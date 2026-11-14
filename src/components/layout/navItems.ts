import { Activity, ArrowLeftRight, Database, LayoutDashboard, Lightbulb } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ViewId } from '@/types/navigation';

export interface NavItem {
  id: ViewId;
  /** Short label used in the navigation. */
  label: string;
  icon: LucideIcon;
  /** Page heading and subheading shown in the header. */
  title: string;
  subtitle: string;
}

export const navItems: readonly NavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    title: 'Dashboard',
    subtitle: 'Your financial overview at a glance',
  },
  {
    id: 'transactions',
    label: 'Transactions',
    icon: ArrowLeftRight,
    title: 'Transactions',
    subtitle: 'Review and manage your income and expenses',
  },
  {
    id: 'analytics',
    label: 'Analytics',
    icon: Activity,
    title: 'Analytics',
    subtitle: 'Understand where your money goes',
  },
  {
    id: 'insights',
    label: 'Insights',
    icon: Lightbulb,
    title: 'Insights',
    subtitle: 'Savings, spending trends and warnings for any date range',
  },
  {
    id: 'data',
    label: 'Data',
    icon: Database,
    title: 'Data',
    subtitle: 'Back up your transactions to a file',
  },
];
