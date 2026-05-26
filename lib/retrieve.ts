import { sql } from './db';
import { embedQuery, vectorLiteral, TOP_K } from './llm';
import { expandQuery } from './expand';
import type { ChunkHit } from './db';

export type RetrieveIntent =
  | 'ddx'
  | 'workup'
  | 'management'
  | 'dosing'
  | 'mechanism'
  | 'prognosis'
  | 'risk_stratification'
  | 'monitoring'
  | 'pharmacokinetics'
  | 'special_populations'
  | 'triage'
  | 'education';

export type EntityFilter = {
  drugs?: string[];
  drug_classes?: string[];
  conditions?: string[];
  procedures?: string[];
  anatomy?: string[];
  age_groups?: string[];
  sex_specific?: 'female' | 'male' | 'intersex';
};

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

  // ────────────────────────────────────────────────────────────────────
  // KNOWLEDGE MAP (Phase C) — backward-compatible additions.
  // Defaults are tuned so existing callers get a transparent upgrade:
  // map routing kicks in when a clear topic match exists, and falls back
  // to the original full-corpus hybrid retrieval when it doesn't.
  // ────────────────────────────────────────────────────────────────────

  /**
   * Use kb_topics as a routing pre-stage to narrow retrieval to a curated
   * candidate set. Default true. If no topic matches above mapMinSimilarity,
   * we fall back to full-corpus retrieval automatically.
   */
  useMap?: boolean;
  /** Minimum top-topic cosine similarity to use map routing. Default 0.5. */
  mapMinSimilarity?: number;
  /** How many top topics to draw candidate chunks from. Default 3. */
  topicTopK?: number;
  /**
   * If provided AND the map was used AND the selected topics have
   * source_mix_recommendation entries for this intent, RRF scores get
   * multiplied by per-source weights. Per-route hints:
   *   /ddx     → 'ddx'
   *   /drugs   → 'dosing'  (or 'pharmacokinetics' for half-life style Qs)
   *   /coach   → 'education'
   *   /review  → 'education'
   *   /ask     → omit (let topic-curated chunk set dominate)
   */
  intent?: RetrieveIntent;
  /**
   * Hard filter against kb_chunk_entities. AND-combined. Mostly used by /drugs
   * (e.g. entityFilter.drugs = ['ticagrelor']) for surgical retrieval.
   */
  entityFilter?: EntityFilter;
};

export type RetrieveResult = {
  hits: ChunkHit[];
  expandedQuery: string;
  meta?: {
    vector_pool: number;
    bm25_pool: number;
    fused: number;
    bm25_query?: string;
    // New diagnostic fields — surface in traces to see what the map did
    map_used?: boolean;
    map_topics?: Array<{ id: number; name: string; similarity: number }>;
    candidate_size?: number;
    fallback_reason?: 'no_topic_above_threshold' | 'empty_candidate_set' | 'map_disabled' | 'map_error';
  };
};

// Reciprocal Rank Fusion: score(d) = Σ 1/(k + rank_r(d))
// Standard k=60. Higher score = better.
const RRF_K = 60;

type RankRow = { id: number; rank: number };
type TopicRow = {
  id: number;
  canonical_name: string;
  similarity: number;
  canonical_chunk_ids: number[] | null;
  supporting_chunk_ids: number[] | null;
  source_mix_recommendation: Record<string, Record<string, number>> | null;
};

// ─── Knowledge map helpers ──────────────────────────────────────────────

async function pickTopics(vlit: string, k: number, minSim: number): Promise<TopicRow[]> {
  const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<TopicRow[]>;
  const q = `
    SELECT id, canonical_name,
           1 - (embedding <=> $1::vector) AS similarity,
           canonical_chunk_ids, supporting_chunk_ids,
           source_mix_recommendation
    FROM kb_topics
    WHERE NOT is_pilot AND embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `;
  const rows = await sqlFn(q, [vlit, k]);
  return rows.filter((r) => Number(r.similarity) >= minSim);
}

async function applyEntityFilter(filter: EntityFilter, candidateIds: number[]): Promise<number[]> {
  const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ chunk_id: number }>>;
  const conds: string[] = ['NOT is_pilot'];
  const params: unknown[] = [];
  let i = 0;

  if (candidateIds.length > 0) {
    conds.push(`chunk_id = ANY($${++i}::int[])`);
    params.push(candidateIds);
  }
  if (filter.drugs?.length)        { conds.push(`drugs && $${++i}::text[]`);        params.push(filter.drugs); }
  if (filter.drug_classes?.length) { conds.push(`drug_classes && $${++i}::text[]`); params.push(filter.drug_classes); }
  if (filter.conditions?.length)   { conds.push(`conditions && $${++i}::text[]`);   params.push(filter.conditions); }
  if (filter.procedures?.length)   { conds.push(`procedures && $${++i}::text[]`);   params.push(filter.procedures); }
  if (filter.anatomy?.length)      { conds.push(`anatomy && $${++i}::text[]`);      params.push(filter.anatomy); }
  if (filter.age_groups?.length)   { conds.push(`age_groups && $${++i}::text[]`);   params.push(filter.age_groups); }
  if (filter.sex_specific) {
    conds.push(`(sex_specific IS NULL OR sex_specific = $${++i})`);
    params.push(filter.sex_specific);
  }

  const q = `SELECT chunk_id FROM kb_chunk_entities WHERE ${conds.join(' AND ')}`;
  const rows = await sqlFn(q, params);
  return rows.map((r) => Number(r.chunk_id));
}

function averageSourceWeights(topics: TopicRow[], intent: RetrieveIntent): Record<string, number> {
  const acc: Record<string, number[]> = {};
  for (const t of topics) {
    const smr = t.source_mix_recommendation;
    if (!smr || !smr[intent]) continue;
    for (const [src, w] of Object.entries(smr[intent])) {
      (acc[src] ||= []).push(Number(w));
    }
  }
  const out: Record<string, number> = {};
  for (const [src, ws] of Object.entries(acc)) {
    out[src] = ws.reduce((a, b) => a + b, 0) / ws.length;
  }
  return out;
}

// ─── Main retrieval ─────────────────────────────────────────────────────

export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrieveResult> {
  const topK = opts.topK ?? TOP_K;
  const minSim = opts.minSimilarity ?? 0.3;
  const hybrid = opts.hybrid !== false;
  const useMap = opts.useMap !== false;
  const mapMinSim = opts.mapMinSimilarity ?? 0.5;
  const topicTopK = opts.topicTopK ?? 3;

  const expanded = opts.skipExpand ? query : await expandQuery(query);
  const vec = await embedQuery(expanded);
  const vlit = vectorLiteral(vec);

  // ─── Topic routing pre-stage ──────────────────────────────────────────
  let candidateIds: number[] | null = null;
  let mapTopics: TopicRow[] = [];
  let mapUsed = false;
  let fallbackReason:
    | 'no_topic_above_threshold'
    | 'empty_candidate_set'
    | 'map_disabled'
    | 'map_error'
    | undefined;

  if (useMap) {
    try {
      mapTopics = await pickTopics(vlit, topicTopK, mapMinSim);
      if (mapTopics.length === 0) {
        fallbackReason = 'no_topic_above_threshold';
      } else {
        // Union of canonical + supporting chunk_ids across picked topics
        const idSet = new Set<number>();
        for (const t of mapTopics) {
          for (const cid of (t.canonical_chunk_ids ?? [])) idSet.add(Number(cid));
          for (const cid of (t.supporting_chunk_ids ?? [])) idSet.add(Number(cid));
        }
        candidateIds = Array.from(idSet);

        // Optional entity filter narrows the candidate set further
        if (opts.entityFilter && Object.keys(opts.entityFilter).length > 0) {
          candidateIds = await applyEntityFilter(opts.entityFilter, candidateIds);
        }

        if (candidateIds.length === 0) {
          fallbackReason = 'empty_candidate_set';
          candidateIds = null; // disable map restriction in the SQL below
        } else {
          mapUsed = true;
        }
      }
    } catch {
      fallbackReason = 'map_error';
      candidateIds = null;
    }
  } else {
    fallbackReason = 'map_disabled';
  }

  // ─── Build retrieval SQL legs ─────────────────────────────────────────
  const filterClauses: string[] = [`text IS NOT NULL`];
  const filterParams: unknown[] = [];
  let fp = 0;
  if (opts.bookFilter) { filterClauses.push(`book = $FP_${fp++}`); filterParams.push(opts.bookFilter); }
  if (opts.chunkType)  { filterClauses.push(`chunk_type = $FP_${fp++}`); filterParams.push(opts.chunkType); }
  if (opts.source)     { filterClauses.push(`source = $FP_${fp++}`); filterParams.push(opts.source); }
  if (mapUsed && candidateIds && candidateIds.length > 0) {
    filterClauses.push(`id = ANY($FP_${fp++}::int[])`);
    filterParams.push(candidateIds);
  }

  const POOL = Math.max(40, topK * 5);

  // Vector leg — params: $1=vlit, $2=minSim, then filter params
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

  // BM25 leg — params: $1=bm25Query, then filter params
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
  const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<RankRow[]>;
  const [vecRows, bm25Rows] = await Promise.all([
    sqlFn(vecSQL, vecParams).catch(() => [] as RankRow[]),
    hybrid ? sqlFn(bm25SQL, bm25Params).catch(() => [] as RankRow[]) : Promise.resolve([] as RankRow[]),
  ]);

  // RRF fusion
  const score: Map<number, number> = new Map();
  for (const r of vecRows) {
    score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + Number(r.rank)));
  }
  for (const r of bm25Rows) {
    score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + Number(r.rank)));
  }

  // ─── Source-weight reranking ──────────────────────────────────────────
  // If map was used and intent is specified, weight scores by source.
  if (mapUsed && opts.intent && mapTopics.length > 0 && score.size > 0) {
    const weights = averageSourceWeights(mapTopics, opts.intent);
    if (Object.keys(weights).length > 0) {
      const fusedIds = Array.from(score.keys());
      const placeholders = fusedIds.map((_, i) => `$${i + 1}`).join(',');
      type SrcRow = { id: number; source: string };
      const srcRows = await (sql as unknown as (q: string, p: unknown[]) => Promise<SrcRow[]>)(
        `SELECT id, source FROM mksap_chunks WHERE id IN (${placeholders})`,
        fusedIds,
      );
      for (const r of srcRows) {
        const w = weights[r.source];
        if (w !== undefined) {
          score.set(r.id, (score.get(r.id) ?? 0) * w);
        }
      }
    }
  }

  const fusedIds = Array.from(score.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id]) => id);

  const mapTopicsSummary = mapTopics.map((t) => ({
    id: t.id, name: t.canonical_name, similarity: Number(t.similarity),
  }));

  // ─── Empty-result fallback: retry without the map ─────────────────────
  if (fusedIds.length === 0) {
    if (mapUsed) {
      // The map restricted us into a corner. Retry the same query without the map.
      const fallback = await retrieve(query, { ...opts, useMap: false });
      return {
        ...fallback,
        meta: {
          ...fallback.meta!,
          map_used: false,
          map_topics: mapTopicsSummary,
          candidate_size: candidateIds?.length ?? 0,
          fallback_reason: 'empty_candidate_set',
        },
      };
    }
    return {
      hits: [],
      expandedQuery: expanded,
      meta: {
        vector_pool: vecRows.length,
        bm25_pool: bm25Rows.length,
        fused: 0,
        bm25_query: bm25Query,
        map_used: false,
        map_topics: mapTopicsSummary,
        candidate_size: candidateIds?.length ?? 0,
        fallback_reason: fallbackReason ?? 'no_topic_above_threshold',
      },
    };
  }

  // ─── Final SELECT ─────────────────────────────────────────────────────
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

  const byId = new Map(rowsBy.map((r) => [r.id, r]));
  const hits = fusedIds.map((id) => byId.get(id)).filter((x): x is ChunkHit => !!x);

  return {
    hits,
    expandedQuery: expanded,
    meta: {
      vector_pool: vecRows.length,
      bm25_pool: bm25Rows.length,
      fused: hits.length,
      bm25_query: bm25Query,
      map_used: mapUsed,
      map_topics: mapTopicsSummary,
      candidate_size: candidateIds?.length ?? 0,
      fallback_reason: mapUsed ? undefined : fallbackReason,
    },
  };
}
