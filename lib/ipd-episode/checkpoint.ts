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
  everyEntryUncited, parseExpectedCourse, assessTopicality, retrievedTitles,
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

/** The similarity floor. `lib/retrieve.ts` defaults `minSimilarity` to 0.3 for the literature legs;
 *  it is passed EXPLICITLY so this engine's normative gate and retrieval's own floor are one
 *  number, and a change to either is visible at both. */
export const RETRIEVAL_MIN_SIMILARITY = 0.3;

/**
 * The generation settings, recorded on every checkpoint row so a variance investigation has the
 * settings in front of it rather than having to trust that they were what someone said.
 *
 * ⚠️ TEMPERATURE WAS ALREADY 0 ON BOTH CALLS, so item 3 does not explain the run-to-run variance
 * that produced VTE prophylaxis as an expectation in one run and an uncertainty note in the next.
 * Temperature 0 is not a determinism guarantee on these models; it removes sampling spread, not
 * every source of variation.
 *
 * ⚠️ AND A SEED CANNOT BE PASSED. The Bedrock Converse API's `inferenceConfig` accepts `maxTokens`
 * and `temperature` and nothing else — `lib/bedrock-core.ts`'s `toConverseInput` builds exactly
 * those two, and it is on the UNTOUCHED list. AUDIT_LLM_SEED reaches OpenRouter and Gemini callers;
 * there is no wire field to put it in here. `seed` is therefore recorded as NULL, honestly, rather
 * than stamped with a number that never left the process. The real mitigation for item 4's defect
 * is the prompt change, not a seed.
 */
export const CHECKPOINT_TEMPERATURE = 0;
export const CHECKPOINT_SEED: number | null = null;

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
  /** First 100 chars of each retrieved excerpt — a topical failure, readable without jsonb. */
  retrievedTitles: string[];
  /** A MAJORITY of excerpts shared no clinical term with the query. Recorded, never blocking. */
  retrievalOffTopic: boolean;
  /** How many of them, so the boolean can be checked rather than trusted. */
  offTopicExcerptCount: number;
  /** Normative chunks dropped for failing the similarity floor (item 5). */
  normativeDropped: number;
  /** The day 0 query was empty and fell back to an in-window OT surgery_name. */
  day0QueryFromOt: boolean;
  /** The generation settings this checkpoint actually ran with. */
  temperature: number;
  seed: number | null;
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
 * ⚠️ THE NORMATIVE LEG IS OFF, AND THIS IS THE FIX FOR THE FIXED ICMR INTERLEAVE. On IP-1286 the
 * same four ICMR antimicrobial chunks — three of them hospital-acquired-pneumonia sections — took
 * slots 2, 4, 6 and 8 of every single checkpoint on a clean elective hernia case: half the evidence
 * window, regardless of the clinical question, and the only chunks any finding ever cited.
 *
 * THE MECHANISM, read out of lib/retrieve.ts rather than guessed. The normative leg is a separate
 * SQL query (`normativeVectorSql`) that re-ranks the normative SUBSET with
 * `ROW_NUMBER() OVER (ORDER BY distance)` and returns its own top N. RRF then scores every leg's
 * rank identically as `1/(60 + rank)` — so the closest NORMATIVE chunk scores exactly what the
 * closest chunk overall scores, and the leg's ranks 2, 3, 4 tie with the main leg's 2, 3, 4. That
 * tie is the interleave. Being "the nearest of the four ICMR chunks" is a fact about a tiny subset,
 * not about the query, so with only a handful of normative chunks in the corpus the SAME four win
 * the SAME slots for every question ever asked.
 *
 * ⚠️ AND THE 0.3 GATE COULD NOT HAVE STOPPED IT. `normativeVectorSql` already applies
 * `1 - distance > minSim`, so those chunks clear 0.3 on their own; the round-5 gate was working and
 * the floor was simply never the binding constraint. A similarity floor cannot undo a rank tie.
 *
 * lib/retrieve.ts is UNTOUCHED, so the reservation cannot be removed where it is built. It is
 * removed by NOT USING THE LEG: with `useNormativeLeg` off, normative chunks compete in the
 * unrestricted main vector and BM25 legs on their true rank against the whole corpus. A normative
 * chunk now earns its slot on relevance or it does not appear — which is exactly the rule asked
 * for, and the corpus stays wide, so nothing has become uncitable.
 *
 * The round-5 similarity gate below is KEPT as a backstop: it costs nothing and still catches a
 * low-similarity normative chunk that wins a slot on BM25 alone.
 */
async function retrieveExcerpts(query: string): Promise<{
  excerpts: RetrievedExcerpt[]; ids: number[]; sources: Record<string, string>;
  normativeDropped: number; failed: boolean;
}> {
  if (!query.trim()) return { excerpts: [], ids: [], sources: {}, normativeDropped: 0, failed: false };
  try {
    const res = await retrieve(query, { topK: RETRIEVAL_TOP_K, minSimilarity: RETRIEVAL_MIN_SIMILARITY });
    // ⚠️ ONE FILTERED LIST, TWO VIEWS OF IT. `excerpts` is what the prompt numbers [1]…[k] and
    // `ids` is what those ordinals resolve to, so they MUST stay index-aligned. Filtering a hit
    // out of one list and not the other would silently shift every ordinal after it onto the wrong
    // passage — a citation that points at real text nobody was shown.
    // ── item 5: the normative leg is a CANDIDATE SOURCE, not a fixed block ──────────────────
    // The leg is unconditional by construction: it takes the top N normative chunks for the query
    // whether or not they are similar to it, and unions them into the slate. On a clean elective
    // hernia case that meant the same four ICMR AMR chunks — hospital-acquired pneumonia, pelvic
    // infections — in every single checkpoint, twelve of twenty-four excerpts on IP-1286.
    //
    // lib/retrieve.ts is on the UNTOUCHED list, so the leg cannot be gated where it is built. It is
    // gated HERE instead, on the same floor the literature legs use (`minSimilarity`, default 0.3,
    // passed explicitly above so the two cannot drift): a normative chunk that does not clear the
    // floor is dropped from the slate. Non-normative hits are left alone — they already passed the
    // floor inside retrieve().
    //
    // If this empties the normative contribution for a case, that IS the correct answer, and the
    // topicality numbers below will say so rather than a block of confident irrelevance hiding it.
    const normative = new Set(normativeSourcesForProvenance().map((x) => x.trim()).filter(Boolean));
    const raw = (res?.hits ?? []).filter((h) => Number.isFinite(Number(h.id)));
    let normativeDropped = 0;
    const gated = raw.filter((h) => {
      if (!normative.has(String(h.source ?? '').trim())) return true;
      const sim = Number(h.similarity);
      if (Number.isFinite(sim) && sim >= RETRIEVAL_MIN_SIMILARITY) return true;
      normativeDropped++;
      return false;
    });
    const hits = gated.slice(0, RETRIEVAL_TOP_K);
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
      normativeDropped,
      failed: false,
    };
  } catch {
    return { excerpts: [], ids: [], sources: {}, normativeDropped: 0, failed: true };
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
  const { query, day0FromOt } = buildRetrievalQuery(input.retrievalQueryInput);
  const { excerpts, ids, sources, normativeDropped, failed } = await retrieveExcerpts(query);
  const topicality = assessTopicality(query, excerpts);

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
    retrievedTitles: retrievedTitles(excerpts),
    retrievalOffTopic: topicality.offTopic,
    offTopicExcerptCount: topicality.offTopicCount,
    normativeDropped,
    day0QueryFromOt: day0FromOt,
    temperature: CHECKPOINT_TEMPERATURE,
    seed: CHECKPOINT_SEED,
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
          temperature: CHECKPOINT_TEMPERATURE,
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
