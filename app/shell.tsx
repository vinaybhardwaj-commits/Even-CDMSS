'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MessageSquare, Sparkles, Pill, Calculator, Brain, BookOpen } from 'lucide-react';
import HealthPill from '@/components/HealthPill';

const TABS = [
  { href: '/ask', label: 'Ask', icon: MessageSquare },
  { href: '/ddx', label: 'DDx', icon: Sparkles },
  { href: '/drugs', label: 'Drugs', icon: Pill },
  { href: '/calculators', label: 'Calc', icon: Calculator },
  { href: '/coach', label: 'Coach', icon: Brain },
  { href: '/review', label: 'Review', icon: BookOpen },
];

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  function isActive(href: string) {
    if (href === '/ask') return pathname === '/' || pathname === '/ask' || pathname.startsWith('/ask/');
    return pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <div className="flex min-h-screen flex-col sm:flex-row">
      {/* Sidebar (≥640px) */}
      <aside className="hidden border-r bg-white sm:flex sm:w-56 sm:shrink-0 sm:flex-col">
        <div className="flex items-center gap-2.5 border-b px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand text-white shadow-sm">
            <span className="text-[11px] font-bold tracking-tight">EC</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold leading-tight tracking-tight text-brand">Even CDMSS</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-400">
              <span>v0.9</span>
              <span className="text-slate-300">·</span>
              <HealthPill />
            </div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = isActive(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  active
                    ? 'bg-brand-faint font-semibold text-brand'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <Icon className={`h-5 w-5 ${active ? 'text-brand' : 'text-slate-500'}`} />
                <span>{t.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="border-t px-4 py-3 text-[11px] text-slate-400">
          MKSAP · StatPearls · UpToDate
        </div>
      </aside>

      {/* Main + bottom-tabs (mobile) */}
      <main className="flex-1 pb-16 sm:pb-0">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-8 lg:max-w-4xl">
          {children}
        </div>
      </main>

      <nav className="fixed bottom-0 left-0 right-0 z-50 flex border-t bg-white sm:hidden" aria-label="Primary">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = isActive(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition ${
                active ? 'text-brand' : 'text-slate-500'
              }`}
            >
              <Icon className={`h-5 w-5 ${active ? 'text-brand' : 'text-slate-500'}`} />
              <span className={active ? 'font-semibold' : ''}>{t.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
