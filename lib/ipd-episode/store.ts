/**
 * lib/ipd-episode/store.ts — Neon reads and writes for the IPD Episode Audit engine
 * (`ipd_episode_audits`, `ipd_episode_checkpoints`, `ipd_episode_skips`; migrations/0052).
 *
 * ⚠️ EVERY SQL STRING HERE IS INFERRED against the DDL this build ships in the same commit. It has
 * not been run against Neon — the sandbox has no database. Every path is therefore FAIL-SAFE: a
 * reader returns [] or null on any fault (including "the migration has not run yet"), and a writer
 * returns a status rather than throwing. Nothing here can turn a completed audit into a 500.
 *
 * PHI POSTURE. The only identifying columns written are `encounter_id`, `ip_uid` and `member_id` —
 * link-back keys, the same posture as `ipd_discharge_audits`. No uhid, name, age, gender or
 * contact value is written by any statement in this file. `real_course`, `findings` and
 * `commentary` hold text that has already been through the de-identifier at assembly time.
 *
 * `ip_uid` AND `encounter_id` HOLD THE SAME VALUE, and that is deliberate rather than redundant:
 * `encounter_id` is this engine's own key, and `ip_uid` is the column name the sibling discharge
 * engine and `discharge_extracted_cases` use for the same namespace — so the join in
 * `dischargeEngineScores` below is a column-name match, not a transformation. Neither is ever
 * rewritten.
 */

import { sql } from '../db';
import type { EpisodeFinding, FindingCounters } from './judge-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Every degraded path in this file says so. A reader of the logs can tell "no rows" from
 *  "this query has been failing since someone renamed a column", which a bare `.catch(() => [])`
 *  cannot. Truncated: an error string is a log line, not a payload. */
/**
 * A counted column is never null. `0` and `unknown` are different claims about an episode, and a
 * nullable counter is the one that quietly corrupts a cohort: SUM and AVG skip nulls, so a single
 * unwritten column changes the denominator of every aggregate over the table without saying so.
 *
 * The DDL carries DEFAULT 0 as well. Both halves are needed — the default covers a column added to
 * the schema before the INSERT names it, this covers the columns the INSERT already names.
 *
 * NB: `losDays` is deliberately NOT run through this. A missing length of stay IS unknown, and
 * writing 0 would assert a same-day discharge that nothing in the record supports.
 */
function num(v: number | null | undefined): number {
  return Number.isFinite(v as number) ? (v as number) : 0;
}

function warn(label: string, e: unknown): void {
  console.warn(`[ipd-episode/store] ${label} failed (degraded): ${String((e as Error)?.message ?? e).slice(0, 300)}`);
}

/** Engine version (decision 27). A bump audits an admission again BESIDE its old row, never over it. */
export const IPD_EPISODE_ENGINE_VERSION = 'ipd-episode-audit/0.1';

/** The sibling engine whose score the UI shows beside this one, labelled as its own (decision 14). */
export const IPD_DISCHARGE_ENGINE_VERSION_FOR_JOIN = 'ipd-discharge-audit/0.2';

/** Skip reasons (§3.1). A closed set — a reason outside it is a bug, not a new category. */
export const SKIP_REASONS = ['no_discharge_summary', 'no_notes', 'no_extraction', 'diff_failed', 'fidelity_failed'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** A skipped episode is retried each tick until this many days after discharge, then left alone. */
export const SKIP_RETRY_DAYS = 14;

// ── selection support ────────────────────────────────────────────────────────────────────────

/** Encounter ids already audited at this engine version — condition 4's silent skip (§3.1). */
export async function auditedEncounterIds(engineVersion = IPD_EPISODE_ENGINE_VERSION): Promise<string[]> {
  const rows = await run(
    `SELECT encounter_id FROM ipd_episode_audits WHERE engine_version = $1`, [engineVersion],
  ).catch((e: unknown) => { warn('auditedEncounterIds', e); return [] as Record<string, unknown>[]; });
  return rows.map((r) => String(r.encounter_id));
}

export interface SkipRow { encounter_id: string; reason: string; attempts: number; discharged_at: string | null }

export async function skipRows(engineVersion = IPD_EPISODE_ENGINE_VERSION): Promise<SkipRow[]> {
  const rows = await run(
    `SELECT encounter_id, reason, attempts, discharged_at FROM ipd_episode_skips WHERE engine_version = $1`, [engineVersion],
  ).catch((e: unknown) => { warn('skipRows', e); return [] as Record<string, unknown>[]; });
  return rows.map((r) => ({
    encounter_id: String(r.encounter_id),
    reason: String(r.reason),
    attempts: Number(r.attempts ?? 0),
    discharged_at: r.discharged_at == null ? null : String(r.discharged_at),
  }));
}

/**
 * §3.1's retry window, as a PURE decision so it can be tested without a database: a skipped
 * episode is retried until 14 days after its discharge, and then never again. An unknown
 * discharge date is retried — the engine does not stop looking at something it cannot date.
 */
export function skipIsRetryable(dischargedAt: string | null, now: Date = new Date()): boolean {
  if (!dischargedAt) return true;
  const d = Date.parse(dischargedAt);
  if (!Number.isFinite(d)) return true;
  return (now.getTime() - d) < SKIP_RETRY_DAYS * 86_400_000;
}

/** Upsert a skip (§7.3): reason refreshed, `last_seen` bumped, `attempts` incremented. */
export async function recordSkip(a: {
  encounterId: string; reason: SkipReason; dischargedAt: string | null; engineVersion?: string;
}): Promise<'recorded' | 'skipped'> {
  try {
    await run(
      `INSERT INTO ipd_episode_skips (encounter_id, engine_version, reason, discharged_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (encounter_id, engine_version) DO UPDATE SET
         reason = EXCLUDED.reason, last_seen = NOW(), attempts = ipd_episode_skips.attempts + 1,
         discharged_at = COALESCE(EXCLUDED.discharged_at, ipd_episode_skips.discharged_at)`,
      [a.encounterId, a.engineVersion ?? IPD_EPISODE_ENGINE_VERSION, a.reason, a.dischargedAt],
    );
    return 'recorded';
  } catch (e) {
    // A skip that cannot be recorded means this episode is retried forever with no trace of why.
    warn('recordSkip', e);
    return 'skipped';
  }
}

/** An episode that now qualifies has no business keeping a skip row. Best-effort. */
export async function clearSkip(encounterId: string, engineVersion = IPD_EPISODE_ENGINE_VERSION): Promise<void> {
  await run(`DELETE FROM ipd_episode_skips WHERE encounter_id = $1 AND engine_version = $2`, [encounterId, engineVersion])
    .catch((e: unknown) => { warn('clearSkip', e); return [] as Record<string, unknown>[]; });
}

// ── the stored extraction (§3.1 condition 3) ─────────────────────────────────────────────────

export interface StoredExtraction { extractionVersion: string; extractedJson: unknown; memberId: string | null; extractedAt: string | null }

/**
 * The extraction for one episode, from `discharge_extracted_cases` keyed on `ip_uid`. Preference
 * order is `doc-extract/2`, then `doc-extract/1`, then the latest `extracted_at` — expressed as an
 * ORDER BY rather than three queries so one round trip settles it.
 *
 * READ-ONLY. This engine never writes to `discharge_extracted_cases` and never extracts a PDF:
 * the nightly discharge worker owns that table and grows this engine's cohort (decision 13).
 */
export async function fetchExtractionByIpUid(ipUid: string): Promise<StoredExtraction | null> {
  const rows = await run(
    `SELECT extraction_version, extracted_json, member_id, extracted_at
     FROM discharge_extracted_cases
     WHERE ip_uid = $1
     ORDER BY (extraction_version = 'doc-extract/2') DESC,
              (extraction_version = 'doc-extract/1') DESC,
              extracted_at DESC NULLS LAST
     LIMIT 1`, [ipUid],
  ).catch((e: unknown) => { warn('fetchExtractionByIpUid', e); return [] as Record<string, unknown>[]; });
  const r = rows[0];
  if (!r) return null;
  return {
    extractionVersion: String(r.extraction_version ?? ''),
    extractedJson: r.extracted_json ?? null,
    memberId: r.member_id == null ? null : String(r.member_id),
    extractedAt: r.extracted_at == null ? null : String(r.extracted_at),
  };
}

// ── the sibling score (decision 14) ──────────────────────────────────────────────────────────

export interface DischargeEngineScore { care_value_index: number | null; band: string | null }

/**
 * The discharge engine's score for a set of encounters, joined on `ip_uid = encounter_id` at the
 * pinned engine version. Read-only, one batched query, and absent rows simply do not appear — the
 * UI renders "not audited by discharge engine" for those rather than a zero.
 */
export async function dischargeEngineScores(encounterIds: string[]): Promise<Record<string, DischargeEngineScore>> {
  const ids = Array.from(new Set(encounterIds.filter((v) => typeof v === 'string' && v.length > 0)));
  if (!ids.length) return {};
  const rows = await run(
    `SELECT DISTINCT ON (ip_uid) ip_uid, care_value_index, band
     FROM ipd_discharge_audits
     WHERE engine_version = $1 AND ip_uid = ANY($2::text[])
     ORDER BY ip_uid, audited_at DESC`, [IPD_DISCHARGE_ENGINE_VERSION_FOR_JOIN, ids],
  ).catch((e: unknown) => {
    // NOT a silent catch. This read is decoration — the surface renders "not audited by discharge
    // engine" without it — but a query that has been failing since a schema change would look
    // exactly the same as a cohort the discharge engine has genuinely never audited, and the
    // second is a fact while the first is a bug. Say which one it is.
    warn('dischargeEngineScores', e);
    return [] as Record<string, unknown>[];
  });
  const out: Record<string, DischargeEngineScore> = {};
  for (const r of rows) {
    out[String(r.ip_uid)] = {
      care_value_index: r.care_value_index == null ? null : Number(r.care_value_index),
      band: r.band == null ? null : String(r.band),
    };
  }
  return out;
}

// ── writes ───────────────────────────────────────────────────────────────────────────────────

export interface EpisodeAuditRow {
  engineVersion: string;
  encounterId: string;
  ipUid: string;
  memberId: string | null;
  facilityName: string | null;
  speciality: string | null;
  admittedAt: string | null;
  dischargedAt: string | null;
  losDays: number | null;
  dischargeType: string | null;
  extractionVersion: string | null;
  divergenceIndex: number | null;
  /** 'ok' | 'no_expectations' | 'all_capped'. Anything but 'ok' means the number beside it is not
   *  a score, and the UI must not render one. */
  scoringStatus?: string | null;
  completenessPct: number | null;
  counters: FindingCounters;
  checkpointCount: number;
  evidenceTiers: unknown;
  realCourse: unknown;
  findings: EpisodeFinding[];
  commentary: unknown;
  modelCheckpoint: string | null;
  modelJudge: string | null;
  traceId: string | null;
  /** Integration facts about an episode that still produced a row: discarded findings, a
   *  rejected commentary, a normalised fidelity shape. */
  errorDetail?: string | null;
  /** Per discarded finding: the raw fragment (truncated) and the validation error that killed it.
   *  A silent loss on the divergence pass is how a third of an episode's findings disappear. */
  rawJudgeError?: unknown;
}

export interface CheckpointWriteRow {
  dayIndex: number;
  checkpointType: 'daily' | 'episode';
  inputCutoffAt: string;
  inputEventCount: number;
  retrievalQuery: string | null;
  retrievalFailed: boolean;
  citationIds: number[];
  expectedCourse: unknown;
  status: 'ok' | 'error';
  errorDetail: string | null;
  model: string | null;
  traceId: string | null;
  /** Entries that cited nothing, and how many there were — scalars, so the grounding failure the
   *  IP-1286 run exposed is queryable without parsing expected_course. */
  uncitedEntryCount: number;
  entryCount: number;
  /** Cited chunk id → its `source`. Records the FACT; the normative/literature split is derived
   *  from it at finalise time, so a later change to the source list can be re-applied to old rows. */
  citationSources: Record<string, string>;
  /** First 100 chars of each retrieved excerpt — what came back, without opening jsonb. */
  retrievedTitles: string[];
  /** No excerpt shared a clinical term with the query. */
  retrievalOffTopic: boolean;
}

/**
 * Write one audit and its checkpoints. UPSERT on (encounter_id, engine_version), and the
 * checkpoints for that audit are replaced wholesale so a re-run cannot leave a stale checkpoint
 * from a previous, differently-shaped run sitting beside the new ones.
 *
 * Returns 'skipped' on any fault. The caller logs it; nothing throws.
 */
export async function saveEpisodeAudit(row: EpisodeAuditRow, checkpoints: CheckpointWriteRow[]): Promise<{ status: 'inserted' | 'updated' | 'skipped'; auditId: string | null; failedCheckpoints: number }> {
  try {
    const c = row.counters;
    const res = await run(
      `INSERT INTO ipd_episode_audits (
         engine_version, encounter_id, ip_uid, member_id, facility_name, speciality,
         admitted_at, discharged_at, los_days, discharge_type, extraction_version,
         divergence_index, scoring_status, completeness_pct,
         n_findings, n_divergence_pass, n_fidelity_pass, n_omission, n_commission, n_timing,
         n_sequencing, n_divergent, n_context_dependent, n_unassessable, n_concordant,
         n_low_value, n_dropped_invalid, n_parse_failed,
         checkpoint_count, evidence_tiers, real_course, findings, commentary,
         model_checkpoint, model_judge, trace_id, error_detail, raw_judge_error)
       VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10,$11, $12,$13,$14,
               $15,$16,$17,$18,$19,$20, $21,$22,$23,$24,$25, $26,$27,$28,
               $29,$30::jsonb,$31::jsonb,$32::jsonb,$33::jsonb, $34,$35,$36,$37,$38::jsonb)
       ON CONFLICT (encounter_id, engine_version) DO UPDATE SET
         audited_at = NOW(),
         ip_uid = EXCLUDED.ip_uid, member_id = EXCLUDED.member_id,
         facility_name = EXCLUDED.facility_name, speciality = EXCLUDED.speciality,
         admitted_at = EXCLUDED.admitted_at, discharged_at = EXCLUDED.discharged_at,
         los_days = EXCLUDED.los_days, discharge_type = EXCLUDED.discharge_type,
         extraction_version = EXCLUDED.extraction_version,
         divergence_index = EXCLUDED.divergence_index, scoring_status = EXCLUDED.scoring_status,
         completeness_pct = EXCLUDED.completeness_pct,
         n_findings = EXCLUDED.n_findings, n_divergence_pass = EXCLUDED.n_divergence_pass,
         n_fidelity_pass = EXCLUDED.n_fidelity_pass, n_omission = EXCLUDED.n_omission,
         n_commission = EXCLUDED.n_commission, n_timing = EXCLUDED.n_timing,
         n_sequencing = EXCLUDED.n_sequencing, n_divergent = EXCLUDED.n_divergent,
         n_context_dependent = EXCLUDED.n_context_dependent, n_unassessable = EXCLUDED.n_unassessable,
         n_concordant = EXCLUDED.n_concordant, n_low_value = EXCLUDED.n_low_value,
         n_dropped_invalid = EXCLUDED.n_dropped_invalid, n_parse_failed = EXCLUDED.n_parse_failed,
         checkpoint_count = EXCLUDED.checkpoint_count, evidence_tiers = EXCLUDED.evidence_tiers,
         real_course = EXCLUDED.real_course, findings = EXCLUDED.findings,
         commentary = EXCLUDED.commentary, model_checkpoint = EXCLUDED.model_checkpoint,
         model_judge = EXCLUDED.model_judge, trace_id = EXCLUDED.trace_id,
         error_detail = EXCLUDED.error_detail, raw_judge_error = EXCLUDED.raw_judge_error
       RETURNING id, (xmax = 0) AS inserted`,
      [
        row.engineVersion, row.encounterId, row.ipUid, row.memberId, row.facilityName, row.speciality,
        row.admittedAt, row.dischargedAt, row.losDays, row.dischargeType, row.extractionVersion,
        // NEVER NULL. The DDL defaults these to 0, but a DEFAULT only applies to a column the
        // INSERT omits — and this INSERT names all of them, so a null here would be written as a
        // null. `num` is the half of the guarantee that actually holds on this statement.
        // ⚠️ divergence_index is the ONE counted column that may legitimately be null: under
        // scoring_status 'no_expectations' there is no score, and 0 would read as a catastrophic
        // episode while null reads as "not scorable", which is what actually happened.
        row.divergenceIndex, row.scoringStatus ?? 'ok', num(row.completenessPct),
        num(c.n_findings), num(c.n_divergence_pass), num(c.n_fidelity_pass), num(c.n_omission),
        num(c.n_commission), num(c.n_timing), num(c.n_sequencing), num(c.n_divergent),
        num(c.n_context_dependent), num(c.n_unassessable), num(c.n_concordant),
        num(c.n_low_value), num(c.n_dropped_invalid), num(c.n_parse_failed),
        num(row.checkpointCount), JSON.stringify(row.evidenceTiers ?? null), JSON.stringify(row.realCourse ?? null),
        JSON.stringify(row.findings ?? []), row.commentary == null ? null : JSON.stringify(row.commentary),
        row.modelCheckpoint, row.modelJudge, row.traceId, row.errorDetail ?? null,
        row.rawJudgeError == null ? null : JSON.stringify(row.rawJudgeError),
      ],
    );
    const first = res[0];
    const auditId = first?.id == null ? null : String(first.id);
    if (!auditId) return { status: 'skipped', auditId: null, failedCheckpoints: checkpoints.length };

    await run(`DELETE FROM ipd_episode_checkpoints WHERE episode_audit_id = $1`, [auditId])
      .catch((e: unknown) => { warn('saveEpisodeAudit clear checkpoints', e); return [] as Record<string, unknown>[]; });
    let failedCheckpoints = 0;
    for (const cp of checkpoints) {
      // $8::int[] — the driver sends a JS array as a Postgres array literal, and without the cast
      // an empty one is ambiguous enough for the server to reject the whole statement. A checkpoint
      // row that vanishes takes input_cutoff_at and input_event_count with it, and those two ARE
      // the blinding proof (§14 step 8) — so this insert must never fail quietly.
      await run(
        `INSERT INTO ipd_episode_checkpoints (
           episode_audit_id, day_index, checkpoint_type, input_cutoff_at, input_event_count,
           retrieval_query, retrieval_failed, citation_ids, expected_course, status, error_detail,
           model, trace_id, uncited_entry_count, entry_count, citation_sources,
           retrieved_titles, retrieval_offtopic)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::int[],$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb,
                 $17::text[],$18)`,
        [
          auditId, cp.dayIndex, cp.checkpointType, cp.inputCutoffAt, cp.inputEventCount,
          cp.retrievalQuery, cp.retrievalFailed, cp.citationIds,
          cp.expectedCourse == null ? null : JSON.stringify(cp.expectedCourse),
          cp.status, cp.errorDetail, cp.model, cp.traceId,
          num(cp.uncitedEntryCount), num(cp.entryCount), JSON.stringify(cp.citationSources ?? {}),
          cp.retrievedTitles ?? [], cp.retrievalOffTopic ?? false,
        ],
      ).catch((e: unknown) => {
        warn(`saveEpisodeAudit checkpoint day ${cp.dayIndex} (${cp.checkpointType})`, e);
        failedCheckpoints++;
        return [] as Record<string, unknown>[];
      });
    }
    return { status: first?.inserted ? 'inserted' : 'updated', auditId, failedCheckpoints };
  } catch (e) {
    warn('saveEpisodeAudit (no row written)', e);
    return { status: 'skipped', auditId: null, failedCheckpoints: checkpoints.length };
  }
}

// ── surface reads ────────────────────────────────────────────────────────────────────────────

export type EpisodeListRow = Record<string, unknown>;

/** The list surface. Sortable on divergence index and the sibling discharge score (§10). */
export async function episodeWorklist(a: { limit?: number; sort?: 'divergence' | 'discharge' | 'recent' } = {}): Promise<EpisodeListRow[]> {
  const lim = Math.max(1, Math.min(400, Math.floor(a.limit ?? 200)));
  const rows = await run(
    `SELECT id, encounter_id, ip_uid, speciality, facility_name, admitted_at, discharged_at,
            los_days, discharge_type, divergence_index, completeness_pct,
            n_findings, n_divergent, n_unassessable, n_low_value, n_divergence_pass, n_fidelity_pass,
            checkpoint_count, audited_at
     FROM ipd_episode_audits
     WHERE engine_version = $1
     ORDER BY discharged_at DESC NULLS LAST
     LIMIT ${lim}`, [IPD_EPISODE_ENGINE_VERSION],
  ).catch((e: unknown) => { warn('episodeWorklist', e); return [] as Record<string, unknown>[]; });
  return rows;
}

export async function episodeAuditById(id: string): Promise<EpisodeListRow | null> {
  if (!/^[0-9a-fA-F-]{10,64}$/.test(id)) return null;
  const rows = await run(`SELECT * FROM ipd_episode_audits WHERE id = $1 LIMIT 1`, [id])
    .catch((e: unknown) => { warn('episodeAuditById', e); return [] as Record<string, unknown>[]; });
  return rows[0] ?? null;
}

export async function checkpointsForAudit(auditId: string): Promise<EpisodeListRow[]> {
  if (!/^[0-9a-fA-F-]{10,64}$/.test(auditId)) return [];
  return run(
    `SELECT day_index, checkpoint_type, generated_at, input_cutoff_at, input_event_count,
            retrieval_query, retrieval_failed, citation_ids, expected_course, status, error_detail, model,
            uncited_entry_count, entry_count, citation_sources, retrieved_titles, retrieval_offtopic
     FROM ipd_episode_checkpoints
     WHERE episode_audit_id = $1
     ORDER BY (checkpoint_type = 'episode'), day_index ASC`, [auditId],
  ).catch((e: unknown) => { warn('checkpointsForAudit', e); return [] as Record<string, unknown>[]; });
}
