import Link from 'next/link';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function ChapterPage({ params }: { params: Promise<{ book: string; chapter: string }> }) {
  const { book, chapter } = await params;
  const dbook = decodeURIComponent(book);
  const dchap = decodeURIComponent(chapter);
  const chunks = (await sql`
    SELECT id, page_start, page_end, item_number, chunk_type, text, token_count
    FROM mksap_chunks WHERE book = ${dbook} AND chapter = ${dchap}
    ORDER BY page_start NULLS LAST, id
  `) as Array<{ id: number; page_start: number; page_end: number; item_number: string | null; chunk_type: string; text: string; token_count: number }>;

  return (
    <div>
      <nav className="text-xs text-slate-500">
        <Link href="/browse" className="hover:underline">Browse</Link> → {' '}
        <Link href={`/browse/${encodeURIComponent(dbook)}`} className="hover:underline">{dbook}</Link> →
      </nav>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900">{dchap}</h1>
      <p className="mt-1 text-sm text-slate-500">{chunks.length} chunk{chunks.length !== 1 ? 's' : ''}</p>
      <ol className="mt-6 space-y-3">
        {chunks.map((c) => (
          <li key={c.id} className="rounded-lg border bg-white p-4 shadow-sm">
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500">
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">#{c.id}</span>
              {c.page_start && <span>p.{c.page_start}{c.page_end && c.page_end !== c.page_start ? `–${c.page_end}` : ''}</span>}
              {c.item_number && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">Item {c.item_number}</span>}
              <span className="rounded bg-slate-100 px-1.5 py-0.5">{c.chunk_type}</span>
              <span>~{c.token_count} tok</span>
            </div>
            <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-slate-800">{c.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
