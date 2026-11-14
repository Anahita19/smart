import type { LucideIcon } from 'lucide-react';

type Tone = 'hero' | 'income' | 'expense' | 'neutral';

interface StatCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: Tone;
  hint?: string;
}

const toneStyles: Record<
  Tone,
  { card: string; label: string; value: string; hint: string; iconWrap: string }
> = {
  hero: {
    card: 'bg-gradient-to-br from-navy-900 to-navy-950 text-white shadow-card',
    label: 'text-navy-200',
    value: 'text-white',
    hint: 'text-navy-300',
    iconWrap: 'bg-gold-500/15 text-gold-400',
  },
  income: {
    card: 'bg-white shadow-card ring-1 ring-navy-950/5',
    label: 'text-navy-500',
    value: 'text-navy-900',
    hint: 'text-navy-400',
    iconWrap: 'bg-emerald-50 text-emerald-700',
  },
  expense: {
    card: 'bg-white shadow-card ring-1 ring-navy-950/5',
    label: 'text-navy-500',
    value: 'text-navy-900',
    hint: 'text-navy-400',
    iconWrap: 'bg-rose-50 text-rose-700',
  },
  neutral: {
    card: 'bg-white shadow-card ring-1 ring-navy-950/5',
    label: 'text-navy-500',
    value: 'text-navy-900',
    hint: 'text-navy-400',
    iconWrap: 'bg-navy-50 text-navy-700',
  },
};

export function StatCard({ label, value, icon: Icon, tone, hint }: StatCardProps) {
  const styles = toneStyles[tone];

  return (
    <div className={`rounded-2xl p-5 ${styles.card}`}>
      <div className="flex items-start justify-between gap-3">
        <p className={`text-sm font-medium ${styles.label}`}>{label}</p>
        <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${styles.iconWrap}`}>
          <Icon className="size-[18px]" aria-hidden="true" />
        </span>
      </div>
      <p className={`mt-4 text-2xl font-semibold tabular-nums tracking-tight sm:text-3xl ${styles.value}`}>
        {value}
      </p>
      {hint && <p className={`mt-1 text-xs ${styles.hint}`}>{hint}</p>}
    </div>
  );
}
