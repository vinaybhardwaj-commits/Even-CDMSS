export const dynamic = 'force-dynamic';
export const maxDuration = 180;

import { retrieve } from '@/lib/retrieve';
import { llm, TEXT_MODEL } from '@/lib/llm';

// Topic synthesis: retrieve ~15 excerpts, then stream a cited study guide.
// Wire format matches topics-client: a JSON citations header, the literal
// delimiter "\n\n---STREAM---\n", then the markdown answer streamed as text.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const topic = String((body as { topic?: unknown }).topic ?? '').trim();
  if (!topic) return new Response('topic required', { status: 400 });

  const { hits } = await retrieve(topic, { topK: 15 });
  const citations = hits.map((h, i) => ({
    n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
    page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
    chunk_type: h.chunk_type, similarity: h.similarity,
    preview: (h.text || '').slice(0, 240),
  }));

  const context = hits
    .map((h, i) => `[${i + 1}] (${h.book}${h.chapter ? ', ' + h.chapter : ''})\n${h.text}`)
    .join('\n\n');
  const system =
    'You are a clinical educator. Write a concise, well-structured study guide on the given topic, grounded ONLY in the provided excerpts. ' +
    'Use "## " section headings (e.g. Definition, Diagnosis, Management, Pearls) and "- " bullet points. ' +
    'Cite every factual claim with [n] referring to the excerpt numbers. Do not invent facts beyond the excerpts.';
  const user = `Topic: ${topic}\n\nExcerpts:\n${context}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'citations', items: citations }) + '\n\n---STREAM---\n'));
        if (hits.length === 0) {
          controller.enqueue(encoder.encode('No matching material was found in the corpus for this topic.'));
          controller.close();
          return;
        }
        const completion = await llm.chat.completions.create({
          model: TEXT_MODEL,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.2,
          stream: true,
        });
        for await (const part of completion as AsyncIterable<{ choices?: { delta?: { content?: string } }[] }>) {
          const delta = part.choices?.[0]?.delta?.content ?? '';
          if (delta) controller.enqueue(encoder.encode(delta));
        }
        controller.close();
      } catch (e) {
        controller.enqueue(encoder.encode(`\n\n[error: ${(e as Error).message}]`));
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
