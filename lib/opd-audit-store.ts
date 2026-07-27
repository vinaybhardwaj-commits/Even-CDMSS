/**
 * lib/opd-audit-store.ts — persist + read OPD note-quality audits (Neon `opd_note_audits`).
 *
 * Maps the in-memory OpdNoteAudit → one de-identified, uid-keyed row. Idempotent insert
 * (ON CONFLICT (uid, engine_version) DO NOTHING), so the worker re-runs safely — the audit
 * table itself is the worker's watermark. A manual force mode (saveOpdAudit opts.force)
 * upgrades the conflict to DO UPDATE for admin backfill overwrites.
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

/** Force-overwrite mode for saveOpdAudit (obstetric re-score backfill): when a row already exists
 *  at (uid, engine_version), DO UPDATE the scored columns instead of DO NOTHING. Off by default —
 *  the idempotent daily worker path is unchanged (byte-identical SQL). */
export interface SaveOpdAuditOptions { force?: boolean }

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
// GENERALISED (A.1): the same deploy-before-migrate tolerance now guards two columns —
// `quieting_gen` and `completeness_items` (0027). Semantics are UNCHANGED from the single-column
// version: cache a present result for 300s, re-probe an absent one after 60s so the first render
// after the migration picks it up, and treat a probe error as absent (drop the extra column, never
// the audit). The cache is keyed per column, so the two never interfere.
const _colProbe = new Map<string, { at: number; present: boolean }>();
async function opdColumnExists(column: string): Promise<boolean> {
  const now = Date.now();
  const hit = _colProbe.get(column);
  if (hit && now - hit.at < 300_000 && hit.present) return true;
  if (hit && now - hit.at < 60_000) return hit.present;   // re-probe absent faster post-migration
  try {
    const rows = (await sql(
      `SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'opd_note_audits' AND column_name = $1`,
      [column],
    )) as Array<{ ok: number }>;
    _colProbe.set(column, { at: now, present: rows.length > 0 });
  } catch { _colProbe.set(column, { at: now, present: false }); }
  return _colProbe.get(column)!.present;
}
async function quietingGenColumnExists(): Promise<boolean> { return opdColumnExists('quieting_gen'); }
/** 0027 — the per-field completeness array (item D-1). Absent until the migration runs. */
async function completenessItemsColumnExists(): Promise<boolean> { return opdColumnExists('completeness_items'); }

/**
 * The array to persist, or null. Returns null rather than `[]` when the engine produced nothing:
 * NULL means "no per-field detail was recorded", and the read path treats that as "fall back to the
 * stored flat completeness_pct". An empty array would mean "we looked and there were no fields",
 * which weighted completeness scores as 100. The two must never be conflated.
 */
function completenessItemsJson(audit: OpdNoteAudit): string | null {
  const items = audit.completeness?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  try { return JSON.stringify(items); } catch { return null; }
}

/** Insert one audit. Returns 'inserted' | 'exists' (already audited at this engine version) | 'skipped' (no uid).
 *  With opts.force, an existing (uid, engine_version) row is overwritten (scored columns +
 *  model/trace/latency/sources, audited_at = now()) and 'updated' is returned. */
/**
 * PHASE 1 (NQI coverage) — serialise the scorecard AS COMPUTED, unmodified: headline, band,
 * domains[] (domain/label/score/weight/n/basis), pdqi9[], confidence, flags[], caveat. Nothing is
 * pruned, reshaped or renamed; jsonb exists precisely so a question nobody has asked yet is still
 * answerable. The load-bearing field is domains[].weight — a note_quality entry with weight 0 and
 * basis "PDQI-9 not assessed" is what can finally contradict a high note_quality_index.
 *
 * FAIL-SAFE (PRD §5): returns null if serialisation throws for ANY reason, so the audit row is still
 * written exactly as it is today with scorecard NULL. A scorecard-persistence fault must never cost
 * an audit — the audit is the product, this column is instrumentation.
 */
function scorecardJson(sc: unknown): string | null {
  try {
    if (sc == null) return null;
    return JSON.stringify(sc);
  } catch { return null; }
}

export async function saveOpdAudit(
  audit: OpdNoteAudit,
  meta: SaveOpdAuditMeta = {},
  opts: SaveOpdAuditOptions = {},
): Promise<'inserted' | 'exists' | 'skipped' | 'updated'> {
  const k = audit.keys;
  if (!k.uid) return 'skipped';
  const force = opts.force === true;
  const sc = audit.scorecard;
  const findings = audit.findings || [];
  const nLow = findings.filter((f) => f.verdict === 'low-value').length;
  const nCtx = findings.filter((f) => f.verdict === 'context-dependent').length;
  const nInteraction = findings.filter((f) => /interaction|contraindicat|\bddi\b/i.test(`${f.subject} ${f.rationale}`)).length;
  const missing = audit.completeness?.missing ?? [];
  const withGen = await quietingGenColumnExists();
  // 0027 — persist the per-field array the core already emits. Appended AFTER quieting_gen so every
  // existing placeholder index is untouched.
  const withItems = await completenessItemsColumnExists();
  const itemsJson = completenessItemsJson(audit);

  // Force mode rewrites the scored columns from the fresh audit (EXCLUDED.*) and re-stamps
  // audited_at; complexity_band/complexity_inputs are left as-is (same as updateOpdAudit).
  const conflictClause = force
    ? `DO UPDATE SET
         note_quality_index = EXCLUDED.note_quality_index, band = EXCLUDED.band,
         score_documentation = EXCLUDED.score_documentation, score_note_quality = EXCLUDED.score_note_quality,
         score_appropriateness = EXCLUDED.score_appropriateness, score_prescribing_safety = EXCLUDED.score_prescribing_safety,
         score_patient_centred = EXCLUDED.score_patient_centred,
         pdqi9 = EXCLUDED.pdqi9, completeness_pct = EXCLUDED.completeness_pct, n_missing_mandatory = EXCLUDED.n_missing_mandatory,
         n_findings = EXCLUDED.n_findings, n_low_value = EXCLUDED.n_low_value, n_context_dependent = EXCLUDED.n_context_dependent,
         n_interaction_alerts = EXCLUDED.n_interaction_alerts,
         findings = EXCLUDED.findings, suggestions = EXCLUDED.suggestions, missing_fields = EXCLUDED.missing_fields,
         model = EXCLUDED.model, trace_id = EXCLUDED.trace_id, latency_ms = EXCLUDED.latency_ms, sources = EXCLUDED.sources,
         scorecard = EXCLUDED.scorecard,
         ${withItems ? 'completeness_items = EXCLUDED.completeness_items, ' : ''}${withGen ? 'quieting_gen = EXCLUDED.quieting_gen, ' : ''}audited_at = now()`
    : 'DO NOTHING';

  const rows = (await sql(
    `INSERT INTO opd_note_audits
      (uid, consult_uid, doctor_uid, kx_encounter_id, note_date, prescription_type, consult_type,
       note_quality_index, band,
       score_documentation, score_note_quality, score_appropriateness, score_prescribing_safety, score_patient_centred,
       pdqi9, completeness_pct, n_missing_mandatory,
       n_findings, n_low_value, n_context_dependent, n_interaction_alerts,
       findings, suggestions, engine_version, model, trace_id, latency_ms, missing_fields, sources,
       complexity_band, complexity_inputs, scorecard${withGen ? ', quieting_gen' : ''}${withItems ? ', completeness_items' : ''})
     VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9, $10,$11,$12,$13,$14,
       $15::jsonb,$16,$17, $18,$19,$20,$21, $22::jsonb,$23::jsonb,$24,$25,$26,$27, $28::jsonb, $29::jsonb,
       $30, $31::jsonb, $32::jsonb${withGen ? ', $33' : ''}${withItems ? `, $${withGen ? 34 : 33}::jsonb` : ''})
     ON CONFLICT (uid, engine_version) ${conflictClause}
     RETURNING id${force ? ', (xmax = 0) AS inserted' : ''}`,
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
      scorecardJson(sc),
      ...(withGen ? [audit.quietingGen ?? 0] : []),
      ...(withItems ? [itemsJson] : []),
    ],
  )) as Array<{ id: string; inserted?: boolean }>;
  // Under force, DO UPDATE always returns the row; (xmax = 0) distinguishes fresh insert from overwrite.
  const freshInsert = rows.length > 0 && (!force || rows[0].inserted === true);
  await runAuditShadow(audit, findings); // B1 shadow — dormant unless CLINICAL_STATE_AUDIT_SHADOW=1; read-only, fail-open
  // Stage 3 longitudinal pass (opd-longitudinal/0.1) — AFTER the INSERT, flag-gated + fail-open, so it can
  // never affect the base row. Only for a fresh insert (idempotent worker re-runs never re-charge it; the
  // replay endpoint recomputes on demand — and a force overwrite never re-charges it either). Dark unless
  // OPD_LONGITUDINAL_ENABLED=1.
  if (freshInsert) await runLongitudinalPass(audit).catch(() => { /* fail-open — base audit already persisted */ });
  if (!rows.length) return 'exists';
  return freshInsert ? 'inserted' : 'updated';
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
  const withItems = await completenessItemsColumnExists();
  const itemsJson = completenessItemsJson(audit);

  const rows = (await sql(
    `UPDATE opd_note_audits SET
       note_quality_index = $2, band = $3,
       score_documentation = $4, score_note_quality = $5, score_appropriateness = $6,
       score_prescribing_safety = $7, score_patient_centred = $8,
       pdqi9 = $9::jsonb, completeness_pct = $10, n_missing_mandatory = $11,
       n_findings = $12, n_low_value = $13, n_context_dependent = $14, n_interaction_alerts = $15,
       findings = $16::jsonb, suggestions = $17::jsonb, missing_fields = $18::jsonb,
       scorecard = $20::jsonb${withGen ? ', quieting_gen = $21' : ''}${withItems ? `, completeness_items = $${withGen ? 22 : 21}::jsonb` : ''}
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
      scorecardJson(sc),
      ...(withGen ? [audit.quietingGen ?? 0] : []),
      ...(withItems ? [itemsJson] : []),
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

// ── recompute-on-read (Scoring policy Phase A, decision §1.1 / §1.5) ─────────────────────────────
//
// ⚠️ OPD IS NEW-AUDITS-ONLY, AND THIS FUNCTION CANNOT CHANGE THAT. Decision §1.5: `opd_note_audits`
// stores `missing_fields` (display LABELS) and `completeness_pct`, but NO per-field status array —
// so its 25,130-note history cannot be re-weighted, and this wrapper deliberately does not try.
// It attaches the active weights version for display (PRD §8.3, "every surface showing a band must
// also show the weights version that produced it") and mirrors the stored values, but leaves the
// scores alone. Re-weighting begins only once the engine's structured emission is persisted.
//
// It is written as a wrapper anyway, rather than omitted, so that the moment the structured array
// IS persisted the change is a single `extractOpdItems` implementation here — not a new read path.

export interface WeightedOpdRow extends Record<string, unknown> {
  stored_completeness_pct: number | null;
  stored_note_quality_index: number | null;
  stored_band: string | null;
  weights_version: string | null;
  /** TRUE when THIS ROW has no stored per-field detail, so nothing could be re-weighted. */
  weights_not_applicable: boolean;
}

/**
 * Parse `opd_note_audits.completeness_items` (0027). Returns [] for NULL, a non-array, or unparseable
 * JSON — the caller distinguishes "no items" from "items" and never scores an empty array.
 */
export function parseOpdCompletenessItems(raw: unknown): { key: string; status?: unknown; label?: string; section?: string }[] {
  let v: unknown = raw;
  if (v == null) return [];
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(v)) return [];
  return v.filter((i): i is { key: string } => !!i && typeof i === 'object' && typeof (i as { key?: unknown }).key === 'string');
}

/**
 * Apply the active OPD weights to already-fetched rows (A.1 / item D-1).
 *
 * ═══ THE FALLBACK RULE — THE LOAD-BEARING PART OF THIS FUNCTION ═══
 * A row whose `completeness_items` is NULL — every one of the 25,130 historical rows, and every row
 * written before migration 0027 runs — KEEPS ITS STORED FLAT `completeness_pct`, `note_quality_index`
 * and `band`, untouched. It is marked `weights_not_applicable: true`.
 *
 * It must NEVER be scored from the absent array. `weightedCompleteness([], …)` returns 100 ("no
 * applicable fields ⇒ nothing missing"), which is correct for a document whose fields are all `na`
 * and CATASTROPHICALLY wrong for a row we simply never recorded detail for: it would silently
 * promote 25,130 historical audits to 100% documentation. Equally, a missing array must never read
 * as "all fields missing" (0%). Hence the explicit `items.length === 0 ⇒ return stored` guard below,
 * which has its own test.
 *
 * Decision §1.5 stands: OPD weighting is NEW-AUDITS-ONLY. There is no backfill and this function
 * does not simulate one.
 *
 * Only the DOCUMENTATION fields are weighted: the three continuity items (advice_given,
 * advice_instructions, follow_up) are scored in the Continuity domain and are excluded from the
 * completeness denominator by the engine, so they are filtered out here too. With v1 all-Standard
 * that makes the weighted value reproduce the engine's own `coverage` exactly.
 *
 * NEVER THROWS: on any failure the rows come back stored-as-is with `weights_version: null`.
 */
export async function applyOpdScoringPolicy<T extends Record<string, unknown>>(rows: T[]): Promise<(T & WeightedOpdRow)[]> {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];

  const stored = (r: T) => ({
    ...r,
    stored_completeness_pct: r.completeness_pct == null ? null : Number(r.completeness_pct),
    stored_note_quality_index: r.note_quality_index == null ? null : Number(r.note_quality_index),
    stored_band: r.band == null ? null : String(r.band),
  });

  try {
    const { getActivePolicy } = await import('./scoring-policy/store');
    const { weightedCompleteness, OPD_RX_COND_KEYS } = await import('./scoring-policy/completeness');
    const { recomputeOpdIndex } = await import('./scoring-policy/recompute');
    const { weightedKeysFor } = await import('./scoring-policy/weights');
    const policy = await getActivePolicy('opd_rx');
    const versionString = policy.fallback ? null : policy.versionString;
    const weightable = new Set(weightedKeysFor('opd_rx'));

    return list.map((r) => {
      const base = { ...stored(r), weights_version: versionString };
      const items = parseOpdCompletenessItems(r.completeness_items).filter((i) => weightable.has(i.key));
      // ── THE GUARD. No stored detail ⇒ stored values, verbatim. ──
      if (items.length === 0) return { ...base, weights_not_applicable: true } as T & WeightedOpdRow;

      const c = weightedCompleteness(items, policy.vector, { condKeys: OPD_RX_COND_KEYS });
      const idx = recomputeOpdIndex(
        {
          documentation: c.pct,
          note_quality: numOrNull(r.score_note_quality),
          appropriateness: numOrNull(r.score_appropriateness),
          prescribing_safety: numOrNull(r.score_prescribing_safety),
          patient_centred: numOrNull(r.score_patient_centred),
        },
        c.pct,
      );
      return {
        ...base,
        completeness_pct: c.pct,
        score_documentation: c.pct,
        note_quality_index: idx.index,
        band: idx.band,
        weights_not_applicable: false,
      } as T & WeightedOpdRow;
    });
  } catch {
    return list.map((r) => ({ ...stored(r), weights_version: null, weights_not_applicable: true })) as (T & WeightedOpdRow)[];
  }
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
