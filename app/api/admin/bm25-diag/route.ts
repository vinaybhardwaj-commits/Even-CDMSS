import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * Diagnose why retrieve()'s BM25 leg returns bm25_pool=0.
 *
 * Hits all the layers in order:
 *   1. Does `text_tsv` column exist + is GIN-indexed?
 *   2. How many rows have a non-empty text_tsv?
 *   3. What does plainto_tsquery() produce for a sample query?
 *   4. Does the actual BM25 query return rows?
 *   5. Show 3 sample hits.
 *
 * Query string ?q= controls the test query (default: "warfarin pharmacology").
 */
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const url = new URL(req.url);
  const q = url.searchParams.get('q') || 'warfarin pharmacology';
  const sqlFn = sql as unknown as (qs: string, p: unknown[]) => Promise<Array<Record<string, unknown>>>;
  const out: Record<string, unknown> = { query: q };

  try {
    // 1. Column existence
    const cols = await sqlFn(
      `SELECT column_name, data_type, generation_expression
       FROM information_schema.columns
       WHERE table_name = 'mksap_chunks' AND column_name IN ('text','text_tsv')`,
      []
    );
    out.columns = cols;

    // 2. Row counts: total, with text_tsv populated, with non-empty text_tsv
    const counts = await sqlFn(
      `SELECT
         COUNT(*)::int AS total_rows,
         COUNT(text_tsv)::int AS rows_with_tsv,
         COUNT(*) FILTER (WHERE text_tsv != ''::tsvector)::int AS rows_with_nonempty_tsv,
         COUNT(*) FILTER (WHERE text IS NOT NULL AND length(text) > 0)::int AS rows_with_text
       FROM mksap_chunks`,
      []
    );
    out.row_counts = counts[0];

    // 3. What does plainto_tsquery produce for this query?
    const tsqRows = await sqlFn(
      `SELECT plainto_tsquery('english', $1)::text AS tsquery,
              array_length(string_to_array(plainto_tsquery('english', $1)::text, ' & '), 1) AS n_terms`,
      [q]
    );
    out.tsquery = tsqRows[0];

    // 4. Run the BM25 query (same shape as lib/retrieve.ts) and count hits
    const t0 = Date.now();
    const bm25Hits = await sqlFn(
      `SELECT id, ts_rank_cd(text_tsv, plainto_tsquery('english', $1)) AS rank, book, chapter
       FROM mksap_chunks
       WHERE text_tsv @@ plainto_tsquery('english', $1)
         AND text IS NOT NULL
       ORDER BY rank DESC
       LIMIT 5`,
      [q]
    );
    out.bm25_latency_ms = Date.now() - t0;
    out.bm25_hit_count = bm25Hits.length;
    out.bm25_sample_hits = bm25Hits;

    // 5. Index check
    const idx = await sqlFn(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'mksap_chunks' AND (indexname LIKE '%tsv%' OR indexdef LIKE '%text_tsv%')`,
      []
    );
    out.indexes = idx;

    return NextResponse.json(out);
  } catch (e) {
    out.error = String((e as Error).message);
    return NextResponse.json(out, { status: 500 });
  }
}
