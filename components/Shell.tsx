'use client';
import Link from 'next/link';

const NAV = [
  ['/ask', 'Ask'], ['/ddx', 'DDx'], ['/drugs', 'Drugs'],
  ['/calculators', 'Calculators'], ['/coach', 'Coach'], ['/review', 'Review'],
  ['/browse', 'Browse'], ['/practice', 'Practice'],
  ['/topics', 'Topics'], ['/search', 'Search'],
];

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <nav style={{ width: 180, borderRight: '1px solid #e5e7eb', padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>CAT</div>
        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 16 }}>Clinical Analysis Tool</div>
        {NAV.map(([href, label]) => (
          <Link key={href} href={href} style={{ display: 'block', padding: '6px 0' }}>
            {label}
          </Link>
        ))}
      </nav>
      <main style={{ flex: 1, padding: 24 }}>{children}</main>
    </div>
  );
}
