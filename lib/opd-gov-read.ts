/**
 * lib/opd-gov-read.ts — audit-side reads for the governance signal feed (Neon).
 *
 * A governance thread stores the (doctor, signal_type, window) key; the actual finding INSTANCES
 * and the doctor's audit METRICS live in opd_note_audits and are resolved at read time here (so the
 * thread never duplicates finding text). Re-stamps finding identity on read → legacy rows covered.
 */

import { sql } from './db';
import { OPD_ENGINE_VERSION, stampFindingIdentity, type OpdFinding } from './opd-note-audit-core';
import { parseJson } from './opd-audit-ui';
import type { Source } from './citations-core';
import type { SignalRepresentative } from './opd-gov-signal-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

export interface Instance extends SignalRepresentative {}

function citationsFor(f: OpdFinding, sources: Source[]): { n: number; title: string; url: string }[] {
  const ids = Array.isArray(f.citation_ids) ? f.citation_ids : [];
  return ids.map((i) => {
    const s = sources.find((x) => x?.n === i);
    return { n: i, title: s ? (s.chapter ? `${s.book} — ${s.chapter}` : s.book) : `Source ${i}`, url: s?.url || '' };
  });
}

/**
 * All instances of one signal_type for a doctor in a window, newest note first. `representative`
 * is the first. Reads only de-identified finding text (no PHI, no patient identifiers).
 */
export async function resolveInstances(
  doctorUid: string, signalType: string, windowFrom: string | null, windowTo: string | null,
): Promise<{ count: number; representative: SignalRepresentative | null; instances: Instance[] }> {
  const params: unknown[] = [APP, OPD_ENGINE_VERSION, doctorUid];
  let where = `app_source=$1 AND engine_version=$2 AND doctor_uid=$3`;
  if (windowFrom) { params.push(windowFrom); where += ` AND (note_date AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}`; }
  if (windowTo) { params.push(windowTo); where += ` AND (note_date AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}`; }

  const rows = await run(
    `SELECT id::text AS id, to_char(note_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS note_date, findings, sources
     FROM opd_note_audits WHERE ${where} ORDER BY note_date DESC LIMIT 2000`, params).catch(() => []);

  const instances: Instance[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const audit_id = String(r.id);
    const note_date = String(r.note_date || '');
    const sources = parseJson<Source[]>(r.sources, []);
    const stamped = stampFindingIdentity(parseJson<OpdFinding[]>(r.findings, []));
    for (const f of stamped) {
      if (f.informational) continue;
      if (f.signal_type !== signalType) continue;
      instances.push({
        audit_id, finding_ref: f.finding_ref as string, subject: f.subject, verdict: f.verdict,
        rationale: f.rationale, note_date, citations: citationsFor(f, sources),
      });
    }
  }
  return { count: instances.length, representative: instances[0] ?? null, instances };
}

export interface AuditMetrics {
  notes_audited: number; nqi_mean: number | null; band_a_pct: number | null;
  documentation_completeness: number | null; prescribing_safety: number | null;
  top_gap: string | null; as_of: string | null;
}

/** Audit-side per-doctor metrics over a trailing window (default 30d ending latest audited day). */
export async function doctorAuditMetrics(doctorUid: string, days = 30): Promise<AuditMetrics> {
  const latest = await run(
    `SELECT to_char(max((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') d
     FROM opd_note_audits WHERE app_source=$1 AND engine_version=$2 AND doctor_uid=$3`,
    [APP, OPD_ENGINE_VERSION, doctorUid]).catch(() => []);
  const to = String(latest[0]?.d || '');
  if (!to) return { notes_audited: 0, nqi_mean: null, band_a_pct: null, documentation_completeness: null, prescribing_safety: null, top_gap: null, as_of: null };
  const fromD = new Date(to + 'T00:00:00Z'); fromD.setUTCDate(fromD.getUTCDate() - (Math.max(1, days) - 1));
  const from = fromD.toISOString().slice(0, 10);
  const win = `app_source=$1 AND engine_version=$2 AND doctor_uid=$3 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $4 AND $5`;
  const p = [APP, OPD_ENGINE_VERSION, doctorUid, from, to];

  const [agg, gap] = await Promise.all([
    run(`SELECT count(*)::int n, avg(note_quality_index)::float nqi,
           (100.0*sum(CASE WHEN band='A' THEN 1 ELSE 0 END)/nullif(count(*),0))::float band_a,
           avg(completeness_pct)::float comp, avg(score_prescribing_safety)::float rx
         FROM opd_note_audits WHERE ${win}`, p).catch(() => []),
    run(`SELECT x s, count(*) c FROM opd_note_audits, LATERAL jsonb_array_elements_text(missing_fields) x
         WHERE ${win} GROUP BY 1 ORDER BY c DESC LIMIT 1`, p).catch(() => []),
  ]);
  const a = (agg[0] || {}) as Record<string, unknown>;
  const rnd = (v: unknown) => (v == null ? null : Math.round(Number(v)));
  return {
    notes_audited: Number(a.n || 0),
    nqi_mean: rnd(a.nqi), band_a_pct: rnd(a.band_a),
    documentation_completeness: rnd(a.comp), prescribing_safety: rnd(a.rx),
    top_gap: gap[0]?.s ? String(gap[0].s) : null, as_of: to,
  };
}
