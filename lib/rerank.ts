/**
 * v1.6 P3: Cross-encoder reranker bridge.
 *
 * Reorders a candidate pool by query-document relevance using a stronger
 * scoring model than bi-encoder similarity. Typical impact: top-8 quality
 * lifts dramatically because the cross-encoder sees query + doc together
 * rather than projecting them into independent vectors first.
 *
 * Two backends, picked by RERANK_BACKEND env:
 *   'bge'    : Native cross-encoder (bge-reranker-v2-m3) via Ollama's
 *              REST /api/embeddings endpoint, which the bge-reranker
 *              community models on Ollama use for a query+passage logit.
 *              FASTER (~50ms/pair) but requires `ollama pull` for the
 *              model on the Mac Mini.
 *   'judge'  : LLM-as-judge using llama3.1:8b with a strict 0-10 scoring
 *              prompt, batched. Works out of the box (model already
 *              loaded), but slower (~200-400ms per batch of 5).
 *
 * Default backend = 'judge' (zero-extra-install), override via env.
 *
 * Soft-fail: if rerank breaks for any reason, returns the input order
 * unchanged. Never blocks retrieval.
 */
import { llm } from './llm';

const BACKEND = (process.env.RERANK_BACKEND || 'judge') as 'bge' | 'judge';
const BGE_MODEL = process.env.RERANK_MODEL || 'bge-reranker-v2-m3';
const JUDGE_MODEL = process.env.RERANK_JUDGE_MODEL || 'llama3.1:8b';
const JUDGE_BATCH = 5;  // 5 candidates per LLM call
const MAX_SNIPPET_CHARS = 600;

export type RerankCandidate = {
  id: number | string;
  text: string;
  /** Optional pass-through fields preserved on the output */
  [key: string]: unknown;
};

export type RerankResult<T extends RerankCandidate> = T & {
  rerank_score: number;        // higher = more relevant
  rerank_backend: 'bge' | 'judge' | 'none';
};

/**
 * Rerank candidates against the query. Returns a NEW array sorted by
 * rerank_score descending. Input array is not mutated.
 */
export async function rerank<T extends RerankCandidate>(
  query: string,
  candidates: T[],
): Promise<RerankResult<T>[]> {
  if (candidates.length === 0) return [];
  // Single candidate — no reorder needed
  if (candidates.length === 1) {
    return [{ ...candidates[0], rerank_score: 1.0, rerank_backend: 'none' }];
  }

  try {
    if (BACKEND === 'bge') return await rerankBge(query, candidates);
    return await rerankJudge(query, candidates);
  } catch (e) {
    console.warn('[rerank] backend failed, returning input order', (e as Error).message);
    return candidates.map((c, i) => ({
      ...c,
      rerank_score: 1 - i / candidates.length,  // preserve original order
      rerank_backend: 'none' as const,
    }));
  }
}

/* ─────────────────────────────  LLM-judge backend  ───────────────────────────── */

const JUDGE_SYSTEM = `You are a clinical relevance judge. Given a clinician's question and a list of textbook passages, score each passage 0-10 for how directly it answers the question.

Scoring rubric:
  9-10 : passage directly answers the core of the question with specific clinical facts
  7-8  : passage covers the right topic and contains relevant content but doesn't fully answer
  4-6  : passage is on the same general subject but is tangential
  1-3  : passage barely related (shared keyword only)
  0    : passage is irrelevant or noise

Return ONLY a JSON object with integer scores keyed by candidate INDEX (0-based, as I provide them):
{"0": 8, "1": 3, "2": 10, "3": 6, "4": 2}

No prose, no explanation, no markdown fences.`;

async function rerankJudge<T extends RerankCandidate>(
  query: string,
  candidates: T[],
): Promise<RerankResult<T>[]> {
  const scores: number[] = new Array(candidates.length).fill(0);

  // Run JUDGE_BATCH-sized batches in PARALLEL so wall-clock stays bounded
  const batches: { start: number; end: number }[] = [];
  for (let i = 0; i < candidates.length; i += JUDGE_BATCH) {
    batches.push({ start: i, end: Math.min(i + JUDGE_BATCH, candidates.length) });
  }

  await Promise.all(batches.map(async ({ start, end }) => {
    const slice = candidates.slice(start, end);
    const passagesText = slice.map((c, idx) => {
      const snip = (c.text || '').slice(0, MAX_SNIPPET_CHARS).replace(/\s+/g, ' ').trim();
      return `[${idx}] ${snip}`;
    }).join('\n\n');

    const userMsg = `QUESTION:\n${query}\n\nPASSAGES:\n${passagesText}\n\nReturn the JSON scoring object now.`;

    try {
      const r = await llm.chat.completions.create({
        model: JUDGE_MODEL,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.0,
        max_tokens: 200,
        ...({ options: { num_ctx: 4096 }, keep_alive: '15m' } as Record<string, unknown>),
      });
      let txt = r.choices?.[0]?.message?.content?.trim() || '';
      if (txt.startsWith('```')) txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const a = txt.indexOf('{');
      const b = txt.lastIndexOf('}');
      if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
      const parsed = JSON.parse(txt) as Record<string, number>;
      for (let k = 0; k < slice.length; k++) {
        const raw = parsed[String(k)];
        if (typeof raw === 'number' && !Number.isNaN(raw)) {
          scores[start + k] = Math.max(0, Math.min(10, raw)) / 10;
        }
      }
    } catch (e) {
      // Batch failed — leave those scores at 0 (will sort to bottom).
      // Soft fail is OK because we still have the input order as tiebreaker downstream.
      console.warn('[rerank judge] batch failed', start, '-', end, (e as Error).message);
    }
  }));

  // Pair, sort, return
  const paired = candidates.map((c, i) => ({
    ...c,
    rerank_score: scores[i],
    rerank_backend: 'judge' as const,
  }));
  paired.sort((a, b) => b.rerank_score - a.rerank_score);
  return paired;
}

/* ─────────────────────────────  BGE cross-encoder backend  ───────────────────────────── */

async function rerankBge<T extends RerankCandidate>(
  query: string,
  candidates: T[],
): Promise<RerankResult<T>[]> {
  const base = process.env.OLLAMA_BASE_URL;
  if (!base) throw new Error('OLLAMA_BASE_URL not set');

  // bge-reranker community Ollama wrappers typically expose a score per call
  // via /api/generate with a query+passage prompt. We send each (q,d) pair
  // and parse a single float. Done in parallel.
  const scores = await Promise.all(candidates.map(async (c) => {
    const passage = (c.text || '').slice(0, MAX_SNIPPET_CHARS);
    const prompt = `${query}\n${passage}`;
    try {
      const r = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: BGE_MODEL,
          prompt,
          stream: false,
          options: { num_predict: 8, temperature: 0 },
          keep_alive: '15m',
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`bge HTTP ${r.status}`);
      const j = await r.json() as { response?: string };
      const m = (j.response || '').match(/-?\d+(\.\d+)?/);
      if (!m) return 0;
      const n = Number(m[0]);
      // bge-reranker raw logits are roughly [-5, +5]. Squash to [0, 1] with sigmoid.
      return 1 / (1 + Math.exp(-n));
    } catch {
      return 0;
    }
  }));

  const paired = candidates.map((c, i) => ({
    ...c,
    rerank_score: scores[i],
    rerank_backend: 'bge' as const,
  }));
  paired.sort((a, b) => b.rerank_score - a.rerank_score);
  return paired;
}
