import Link from 'next/link';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function BookPage({ params }: { params: Promise<{ book: string }> }) {
  const { book } = await params;
  const decoded = decodeURIComponent(book);
  const chapters = (await sql`
    SELECT chapter, COUNT(*)::int AS chunks, MIN(page_start) AS first_page, MAX(page_end) AS last_page
    FROM mksap_chunks WHERE book = ${decoded} AND chapter IS NOT NULL
    GROUP BY chapter ORDER BY MIN(page_start) NULLS LAST, chapter
  `) as Array<{ chapter: string; chunks: number; first_page: number; last_page: number }>;

  return (
    <div>
      <nav className="text-xs text-slate-500"><Link href="/browse" className="hover:underline">Browse</Link> → </nav>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900">{decoded}</h1>
      <p className="mt-1 text-sm text-slate-500">{chapters.length} chapters</p>
      <ol className="mt-6 divide-y rounded-lg border bg-white shadow-sm">
        {chapters.map((c) => (
          <li key={c.chapter}>
            <Link
              href={`/browse/${encodeURIComponent(decoded)}/${encodeURIComponent(c.chapter)}`}
              className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50"
            >
              <span className="text-sm text-slate-800">{c.chapter}</span>
              <span className="text-xs text-slate-400">{c.chunks} chunk{c.chunks !== 1 ? 's' : ''} · p.{c.first_page}{c.last_page !== c.first_page ? `–${c.last_page}` : ''}</span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
