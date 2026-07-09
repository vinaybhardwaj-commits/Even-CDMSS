/**
 * GET /api/opd-triage/queue — the care-manager worklist (governance spec v2.0 §3.2).
 *
 * Last night's non-informational OPD audit findings, grouped by doctor → signal_type, ranked by
 * severity × noise, with the current triage decision overlaid. This is the GATE: only findings a
 * CM later routes ever leave for a doctor. Advisory framing throughout — a screen, not a verdict.
 *
 * Query: ?day=YYYY-MM-DD (default = latest audited IST day) · ?days=N (window back, default 1,
 *        max 7) · ?doctor_uid= (one doctor) · ?status=untriaged|all (default untriaged).
 * Auth: care-manager session cookie OR admin.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT, stampFindingIdentity, type OpdFinding } from '@/lib/opd-note-audit-core';
import { fetchDoctorNames } from '@/lib/metabase';
import { parseJson } from '@/lib/opd-audit-ui';
import { buildQueue, type TriageFinding } from '@/lib/opd-triage-core';
import { loadTriageDecisions } from '@/lib/opd-triage-store';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';
const ENGINE_FAMILY: string[] = [...OPD_ENGINE_VERSIONS_CURRENT];

async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}
function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status') === 'all' ? 'all' : 'untriaged';
  const doctorFilter = (sp.get('doctor_uid') || '').trim();
  const days = Math.max(1, Math.min(7, Number(sp.get('days')) || 1));

  let day = sp.get('day') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const latest = await run(
      `SELECT to_char(max((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') d
       FROM opd_note_audits WHERE app_source = $1 AND engine_version = ANY($2)`,
      [APP, ENGINE_FAMILY]).catch(() => []);
    day = String(latest[0]?.d || new Date().toISOString().slice(0, 10));
  }
  const from = addDays(day, -(days - 1));
  const to = day;

  // Read the window's audits. findings jsonb is re-stamped per note (deterministic) so legacy rows
  // that predate finding identity still get signal_type + finding_ref. Engine FAMILY (0.81.3 ∪ 0.81.4)
  // so the 0.81.4 metadata bump doesn't empty the queue against the un-re-audited 0.81.3 corpus.
  const params: unknown[] = [APP, ENGINE_FAMILY, from, to];
  let where = `app_source = $1 AND engine_version = ANY($2) AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $3 AND $4`;
  if (doctorFilter) { params.push(doctorFilter); where += ` AND doctor_uid = $${params.length}`; }

  const rows = await run(
    `SELECT id::text AS id, doctor_uid, to_char(note_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS note_date,
            findings, complexity_band, complexity_inputs
     FROM opd_note_audits WHERE ${where} LIMIT 8000`, params).catch(() => []);

  const findings: TriageFinding[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const audit_id = String(r.id);
    const doctor_uid = r.doctor_uid ? String(r.doctor_uid) : '';
    const note_date = String(r.note_date || day);
    if (!doctor_uid) continue;
    const raw = parseJson<OpdFinding[]>(r.findings, []);
    const stamped = stampFindingIdentity(raw);
    // Right Care routing context (decision 16) — per-note band/inputs + per-finding lvc_category.
    const band = r.complexity_band == null ? null : String(r.complexity_band);
    const inputs = r.complexity_inputs == null ? null : parseJson<Record<string, unknown>>(r.complexity_inputs, {});
    for (const f of stamped) {
      findings.push({
        audit_id, doctor_uid, note_date,
        subject: f.subject, rationale: f.rationale, verdict: f.verdict, domain: f.domain,
        signal_type: f.signal_type as string, finding_ref: f.finding_ref as string,
        informational: f.informational, citation_ids: f.citation_ids,
        complexity_band: band, complexity_inputs: inputs,
        lvc_category: (f as { lvc_category?: string }).lvc_category ?? null,
      });
    }
  }

  const doctorUids = [...new Set(findings.map((f) => f.doctor_uid))];
  const [decisions, names, dirRows] = await Promise.all([
    loadTriageDecisions(doctorUids).catch(() => []),
    fetchDoctorNames(doctorUids).catch(() => ({} as Record<string, string>)),
    run(`SELECT doctor_uid, speciality FROM doctor_directory WHERE speciality IS NOT NULL`, []).catch(() => []),
  ]);
  const specialities: Record<string, string> = {};
  for (const r of dirRows as Record<string, unknown>[]) specialities[String(r.doctor_uid)] = String(r.speciality);

  const { doctors } = buildQueue(findings, decisions, { names, specialities, status });

  return NextResponse.json({
    ok: true,
    window: { from, to, days },
    status,
    engine: OPD_ENGINE_VERSION,
    doctors_total: doctorUids.length,
    doctors,
    advisory: 'Advisory documentation & prescribing signals from an automated screen — validate before routing. Not a clinician performance score.',
  });
}
