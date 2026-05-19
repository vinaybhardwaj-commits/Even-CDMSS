import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ book: string }> }) {
  const { book } = await ctx.params;
  const decoded = decodeURIComponent(book);
  const rows = (await sql`
    SELECT chapter, COUNT(*)::int AS chunks, MIN(page_start) AS first_page, MAX(page_end) AS last_page
    FROM mksap_chunks WHERE book = ${decoded} AND chapter IS NOT NULL
    GROUP BY chapter ORDER BY MIN(page_start) NULLS LAST, chapter
  `) as Array<{ chapter: string; chunks: number; first_page: number; last_page: number }>;
  const nullRow = (await sql`
    SELECT COUNT(*)::int AS chunks FROM mksap_chunks WHERE book = ${decoded} AND chapter IS NULL
  `) as Array<{ chunks: number }>;
  return NextResponse.json({ book: decoded, chapters: rows, no_chapter_chunks: nullRow[0]?.chunks ?? 0 });
}
