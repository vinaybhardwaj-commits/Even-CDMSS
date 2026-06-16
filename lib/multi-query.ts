/**
 * v1.5 P2a: multi-query retrieval.
 *
 * Generates 3-5 query reformulations (different clinical angles) and runs
 * retrieve() in parallel for each. Dedupes hits by chunk id keeping max
 * fused score. Returns a single ranked list — same shape as retrieve().
 *
 * Latency: ~wall-clock-equal to a single retrieve() call (Promise.all),
 * plus one fast LLM call for variant generation (~500ms).
 *
 * Why this matters: most "/ask doesn't find X" failures aren't because
 * the content isn't there — they're wording-match failures. Reformulating
 * the query and unioning the candidate pools catches gold the original
 * phrasing missed.
 */
import { llm } from './llm';
import { retrieve, type RetrieveOptions, type RetrieveResult } from './retrieve';
import type { ChunkHit } from './db';

const VARIANT_MODEL = 'llama3.1:8b';
const VARIANT_COUNT = 2;  // 2 variants + the original = 3 retrievals fanned out (v1.6 hotfix: was 4, cut to keep latency under 300s on Mac Mini Ollama)

const SYSTEM_VARIANTS = `You are a clinical query reformulator. Given a clinician's question, output ${VARIANT_COUNT} alternative phrasings that approach the same underlying information need from different angles, in JSON.

Cover these angles (one per variant, in order):
1. Diagnostic workup / criteria angle
2. Management / treatment angle

Return ONLY a JSON array of strings, no prose:
["variant 1", "variant 2", "variant 3", "variant 4"]

Each variant should:
- Use precise clinical terminology
- Read like a focused query a physician would type
- Stay under 20 words
- NOT be a question form — make them noun-phrase queries (e.g. "pathophysiology of heart failure with reduced ejection fraction" not "what is the pathophysiology of HFrEF?")`;

export async function generateQueryVariants(question: string): Promise<string[]> {
  try {
    const r = await llm.chat.completions.create({
      model: VARIANT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_VARIANTS },
        { role: 'user', content: question },
      ],
      temperature: 0.2,  // steadier variants — 0.4 drifted (e.g. latched onto "arthropod bite" and buried the real differential)
      max_tokens: 300,
      ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    });
    let txt = r.choices?.[0]?.message?.content?.trim() || '';
    // Strip markdown fences if the model added them
    if (txt.startsWith('```')) txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    // Find the JSON array boundaries
    const a = txt.indexOf('[');
    const b = txt.lastIndexOf(']');
    if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, VARIANT_COUNT);
  } catch (e) {
    console.warn('[multi-query] variant generation failed', (e as Error).message);
    return [];
  }
}

export type MultiRetrieveResult = {
  hits: ChunkHit[];
  variants: string[];   // the variants we actually ran (incl. original at index 0)
  perVariantCounts: number[];
};

/**
 * Run retrieve() for the original query + N variants in parallel,
 * dedupe by chunk id (keep max fused score), return top-K.
 */
export async function retrieveMultiQuery(
  question: string,
  opts: RetrieveOptions = {},
): Promise<MultiRetrieveResult> {
  // Per-variant pool — keep it moderate; we'll fuse and trim to opts.topK at the end
  const perVariantK = Math.max(opts.topK ?? 8, 6);
  const variants = await generateQueryVariants(question);
  // Always include the original — it's the source of truth
  const allQueries = [question, ...variants];

  const results = await Promise.all(
    allQueries.map((q) =>
      retrieve(q, { ...opts, topK: perVariantK, skipExpand: true }).catch((e) => {
        console.warn('[multi-query] variant retrieve failed', q.slice(0, 60), (e as Error).message);
        return { hits: [], expandedQuery: q } as RetrieveResult;
      }),
    ),
  );

  // Dedupe by chunk id, keep MAX similarity score across variants
  const byId = new Map<number | string, ChunkHit>();
  for (const r of results) {
    for (const h of r.hits) {
      const prev = byId.get(h.id);
      if (!prev || h.similarity > prev.similarity) {
        byId.set(h.id, h);
      }
    }
  }
  const fused = Array.from(byId.values()).sort((a, b) => b.similarity - a.similarity);
  const topK = opts.topK ?? 8;
  return {
    hits: fused.slice(0, topK),
    variants: allQueries,
    perVariantCounts: results.map((r) => r.hits.length),
  };
}
