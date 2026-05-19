import { NextRequest, NextResponse } from 'next/server';
import { retrieve } from '@/lib/retrieve';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') || '';
  const topK = parseInt(req.nextUrl.searchParams.get('k') || '10', 10);
  const minSim = parseFloat(req.nextUrl.searchParams.get('min') || '0');
  const book = req.nextUrl.searchParams.get('book') || undefined;
  const skipExpand = req.nextUrl.searchParams.get('raw') === '1';
  if (!q) return NextResponse.json({ error: 'q is required' }, { status: 400 });
  try {
    const { hits, expandedQuery } = await retrieve(q, { topK, minSimilarity: minSim, bookFilter: book, skipExpand });
    return NextResponse.json({
      query: q,
      expanded: expandedQuery,
      n: hits.length,
      hits: hits.map((h) => ({
        id: h.id,
        book: h.book,
        chapter: h.chapter,
        page_start: h.page_start,
        item_number: h.item_number,
        chunk_type: h.chunk_type,
        similarity: Number(h.similarity.toFixed(4)),
        preview: h.text.slice(0, 200),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
  }
}
