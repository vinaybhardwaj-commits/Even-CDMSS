import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Department stewardship · Admin · CAT' };

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const n = (v: unknown): number => Number(v ?? 0);

type DeptRow = {
  dept: string; n_notes: number; avg_nqi: number; pct_ab: number;
  avg_appr: number; avg_presc: number; avg_doc: number; avg_complete: number;
  pct_low: number; sum_low: number; sum_interactions: number;
};

const WINDOW_DAYS = 90;

// Latest audit per note (DISTINCT ON uid) over the window, joined to the doctor_directory for a
// real speciality (the source consult_type is blank), aggregated by speciality. Nested subquery
// because Neon's HTTP driver can't GROUP BY over a DISTINCT ON in one pass. The directory is synced
// from db13 via /api/admin/sync-doctor-directory; a missing table is caught → empty state.
const DEPT_SQL = `
  SELECT COALESCE(NULLIF(dd.speciality, ''), 'Unspecified') AS dept,
    count(*)::int AS n_notes,
    round(avg(note_quality_index))::int AS avg_nqi,
    round(100.0 * avg(CASE WHEN band IN ('A','B') THEN 1 ELSE 0 END))::int AS pct_ab,
    round(avg(score_appropriateness))::int AS avg_appr,
    round(avg(score_prescribing_safety))::int AS avg_presc,
    round(avg(score_documentation))::int AS avg_doc,
    round(avg(completeness_pct))::int AS avg_complete,
    round(100.0 * avg(CASE WHEN n_low_value > 0 THEN 1 ELSE 0 END))::int AS pct_low,
    sum(n_low_value)::int AS sum_low,
    sum(n_interaction_alerts)::int AS sum_interactions
  FROM (
    SELECT DISTINCT ON (uid) uid, doctor_uid, note_quality_index, band,
      score_appropriateness, score_prescribing_safety, score_documentation,
      completeness_pct, n_low_value, n_interaction_alerts
    FROM opd_note_audits
    WHERE app_source = $1 AND note_date >= NOW() - ($2 || ' days')::interval
    ORDER BY uid, audited_at DESC
  ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  GROUP BY 1
  ORDER BY n_notes DESC`;

const TOTAL_SQL = `
  SELECT count(*)::int AS n_notes,
    round(avg(note_quality_index))::int AS avg_nqi,
    round(100.0 * avg(CASE WHEN band IN ('A','B') THEN 1 ELSE 0 END))::int AS pct_ab,
    round(100.0 * avg(CASE WHEN n_low_value > 0 THEN 1 ELSE 0 END))::int AS pct_low,
    sum(n_low_value)::int AS sum_low,
    sum(n_interaction_alerts)::int AS sum_interactions
  FROM (
    SELECT DISTINCT ON (uid) uid, note_quality_index, band, n_low_value, n_interaction_alerts
    FROM opd_note_audits
    WHERE app_source = $1 AND note_date >= NOW() - ($2 || ' days')::interval
    ORDER BY uid, audited_at DESC
  ) t`;

function scoreClass(v: number): string {
  if (v >= 80) return 'text-emerald-700';
  if (v >= 60) return 'text-amber-600';
  return 'text-red-600';
}
function riskClass(pct: number): string {
  if (pct >= 40) return 'text-red-600 font-medium';
  if (pct >= 20) return 'text-amber-600';
  return 'text-slate-600';
}

function Locked() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">Department stewardship</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock an admin surface</Link> first.</p>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 font-serif text-[24px] font-semibold text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-slate-500">{sub}</div>}
    </div>
  );
}

export default async function StewardshipPage() {
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <Locked />; }

  const [deptRaw, totalRaw] = await Promise.all([
    run(DEPT_SQL, [APP, String(WINDOW_DAYS)]).catch(() => []),
    run(TOTAL_SQL, [APP, String(WINDOW_DAYS)]).catch(() => []),
  ]);

  const depts: DeptRow[] = deptRaw.map((r) => ({
    dept: String(r.dept || 'Unspecified'), n_notes: n(r.n_notes), avg_nqi: n(r.avg_nqi), pct_ab: n(r.pct_ab),
    avg_appr: n(r.avg_appr), avg_presc: n(r.avg_presc), avg_doc: n(r.avg_doc), avg_complete: n(r.avg_complete),
    pct_low: n(r.pct_low), sum_low: n(r.sum_low), sum_interactions: n(r.sum_interactions),
  }));
  const t = totalRaw[0] || {};

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand">STEWARDSHIP</div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">Department stewardship</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-500">
        Note-quality and care-appropriateness across departments, from the daily OPD audits (last {WINDOW_DAYS} days, latest audit per note).
        <span className="text-slate-600"> Department-level only — no individual clinicians. A process &amp; appropriateness lens, not a clinician score.</span>
      </p>

      {depts.length === 0 ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-6 text-center text-[13px] text-slate-500">
          No audits in the window yet.
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Notes audited" value={n(t.n_notes).toLocaleString()} sub={`${depts.length} departments`} />
            <Stat label="Avg note-quality" value={String(n(t.avg_nqi))} sub={`${n(t.pct_ab)}% in band A–B`} />
            <Stat label="Notes w/ low-value" value={`${n(t.pct_low)}%`} sub={`${n(t.sum_low).toLocaleString()} findings total`} />
            <Stat label="Interaction alerts" value={n(t.sum_interactions).toLocaleString()} sub="across audited notes" />
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[10.5px] uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2.5 font-medium">Department</th>
                  <th className="px-3 py-2.5 text-right font-medium">Notes</th>
                  <th className="px-3 py-2.5 text-right font-medium">Avg NQI</th>
                  <th className="px-3 py-2.5 text-right font-medium">% A–B</th>
                  <th className="px-3 py-2.5 text-right font-medium">Appropriate&shy;ness</th>
                  <th className="px-3 py-2.5 text-right font-medium">Prescribing safety</th>
                  <th className="px-3 py-2.5 text-right font-medium">Complete&shy;ness</th>
                  <th className="px-3 py-2.5 text-right font-medium">Low-value %</th>
                  <th className="px-3 py-2.5 text-right font-medium">Interaction alerts</th>
                </tr>
              </thead>
              <tbody>
                {depts.map((d) => (
                  <tr key={d.dept || 'none'} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-3 py-2.5 font-medium text-slate-800">{d.dept}</td>
                    <td className="px-3 py-2.5 text-right text-slate-600">{d.n_notes.toLocaleString()}</td>
                    <td className={`px-3 py-2.5 text-right font-medium ${scoreClass(d.avg_nqi)}`}>{d.avg_nqi}</td>
                    <td className="px-3 py-2.5 text-right text-slate-600">{d.pct_ab}%</td>
                    <td className={`px-3 py-2.5 text-right ${scoreClass(d.avg_appr)}`}>{d.avg_appr}</td>
                    <td className={`px-3 py-2.5 text-right ${scoreClass(d.avg_presc)}`}>{d.avg_presc}</td>
                    <td className={`px-3 py-2.5 text-right ${scoreClass(d.avg_complete)}`}>{d.avg_complete}%</td>
                    <td className={`px-3 py-2.5 text-right ${riskClass(d.pct_low)}`}>{d.pct_low}%</td>
                    <td className={`px-3 py-2.5 text-right ${d.sum_interactions > 0 ? 'text-amber-600' : 'text-slate-400'}`}>{d.sum_interactions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-[11px] text-slate-400">
            Scores 0–100; green ≥80, amber 60–79, red &lt;60. Departments with few audited notes will read noisily until volume builds.
            Aggregated from de-identified audit records; no patient or clinician identifiers shown.
          </p>
        </>
      )}
    </div>
  );
}
