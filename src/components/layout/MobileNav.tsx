import type { ViewId } from '@/types/navigation';
import { navItems } from './navItems';

interface MobileNavProps {
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
}

/** Bottom tab bar for small screens (hidden from the `lg` breakpoint up). */
export function MobileNav({ activeView, onNavigate }: MobileNavProps) {
  return (
    <nav
      aria-label="Main navigation"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-white/10 bg-navy-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul className="grid grid-cols-5">
        {navItems.map(({ id, label, icon: Icon }) => {
          const isActive = id === activeView;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onNavigate(id)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex w-full min-w-0 flex-col items-center gap-1 px-0.5 py-3 text-[11px] font-medium tracking-tight transition-colors sm:text-xs sm:tracking-normal ${
                  isActive ? 'text-gold-400' : 'text-navy-300 hover:text-white'
                }`}
              >
                <Icon className="size-5" aria-hidden="true" />
                <span className="max-w-full truncate">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
