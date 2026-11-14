import { useEffect } from 'react';
import { registerReloadActivity } from './reloadGuard';
import type { ReloadActivityKind } from './reloadGuard';

/** While `active`, a service-worker update may not reload the page (see reloadGuard). Unmounting ends it. */
export function useReloadActivity(kind: ReloadActivityKind, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return registerReloadActivity(kind);
  }, [kind, active]);
}
