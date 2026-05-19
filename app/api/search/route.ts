import { NextRequest, NextResponse } from 'next/server';
import { retrieve } from '@/lib/retrieve';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: { query?: string; book?: string; chunkType?: 'narrative' | 'explanation'; topK?: number; skipExpand?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const q = (body.query || '').trim();
  if (!q) return NextResponse.json({ error: 'query is required' }, { status: 400 });
  try {
    const { hits, expandedQuery } = await retrieve(q, {
      topK: body.topK ?? 20,
      bookFilter: body.book,
      chunkType: body.chunkType,
      minSimilarity: 0.4,
      skipExpand: body.skipExpand,
    });
    return NextResponse.json({
      query: q,
      expanded: expandedQuery,
      n: hits.length,
      hits: hits.map((h) => ({
        id: h.id,
        book: h.book,
        chapter: h.chapter,
        page_start: h.page_start,
        page_end: h.page_end,
        item_number: h.item_number,
        chunk_type: h.chunk_type,
        token_count: h.token_count,
        similarity: Number(h.similarity.toFixed(3)),
        text: h.text,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
  }
}
