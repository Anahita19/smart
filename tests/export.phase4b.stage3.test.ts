/**
 * Phase 4B, Stage 3 tests: Backup Export UI and its integration (Data page, nav, export module).
 *
 * No React or browser is available (no packages may be installed), so the page itself is covered
 * three ways: the logic it calls (src/lib/exportBackup.ts) is run end-to-end against the real Stage 1
 * engine and real Web Crypto; the browser download is exercised with stubbed DOM globals; and the
 * components are pinned by source-text guards. Nothing here renders the page.
 *
 * Run: node --import ./tests/register-alias.mjs --test "tests/*.test.ts"
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MAX_BACKUP_CHARS,
  buildBackup,
  parseBackup,
  serializeBackup,
} from '../src/lib/backup.ts';
import type { BackupErrorCode, DigestLike } from '../src/lib/backup.ts';
import { exportBackup, saveInBrowser } from '../src/lib/exportBackup.ts';
import type { ExportFailureCode } from '../src/lib/exportBackup.ts';
import {
  EMPTY_NOTE,
  PRIVACY_WARNING_TEXT,
  PRIVACY_WARNING_TITLE,
  SCOPE_NOTE,
  describeExportFailure,
  describeExportSuccess,
  formatCount,
  formatExportDate,
  formatTransactionCount,
} from '../src/components/data/exportCopy.ts';
import { RECOVERY_KEY_PREFIX, SCHEMA_VERSION, STORAGE_KEY, openSession } from '../src/lib/storage.ts';
import type { StorageLike } from '../src/lib/storage.ts';
import type { Transaction } from '../src/types/transaction.ts';

// ───────────── helpers ─────────────

const tx = (id: string, date = '2026-11-01', over: Partial<Transaction> = {}): Transaction => ({
  id, type: 'expense', amount: 1_250, categoryId: 'groceries', description: `item ${id}`, date, ...over,
});
const NOW = new Date(2026, 10, 11, 14, 30, 0); // local 2026-11-11
const LIST = [tx('a', '2026-11-01'), tx('b', '2026-10-05', { type: 'income', categoryId: 'salary', amount: 400_000 }), tx('f', '2099-01-01')];

interface SaveCall { text: string; fileName: string }
function recordingSave() {
  const calls: SaveCall[] = [];
  let released = 0;
  const save = (text: string, fileName: string) => { calls.push({ text, fileName }); return () => { released += 1; }; };
  return { save, calls, released: () => released };
}
const deepFreeze = <T,>(value: T): T => {
  if (typeof value === 'object' && value !== null) { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); }
  return value;
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ───────────── A. the export logic, end to end ─────────────

describe('exportBackup: builds with the Stage 1 engine, verifies, then downloads', () => {
  it('saves exactly one file whose text verifies and round-trips every transaction (future-dated included, order kept)', async () => {
    const rec = recordingSave();
    const out = await exportBackup(LIST, { now: () => NOW, save: rec.save });
    assert.equal(out.ok, true);
    assert.equal(rec.calls.length, 1);
    const parsed = await parseBackup(rec.calls[0]!.text);
    assert.ok(parsed.ok);
    assert.equal(parsed.source, 'backup');
    assert.equal(parsed.meta.checksum, 'verified');
    assert.deepEqual(parsed.transactions, LIST);
    assert.equal(parsed.report.futureDated, 1);
    if (out.ok) {
      assert.equal(out.transactionCount, 3);
      assert.equal(out.fileName, 'smart-expense-tracker-backup-2026-11-11.json');
      assert.equal(rec.calls[0]!.fileName, out.fileName);
      assert.equal(out.exportedAt, NOW.toISOString());
      assert.equal(out.size, rec.calls[0]!.text.length);
    }
  });

  it('uses the real Web Crypto by default (no injected digest)', async () => {
    const rec = recordingSave();
    const out = await exportBackup(LIST, { save: rec.save });
    assert.equal(out.ok, true);
    const parsed = await parseBackup(rec.calls[0]!.text);
    assert.ok(parsed.ok && parsed.meta.checksum === 'verified');
  });

  it('adds no format of its own: the text is byte-for-byte the Stage 1 serialization', async () => {
    const rec = recordingSave();
    await exportBackup(LIST, { now: () => NOW, appVersion: '0.2.0', save: rec.save });
    const expected = serializeBackup(await buildBackup(LIST, { now: NOW, appVersion: '0.2.0' }));
    assert.equal(rec.calls[0]!.text, expected);
    const doc = JSON.parse(rec.calls[0]!.text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(doc).sort(), ['app', 'appSchemaVersion', 'backupVersion', 'checksum', 'counts', 'data', 'exportedAt', 'format']);
    assert.equal(doc.format, BACKUP_FORMAT);
    assert.equal(doc.backupVersion, BACKUP_VERSION);
    assert.equal(doc.appSchemaVersion, SCHEMA_VERSION);
    assert.deepEqual(Object.keys(doc.data as object), ['transactions']);
  });

  it('never changes its input', async () => {
    const frozen = deepFreeze(LIST.map((t) => ({ ...t })));
    const before = JSON.stringify(frozen);
    const rec = recordingSave();
    const out = await exportBackup(frozen, { now: () => NOW, save: rec.save });
    assert.equal(out.ok, true);
    assert.equal(JSON.stringify(frozen), before);
  });

  it('exports nothing but transactions: storage, recovery copies and snapshots are neither read nor written', async () => {
    const store = new Map<string, string>();
    const log: string[] = [];
    const fake: StorageLike = {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => { log.push(`get ${k}`); return store.get(k) ?? null; },
      setItem: (k, v) => { log.push(`set ${k}`); store.set(k, v); },
      removeItem: (k) => { log.push(`remove ${k}`); store.delete(k); },
    };
    store.set(STORAGE_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, savedAt: '2026-11-10T08:00:00.000Z', transactions: LIST }));
    store.set(`${RECOVERY_KEY_PREFIX}zzz-1`, 'RECOVERY-MARKER-1234');
    store.set('smart-expense-tracker:v1:snapshot:zzz-2', 'SNAPSHOT-MARKER-5678');
    const session = openSession(fake, () => 1);
    const loaded = session.boot.transactions;
    const before = new Map(store);
    log.length = 0; // from here on, the export itself must not touch storage at all

    const rec = recordingSave();
    const out = await exportBackup(loaded, { now: () => NOW, save: rec.save });
    assert.equal(out.ok, true);
    assert.deepEqual(log, [], 'the export performed no storage operation');
    assert.deepEqual(store, before);
    assert.doesNotMatch(rec.calls[0]!.text, /MARKER|recovery|snapshot/i);
    assert.deepEqual(((JSON.parse(rec.calls[0]!.text) as { data: { transactions: Transaction[] } }).data.transactions), LIST);
  });

  it('hands over the release function of the save, untouched', async () => {
    const rec = recordingSave();
    const out = await exportBackup(LIST, { save: rec.save });
    assert.ok(out.ok);
    if (out.ok) { out.release(); assert.equal(rec.released(), 1); }
  });

  it('an empty list yields a valid empty backup at this layer (the page itself disables the button)', async () => {
    const rec = recordingSave();
    const out = await exportBackup([], { save: rec.save });
    assert.equal(out.ok, true);
    const parsed = await parseBackup(rec.calls[0]!.text);
    assert.ok(parsed.ok && parsed.transactions.length === 0);
  });
});

describe('exportBackup: every failure stops BEFORE anything is downloaded', () => {
  it('Web Crypto unavailable → clear error, no file', async () => {
    const rec = recordingSave();
    const out = await exportBackup(LIST, { subtle: null, save: rec.save });
    assert.ok(!out.ok);
    assert.equal(out.ok === false && out.code, 'crypto-unavailable');
    assert.equal(rec.calls.length, 0);
  });

  it('a digest that throws is also reported as crypto-unavailable', async () => {
    const rec = recordingSave();
    const broken: DigestLike = { digest: () => Promise.reject(new Error('NotSupportedError')) };
    const out = await exportBackup(LIST, { subtle: broken, save: rec.save });
    assert.equal(out.ok === false && out.code, 'crypto-unavailable');
    assert.equal(rec.calls.length, 0);
  });

  it('crypto.subtle missing on the real global (plain http) → crypto-unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const rec = recordingSave();
      const out = await exportBackup(LIST, { save: rec.save });
      assert.equal(out.ok === false && out.code, 'crypto-unavailable');
      assert.equal(rec.calls.length, 0);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    }
  });

  const bad: [string, Transaction[], ExportFailureCode][] = [
    ['an invalid record', [tx('ok'), { ...tx('x'), amount: -5 }], 'invalid-transactions'],
    ['an impossible date', [tx('ok'), tx('bad', '2026-02-31')], 'invalid-transactions'],
    ['a repeated id', [tx('d'), tx('d', '2026-05-05')], 'duplicate-ids'],
    ['a description over the limit', [tx('long', '2026-01-01', { description: 'x'.repeat(81) })], 'invalid-transactions'],
  ];
  for (const [name, list, expected] of bad) {
    it(`${name} → no incomplete backup is produced`, async () => {
      const rec = recordingSave();
      const out = await exportBackup(list, { save: rec.save });
      assert.equal(out.ok === false && out.code, expected);
      assert.equal(rec.calls.length, 0);
    });
  }

  it('a file that fails its own read-back verification is not saved', async () => {
    const rec = recordingSave();
    let call = 0;
    const flaky: DigestLike = {
      async digest(algo, data) {
        call += 1;
        const real = await globalThis.crypto.subtle.digest(algo, data as BufferSource);
        if (call === 1) return real;
        const copy = new Uint8Array(real.slice(0));
        copy[0] = (copy[0]! + 1) % 256; // the second computation disagrees with the first
        return copy.buffer;
      },
    };
    const out = await exportBackup(LIST, { subtle: flaky, save: rec.save });
    assert.equal(out.ok === false && out.code, 'verification-failed');
    assert.equal(rec.calls.length, 0);
  });

  it('a backup larger than an import would accept is not produced', async () => {
    const big: Transaction[] = Array.from({ length: 45_000 }, (_, i) => tx(`t${i}`, '2026-01-01', { description: 'x'.repeat(80) }));
    const rec = recordingSave();
    const out = await exportBackup(big, { save: rec.save });
    assert.ok(serializeBackup(await buildBackup(big)).length > MAX_BACKUP_CHARS, 'precondition: the file really is over the limit');
    assert.equal(out.ok === false && out.code, 'verification-failed');
    assert.equal(rec.calls.length, 0);
  });

  it('the browser refusing the download → download-failed, never reported as success', async () => {
    const out = await exportBackup(LIST, { save: () => { throw new Error('blocked'); } });
    assert.equal(out.ok === false && out.code, 'download-failed');
  });

  it('failure results carry no transaction contents', async () => {
    const out = await exportBackup([tx('secret-1', '2026-02-31', { description: 'private rent payment' })]);
    assert.ok(!out.ok);
    assert.doesNotMatch(JSON.stringify(out), /private rent|secret-1/);
  });
});

// ───────────── B. the browser download ─────────────

describe('saveInBrowser (DOM stubbed)', () => {
  function stubDom(opts: { clickThrows?: boolean } = {}) {
    const events: string[] = [];
    const urls: string[] = [];
    const blobs: Blob[] = [];
    const anchor: Record<string, unknown> & { style: { display?: string } } = {
      style: {},
      click() { events.push('click'); if (opts.clickThrows) throw new Error('click blocked'); },
    };
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    g.document = {
      createElement: (tag: string) => { events.push(`create ${tag}`); return anchor; },
      body: { appendChild: () => { events.push('append'); }, removeChild: () => { events.push('remove'); } },
    };
    URL.createObjectURL = (blob: Blob) => { blobs.push(blob); const url = `blob:test/${blobs.length}`; urls.push(url); events.push('createURL'); return url; };
    URL.revokeObjectURL = (url: string) => { events.push(`revoke ${url}`); };
    return { events, urls, blobs, anchor, restore() { g.document = saved.document; URL.createObjectURL = saved.create; URL.revokeObjectURL = saved.revoke; } };
  }

  it('downloads a JSON blob through a hidden <a download>, and frees the URL only when told to', async () => {
    const dom = stubDom();
    try {
      const release = saveInBrowser('{"a":1}\n', 'file.json');
      assert.deepEqual(dom.events, ['createURL', 'create a', 'append', 'click', 'remove']);
      assert.equal(dom.anchor.download, 'file.json');
      assert.equal(dom.anchor.href, 'blob:test/1');
      assert.equal(dom.anchor.rel, 'noopener');
      assert.equal(dom.anchor.style.display, 'none');
      assert.equal(dom.blobs[0]!.type, 'application/json;charset=utf-8');
      assert.equal(await dom.blobs[0]!.text(), '{"a":1}\n');
      assert.ok(!dom.events.some((e) => e.startsWith('revoke')), 'not revoked while the download may still be starting');
      release();
      release(); // idempotent
      assert.equal(dom.events.filter((e) => e.startsWith('revoke')).length, 1);
    } finally { dom.restore(); }
  });

  it('a click that fails frees the URL, removes the link and propagates the error', () => {
    const dom = stubDom({ clickThrows: true });
    try {
      assert.throws(() => saveInBrowser('x', 'f.json'), /click blocked/);
      assert.ok(dom.events.includes('remove'));
      assert.ok(dom.events.includes('revoke blob:test/1'));
    } finally { dom.restore(); }
  });

  it('exportBackup reports success only after the download was handed over (full path with the stubbed DOM)', async () => {
    const dom = stubDom();
    try {
      const out = await exportBackup(LIST, { now: () => NOW });
      assert.equal(out.ok, true);
      assert.ok(dom.events.indexOf('click') > dom.events.indexOf('createURL'));
      assert.equal(dom.anchor.download, 'smart-expense-tracker-backup-2026-11-11.json');
      const parsed = await parseBackup(await dom.blobs[0]!.text());
      assert.ok(parsed.ok && parsed.transactions.length === 3);
    } finally { dom.restore(); }
  });
});

// ───────────── C. English copy and formatting ─────────────

describe('exportCopy (English wording)', () => {
  const backupCodes: BackupErrorCode[] = [
    'too-large', 'empty', 'invalid-json', 'unrecognized-format', 'malformed', 'missing-field', 'unsupported-version',
    'migration-failed', 'checksum-missing', 'unsupported-checksum', 'crypto-unavailable', 'checksum-mismatch',
    'count-mismatch', 'invalid-transactions', 'duplicate-ids',
  ];
  const all: ExportFailureCode[] = [...backupCodes, 'verification-failed', 'download-failed', 'unexpected'];

  it('every failure code gets a non-empty English message that says nothing was downloaded', () => {
    for (const c of all) {
      const message = describeExportFailure(c);
      assert.match(message, /[A-Za-z]{3,}/, c);
      assert.doesNotMatch(message, /[\u0600-\u06FF]/, c);
      assert.match(message, /downloaded|created|saved/i, c);
    }
  });

  it('the Web Crypto message names the cause and states that no file was produced', () => {
    const message = describeExportFailure('crypto-unavailable');
    assert.match(message, /SHA-256/);
    assert.match(message, /https|localhost/);
    assert.match(message, /No file was downloaded/);
  });

  it('the privacy warning says: financial information, readable JSON, store securely', () => {
    assert.match(PRIVACY_WARNING_TEXT, /financial information/);
    assert.match(PRIVACY_WARNING_TEXT, /readable/);
    assert.match(PRIVACY_WARNING_TEXT, /unencrypted/);
    assert.match(PRIVACY_WARNING_TEXT, /somewhere safe/);
    assert.match(PRIVACY_WARNING_TITLE, /privacy/i);
  });

  it('the scope note says future-dated transactions are included and snapshots/recovery copies are not', () => {
    assert.match(SCOPE_NOTE, /future-dated/);
    assert.match(SCOPE_NOTE, /snapshots/);
    assert.match(SCOPE_NOTE, /recovery/i);
    assert.match(EMPTY_NOTE, /No transactions/);
  });

  it('the success text is honest: the download was started, not "saved"', () => {
    const text = describeExportSuccess('smart-expense-tracker-backup-2026-11-11.json', 1234);
    assert.match(text, /download of .* has started/);
    assert.match(text, /smart-expense-tracker-backup-2026-11-11\.json/);
    assert.match(text, /1,234 transactions/);
  });

  it('counts use Western digits with thousands separators', () => {
    assert.equal(formatCount(0), '0');
    assert.equal(formatCount(1234), '1,234');
    assert.equal(formatTransactionCount(1), '1 transaction');
    assert.equal(formatTransactionCount(3, 'new'), '3 new transactions');
  });

  it('export date: a readable date plus the ISO date of the local day', () => {
    const d = formatExportDate(NOW);
    assert.equal(d.iso, '2026-11-11');
    assert.equal(d.display, 'Nov 11, 2026');
  });
});

// ───────────── D. wiring, direction and scope guards (source text) ─────────────

describe('Data page, navigation and scope guards', () => {
  const page = read('src/components/data/DataPage.tsx');
  const exportModule = read('src/lib/exportBackup.ts');
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) files.push(full);
    }
  })(srcDir);

  it('no file sets rtl (existing dir=auto on user text and dir=ltr on a chart are unrelated): the whole app is left-to-right', () => {
    assert.doesNotMatch(code(page), /\bdir=["']?rtl|lang="fa"/);
    for (const file of files) {
      assert.doesNotMatch(code(readFileSync(file, 'utf8')), /\bdir=["']?rtl|\bdir:\s*["']rtl|\brtl:|writing-mode/, file);
    }
    assert.doesNotMatch(read('index.html'), /dir=/);
    assert.doesNotMatch(read('src/components/layout/Header.tsx'), /dir=|rtl/);
  });

  it('the page exports ALL transactions (raw list, future-dated included), never the "actual" subset', () => {
    assert.match(page, /useTransactions\(\)/);
    assert.doesNotMatch(page, /useActualTransactions/);
    assert.match(page, /exportBackup\(transactions\)/);
  });

  it('the page shows counts and dates only: no amounts, descriptions or categories', () => {
    assert.doesNotMatch(page, /formatCurrency|\.amount|\.description|\.categoryId|\.type\b|JSON\.stringify|checksum/i);
    assert.match(page, /formatCount\(total\)/);
    assert.match(page, /formatExportDate/);
  });

  it('states are covered: loading (disabled + aria-busy), success (role=status), failure (role=alert), empty', () => {
    assert.match(page, /disabled=\{working \|\| total === 0\}/);
    assert.match(page, /aria-busy=\{working\}/);
    assert.match(page, /role="status"/);
    assert.match(page, /role="alert"/);
    assert.match(page, /if \(working \|\| total === 0\) return;/);
    assert.match(page, /EMPTY_NOTE/);
    assert.match(page, /PRIVACY_WARNING_TEXT/);
    assert.match(page, /PRIVACY_WARNING_TITLE/);
  });

  it('success is shown only from an ok outcome; failures show the mapped message', () => {
    const handler = page.slice(page.indexOf('async function handleExport'), page.indexOf('return (', page.indexOf('async function handleExport')));
    assert.ok(handler.indexOf('if (outcome.ok)') > 0);
    assert.match(handler, /status: 'success'/);
    assert.match(handler, /describeExportFailure\(outcome\.code\)/);
    assert.ok(handler.indexOf("status: 'success'") > handler.indexOf('if (outcome.ok)'));
  });

  it('the temporary download URL is released on the next export and on leaving the page; no timers', () => {
    assert.match(page, /useEffect\(\(\) => \(\) => releaseRef\.current\?\.\(\), \[\]\)/);
    assert.match(page, /releaseRef\.current = outcome\.release/);
    for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /setInterval|setTimeout/, file);
  });

  it('exportBackup.ts only builds the file and downloads it: Stage 1 engine functions, no format/checksum/storage of its own', () => {
    const src = code(exportModule);
    assert.deepEqual([...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort(), ['@/lib/backup', '@/lib/backup', '@/types/transaction']);
    assert.match(src, /createBackupJson\(/);
    assert.match(src, /parseBackup\(/);
    assert.doesNotMatch(src, /JSON\.stringify|crypto\.|\.digest\(|sha256Hex|canonicalJson|computeChecksum/);
    assert.doesNotMatch(src, /localStorage|sessionStorage|STORAGE_KEY|recovery|snapshot|from '@\/lib\/storage'/i);
  });

  it('only the export path and (Stage 4) the import orchestration reach into the backup engine; file input and restore calls live in ONE UI file', () => {
    const importers = files.filter((f) => /from '@\/lib\/backup'/.test(readFileSync(f, 'utf8'))).map((f) => f.split('/src/')[1]).sort();
    assert.deepEqual(importers, ['lib/exportBackup.ts', 'lib/importRestore.ts']);
    // UI code (components and App): no raw file reading and no engine calls anywhere; the file input and
    // the restore call exist only in the Stage 4 import card.
    for (const file of files.filter((f) => /\/src\/(components\/|App\.tsx)/.test(f))) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /FileReader|showOpenFilePicker|planMerge\(|parseBackup\(|buildBackup\(/, file);
      if (file.endsWith('components/data/ImportRestoreCard.tsx')) continue;
      assert.doesNotMatch(readFileSync(file, 'utf8'), /type="file"|restoreTransactions/, file);
    }
    assert.doesNotMatch(code(page).replace(/^import .*$/gm, ''), /\b(restore|merge|replace|snapshot)\b/i);
  });

  it('navigation: "data" is a ViewId, a fifth nav item with a unique id, and App renders the page for it', () => {
    assert.match(read('src/types/navigation.ts'), /'insights' \| 'data'/);
    const items = read('src/components/layout/navItems.ts');
    const ids = [...items.matchAll(/^\s+id: '([a-z]+)',/gm)].map((m) => m[1]);
    assert.deepEqual(ids, ['dashboard', 'transactions', 'analytics', 'insights', 'data']);
    assert.match(items, /id: 'data',\s+label: 'Data',\s+icon: Database,/);
    const app = read('src/App.tsx');
    assert.match(app, /import \{ DataPage \} from '@\/components\/data\/DataPage'/);
    assert.match(app, /\{view === 'data' && <DataPage \/>\}/);
  });

  it('the bottom bar fits five items: five columns, truncating labels, the rest of the bar unchanged', () => {
    const nav = read('src/components/layout/MobileNav.tsx');
    assert.match(nav, /grid grid-cols-5/);
    assert.doesNotMatch(nav, /grid-cols-4/);
    assert.match(nav, /<span className="max-w-full truncate">\{label\}<\/span>/);
    assert.match(nav, /navItems\.map/);
    assert.match(nav, /pb-\[env\(safe-area-inset-bottom\)\]/);
  });
});
