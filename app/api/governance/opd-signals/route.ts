/**
 * GET /api/governance/opd-signals — daily PDQI-9 governance signals (API-first).
 *
 * The consumer view lives in the future governance app (governance.evenos.app / EPI-ELO);
 * CAT computes and serves the contract. See CDMSS-GOVERNANCE-SIGNALS-API-v1.0.md.
 *
 * Auth (any one): admin session cookie · `Authorization: Bearer <ADMIN_TOKEN>` / `?token=` ·
 * `x-api-key: <GOV_API_KEY>` (optional env for the external consumer; PENDING-V to set).
 *
 * Params: ?day=YYYY-MM-DD (IST; default = latest audited day) · ?period=day|week|month
 * (default day) · ?baselineDays=N (default 14 — the trend baseline window ending the day
 * before the current window starts).
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

export async function GET(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) {
    const denied = requireAdmin(req);
    if (denied) return denied;
  }

  const sp = req.nextUrl.searchParams;
  const period: Period = sp.get('period') === 'week' ? 'week' : sp.get('period') === 'month' ? 'month' : 'day';
  const baselineDays = Math.max(1, Math.min(90, Number(sp.get('baselineDays')) || 14));

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

  const [curR, priorR] = await Promise.all([
    run(`SELECT doctor_uid, pdqi9 FROM opd_note_audits WHERE ${WIN} LIMIT 5000`, [APP, from, to]).catch(() => []),
    run(`SELECT pdqi9 FROM opd_note_audits WHERE ${WIN} LIMIT 10000`, [APP, baseFrom, baseTo]).catch(() => []),
  ]);

  // ── aggregate: hospital per-attr, per-doctor per-attr, prior-window per-attr ──
  const agg: Record<string, { s: number; c: number }> = {};
  const perDoc = new Map<string, Record<string, { s: number; c: number }>>();
  let assessed = 0;
  for (const row of curR) {
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
  const prior: Record<string, number> = {};
  {
    const pAgg: Record<string, { s: number; c: number }> = {};
    for (const row of priorR) {
      for (const a of parseJson<Pdqi[]>(row.pdqi9, [])) {
        const k = String(a.attr); const v = Number(a.value) || 0;
        (pAgg[k] ||= { s: 0, c: 0 }); pAgg[k].s += v; pAgg[k].c += 1;
      }
    }
    for (const k of Object.keys(pAgg)) if (pAgg[k].c > 0) prior[k] = pAgg[k].s / pAgg[k].c;
  }

  const names = await fetchDoctorNames([...perDoc.keys()]).catch(() => ({} as Record<string, string>));
  const doctors: GovDoctorStat[] = [...perDoc.entries()].map(([uid, attrs]) => ({
    uid, name: names[uid] || undefined,
    attrs: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { mean: v.s / v.c, n: v.c }])),
  }));

  const current = PDQI9_GOV_ORDER
    .filter((attr) => agg[attr]?.c > 0)
    .map((attr) => ({ attr, mean: agg[attr].s / agg[attr].c, n: agg[attr].c }));

  const report = computeGovernanceSignals({ current, prior, doctors });

  return NextResponse.json({
    ok: true,
    generator: 'opd-governance/0.1',
    engine: OPD_ENGINE_VERSION,
    day, period,
    window: { from, to },
    baseline: { from: baseFrom, to: baseTo, days: baselineDays },
    notes_total: curR.length,
    notes_assessed: assessed,
    doctors_seen: perDoc.size,
    report,
    advisory: 'Advisory process & documentation signals for clinical governance — not a clinician performance score. Concentrated signals name doctors for supportive, non-punitive follow-up.',
  });
}
