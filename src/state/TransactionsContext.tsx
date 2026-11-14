import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { actualTransactions, checkTransactionDate, todayISO } from '@/lib/datePolicy';
import { STORAGE_KEY, openSession, requestPersistentStorage } from '@/lib/storage';
import type { DiscardHazard, RestoreOutcome, RestoreRequest, StorageNotice, SyncOutcome } from '@/lib/storage';
import type { Transaction, TransactionWriteResult } from '@/types/transaction';
import { createId, transactionsReducer } from './transactionsReducer';

type TransactionInput = Omit<Transaction, 'id'>;

/** What a restore attempt returns: the storage layer's outcome, or a refusal for unsaved changes. */
export type ContextRestoreOutcome =
  | RestoreOutcome
  | { status: 'refused'; reason: 'unsaved-changes'; message: string };

interface TransactionsContextValue {
  transactions: readonly Transaction[];
  /** Refuses (and returns `ok: false`) a date that is invalid or after today; see lib/datePolicy. */
  addTransaction: (input: TransactionInput) => TransactionWriteResult;
  /** Same rule as add: an existing future-dated record can be saved once its date is today or earlier. */
  updateTransaction: (id: string, input: TransactionInput) => TransactionWriteResult;
  deleteTransaction: (id: string) => void;
  /** False when the browser refused to persist data (private mode, quota, disabled storage). */
  persistenceOk: boolean;
  /**
   * True while the list on screen differs from what storage holds: a save that is pending, failed or
   * blocked. Leaving the page (for example a reload) at that moment would lose those changes.
   */
  hasUnsavedChanges: boolean;
  /** Set when stored data needed attention or another tab changed it; null otherwise. */
  storageNotice: StorageNotice | null;
  dismissStorageNotice: () => void;
  /**
   * Why what this tab shows cannot safely be discarded (a reload would lose it), or null. It comes
   * from the storage session itself, not from a notice, so dismissing or replacing notices never
   * changes it; it ends only when storage and this tab agree again. See `StorageSession.getDiscardHazard`.
   */
  storageHazard: DiscardHazard | null;
  /** The same verdict read live from the session (never a stale render), for checks that run later, such as a deferred reload. */
  readStorageHazard: () => DiscardHazard | null;
  /**
   * Merge or replace the stored list (Stage 2: storage layer only, no screen calls this yet).
   * Refused while this tab holds changes that are not saved yet. The list on screen is updated only
   * after storage has been written and read back; a failure never looks like a success.
   */
  restoreTransactions: (request: RestoreRequest) => ContextRestoreOutcome;
}

const TransactionsContext = createContext<TransactionsContextValue | null>(null);

export function TransactionsProvider({ children }: { children: ReactNode }) {
  // Reading storage is the only thing that happens at startup. A first run is an EMPTY list (no
  // demo data); unreadable, corrupt or unsupported content is preserved and never treated as a first
  // run. Everything storage-related lives in lib/storage; see its header for the rules.
  const [session] = useState(() => openSession());
  const [transactions, dispatch] = useReducer(transactionsReducer, session.boot.transactions);
  const [persistenceOk, setPersistenceOk] = useState(true);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [storageNotice, setStorageNotice] = useState<StorageNotice | null>(session.boot.notice);
  // Mirrors the session's own verdict (it is session state, independent of the notice above). It is
  // re-read after every call that can change it: a save, a sync and a restore.
  const [storageHazard, setStorageHazard] = useState<DiscardHazard | null>(() => session.getDiscardHazard());
  const refreshStorageHazard = useCallback(() => setStorageHazard(session.getDiscardHazard()), [session]);
  const readStorageHazard = useCallback(() => session.getDiscardHazard(), [session]);
  // The list that storage already holds (what was loaded, or last saved/adopted). The save effect
  // does nothing while state is still that list, so mounting, StrictMode's repeated effects and
  // adopting another tab's data can never trigger a save (and therefore no save/reload loop).
  const syncedRef = useRef(session.boot.transactions);
  const persistRequested = useRef(false);

  const applySync = useCallback((outcome: SyncOutcome) => {
    if (outcome.action === 'adopt') {
      syncedRef.current = outcome.transactions;
      dispatch({ type: 'replace', transactions: outcome.transactions });
      // Everything on screen was just replaced by what storage holds, so a failed save from before
      // no longer leaves anything only in memory. A later failing save sets this to false again.
      setPersistenceOk(true);
    }
    if (outcome.action !== 'none' && outcome.notice) setStorageNotice(outcome.notice);
    refreshStorageHazard();
  }, [refreshStorageHazard]);

  // Save after real changes only. A stale tab is refused by the session and adopts the newer data.
  useEffect(() => {
    if (transactions === syncedRef.current) return;
    const outcome = session.save(transactions);
    if (outcome.status === 'saved') {
      syncedRef.current = transactions;
      setPersistenceOk(true);
      // Best effort, once per session, and only after the person has real data to protect.
      if (!persistRequested.current) {
        persistRequested.current = true;
        void requestPersistentStorage();
      }
    } else if (outcome.status === 'failed') {
      setPersistenceOk(false);
    } else if (outcome.status === 'conflict') {
      if (outcome.sync.action === 'none') setPersistenceOk(false);
      else applySync(outcome.sync);
    }
    // 'blocked': the notice shown at startup (or after a sync) already explains why nothing is saved.
    // (After an incomplete restore, session.save first re-reads storage and lifts the block only if it
    // verifiably holds what is on screen; the refresh below picks that up.)
    refreshStorageHazard();
  }, [transactions, session, applySync, refreshStorageHazard]);

  // Whether storage holds what is on screen. Declared after the save effect so that it reads the synced
  // list once that effect has run: a failed or blocked save leaves the list unsynced (unsaved), a
  // successful save, or adopting a newer list from storage, makes it synced again.
  useEffect(() => {
    setHasUnsavedChanges(transactions !== syncedRef.current);
  }, [transactions]);

  // Another tab changed our key: reconcile instead of waiting for our next (stale) save.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      applySync(session.syncFromStorage('event'));
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [session, applySync]);

  const dismissStorageNotice = useCallback(() => setStorageNotice(null), []);

  const restoreTransactions = useCallback(
    (request: RestoreRequest): ContextRestoreOutcome => {
      // State that storage doesn't hold yet (a pending or failed save) would be lost or mixed up.
      if (transactions !== syncedRef.current) {
        return {
          status: 'refused',
          reason: 'unsaved-changes',
          message: 'This tab has changes that are not saved yet, so nothing was restored. Your data was not changed.',
        };
      }
      const result = session.restore(request);
      if (result.status === 'restored') {
        // Storage already holds (and has verified) the new list; adopting it marks it as synced
        // before the state changes, so it is never saved a second time.
        if (result.changed) {
          applySync({
            action: 'adopt',
            transactions: result.transactions,
            notice: { kind: 'restored', message: `Restore complete: ${result.transactions.length} transactions are now saved.` },
          });
        }
      } else if (result.status === 'refused') {
        if (result.sync) applySync(result.sync);
      } else if (result.dataState === 'rollback-failed' || result.dataState === 'changed-elsewhere') {
        setStorageNotice({ kind: 'restore-incomplete', message: result.message });
      }
      refreshStorageHazard();
      return result;
    },
    [transactions, session, applySync, refreshStorageHazard],
  );

  const addTransaction = useCallback((input: TransactionInput): TransactionWriteResult => {
    const today = todayISO();
    const check = checkTransactionDate(input.date, today);
    if (!check.ok) return { ok: false, message: check.message };
    dispatch({ type: 'add', transaction: { id: createId(), ...input }, today });
    return { ok: true };
  }, []);

  const updateTransaction = useCallback((id: string, input: TransactionInput): TransactionWriteResult => {
    const today = todayISO();
    const check = checkTransactionDate(input.date, today);
    if (!check.ok) return { ok: false, message: check.message };
    dispatch({ type: 'update', transaction: { id, ...input }, today });
    return { ok: true };
  }, []);

  const deleteTransaction = useCallback((id: string) => {
    dispatch({ type: 'delete', id });
  }, []);

  const value = useMemo<TransactionsContextValue>(
    () => ({
      transactions,
      addTransaction,
      updateTransaction,
      deleteTransaction,
      persistenceOk,
      hasUnsavedChanges,
      storageNotice,
      dismissStorageNotice,
      storageHazard,
      readStorageHazard,
      restoreTransactions,
    }),
    [
      transactions,
      addTransaction,
      updateTransaction,
      deleteTransaction,
      persistenceOk,
      hasUnsavedChanges,
      storageNotice,
      dismissStorageNotice,
      storageHazard,
      readStorageHazard,
      restoreTransactions,
    ],
  );

  return <TransactionsContext.Provider value={value}>{children}</TransactionsContext.Provider>;
}

export function useTransactions(): TransactionsContextValue {
  const context = useContext(TransactionsContext);
  if (context === null) {
    throw new Error('useTransactions must be used inside <TransactionsProvider>.');
  }
  return context;
}

/**
 * The transactions that count as real (dated today or earlier). Dashboard and Analytics read this
 * instead of the raw list; the Transactions page keeps using the raw list so future-dated records
 * stay visible there. All the logic lives in lib/datePolicy.
 */
export function useActualTransactions(): Transaction[] {
  const { transactions } = useTransactions();
  // Read on every render (never cached in state) so the cut-off follows the calendar; the string
  // only changes at midnight, which is when the memo below recomputes.
  const today = todayISO();
  return useMemo(() => actualTransactions(transactions, today), [transactions, today]);
}
