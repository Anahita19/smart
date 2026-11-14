import { checkForUpdate } from './updateLifecycle';

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  const scriptUrl = `${import.meta.env.BASE_URL}sw.js`;
  const scope = import.meta.env.BASE_URL;

  void navigator.serviceWorker.register(scriptUrl, {
    scope,
    updateViaCache: 'none',
  }).then((registration) => {
    void checkForUpdate(registration);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void checkForUpdate(registration);
    });
  }).catch(() => {
    // PWA support is progressive enhancement; the app remains usable without it.
  });
}
