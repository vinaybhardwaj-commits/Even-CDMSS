import { NextRequest, NextResponse } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { llm } from '@/lib/llm';

const DDX_MODEL = 'llama3.1:8b';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SYSTEM = `You generate a differential diagnosis as JSON. Use ONLY the excerpts below for clinical content.

Return ONLY this JSON object, lowercase keys exactly as shown:
{"summary":"one line","missing_info":["..."],"cannot_miss":[{"diagnosis":"name","likelihood":"high|moderate|low","why_consider":"<25 words","distinguishing_features":["<12 words each"],"investigations":["<12 words each"],"citation_ids":[1,2]}],"most_likely":[...same shape...],"other":[...same shape...]}

- cannot_miss: 2-3 dangerous/time-sensitive (worst-first)
- most_likely: 2-3 by probability
- other: 1-2 less likely
- citation_ids = 1-based numbers from the excerpts. Cite every claim.
- No prose, no markdown fences, lowercase keys.`;

type Body = {
  age?: number | string;
  sex?: string;
  cc?: string;
  history?: string;
  exam?: string;
  vitals?: string;
  session_id?: string;
};

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
  const display = parts.join('\n');
  // For retrieval, dense one-liner
  const queryHint = [demo, b.cc, b.history, b.exam, b.vitals].filter(Boolean).join('; ');
  return { display, queryHint };
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
  const t0 = Date.now();
  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  if (!body.cc || !body.cc.trim()) return NextResponse.json({ error: 'chief_complaint required' }, { status: 400 });

  const { display, queryHint } = buildPresentation(body);

  // Retrieve top-20 across all sources
  let result;
  try {
    result = await retrieve(queryHint || display, { topK: 5, minSimilarity: 0.4 });
  } catch (e) {
    return NextResponse.json({ error: 'retrieval failed', detail: String((e as Error).message) }, { status: 500 });
  }
  const hits = result.hits;
  if (hits.length === 0) {
    return NextResponse.json({ error: 'no relevant excerpts above threshold — presentation too vague?' }, { status: 404 });
  }

  const contextBlock = hits.map((h, i) => {
    const cite = `[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}`;
    return `--- Excerpt ${i + 1} ---\n${cite}\n${h.text}\n`;
  }).join('\n');

  const userMsg = `CLINICAL PRESENTATION:\n${display}\n\nMEDICAL EXCERPTS:\n${contextBlock}\n\nOutput ONLY the JSON object now, starting with {. No prose, no markdown fences, no commentary.`;

  let raw = '';
  try {
    const r = await llm.chat.completions.create({
      model: DDX_MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.2,
      max_tokens: 1500,
    });
    raw = r.choices?.[0]?.message?.content ?? '';
    const parsed = parseLooseJson(raw) as {
      summary?: string;
      missing_info?: string[];
      cannot_miss?: unknown[];
      most_likely?: unknown[];
      other?: unknown[];
    };

    const citations = hits.map((h, i) => ({
      n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
      page_start: h.page_start, page_end: h.page_end,
      item_number: h.item_number, chunk_type: h.chunk_type,
      similarity: Number(h.similarity.toFixed(3)),
      preview: h.text.slice(0, 600),
    }));

    return NextResponse.json({
      summary: parsed.summary ?? '',
      missing_info: Array.isArray(parsed.missing_info) ? parsed.missing_info : [],
      cannot_miss: Array.isArray(parsed.cannot_miss) ? parsed.cannot_miss : [],
      most_likely: Array.isArray(parsed.most_likely) ? parsed.most_likely : [],
      other: Array.isArray(parsed.other) ? parsed.other : [],
      citations,
      presentation: display,
      duration_ms: Date.now() - t0,
      _debug_raw: raw.slice(0, 4000),
    });
  } catch (e) {
    return NextResponse.json({
      error: 'LLM failure',
      detail: String((e as Error).message),
      raw: raw.slice(0, 500),
    }, { status: 502 });
  }
}
