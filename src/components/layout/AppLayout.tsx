import type { ReactNode } from 'react';
import type { ViewId } from '@/types/navigation';
import { Header } from './Header';
import { MobileNav } from './MobileNav';
import { Sidebar } from './Sidebar';

interface AppLayoutProps {
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
  title: string;
  subtitle: string;
  children: ReactNode;
}

export function AppLayout({ activeView, onNavigate, title, subtitle, children }: AppLayoutProps) {
  return (
    <div className="flex min-h-screen">
      <Sidebar activeView={activeView} onNavigate={onNavigate} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header title={title} subtitle={subtitle} />
        {/* Extra bottom padding on mobile keeps content clear of the fixed tab bar. */}
        <main className="flex-1 px-4 pb-28 pt-6 sm:px-6 lg:px-10 lg:pb-10">{children}</main>
      </div>

      <MobileNav activeView={activeView} onNavigate={onNavigate} />
    </div>
  );
}
