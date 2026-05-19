import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { llm, TEXT_MODEL } from '@/lib/llm';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SYSTEM = `You are a medical education content writer. From a single MKSAP explanation excerpt, generate ONE multiple-choice question in MKSAP style.

Rules:
- The question stem should be a 2-4 sentence clinical vignette anchored in the excerpt.
- Provide exactly 4 plausible options, only ONE correct. Options should be ~1 sentence each.
- The correct option must be supported by the excerpt.
- Distractors should be plausible clinical errors a resident might make.
- Add a 2-3 sentence rationale that cites the key reasoning from the excerpt.

Return ONLY valid JSON in this exact shape, with no preamble, no markdown, no commentary:
{
  "question": "...",
  "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
  "correct": "A",
  "rationale": "..."
}`;

function parseJsonLoose(s: string): unknown {
  // Strip ```json fences if any
  let t = s.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // Find first '{' and last '}' to be defensive
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

export async function POST(req: NextRequest) {
  let body: { book?: string } = {};
  try { body = await req.json(); } catch {}

  // Pick a random explanation chunk, optionally filtered by book.
  // Use TABLESAMPLE for speed on large tables; fallback to ORDER BY random().
  const rows = body.book
    ? (await sql`SELECT id, book, chapter, page_start, item_number, text
                 FROM mksap_chunks WHERE chunk_type='explanation'
                   AND item_number IS NOT NULL AND book = ${body.book}
                   AND length(text) BETWEEN 600 AND 2400
                 ORDER BY random() LIMIT 1`) as Array<{ id: number; book: string; chapter: string; page_start: number; item_number: string; text: string }>
    : (await sql`SELECT id, book, chapter, page_start, item_number, text
                 FROM mksap_chunks WHERE chunk_type='explanation'
                   AND item_number IS NOT NULL
                   AND length(text) BETWEEN 600 AND 2400
                 ORDER BY random() LIMIT 1`) as Array<{ id: number; book: string; chapter: string; page_start: number; item_number: string; text: string }>;

  if (rows.length === 0) return NextResponse.json({ error: 'no source chunk found' }, { status: 404 });
  const src = rows[0];

  try {
    const r = await llm.chat.completions.create({
      model: TEXT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `MKSAP excerpt (Book: ${src.book}, Chapter: ${src.chapter}, Item ${src.item_number}, p.${src.page_start}):\n\n${src.text}` },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });
    const raw = r.choices?.[0]?.message?.content ?? '';
    const parsed = parseJsonLoose(raw) as { question?: string; options?: Record<string, string>; correct?: string; rationale?: string };
    if (!parsed.question || !parsed.options || !parsed.correct || !parsed.rationale) {
      return NextResponse.json({ error: 'malformed LLM JSON', raw: raw.slice(0, 300), source: src }, { status: 502 });
    }
    return NextResponse.json({
      source: { id: src.id, book: src.book, chapter: src.chapter, page_start: src.page_start, item_number: src.item_number, text: src.text },
      mcq: parsed,
    });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
  }
}
