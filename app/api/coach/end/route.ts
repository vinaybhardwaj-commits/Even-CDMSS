import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { llm, COACH_MODEL, loadSession, computeAccuracy } from '@/lib/coach';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SUMMARY_SYSTEM = `You are a teaching coach wrapping up a Socratic session. Return ONLY this JSON:
{"summary":"<one sentence>","concepts_mastered":["<bullet>"],"gaps":["<bullet>"],"suggested_next":"<one topic to explore next>"}
- 3-5 items per array max. Each item under 20 words.
- "summary" reflects overall progress in one sentence.
- No prose outside the JSON.`;

export async function POST(req: NextRequest) {
  let body: { session_id?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const id = Number(body.session_id);
  if (!id) return NextResponse.json({ error: 'session_id required' }, { status: 400 });

  const sess = await loadSession(id);
  if (!sess) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const transcript = (sess.turns || []).map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');
  const accuracy = computeAccuracy(sess.turns || []);

  let raw = '';
  try {
    const r = await llm.chat.completions.create({
      model: COACH_MODEL,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `Topic: ${sess.topic}\nDifficulty: ${sess.difficulty}\nFinal accuracy: ${(accuracy * 100).toFixed(0)}%\n\nTranscript:\n${transcript}\n\nOutput the JSON summary now.` },
      ],
      temperature: 0.3,
      max_tokens: 400,
      // @ts-expect-error — Ollama: num_ctx + keep_alive
      keep_alive: '15m',
      options: { num_ctx: 16384 },
    } as any);
    raw = r.choices?.[0]?.message?.content ?? '';
    let t = raw.trim();
    if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const a = t.indexOf('{'); const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    const parsed = JSON.parse(t) as { summary?: string; concepts_mastered?: string[]; gaps?: string[]; suggested_next?: string };

    if (!sess.ended_at) {
      await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown>)(
        `UPDATE coaching_sessions SET ended_at = NOW(), outcome = COALESCE(outcome, 'completed'), accuracy = $1 WHERE id = $2`,
        [accuracy, id]
      );
    }

    return NextResponse.json({
      session_id: id,
      accuracy: Number(accuracy.toFixed(2)),
      summary: parsed.summary || '',
      concepts_mastered: Array.isArray(parsed.concepts_mastered) ? parsed.concepts_mastered : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      suggested_next: parsed.suggested_next || '',
    });
  } catch (e) {
    return NextResponse.json({ error: 'LLM failure', detail: String((e as Error).message), raw: raw.slice(0, 300) }, { status: 502 });
  }
}
