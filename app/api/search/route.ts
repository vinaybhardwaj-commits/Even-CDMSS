export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { retrieve } from '@/lib/retrieve';

// Semantic search over the shared corpus. Returns ranked passages with no LLM
// synthesis — the raw evidence behind Ask/DDx. (Re-implemented v0.7; the v0.2
// 410 tombstone is replaced.)
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const query = String((body as { query?: unknown }).query ?? '').trim();
    if (!query) return NextResponse.json({ error: 'query required' }, { status: 400 });

    const b = body as {
      book?: string; chunkType?: string; source?: string; skipExpand?: boolean; topK?: number;
    };
    const { hits, expandedQuery } = await retrieve(query, {
      topK: typeof b.topK === 'number' ? b.topK : 20,
      bookFilter: b.book || undefined,
      chunkType: (b.chunkType || undefined) as 'narrative' | 'explanation' | undefined,
      source: b.source || undefined,
      skipExpand: b.skipExpand === true,
    });
    return NextResponse.json({ hits, expanded: expandedQuery });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
