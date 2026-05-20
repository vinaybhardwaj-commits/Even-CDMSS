import { sql } from './db';
import { embedQuery, vectorLiteral, TOP_K } from './llm';
import { expandQuery } from './expand';
import type { ChunkHit } from './db';

export type RetrieveOptions = {
  topK?: number;
  bookFilter?: string;
  chunkType?: 'narrative' | 'explanation';
  source?: string;
  minSimilarity?: number;
  skipExpand?: boolean;
  hybrid?: boolean; // default true; pass false to disable BM25 leg (debug/comparison)
  /**
   * Optional override for the BM25 leg. The vector leg always uses the (HyDE-expanded)
   * full query, which is appropriate for semantic similarity. BM25 is term-precision-based
   * and a wide boilerplate query like "warfarin pharmacology mechanism receptors ..."
   * AND-tokenizes to zero matches (no single chunk contains all 13 stemmed terms).
   *
   * Callers with wide query templates should pass a focused bm25Query — typically the
   * highest-IDF entity (drug name, chief complaint, topic).
   *
   * If omitted, retrieve() uses the same query as the vector leg, which works fine for
   * short, focused user-typed queries (/ask, /coach).
   */
  bm25Query?: string;
};

export type RetrieveResult = {
  hits: ChunkHit[];
  expandedQuery: string;
  meta?: {
    vector_pool: number;
    bm25_pool: number;
    fused: number;
    bm25_query?: string;
  };
};

// Reciprocal Rank Fusion: score(d) = Σ 1/(k + rank_r(d))
// Standard k=60. Higher score = better.
const RRF_K = 60;

export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrieveResult> {
  const topK = opts.topK ?? TOP_K;
  const minSim = opts.minSimilarity ?? 0.3;
  const hybrid = opts.hybrid !== false;

  const expanded = opts.skipExpand ? query : await expandQuery(query);
  const vec = await embedQuery(expanded);
  const vlit = vectorLiteral(vec);

  // Build the optional filter clauses + params shared by both legs
  const filterClauses: string[] = [`text IS NOT NULL`];
  const filterParams: unknown[] = [];
  let fp = 0; // 1-based offset added to each param's placeholder index per-leg
  if (opts.bookFilter) { filterClauses.push(`book = $FP_${fp++}`); filterParams.push(opts.bookFilter); }
  if (opts.chunkType)  { filterClauses.push(`chunk_type = $FP_${fp++}`); filterParams.push(opts.chunkType); }
  if (opts.source)     { filterClauses.push(`source = $FP_${fp++}`); filterParams.push(opts.source); }

  const POOL = Math.max(40, topK * 5); // each leg pulls 40+ candidates

  // ---- Vector leg ----
  // params: $1 = vlit, $2 = minSim, then filter params
  const vecFilterSQL = filterClauses.map((c) => c.replace(/\$FP_(\d+)/g, (_m, n) => `$${3 + Number(n)}`)).join(' AND ');
  const vecSQL = `
    SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
    FROM mksap_chunks
    WHERE 1 - (embedding <=> $1::vector) > $2
      AND ${vecFilterSQL}
    ORDER BY embedding <=> $1::vector
    LIMIT ${POOL}
  `;
  const vecParams = [vlit, minSim, ...filterParams];

  // ---- BM25 leg ----
  // Uses opts.bm25Query if provided (focused, high-IDF terms), else falls back to the
  // full query. plainto_tsquery ANDs every stemmed term — fine for 1-3 specific terms,
  // catastrophic for the long boilerplate queries that drugs/lookup, drugs/interactions,
  // and /ddx build (every term has to appear in the same chunk → bm25_pool=0).
  const bm25Query = (opts.bm25Query ?? query).trim();
  const bm25FilterSQL = filterClauses.map((c) => c.replace(/\$FP_(\d+)/g, (_m, n) => `$${2 + Number(n)}`)).join(' AND ');
  const bm25SQL = `
    SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(text_tsv, plainto_tsquery('english', $1)) DESC) AS rank
    FROM mksap_chunks
    WHERE text_tsv @@ plainto_tsquery('english', $1)
      AND ${bm25FilterSQL}
    ORDER BY ts_rank_cd(text_tsv, plainto_tsquery('english', $1)) DESC
    LIMIT ${POOL}
  `;
  const bm25Params = [bm25Query, ...filterParams];

  // Run both in parallel
  type RankRow = { id: number; rank: number };
  const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<RankRow[]>;
  const [vecRows, bm25Rows] = await Promise.all([
    sqlFn(vecSQL, vecParams).catch(() => [] as RankRow[]),
    hybrid ? sqlFn(bm25SQL, bm25Params).catch(() => [] as RankRow[]) : Promise.resolve([] as RankRow[]),
  ]);

  // RRF fusion in JS
  const score: Map<number, number> = new Map();
  for (const r of vecRows) {
    score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + Number(r.rank)));
  }
  for (const r of bm25Rows) {
    score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + Number(r.rank)));
  }
  const fusedIds = Array.from(score.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id]) => id);

  if (fusedIds.length === 0) {
    return { hits: [], expandedQuery: expanded, meta: { vector_pool: vecRows.length, bm25_pool: bm25Rows.length, fused: 0, bm25_query: bm25Query } };
  }

  // Final SELECT: pull full row data for the fused IDs, with vector similarity for display
  const placeholders = fusedIds.map((_, i) => `$${i + 2}`).join(',');
  const finalSQL = `
    SELECT id, source, book, chapter, section, page_start, page_end, item_number, chunk_type, text, token_count,
           1 - (embedding <=> $1::vector) AS similarity
    FROM mksap_chunks
    WHERE id IN (${placeholders})
  `;
  const rowsBy = await (sql as unknown as (q: string, p: unknown[]) => Promise<ChunkHit[]>)(
    finalSQL, [vlit, ...fusedIds]
  );

  // Re-order to match RRF ranking
  const byId = new Map(rowsBy.map((r) => [r.id, r]));
  const hits = fusedIds.map((id) => byId.get(id)).filter((x): x is ChunkHit => !!x);

  return {
    hits,
    expandedQuery: expanded,
    meta: { vector_pool: vecRows.length, bm25_pool: bm25Rows.length, fused: hits.length, bm25_query: bm25Query },
  };
}
