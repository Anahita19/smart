import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Accessible modal built on the native <dialog> element: the browser provides the focus trap,
 * inert background and Escape handling. Rendered only while open, so it mounts open.
 */
export function Modal({ title, description, onClose, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      aria-describedby={description ? 'modal-description' : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Clicks on the backdrop target the <dialog> element itself.
        if (event.target === ref.current) onClose();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl bg-white p-0 text-navy-900 shadow-card ring-1 ring-navy-950/5 backdrop:bg-navy-950/50"
    >
      <div className="flex items-start justify-between gap-4 px-6 pt-6">
        <div>
          <h2 id="modal-title" className="text-lg font-semibold text-navy-900">
            {title}
          </h2>
          {description && (
            <p id="modal-description" className="mt-1 text-sm text-navy-500">
              {description}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="-mr-2 -mt-1 grid size-9 shrink-0 place-items-center rounded-lg text-navy-500 transition-colors hover:bg-navy-50 hover:text-navy-900"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
