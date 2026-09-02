/**
 * lib/ipd-episode/judge.ts — the IMPURE half of the three Opus passes: A1 divergence, A2 fidelity,
 * B commentary. Every call goes through `governedChat` with `{ bedrock: model }` and no other
 * client (PRD §3.7).
 *
 * WHAT EACH PASS IS GIVEN IS DECIDED BEFORE IT GETS HERE. The caller hands A1 a list produced by
 * `diffPassEvents` (no discharge event) and A2 one produced by `fidelityPassEvents` (with it).
 * This file renders what it is given; it never reaches back for an event, which is why the
 * blinding cannot be broken by a change in here.
 */

import { governedChat } from '../trace';
import { assertKnownBedrockModel } from '../bedrock-core';
import {
  buildCommentaryUser, buildDiffUser, buildFidelityUser, parseFindings, validateCommentary,
  type Commentary, type EpisodeFinding,
} from './judge-core';
import {
  IPD_EPISODE_COMMENTARY_SYSTEM, IPD_EPISODE_DIFF_SYSTEM, IPD_EPISODE_FIDELITY_SYSTEM,
} from './prompts';
import type { EpisodeEvent } from './assemble-core';

/** `lib/bedrock-core.ts` BEDROCK_MODELS. Overridable by IPD_EPISODE_JUDGE_MODEL; an unlisted id is
 *  refused there. Opus does the diff, the fidelity check and the commentary. */
export const IPD_EPISODE_JUDGE_MODEL_DEFAULT = 'global.anthropic.claude-opus-4-6-v1';

export function judgeModel(env: Record<string, string | undefined>): string {
  const override = (env.IPD_EPISODE_JUDGE_MODEL ?? '').trim();
  return override || IPD_EPISODE_JUDGE_MODEL_DEFAULT;
}

const content = (res: unknown): string =>
  String((res as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content ?? '');

/** Two retries with exponential backoff, then give up (§8). Never throws. */
async function callWithRetry(
  traceId: string | undefined, label: string, system: string, user: string, model: string, promptRef: string, maxTokens: number,
): Promise<{ text: string; error: string | null }> {
  let lastError = 'no attempt was made';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    try {
      const res = await governedChat(traceId, label, {
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0,
        max_tokens: maxTokens,
      }, { bedrock: model, promptRef });
      const text = content(res);
      if (text.trim()) return { text, error: null };
      lastError = 'the response was empty';
    } catch (e) {
      lastError = String((e as Error).message).slice(0, 400);
    }
  }
  return { text: '', error: lastError };
}

export interface PassResult {
  findings: EpisodeFinding[];
  dropped: number;
  ok: boolean;
  error: string | null;
}

/** Pass A1 — divergence. Outcome-blind: `events` must already exclude the discharge event. */
export async function runDiffPass(a: {
  traceId: string | undefined;
  admissionContext: string;
  events: EpisodeEvent[];
  checkpointBlocks: string[];
  excerptCount: number;
  model: string;
}): Promise<PassResult> {
  const user = buildDiffUser({ admissionContext: a.admissionContext, events: a.events, checkpointBlocks: a.checkpointBlocks });
  const { text, error } = await callWithRetry(a.traceId, 'ipd_episode_diff', IPD_EPISODE_DIFF_SYSTEM, user, a.model, 'prompts/IPD_EPISODE_DIFF_SYSTEM', 8000);
  if (error) return { findings: [], dropped: 0, ok: false, error };
  const parsed = parseFindings(text, { pass: 'divergence', idPrefix: 'a1', excerptCount: a.excerptCount });
  // An empty findings list is a legitimate result — a concordant admission. Only a call or parse
  // FAILURE skips the episode (§8), so "no divergence found" must not look like a failure here.
  const usable = /\bfindings\b/.test(text);
  return { findings: parsed.findings, dropped: parsed.dropped, ok: usable, error: usable ? null : 'the response carried no findings array' };
}

/** Pass A2 — fidelity. Reads the discharge summary; writes `documentation` findings only. */
export async function runFidelityPass(a: {
  traceId: string | undefined;
  admissionContext: string;
  events: EpisodeEvent[];
  extractedCase: unknown;
  extractionVersion: string | null;
  model: string;
}): Promise<PassResult> {
  const user = buildFidelityUser({
    admissionContext: a.admissionContext, events: a.events,
    extractedCase: a.extractedCase, extractionVersion: a.extractionVersion,
  });
  const { text, error } = await callWithRetry(a.traceId, 'ipd_episode_fidelity', IPD_EPISODE_FIDELITY_SYSTEM, user, a.model, 'prompts/IPD_EPISODE_FIDELITY_SYSTEM', 8000);
  if (error) return { findings: [], dropped: 0, ok: false, error };
  const parsed = parseFindings(text, { pass: 'fidelity', idPrefix: 'a2', excerptCount: 0 });
  const usable = /\bfindings\b/.test(text);
  return { findings: parsed.findings, dropped: parsed.dropped, ok: usable, error: usable ? null : 'the response carried no findings array' };
}

/**
 * Pass B — commentary. The only outcome-aware pass, and the only one whose output is thrown away
 * whole when it misbehaves: a score field or an unknown finding_id costs one retry and then null
 * (§8). A failed commentary never fails the episode — the audit row is written with
 * `commentary = null`, which the UI renders as an honest absence.
 */
export async function runCommentaryPass(a: {
  traceId: string | undefined;
  admissionContext: string;
  events: EpisodeEvent[];
  findings: EpisodeFinding[];
  outcomeLine: string;
  expectedCourses: string[];
  model: string;
}): Promise<{ commentary: Commentary | null; error: string | null }> {
  const user = buildCommentaryUser({
    admissionContext: a.admissionContext, events: a.events, findings: a.findings,
    outcomeLine: a.outcomeLine, expectedCourses: a.expectedCourses,
  });
  const knownIds = a.findings.map((f) => f.finding_id);

  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, error } = await callWithRetry(a.traceId, `ipd_episode_commentary${attempt ? '_retry' : ''}`, IPD_EPISODE_COMMENTARY_SYSTEM, user, a.model, 'prompts/IPD_EPISODE_COMMENTARY_SYSTEM', 6000);
    if (error) { lastError = error; continue; }
    const v = validateCommentary(text, knownIds);
    if (v.ok) return { commentary: v.commentary, error: null };
    lastError = v.reason;
  }
  return { commentary: null, error: lastError };
}

export { assertKnownBedrockModel };
