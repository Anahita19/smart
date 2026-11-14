import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

async function loadWorker() {
  const template = await read('public/sw.js');
  const source = template
    .replace("'__BUILD_ID__'", "'test-build'")
    .replace('/*__PRECACHE_MANIFEST__*/ []', JSON.stringify([
      './index.html', './assets/app.js', './assets/app.css', './manifest.webmanifest',
      './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
    ]));
  const listeners = new Map();
  const entries = new Map();
  const deleted = [];
  const cachesApi = {
    async open(name) {
      if (!entries.has(name)) entries.set(name, new Map());
      const cache = entries.get(name);
      return {
        async addAll(urls) { for (const url of urls) cache.set(url, { cached: url }); },
        async match(request) { return cache.get(typeof request === 'string' ? request : request.url); },
      };
    },
    async keys() { return [...entries.keys()]; },
    async delete(name) { deleted.push(name); return entries.delete(name); },
  };
  let skipWaitingCalls = 0;
  const self = {
    registration: { scope: 'https://example.test/expenses/' },
    location: { origin: 'https://example.test' },
    clients: { async claim() {} },
    async skipWaiting() { skipWaitingCalls += 1; },
    addEventListener(name, callback) { listeners.set(name, callback); },
  };
  let networkCalls = 0;
  const context = {
    self,
    caches: cachesApi,
    URL,
    Set,
    Promise,
    async fetch(request) { networkCalls += 1; return { network: request.url }; },
  };
  vm.runInNewContext(source, context, { filename: 'sw.js' });
  return { listeners, entries, deleted, context, get skipWaitingCalls() { return skipWaitingCalls; }, get networkCalls() { return networkCalls; } };
}

describe('Stage 6 PWA shell', () => {
  it('declares standalone install metadata and all required icon sizes', async () => {
    const manifest = JSON.parse(await read('public/manifest.webmanifest'));
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.scope, './');
    assert.equal(manifest.lang, 'en');
    for (const icon of manifest.icons) {
      const bytes = await readFile(resolve(root, 'public', icon.src.replace(/^\.\//, '')));
      assert.equal(bytes.toString('ascii', 1, 4), 'PNG');
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      assert.equal(`${width}x${height}`, icon.sizes);
    }
  });

  it('links the manifest and Apple touch icon and keeps GitHub Pages paths relative', async () => {
    const html = await read('index.html');
    const vite = await read('vite.config.ts');
    assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
    assert.match(html, /rel="apple-touch-icon" href="\.\/icons\/apple-touch-icon\.png"/);
    assert.match(html, /background: #0B1424/);
    assert.match(vite, /base:\s*'\.\/'/);
    assert.match(vite, /pwaShellPlugin\(\)/);
  });

  it('precaches only the shell, serves offline navigation, and ignores unrelated requests', async () => {
    const worker = await loadWorker();
    const installEvent = { waitUntil(promise) { this.promise = promise; } };
    worker.listeners.get('install')(installEvent);
    await installEvent.promise;
    const cache = worker.entries.get('smart-expense-tracker-shell-test-build');
    assert.ok(cache.has('https://example.test/expenses/index.html'));
    assert.ok(cache.has('https://example.test/expenses/assets/app.js'));

    worker.entries.set('smart-expense-tracker-shell-old', new Map());
    const activateEvent = { waitUntil(promise) { this.promise = promise; } };
    worker.listeners.get('activate')(activateEvent);
    await activateEvent.promise;
    assert.deepEqual(worker.deleted, ['smart-expense-tracker-shell-old']);

    let navigationResponse;
    worker.listeners.get('fetch')({
      request: { method: 'GET', mode: 'navigate', url: 'https://example.test/expenses/transactions' },
      respondWith(promise) { navigationResponse = promise; },
    });
    assert.equal((await navigationResponse).cached, 'https://example.test/expenses/index.html');

    let assetResponse;
    worker.listeners.get('fetch')({
      request: { method: 'GET', mode: 'no-cors', url: 'https://example.test/expenses/assets/app.js' },
      respondWith(promise) { assetResponse = promise; },
    });
    assert.equal((await assetResponse).cached, 'https://example.test/expenses/assets/app.js');

    let intercepted = false;
    worker.listeners.get('fetch')({
      request: { method: 'GET', mode: 'cors', url: 'https://example.test/expenses/user-export.csv' },
      respondWith() { intercepted = true; },
    });
    worker.listeners.get('fetch')({
      request: { method: 'GET', mode: 'cors', url: 'https://third-party.test/resource' },
      respondWith() { intercepted = true; },
    });
    worker.listeners.get('fetch')({
      request: { method: 'POST', mode: 'cors', url: 'https://example.test/expenses/api' },
      respondWith() { intercepted = true; },
    });
    assert.equal(intercepted, false);
    assert.equal(worker.networkCalls, 0);
  });

  it('only skips the waiting phase after an explicit message and contains no user-data APIs or keys', async () => {
    const worker = await loadWorker();
    worker.listeners.get('message')({ data: { type: 'OTHER' } });
    assert.equal(worker.skipWaitingCalls, 0);
    worker.listeners.get('message')({ data: { type: 'SKIP_WAITING' } });
    assert.equal(worker.skipWaitingCalls, 1);

    const source = await read('public/sw.js');
    assert.doesNotMatch(source, /localStorage|indexedDB|smart-expense-tracker:v1/i);
    assert.equal((source.match(/skipWaiting\(\)/g) ?? []).length, 1, 'skipWaiting appears only in the explicit message handler');
  });

  it('registers only in production and does not use polling timers', async () => {
    const registration = await read('src/pwa/registerServiceWorker.ts');
    const banner = await read('src/components/layout/UpdateBanner.tsx');
    assert.match(registration, /import\.meta\.env\.PROD/);
    assert.match(registration, /updateViaCache:\s*'none'/);
    assert.match(registration, /visibilitychange/);
    assert.match(banner, /Update ready/);
    assert.match(banner, /SKIP_WAITING/);
    assert.doesNotMatch(registration + banner, /setTimeout|setInterval/);
  });
});
