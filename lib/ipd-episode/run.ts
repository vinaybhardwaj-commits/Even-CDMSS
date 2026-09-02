/**
 * lib/ipd-episode/run.ts — the seven-stage pipeline for ONE episode (PRD §2).
 * select → assemble → checkpoints → diff (A1) → fidelity (A2) → comment (B) → persist.
 *
 * TWO PROPERTIES THIS FILE IS RESPONSIBLE FOR.
 *
 * 1. THE BLINDING. There is ONE assembled event list, and every model input below is a FILTER
 *    over it — `eventsBeforeDayStart` for each daily checkpoint, `episodeLevelEvents` for the
 *    episode one, `diffPassEvents` for A1, `fidelityPassEvents` for A2. Nothing here constructs a
 *    second list, and nothing here hands a pass a field its filter removed. The stored
 *    `input_cutoff_at` / `input_event_count` on each checkpoint row is the auditable proof, and
 *    §14 step 8 recomputes both from the stored course.
 *
 * 2. EVERY FAILURE DEGRADES TO A RECORDED NO-OP (§8). A db13 fault aborts this episode with no
 *    audit row and no skip row (it is a transport failure, not a fact about the episode). A
 *    missing summary, missing notes or missing extraction writes a SKIP with its reason. A failed
 *    A1 or A2 writes a skip. A failed B writes the audit row with `commentary = null`. No path
 *    returns a 500 and no path writes a value it did not derive.
 */

import { assertKnownBedrockModel } from '../bedrock-core';
import { startTrace, finishTraceIfRunning } from '../trace';
import {
  checkpointPlan, dayStartIso, diffPassEvents, episodeLevelEvents, eventsBeforeDayStart,
  fidelityPassEvents, isDischargeEvent, type EpisodeEvent,
} from './assemble-core';
import { assembleEpisode, type AssembledEpisode } from './assemble';
import { admissionContextLine, renderExpectedCourse, type CheckpointEntryRef } from './checkpoint-core';
import { checkpointModel, runCheckpoint, type CheckpointResult } from './checkpoint';
import { judgeModel, runCommentaryPass, runDiffPass, runFidelityPass } from './judge';
import { evidenceTiersOf, finalizeFindings, completenessPct, type EpisodeFinding } from './judge-core';
import { fetchProgressNotes, fetchDischargeSummary } from './db13';
import {
  IPD_EPISODE_ENGINE_VERSION, fetchExtractionByIpUid, recordSkip, clearSkip, saveEpisodeAudit,
  type CheckpointWriteRow,
} from './store';

export interface RunEpisodeInput {
  encounterId: string;
  /** From the selection query; used to date a skip row when the episode never assembles. */
  dischargedAtHint?: string | null;
  engineVersion?: string;
}

export interface RunEpisodeResult {
  encounterId: string;
  status?: 'inserted' | 'updated' | 'skipped';
  skip?: string;
  error?: string;
  divergenceIndex?: number;
  completenessPct?: number;
  nFindings?: number;
  checkpointCount?: number;
  traceId?: string;
  latencyMs: number;
  notes?: string[];
}

/**
 * The outcome line handed to pass B and to NOBODY else. It is built here, at the last stage, from
 * the discharge event — deliberately not carried through the pipeline in a variable that an
 * earlier pass could read.
 */
function outcomeLineFrom(events: EpisodeEvent[], losDays: number | null): string {
  const d = events.find(isDischargeEvent);
  if (!d) return 'The record carries no discharge event for this admission.';
  const type = (d.detail as Record<string, unknown>)?.discharge_type;
  return [
    `Discharged ${d.occurred_at ?? 'at a time the record does not give'}`,
    type ? `discharge type: ${String(type)}` : 'discharge type not recorded',
    losDays == null ? 'length of stay not computable' : `length of stay ${losDays} day(s)`,
  ].join(' · ');
}

/**
 * Audit one episode.
 *
 * Selection conditions 1–3 are re-checked HERE rather than trusted from the caller, because the
 * worker's candidate query and this function can be minutes apart and a skip must record what was
 * true when the episode was actually attempted.
 */
export async function runEpisodeAudit(input: RunEpisodeInput): Promise<RunEpisodeResult> {
  const t0 = Date.now();
  const encounterId = input.encounterId;
  const engineVersion = input.engineVersion ?? IPD_EPISODE_ENGINE_VERSION;

  // MODELS FIRST, BEFORE ANY WORK (§3.7). An unlisted id must cost nothing — not a db13 read, not
  // a retrieval, and certainly not three Opus calls that then land on a row nobody can attribute.
  const modelCheckpoint = checkpointModel(process.env);
  const modelJudge = judgeModel(process.env);
  try {
    assertKnownBedrockModel(modelCheckpoint);
    assertKnownBedrockModel(modelJudge);
  } catch (e) {
    return { encounterId, error: String((e as Error).message), latencyMs: Date.now() - t0 };
  }

  let traceId: string | undefined;
  try {
    // ── 1. select (conditions 1–3; condition 4 is the caller's silent skip) ──
    const [discharge, notes] = await Promise.all([
      fetchDischargeSummary(encounterId),
      fetchProgressNotes(encounterId, 1),
    ]);
    const dischargedAtHint = discharge?.discharge_date_time == null
      ? (input.dischargedAtHint ?? null)
      : String(discharge.discharge_date_time);

    if (!discharge) {
      await recordSkip({ encounterId, reason: 'no_discharge_summary', dischargedAt: dischargedAtHint, engineVersion });
      return { encounterId, skip: 'no_discharge_summary', latencyMs: Date.now() - t0 };
    }
    if (!notes.length) {
      await recordSkip({ encounterId, reason: 'no_notes', dischargedAt: dischargedAtHint, engineVersion });
      return { encounterId, skip: 'no_notes', latencyMs: Date.now() - t0 };
    }
    const extraction = await fetchExtractionByIpUid(encounterId);
    if (!extraction) {
      await recordSkip({ encounterId, reason: 'no_extraction', dischargedAt: dischargedAtHint, engineVersion });
      return { encounterId, skip: 'no_extraction', latencyMs: Date.now() - t0 };
    }

    traceId = await startTrace('ipd_episode_audit', { encounter_id: encounterId, engine_version: engineVersion });

    // ── 2. assemble: ONE list, built once ──
    const assembled: AssembledEpisode | null = await assembleEpisode({
      encounterId,
      extractedCase: extraction.extractedJson,
      extractionVersion: extraction.extractionVersion,
    });
    if (!assembled) {
      await finishTraceIfRunning(traceId, 'error', 'assembly produced no episode');
      return { encounterId, error: 'assembly produced no episode (no admission row, or no readable admission_date_time)', traceId, latencyMs: Date.now() - t0 };
    }
    const { envelope, events, sourcesPresent, notes: assemblyNotes } = assembled;
    const admissionContext = admissionContextLine({
      treatingDepartmentName: envelope.treatingDepartmentName,
      admissionType: envelope.admissionType,
      admitSource: envelope.admitSource,
      speciality: envelope.speciality,
      remarks: envelope.remarks,
    });

    // ── 3. checkpoints (Haiku, blinded) ──
    const plan = checkpointPlan(envelope.losDays);
    const admittedAt = envelope.admittedAt as string;
    const checkpoints: CheckpointResult[] = [];
    for (const entry of plan) {
      // THE FILTER IS THE BLINDING. Both branches return a subset of `events`; neither can
      // produce an event the other pass would not have had.
      const input_events = entry.checkpoint_type === 'episode'
        ? episodeLevelEvents(events)
        : eventsBeforeDayStart(events, admittedAt, entry.day_index);
      const cutoffAt = entry.checkpoint_type === 'episode'
        ? (input_events.filter((e) => e.occurred_at).slice(-1)[0]?.occurred_at ?? admittedAt)
        : dayStartIso(admittedAt, entry.day_index);

      checkpoints.push(await runCheckpoint({
        traceId,
        checkpointId: entry.checkpoint_id,
        checkpointType: entry.checkpoint_type,
        dayIndex: entry.day_index,
        cutoffAt,
        admissionContext,
        events: input_events,
        retrievalQueryInput: {
          treatingDepartmentName: envelope.treatingDepartmentName,
          admissionType: envelope.admissionType,
          admitSource: envelope.admitSource,
          remarks: envelope.remarks,
          eventsBeforeCutoff: input_events,
        },
        model: modelCheckpoint,
      }));
    }

    // Every checkpoint errored ⇒ there is no expected course to diff against (§8).
    if (checkpoints.length && checkpoints.every((c) => c.status === 'error')) {
      await recordSkip({ encounterId, reason: 'diff_failed', dischargedAt: envelope.dischargedAt, engineVersion });
      await finishTraceIfRunning(traceId, 'error', 'every checkpoint errored');
      return { encounterId, skip: 'diff_failed', error: 'every checkpoint errored', traceId, latencyMs: Date.now() - t0, notes: assemblyNotes };
    }

    const checkpointBlocks = checkpoints
      .filter((c) => c.expectedCourse)
      .map((c) => renderExpectedCourse(c.checkpointId, c.dayIndex, c.checkpointType, c.expectedCourse));
    const entryRefs = new Map<string, CheckpointEntryRef>();
    for (const c of checkpoints) for (const r of c.entryRefs) entryRefs.set(r.ref, r);
    const excerptCount = Math.max(0, ...checkpoints.map((c) => c.citationIds.length));

    // ── 4. diff (A1) — blind: the discharge event is filtered out ──
    const a1 = await runDiffPass({
      traceId, admissionContext, events: diffPassEvents(events), checkpointBlocks, excerptCount, model: modelJudge,
    });
    if (!a1.ok) {
      await recordSkip({ encounterId, reason: 'diff_failed', dischargedAt: envelope.dischargedAt, engineVersion });
      await finishTraceIfRunning(traceId, 'error', a1.error ?? 'diff pass failed');
      return { encounterId, skip: 'diff_failed', error: a1.error ?? 'diff pass failed', traceId, latencyMs: Date.now() - t0, notes: assemblyNotes };
    }

    // ── 5. fidelity (A2) — the only pass that reads the summary ──
    const a2 = await runFidelityPass({
      traceId, admissionContext, events: fidelityPassEvents(events),
      extractedCase: extraction.extractedJson, extractionVersion: extraction.extractionVersion, model: modelJudge,
    });
    if (!a2.ok) {
      await recordSkip({ encounterId, reason: 'fidelity_failed', dischargedAt: envelope.dischargedAt, engineVersion });
      await finishTraceIfRunning(traceId, 'error', a2.error ?? 'fidelity pass failed');
      return { encounterId, skip: 'fidelity_failed', error: a2.error ?? 'fidelity pass failed', traceId, latencyMs: Date.now() - t0, notes: assemblyNotes };
    }

    // ── code-enforced rules, then the score ──
    const raw: EpisodeFinding[] = [...a1.findings, ...a2.findings];
    const final = finalizeFindings(raw, entryRefs, events, a1.dropped + a2.dropped);

    // ── 6. comment (B) — outcome-aware, prose only, never fatal ──
    const b = await runCommentaryPass({
      traceId, admissionContext, events, findings: final.findings,
      outcomeLine: outcomeLineFrom(events, envelope.losDays),
      expectedCourses: checkpointBlocks, model: modelJudge,
    });

    // ── 7. persist ──
    const checkpointRows: CheckpointWriteRow[] = checkpoints.map((c) => ({
      dayIndex: c.dayIndex,
      checkpointType: c.checkpointType,
      inputCutoffAt: c.cutoffAt,
      inputEventCount: c.inputEventCount,
      retrievalQuery: c.retrievalQuery || null,
      retrievalFailed: c.retrievalFailed,
      citationIds: c.citationIds,
      expectedCourse: c.expectedCourse,
      status: c.status,
      errorDetail: c.errorDetail,
      model: c.model,
      traceId: traceId ?? null,
    }));

    const saved = await saveEpisodeAudit({
      engineVersion,
      encounterId,
      // Same value, two column names — see the store's header. Never transformed.
      ipUid: encounterId,
      memberId: envelope.memberId ?? extraction.memberId,
      facilityName: envelope.facilityName,
      speciality: envelope.speciality,
      admittedAt: envelope.admittedAt,
      dischargedAt: envelope.dischargedAt,
      losDays: envelope.losDays,
      dischargeType: envelope.dischargeType,
      extractionVersion: extraction.extractionVersion,
      divergenceIndex: final.divergence_index,
      completenessPct: completenessPct(sourcesPresent),
      counters: final.counters,
      checkpointCount: checkpoints.length,
      evidenceTiers: evidenceTiersOf(sourcesPresent),
      realCourse: events,
      findings: final.findings,
      commentary: b.commentary,
      modelCheckpoint,
      modelJudge,
      traceId: traceId ?? null,
    }, checkpointRows);

    if (saved.status !== 'skipped') await clearSkip(encounterId, engineVersion);
    await finishTraceIfRunning(traceId, saved.status === 'skipped' ? 'partial' : 'success');

    return {
      encounterId,
      status: saved.status,
      divergenceIndex: final.divergence_index,
      completenessPct: completenessPct(sourcesPresent),
      nFindings: final.counters.n_findings,
      checkpointCount: checkpoints.length,
      traceId,
      latencyMs: Date.now() - t0,
      notes: [
        ...assemblyNotes,
        ...(b.commentary ? [] : [`commentary was not stored: ${b.error ?? 'rejected'}`]),
        ...(final.n_tier_c_rewritten ? [`${final.n_tier_c_rewritten} finding(s) rewritten to unassessable by the Tier C rule`] : []),
        ...(final.n_uncited_capped ? [`${final.n_uncited_capped} finding(s) capped by the uncited-expectation rule`] : []),
      ],
    };
  } catch (e) {
    // A db13 or transport fault: abort this episode, write NO audit row and NO skip row (§8), and
    // let the next tick try again. A skip would record a fact about the episode that is not true.
    if (traceId) await finishTraceIfRunning(traceId, 'error', String((e as Error).message));
    return { encounterId, error: String((e as Error).message), traceId, latencyMs: Date.now() - t0 };
  }
}
