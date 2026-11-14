/**
 * Stage 6 final QA: regression tests for the defects found in the audit, plus the GitHub Pages /
 * service-worker / asset checks that need no browser and no installed dependencies.
 *
 * Run: node --test tests/pwa.stage6.hardening.test.mjs
 * (The accepted tests in pwa.stage6.test.mjs are untouched.)
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(resolve(root, path), 'utf8');
const SCOPE = 'https://user.github.io/expense-repo/'; // a GitHub Pages project site

// ───────────── minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) ─────────────
function decodePng(buf) {
  assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  let pos = 8, header; const idat = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colour: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  assert.equal(header.depth, 8); assert.ok([2, 6].includes(header.colour), 'RGB or RGBA'); assert.equal(header.interlace, 0);
  const bpp = header.colour === 6 ? 4 : 3; const stride = header.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat)); const out = Buffer.alloc(header.height * stride);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= bpp ? out[(y - 1) * stride + i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + i] = (x + [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
    }
  }
  return { ...header, pixel: (x, y) => { const o = y * stride + x * bpp; return [out[o], out[o + 1], out[o + 2], bpp === 4 ? out[o + 3] : 255]; } };
}

// ───────────── regression: the page must keep the app's own background (defect 1) ─────────────
describe('index.html: first-paint colour must not override the app background', () => {
  it('has no inline style on <html> or <body> (an inline body background beat bg-sand-100 and made headings unreadable)', async () => {
    const html = await read('index.html');
    assert.doesNotMatch(html, /<(?:html|body)\b[^>]*\sstyle=/i);
  });

  it('paints the first frame navy on <html> only, in a <style> block', async () => {
    const html = (await read('index.html')).replace(/\/\*[\s\S]*?\*\//g, ''); // ignore CSS comments
    assert.match(html, /<style>\s*html\s*\{\s*background:\s*#0B1424;?\s*\}\s*<\/style>/);
    assert.doesNotMatch(html, /\bbody\s*\{[^}]*background/i, 'nothing may set a <body> background before the app CSS does');
  });

  it('the app itself still sets the page background on body (what the first-paint style must not override)', async () => {
    const css = await read('src/index.css');
    assert.match(css, /body\s*\{[^}]*@apply[^}]*\bbg-sand-100\b/s);
  });

  it('uses an opaque iOS status bar (black-translucent draws the page under the status bar; the header has no top safe-area padding)', async () => {
    const html = await read('index.html');
    assert.doesNotMatch(html, /black-translucent/);
    assert.match(html, /apple-mobile-web-app-status-bar-style" content="default"/);
  });
});

// ───────────── manifest and assets (checks C) ─────────────
describe('manifest, icons and referenced assets', () => {
  it('has no "id": a relative id resolves against the origin, so all project sites of one GitHub user would share one app identity', async () => {
    const manifest = JSON.parse(await read('public/manifest.webmanifest'));
    assert.equal('id' in manifest, false);
  });

  it('start_url and scope resolve to the project root below a GitHub Pages subpath', async () => {
    const manifest = JSON.parse(await read('public/manifest.webmanifest'));
    const manifestUrl = new URL('manifest.webmanifest', SCOPE);
    assert.equal(new URL(manifest.start_url, manifestUrl).href, SCOPE);
    assert.equal(new URL(manifest.scope, manifestUrl).href, SCOPE);
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.lang, 'en');
    assert.equal(manifest.dir, undefined);
  });

  it('theme and background colours match the theme-color meta tag', async () => {
    const manifest = JSON.parse(await read('public/manifest.webmanifest'));
    const html = await read('index.html');
    const meta = html.match(/name="theme-color" content="(#[0-9A-Fa-f]{6})"/)[1];
    assert.equal(manifest.theme_color.toLowerCase(), meta.toLowerCase());
    assert.equal(manifest.background_color.toLowerCase(), meta.toLowerCase());
  });

  it('declares 192 and 512 "any" icons plus a 512 maskable icon, and every file exists with the declared size', async () => {
    const manifest = JSON.parse(await read('public/manifest.webmanifest'));
    const key = (i) => `${i.sizes}/${i.purpose}`;
    assert.deepEqual(manifest.icons.map(key).sort(), ['192x192/any', '512x512/any', '512x512/maskable']);
    for (const icon of manifest.icons) {
      const png = decodePng(await readFile(resolve(root, 'public', icon.src.replace(/^\.\//, ''))));
      assert.equal(`${png.width}x${png.height}`, icon.sizes);
      assert.equal(icon.type, 'image/png');
    }
  });

  it('maskable icon is fully opaque and its artwork stays inside the 80% safe zone (circle of radius 40%)', async () => {
    const png = decodePng(await readFile(resolve(root, 'public/icons/icon-maskable-512.png')));
    const background = png.pixel(0, 0); const centre = (png.width - 1) / 2; let farthest = 0;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const p = png.pixel(x, y);
      assert.equal(p[3], 255, `transparent pixel at ${x},${y}: the platform mask would show through`);
      if (Math.abs(p[0] - background[0]) + Math.abs(p[1] - background[1]) + Math.abs(p[2] - background[2]) > 60) farthest = Math.max(farthest, Math.hypot(x - centre, y - centre));
    }
    assert.ok(farthest > 0, 'icon has artwork');
    assert.ok(farthest <= png.width * 0.4, `artwork reaches ${(farthest / png.width * 100).toFixed(1)}% of the width, limit 40%`);
  });

  it('Apple touch icon is 180x180 and opaque (iOS fills transparency with black)', async () => {
    const png = decodePng(await readFile(resolve(root, 'public/icons/apple-touch-icon.png')));
    assert.equal(`${png.width}x${png.height}`, '180x180');
    for (const [x, y] of [[0, 0], [179, 0], [0, 179], [179, 179], [90, 90]]) assert.equal(png.pixel(x, y)[3], 255);
  });

  it('every shell file referenced by index.html or the manifest exists and is in the plugin precache list', async () => {
    const html = await read('index.html'); const vite = await read('vite.config.ts');
    const manifest = JSON.parse(await read('public/manifest.webmanifest'));
    const listed = [...vite.matchAll(/'(\.\/(?:manifest\.webmanifest|icons\/[^']+))'/g)].map((m) => m[1]);
    const referenced = [
      html.match(/rel="manifest" href="([^"]+)"/)[1],
      html.match(/rel="apple-touch-icon" href="([^"]+)"/)[1],
      ...manifest.icons.map((i) => i.src),
    ];
    for (const path of referenced) {
      await readFile(resolve(root, 'public', path.replace(/^\.\//, ''))); // throws if missing
      assert.ok(listed.includes(path), `${path} is referenced but not precached`);
    }
  });
});

// ───────────── the real build plugin, run against a fake Rollup bundle (checks A) ─────────────
async function loadPlugin() {
  const dir = await mkdtemp(join(tmpdir(), 'pwa-plugin-'));
  await cp(resolve(root, 'public'), join(dir, 'public'), { recursive: true });
  let source = await read('vite.config.ts');
  // Only the two third-party imports are stubbed; the plugin and config code run unchanged.
  source = source.replace("import react from '@vitejs/plugin-react';", 'const react = () => ({ name: "react-stub" });')
    .replace("import { defineConfig, type Plugin } from 'vite';", 'const defineConfig = (c: any) => c;\ntype Plugin = any;');
  assert.doesNotMatch(source, /from '(?:vite|@vitejs\/plugin-react)'/, 'stubbing must remove both imports');
  await writeFile(join(dir, 'vite.config.ts'), source);
  const config = (await import(pathToFileURL(join(dir, 'vite.config.ts')).href)).default;
  return { dir, config, plugin: config.plugins.find((p) => p.name === 'smart-expense-tracker-pwa-shell') };
}
const bundleOf = (js = 'console.log(1)', html = '<html>v1</html>') => ({
  'index.html': { type: 'asset', fileName: 'index.html', source: html },
  'assets/index-AAAA1111.js': { type: 'chunk', fileName: 'assets/index-AAAA1111.js', code: js },
  'assets/index-BBBB2222.css': { type: 'asset', fileName: 'assets/index-BBBB2222.css', source: 'body{}' },
});

describe('vite.config.ts: GitHub Pages base and the inline PWA plugin', () => {
  it('uses a relative base and emits sw.js at the root of the build output with the build ID and precache list injected', async () => {
    const { dir, config, plugin } = await loadPlugin();
    const out = await mkdtemp(join(tmpdir(), 'pwa-dist-'));
    try {
      assert.equal(config.base, './');
      assert.equal(plugin.apply, 'build', 'dev server must not get a service worker');
      await plugin.writeBundle({ dir: out }, bundleOf());
      const sw = await readFile(join(out, 'sw.js'), 'utf8'); // sw.js directly in the output root, next to index.html
      assert.doesNotMatch(sw, /__BUILD_ID__|__PRECACHE_MANIFEST__/, 'no placeholder may survive');
      assert.match(sw, /const BUILD_ID = "[0-9a-f]{12}";/);
      const paths = JSON.parse(sw.match(/const PRECACHE_PATHS = (\[.*?\]);/)[1]);
      assert.deepEqual(paths, ['./index.html', './assets/index-AAAA1111.js', './assets/index-BBBB2222.css', './manifest.webmanifest',
        './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png']);
      for (const p of paths) {
        assert.match(p, /^\.\/[^.]/, 'relative to the service-worker scope');
        assert.ok(new URL(p, SCOPE).href.startsWith(SCOPE), `${p} stays inside ${SCOPE}`);
      }
    } finally { await rm(dir, { recursive: true }); await rm(out, { recursive: true }); }
  });

  it('build ID is deterministic and changes whenever the shell changes', async () => {
    const { dir, plugin } = await loadPlugin();
    const out = await mkdtemp(join(tmpdir(), 'pwa-dist-'));
    const idOf = async (bundle) => { await plugin.writeBundle({ dir: out }, bundle); return (await readFile(join(out, 'sw.js'), 'utf8')).match(/BUILD_ID = "([0-9a-f]{12})"/)[1]; };
    try {
      const base = await idOf(bundleOf());
      assert.equal(await idOf(bundleOf()), base, 'same input, same ID');
      assert.notEqual(await idOf(bundleOf('console.log(2)')), base, 'JS changed');
      assert.notEqual(await idOf(bundleOf('console.log(1)', '<html>v2</html>')), base, 'index.html changed');
    } finally { await rm(dir, { recursive: true }); await rm(out, { recursive: true }); }
  });

  it('only application-shell file types are listed (html, js, css, manifest, icons): nothing user-supplied', async () => {
    const { dir, plugin } = await loadPlugin();
    const out = await mkdtemp(join(tmpdir(), 'pwa-dist-'));
    try {
      const bundle = { ...bundleOf(), 'assets/backup.json': { type: 'asset', fileName: 'assets/backup.json', source: '{}' }, 'assets/data.csv': { type: 'asset', fileName: 'assets/data.csv', source: 'a,b' } };
      await plugin.writeBundle({ dir: out }, bundle);
      const sw = await readFile(join(out, 'sw.js'), 'utf8');
      assert.doesNotMatch(sw, /backup\.json|data\.csv/);
    } finally { await rm(dir, { recursive: true }); await rm(out, { recursive: true }); }
  });
});

// ───────────── service worker (checks B) with a more realistic fake than the accepted test ─────────────
async function bootWorker({ paths = ['./index.html', './assets/app.js', './manifest.webmanifest'], withRequest = true } = {}) {
  const template = await read('public/sw.js');
  const source = template.replace("'__BUILD_ID__'", "'v2'").replace('/*__PRECACHE_MANIFEST__*/ []', JSON.stringify(paths));
  const listeners = new Map(); const stores = new Map(); const added = []; const puts = []; const deleted = []; const network = [];
  class FakeRequest { constructor(url, init = {}) { this.url = url; this.cache = init.cache ?? 'default'; this.method = 'GET'; } }
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async addAll(requests) { for (const r of requests) { added.push(r); store.set(typeof r === 'string' ? r : r.url, { cached: typeof r === 'string' ? r : r.url }); } },
        async put(request, response) { puts.push(request); store.set(typeof request === 'string' ? request : request.url, response); },
        async match(request) { return store.get(typeof request === 'string' ? request : request.url); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deleted.push(name); return stores.delete(name); },
  };
  let skipWaiting = 0;
  const self = {
    registration: { scope: SCOPE }, location: { origin: new URL(SCOPE).origin },
    clients: { async claim() {} }, async skipWaiting() { skipWaiting += 1; },
    addEventListener(name, fn) { listeners.set(name, fn); },
  };
  const context = { self, caches, URL, Set, Promise, async fetch(r) { network.push(r.url ?? r); return { network: r.url ?? r }; } };
  if (withRequest) context.Request = FakeRequest;
  vm.runInNewContext(source, context, { filename: 'sw.js' });
  const run = async (name) => { const e = { waitUntil(p) { this.p = p; } }; listeners.get(name)(e); await e.p; };
  const fetchEvent = (request) => { const e = { request, intercepted: false, respondWith(p) { this.intercepted = true; this.response = p; } }; listeners.get('fetch')(e); return e; };
  return { run, fetchEvent, stores, added, puts, deleted, network, listeners, source, get skipWaiting() { return skipWaiting; } };
}

describe('service worker safety', () => {
  it('precaches with cache:"reload" so a GitHub Pages HTTP-cached (max-age=600) old index.html is never stored under the new build ID (regression)', async () => {
    const w = await bootWorker(); await w.run('install');
    assert.equal(w.added.length, 3);
    for (const r of w.added) { assert.equal(typeof r, 'object'); assert.equal(r.cache, 'reload', r.url); }
    assert.ok(w.stores.get('smart-expense-tracker-shell-v2').has(`${SCOPE}index.html`));
  });

  it('still precaches plain URLs when Request is unavailable (the accepted test fake)', async () => {
    const w = await bootWorker({ withRequest: false }); await w.run('install');
    assert.deepEqual(w.added.map(String).sort(), [`${SCOPE}assets/app.js`, `${SCOPE}index.html`, `${SCOPE}manifest.webmanifest`]);
  });

  it('never caches anything at runtime: the only cache write is the install-time precache', async () => {
    const w = await bootWorker(); await w.run('install');
    assert.equal(w.puts.length, 0);
    assert.doesNotMatch(w.source, /\.put\(|\.add\(|localStorage|sessionStorage|indexedDB|smart-expense-tracker:v1/);
    assert.equal((w.source.match(/cache\.addAll/g) ?? []).length, 1);
  });

  it('after install the shell loads offline: navigation and shell assets are answered from the cache with no network call', async () => {
    const w = await bootWorker(); await w.run('install');
    const nav = w.fetchEvent({ method: 'GET', mode: 'navigate', url: SCOPE });
    assert.equal((await nav.response).cached, `${SCOPE}index.html`);
    const asset = w.fetchEvent({ method: 'GET', mode: 'cors', url: `${SCOPE}assets/app.js` });
    assert.equal((await asset.response).cached, `${SCOPE}assets/app.js`);
    assert.deepEqual(w.network, []);
  });

  it('does not intercept POST/PUT/DELETE, other origins, blob/data URLs, backup or import files, or non-shell GETs', async () => {
    const w = await bootWorker(); await w.run('install');
    const cases = [
      { method: 'POST', mode: 'cors', url: `${SCOPE}assets/app.js` }, { method: 'PUT', mode: 'cors', url: `${SCOPE}x` }, { method: 'DELETE', mode: 'cors', url: `${SCOPE}x` },
      { method: 'GET', mode: 'cors', url: 'https://cdn.example.com/lib.js' },
      { method: 'GET', mode: 'cors', url: `${SCOPE}smart-expense-tracker-backup.json` }, { method: 'GET', mode: 'cors', url: `${SCOPE}export.csv` },
      { method: 'GET', mode: 'cors', url: `${SCOPE}assets/app.js?download=1` }, { method: 'GET', mode: 'cors', url: `${SCOPE}icons/other.png` },
    ];
    for (const request of cases) assert.equal(w.fetchEvent(request).intercepted, false, `${request.method} ${request.url}`);
  });

  it('activation deletes only older caches with this app’s prefix and leaves every other cache (including look-alikes) alone', async () => {
    const w = await bootWorker(); await w.run('install');
    for (const name of ['smart-expense-tracker-shell-v1', 'smart-expense-tracker-shell-', 'other-app-shell-v1', 'smart-expense-tracker:v1:transactions', 'workbox-precache', 'smart-expense-tracker-shell']) w.stores.set(name, new Map());
    await w.run('activate');
    assert.deepEqual([...w.deleted].sort(), ['smart-expense-tracker-shell-', 'smart-expense-tracker-shell-v1']);
    for (const kept of ['smart-expense-tracker-shell-v2', 'other-app-shell-v1', 'smart-expense-tracker:v1:transactions', 'workbox-precache', 'smart-expense-tracker-shell']) assert.ok(w.stores.has(kept), kept);
  });

  it('an updated worker waits: install and activate never call skipWaiting; only an explicit SKIP_WAITING message does', async () => {
    const w = await bootWorker(); await w.run('install'); await w.run('activate');
    assert.equal(w.skipWaiting, 0);
    w.listeners.get('message')({ data: { type: 'SOMETHING_ELSE' } }); w.listeners.get('message')({ data: null }); w.listeners.get('message')({});
    assert.equal(w.skipWaiting, 0);
    w.listeners.get('message')({ data: { type: 'SKIP_WAITING' } });
    assert.equal(w.skipWaiting, 1);
  });

  it('a failed precache fails the install (the old worker keeps serving) instead of activating a half-filled cache', async () => {
    const template = await read('public/sw.js');
    assert.match(template, /await cache\.addAll\(/, 'addAll rejects when any response is not OK; the install promise must not swallow it');
    assert.doesNotMatch(template.match(/addEventListener\('install'[\s\S]*?\n\}\);/)[0], /catch/);
  });
});
