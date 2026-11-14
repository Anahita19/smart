/**
 * Stage 6 final QA: service-worker update lifecycle (src/pwa/updateLifecycle.ts) with fake
 * registrations. Regression tests for three defects found in the audit:
 *  1. an update still installing when the banner starts watching was never reported;
 *  2. clicking Reload on a stale (redundant) worker threw, left the banner stuck and left a
 *     controllerchange listener armed that could reload the page later without the user asking;
 *  3. an update check while offline produced an unhandled promise rejection.
 *
 * Run: node --experimental-strip-types --import ./tests/register-alias.mjs --test "tests/pwaLifecycle.stage6.test.ts"
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkForUpdate, requestUpdateActivation, watchForWaitingWorker } from '../src/pwa/updateLifecycle.ts';

class FakeWorker {
  state: string;
  posted: unknown[] = [];
  private listeners: Array<() => void> = [];
  constructor(state: string) { this.state = state; }
  addEventListener(_type: 'statechange', listener: () => void) { this.listeners.push(listener); }
  postMessage(message: unknown) {
    if (this.state === 'redundant') throw new DOMException('The ServiceWorker is redundant', 'InvalidStateError');
    this.posted.push(message);
  }
  moveTo(state: string) { this.state = state; this.listeners.forEach((l) => l()); }
}

class FakeRegistration {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  updatefound: Array<() => void> = [];
  updateImpl: () => Promise<unknown> = async () => undefined;
  addEventListener(_type: 'updatefound', listener: () => void) { this.updatefound.push(listener); }
  update() { return this.updateImpl(); }
  /** What a browser does when sw.js changed: a worker starts installing, then waits. */
  startInstall(): FakeWorker { const w = new FakeWorker('installing'); this.installing = w; this.updatefound.forEach((l) => l()); return w; }
  finishInstall(w: FakeWorker) { this.installing = null; this.waiting = w; w.moveTo('installed'); }
}

class FakeContainer {
  controller: unknown;
  listeners = new Set<() => void>();
  constructor(controlled = true) { this.controller = controlled ? {} : null; }
  addEventListener(_type: 'controllerchange', listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_type: 'controllerchange', listener: () => void) { this.listeners.delete(listener); }
  fireControllerChange() { [...this.listeners].forEach((l) => l()); }
}

describe('watchForWaitingWorker', () => {
  it('reports an update that is already waiting', () => {
    const reg = new FakeRegistration(); reg.waiting = new FakeWorker('installed');
    let calls = 0; watchForWaitingWorker(reg, new FakeContainer(), () => { calls++; });
    assert.equal(calls, 1);
  });

  it('reports an update found later (updatefound, then installed)', () => {
    const reg = new FakeRegistration(); let calls = 0;
    watchForWaitingWorker(reg, new FakeContainer(), () => { calls++; });
    assert.equal(calls, 0);
    const w = reg.startInstall(); assert.equal(calls, 0, 'not before it has finished installing');
    reg.finishInstall(w); assert.equal(calls, 1);
  });

  it('regression 1: reports an update that was still installing when watching started (its updatefound had already fired)', () => {
    const reg = new FakeRegistration();
    const w = reg.startInstall();               // updatefound fires before anyone is listening
    let calls = 0; watchForWaitingWorker(reg, new FakeContainer(), () => { calls++; });
    assert.equal(calls, 0);
    reg.finishInstall(w);
    assert.equal(calls, 1, 'the banner must still appear');
  });

  it('reports a worker that finished installing between the registration lookup and the watch', () => {
    const reg = new FakeRegistration(); reg.installing = new FakeWorker('installed'); reg.waiting = reg.installing;
    let calls = 0; watchForWaitingWorker(reg, new FakeContainer(), () => { calls++; });
    assert.ok(calls >= 1);
  });

  it('stays silent on the very first install (no controller yet: nothing to update)', () => {
    const reg = new FakeRegistration(); let calls = 0;
    watchForWaitingWorker(reg, new FakeContainer(false), () => { calls++; });
    reg.finishInstall(reg.startInstall());
    assert.equal(calls, 0);
  });
});

describe('requestUpdateActivation', () => {
  const MESSAGE = { type: 'SKIP_WAITING' };

  it('does nothing until it is called, then asks the waiting worker and reloads exactly once when the controller changes', () => {
    const reg = new FakeRegistration(); reg.waiting = new FakeWorker('installed'); const container = new FakeContainer();
    let reloads = 0;
    assert.equal(reg.waiting.posted.length, 0); assert.equal(reloads, 0);
    assert.equal(requestUpdateActivation(reg, container, MESSAGE, () => { reloads++; }), 'requested');
    assert.deepEqual(reg.waiting.posted, [MESSAGE]);
    assert.equal(reloads, 0, 'no reload until the new worker has taken control');
    container.fireControllerChange(); container.fireControllerChange();
    assert.equal(reloads, 1);
    assert.equal(container.listeners.size, 0);
  });

  it('never reloads on its own: a controller change without a prior request does nothing', () => {
    const container = new FakeContainer(); let reloads = 0;
    watchForWaitingWorker(Object.assign(new FakeRegistration(), { waiting: new FakeWorker('installed') }), container, () => {});
    container.fireControllerChange();
    assert.equal(reloads, 0); assert.equal(container.listeners.size, 0, 'watching registers no controllerchange listener');
  });

  it('regression 2: uses the CURRENT waiting worker, not one seen earlier that a newer deploy made redundant', () => {
    const reg = new FakeRegistration(); const stale = new FakeWorker('installed'); reg.waiting = stale;
    stale.state = 'redundant'; const fresh = new FakeWorker('installed'); reg.waiting = fresh; // a newer deploy replaced it
    const container = new FakeContainer(); let reloads = 0;
    assert.equal(requestUpdateActivation(reg, container, MESSAGE, () => { reloads++; }), 'requested');
    assert.deepEqual(fresh.posted, [MESSAGE]); assert.equal(stale.posted.length, 0);
  });

  it('regression 2: when the worker cannot be messaged it reports "failed" and leaves no controllerchange listener that could reload later', () => {
    const reg = new FakeRegistration(); reg.waiting = new FakeWorker('redundant'); const container = new FakeContainer(); let reloads = 0;
    assert.equal(requestUpdateActivation(reg, container, MESSAGE, () => { reloads++; }), 'failed');
    assert.equal(container.listeners.size, 0);
    container.fireControllerChange(); // e.g. another tab's update, or a later automatic activation
    assert.equal(reloads, 0, 'must not reload the page (it may be mid-edit or mid-restore)');
  });

  it('reports "no-waiting-worker" when the update is already gone, without touching the container', () => {
    const container = new FakeContainer(); let reloads = 0;
    assert.equal(requestUpdateActivation(new FakeRegistration(), container, MESSAGE, () => { reloads++; }), 'no-waiting-worker');
    assert.equal(container.listeners.size, 0); container.fireControllerChange(); assert.equal(reloads, 0);
  });
});

describe('checkForUpdate', () => {
  it('regression 3: an offline update check resolves quietly instead of rejecting', async () => {
    const reg = new FakeRegistration(); reg.updateImpl = () => Promise.reject(new TypeError('Failed to fetch'));
    await assert.doesNotReject(checkForUpdate(reg));
  });

  it('calls registration.update() and also survives a synchronous throw', async () => {
    const reg = new FakeRegistration(); let calls = 0; reg.updateImpl = async () => { calls++; };
    await checkForUpdate(reg); assert.equal(calls, 1);
    reg.updateImpl = () => { throw new Error('boom'); };
    await assert.doesNotReject(checkForUpdate(reg));
  });
});

describe('wiring', () => {
  it('registration and banner use the lifecycle helpers; the banner passes SKIP_WAITING and no code path reloads automatically', async () => {
    const { readFile } = await import('node:fs/promises');
    const banner = await readFile(new URL('../src/components/layout/UpdateBanner.tsx', import.meta.url), 'utf8');
    const registration = await readFile(new URL('../src/pwa/registerServiceWorker.ts', import.meta.url), 'utf8');
    assert.match(banner, /requestUpdateActivation\(/); assert.match(banner, /watchForWaitingWorker\(/);
    assert.equal((banner.match(/location\.reload\(\)/g) ?? []).length, 1, 'the only reload is the callback handed to requestUpdateActivation');
    assert.doesNotMatch(registration, /\.update\(\)/, 'update checks go through checkForUpdate so offline failures are caught');
    assert.match(registration, /checkForUpdate\(registration\)/);
    assert.doesNotMatch(banner + registration, /setTimeout|setInterval|skipWaiting\(/);
    assert.doesNotMatch(banner, /hover:bg-gold-300/, 'gold-300 is not defined in tailwind.config.js');
  });
});
