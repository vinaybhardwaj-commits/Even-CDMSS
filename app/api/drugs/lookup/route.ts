import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { llm } from '@/lib/llm';
import { DRUGS_MODEL, parseLooseJson, normalizeDrugName } from '@/lib/drugs';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SYSTEM = `You write structured drug references for clinicians. Use ONLY the medical excerpts provided.

Return ONLY this JSON, lowercase keys, no prose:
{"drug_normalized":"...","class":"...","indications":["..."],"typical_dosing":["..."],"renal_adjust":"...","hepatic_adjust":"...","contraindications":["..."],"adverse_effects":["..."],"monitoring":["..."],"citation_ids":[1,2]}

- Be terse: each bullet under 20 words.
- "renal_adjust" / "hepatic_adjust": one sentence each, or "Not specified in available excerpts" if missing.
- Only include items supported by the excerpts.
- "citation_ids": 1-based numbers from the excerpts.`;

export async function POST(req: NextRequest) {
  let body: { drug?: string };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 });
  }
  const raw = (body.drug || '').trim();
  if (!raw) return new Response(JSON.stringify({ error: 'drug required' }), { status: 400 });

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();

  (async () => {
    try {
      emit({ type: 'progress', stage: 'expanding', msg: `Normalizing "${raw}" to generic name…` });
      const normalized = await normalizeDrugName(raw);
      emit({ type: 'progress', stage: 'expanding', msg: `Resolved to "${normalized}"`, ms: Date.now() - t0 });

      const query = `${normalized} drug — class, indications, dosing, contraindications, adverse effects, monitoring`;
      const result = await retrieve(query, { topK: 6, minSimilarity: 0.35 });
      const hits = result.hits;
      emit({ type: 'progress', stage: 'retrieving', msg: `Retrieved ${hits.length} excerpts`, ms: Date.now() - t0 });
      if (hits.length === 0) { emit({ type: 'error', message: `no excerpts for "${raw}"` }); close(); return; }

      const citations = hits.map((h, i) => ({
        n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
        page_start: h.page_start, page_end: h.page_end,
        similarity: Number(h.similarity.toFixed(3)),
        preview: h.text.slice(0, 600),
      }));
      emit({ type: 'sources', items: citations });

      const contextBlock = hits.map((h, i) => `--- Excerpt ${i + 1} ---\n[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}\n${h.text}`).join('\n\n');

      emit({ type: 'progress', stage: 'generating', msg: `Composing drug card with ${DRUGS_MODEL}…`, ms: Date.now() - t0 });
      const r = await llm.chat.completions.create({
        model: DRUGS_MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Drug: ${normalized}\n\nExcerpts:\n${contextBlock}\n\nOutput ONLY the JSON object now.` },
        ],
        temperature: 0.2,
        max_tokens: 1200,
      });
      const llmRaw = r.choices?.[0]?.message?.content ?? '';
      emit({ type: 'progress', stage: 'parsing', msg: 'Parsing drug card…', ms: Date.now() - t0 });
      const parsed = parseLooseJson(llmRaw) as Record<string, unknown>;

      emit({
        type: 'result',
        data: {
          input: raw,
          normalized,
          drug_normalized: parsed.drug_normalized ?? normalized,
          class: parsed.class ?? '',
          indications: Array.isArray(parsed.indications) ? parsed.indications : [],
          typical_dosing: Array.isArray(parsed.typical_dosing) ? parsed.typical_dosing : [],
          renal_adjust: parsed.renal_adjust ?? '',
          hepatic_adjust: parsed.hepatic_adjust ?? '',
          contraindications: Array.isArray(parsed.contraindications) ? parsed.contraindications : [],
          adverse_effects: Array.isArray(parsed.adverse_effects) ? parsed.adverse_effects : [],
          monitoring: Array.isArray(parsed.monitoring) ? parsed.monitoring : [],
          citations,
        },
      });
      emit({ type: 'done', ms: Date.now() - t0 });
    } catch (e) {
      emit({ type: 'error', message: String((e as Error).message) });
    } finally { close(); }
  })();

  return new Response(stream, { headers: ndjsonHeaders() });
}
