/**
 * lib/audit-suppression-store.ts — Tier 1 self-healing: the suppression store (Neon, WIRED).
 *
 * `audit_suppression` holds human-approved, narrowly-scoped, reversible FP suppressions consulted by
 * the audit pipeline (applySuppressions). Plus the valid-label-set read the dual-label safety check
 * (previewCollateral) runs before activation. Table created by /api/admin/migrate-audit-suppression.
 */

import { randomUUID } from 'crypto';
import { sql } from './db';
import { OPD_ENGINE_VERSION, stampFindingIdentity, type OpdFinding } from './opd-note-audit-core';
import { parseJson } from './opd-audit-ui';
import { loadValidLabelDoctors } from './opd-triage-store';
import type { Suppression, ValidLabelInstance, SuppressionAction, SuppressionMatch, SuppressionScope } from './audit-suppression-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

export async function ensureSuppressionTable(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS audit_suppression (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    app_source        text NOT NULL DEFAULT 'standalone',
    signal_type       text NOT NULL,
    discriminator     text,
    match_kind        text NOT NULL DEFAULT 'type_only',
    scope             text NOT NULL DEFAULT 'all',
    doctor_uid        text,
    action            text NOT NULL DEFAULT 'downgrade',
    source_triage_ref uuid,
    reason            text,
    created_by        text,
    active            boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
  )`, []);
  await run(`CREATE INDEX IF NOT EXISTS audit_suppression_active_idx ON audit_suppression (active, signal_type)`, []);
}

export interface SuppressionRow extends Suppression {
  id: string; reason: string | null; created_by: string | null; source_triage_ref: string | null; created_at: string;
}
function rowToSuppression(r: Record<string, unknown>): SuppressionRow {
  return {
    id: String(r.id), signal_type: String(r.signal_type),
    discriminator: r.discriminator == null ? null : String(r.discriminator),
    match_kind: (String(r.match_kind || 'type_only') as SuppressionMatch),
    scope: (String(r.scope || 'all') as SuppressionScope),
    doctor_uid: r.doctor_uid == null ? null : String(r.doctor_uid),
    action: (String(r.action || 'downgrade') as SuppressionAction),
    active: r.active === true || r.active === 't' || r.active === 'true',
    reason: r.reason == null ? null : String(r.reason),
    created_by: r.created_by == null ? null : String(r.created_by),
    source_triage_ref: r.source_triage_ref == null ? null : String(r.source_triage_ref),
    created_at: r.created_at == null ? '' : new Date(String(r.created_at)).toISOString(),
  };
}
const COLS = `id, signal_type, discriminator, match_kind, scope, doctor_uid, action, source_triage_ref, reason, created_by, active, created_at`;

export async function listSuppressions(activeOnly = false): Promise<SuppressionRow[]> {
  const where = activeOnly ? `WHERE active = true` : '';
  const rows = await run(`SELECT ${COLS} FROM audit_suppression ${where} ORDER BY created_at DESC LIMIT 1000`, []).catch(() => []);
  return (rows as Record<string, unknown>[]).map(rowToSuppression);
}

/** Active suppressions the audit pipeline consults (cached by the caller). */
export async function loadActiveSuppressions(): Promise<Suppression[]> {
  return (await listSuppressions(true)).map((s) => ({
    id: s.id, signal_type: s.signal_type, discriminator: s.discriminator, match_kind: s.match_kind,
    scope: s.scope, doctor_uid: s.doctor_uid, action: s.action, active: s.active,
  }));
}

export interface CreateSuppressionInput {
  signal_type: string; discriminator?: string | null; match_kind?: string; scope?: string;
  doctor_uid?: string | null; action?: string; source_triage_ref?: string | null; reason?: string | null;
  created_by?: string | null; active?: boolean;
}
const dstr = (v: unknown, cap = 500): string | null => (v == null || v === '' ? null : String(v).slice(0, cap));

export async function createSuppression(input: CreateSuppressionInput): Promise<SuppressionRow> {
  const signal_type = dstr(input.signal_type, 80);
  if (!signal_type) throw new Error('signal_type required');
  const match_kind = input.match_kind === 'subject_contains' ? 'subject_contains' : 'type_only';
  const scope = input.scope === 'doctor' ? 'doctor' : 'all';
  const action = input.action === 'drop' ? 'drop' : 'downgrade';
  if (match_kind === 'subject_contains' && !dstr(input.discriminator)) throw new Error('subject_contains requires a discriminator');
  if (scope === 'doctor' && !dstr(input.doctor_uid, 64)) throw new Error('doctor scope requires doctor_uid');
  const id = randomUUID();
  await run(
    `INSERT INTO audit_suppression (id, app_source, signal_type, discriminator, match_kind, scope, doctor_uid, action, source_triage_ref, reason, created_by, active)
     VALUES ($1,'standalone',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, signal_type, dstr(input.discriminator), match_kind, scope, dstr(input.doctor_uid, 64), action,
      dstr(input.source_triage_ref, 64), dstr(input.reason, 1000), dstr(input.created_by, 64), input.active !== false]);
  const rows = await run(`SELECT ${COLS} FROM audit_suppression WHERE id=$1`, [id]);
  return rowToSuppression(rows[0]);
}

export async function setSuppressionActive(id: string, active: boolean): Promise<SuppressionRow | null> {
  await run(`UPDATE audit_suppression SET active=$2, updated_at=now() WHERE id=$1`, [id, active]);
  const rows = await run(`SELECT ${COLS} FROM audit_suppression WHERE id=$1`, [id]).catch(() => []);
  return rows[0] ? rowToSuppression(rows[0]) : null;
}

/**
 * The valid-label set for `signalType`: every finding of that type, on notes by a doctor whose latest
 * triage decision for the type is `valid_signal`. This is what the dual-label check runs against — a
 * proposed suppression must remove NONE of these. Scanned over a recent window (default 60d).
 */
export async function loadValidLabelInstances(signalType: string, windowDays = 60): Promise<ValidLabelInstance[]> {
  const protectedDoctors = await loadValidLabelDoctors(signalType);
  if (protectedDoctors.length === 0) return [];
  const rows = await run(
    `SELECT doctor_uid, findings FROM opd_note_audits
     WHERE app_source=$1 AND engine_version=$2 AND doctor_uid = ANY($3)
       AND (note_date AT TIME ZONE 'Asia/Kolkata')::date > (now() AT TIME ZONE 'Asia/Kolkata')::date - $4::int
     LIMIT 6000`,
    [APP, OPD_ENGINE_VERSION, protectedDoctors, Math.max(1, windowDays)]).catch(() => []);
  const out: ValidLabelInstance[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const doctor_uid = String(r.doctor_uid || '');
    if (!doctor_uid) continue;
    const stamped = stampFindingIdentity(parseJson<OpdFinding[]>(r.findings, []));
    for (const f of stamped) {
      if (f.informational) continue;
      if (f.signal_type !== signalType) continue;
      out.push({ doctor_uid, signal_type: signalType, subject: f.subject });
    }
  }
  return out;
}
