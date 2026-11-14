import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Modal } from '@/components/ui/Modal';
import {
  inputClass,
  inputErrorClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '@/components/ui/formStyles';
import { getCategoriesByType } from '@/data/categories';
import { isFutureDate } from '@/lib/datePolicy';
import {
  centsToInputValue,
  hasDraftChanges,
  hasErrors,
  todayISO,
  toTransactionInput,
  validateTransactionForm,
} from '@/lib/validation';
import type { TransactionFormErrors, TransactionFormValues } from '@/lib/validation';
import { useReloadActivity } from '@/pwa/useReloadActivity';
import type { Transaction, TransactionType, TransactionWriteResult } from '@/types/transaction';

interface TransactionFormProps {
  /** When provided the form edits this transaction; otherwise it creates a new one. */
  initial?: Transaction;
  /** Returning a failed result keeps the form open and shows the message on the date field. */
  onSubmit: (input: Omit<Transaction, 'id'>) => TransactionWriteResult | void;
  onCancel: () => void;
}

function initialValues(initial?: Transaction): TransactionFormValues {
  if (!initial) {
    return { type: 'expense', amount: '', categoryId: '', description: '', date: todayISO() };
  }
  return {
    type: initial.type,
    amount: centsToInputValue(initial.amount),
    categoryId: initial.categoryId,
    description: initial.description,
    date: initial.date,
  };
}

const TYPE_OPTIONS: { value: TransactionType; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
];

export function TransactionForm({ initial, onSubmit, onCancel }: TransactionFormProps) {
  // What the form started with, captured once. A new form defaults its date to today; recomputing
  // that on every render would make an untouched form look edited after midnight.
  const [start] = useState<TransactionFormValues>(() => initialValues(initial));
  const [values, setValues] = useState<TransactionFormValues>(start);
  // Errors are hidden until the first submit attempt, then kept live. Editing a record that already
  // has a future date shows the date problem straight away, so it is clear what has to be corrected.
  const [submitted, setSubmitted] = useState(() => initial !== undefined && isFutureDate(initial.date));
  // Set only if the store refuses the save (e.g. the date became invalid since the form validated).
  const [writeError, setWriteError] = useState<string | null>(null);
  const uid = useId();

  // Edits that have not been submitted are a draft: an update must not reload the page under them.
  useReloadActivity('draft-open', hasDraftChanges(values, start));

  const errors: TransactionFormErrors = submitted ? validateTransactionForm(values) : {};
  const dateError = errors.date ?? writeError ?? undefined;
  const categoryOptions = getCategoriesByType(values.type);
  // A transaction whose stored category no longer exists must still be editable.
  const categoryIsKnown = categoryOptions.some((c) => c.id === values.categoryId);

  function setField<K extends keyof TransactionFormValues>(key: K, value: TransactionFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function changeType(type: TransactionType) {
    setValues((current) => {
      const stillValid = getCategoriesByType(type).some((c) => c.id === current.categoryId);
      return { ...current, type, categoryId: stillValid ? current.categoryId : '' };
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (hasErrors(validateTransactionForm(values))) return;
    const input = toTransactionInput(values);
    if (!input) return;
    const result = onSubmit(input);
    setWriteError(result && !result.ok ? result.message : null);
  }

  const fieldId = (name: string) => `${uid}-${name}`;
  const describedBy = (name: keyof TransactionFormValues) =>
    errors[name] ? `${fieldId(name)}-error` : undefined;

  return (
    <Modal
      title={initial ? 'Edit transaction' : 'Add transaction'}
      description={initial ? 'Update the details and save your changes.' : 'Record a new income or expense.'}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4 px-6 pb-6 pt-5">
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-navy-700">Type</legend>
          <div role="radiogroup" aria-label="Transaction type" className="grid grid-cols-2 gap-1 rounded-xl bg-navy-50 p-1">
            {TYPE_OPTIONS.map((option) => {
              const active = values.type === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => changeType(option.value)}
                  className={`rounded-lg py-2 text-sm font-medium transition-colors ${
                    active ? 'bg-white text-navy-900 shadow-sm' : 'text-navy-500 hover:text-navy-900'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div>
          <label htmlFor={fieldId('amount')} className="mb-1.5 block text-sm font-medium text-navy-700">
            Amount (USD)
          </label>
          <input
            id={fieldId('amount')}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={values.amount}
            onChange={(e) => setField('amount', e.target.value)}
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby={describedBy('amount')}
            className={`${inputClass} tabular-nums ${errors.amount ? inputErrorClass : ''}`}
          />
          <FieldError id={`${fieldId('amount')}-error`} message={errors.amount} />
        </div>

        <div>
          <label htmlFor={fieldId('category')} className="mb-1.5 block text-sm font-medium text-navy-700">
            Category
          </label>
          <select
            id={fieldId('category')}
            value={values.categoryId}
            onChange={(e) => setField('categoryId', e.target.value)}
            aria-invalid={errors.categoryId ? true : undefined}
            aria-describedby={describedBy('categoryId')}
            className={`${inputClass} ${errors.categoryId ? inputErrorClass : ''}`}
          >
            <option value="">Select a category</option>
            {values.categoryId !== '' && !categoryIsKnown && (
              <option value={values.categoryId} disabled>
                Unavailable category
              </option>
            )}
            {categoryOptions.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <FieldError id={`${fieldId('categoryId')}-error`} message={errors.categoryId} />
        </div>

        <div>
          <label htmlFor={fieldId('description')} className="mb-1.5 block text-sm font-medium text-navy-700">
            Description
          </label>
          <input
            id={fieldId('description')}
            type="text"
            autoComplete="off"
            placeholder="e.g. Weekly groceries"
            value={values.description}
            onChange={(e) => setField('description', e.target.value)}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={describedBy('description')}
            className={`${inputClass} ${errors.description ? inputErrorClass : ''}`}
          />
          <FieldError id={`${fieldId('description')}-error`} message={errors.description} />
        </div>

        <div>
          <label htmlFor={fieldId('date')} className="mb-1.5 block text-sm font-medium text-navy-700">
            Date
          </label>
          <input
            id={fieldId('date')}
            type="date"
            value={values.date}
            max={todayISO()}
            onChange={(e) => {
              setField('date', e.target.value);
              setWriteError(null);
            }}
            aria-invalid={dateError ? true : undefined}
            aria-describedby={dateError ? `${fieldId('date')}-error` : undefined}
            className={`${inputClass} ${dateError ? inputErrorClass : ''}`}
          />
          <FieldError id={`${fieldId('date')}-error`} message={dateError} />
        </div>

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onCancel} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass}>
            {initial ? 'Save changes' : 'Add transaction'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-xs font-medium text-rose-600">
      {message}
    </p>
  );
}
