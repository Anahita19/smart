import {
  Briefcase,
  Building2,
  Car,
  Film,
  Gift,
  GraduationCap,
  HeartPulse,
  Laptop,
  Plane,
  Receipt,
  ShoppingBag,
  ShoppingCart,
  Tag,
  TrendingUp,
  Utensils,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TransactionType } from '@/types/transaction';

export interface Category {
  id: string;
  name: string;
  type: TransactionType;
  icon: LucideIcon;
  /** Hex colour (#RRGGBB) used for icon tints and, later, charts. */
  color: string;
}

export const categories: readonly Category[] = [
  // Income
  { id: 'salary', name: 'Salary', type: 'income', icon: Briefcase, color: '#2F8F6B' },
  { id: 'freelance', name: 'Freelance', type: 'income', icon: Laptop, color: '#3E9BA8' },
  { id: 'investments', name: 'Investments', type: 'income', icon: TrendingUp, color: '#5B7DB1' },
  { id: 'other-income', name: 'Other income', type: 'income', icon: Gift, color: '#8C6BB1' },

  // Expenses
  { id: 'housing', name: 'Housing', type: 'expense', icon: Building2, color: '#2A3A56' },
  { id: 'groceries', name: 'Groceries', type: 'expense', icon: ShoppingCart, color: '#4F8A6B' },
  { id: 'dining', name: 'Dining', type: 'expense', icon: Utensils, color: '#C39A3E' },
  { id: 'transport', name: 'Transport', type: 'expense', icon: Car, color: '#5B7DB1' },
  { id: 'utilities', name: 'Utilities', type: 'expense', icon: Zap, color: '#8C6BB1' },
  { id: 'health', name: 'Health', type: 'expense', icon: HeartPulse, color: '#C0576B' },
  { id: 'entertainment', name: 'Entertainment', type: 'expense', icon: Film, color: '#D98B4C' },
  { id: 'shopping', name: 'Shopping', type: 'expense', icon: ShoppingBag, color: '#A9794E' },
  { id: 'travel', name: 'Travel', type: 'expense', icon: Plane, color: '#3E9BA8' },
  { id: 'education', name: 'Education', type: 'expense', icon: GraduationCap, color: '#7A8F3F' },
  { id: 'other-expense', name: 'Other', type: 'expense', icon: Receipt, color: '#8D96A6' },
];

const categoriesById = new Map(categories.map((category) => [category.id, category]));

const UNKNOWN_CATEGORY: Category = {
  id: 'unknown',
  name: 'Uncategorized',
  type: 'expense',
  icon: Tag,
  color: '#94A3B8',
};

/** Looks up a category by id; never returns undefined so the UI cannot crash on stale data. */
export function getCategory(id: string): Category {
  return categoriesById.get(id) ?? UNKNOWN_CATEGORY;
}

export function getCategoriesByType(type: TransactionType): Category[] {
  return categories.filter((category) => category.type === type);
}
