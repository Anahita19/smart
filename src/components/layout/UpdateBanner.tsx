import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  createGuardedReload,
  evaluateReloadSafety,
  getReloadActivities,
  subscribeReloadActivities,
} from '@/pwa/reloadGuard';
import { requestUpdateActivation, watchForWaitingWorker } from '@/pwa/updateLifecycle';
import { useTransactions } from '@/state/TransactionsContext';

export function UpdateBanner() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [reloading, setReloading] = useState(false);
  // The new worker is in control but the page has not reloaded yet because it was unsafe to do so.
  const [reloadPending, setReloadPending] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  // Reloading discards whatever lives only in memory, so it is allowed only when nothing would be lost.
  const { persistenceOk, hasUnsavedChanges, storageHazard, readStorageHazard } = useTransactions();
  const activities = useSyncExternalStore(subscribeReloadActivities, getReloadActivities);
  const block = evaluateReloadSafety({ persistenceOk, hasUnsavedChanges, storageHazard, activities });
  // The verdict for the reload that runs after the new worker takes control (not at click time).
  // The render-time inputs are the latest rendered ones; the storage session's verdict and the
  // registered activities are read live, so a change that has not been rendered yet still counts.
  const inputRef = useRef({ persistenceOk, hasUnsavedChanges });
  useEffect(() => {
    inputRef.current = { persistenceOk, hasUnsavedChanges };
  });
  const getLiveBlock = () =>
    evaluateReloadSafety({ ...inputRef.current, storageHazard: readStorageHazard(), activities: getReloadActivities() });

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

    let active = true;
    void navigator.serviceWorker.ready.then((registration) => {
      if (!active) return;
      registrationRef.current = registration;
      watchForWaitingWorker(registration, navigator.serviceWorker, () => {
        if (active) setUpdateAvailable(true);
      });
    }).catch(() => {
      // The application remains available if service-worker registration is unavailable.
    });

    return () => {
      active = false;
    };
  }, []);

  const reloadPage = () => window.location.reload();

  const applyUpdate = () => {
    const registration = registrationRef.current;
    if (!registration || reloading || block !== null || getLiveBlock() !== null) return;
    if (reloadPending) {
      reloadPage();
      return;
    }
    const result = requestUpdateActivation(
      registration,
      navigator.serviceWorker,
      { type: 'SKIP_WAITING' },
      createGuardedReload({
        getBlock: getLiveBlock,
        reload: reloadPage,
        onDeferred: () => {
          setReloading(false);
          setReloadPending(true);
        },
      }),
    );
    if (result === 'requested') setReloading(true);
    else setUpdateAvailable(false); // the update is gone or can no longer be applied; never leave the banner stuck
  };

  if (!updateAvailable) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-3 top-3 z-[100] mx-auto flex max-w-xl items-center justify-between gap-3 rounded-xl border border-gold-400/40 bg-navy-950 px-4 py-3 text-sm text-sand-50 shadow-xl"
    >
      <span>{block ? block.message : reloading ? 'Applying update…' : 'Update ready'}</span>
      <button
        type="button"
        onClick={applyUpdate}
        disabled={reloading || block !== null}
        className="shrink-0 rounded-lg bg-gold-400 px-4 py-2 font-semibold text-navy-950 transition-colors hover:bg-gold-500 disabled:opacity-60"
      >
        {reloading ? 'Please wait' : 'Reload'}
      </button>
    </div>
  );
}
