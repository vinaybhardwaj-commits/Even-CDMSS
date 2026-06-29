import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fetchDoctorNames } from '@/lib/metabase';
import { bandFor } from '@/lib/opd-note-score-core';
import {
  bandColor, scoreColor, istDateRange, parseJson, doctorLabel, fmtIstTime, fmtIstDateLong,
  type Period,
} from '@/lib/opd-audit-ui';
import AuditTable, { type AuditRow } from './audit-table';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'OPD Audit · Admin' };

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function rowsOf<T>(text: string, params: unknown[]): Promise<T[]> {
  try { return (await run(text, params)) as T[]; } catch { return []; }
}
const n = (v: unknown): number => Number(v ?? 0);

function Locked({ configured, bad }: { configured: boolean; bad: boolean }) {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">OPD Audit</h1>
      <p className="mt-1.5 text-sm text-slate-500">Daily OPD note-quality audit. This surface shows clinical-quality detail, so it is access-controlled.</p>
      <div className="mt-8 max-w-sm rounded-xl border border-slate-200 bg-white p-5">
        {!configured ? (
          <p className="text-sm text-red-700">Locked. Set the <code className="rounded bg-slate-100 px-1">ADMIN_TOKEN</code> environment variable to enable this surface.</p>
        ) : (
          <form method="POST" action="/api/admin/unlock">
            <label className="block text-sm font-medium text-slate-700">Admin token</label>
            <input type="password" name="token" autoFocus className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Enter admin token" />
            {bad && <p className="mt-2 text-xs text-red-600">Incorrect token.</p>}
            <button type="submit" className="mt-3 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark">Unlock</button>
          </form>
        )}
      </div>
    </div>
  );
}

function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}

function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-white p-2.5 px-3">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className="text-[19px] font-medium" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="text-[9.5px] text-slate-400">{sub}</div>}
    </div>
  );
}

type DocRow = { doctor_uid: string; nnotes: number; idx: number; low_value: number; completeness: number };
type ReviewRow = { id: string; note_date: string; doctor_uid: string | null; band: string; note_quality_index: number; findings: unknown; n_low_value: number; n_interaction_alerts: number; completeness_pct: number };
type AllRow = { id: string; uid: string; note_date: string; doctor_uid: string | null; consult_type: string | null; prescription_type: string | null; band: string; note_quality_index: number; n_low_value: number; completeness_pct: number; findings: unknown };

const TYPE_SHORT: Record<string, string> = {
  GENERAL_PRACTITIONER: 'GP', HOSPITAL_GP: 'Hosp GP', HOSPITAL_GYNAECOLOGY_ASSESSMENT: 'Gynae',
  HOSPITAL_GYNAECOLOGY_OBSTETRICS: 'Obs-Gyn', HOSPITAL_PAEDIATRIC: 'Paeds', HOSPITAL_GP_INVESTIGATION_REFERRAL: 'GP-Ref',
};
function prettyType(t: string | null): string {
  if (!t) return 'OPD';
  return TYPE_SHORT[t] || t.toLowerCase().replace(/_/g, ' ');
}
function issueFrom(findings: unknown, completenessPct: number): string {
  const fs = parseJson<{ subject?: string; verdict?: string }[]>(findings, []);
  const lv = fs.find((f) => f.verdict === 'low-value') || fs[0];
  if (lv?.subject) return lv.subject;
  if (completenessPct < 60) return 'Documentation gaps';
  return 'Review';
}

export default async function OpdAuditAdmin({ searchParams }: { searchParams: Promise<{ day?: string; period?: string; locked?: string }> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;

  const period: Period = sp.period === 'week' ? 'week' : sp.period === 'month' ? 'month' : 'day';

  // Default day = latest IST date that has audits (so the page is never accidentally empty).
  const latest = await rowsOf<{ d: string }>(
    `SELECT to_char(max((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') d FROM opd_note_audits WHERE app_source = $1`,
    [APP],
  );
  const latestDay = latest[0]?.d || new Date().toISOString().slice(0, 10);
  const day = (sp.day && /^\d{4}-\d{2}-\d{2}$/.test(sp.day)) ? sp.day : latestDay;
  const { from, to } = istDateRange(day, period);
  const winParams = [APP, from, to];
  const WIN = `app_source = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3`;

  const [kpiR, bandsR, trendR, docsR, reviewR, allR] = await Promise.all([
    rowsOf<Record<string, unknown>>(
      `SELECT count(*)::int total, count(DISTINCT doctor_uid)::int doctors,
              round(avg(note_quality_index))::int mean_index,
              round(100.0*avg((band IN ('A','B'))::int))::int pct_good,
              round(100.0*avg((n_low_value>0)::int))::int low_value_rate,
              coalesce(sum(n_interaction_alerts),0)::int interactions,
              round(avg(completeness_pct))::int mean_completeness
       FROM opd_note_audits WHERE ${WIN}`, winParams),
    rowsOf<{ band: string; c: number }>(`SELECT band, count(*)::int c FROM opd_note_audits WHERE ${WIN} GROUP BY band`, winParams),
    rowsOf<{ d: string; idx: number; c: number }>(
      `SELECT to_char((note_date AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') d,
              round(avg(note_quality_index))::int idx, count(*)::int c
       FROM opd_note_audits
       WHERE app_source = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date > $2::date - 14
         AND (note_date AT TIME ZONE 'Asia/Kolkata')::date <= $2::date
       GROUP BY 1 ORDER BY 1`, [APP, to]),
    rowsOf<DocRow>(
      `SELECT doctor_uid, count(*)::int nnotes, round(avg(note_quality_index))::int idx,
              round(100.0*avg((n_low_value>0)::int))::int low_value, round(avg(completeness_pct))::int completeness
       FROM opd_note_audits WHERE ${WIN} AND doctor_uid IS NOT NULL
       GROUP BY doctor_uid ORDER BY nnotes DESC, idx ASC LIMIT 50`, winParams),
    rowsOf<ReviewRow>(
      `SELECT id, note_date, doctor_uid, band, note_quality_index, findings, n_low_value, n_interaction_alerts, completeness_pct
       FROM opd_note_audits WHERE ${WIN}
       ORDER BY note_quality_index ASC, n_low_value DESC LIMIT 12`, winParams),
    rowsOf<AllRow>(
      `SELECT id, uid, note_date, doctor_uid, consult_type, prescription_type, band, note_quality_index, n_low_value, completeness_pct, findings
       FROM opd_note_audits WHERE ${WIN}
       ORDER BY note_date DESC LIMIT 600`, winParams),
  ]);

  // Doctor names (db13 `doctors`) — render-time join; staff data, not PHI. Best-effort.
  const docUids = Array.from(new Set(([...docsR.map((d) => d.doctor_uid), ...reviewR.map((r) => r.doctor_uid), ...allR.map((r) => r.doctor_uid)].filter(Boolean)) as string[]));
  const names = await fetchDoctorNames(docUids).catch(() => ({} as Record<string, string>));
  const docName = (uid: string | null): string => (uid && names[uid]) || doctorLabel(uid);

  const allRows: AuditRow[] = allR.map((r) => ({
    id: String(r.id), time: fmtIstTime(r.note_date), doctor: docName(r.doctor_uid),
    consult: prettyType(r.prescription_type || r.consult_type), uid: String(r.uid || ''),
    band: r.band, index: n(r.note_quality_index), lowVal: n(r.n_low_value),
    issue: issueFrom(r.findings, n(r.completeness_pct)),
  }));

  const k = kpiR[0] || {};
  const total = n(k.total);
  const meanIndex = n(k.mean_index);
  const bandCounts: Record<string, number> = {};
  for (const b of bandsR) bandCounts[b.band] = n(b.c);
  const bandTotal = Object.values(bandCounts).reduce((s, x) => s + x, 0) || 1;
  const BANDS = ['A', 'B', 'C', 'D', 'E'];

  // trend sparkline points
  const trend = trendR.map((r) => ({ d: r.d, idx: n(r.idx) }));
  const tW = 320, tH = 56;
  const idxs = trend.map((p) => p.idx);
  const lo = Math.min(40, ...idxs, 100), hi = Math.max(90, ...idxs, 0);
  const pts = trend.length
    ? trend.map((p, i) => {
        const x = trend.length === 1 ? tW : (i / (trend.length - 1)) * tW;
        const y = tH - ((p.idx - lo) / Math.max(1, hi - lo)) * tH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ')
    : '';

  const periodLabel = period === 'day' ? fmtIstDateLong(day) : `${fmtIstDateLong(from)} → ${fmtIstDateLong(to)}`;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-brand">OPD Audit</div>
          <h1 className="font-serif text-[26px] font-semibold leading-tight text-slate-900 sm:text-[30px]">OPD note quality</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">{periodLabel} · every non-draft medical OPD note, run through Right Care. Advisory — a process &amp; documentation proxy, not a clinician scorecard.</p>
        </div>
        <form method="POST" action="/api/admin/unlock?action=logout"><button className="whitespace-nowrap text-xs text-slate-400 hover:text-brand">Lock</button></form>
      </div>

      {/* controls */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="flex overflow-hidden rounded-lg border border-slate-200">
          {(['day', 'week', 'month'] as Period[]).map((p) => (
            <Link key={p} href={`/admin/opd-audit?day=${day}&period=${p}`}
              className={`px-3 py-1.5 text-xs capitalize ${period === p ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{p}</Link>
          ))}
        </span>
        <span className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600">
          <Link href={`/admin/opd-audit?day=${addDays(day, -1)}&period=${period}`} className="px-1 hover:text-brand">‹</Link>
          <span className="tabular-nums">{day}</span>
          <Link href={`/admin/opd-audit?day=${addDays(day, 1)}&period=${period}`} className="px-1 hover:text-brand">›</Link>
        </span>
        {day !== latestDay && <Link href={`/admin/opd-audit?period=${period}`} className="text-xs text-brand hover:underline">latest</Link>}
      </div>

      {total === 0 ? (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No audits for this {period}. The nightly worker audits the prior day overnight (00:30–05:25 IST); pick another date, or trigger a backfill with <code className="rounded bg-slate-100 px-1">/api/opd-audit/worker?day={day}</code>.
        </div>
      ) : (
        <>
          {/* KPI strip */}
          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Notes audited" value={String(total)} sub={`${n(k.doctors)} doctors`} />
            <Kpi label="Mean quality" value={String(meanIndex)} sub={`Band ${bandFor(meanIndex)}`} color={scoreColor(meanIndex)} />
            <Kpi label="Good (A/B)" value={`${n(k.pct_good)}%`} color="#0f766e" />
            <Kpi label="Low-value" value={`${n(k.low_value_rate)}%`} sub="≥1 flag" color="#b45309" />
            <Kpi label="Interaction alerts" value={String(n(k.interactions))} color="#b91c1c" />
            <Kpi label="Completeness" value={`${n(k.mean_completeness)}%`} sub="NABH OPD" color={scoreColor(n(k.mean_completeness))} />
          </div>

          {/* trend + band distribution */}
          <div className="mt-3 flex flex-wrap gap-3">
            <div className="min-w-[240px] flex-[1.3] rounded-xl border border-slate-200 bg-white p-3">
              <div className="mb-1.5 text-[11.5px] text-slate-600">Quality index · last 14 days</div>
              <svg viewBox={`0 0 ${tW} ${tH}`} width="100%" height={tH} preserveAspectRatio="none">
                {pts && <polyline points={pts} fill="none" stroke="#0f766e" strokeWidth="2" />}
                {trend.map((p, i) => {
                  const x = trend.length === 1 ? tW : (i / (trend.length - 1)) * tW;
                  const y = tH - ((p.idx - lo) / Math.max(1, hi - lo)) * tH;
                  return <circle key={i} cx={x} cy={y} r="1.6" fill="#0f766e" />;
                })}
              </svg>
              <div className="text-[10px] text-slate-400">{trend.length ? `${trend[0].idx} → ${trend[trend.length - 1].idx} over ${trend.length} day(s)` : 'no history'}</div>
            </div>
            <div className="min-w-[200px] flex-1 rounded-xl border border-slate-200 bg-white p-3">
              <div className="mb-2 text-[11.5px] text-slate-600">Band distribution</div>
              <div className="flex h-4 overflow-hidden rounded">
                {BANDS.map((b) => bandCounts[b] ? <span key={b} title={`${b} ${bandCounts[b]}`} style={{ width: `${(bandCounts[b] / bandTotal) * 100}%`, background: bandColor(b) }} /> : null)}
              </div>
              <div className="mt-1 flex justify-between text-[9.5px] text-slate-400">
                {BANDS.map((b) => <span key={b}>{b} {Math.round(((bandCounts[b] || 0) / bandTotal) * 100)}%</span>)}
              </div>
            </div>
          </div>

          {/* by doctor + needs review */}
          <div className="mt-3 flex flex-wrap gap-3">
            <div className="min-w-[260px] flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-100 px-3 py-2 text-[11.5px] font-medium text-slate-600">By doctor <span className="font-normal text-slate-400">· {docsR.length}</span></div>
              <div className="max-h-[320px] overflow-y-auto">
                <table className="w-full text-[11.5px]">
                  <thead className="text-[10px] text-slate-400">
                    <tr><th className="px-3 py-1 text-left font-normal">doctor</th><th className="px-2 py-1 text-right font-normal">notes</th><th className="px-2 py-1 text-right font-normal">index</th><th className="px-3 py-1 text-right font-normal">low-val</th></tr>
                  </thead>
                  <tbody>
                    {docsR.map((d) => (
                      <tr key={d.doctor_uid} className="border-t border-slate-50">
                        <td className="px-3 py-1.5 text-slate-700">{docName(d.doctor_uid)}</td>
                        <td className="px-2 py-1.5 text-right text-slate-500">{n(d.nnotes)}</td>
                        <td className="px-2 py-1.5 text-right font-medium" style={{ color: scoreColor(n(d.idx)) }}>{n(d.idx)}</td>
                        <td className="px-3 py-1.5 text-right text-slate-500">{n(d.low_value)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="min-w-[260px] flex-[1.1] overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-amber-100 bg-amber-50/60 px-3 py-2 text-[11.5px] font-medium text-amber-800">Needs review — lowest {period === 'day' ? 'today' : 'this ' + period}</div>
              <div>
                {reviewR.map((r) => (
                  <Link key={r.id} href={`/admin/opd-audit/${r.id}`} className="flex items-center gap-2 border-b border-slate-50 px-3 py-2 text-[11.5px] hover:bg-slate-50">
                    <span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-white" style={{ background: bandColor(r.band) }}>{r.band}</span>
                    <span className="flex-1 truncate text-slate-700">{fmtIstTime(r.note_date)} · {docName(r.doctor_uid)} · {issueFrom(r.findings, n(r.completeness_pct))}</span>
                    <span className="text-slate-300">›</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>

          {/* browse / look up any note */}
          <AuditTable rows={allRows} />
        </>
      )}
    </div>
  );
}
