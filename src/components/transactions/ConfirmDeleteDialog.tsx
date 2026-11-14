import { Modal } from '@/components/ui/Modal';
import { dangerButtonClass, secondaryButtonClass } from '@/components/ui/formStyles';
import { formatCurrency, formatDate } from '@/lib/format';
import type { Transaction } from '@/types/transaction';

interface ConfirmDeleteDialogProps {
  transaction: Transaction;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDeleteDialog({ transaction, onConfirm, onCancel }: ConfirmDeleteDialogProps) {
  return (
    <Modal
      title="Delete transaction?"
      description={`“${transaction.description}” (${formatCurrency(transaction.amount)} on ${formatDate(
        transaction.date,
      )}) will be removed permanently. This can't be undone.`}
      onClose={onCancel}
    >
      <div className="flex flex-col-reverse gap-2 px-6 pb-6 pt-5 sm:flex-row sm:justify-end">
        <button type="button" onClick={onCancel} className={secondaryButtonClass}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm} className={dangerButtonClass}>
          Delete
        </button>
      </div>
    </Modal>
  );
}
