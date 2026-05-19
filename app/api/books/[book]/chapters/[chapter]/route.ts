import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ book: string; chapter: string }> }) {
  const { book, chapter } = await ctx.params;
  const dbook = decodeURIComponent(book);
  const dchap = decodeURIComponent(chapter);
  const rows = (await sql`
    SELECT id, page_start, page_end, item_number, chunk_type, text, token_count
    FROM mksap_chunks WHERE book = ${dbook} AND chapter = ${dchap}
    ORDER BY page_start NULLS LAST, id
  `) as Array<{ id: number; page_start: number; page_end: number; item_number: string; chunk_type: string; text: string; token_count: number }>;
  return NextResponse.json({ book: dbook, chapter: dchap, n: rows.length, chunks: rows });
}
