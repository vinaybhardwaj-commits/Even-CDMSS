/**
 * lib/patient-summary.ts — Patient Summary API (Pulse), WIRED half. 30 Jul 2026.
 *
 * Orchestrates the PRESERVED CCB mechanics into the namespaced package Pulse renders before an
 * encounter: episode assembly → grounded brief → ClinicalState → MemberStateSnapshot → provenance.
 * The pure contract (shape, degraded rules, disclaimer, job ids) lives in patient-summary-core.
 *
 * ⚠️ Everything this module calls is the RETIRED-but-LIVE CCB code. See the header on
 * lib/ccb-brief.ts before deleting anything that looks unused.
 *
 * PHI: identifiers ride the package's episode.keys for join-back only, exactly as CCB's
 * member_ref did — they never enter a model payload. Nothing new is persisted.
 */

import { assembleEpisode } from './ccb-fetch';
import { resolveBriefUid } from './ccb-resolve';
import { generateBrief } from './ccb-brief';
import { CCB_ENGINE_VERSION, type ExtractedReport } from './ccb-brief-core';
import { getMemberSnapshot } from './member-state/member-state';
import { deterministicExtract, type ExtractInput } from './clinical-state/extract';
import { sql } from './db';
import {
  assemblePackage, resolveServed, type PatientSummaryPackage, type ServedObservation,
} from './patient-summary-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface SummaryRequest {
  uid?: string; uhid?: string; individual_uid?: string; member_id?: string; date?: string;
}

/**
 * §2.4 — read what ACTUALLY served this trace, from llm_response / llm_stream_usage. NEVER from
 * llm_request, which records intent: that distinction is the whole reason register T-5 existed.
 * Ordered by seq so the LAST observation is the one that produced the final text.
 */
async function servedObservations(traceId: string | null): Promise<ServedObservation[]> {
  if (!traceId) return [];
  try {
    const rows = await run(
      `SELECT payload->>'provider' AS provider, payload->>'model' AS model
         FROM trace_events
        WHERE trace_id = $1 AND kind IN ('llm_response', 'llm_stream_usage')
        ORDER BY seq ASC`,
      [traceId],
    );
    return rows.map((r) => ({ provider: r.provider as string | null, model: r.model as string | null }));
  } catch {
    return [];   // unknown ⇒ resolveServed marks the package degraded, which is the honest answer
  }
}

/**
 * ClinicalState for the episode, built by the DETERMINISTIC extractor over the episode's own
 * fields. No LLM pass here: the stage-2 normalisation is flag-gated and additive everywhere else
 * in the system, and a pre-encounter summary must not pay a second inference for it. Fail-open —
 * a construction error yields null and the package reports itself degraded rather than lying.
 */
function buildEpisodeClinicalState(
  bundle: Awaited<ReturnType<typeof assembleEpisode>>,
  reports: ExtractedReport[],
): unknown | null {
  if (!bundle) return null;
  try {
    const p = bundle.prescription;
    // Every field name becomes provenance.sourceField, so they are named for what they ARE — a
    // physician reading the state can see which part of the record each finding came from.
    // The de-identified report content is included because it is the richest clinical text in the
    // episode: without it a rich episode yields almost nothing but `unknowns`.
    const input: ExtractInput = {
      surface: 'other',
      fields: {
        presentingComplaint: p.presentingComplaint || undefined,
        diagnoses: p.diagnoses.length ? p.diagnoses.join('; ') : undefined,
        planOfManagement: p.planOfManagement || undefined,
        investigations: p.investigations.length ? p.investigations.join('; ') : undefined,
        reportImpressions: reports.map((r) => r.impression || '').filter(Boolean).join('; ') || undefined,
        reportFindings: reports.flatMap((r) => r.keyFindings).filter(Boolean).join('; ') || undefined,
        reportAbnormalValues: reports.flatMap((r) => r.abnormalValues).filter(Boolean).join('; ') || undefined,
      },
    };
    return deterministicExtract(input);
  } catch {
    return null;
  }
}

export interface BuildResult { package: PatientSummaryPackage | null; error?: string }

/**
 * Build one Patient Summary package. Deliberately UNOPTIMISED (V1 measures first): no precompute,
 * no caching, no parallel speculation beyond what CCB already does.
 */
export async function buildPatientSummary(req: SummaryRequest): Promise<BuildResult> {
  const generatedAt = new Date().toISOString();

  // 1. Resolve to a prescription uid. Pulse calls with a UHID; CCB's own resolver already maps
  //    uhid / individual_uid / member_id (optionally scoped by date) → presc_uid.
  const { uid } = await resolveBriefUid({
    uid: req.uid, uhid: req.uhid, individualUid: req.individual_uid,
    memberId: req.member_id, date: req.date,
  }).catch(() => ({ uid: null, candidates: [] as string[] }));
  if (!uid) return { package: null, error: 'no episode found for the supplied identifier' };

  // 2. Episode.
  const bundle = await assembleEpisode(uid).catch(() => null);
  if (!bundle) return { package: null, error: 'prescription not found' };

  // 3. Grounded brief (the preserved CCB engine). ExtractedReport[] rides the additive sink —
  //    the CcbEnvelope does not carry it.
  let extractedReports: ExtractedReport[] = [];
  const envelope = await generateBrief(bundle, { onExtracted: (r) => { extractedReports = r; } });

  // 4. The two state objects. Both fail-open; a null is reported as degraded, never as "clean".
  const clinicalState = buildEpisodeClinicalState(bundle, extractedReports);
  const memberState = await getMemberSnapshot(bundle.keys.individualUid, generatedAt).catch(() => null);

  // 5. §2.4 — provenance from the brief's own trace.
  const served = resolveServed(await servedObservations(envelope.trace_id), {
    partial: clinicalState == null || memberState == null,
  });

  return {
    package: assemblePackage({
      traceId: envelope.trace_id,
      engineVersion: CCB_ENGINE_VERSION,
      generatedAt,
      served,
      clinicalFindings: envelope.clinical,
      lowValueFlags: envelope.low_value_flags,
      groundingSummary: envelope.grounding_summary,
      retrievalManifest: envelope.retrieval,
      extractedReports,
      sources: envelope.sources,
      clinicalState,
      memberState: memberState as unknown as { asOf?: string; followUps?: unknown[] } | null,
      episode: {
        keys: bundle.keys, prescription: bundle.prescription,
        orders: bundle.orders, reports: bundle.reports, coverage: bundle.coverage,
      },
      // PROM requests: Phase 2 ships the field, empty. The PROM scheduler is member- and
      // programme-scoped (lib/proms/schedule.ts) and wiring it is a separate decision, not an
      // unstated one — the namespace exists so adding them later is additive for Pulse.
      promRequests: [],
      commercial: envelope.commercial,
    }),
  };
}

// ── job store ─────────────────────────────────────────────────────────────────────────────────
//
// Deliberately NOT a queue (kickoff §2.1). One row per job in the existing app_settings key/value
// store — the same mechanism the lab batch and quieting config already use. Jobs are small, and
// this keeps the 202/poll contract working with no migration.

const JOB_PREFIX = 'psum_job:';

export async function putJob(job: { job_id: string } & Record<string, unknown>): Promise<void> {
  try {
    await run(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JOB_PREFIX + job.job_id, JSON.stringify(job)],
    );
  } catch { /* a job-store failure must not throw into the request path */ }
}

export async function getJob(jobId: string): Promise<Record<string, unknown> | null> {
  try {
    const rows = await run(`SELECT value FROM app_settings WHERE key = $1`, [JOB_PREFIX + jobId]);
    const v = rows[0]?.value;
    if (v == null) return null;
    return typeof v === 'string' ? JSON.parse(v) : (v as Record<string, unknown>);
  } catch {
    return null;
  }
}
