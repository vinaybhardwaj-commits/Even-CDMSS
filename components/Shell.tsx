'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const CLINICIAN_NAV: [string, string][] = [
  ['/ask', 'Ask'], ['/ddx', 'DDx'], ['/drugs', 'Drugs'],
  ['/calculators', 'Calculators'], ['/coach', 'Coach'], ['/review', 'Review'],
  ['/browse', 'Browse'], ['/practice', 'Practice'],
  ['/topics', 'Topics'], ['/search', 'Search'],
];

const ADMIN_NAV: [string, string][] = [
  ['/admin/literature', 'Literature'],
  ['/admin/observability', 'Observability'],
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '';
  const isAdmin = pathname.startsWith('/admin');
  const isObs = pathname.startsWith('/admin/observability');
  const nav = isAdmin ? ADMIN_NAV : CLINICIAN_NAV;
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <nav style={{ width: 180, borderRight: '1px solid #e5e7eb', padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>CAT</div>
        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 16 }}>
          {isAdmin ? (isObs ? 'Admin · Observability' : 'Admin · Literature engine') : 'Clinical Analysis Tool'}
        </div>
        {nav.map(([href, label]) => (
          <Link key={href} href={href} style={{ display: 'block', padding: '6px 0' }}>
            {label}
          </Link>
        ))}
        {isAdmin && (
          <Link href="/ask" style={{ display: 'block', padding: '6px 0', marginTop: 16, fontSize: 12, color: '#6b7280' }}>
            ← Clinician app
          </Link>
        )}
      </nav>
      <main style={{ flex: 1, padding: 24 }}>{children}</main>
    </div>
  );
}
