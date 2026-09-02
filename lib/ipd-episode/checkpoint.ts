/**
 * lib/ipd-episode/checkpoint.ts — the IMPURE checkpoint pass: retrieval, then one Haiku call per
 * checkpoint, through `governedChat` with `{ bedrock: model }` and nothing else.
 *
 * ONE MODEL PATH. `governedChat` is the only client this engine touches (PRD §3.7); the
 * reasoning-governance gate fails CI on any direct model call outside the governed layer, and
 * `assertKnownBedrockModel` refuses an unlisted id before any work starts rather than falling back
 * to whatever else is configured. A silently-substituted model is an unattributable audit row.
 *
 * RETRIEVAL IS BEST-EFFORT BY DESIGN (§8). A failed retrieve does not fail a checkpoint: the
 * checkpoint runs with no excerpts and the row records `retrieval_failed = true`, so a reader can
 * tell an uncited expectation caused by a retrieval outage from one that simply had no normative
 * source. The uncited cap in judge-core then does the rest.
 */

import { governedChat } from '../trace';
import { retrieve, resolveNormativeSources } from '../retrieve';
import { assertKnownBedrockModel } from '../bedrock-core';
import {
  buildCheckpointUser, buildRetrievalQuery, checkpointEntryRefs, countUncitedEntries,
  everyEntryUncited, parseExpectedCourse,
  RETRIEVAL_TOP_K, type CheckpointEntryRef, type ExpectedCourse, type RetrievedExcerpt,
} from './checkpoint-core';
import { IPD_EPISODE_CHECKPOINT_SYSTEM } from './prompts';
import type { EpisodeEvent } from './assemble-core';

/** `lib/bedrock-core.ts` BEDROCK_MODELS. Overridable by IPD_EPISODE_CHECKPOINT_MODEL; an unlisted
 *  id is refused there, so a mistyped variable costs one string comparison, not a wrong grader. */
export const IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

export function checkpointModel(env: Record<string, string | undefined>): string {
  const override = (env.IPD_EPISODE_CHECKPOINT_MODEL ?? '').trim();
  return override || IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT;
}

const EXCERPT_CHARS = 1100;

export interface RunCheckpointInput {
  traceId: string | undefined;
  checkpointId: string;
  checkpointType: 'daily' | 'episode';
  dayIndex: number;
  cutoffAt: string;
  admissionContext: string;
  /** ALREADY filtered by eventsBeforeDayStart / episodeLevelEvents. Never the whole episode. */
  events: EpisodeEvent[];
  retrievalQueryInput: Parameters<typeof buildRetrievalQuery>[0];
  model: string;
}

export interface CheckpointResult {
  checkpointId: string;
  dayIndex: number;
  checkpointType: 'daily' | 'episode';
  cutoffAt: string;
  inputEventCount: number;
  retrievalQuery: string;
  retrievalFailed: boolean;
  citationIds: number[];
  /** Cited chunk id → the `source` value of that chunk, verbatim. */
  citationSources: Record<string, string>;
  expectedCourse: ExpectedCourse | null;
  entryRefs: CheckpointEntryRef[];
  status: 'ok' | 'error';
  errorDetail: string | null;
  model: string;
  /** Entries this checkpoint produced that cite nothing, and how many entries there were — scalars
   *  so the grounding failure is visible without anyone parsing the expected_course jsonb. */
  uncitedEntryCount: number;
  entryCount: number;
  /** True when the whole course came back uncited and the one retry was spent on it. */
  retriedForCitations: boolean;
}

/**
 * Retrieval, degraded to "no excerpts" on any fault. Never throws.
 *
 * ⚠️ WIDE CORPUS PLUS THE NORMATIVE LEG (V, 2026-09-02). The main legs are unrestricted, so this
 * engine may cite anything retrieval returns — StatPearls chapters, surgical journal content,
 * textbook passages. `useNormativeLeg` adds a THIRD leg restricted to the normative sources into
 * the same RRF union, so a terse guideline statement still earns a pool seat instead of being
 * outranked by dense literature that happens to share more vocabulary with the query.
 *
 * The two are not in tension: widening decides what MAY be cited, the normative leg decides what
 * ranks. What keeps them honest is that the difference is recorded rather than assumed — every
 * cited chunk's `source` is stored on the checkpoint row, and a finding standing only on
 * literature is capped in code (see `applyLiteratureCap`). A journal abstract is evidence; a
 * guideline is a standard; the score should be able to tell you which one it rests on.
 */
async function retrieveExcerpts(query: string): Promise<{
  excerpts: RetrievedExcerpt[]; ids: number[]; sources: Record<string, string>; failed: boolean;
}> {
  if (!query.trim()) return { excerpts: [], ids: [], sources: {}, failed: false };
  try {
    const res = await retrieve(query, { topK: RETRIEVAL_TOP_K, useNormativeLeg: true });
    // ⚠️ ONE FILTERED LIST, TWO VIEWS OF IT. `excerpts` is what the prompt numbers [1]…[k] and
    // `ids` is what those ordinals resolve to, so they MUST stay index-aligned. Filtering a hit
    // out of one list and not the other would silently shift every ordinal after it onto the wrong
    // passage — a citation that points at real text nobody was shown.
    const hits = (res?.hits ?? []).slice(0, RETRIEVAL_TOP_K).filter((h) => Number.isFinite(Number(h.id)));
    // chunk id → its `source` value, verbatim from the row. The classification into
    // normative/literature happens later, against the shipped source list, so this map records the
    // FACT and nothing derived from it — a source list that changes later can be re-applied to
    // stored rows without re-running any model.
    const sources: Record<string, string> = {};
    for (const h of hits) sources[String(Number(h.id))] = String(h.source ?? '');
    return {
      excerpts: hits.map((h) => ({
        id: Number(h.id),
        label: [h.book, h.chapter, h.section].filter(Boolean).join(' · ') || String(h.source ?? 'source'),
        text: String(h.text ?? '').slice(0, EXCERPT_CHARS),
      })),
      ids: hits.map((h) => Number(h.id)),
      sources,
      failed: false,
    };
  } catch {
    return { excerpts: [], ids: [], sources: {}, failed: true };
  }
}

/** The normative source allowlist this engine classifies against — resolved from the SHIPPED
 *  helper so the definition never forks from the retrieval leg's own. */
export function normativeSourcesForProvenance(env: Record<string, string | undefined> = process.env): string[] {
  return resolveNormativeSources(undefined, env.NORMATIVE_LEG_SOURCES);
}

/**
 * One checkpoint. Bedrock faults are retried twice with exponential backoff (§8) and then recorded
 * as `status = 'error'`; the episode carries on with one fewer expected course. Unparseable JSON
 * is treated exactly like a call failure, because a response that cannot be read is a response
 * that did not arrive.
 */
export async function runCheckpoint(input: RunCheckpointInput): Promise<CheckpointResult> {
  const query = buildRetrievalQuery(input.retrievalQueryInput);
  const { excerpts, ids, sources, failed } = await retrieveExcerpts(query);

  const base: Omit<CheckpointResult, 'expectedCourse' | 'entryRefs' | 'status' | 'errorDetail' | 'uncitedEntryCount' | 'entryCount' | 'retriedForCitations'> = {
    checkpointId: input.checkpointId,
    dayIndex: input.dayIndex,
    checkpointType: input.checkpointType,
    cutoffAt: input.cutoffAt,
    inputEventCount: input.events.length,
    retrievalQuery: query,
    retrievalFailed: failed,
    citationIds: ids,
    citationSources: sources,
    model: input.model,
  };

  const user = buildCheckpointUser({
    checkpointId: input.checkpointId,
    checkpointType: input.checkpointType,
    dayIndex: input.dayIndex,
    cutoffAt: input.cutoffAt,
    admissionContext: input.admissionContext,
    events: input.events,
    excerpts,
  });

  const askOnce = async (extraInstruction: string | null): Promise<{ course: ExpectedCourse | null; error: string | null }> => {
    let lastError = 'no attempt was made';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 750 * Math.pow(2, attempt - 1)));
      try {
        const res = await governedChat(input.traceId, `ipd_episode_checkpoint_${input.checkpointId}`, {
          messages: [
            { role: 'system', content: IPD_EPISODE_CHECKPOINT_SYSTEM },
            { role: 'user', content: extraInstruction ? `${user}\n\n${extraInstruction}` : user },
          ],
          temperature: 0,
          max_tokens: 3000,
        }, { bedrock: input.model, promptRef: 'prompts/IPD_EPISODE_CHECKPOINT_SYSTEM' });

        const text = String(res?.choices?.[0]?.message?.content ?? '');
        // ids, not the count: the parser resolves each cited ordinal to the chunk id it stood for
        const course = parseExpectedCourse(text, ids);
        if (!course) { lastError = 'the response carried no usable expected course'; continue; }
        return { course, error: null };
      } catch (e) {
        lastError = String((e as Error).message).slice(0, 400);
      }
    }
    return { course: null, error: lastError };
  };

  const first = await askOnce(null);
  if (!first.course) {
    return {
      ...base, expectedCourse: null, entryRefs: [], status: 'error', errorDetail: first.error,
      uncitedEntryCount: 0, entryCount: 0, retriedForCitations: false,
    };
  }

  // ── item 2: ONE retry when the WHOLE course came back uncited and retrieval had succeeded ──
  // Measured on IP-1286: 42 of 42 entries cited nothing while every checkpoint row carried 8 real
  // chunk ids and retrieval_failed was false. Retrying only in that exact shape costs one extra
  // Haiku call on the episodes where the pass demonstrably failed, and nothing on the ones where it
  // worked. A second failure is KEPT, not discarded — an uncited course is still an expected
  // course, and the uncited cap already limits what any finding built on it can score.
  let course = first.course;
  let retried = false;
  if (excerpts.length > 0 && everyEntryUncited(course, excerpts.length)) {
    retried = true;
    const second = await askOnce(
      'YOUR PREVIOUS RESPONSE CITED NOTHING. Every entry came back with citation_ids: [], although '
      + `${excerpts.length} numbered excerpts were supplied above. Answer again, and give every entry `
      + `at least one citation_ids value between 1 and ${excerpts.length}, naming the excerpt it was `
      + 'derived from. If an expectation truly rests on no excerpt shown to you, drop that entry '
      + 'rather than returning it uncited.',
    );
    // Keep the retry only if it actually grounded something; otherwise the first answer stands.
    if (second.course && !everyEntryUncited(second.course, excerpts.length)) course = second.course;
  }

  const { uncited, total } = countUncitedEntries(course);
  return {
    ...base,
    expectedCourse: course,
    entryRefs: checkpointEntryRefs(input.checkpointId, course),
    status: 'ok',
    errorDetail: null,
    uncitedEntryCount: uncited,
    entryCount: total,
    retriedForCitations: retried,
  };
}

export { assertKnownBedrockModel };
