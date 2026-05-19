import './globals.css';
import Link from 'next/link';

export const metadata = {
  title: 'Even-Tutor',
  description: 'MKSAP-grounded medical study companion',
};

const NAV = [
  { href: '/ask', label: 'Ask' },
  { href: '/search', label: 'Search' },
  { href: '/browse', label: 'Browse' },
  { href: '/practice', label: 'Practice' },
  { href: '/topics', label: 'Topics' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <header className="border-b bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <Link href="/" className="flex items-center gap-2">
              <span className="text-xl font-semibold tracking-tight text-brand">Even-Tutor</span>
              <span className="rounded bg-brand-faint px-1.5 py-0.5 text-[11px] font-medium text-brand">v0.1</span>
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="rounded px-3 py-1.5 text-slate-700 hover:bg-slate-100"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
