import { NextRequest, NextResponse } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { llm } from '@/lib/llm';
import { DRUGS_MODEL, parseLooseJson, normalizeDrugName } from '@/lib/drugs';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SYSTEM = `You write structured drug references for clinicians. Use ONLY the medical excerpts provided.

Return ONLY this JSON, lowercase keys, no prose:
{"drug_normalized":"...","class":"...","indications":["..."],"typical_dosing":["..."],"renal_adjust":"...","hepatic_adjust":"...","contraindications":["..."],"adverse_effects":["..."],"monitoring":["..."],"citation_ids":[1,2]}

- Be terse: each bullet under 20 words.
- "renal_adjust" / "hepatic_adjust": one sentence each, or "Not specified in available excerpts" if missing.
- Only include items supported by the excerpts. Empty array if nothing supports it.
- "citation_ids": 1-based numbers from the excerpts below covering all claims.`;

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let body: { drug?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const raw = (body.drug || '').trim();
  if (!raw) return NextResponse.json({ error: 'drug required' }, { status: 400 });

  const normalized = await normalizeDrugName(raw);
  const query = `${normalized} drug — class, indications, dosing, contraindications, adverse effects, monitoring`;

  let result;
  try {
    result = await retrieve(query, { topK: 6, minSimilarity: 0.35 });
  } catch (e) {
    return NextResponse.json({ error: 'retrieval failed', detail: String((e as Error).message) }, { status: 500 });
  }
  const hits = result.hits;
  if (hits.length === 0) {
    return NextResponse.json({ error: `no excerpts found for "${raw}" (normalized: "${normalized}")` }, { status: 404 });
  }

  const contextBlock = hits.map((h, i) => {
    const cite = `[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}`;
    return `--- Excerpt ${i + 1} ---\n${cite}\n${h.text}\n`;
  }).join('\n');

  const userMsg = `Drug: ${normalized}\n\nExcerpts:\n${contextBlock}\n\nOutput ONLY the JSON object now.`;

  let llmRaw = '';
  try {
    const r = await llm.chat.completions.create({
      model: DRUGS_MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.2,
      max_tokens: 1200,
    });
    llmRaw = r.choices?.[0]?.message?.content ?? '';
    const parsed = parseLooseJson(llmRaw) as Record<string, unknown>;

    const citations = hits.map((h, i) => ({
      n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
      page_start: h.page_start, page_end: h.page_end,
      similarity: Number(h.similarity.toFixed(3)),
      preview: h.text.slice(0, 600),
    }));

    return NextResponse.json({
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
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    return NextResponse.json({
      error: 'LLM failure',
      detail: String((e as Error).message),
      raw: llmRaw.slice(0, 500),
    }, { status: 502 });
  }
}
