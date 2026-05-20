import { NextRequest, NextResponse } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { llm } from '@/lib/llm';
import { DRUGS_MODEL, parseLooseJson, normalizeDrugName } from '@/lib/drugs';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SYSTEM = `You analyze drug-drug interactions for clinicians. Use ONLY the medical excerpts provided.

Return ONLY this JSON, lowercase keys, no prose:
{"summary":"one sentence overall risk picture","pairs":[{"drug_a":"...","drug_b":"...","severity":"contraindicated|major|moderate|minor|none","mechanism":"<30 words","consequence":"<30 words","management":"<30 words","citation_ids":[1,2]}]}

- One object per UNIQUE pair. If N drugs given, include up to N*(N-1)/2 pairs but ONLY those with a real interaction.
- "severity":
   contraindicated = avoid combo entirely
   major = significant harm risk, usually avoid or close monitoring
   moderate = monitor / adjust dose
   minor = clinical impact unlikely but documented
   none = no clinically meaningful interaction in the excerpts
- For "none" pairs, set mechanism/consequence/management to "" and citation_ids to [].
- If the excerpts do not cover a pair, list it with severity:"none" and consequence:"Not covered in available excerpts."
- Be terse. No prose outside the JSON.`;

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let body: { drugs?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const raw = (body.drugs || []).map((s) => (s || '').trim()).filter(Boolean);
  if (raw.length < 2) return NextResponse.json({ error: 'at least 2 drugs required' }, { status: 400 });
  if (raw.length > 5) return NextResponse.json({ error: 'at most 5 drugs supported' }, { status: 400 });

  // Normalize names in parallel
  const normalized = await Promise.all(raw.map(normalizeDrugName));
  const drugList = normalized.join(', ');
  const query = `drug-drug interactions between ${drugList}`;

  let result;
  try {
    result = await retrieve(query, { topK: 10, minSimilarity: 0.3 });
  } catch (e) {
    return NextResponse.json({ error: 'retrieval failed', detail: String((e as Error).message) }, { status: 500 });
  }
  const hits = result.hits;
  if (hits.length === 0) {
    return NextResponse.json({ error: 'no excerpts found' }, { status: 404 });
  }

  const contextBlock = hits.map((h, i) => {
    const cite = `[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}`;
    return `--- Excerpt ${i + 1} ---\n${cite}\n${h.text}\n`;
  }).join('\n');

  const userMsg = `Drugs to check: ${drugList}\n\nExcerpts:\n${contextBlock}\n\nOutput ONLY the JSON object covering all pairs now.`;

  let llmRaw = '';
  try {
    const r = await llm.chat.completions.create({
      model: DRUGS_MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.2,
      max_tokens: 1500,
    });
    llmRaw = r.choices?.[0]?.message?.content ?? '';
    const parsed = parseLooseJson(llmRaw) as { summary?: string; pairs?: unknown[] };

    const citations = hits.map((h, i) => ({
      n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
      page_start: h.page_start, page_end: h.page_end,
      similarity: Number(h.similarity.toFixed(3)),
      preview: h.text.slice(0, 600),
    }));

    // Dedup pairs by canonical (alphabetized) key so the LLM can't list the same pair twice
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

    return NextResponse.json({
      input: raw,
      normalized,
      summary: parsed.summary ?? '',
      pairs,
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
