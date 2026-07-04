// Concordance — non-core runner. Imports the LLM client; delegates all pure logic to
// concordance-core. P0 single-shot: a CLEAN direct Mac-mini call (no RAG, no retrieve,
// no critique/revise) — ₹0. This is deliberately NOT the ask-route pipeline, whose
// audit/revise pass hedges concordance verdicts.

import { llm, TEXT_MODEL } from './llm';
import {
  buildConcordancePrompt, parseConcordance, type ParsedConcordance,
  buildSeedPrompt, parseSeed, buildNextQuestionPrompt, parseNextQuestion,
  initInterview, recordTurn, shouldStop, toVerdictContext,
  DEFAULT_INTERVIEW_OPTS,
  type BeliefItem, type InterviewState, type InterviewOpts, type NextQuestion,
} from './concordance-core';

export interface SingleShotResult {
  ok: boolean;
  model: string;
  ms: number;
  raw: string;
  parsed: ParsedConcordance;
  error?: string;
}

export async function runConcordanceSingleShot(result: string, context: string, model = TEXT_MODEL): Promise<SingleShotResult> {
  const { system, user } = buildConcordancePrompt(result, context);
  const t0 = Date.now();
  const resp = await llm.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const raw = resp.choices?.[0]?.message?.content ?? '';
  return {
    ok: true,
    model,
    ms: Date.now() - t0,
    raw,
    parsed: parseConcordance(raw),
  };
}

// ── P1: adaptive interview (LLM wrappers + driver) ──

async function chat(system: string, user: string, model: string): Promise<string> {
  const resp = await llm.chat.completions.create({
    model, temperature: 0.2,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  return resp.choices?.[0]?.message?.content ?? '';
}

/** Seed the cause-differential + prior belief from the result + minimal context. */
export async function seedBelief(result: string, context: string, model = TEXT_MODEL): Promise<BeliefItem[]> {
  const { system, user } = buildSeedPrompt(result, context);
  return parseSeed(await chat(system, user, model));
}

/** Produce the single next discriminating question (or STOP) given the interview state. */
export async function askNextQuestion(state: InterviewState, model = TEXT_MODEL): Promise<NextQuestion> {
  const { system, user } = buildNextQuestionPrompt(state);
  return parseNextQuestion(await chat(system, user, model));
}

/** The clinician/report/lab answering a question. In the product this is the UI/user;
 *  in the P1 test harness it is a fixture-answerer. Returns "I don't have this" freely. */
export type Answerer = (q: NextQuestion) => Promise<string>;

export interface InterviewResult { state: InterviewState; verdict: SingleShotResult; }

/** Run the full adaptive interview, then hand the transcript to the P0 verdict engine. */
export async function runInterview(
  result: string, context: string, answerer: Answerer,
  opts: InterviewOpts = DEFAULT_INTERVIEW_OPTS, model = TEXT_MODEL,
): Promise<InterviewResult> {
  let state: InterviewState = { ...initInterview(result, context), belief: await seedBelief(result, context, model), status: 'asking' };
  while (state.askedCount < opts.cap) {
    const nq = await askNextQuestion(state, model);
    if (nq.stop) break;
    const answer = await answerer(nq);
    state = recordTurn(state, nq, answer);
    if (shouldStop(state, opts)) break;
  }
  state = { ...state, status: 'stopped' };
  const verdict = await runConcordanceSingleShot(result, toVerdictContext(state), model);
  return { state, verdict };
}
