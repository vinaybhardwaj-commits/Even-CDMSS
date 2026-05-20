import { NextRequest, NextResponse } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { sql } from '@/lib/db';
import { llm, COACH_MODEL, buildCoachSystemPrompt, parseLooseJson, loadSession, computeAccuracy, Turn } from '@/lib/coach';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_TURNS = 15; // total messages each side combined — hard cap

export async function POST(req: NextRequest) {
  let body: { session_id?: number; user_message?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const id = Number(body.session_id);
  const msg = (body.user_message || '').trim();
  if (!id) return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  if (!msg) return NextResponse.json({ error: 'user_message required' }, { status: 400 });

  const sess = await loadSession(id);
  if (!sess) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  if (sess.ended_at) return NextResponse.json({ error: 'session already ended' }, { status: 409 });

  const turns: Turn[] = Array.isArray(sess.turns) ? sess.turns : [];
  const userTurn: Turn = { role: 'user', content: msg, timestamp: new Date().toISOString() };

  // Build conversation history for LLM
  const history = turns.map((t) => ({
    role: (t.role === 'coach' ? 'assistant' : 'user') as 'assistant' | 'user',
    content: t.content,
  }));

  // Retrieve fresh context based on the user's most recent message (more responsive than fixed-topic retrieval)
  const subject = `${sess.topic} ${msg}`;
  let hits: Awaited<ReturnType<typeof retrieve>>['hits'] = [];
  try { hits = (await retrieve(subject, { topK: 5, minSimilarity: 0.3 })).hits; } catch {}
  const contextBlock = hits.length
    ? hits.map((h, i) => `--- Excerpt ${i + 1} (${h.book}${h.chapter ? ' · ' + h.chapter : ''}) ---\n${h.text.slice(0, 600)}`).join('\n\n')
    : '(no fresh excerpts retrieved for this turn)';

  const system = buildCoachSystemPrompt(sess.difficulty, 'topic', sess.topic);
  const turnCount = turns.length + 1;
  const forceSummary = turnCount >= MAX_TURNS;

  const llmInput = [
    { role: 'system' as const, content: system },
    ...history,
    {
      role: 'user' as const,
      content: `Learner's latest reply: "${msg}"\n\nFresh excerpts (your grounding, do NOT quote):\n${contextBlock}\n\nEvaluate the learner's reply, decide difficulty change, then output the JSON.${forceSummary ? '\n\nNOTE: turn budget reached — set mastered=true and next_turn.type="summary".' : ''}`,
    },
  ];

  let raw = '';
  try {
    const r = await llm.chat.completions.create({
      model: COACH_MODEL,
      messages: llmInput,
      temperature: 0.3,
      max_tokens: 500,
    });
    raw = r.choices?.[0]?.message?.content ?? '';
    const parsed = parseLooseJson(raw) as {
      evaluation?: { correctness?: string; feedback?: string };
      difficulty_change?: 'up' | 'down' | 'stay';
      mastered?: boolean;
      next_turn?: { type?: 'question' | 'summary'; content?: string };
    };

    // Attach evaluation onto the user turn
    if (parsed.evaluation?.correctness) {
      userTurn.evaluation = {
        correctness: (parsed.evaluation.correctness as Turn['evaluation'] extends infer T ? (T extends { correctness: infer C } ? C : never) : never) || 'partial',
        feedback: parsed.evaluation.feedback || '',
      } as Turn['evaluation'];
    }

    const coachTurn: Turn = {
      role: 'coach',
      content: (parsed.next_turn?.content || 'Could you say more about that?').trim(),
      timestamp: new Date().toISOString(),
    };

    // Apply difficulty change
    const order = ['novice', 'intermediate', 'advanced'] as const;
    let newDifficulty = sess.difficulty;
    const idx = order.indexOf(sess.difficulty);
    if (parsed.difficulty_change === 'up' && idx < 2) newDifficulty = order[idx + 1];
    if (parsed.difficulty_change === 'down' && idx > 0) newDifficulty = order[idx - 1];

    const newTurns = [...turns, userTurn, coachTurn];
    const accuracy = computeAccuracy(newTurns);
    const mastered = !!parsed.mastered || parsed.next_turn?.type === 'summary' || forceSummary;
    const ended_at = mastered ? new Date().toISOString() : null;
    const outcome = mastered ? (parsed.mastered ? 'mastered' : 'capped') : null;

    await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown>)(
      `UPDATE coaching_sessions SET turns = $1::jsonb, difficulty = $2, accuracy = $3, ended_at = $4, outcome = $5 WHERE id = $6`,
      [JSON.stringify(newTurns), newDifficulty, accuracy, ended_at, outcome, id]
    );

    return NextResponse.json({
      session_id: id,
      user_turn: userTurn,
      coach_turn: coachTurn,
      difficulty: newDifficulty,
      difficulty_changed: newDifficulty !== sess.difficulty,
      accuracy: Number(accuracy.toFixed(2)),
      mastered,
      ended_at,
      outcome,
      is_summary: parsed.next_turn?.type === 'summary',
    });
  } catch (e) {
    return NextResponse.json({ error: 'LLM failure', detail: String((e as Error).message), raw: raw.slice(0, 300) }, { status: 502 });
  }
}
