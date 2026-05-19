import { NextRequest, NextResponse } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { llm } from '@/lib/llm';

const DDX_MODEL = 'llama3.1:8b';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SYSTEM = `You are an expert internist generating a differential diagnosis for a clinician colleague.
You answer using ONLY the medical excerpts provided. You do not invent diagnoses, mechanisms, or citations.

Output format — REQUIRED, valid JSON object only, no preamble, no markdown:
{
  "summary": "one-line clinical summary including pertinent demographics and the chief complaint",
  "missing_info": ["any critical data points the clinician omitted that would meaningfully change the differential"],
  "cannot_miss": [
    {
      "diagnosis": "short name",
      "likelihood": "low" | "moderate" | "high",
      "why_consider": "1-2 sentences on why this dangerous diagnosis must be considered for THIS patient",
      "distinguishing_features": ["one-line features that, if present/absent, increase/decrease probability"],
      "investigations": ["specific test or maneuver to confirm or refute"],
      "citation_ids": [1, 3]
    }
  ],
  "most_likely": [ /* same shape */ ],
  "other": [ /* same shape */ ]
}

Rules:
- "cannot_miss": exactly 2-3 dangerous/time-sensitive diagnoses. Worst-first.
- "most_likely": exactly 2-3 diagnoses ranked by clinical probability.
- "other": 1-2 less likely considerations.
- Keep "why_consider" under 25 words. Each "distinguishing_features" / "investigations" entry under 12 words. Be terse.
- "citation_ids": 1-based numbers matching the bracketed excerpt numbers below. Cite every clinical claim.
- If the presentation is too vague to differentiate sensibly, say so in summary, list "missing_info" specifically, and return small or empty arrays — never fabricate.
- Ignore any obviously OCR-garbled excerpts. Do not quote nonsense.`;

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
    result = await retrieve(queryHint || display, { topK: 8, minSimilarity: 0.4 });
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
    });
  } catch (e) {
    return NextResponse.json({
      error: 'LLM failure',
      detail: String((e as Error).message),
      raw: raw.slice(0, 500),
    }, { status: 502 });
  }
}
