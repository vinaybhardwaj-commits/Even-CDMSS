import { NextRequest } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { llm, TEXT_MODEL } from '@/lib/llm';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SYSTEM = `You are Even-Tutor. Generate a tight, MKSAP-style study guide.

OUTPUT FORMAT — REQUIRED, NO DEVIATION:
Begin with these six section headers, in this order, each on its own line, no other heading levels, no preamble, no bold titles, no top-level "Study Guide" title:

## Overview
## Pathophysiology
## Clinical Features
## Diagnosis
## Management
## Pearls & Pitfalls

CONTENT RULES:
- Each section: 3-7 bullets (use "- " markers), each ONE-sentence dense, clinically actionable.
- Cite each clinical claim with bracketed numbers like [1] or [3,5] that map to the supplied excerpts.
- If a section has no support in the excerpts, write exactly: "- Not covered in the available excerpts."
- Stay on the requested topic. If the top excerpts are tangential (e.g., SVT when asked for atrial fibrillation), still anchor on the requested topic — say "Not covered" rather than pivoting.
- MKSAP voice: evidence-based, terse, no fluff, no marketing words like "comprehensive" or "robust".
- Skip excerpts that are obviously OCR-garbled — do not quote them.`;

export async function POST(req: NextRequest) {
  let body: { topic?: string; bookFilter?: string };
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 }); }
  const topic = (body.topic || '').trim();
  if (!topic) return new Response(JSON.stringify({ error: 'topic is required' }), { status: 400 });

  // Retrieve broader set than /ask (15 instead of 8)
  let result;
  try {
    result = await retrieve(topic, { topK: 15, bookFilter: body.bookFilter, minSimilarity: 0.35 });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'retrieval failed', detail: String((e as Error).message) }), { status: 500 });
  }
  const hits = result.hits;
  if (hits.length === 0) return new Response(JSON.stringify({ error: 'no relevant excerpts above threshold' }), { status: 404 });

  const contextBlock = hits.map((h, i) => {
    const cite = `[${i + 1}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}${h.page_start ? ' · p.' + h.page_start : ''}`;
    return `--- Excerpt ${i + 1} ---\n${cite}\n${h.text}\n`;
  }).join('\n');

  const userMsg = `Topic: ${topic}\n\nMKSAP Excerpts:\n${contextBlock}\n\nGenerate the structured study guide following the required format. Cite each claim with [n].`;

  const encoder = new TextEncoder();
  const citationsHeader = JSON.stringify({
    type: 'citations',
    items: hits.map((h, i) => ({
      n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
      page_start: h.page_start, page_end: h.page_end,
      item_number: h.item_number, chunk_type: h.chunk_type,
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
            { role: 'system', content: SYSTEM },
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
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Even-Tutor-Hits': String(hits.length) },
  });
}
