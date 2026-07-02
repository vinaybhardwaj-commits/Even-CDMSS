/**
 * GET /api/governance/opd-signals — daily PDQI-9 governance signals (API-first).
 *
 * The consumer view lives in the future governance app (governance.evenos.app / EPI-ELO);
 * CAT computes and serves the contract. See CDMSS-GOVERNANCE-SIGNALS-API-v1.1.md.
 *
 * Auth (any one): admin session cookie · `Authorization: Bearer <ADMIN_TOKEN>` / `?token=` ·
 * `x-api-key: <GOV_API_KEY>` (the governance-app consumer key).
 *
 * Params: ?day=YYYY-MM-DD (IST; default = latest audited day) · ?period=day|week|month
 * (default day) · ?baselineDays=N (default 14) ·
 * v1.1: ?speciality=<name> (scope the whole report — window, baseline, eligibility — to one
 * department via doctor_directory; takes precedence over groupBy) · ?groupBy=speciality
 * (adds a compact `by_speciality` array alongside the hospital-wide report).
 *
 * v1.x contract discipline: additive-only response changes; `generator` bumps only when the
 * SAME request would return different content (thresholds/scope logic/wording). The default
 * (param-less) response is byte-compatible with v1.0.
 */
import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { fetchDoctorNames } from '@/lib/metabase';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { istDateRange, parseJson, type Period } from '@/lib/opd-audit-ui';
import { computeGovernanceSignals, PDQI9_GOV_ORDER, type GovDoctorStat } from '@/lib/opd-governance-core';

export const dynamic = 'force-dynamic';

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

function govKeyValid(req: NextRequest): boolean {
  const key = process.env.GOV_API_KEY;
  if (!key) return false;
  const hdr = req.headers.get('x-api-key') || '';
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const presented = hdr || bearer;
  if (!presented) return false;
  const a = Buffer.from(presented); const b = Buffer.from(key);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}

type Pdqi = { attr: string; value: number };
type NoteRow = { doctor_uid: unknown; pdqi9: unknown };
const normSpec = (s: string) => s.trim().toLowerCase();

/** Aggregate a set of note rows → hospital per-attr stats + per-doctor per-attr stats. */
function aggregate(rows: NoteRow[]) {
  const agg: Record<string, { s: number; c: number }> = {};
  const perDoc = new Map<string, Record<string, { s: number; c: number }>>();
  let assessed = 0;
  for (const row of rows) {
    const pd = parseJson<Pdqi[]>(row.pdqi9, []);
    if (pd.length === 0) continue;
    assessed += 1;
    const uid = row.doctor_uid ? String(row.doctor_uid) : '';
    const docAgg = uid ? (perDoc.get(uid) || {}) : null;
    for (const a of pd) {
      const k = String(a.attr); const v = Number(a.value) || 0;
      (agg[k] ||= { s: 0, c: 0 }); agg[k].s += v; agg[k].c += 1;
      if (docAgg) { (docAgg[k] ||= { s: 0, c: 0 }); docAgg[k].s += v; docAgg[k].c += 1; }
    }
    if (docAgg && uid) perDoc.set(uid, docAgg);
  }
  const current = PDQI9_GOV_ORDER
    .filter((attr) => agg[attr]?.c > 0)
    .map((attr) => ({ attr, mean: agg[attr].s / agg[attr].c, n: agg[attr].c }));
  return { current, perDoc, assessed };
}

function priorMeans(rows: NoteRow[]): Record<string, number> {
  const pAgg: Record<string, { s: number; c: number }> = {};
  for (const row of rows) {
    for (const a of parseJson<Pdqi[]>(row.pdqi9, [])) {
      const k = String(a.attr); const v = Number(a.value) || 0;
      (pAgg[k] ||= { s: 0, c: 0 }); pAgg[k].s += v; pAgg[k].c += 1;
    }
  }
  const out: Record<string, number> = {};
  for (const k of Object.keys(pAgg)) if (pAgg[k].c > 0) out[k] = pAgg[k].s / pAgg[k].c;
  return out;
}

function toDoctorStats(perDoc: Map<string, Record<string, { s: number; c: number }>>, names: Record<string, string>): GovDoctorStat[] {
  return [...perDoc.entries()].map(([uid, attrs]) => ({
    uid, name: names[uid] || undefined,
    attrs: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { mean: v.s / v.c, n: v.c }])),
  }));
}

export async function GET(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) {
    const denied = requireAdmin(req);
    if (denied) return denied;
  }

  const sp = req.nextUrl.searchParams;
  const period: Period = sp.get('period') === 'week' ? 'week' : sp.get('period') === 'month' ? 'month' : 'day';
  const baselineDays = Math.max(1, Math.min(90, Number(sp.get('baselineDays')) || 14));
  const specialityParam = (sp.get('speciality') || '').trim();
  const groupBy = sp.get('groupBy') === 'speciality' && !specialityParam;

  const WIN = `app_source = $1 AND engine_version = '${OPD_ENGINE_VERSION}' AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3`;

  let day = sp.get('day') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const latest = await run(
      `SELECT to_char(max((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') d FROM opd_note_audits WHERE app_source = $1 AND engine_version = '${OPD_ENGINE_VERSION}'`,
      [APP]).catch(() => []);
    day = String(latest[0]?.d || new Date().toISOString().slice(0, 10));
  }
  const { from, to } = istDateRange(day, period);
  const baseTo = addDays(from, -1);
  const baseFrom = addDays(baseTo, -(baselineDays - 1));

  const needDir = !!specialityParam || groupBy;
  const [curR, priorR, dirR] = await Promise.all([
    run(`SELECT doctor_uid, pdqi9 FROM opd_note_audits WHERE ${WIN} LIMIT 5000`, [APP, from, to]).catch(() => []) as Promise<NoteRow[]>,
    run(`SELECT doctor_uid, pdqi9 FROM opd_note_audits WHERE ${WIN} LIMIT 10000`, [APP, baseFrom, baseTo]).catch(() => []) as Promise<NoteRow[]>,
    needDir ? run(`SELECT doctor_uid, speciality FROM doctor_directory WHERE speciality IS NOT NULL`, []).catch(() => []) : Promise.resolve([]),
  ]);

  // uid → speciality (directory is synced weekly from db13; missing uids read as Unattributed)
  const specOf = new Map<string, string>();
  for (const r of dirR) specOf.set(String(r.doctor_uid), String(r.speciality));

  // ── optional speciality filter: scope EVERYTHING (window, baseline, eligibility) ──
  let curRows = curR, priorRows = priorR;
  if (specialityParam) {
    const want = normSpec(specialityParam);
    const keep = (r: NoteRow) => normSpec(specOf.get(String(r.doctor_uid || '')) || '') === want;
    curRows = curR.filter(keep);
    priorRows = priorR.filter(keep);
  }

  const { current, perDoc, assessed } = aggregate(curRows);
  const names = await fetchDoctorNames([...perDoc.keys()]).catch(() => ({} as Record<string, string>));
  const report = computeGovernanceSignals({ current, prior: priorMeans(priorRows), doctors: toDoctorStats(perDoc, names) });

  // ── optional per-speciality mini-reports (compact: no actions/affected at dept level) ──
  let bySpeciality: unknown = undefined;
  if (groupBy) {
    const curBy = new Map<string, NoteRow[]>(); const priorBy = new Map<string, NoteRow[]>();
    const bucket = (m: Map<string, NoteRow[]>, r: NoteRow) => {
      const k = specOf.get(String(r.doctor_uid || '')) || 'Unattributed';
      (m.get(k) || m.set(k, []).get(k)!).push(r);
    };
    for (const r of curR) bucket(curBy, r);
    for (const r of priorR) bucket(priorBy, r);
    bySpeciality = [...curBy.entries()].map(([spec, rows]) => {
      const a = aggregate(rows);
      const rep = computeGovernanceSignals({
        current: a.current, prior: priorMeans(priorBy.get(spec) || []), doctors: toDoctorStats(a.perDoc, {}),
      });
      return {
        speciality: spec,
        notes_assessed: a.assessed,
        doctors_seen: a.perDoc.size,
        signals: rep.signals.map((s) => ({ attr: s.attr, label: s.label, mean: s.mean, n: s.n, severity: s.severity, trend: s.trend, delta: s.delta, scope: s.scope })),
        healthy: rep.healthy,
      };
    }).sort((x, y) => y.notes_assessed - x.notes_assessed);
  }

  return NextResponse.json({
    ok: true,
    generator: 'opd-governance/0.1',
    engine: OPD_ENGINE_VERSION,
    day, period,
    window: { from, to },
    baseline: { from: baseFrom, to: baseTo, days: baselineDays },
    ...(specialityParam ? { speciality: specialityParam } : {}),
    notes_total: curRows.length,
    notes_assessed: assessed,
    doctors_seen: perDoc.size,
    report,
    ...(bySpeciality !== undefined ? { by_speciality: bySpeciality } : {}),
    advisory: 'Advisory process & documentation signals for clinical governance — not a clinician performance score. Concentrated signals name doctors for supportive, non-punitive follow-up.',
  });
}
