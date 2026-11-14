import { Wallet } from 'lucide-react';
import type { ViewId } from '@/types/navigation';
import { navItems } from './navItems';

interface SidebarProps {
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
}

/** Desktop navigation (hidden below the `lg` breakpoint, where MobileNav takes over). */
export function Sidebar({ activeView, onNavigate }: SidebarProps) {
  return (
    <aside className="hidden flex-col bg-navy-950 px-5 py-8 lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0">
      <div className="flex items-center gap-3 px-2">
        <span className="grid size-10 place-items-center rounded-xl bg-gold-500/15 text-gold-400">
          <Wallet className="size-5" aria-hidden="true" />
        </span>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-white">Smart Expense</p>
          <p className="text-xs text-navy-300">Tracker</p>
        </div>
      </div>

      <nav aria-label="Main navigation" className="mt-10 flex flex-col gap-1">
        {navItems.map(({ id, label, icon: Icon }) => {
          const isActive = id === activeView;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              aria-current={isActive ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-white/10 text-white'
                  : 'text-navy-300 hover:bg-white/5 hover:text-white'
              }`}
            >
              <Icon
                className={`size-5 ${isActive ? 'text-gold-400' : ''}`}
                aria-hidden="true"
              />
              {label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
