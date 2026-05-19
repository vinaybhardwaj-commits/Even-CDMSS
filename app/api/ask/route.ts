import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { llm, TEXT_MODEL } from '@/lib/llm';

// Node runtime (we need streaming + ~30s budget; edge is fine too but node is safer)
export const runtime = 'nodejs';
export const maxDuration = 60;

const SYSTEM_PROMPT = `You are Even-Tutor, a medical study companion for residents and physicians.
You answer questions using ONLY the MKSAP excerpts provided below.

Rules:
- Be concise, precise, and clinically useful — the audience is a working physician.
- Cite the source for every clinical claim using bracketed numbers like [1], [2] that map to the excerpts.
- If the excerpts do not cover the question, say so plainly. Do not invent.
- If an excerpt looks garbled or nonsensical (some books were OCR'd), ignore it rather than quoting it.
- Match the voice of MKSAP: structured, evidence-based, practical.
- Prefer bullet points for management/diagnosis steps. Use prose for clinical reasoning.
`;

export async function POST(req: NextRequest) {
  let body: { question?: string; bookFilter?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 });
  }
  const question = (body.question || '').trim();
  if (!question) {
    return new Response(JSON.stringify({ error: 'question is required' }), { status: 400 });
  }

  // 1. Retrieve
  let hits;
  try {
    hits = await retrieve(question, { bookFilter: body.bookFilter });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'retrieval failed', detail: String((e as Error).message) }), { status: 500 });
  }

  if (hits.length === 0) {
    return new Response(JSON.stringify({ error: 'no relevant excerpts found above similarity threshold' }), { status: 404 });
  }

  // 2. Build context block
  const contextBlock = hits
    .map((h, i) => {
      const cite = `[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}${h.item_number ? ' · Item ' + h.item_number : ''}`;
      return `--- Excerpt ${i + 1} ---\n${cite}\n${h.text}\n`;
    })
    .join('\n');

  const userMsg = `Question:\n${question}\n\nMKSAP Excerpts:\n${contextBlock}\n\nAnswer the question above using only these excerpts. Cite each claim with the bracketed number that matches the excerpt.`;

  // 3. Stream the LLM response, prepending the citations as a JSON header line so the client can render them
  const encoder = new TextEncoder();
  const citationsHeader = JSON.stringify({
    type: 'citations',
    items: hits.map((h, i) => ({
      n: i + 1,
      id: h.id,
      book: h.book,
      chapter: h.chapter,
      page_start: h.page_start,
      page_end: h.page_end,
      item_number: h.item_number,
      chunk_type: h.chunk_type,
      similarity: Number(h.similarity.toFixed(3)),
      preview: h.text.slice(0, 600),
    })),
  });

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(citationsHeader + '\n\n---STREAM---\n'));
      try {
        const completion = await llm.chat.completions.create({
          model: TEXT_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
          ],
          temperature: 0.2,
          stream: true,
        });
        for await (const part of completion) {
          const delta = part.choices?.[0]?.delta?.content ?? '';
          if (delta) controller.enqueue(encoder.encode(delta));
        }
      } catch (e) {
        controller.enqueue(encoder.encode(`\n\n[stream error: ${(e as Error).message}]`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Even-Tutor-Hits': String(hits.length),
    },
  });
}
