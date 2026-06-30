'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import {
  MessagesSquare, Network, Pill, Calculator, ClipboardCheck,
  ClipboardList, BookOpen, GraduationCap, Settings, Menu, X, ChevronLeft, Activity, Lightbulb,
  type LucideIcon,
} from 'lucide-react';

type NavItem = {
  href: string;
  label: string;
  Icon: LucideIcon;
  match?: string[]; // extra path prefixes that should mark this item active
};
type NavGroup = { heading?: string; items: NavItem[] };

// ── Clarity IA: ~7 surfaces, grouped. Decision-support first; the merged
//    Knowledge base (Search + Browse) and Learn hub (Coach/Practice/Review/
//    Topics) are demoted into a quiet "Reference & learning" group.
const CLINICIAN: NavGroup[] = [
  {
    heading: 'Decision support',
    items: [
      { href: '/ask', label: 'Ask', Icon: MessagesSquare },
      { href: '/ddx', label: 'Differential', Icon: Network },
      { href: '/drugs', label: 'Drugs', Icon: Pill },
      { href: '/calculators', label: 'Calculators', Icon: Calculator },
      { href: '/appropriateness', label: 'Right Care', Icon: ClipboardCheck },
    ],
  },
  {
    heading: 'Audit',
    items: [
      { href: '/audit', label: 'Medication Audit', Icon: ClipboardList },
    ],
  },
  {
    heading: 'Reference & learning',
    items: [
      { href: '/knowledge', label: 'Knowledge base', Icon: BookOpen, match: ['/search', '/browse'] },
      { href: '/learn', label: 'Learn', Icon: GraduationCap, match: ['/coach', '/practice', '/review', '/topics'] },
    ],
  },
];

const ADMIN: NavGroup[] = [
  {
    heading: 'Admin',
    items: [
      { href: '/admin/observability', label: 'Observability', Icon: Network, match: ['/admin/appropriateness-runs'] },
      { href: '/admin/opd-audit', label: 'OPD Audit', Icon: Activity },
      { href: '/admin/learning', label: 'Learning loop', Icon: Lightbulb },
      { href: '/admin/literature', label: 'Literature', Icon: BookOpen },
    ],
  },
];

function isActive(pathname: string, item: NavItem): boolean {
  const all = [item.href, ...(item.match ?? [])];
  return all.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

function NavLinks({ groups, pathname, onNavigate }: { groups: NavGroup[]; pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-5">
      {groups.map((group, gi) => (
        <div key={gi}>
          {group.heading && (
            <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
              {group.heading}
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item);
              const Icon = item.Icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={
                    'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] transition ' +
                    (active
                      ? 'bg-brand-faint font-medium text-brand'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')
                  }
                >
                  <Icon className={'h-[17px] w-[17px] shrink-0 ' + (active ? 'text-brand' : 'text-slate-400 group-hover:text-slate-600')} />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-1">
      <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-brand text-[15px] font-semibold text-white">C</span>
      <span className="flex flex-col leading-tight">
        <span className="font-serif text-[17px] font-semibold text-navy">CAT</span>
        <span className="text-[10.5px] text-slate-500">Clinical Analysis Tool</span>
      </span>
    </Link>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '';
  const isAdmin = pathname.startsWith('/admin');
  const groups = isAdmin ? ADMIN : CLINICIAN;
  const [drawer, setDrawer] = useState(false);

  // Close the mobile drawer on route change
  useEffect(() => { setDrawer(false); }, [pathname]);

  const SidebarInner = (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-5 pb-4">
        <Brand />
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <NavLinks groups={groups} pathname={pathname} onNavigate={() => setDrawer(false)} />
      </div>
      <div className="border-t border-slate-200 px-3 py-3">
        {isAdmin ? (
          <Link href="/ask" className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-slate-500 hover:bg-slate-100 hover:text-slate-900">
            <ChevronLeft className="h-4 w-4" /> Clinician app
          </Link>
        ) : (
          <Link href="/admin/observability" className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-slate-500 hover:bg-slate-100 hover:text-slate-900">
            <Settings className="h-[17px] w-[17px] text-slate-400" /> Admin
          </Link>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[230px] border-r border-slate-200 bg-paper md:block">
        {SidebarInner}
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-paper/90 px-4 py-3 backdrop-blur md:hidden">
        <Brand />
        <button
          onClick={() => setDrawer(true)}
          aria-label="Open menu"
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-100"
        >
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-slate-900/30" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-[260px] bg-paper shadow-pop">
            <div className="flex justify-end p-2">
              <button onClick={() => setDrawer(false)} aria-label="Close menu" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            {SidebarInner}
          </div>
        </div>
      )}

      {/* Content */}
      <main className="md:pl-[230px]">
        <div className="cat-page mx-auto w-full max-w-5xl px-5 py-7 sm:px-8 sm:py-9">
          {children}
        </div>
      </main>
    </div>
  );
}
