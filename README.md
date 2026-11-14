# Smart Expense Tracker

A personal finance dashboard for tracking income and expenses, built with React, TypeScript and Tailwind CSS. It runs entirely in the browser: no backend, no account, no network requests for your data. It can be installed as an offline-capable PWA.

## Features

**Dashboard**
- Total balance, total income, total expenses and savings rate
- Recent transactions and top spending categories

**Transactions**
- Add, edit and delete transactions (delete asks for confirmation)
- Validation: positive amount with up to 2 decimals, required description (max 80 characters), category matching the transaction type, valid calendar date
- Search (description and category name), filter by type, category and date range, sort by date or amount
- Pagination (10 per page); filters reset to page 1 and the page is clamped when rows are deleted
- **Date policy:** scheduled transactions are not supported, so a transaction can't be dated after today. Existing future-dated records are kept and flagged, but are excluded from balances, the Dashboard, Analytics and Insights until their date is corrected. The rule lives in `src/lib/datePolicy.ts` and is enforced in the store as well as the form. "Today" is read from the clock on every render rather than stored, so every screen follows the calendar after midnight

**Analytics**
- Income vs. expenses per month (latest 12 months, gap months shown as zero)
- Spending-by-category donut chart and ranked breakdown
- Period selector (all time or a single month)
- Charts are hand-built SVG, with no chart library, and come with an accessible data table

**Insights**
- Analysis of a chosen date range, compared with the previous period
- Monthly income, expenses, savings and savings rate (partial months are marked and left out of averages)
- Top categories, spending trend and unusual-expense detection
- Plain-language notes with a severity (critical, warning, note, good news)

**Data (backup and restore)**
- **Export** a JSON backup. The file is versioned and carries a SHA-256 checksum
- **Import & Restore:** choosing a file only reads and checks it and shows a counts-only preview (backup date, incoming / new / duplicate / conflicting transactions, validation result). Nothing changes until you confirm
  - **Merge** (default) keeps every existing transaction, and the existing version of any record whose id matches but whose content differs
  - **Replace** needs a typed confirmation and takes a safety snapshot first
  - Invalid files (bad JSON, checksum, version, any invalid transaction, duplicate ids) are rejected as a whole
  - Restore is refused while this tab has unsaved changes, and success is reported only after the data has been written and read back
- Backups are **readable, unencrypted JSON**. Keep them somewhere safe
- The whole interface is in English (left-to-right). User-entered text in any script, including right-to-left languages, is displayed correctly

**Persistence**
- Data lives in `localStorage` (key `smart-expense-tracker:v1:transactions`) and survives refresh. First run starts empty; demo data is never inserted automatically
- The app tells apart *no data yet*, *valid data*, *corrupt data* and *unreadable storage*. Before unreadable or invalid content is replaced or pruned, the original raw string is copied to a separate recovery entry (never overwritten); if that copy can't be made, saving is paused
- New saves use a versioned envelope (`{ schemaVersion, savedAt, transactions }`); the older bare-array format is still read. Data from an unsupported newer version is left untouched
- If another tab changes the data, this tab loads the newer version instead of overwriting it with stale state
- A visible warning appears if the browser refuses to save (private mode, full storage)
- Money is stored as integer cents; currency and dates use the built-in `Intl` APIs

**Install as an app (PWA)**
- Installable from a supported browser over HTTPS; the app shell is cached for offline launch
- The service worker precaches only `index.html`, the built JavaScript/CSS, the manifest and the icons. It never caches your data or backup files
- A new version waits until you press **Reload** in the *Update ready* banner. The reload is refused while it could lose data (a failed or pending save, an open unsaved form, a restore in progress)

## Tech stack

| Area | Choice |
| --- | --- |
| UI | React 19 |
| Language | TypeScript (`strict`) |
| Build tool | Vite 7 |
| Styling | Tailwind CSS 3 |
| Icons | Lucide React |
| Tests | Node's built-in test runner (no test framework dependency) |

## Getting started

**Prerequisites:** Node.js 20.19+ (or 22.12+) and npm. Running the tests needs **Node 22 or newer**, because they execute TypeScript directly.

```bash
npm install        # install dependencies
npm run dev        # start the development server
npm run typecheck  # type-check the whole project
npm test           # run all tests (TypeScript suite + PWA source checks)
npm run build      # type-check and create a production build in dist/
npm run preview    # serve the production build locally
```

`npm test` runs two parts, which you can also run on their own: `npm run test:ts` and `npm run test:pwa`.

## Project structure

```
src/
├── components/
│   ├── analytics/     # AnalyticsPage, MonthlyChart, CategoryBreakdown
│   ├── dashboard/     # Dashboard, StatCard, RecentTransactions, SpendingByCategory
│   ├── data/          # DataPage (export), ImportRestoreCard, UI wording (importCopy, exportCopy)
│   ├── insights/      # InsightsPage, range filter, savings, trend, top categories
│   ├── layout/        # AppLayout, Sidebar, MobileNav, Header, UpdateBanner
│   ├── transactions/  # TransactionsPage, filters, rows, pagination, form, delete dialog
│   └── ui/            # Reusable primitives (Card, EmptyState, Modal, form styles)
├── data/              # Category definitions and demo data (not used automatically)
├── lib/               # Pure logic: calculations, analytics, insights, storage, backup, import/restore
├── pwa/               # Service-worker registration, update lifecycle, reload guard
├── state/             # Reducer and React context (single source of truth)
├── types/             # Shared TypeScript types
├── App.tsx            # View switching and provider
└── main.tsx           # Entry point
public/                # Web manifest, icons, service-worker template (sw.js)
tests/                 # Node test-runner suites
```

## Architecture notes

- **Pure logic, separated from the UI.** Calculations, analytics, insights, storage, backup and import/restore are plain TypeScript with no React, so the rules are unit-tested directly.
- **Money as integer cents**, converted only for display, which avoids floating-point rounding errors in totals.
- **One store.** `TransactionsProvider` (reducer + context) owns the transactions and persists them after each change; views derive everything from it.
- **Guarded persistence.** `lib/storage.ts` validates every stored record, preserves the original before dropping anything, and guards each write against stale tabs. Restore goes through one function that takes a snapshot first and verifies the write by reading it back.
- **Local-date parsing.** ISO dates (`YYYY-MM-DD`) are parsed as local calendar dates to avoid off-by-one-day shifts caused by UTC parsing.
- **Safe category lookup.** Unknown category ids fall back to "Uncategorized" instead of crashing.
- **Path alias.** `@/` maps to `src/` in `tsconfig.app.json`, `vite.config.ts` and the test loader.

## Deploying to GitHub Pages

The build uses relative asset paths (`base: './'`), so it works below `/<repository>/` without hard-coding the repository name. `npm run build` also generates `dist/sw.js` with the precache list for that build.

Two GitHub Actions workflows are included:

- `.github/workflows/ci.yml` type-checks, tests and builds on every pull request and on pushes to `main`.
- `.github/workflows/pages.yml` runs the same checks and then deploys `dist/` to GitHub Pages on pushes to `main`.

To use them:

1. Commit `package-lock.json` (the workflows use `npm ci`, which needs it).
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`, then open `https://<user>.github.io/<repository>/` over HTTPS.

Notes:

- Deploy as a **project site**. A service worker at a user site's root (`<user>.github.io/`) would also cover that account's other project sites.
- Browser storage is tied to the origin and path. **Export a backup before the first deployment to a new address and before any later change of address**; otherwise the data can seem to disappear (it remains on the old address).
- The first visit must be online once so the app shell can be cached.
- On Android/Chrome use the browser's **Install app** menu. On iOS use **Share → Add to Home Screen**; iOS installation and offline behaviour should be checked separately.

## Roadmap

- [x] Foundation, layout and navigation
- [x] Transactions, analytics and local persistence
- [x] Insights and automated tests
- [x] Backup export, import and restore
- [x] Installable offline PWA with a safe update flow
- [ ] Check install, offline launch, backup download and the update flow on a real Android device
- [x] MIT license
- [ ] Screenshots

## License

Released under the [MIT License](LICENSE).
