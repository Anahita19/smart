import type { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
}

export function Card({ children, className = '' }: CardProps) {
  return (
    <div className={`rounded-2xl bg-white shadow-card ring-1 ring-navy-950/5 ${className}`}>
      {children}
    </div>
  );
}
