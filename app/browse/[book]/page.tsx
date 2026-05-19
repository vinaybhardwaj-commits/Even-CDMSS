import Link from 'next/link';
import { sql } from '@/lib/db';
import BookFilter from './book-filter';

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
      <BookFilter book={decoded} chapters={chapters} />
    </div>
  );
}
