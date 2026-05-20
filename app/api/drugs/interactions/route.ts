import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { DRUGS_MODEL, parseLooseJson, normalizeDrugName } from '@/lib/drugs';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';
import { startTrace, finishTrace, tracedChat } from '@/lib/trace';

export const runtime = 'nodejs';
export const maxDuration = 120;

const SYSTEM = `You analyze drug-drug interactions for clinicians. Use ONLY the medical excerpts provided.

Return ONLY this JSON, lowercase keys, no prose:
{"summary":"one sentence overall risk picture","pairs":[{"drug_a":"...","drug_b":"...","severity":"contraindicated|major|moderate|minor|none","mechanism":"<30 words","consequence":"<30 words","management":"<30 words","citation_ids":[1,2]}]}

- One object per UNIQUE pair.
- severity: contraindicated/major/moderate/minor/none
- For "none" pairs, set mechanism/consequence/management to "" and citation_ids to [].
- If excerpts don't cover a pair, list it severity:"none" consequence:"Not covered in available excerpts."
- No prose outside the JSON.`;

export async function POST(req: NextRequest) {
  let body: { drugs?: string[] };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 });
  }
  const raw = (body.drugs || []).map((s) => (s || '').trim()).filter(Boolean);
  if (raw.length < 2) return new Response(JSON.stringify({ error: 'at least 2 drugs required' }), { status: 400 });
  if (raw.length > 5) return new Response(JSON.stringify({ error: 'at most 5 drugs supported' }), { status: 400 });

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();
  const traceId = await startTrace('drugs_interactions', { drugs: raw });

  (async () => {
    let outcome: 'success' | 'error' | 'partial' = 'success';
    let outcomeMsg: string | undefined;
    try {
      emit({ type: 'progress', stage: 'expanding', msg: `Normalizing ${raw.length} drug names in parallel…` });
      const normalized = await Promise.all(raw.map(normalizeDrugName));
      emit({ type: 'progress', stage: 'expanding', msg: `Checking: ${normalized.join(', ')}`, ms: Date.now() - t0 });

      const query = `drug-drug interactions between ${normalized.join(', ')}`;
      const result = await retrieve(query, { topK: 10, minSimilarity: 0.3 });
      const hits = result.hits;
      emit({ type: 'progress', stage: 'retrieving', msg: `Retrieved ${hits.length} excerpts (n(n-1)/2 = ${normalized.length * (normalized.length - 1) / 2} pairs to check)`, ms: Date.now() - t0 });
      if (hits.length === 0) { emit({ type: 'error', message: 'no excerpts' }); outcome = 'error'; outcomeMsg = 'no excerpts'; close(); return; }

      const citations = hits.map((h, i) => ({
        n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
        page_start: h.page_start, page_end: h.page_end,
        similarity: Number(h.similarity.toFixed(3)),
        preview: h.text.slice(0, 600),
      }));
      emit({ type: 'sources', items: citations });

      const contextBlock = hits.map((h, i) => `--- Excerpt ${i + 1} ---\n[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}\n${h.text}`).join('\n\n');
      emit({ type: 'progress', stage: 'generating', msg: `Analyzing pairs with ${DRUGS_MODEL}…`, ms: Date.now() - t0 });
      const r = await tracedChat(traceId, 'interactions', {
        model: DRUGS_MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Drugs to check: ${normalized.join(', ')}\n\nExcerpts:\n${contextBlock}\n\nOutput ONLY the JSON object covering all pairs now.` },
        ],
        temperature: 0.2,
        max_tokens: 1500,
        ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
      });
      const llmRaw = r.choices?.[0]?.message?.content ?? '';
      emit({ type: 'progress', stage: 'parsing', msg: 'Deduplicating pairs…', ms: Date.now() - t0 });
      const parsed = parseLooseJson(llmRaw) as { summary?: string; pairs?: unknown[] };

      const rawPairs = Array.isArray(parsed.pairs) ? parsed.pairs : [];
      const seen = new Set<string>();
      const pairs = [];
      for (const p of rawPairs as Array<{ drug_a?: string; drug_b?: string }>) {
        const a = String(p.drug_a || '').trim().toLowerCase();
        const b = String(p.drug_b || '').trim().toLowerCase();
        if (!a || !b || a === b) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push(p);
      }

      emit({ type: 'result', data: { input: raw, normalized, summary: parsed.summary ?? '', pairs, citations } });
      emit({ type: 'done', ms: Date.now() - t0 });
    } catch (e) {
      outcome = 'error';
      outcomeMsg = String((e as Error).message);
      emit({ type: 'error', message: outcomeMsg });
    } finally {
      await finishTrace(traceId, outcome, outcomeMsg);
      close();
    }
  })();

  const headers = ndjsonHeaders();
  headers.set('X-Trace-Id', traceId);
  return new Response(stream, { headers });
}
