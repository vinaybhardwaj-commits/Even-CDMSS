/**
 * lib/opd-audit-store.ts — persist + read OPD note-quality audits (Neon `opd_note_audits`).
 *
 * Maps the in-memory OpdNoteAudit → one de-identified, uid-keyed row. Idempotent insert
 * (ON CONFLICT (uid, engine_version) DO NOTHING), so the worker re-runs safely — the audit
 * table itself is the worker's watermark.
 */

import { sql } from './db';
import type { OpdNoteAudit } from './opd-note-audit';
import type { OpdDomain } from './opd-note-score-core';
import { logEvent } from './trace';
import { auditShadowReport } from './clinical-state/audit-shadow-core';
import { runLongitudinalPass } from './opd-longitudinal';   // Stage 3 — dark unless OPD_LONGITUDINAL_ENABLED=1

function domainScore(audit: OpdNoteAudit, key: OpdDomain): number | null {
  const d = audit.scorecard.domains.find((x) => x.domain === key);
  return d ? Math.round(d.score) : null;
}

export interface SaveOpdAuditMeta { model?: string | null; latencyMs?: number | null }

/**
 * ClinicalState shadow (Platform B1) — DORMANT by default. Flag-gated, read-only w.r.t. the
 * audit, fail-open. When CLINICAL_STATE_AUDIT_SHADOW=1, round-trips the persisted findings
 * through the canonical model and traces the fidelity; when off (default) it is zero work and
 * the persisted audit output is byte-identical. Modelled on the DDx 1a in-pipeline pattern.
 * auditShadowReport never mutates `findings` (works on a JSON clone), so this can never affect
 * what was written above. Called AFTER the INSERT so it is provably out of the persist path.
 */
async function runAuditShadow(audit: OpdNoteAudit, findings: OpdNoteAudit['findings']): Promise<void> {
  if (process.env.CLINICAL_STATE_AUDIT_SHADOW !== '1' || !audit.traceId) return;
  try {
    await logEvent(audit.traceId, 'clinical_state_audit_shadow', 'expanding', auditShadowReport(findings ?? []));
  } catch (e) {
    try { await logEvent(audit.traceId, 'clinical_state_audit_shadow', 'expanding', { ok: false, error: String((e as Error)?.message ?? e) }); } catch { /* fail-open */ }
  }
}

// Quieting choreography tolerance: the code deploys BEFORE the migration adds
// opd_note_audits.quieting_gen, so the writers probe for the column (cached) and only include it
// once it exists. Fail-safe: probe error ⇒ treat as absent (the stamp is dropped, never the audit).
let _qgenCol: { at: number; present: boolean } | null = null;
async function quietingGenColumnExists(): Promise<boolean> {
  const now = Date.now();
  if (_qgenCol && now - _qgenCol.at < 300_000 && _qgenCol.present) return true;
  if (_qgenCol && now - _qgenCol.at < 60_000) return _qgenCol.present;   // re-probe absent faster post-migration
  try {
    const rows = (await sql(
      `SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'opd_note_audits' AND column_name = 'quieting_gen'`,
    )) as Array<{ ok: number }>;
    _qgenCol = { at: now, present: rows.length > 0 };
  } catch { _qgenCol = { at: now, present: false }; }
  return _qgenCol.present;
}

/** Insert one audit. Returns 'inserted' | 'exists' (already audited at this engine version) | 'skipped' (no uid). */
export async function saveOpdAudit(audit: OpdNoteAudit, meta: SaveOpdAuditMeta = {}): Promise<'inserted' | 'exists' | 'skipped'> {
  const k = audit.keys;
  if (!k.uid) return 'skipped';
  const sc = audit.scorecard;
  const findings = audit.findings || [];
  const nLow = findings.filter((f) => f.verdict === 'low-value').length;
  const nCtx = findings.filter((f) => f.verdict === 'context-dependent').length;
  const nInteraction = findings.filter((f) => /interaction|contraindicat|\bddi\b/i.test(`${f.subject} ${f.rationale}`)).length;
  const missing = audit.completeness?.missing ?? [];
  const withGen = await quietingGenColumnExists();

  const rows = (await sql(
    `INSERT INTO opd_note_audits
      (uid, consult_uid, doctor_uid, kx_encounter_id, note_date, prescription_type, consult_type,
       note_quality_index, band,
       score_documentation, score_note_quality, score_appropriateness, score_prescribing_safety, score_patient_centred,
       pdqi9, completeness_pct, n_missing_mandatory,
       n_findings, n_low_value, n_context_dependent, n_interaction_alerts,
       findings, suggestions, engine_version, model, trace_id, latency_ms, missing_fields, sources,
       complexity_band, complexity_inputs${withGen ? ', quieting_gen' : ''})
     VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9, $10,$11,$12,$13,$14,
       $15::jsonb,$16,$17, $18,$19,$20,$21, $22::jsonb,$23::jsonb,$24,$25,$26,$27, $28::jsonb, $29::jsonb,
       $30, $31::jsonb${withGen ? ', $32' : ''})
     ON CONFLICT (uid, engine_version) DO NOTHING
     RETURNING id`,
    [
      k.uid, k.consultUid, k.doctorUid, k.kxEncounterId, k.noteDate, k.prescriptionType, k.consultType,
      sc.headline, sc.band,
      domainScore(audit, 'documentation'), domainScore(audit, 'note_quality'), domainScore(audit, 'appropriateness'),
      domainScore(audit, 'prescribing_safety'), domainScore(audit, 'patient_centred'),
      JSON.stringify(sc.pdqi9 ?? []), Math.round((audit.completeness?.coverage ?? 0) * 100), missing.length,
      findings.length, nLow, nCtx, nInteraction,
      JSON.stringify(findings), JSON.stringify(audit.suggestions ?? []),
      audit.engineVersion, meta.model ?? null, audit.traceId ?? null, meta.latencyMs ?? null,
      JSON.stringify(missing), JSON.stringify(audit.sources ?? []),
      audit.complexity?.band ?? null, audit.complexity?.inputs ? JSON.stringify(audit.complexity.inputs) : null,
      ...(withGen ? [audit.quietingGen ?? 0] : []),
    ],
  )) as Array<{ id: string }>;
  await runAuditShadow(audit, findings); // B1 shadow — dormant unless CLINICAL_STATE_AUDIT_SHADOW=1; read-only, fail-open
  // Stage 3 longitudinal pass (opd-longitudinal/0.1) — AFTER the INSERT, flag-gated + fail-open, so it can
  // never affect the base row. Only for a fresh insert (idempotent worker re-runs never re-charge it; the
  // replay endpoint recomputes on demand). Dark unless OPD_LONGITUDINAL_ENABLED=1.
  if (rows.length) await runLongitudinalPass(audit).catch(() => { /* fail-open — base audit already persisted */ });
  return rows.length ? 'inserted' : 'exists';
}

/** UPDATE an existing audit row in place (deterministic backfill — same engine version). Rewrites
 *  the completeness/findings/score columns from a recomputed audit; leaves model/trace/sources as-is. */
export async function updateOpdAudit(audit: OpdNoteAudit): Promise<'updated' | 'skipped'> {
  const k = audit.keys;
  if (!k.uid) return 'skipped';
  const sc = audit.scorecard;
  const findings = audit.findings || [];
  const nLow = findings.filter((f) => f.verdict === 'low-value').length;
  const nCtx = findings.filter((f) => f.verdict === 'context-dependent').length;
  const nInteraction = findings.filter((f) => /interaction|contraindicat|\bddi\b/i.test(`${f.subject} ${f.rationale}`)).length;
  const missing = audit.completeness?.missing ?? [];
  const withGen = await quietingGenColumnExists();

  const rows = (await sql(
    `UPDATE opd_note_audits SET
       note_quality_index = $2, band = $3,
       score_documentation = $4, score_note_quality = $5, score_appropriateness = $6,
       score_prescribing_safety = $7, score_patient_centred = $8,
       pdqi9 = $9::jsonb, completeness_pct = $10, n_missing_mandatory = $11,
       n_findings = $12, n_low_value = $13, n_context_dependent = $14, n_interaction_alerts = $15,
       findings = $16::jsonb, suggestions = $17::jsonb, missing_fields = $18::jsonb${withGen ? ', quieting_gen = $20' : ''}
     WHERE uid = $1 AND engine_version = $19
     RETURNING id`,
    [
      k.uid, sc.headline, sc.band,
      domainScore(audit, 'documentation'), domainScore(audit, 'note_quality'), domainScore(audit, 'appropriateness'),
      domainScore(audit, 'prescribing_safety'), domainScore(audit, 'patient_centred'),
      JSON.stringify(sc.pdqi9 ?? []), Math.round((audit.completeness?.coverage ?? 0) * 100), missing.length,
      findings.length, nLow, nCtx, nInteraction,
      JSON.stringify(findings), JSON.stringify(audit.suggestions ?? []), JSON.stringify(missing),
      audit.engineVersion,
      ...(withGen ? [audit.quietingGen ?? 0] : []),
    ],
  )) as Array<{ id: string }>;
  return rows.length ? 'updated' : 'skipped';
}

/** uids already audited (at this engine version) for an IST calendar day — the worker's exclude set. */
export async function auditedUidsForDay(day: string, engineVersion: string): Promise<string[]> {
  const rows = (await sql(
    `SELECT uid FROM opd_note_audits
     WHERE engine_version = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
    [engineVersion, day],
  )) as Array<{ uid: string }>;
  return rows.map((r) => r.uid).filter(Boolean);
}

/** Count audited (at this engine version) for an IST calendar day. */
export async function auditedCountForDay(day: string, engineVersion: string): Promise<number> {
  const rows = (await sql(
    `SELECT count(*)::int AS n FROM opd_note_audits
     WHERE engine_version = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
    [engineVersion, day],
  )) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/** uids audited at ANY engine version for a day — the "already been audited at all" set. The
 *  Gemini worker uses this so it only audits GENUINELY NEW notes (never-audited); re-audits of
 *  already-audited notes to a newer engine are left to the free mini backfill.
 *
 *  ⚠️ DATA-QUALITY §1 EXCEPTION: this read deliberately does NOT filter `excluded_reason IS NULL`.
 *  If it did, the 166 excluded house-account audits would look un-audited → the worker would try to
 *  re-admit them each night. Keeping them "audited" here keeps them OUT of the fetch loop. (The intake
 *  filter also excludes them at db13-fetch time; this is belt-and-braces.) */
export async function auditedUidsForDayAnyVersion(day: string): Promise<string[]> {
  const rows = (await sql(
    `SELECT DISTINCT uid FROM opd_note_audits
     WHERE (note_date AT TIME ZONE 'Asia/Kolkata')::date = $1::date`,
    [day],
  )) as Array<{ uid: string }>;
  return rows.map((r) => r.uid).filter(Boolean);
}

/** Re-audit support (Fix B / decision 2) — delete ALL rows for a note uid so the fresh 0.81.7 audit
 *  is the single current row (chosen mechanism: DELETE-then-INSERT — see the build report's flag).
 *  Feedback rows live in a separate append-only table and are untouched. */
export async function deleteOpdAuditsForUid(uid: string): Promise<number> {
  if (!uid) return 0;
  const rows = (await sql(`DELETE FROM opd_note_audits WHERE uid = $1 RETURNING id`, [uid])) as Array<{ id: string }>;
  return rows.length;
}

/** Count of DISTINCT notes audited at ANY engine version for a day. */
export async function auditedCountForDayAnyVersion(day: string): Promise<number> {
  const rows = (await sql(
    `SELECT count(DISTINCT uid)::int AS n FROM opd_note_audits
     WHERE (note_date AT TIME ZONE 'Asia/Kolkata')::date = $1::date`,
    [day],
  )) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/** Earliest IST day that has any audit — the floor for the gap-fill sweep (never audit
 *  days before the system started). Null if nothing audited yet. */
export async function earliestAuditedDay(): Promise<string | null> {
  const rows = (await sql(
    `SELECT to_char(min((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') AS d FROM opd_note_audits`,
  )) as Array<{ d: string | null }>;
  return rows[0]?.d ?? null;
}
