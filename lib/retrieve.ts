import { sql } from './db';
import { embedQuery, embedQueryV2, vectorLiteral, TOP_K, USE_EMBEDDING_V2 } from './llm';
import { expandQuery } from './expand';
import { rerank } from './rerank';
import { computeSourceQualityWeight } from './source-quality';
import { labLabel } from './lab-core';
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

  /** Lab measurement only: include ONE named quarantined batch (label without the `labq:` prefix).
   *  Omitted ⇒ today's behaviour exactly. Never set by production callers. */
  includeQuarantined?: string;

  /** Lab measurement only: force per-stage diagnostics (vector_rank/bm25_rank/rrf_score/final_rank)
   *  onto the returned hits even without includeQuarantined (R-5). Never set by production callers. */
  withDiagnostics?: boolean;
};

export type ChunkHitWithMeta = ChunkHit & {
  source_quality_weight?: number;
  rerank_score?: number;
  rerank_backend?: 'bge' | 'judge' | 'none';

  // Per-stage diagnostics — populated ONLY on the lab measurement path (includeQuarantined set),
  // so production result shapes are untouched. See §3.2 of the lab-retrieve-seam PRD.
  vector_rank?: number | null;   // rank in the vector leg, null if absent
  bm25_rank?: number | null;     // rank in the BM25 leg, null if absent
  rrf_score?: number;            // fused RRF score
  final_rank?: number;           // 1-based position in the returned list
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

// Reciprocal Rank Fusion. Exported so multi-query fusion reuses the SAME constant (do not redeclare).
export const RRF_K = 60;

// ── R-6 guard: USE_EMBEDDING_V2 latent failure ───────────────────────────────────
// USE_EMBEDDING_V2 is hardcoded false and no `embedding_v2` column exists. If that flag is ever
// flipped while the column is absent, the vector leg's SQL throws and is swallowed by the leg's
// `.catch(() => [])`, serving a SILENTLY-EMPTY vector leg. This guard makes that failure LOUD.
export class EmbeddingV2ColumnMissingError extends Error {
  constructor() {
    super('retrieve: USE_EMBEDDING_V2 is enabled but mksap_chunks.embedding_v2 is absent — refusing to query a silently-empty vector leg (R-6)');
    this.name = 'EmbeddingV2ColumnMissingError';
  }
}

/** Pure decision half of the R-6 guard (unit-testable). Throws iff v2 is requested but the column is absent. */
export function assertEmbeddingV2Available(useV2: boolean, columnExists: boolean): void {
  if (useV2 && !columnExists) throw new EmbeddingV2ColumnMissingError();
}

/** Column-existence probe for the R-6 guard. INFERRED SQL — reported verbatim for orchestrator validation. */
async function embeddingV2ColumnExists(): Promise<boolean> {
  const rows = await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown[]>)(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'mksap_chunks' AND column_name = 'embedding_v2' LIMIT 1`,
    [],
  );
  return rows.length > 0;
}

// ── quarantine filter seam (pure, unit-testable) ─────────────────────────────────
// The three constant guards, plus the opt-in structural filters (book/chunk_type/source).
// Clauses carry `$FP_n` placeholders that each leg remaps to its own positional base.
export type FilterClauseOpts = {
  includeQuarantined?: string;   // lab-only: relax the quarantine guards for ONE named batch
  bookFilter?: string;
  chunkType?: string;
  source?: string;
};

/**
 * Build the retrieval WHERE-filter clause array and its bound params, in order.
 *
 * INVARIANT (load-bearing): with `includeQuarantined` omitted/empty the returned clauses are
 * EXACTLY `['text IS NOT NULL', 'visible IS NOT FALSE', "source NOT LIKE 'labq:%'"]` (plus any
 * structural filters) and no quarantine param is added — so the SQL retrieve() emits is
 * byte-identical to production for every real caller.
 *
 * When set, BOTH quarantine guards relax for that ONE label via a BOUND parameter (`labq:<slug>`),
 * never interpolated. The label is slugged with the shared `labLabel` helper, so a hostile value
 * can never widen the filter beyond a single batch.
 */
export function buildFilterClauses(opts: FilterClauseOpts): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [`text IS NOT NULL`, `visible IS NOT FALSE`, `source NOT LIKE 'labq:%'`];
  const params: unknown[] = [];
  let fp = 0;

  // Fail-safe (PRD §8.1): only a NON-blank label relaxes the guard. Empty/whitespace ⇒ fall through
  // to today's exact behaviour rather than let labLabel('   ') → 'default' silently widen the filter.
  const raw = (opts.includeQuarantined ?? '').trim();
  const label = raw ? labLabel(raw) : '';
  if (label) {
    const idx = fp++;                       // this batch's param slot ($FP_idx), reused in BOTH relaxed clauses
    params.push(`labq:${label}`);
    clauses[1] = `(visible IS NOT FALSE OR source = $FP_${idx})`;
    clauses[2] = `(source NOT LIKE 'labq:%' OR source = $FP_${idx})`;
  }

  if (opts.bookFilter) { clauses.push(`book = $FP_${fp++}`); params.push(opts.bookFilter); }
  if (opts.chunkType)  { clauses.push(`chunk_type = $FP_${fp++}`); params.push(opts.chunkType); }
  if (opts.source)     { clauses.push(`source = $FP_${fp++}`); params.push(opts.source); }

  return { clauses, params };
}

/** Remap `$FP_n` placeholders to real positional params for one leg. `base` = the position of the
 *  first filter param (vector leg = 3, BM25 leg = 2). Pure string transform. */
export function renderFilterSql(clauses: string[], base: number): string {
  return clauses.map((c) => c.replace(/\$FP_(\d+)/g, (_m, n) => `$${base + Number(n)}`)).join(' AND ');
}

/** Clamp a lab_retrieve topK request to [1, 20], defaulting to the served k (8). Pure. */
export function clampLabRetrieveTopK(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 8;
  return Math.min(20, n);
}

export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrieveResult> {
  const topK = opts.topK ?? TOP_K;
  const minSim = opts.minSimilarity ?? 0.3;
  const hybrid = opts.hybrid !== false;
  const useV2 = opts.useEmbeddingV2 ?? USE_EMBEDDING_V2;
  const useReranker = opts.useReranker === true;
  const useSourceWeights = opts.useSourceWeights === true;
  const embCol = useV2 ? 'embedding_v2' : 'embedding';

  // R-6 guard: fires ONLY if the hardcoded-false USE_EMBEDDING_V2 flag is ever flipped without the
  // column present — a loud named error instead of a silently-empty vector leg. No-op in production.
  if (useV2) assertEmbeddingV2Available(true, await embeddingV2ColumnExists());

  const expanded = opts.skipExpand ? query : await expandQuery(query);
  const vec = useV2 ? await embedQueryV2(expanded) : await embedQuery(expanded);
  const vlit = vectorLiteral(vec);

  // When reranker is on, pull a deeper pool so the cross-encoder has more
  // to choose from. Otherwise stick with v1.5's POOL=max(40, K*5).
  const POOL = useReranker
    ? Math.max(30, topK * 4)   // smaller pool because rerank is the bottleneck
    : Math.max(40, topK * 5);

  // ---- filter clauses ----
  // QUARANTINE GUARD (lab MCP): lab-added corpus material is inert as source `labq:%` until
  // the user activates it (→ `lab:%`). Excluded from BOTH retrieval legs, always. The lab
  // measurement seam (opts.includeQuarantined, never set in production) relaxes both guards for
  // ONE named batch via a bound param — see buildFilterClauses. Omitted ⇒ byte-identical SQL.
  const { clauses: filterClauses, params: filterParams } = buildFilterClauses({
    includeQuarantined: opts.includeQuarantined,
    bookFilter: opts.bookFilter,
    chunkType: opts.chunkType,
    source: opts.source,
  });

  // ---- Vector leg ----
  const vecFilterSQL = renderFilterSql(filterClauses, 3);
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
  const bm25FilterSQL = renderFilterSql(filterClauses, 2);
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
  // Per-leg ranks — captured here so the lab path (§3.2) can expose them without a second pass.
  const vecRankById = new Map<number, number>();
  const bm25RankById = new Map<number, number>();
  for (const r of vecRows) { score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + Number(r.rank))); vecRankById.set(r.id, Number(r.rank)); }
  for (const r of bm25Rows) { score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + Number(r.rank))); bm25RankById.set(r.id, Number(r.rank)); }

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
      // Compute the weight FRESH from the chunk's own fields rather than trusting
      // the precomputed mksap_chunks.source_quality_weight column. The Jun-2026 bulk
      // literature load (ingest_cdmss_keep.py) inserted ~2M PubMed/PMC rows WITHOUT
      // populating that column → they COALESCE to 1.0, which would rank raw abstracts
      // ABOVE weighted textbooks (StatPearls/UpToDate at 0.90). Computing here uses
      // the same formula a reindex would, so unknown journals get the 0.80 default and
      // tiny/fragment chunks get penalised — no 2M-row backfill needed. Overwrite the
      // field so telemetry shows the weight actually applied.
      const w = computeSourceQualityWeight({ book: h.book, source: h.source, chunk_type: h.chunk_type, token_count: h.token_count });
      return { ...h, source_quality_weight: w, [`${sortKey}_weighted`]: raw * w } as ChunkHitWithMeta & Record<string, number>;
    });
    const k = `${sortKey}_weighted`;
    hits.sort((a, b) => ((b as unknown as Record<string, number>)[k] ?? 0) - ((a as unknown as Record<string, number>)[k] ?? 0));
  }

  // Trim to final topK
  hits = hits.slice(0, topK);

  // ---- Per-stage diagnostics (lab measurement path ONLY) ----
  // Added when the lab explicitly asks (includeQuarantined OR withDiagnostics, R-5), so production
  // result shapes stay untouched — no production caller sets either flag.
  if (opts.includeQuarantined || opts.withDiagnostics) {
    hits = hits.map((h, i) => ({
      ...h,
      vector_rank: vecRankById.has(h.id) ? (vecRankById.get(h.id) as number) : null,
      bm25_rank: bm25RankById.has(h.id) ? (bm25RankById.get(h.id) as number) : null,
      rrf_score: score.get(h.id) ?? 0,
      final_rank: i + 1,
    }));
  }

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
