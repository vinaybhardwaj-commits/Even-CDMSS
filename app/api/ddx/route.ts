import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { llm } from '@/lib/llm';
import { makeNdjsonStream, ndjsonHeaders } from '@/lib/stream';

export const runtime = 'nodejs';
export const maxDuration = 120;

const DDX_MODEL = 'llama3.1:8b';

const SYSTEM = `You generate a differential diagnosis as JSON. Use ONLY the excerpts below for clinical content.

Return ONLY this JSON object, lowercase keys exactly as shown:
{"summary":"one line","missing_info":["..."],"cannot_miss":[{"diagnosis":"name","likelihood":"high|moderate|low","why_consider":"<25 words","distinguishing_features":["<12 words each"],"investigations":["<12 words each"],"citation_ids":[1,2]}],"most_likely":[...same shape...],"other":[...same shape...]}

- cannot_miss: 2-3 dangerous/time-sensitive (worst-first)
- most_likely: 2-3 by probability
- other: 1-2 less likely
- citation_ids = 1-based numbers from the excerpts. Cite every claim.
- No prose, no markdown fences, lowercase keys.`;

type Body = { age?: number | string; sex?: string; cc?: string; history?: string; exam?: string; vitals?: string };

function buildPresentation(b: Body): { display: string; queryHint: string } {
  const parts: string[] = [];
  const agePart = b.age ? `${b.age}` : null;
  const sexPart = b.sex && b.sex !== '?' ? `${b.sex}` : null;
  const demo = [agePart, sexPart].filter(Boolean).join(' / ');
  if (demo) parts.push(demo);
  if (b.cc) parts.push(`Chief complaint: ${b.cc.trim()}`);
  if (b.history) parts.push(`Key history: ${b.history.trim()}`);
  if (b.exam) parts.push(`Exam: ${b.exam.trim()}`);
  if (b.vitals) parts.push(`Vitals: ${b.vitals.trim()}`);
  return { display: parts.join('\n'), queryHint: [demo, b.cc, b.history, b.exam, b.vitals].filter(Boolean).join('; ') };
}

function parseLooseJson(s: string): unknown {
  let t = s.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

export async function POST(req: NextRequest) {
  let body: Body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 });
  }
  if (!body.cc || !body.cc.trim()) {
    return new Response(JSON.stringify({ error: 'chief_complaint required' }), { status: 400 });
  }
  const { display, queryHint } = buildPresentation(body);

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();

  (async () => {
    try {
      emit({ type: 'progress', stage: 'expanding', msg: 'Building clinical summary, expanding query…' });
      const result = await retrieve(queryHint || display, { topK: 8, minSimilarity: 0.4 });
      const hits = result.hits;
      emit({ type: 'progress', stage: 'retrieving', msg: `Retrieved ${hits.length} excerpts`, ms: Date.now() - t0 });
      if (hits.length === 0) { emit({ type: 'error', message: 'no excerpts above threshold — presentation may be too vague' }); close(); return; }

      const citations = hits.map((h, i) => ({
        n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
        page_start: h.page_start, page_end: h.page_end,
        item_number: h.item_number, chunk_type: h.chunk_type,
        similarity: Number(h.similarity.toFixed(3)),
        preview: h.text.slice(0, 600),
      }));
      emit({ type: 'sources', items: citations });

      const contextBlock = hits.map((h, i) => `--- Excerpt ${i + 1} ---\n[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}\n${h.text}`).join('\n\n');
      const userMsg = `CLINICAL PRESENTATION:\n${display}\n\nMEDICAL EXCERPTS:\n${contextBlock}\n\nOutput ONLY the JSON object now, starting with {. No prose, no markdown fences.`;

      emit({ type: 'progress', stage: 'generating', msg: `Reasoning with ${DDX_MODEL}…`, ms: Date.now() - t0 });
      const r = await llm.chat.completions.create({
        model: DDX_MODEL,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }],
        temperature: 0.2,
        max_tokens: 1500,,
        // @ts-expect-error — Ollama: num_ctx prevents KV-cache thrashing
        options: { num_ctx: 16384 },
      });
      const raw = r.choices?.[0]?.message?.content ?? '';
      emit({ type: 'progress', stage: 'parsing', msg: 'Parsing differential…', ms: Date.now() - t0 });

      const parsed = parseLooseJson(raw) as {
        summary?: string; missing_info?: string[];
        cannot_miss?: unknown[]; most_likely?: unknown[]; other?: unknown[];
      };
      emit({
        type: 'result',
        data: {
          summary: parsed.summary ?? '',
          missing_info: Array.isArray(parsed.missing_info) ? parsed.missing_info : [],
          cannot_miss: Array.isArray(parsed.cannot_miss) ? parsed.cannot_miss : [],
          most_likely: Array.isArray(parsed.most_likely) ? parsed.most_likely : [],
          other: Array.isArray(parsed.other) ? parsed.other : [],
          citations,
          presentation: display,
        },
      });
      emit({ type: 'done', ms: Date.now() - t0 });
    } catch (e) {
      emit({ type: 'error', message: String((e as Error).message) });
    } finally { close(); }
  })();

  return new Response(stream, { headers: ndjsonHeaders() });
}
