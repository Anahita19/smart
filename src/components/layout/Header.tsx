interface HeaderProps {
  title: string;
  subtitle: string;
}

export function Header({ title, subtitle }: HeaderProps) {
  return (
    <header className="px-4 pt-6 sm:px-6 lg:px-10 lg:pt-10">
      <h1 className="text-2xl font-semibold tracking-tight text-navy-900 sm:text-3xl">{title}</h1>
      <p className="mt-1 text-sm text-navy-500">{subtitle}</p>
    </header>
  );
}
