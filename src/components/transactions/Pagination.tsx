import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationProps {
  page: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  onPageChange: (page: number) => void;
}

const buttonClass =
  'inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium text-navy-700 ring-1 ring-navy-200 transition-colors hover:bg-navy-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

export function Pagination({ page, pageCount, from, to, total, onPageChange }: PaginationProps) {
  return (
    <nav
      aria-label="Pagination"
      className="flex flex-col items-center justify-between gap-3 border-t border-navy-100 px-5 py-4 sm:flex-row"
    >
      <p className="text-sm text-navy-500" aria-live="polite">
        Showing <span className="font-medium text-navy-900">{from}–{to}</span> of{' '}
        <span className="font-medium text-navy-900">{total}</span>
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Previous
        </button>
        <span className="px-2 text-sm tabular-nums text-navy-500">
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          className={buttonClass}
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
        >
          Next
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
