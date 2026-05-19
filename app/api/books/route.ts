import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET() {
  const rows = (await sql`
    SELECT book, COUNT(*)::int AS chunks, COUNT(DISTINCT chapter)::int AS chapters,
           MIN(page_start) AS first_page, MAX(page_end) AS last_page
    FROM mksap_chunks
    GROUP BY book ORDER BY book
  `) as Array<{ book: string; chunks: number; chapters: number; first_page: number; last_page: number }>;
  return NextResponse.json({ books: rows });
}
