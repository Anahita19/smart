import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Info, ShieldAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { primaryButtonClass } from '@/components/ui/formStyles';
import { futureTransactions, todayISO } from '@/lib/datePolicy';
import { exportBackup } from '@/lib/exportBackup';
import { useTransactions } from '@/state/TransactionsContext';
import { ImportRestoreCard } from './ImportRestoreCard';
import {
  EMPTY_NOTE,
  PRIVACY_WARNING_TEXT,
  PRIVACY_WARNING_TITLE,
  SCOPE_NOTE,
  UNSAVED_NOTE,
  describeExportFailure,
  describeExportSuccess,
  formatCount,
  formatExportDate,
} from './exportCopy';

type ExportState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'success'; message: string; exportedAt: Date }
  | { status: 'error'; message: string };

/**
 * Data page — Backup export, followed by the import card (components/data/ImportRestoreCard). It reads the FULL transaction list (future-dated included) and
 * shows counts and dates only — never amounts, descriptions or the file contents.
 */
export function DataPage() {
  const { transactions, persistenceOk } = useTransactions();
  const [state, setState] = useState<ExportState>({ status: 'idle' });
  // Frees the temporary download URL of the previous export (no timers: on the next export / on leaving).
  const releaseRef = useRef<(() => void) | null>(null);
  useEffect(() => () => releaseRef.current?.(), []);

  const today = todayISO();
  const total = transactions.length;
  const future = futureTransactions(transactions, today).length;
  const working = state.status === 'working';
  const shownDate = formatExportDate(state.status === 'success' ? state.exportedAt : new Date());

  async function handleExport() {
    if (working || total === 0) return;
    setState({ status: 'working' });
    releaseRef.current?.();
    releaseRef.current = null;
    const outcome = await exportBackup(transactions);
    if (outcome.ok) {
      releaseRef.current = outcome.release;
      setState({
        status: 'success',
        message: describeExportSuccess(outcome.fileName, outcome.transactionCount),
        exportedAt: new Date(outcome.exportedAt),
      });
    } else {
      setState({ status: 'error', message: describeExportFailure(outcome.code) });
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 text-start">
      <Card className="p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-navy-900">Backup export</h2>
        <p className="mt-1 text-sm leading-6 text-navy-500">
          A complete copy of your transactions is saved to your device as a versioned JSON file with a built-in SHA-256 integrity check.
        </p>

        <dl className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-navy-50 px-4 py-3">
            <dt className="text-xs text-navy-500">Transactions in the backup</dt>
            <dd className="mt-1 text-xl font-semibold text-navy-900">{formatCount(total)}</dd>
            {future > 0 && (
              <dd className="mt-1 text-xs text-navy-500">Includes {formatCount(future)} future-dated.</dd>
            )}
          </div>
          <div className="rounded-xl bg-navy-50 px-4 py-3">
            <dt className="text-xs text-navy-500">Export date</dt>
            <dd className="mt-1 text-xl font-semibold text-navy-900">{shownDate.display}</dd>
            <dd className="mt-1 text-start text-xs text-navy-500">{shownDate.iso}</dd>
          </div>
        </dl>

        <p className="mt-4 flex items-start gap-2 text-sm text-navy-500">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{SCOPE_NOTE}</span>
        </p>

        <div role="note" className="mt-5 flex items-start gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{PRIVACY_WARNING_TITLE}</p>
            <p className="mt-1 leading-6">{PRIVACY_WARNING_TEXT}</p>
          </div>
        </div>

        {!persistenceOk && (
          <p role="status" className="mt-4 flex items-start gap-2 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{UNSAVED_NOTE}</span>
          </p>
        )}

        {total === 0 && <p className="mt-4 text-sm text-navy-500">{EMPTY_NOTE}</p>}

        <div className="mt-6">
          <button
            type="button"
            onClick={handleExport}
            disabled={working || total === 0}
            aria-busy={working}
            className={`${primaryButtonClass} w-full sm:w-auto`}
          >
            <Download className="size-4" aria-hidden="true" />
            {working ? 'Creating backup…' : 'Create and download backup file'}
          </button>
        </div>

        {state.status === 'success' && (
          <p role="status" className="mt-4 flex items-start gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-700 ring-1 ring-emerald-200">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{state.message}</span>
          </p>
        )}
        {state.status === 'error' && (
          <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700 ring-1 ring-rose-200">
            <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{state.message}</span>
          </p>
        )}
      </Card>

      <ImportRestoreCard />
    </div>
  );
}
