// Test-only module resolver: maps the "@/..." alias (see tsconfig.app.json / vite.config.ts)
// to src/*.ts so the pure-logic modules can run under plain Node without installing anything.
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const SRC = resolvePath(import.meta.dirname, '..', 'src');

// lucide-react is only imported for category icons; the logic under test never renders them,
// so a stand-in module avoids needing node_modules. Tests only.
const ICONS = ['Briefcase','Building2','Car','Film','Gift','GraduationCap','HeartPulse','Laptop','Plane','Receipt','ShoppingBag','ShoppingCart','Tag','TrendingUp','Utensils','Zap'];
const LUCIDE_STUB = 'data:text/javascript,' + encodeURIComponent(ICONS.map((n) => `export const ${n} = () => null;`).join('\n'));

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'lucide-react') return { url: LUCIDE_STUB, shortCircuit: true };
  if (specifier.startsWith('@/')) {
    const base = resolvePath(SRC, specifier.slice(2));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, resolvePath(base, 'index.ts')]) {
      if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
    }
  }
  return nextResolve(specifier, context);
}
