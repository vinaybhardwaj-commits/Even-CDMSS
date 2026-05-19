import Link from 'next/link';
import { sql } from '@/lib/db';

export const metadata = { title: 'Browse · Even-Tutor' };
export const dynamic = 'force-dynamic';

const SHORT: Record<string, string> = {
  'Board basics _ an enhancement to MKSAP 19': 'Board Basics',
  'Cardiovascular Medicine': 'Cardiology',
  'Gastroenterology and Hepatology': 'GI & Hepatology',
  'General Internal Medicine 1': 'General IM 1',
  'General Internal Medicine 2': 'General IM 2',
  'Hematology': 'Hematology',
  'Infectious Disease': 'Infectious Disease',
  'Nephrology': 'Nephrology',
  'Neurology': 'Neurology',
  'Oncology': 'Oncology',
  'Pulmonary and Critical Care Medicine': 'Pulmonary & Crit Care',
  'Rheumatology': 'Rheumatology',
};

export default async function BrowsePage() {
  const rows = (await sql`
    SELECT book, COUNT(*)::int AS chunks, COUNT(DISTINCT chapter)::int AS chapters
    FROM mksap_chunks GROUP BY book ORDER BY book
  `) as Array<{ book: string; chunks: number; chapters: number }>;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Browse</h1>
      <p className="mt-1 text-sm text-slate-500">12 books · 275 chapters · 8,790 chunks indexed.</p>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((b) => (
          <Link
            key={b.book}
            href={`/browse/${encodeURIComponent(b.book)}`}
            className="rounded-lg border bg-white p-4 shadow-sm transition hover:border-brand hover:shadow"
          >
            <h2 className="font-semibold text-brand">{SHORT[b.book] ?? b.book}</h2>
            <p className="mt-1 text-xs text-slate-500">{b.chapters} chapters · {b.chunks.toLocaleString()} chunks</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
