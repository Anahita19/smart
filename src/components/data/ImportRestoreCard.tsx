import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, FileUp, Info, ShieldAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { dangerButtonClass, inputClass, primaryButtonClass, secondaryButtonClass } from '@/components/ui/formStyles';
import { isReplacePhrase, prepareImport, readImportFile, runImport } from '@/lib/importRestore';
import type { ImportMode, ImportPreview, ParsedImport } from '@/lib/importRestore';
import { useReloadActivity } from '@/pwa/useReloadActivity';
import { useTransactions } from '@/state/TransactionsContext';
import type { Transaction } from '@/types/transaction';
import { formatCount, formatExportDate, formatTransactionCount } from './exportCopy';
import {
  IMPORT_INTRO,
  IMPORT_PRIVACY_TEXT,
  IMPORT_TITLE,
  MERGE_TEXT,
  MERGE_TITLE,
  NO_CHECKSUM_WARNING,
  READING_LABEL,
  REPLACE_PHRASE_LABEL,
  REPLACE_SAFETY_TEXT,
  REPLACE_TEXT,
  REPLACE_TITLE,
  SELECT_LABEL,
  STALE_NOTE,
  UNSAVED_IMPORT_NOTE,
  describeImportFailure,
  describeRunResult,
} from './importCopy';
import type { ResultMessage } from './importCopy';

type Stage =
  | { name: 'idle' }
  | { name: 'reading' }
  | { name: 'preview'; parsed: ParsedImport; preview: ImportPreview; base: readonly Transaction[]; stale: boolean }
  | { name: 'done'; message: ResultMessage };

/**
 * Data page — Import & Restore. Picking a file only READS and CHECKS it (parse, checksum, schema,
 * every transaction, duplicate ids) and shows a counts-only preview; nothing is written until the
 * person presses a confirm button. All writing goes through the Context's `restoreTransactions`
 * (Stage 2), so the unsaved-changes refusal, the snapshot-before-write order and the read-back
 * verification are the storage layer's, not re-implemented here. The card sits inside DataPage's
 * RTL root and sets no direction of its own.
 */
export function ImportRestoreCard() {
  const { transactions, persistenceOk, restoreTransactions } = useTransactions();
  const [stage, setStage] = useState<Stage>({ name: 'idle' });
  const [fileError, setFileError] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [phrase, setPhrase] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Ignores the result of a read that was superseded (a newer file, or leaving the page).
  const readToken = useRef(0);
  const busy = useRef(false);
  useEffect(() => () => void (readToken.current += 1), []);

  const reading = stage.name === 'reading';
  // Reading a file or holding a preview is a restore in progress: an update must not reload the page under it.
  useReloadActivity('restore-in-progress', stage.name === 'reading' || stage.name === 'preview');

  function reset() {
    readToken.current += 1;
    setStage({ name: 'idle' });
    setFileError(null);
    setMode('merge');
    setPhrase('');
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so the same file can be chosen again; choosing a file is never more than a read.
    event.target.value = '';
    if (!file || reading) return;
    const token = ++readToken.current;
    setFileError(null);
    setMode('merge');
    setPhrase('');
    setStage({ name: 'reading' });

    const read = await readImportFile(file);
    if (token !== readToken.current) return;
    if (!read.ok) {
      setFileError(describeImportFailure(read.error));
      setStage({ name: 'idle' });
      return;
    }
    const base = transactions;
    const prepared = await prepareImport(read.text, base);
    if (token !== readToken.current) return;
    if (!prepared.ok) {
      setFileError(describeImportFailure(prepared.error));
      setStage({ name: 'idle' });
      return;
    }
    setStage({ name: 'preview', parsed: prepared.parsed, preview: prepared.preview, base, stale: false });
  }

  function handleConfirm() {
    if (stage.name !== 'preview' || busy.current) return;
    busy.current = true;
    try {
      const result = runImport({
        parsed: stage.parsed,
        baseTransactions: stage.base,
        currentTransactions: transactions,
        mode,
        confirmed: true,
        replacePhrase: phrase,
        restore: restoreTransactions,
      });
      if (result.status === 'stale') {
        setStage({ ...stage, preview: result.preview, base: transactions, stale: true });
        setPhrase('');
      } else if (result.status !== 'not-confirmed') {
        setStage({ name: 'done', message: describeRunResult(result) });
        setPhrase('');
        setMode('merge');
      }
    } finally {
      busy.current = false;
    }
  }

  const preview = stage.name === 'preview' ? stage.preview : null;
  const date = preview?.backupDate ? formatExportDate(new Date(preview.backupDate)) : null;

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-lg font-semibold text-navy-900">{IMPORT_TITLE}</h2>
      <p className="mt-1 text-sm leading-6 text-navy-500">{IMPORT_INTRO}</p>

      <div role="note" className="mt-5 flex items-start gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
        <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1 leading-6">{IMPORT_PRIVACY_TEXT}</p>
      </div>

      {!persistenceOk && (
        <p role="status" className="mt-4 flex items-start gap-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{UNSAVED_IMPORT_NOTE}</span>
        </p>
      )}

      <div className="mt-6">
        <input ref={inputRef} type="file" accept=".json,application/json" onChange={handleFile} className="hidden" tabIndex={-1} aria-hidden="true" />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={reading}
          aria-busy={reading}
          className={`${stage.name === 'preview' ? secondaryButtonClass : primaryButtonClass} w-full sm:w-auto`}
        >
          <FileUp className="size-4" aria-hidden="true" />
          {reading ? READING_LABEL : SELECT_LABEL}
        </button>
      </div>

      {fileError !== null && (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700 ring-1 ring-rose-200">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{fileError}</span>
        </p>
      )}

      {stage.name === 'done' && (
        <p
          role={stage.message.tone === 'error' ? 'alert' : 'status'}
          className={`mt-4 flex items-start gap-2 rounded-xl px-4 py-3 text-sm leading-6 ring-1 ${
            stage.message.tone === 'error'
              ? 'bg-rose-50 text-rose-700 ring-rose-200'
              : stage.message.tone === 'success'
                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                : 'bg-navy-50 text-navy-700 ring-navy-200'
          }`}
        >
          {stage.message.tone === 'error' ? (
            <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          ) : stage.message.tone === 'success' ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          ) : (
            <Info className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1">{stage.message.text}</span>
        </p>
      )}

      {stage.name === 'preview' && preview !== null && (
        <section aria-label="Restore preview" className="mt-6 space-y-5 border-t border-navy-100 pt-6">
          {stage.stale && (
            <p role="status" className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 ring-1 ring-amber-200">
              <Info className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{STALE_NOTE}</span>
            </p>
          )}

          <dl className="grid grid-cols-2 gap-3">
            <div className="col-span-2 rounded-xl bg-navy-50 px-4 py-3">
              <dt className="text-xs text-navy-500">Backup date</dt>
              <dd className="mt-1 text-base font-semibold text-navy-900">{date ? date.display : 'Unknown'}</dd>
              {date !== null && (
                <dd className="mt-1 text-start text-xs text-navy-500">
                  {date.iso}
                </dd>
              )}
            </div>
            <Stat label="Transactions in file" value={formatCount(preview.incomingCount)} />
            <Stat label="New transactions" value={formatCount(preview.newCount)} />
            <Stat label="Duplicates (same id and content)" value={formatCount(preview.duplicateCount)} />
            <Stat label="Conflicting ids (different content)" value={formatCount(preview.conflictCount)} />
            <Stat label="Validation errors" value={formatCount(0)} />
            <Stat label="Checksum" value={preview.checksum === 'verified' ? 'Verified' : 'None'} />
          </dl>

          <ul className="space-y-2 text-sm leading-6 text-navy-600">
            {preview.checksum !== 'verified' && <Note tone="warn">{NO_CHECKSUM_WARNING}</Note>}
            {preview.futureDatedCount > 0 && (
              <Note>Future-dated transactions in the file: {formatCount(preview.futureDatedCount)}. They are kept as they are and left out of calculations until their dates are corrected.</Note>
            )}
            {preview.unknownCategoryCount > 0 && <Note>Transactions with an unknown category: {formatCount(preview.unknownCategoryCount)}. They are shown as "Uncategorized".</Note>}
            {preview.possibleDuplicateCount > 0 && (
              <Note tone="warn">New transactions with a different id that look like ones you already have: {formatCount(preview.possibleDuplicateCount)}. They will be added on merge.</Note>
            )}
            {preview.conflictCount > 0 && <Note>Conflicting ids: {formatCount(preview.conflictCount)}. On merge, the existing version of each is kept.</Note>}
          </ul>

          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-medium text-navy-900">Restore method</legend>
            <ModeOption id="import-mode-merge" checked={mode === 'merge'} onSelect={() => setMode('merge')} title={MERGE_TITLE} text={MERGE_TEXT} />
            <ModeOption
              id="import-mode-replace"
              checked={mode === 'replace'}
              onSelect={() => setMode('replace')}
              disabled={!preview.canReplace}
              title={REPLACE_TITLE}
              text={preview.canReplace ? REPLACE_TEXT : 'This file has no transactions; replacing with it would erase all data, so it is unavailable.'}
            />
          </fieldset>

          {mode === 'merge' ? (
            <div className="space-y-3">
              <p className="text-sm leading-6 text-navy-600">
                Confirming adds {formatTransactionCount(preview.newCount, 'new')} to your current {formatCount(preview.existingCount)}. No existing transaction is removed or changed.
              </p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button type="button" onClick={reset} className={secondaryButtonClass}>
                  Cancel
                </button>
                <button type="button" onClick={handleConfirm} className={primaryButtonClass}>
                  Confirm and merge
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 rounded-xl bg-rose-50 p-4 ring-1 ring-rose-200">
              <p className="flex items-start gap-2 text-sm font-medium leading-6 text-rose-800">
                <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  Your {formatTransactionCount(preview.existingCount, 'current')} will be replaced by the {formatTransactionCount(preview.incomingCount)} in the file. Current transactions not in the file will be deleted: {formatCount(preview.replaceRemovedCount)}.
                </span>
              </p>
              <p className="text-sm leading-6 text-rose-800">{REPLACE_SAFETY_TEXT}</p>
              <div>
                <label htmlFor="import-replace-phrase" className="mb-1.5 block text-sm font-medium text-rose-900">
                  {REPLACE_PHRASE_LABEL}
                </label>
                <input
                  id="import-replace-phrase"
                  type="text"
                  value={phrase}
                  onChange={(event) => setPhrase(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button type="button" onClick={reset} className={secondaryButtonClass}>
                  Cancel
                </button>
                <button type="button" onClick={handleConfirm} disabled={!isReplacePhrase(phrase)} className={`${dangerButtonClass} disabled:cursor-not-allowed disabled:opacity-50`}>
                  Confirm and replace everything
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-navy-50 px-4 py-3">
      <dt className="text-xs leading-5 text-navy-500">{label}</dt>
      <dd className="mt-1 text-xl font-semibold text-navy-900">{value}</dd>
    </div>
  );
}

function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <li className={`flex items-start gap-2 ${tone === 'warn' ? 'text-amber-900' : ''}`}>
      {tone === 'warn' ? <AlertTriangle className="mt-1 size-4 shrink-0" aria-hidden="true" /> : <Info className="mt-1 size-4 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}

interface ModeOptionProps {
  id: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  text: string;
  disabled?: boolean;
}

function ModeOption({ id, checked, onSelect, title, text, disabled = false }: ModeOptionProps) {
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-3 rounded-xl px-4 py-3 ring-1 transition-colors ${
        checked ? 'bg-navy-50 ring-navy-400' : 'ring-navy-200 hover:bg-navy-50'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <input id={id} type="radio" name="import-mode" checked={checked} onChange={onSelect} disabled={disabled} className="mt-1 size-4 shrink-0 accent-navy-900" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-navy-900">{title}</span>
        <span className="mt-0.5 block text-sm leading-6 text-navy-500">{text}</span>
      </span>
    </label>
  );
}
