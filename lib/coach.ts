import { llm } from './llm';
import { sql } from './db';

export const COACH_MODEL = 'llama3.1:8b';

export type Turn = {
  role: 'coach' | 'user';
  content: string;
  evaluation?: { correctness: 'correct' | 'partial' | 'incorrect' | 'clarifying'; feedback: string };
  timestamp: string;
};

export type SessionRow = {
  id: number;
  topic: string;
  difficulty: 'novice' | 'intermediate' | 'advanced';
  turns: Turn[];
  outcome: string | null;
  accuracy: number | null;
  ended_at: string | null;
};

export function parseLooseJson(s: string): unknown {
  let t = s.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

export function buildCoachSystemPrompt(difficulty: string, mode: 'topic' | 'case', subject: string): string {
  return `You are a Socratic medical-teaching coach for a junior doctor (RMO/registrar). You NEVER give the answer directly. You probe the learner's reasoning with targeted questions that surface understanding or expose gaps.

CURRENT TOPIC ${mode === 'case' ? '(CASE SCENARIO)' : '(TOPIC)'}: ${subject}
CURRENT DIFFICULTY: ${difficulty}

Teaching style by difficulty:
- novice: short, concrete questions. Anchor in textbook fundamentals. Walk through reasoning stepwise.
- intermediate: scenarios with realistic complications. Test pattern recognition and management priorities.
- advanced: edge cases, conflicting evidence, multi-system trade-offs. Test judgment, not facts.

Rules:
- Each turn, return ONLY the JSON object below — no markdown, no preamble.
- After every USER message you receive, evaluate it before asking the next question.
- correctness:
  * "correct" = clinically accurate + reasoning sound
  * "partial" = right direction but incomplete or imprecise
  * "incorrect" = wrong, or shows a reasoning gap
  * "clarifying" = user asked a question or expressed confusion (not an answer)
- difficulty_change:
  * "up" = 3+ recent correct AND user shows depth → upshift
  * "down" = 2 consecutive incorrect → downshift to scaffold
  * "stay" = default
- mastered = true ONLY when the learner has demonstrated correct reasoning across ≥3 distinct sub-aspects of the topic at the current or higher difficulty. Otherwise false.
- next_turn.type:
  * "question" if continuing (most turns)
  * "summary" only when mastered=true, OR when turn count is high and progress has plateaued
- next_turn.content for "question": ONE focused Socratic question (1-2 sentences). Never declarative.
- next_turn.content for "summary": 3-5 bullets — concepts mastered, gaps still open, suggested next topic.
- Use the supplied excerpts ONLY to ground YOUR questions in real clinical content. Do not quote them to the learner. Do not give away answers.

OUTPUT JSON SCHEMA:
{"evaluation":{"correctness":"...","feedback":"<25 words"},"difficulty_change":"up|down|stay","mastered":false,"next_turn":{"type":"question|summary","content":"..."}}`;
}

export async function loadSession(id: number): Promise<SessionRow | null> {
  const rows = (await sql`SELECT id, topic, difficulty, turns, outcome, accuracy, ended_at FROM coaching_sessions WHERE id = ${id}`) as SessionRow[];
  return rows[0] ?? null;
}

export function computeAccuracy(turns: Turn[]): number {
  const userTurns = turns.filter((t) => t.role === 'user' && t.evaluation);
  if (userTurns.length === 0) return 0;
  const correctish = userTurns.filter((t) => t.evaluation!.correctness === 'correct').length;
  const partial = userTurns.filter((t) => t.evaluation!.correctness === 'partial').length;
  return (correctish + 0.5 * partial) / userTurns.length;
}

export { llm };
