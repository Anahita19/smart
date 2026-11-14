import { useState } from 'react';
import { AnalyticsPage } from '@/components/analytics/AnalyticsPage';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { DataPage } from '@/components/data/DataPage';
import { InsightsPage } from '@/components/insights/InsightsPage';
import { AppLayout } from '@/components/layout/AppLayout';
import { UpdateBanner } from '@/components/layout/UpdateBanner';
import { navItems } from '@/components/layout/navItems';
import { TransactionsPage } from '@/components/transactions/TransactionsPage';
import { TransactionsProvider, useActualTransactions, useTransactions } from '@/state/TransactionsContext';
import type { ViewId } from '@/types/navigation';

function AppContent() {
  const [view, setView] = useState<ViewId>('dashboard');
  // Single source of truth: Dashboard, Transactions and Analytics all read the same context,
  // so any add/edit/delete is reflected everywhere immediately. Dashboard and Analytics only see
  // actual transactions (dated today or earlier); see lib/datePolicy.
  const { persistenceOk, storageNotice, dismissStorageNotice } = useTransactions();
  const actualTransactions = useActualTransactions();

  const current = navItems.find((item) => item.id === view) ?? navItems[0];

  return (
    <>
      <UpdateBanner />
      <AppLayout
        activeView={view}
        onNavigate={setView}
        title={current.title}
        subtitle={current.subtitle}
      >
        {!persistenceOk && (
          <div
            role="alert"
            className="mb-6 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
          >
            Your changes couldn’t be saved to this browser (storage may be full or disabled). They will
            be lost when you close or refresh the page.
          </div>
        )}
        {storageNotice && (
          <div
            role="alert"
            className="mb-6 flex items-start justify-between gap-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
          >
            <p className="min-w-0 flex-1">{storageNotice.message}</p>
            <button
              type="button"
              onClick={dismissStorageNotice}
              className="shrink-0 rounded-lg px-3 py-1 text-sm font-medium ring-1 ring-amber-300 transition-colors hover:bg-amber-100"
            >
              Dismiss
            </button>
          </div>
        )}
        {view === 'dashboard' && (
          <Dashboard
            transactions={actualTransactions}
            onViewAllTransactions={() => setView('transactions')}
          />
        )}
        {view === 'transactions' && <TransactionsPage />}
        {view === 'analytics' && <AnalyticsPage />}
        {view === 'insights' && <InsightsPage />}
        {view === 'data' && <DataPage />}
      </AppLayout>
    </>
  );
}

export default function App() {
  return (
    <TransactionsProvider>
      <AppContent />
    </TransactionsProvider>
  );
}
