/**
 * Service-worker update lifecycle, kept free of React and of the real DOM types so that it can be
 * tested without a browser. The structural types below are satisfied by the DOM's
 * ServiceWorker, ServiceWorkerRegistration and ServiceWorkerContainer.
 */
export interface WorkerLike {
  readonly state: string;
  addEventListener(type: 'statechange', listener: () => void): void;
  postMessage(message: unknown): void;
}

export interface RegistrationLike {
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
  update(): Promise<unknown>;
}

export interface ContainerLike {
  readonly controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
}

/**
 * Calls `onWaiting` whenever an updated worker is installed and waiting for approval. Covers an update
 * that is already waiting, one that is still installing when watching starts (its `updatefound`
 * event has already fired and would otherwise be missed), and updates found later.
 */
export function watchForWaitingWorker(
  registration: RegistrationLike,
  container: Pick<ContainerLike, 'controller'>,
  onWaiting: () => void,
): void {
  const report = () => {
    // Without a controller this is the very first install: there is nothing to update.
    if (registration.waiting && container.controller) onWaiting();
  };
  const track = (worker: WorkerLike | null) => {
    if (!worker) return;
    const check = () => {
      if (worker.state === 'installed') report();
    };
    worker.addEventListener('statechange', check);
    check();
  };

  report();
  track(registration.installing);
  registration.addEventListener('updatefound', () => track(registration.installing));
}

export type ActivationResult = 'requested' | 'no-waiting-worker' | 'failed';

/**
 * Asks the waiting worker to take over (after the user's explicit approval) and runs `reload` once the
 * page's controller changes. The waiting worker is read from the registration at click time: a worker
 * captured earlier can have been replaced by a newer deploy and be redundant, and posting to a
 * redundant worker throws. If the request cannot be made, no `controllerchange` listener is left behind
 * that could reload the page later without the user asking.
 */
export function requestUpdateActivation(
  registration: Pick<RegistrationLike, 'waiting'>,
  container: ContainerLike,
  message: unknown,
  reload: () => void,
): ActivationResult {
  const worker = registration.waiting;
  if (!worker) return 'no-waiting-worker';

  const onControllerChange = () => {
    container.removeEventListener('controllerchange', onControllerChange);
    reload();
  };
  container.addEventListener('controllerchange', onControllerChange);
  try {
    worker.postMessage(message);
  } catch {
    container.removeEventListener('controllerchange', onControllerChange);
    return 'failed';
  }
  return 'requested';
}

/** Update checks fail while offline; that must stay silent instead of an unhandled promise rejection. */
export async function checkForUpdate(registration: Pick<RegistrationLike, 'update'>): Promise<void> {
  try {
    await registration.update();
  } catch {
    // Offline or server unreachable: the installed version keeps working.
  }
}
