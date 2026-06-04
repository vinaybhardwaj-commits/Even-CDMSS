import { sql } from './db';
import { embedQuery, embedQueryV2, vectorLiteral, TOP_K, USE_EMBEDDING_V2 } from './llm';
import { expandQuery } from './expand';
import { rerank } from './rerank';
import type { ChunkHit } from './db';

export type RetrieveOptions = {
  topK?: number;
  bookFilter?: string;
  chunkType?: 'narrative' | 'explanation';
  source?: string;
  minSimilarity?: number;
  skipExpand?: boolean;
  hybrid?: boolean;
  bm25Query?: string;

  /** v1.6: use embedding_v2 column (mxbai-embed-large, 1024-dim).
   *  Default = global USE_EMBEDDING_V2 env. */
  useEmbeddingV2?: boolean;

  /** v1.6: enable cross-encoder reranker on the candidate pool. */
  useReranker?: boolean;

  /** v1.6: multiply final score by source_quality_weight per chunk. */
  useSourceWeights?: boolean;
};

export type ChunkHitWithMeta = ChunkHit & {
  source_quality_weight?: number;
  rerank_score?: number;
  rerank_backend?: 'bge' | 'judge' | 'none';
};

export type RetrieveResult = {
  hits: ChunkHitWithMeta[];
  expandedQuery: string;
  meta?: {
    vector_pool: number;
    bm25_pool: number;
    fused: number;
    bm25_query?: string;
    pool_size?: number;
    reranked?: boolean;
    source_weighted?: boolean;
    embedding_column?: 'embedding' | 'embedding_v2';
  };
};

// Reciprocal Rank Fusion
const RRF_K = 60;

export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrieveResult> {
  const topK = opts.topK ?? TOP_K;
  const minSim = opts.minSimilarity ?? 0.3;
  const hybrid = opts.hybrid !== false;
  const useV2 = opts.useEmbeddingV2 ?? USE_EMBEDDING_V2;
  const useReranker = opts.useReranker === true;
  const useSourceWeights = opts.useSourceWeights === true;
  const embCol = useV2 ? 'embedding_v2' : 'embedding';

  const expanded = opts.skipExpand ? query : await expandQuery(query);
  const vec = useV2 ? await embedQueryV2(expanded) : await embedQuery(expanded);
  const vlit = vectorLiteral(vec);

  // When reranker is on, pull a deeper pool so the cross-encoder has more
  // to choose from. Otherwise stick with v1.5's POOL=max(40, K*5).
  const POOL = useReranker
    ? Math.max(30, topK * 4)   // smaller pool because rerank is the bottleneck
    : Math.max(40, topK * 5);

  // ---- filter clauses ----
  const filterClauses: string[] = [`text IS NOT NULL`, `visible IS NOT FALSE`];
  const filterParams: unknown[] = [];
  let fp = 0;
  if (opts.bookFilter) { filterClauses.push(`book = $FP_${fp++}`); filterParams.push(opts.bookFilter); }
  if (opts.chunkType)  { filterClauses.push(`chunk_type = $FP_${fp++}`); filterParams.push(opts.chunkType); }
  if (opts.source)     { filterClauses.push(`source = $FP_${fp++}`); filterParams.push(opts.source); }

  // ---- Vector leg ----
  const vecFilterSQL = filterClauses.map((c) => c.replace(/\$FP_(\d+)/g, (_m, n) => `$${3 + Number(n)}`)).join(' AND ');
  const vecSQL = `
    SELECT id, ROW_NUMBER() OVER (ORDER BY ${embCol} <=> $1::vector) AS rank
    FROM mksap_chunks
    WHERE 1 - (${embCol} <=> $1::vector) > $2
      AND ${embCol} IS NOT NULL
      AND ${vecFilterSQL}
    ORDER BY ${embCol} <=> $1::vector
    LIMIT ${POOL}
  `;
  const vecParams = [vlit, minSim, ...filterParams];

  // ---- BM25 leg ----
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

  type RankRow = { id: number; rank: number };
  const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<RankRow[]>;
  const [vecRows, bm25Rows] = await Promise.all([
    sqlFn(vecSQL, vecParams).catch(() => [] as RankRow[]),
    hybrid ? sqlFn(bm25SQL, bm25Params).catch(() => [] as RankRow[]) : Promise.resolve([] as RankRow[]),
  ]);

  // ---- RRF fusion ----
  const score: Map<number, number> = new Map();
  for (const r of vecRows) score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + Number(r.rank)));
  for (const r of bm25Rows) score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + Number(r.rank)));

  // When reranker is on we hand it a wider pool (top K*3, capped at 30).
  // When off we trim to topK directly here.
  const poolSize = useReranker ? Math.min(30, topK * 3) : topK;
  const fusedIds = Array.from(score.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, poolSize)
    .map(([id]) => id);

  if (fusedIds.length === 0) {
    return { hits: [], expandedQuery: expanded, meta: {
      vector_pool: vecRows.length, bm25_pool: bm25Rows.length, fused: 0,
      bm25_query: bm25Query, pool_size: 0, reranked: false, source_weighted: false,
      embedding_column: embCol as 'embedding' | 'embedding_v2',
    } };
  }

  // ---- Final hydrate ----
  // Pull source_quality_weight + similarity for the candidate pool
  const placeholders = fusedIds.map((_, i) => `$${i + 2}`).join(',');
  const finalSQL = `
    SELECT id, source, book, chapter, section, page_start, page_end, item_number, chunk_type, text, token_count,
           1 - (${embCol} <=> $1::vector) AS similarity,
           COALESCE(source_quality_weight, 1.0) AS source_quality_weight
    FROM mksap_chunks
    WHERE id IN (${placeholders})
  `;
  type HydratedRow = ChunkHit & { source_quality_weight: number };
  const rowsBy = await (sql as unknown as (q: string, p: unknown[]) => Promise<HydratedRow[]>)(finalSQL, [vlit, ...fusedIds]);
  const byId = new Map(rowsBy.map((r) => [r.id, r]));
  let hits: ChunkHitWithMeta[] = fusedIds
    .map((id) => byId.get(id))
    .filter((x): x is HydratedRow => !!x)
    .map((r) => ({ ...r }));

  // ---- Cross-encoder rerank ----
  if (useReranker && hits.length > 1) {
    const reranked = await rerank(query, hits.map((h) => ({
      id: h.id,
      text: h.text,
      __orig: h,
    })));
    hits = reranked.map((r) => {
      const orig = (r as unknown as { __orig: ChunkHitWithMeta }).__orig;
      return {
        ...orig,
        rerank_score: r.rerank_score,
        rerank_backend: r.rerank_backend,
      };
    });
  }

  // ---- Source-quality weighting ----
  // Multiplier applied to whichever score we sort by at this point.
  // After reranker: score = rerank_score * weight
  // No reranker:    score = similarity * weight
  if (useSourceWeights) {
    const sortKey = useReranker ? 'rerank_score' : 'similarity';
    hits = hits.map((h) => {
      const raw = (h[sortKey as keyof ChunkHitWithMeta] as number) ?? 0;
      const w = h.source_quality_weight ?? 1.0;
      // We keep both originals for debug; the new effective score sorts.
      return { ...h, [`${sortKey}_weighted`]: raw * w } as ChunkHitWithMeta & Record<string, number>;
    });
    const k = `${sortKey}_weighted`;
    hits.sort((a, b) => ((b as unknown as Record<string, number>)[k] ?? 0) - ((a as unknown as Record<string, number>)[k] ?? 0));
  }

  // Trim to final topK
  hits = hits.slice(0, topK);

  return {
    hits,
    expandedQuery: expanded,
    meta: {
      vector_pool: vecRows.length,
      bm25_pool: bm25Rows.length,
      fused: hits.length,
      bm25_query: bm25Query,
      pool_size: poolSize,
      reranked: useReranker,
      source_weighted: useSourceWeights,
      embedding_column: embCol as 'embedding' | 'embedding_v2',
    },
  };
}
