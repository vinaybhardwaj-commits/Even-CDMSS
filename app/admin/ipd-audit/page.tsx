// /admin/ipd-audit — IPD Discharge Audit OVERVIEW (S3.1). Server-rendered; reads
// ipd_discharge_audits (renders an informative empty state while the table fills) + a db13
// filed-count for context. Access-controlled by the admin unlock; PHI never appears here —
// the overview is aggregate + link-back keys only.
import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { bandColor, istDateRange, fmtIstDateLong, type Period } from '@/lib/opd-audit-ui';
import { bandFor, DOMAIN_LABEL, DEFAULT_WEIGHTS, VALUE_DOMAINS } from '@/lib/value-score-core';
import { IPD_ENGINE_VERSION } from '@/lib/ipd-audit/store';
import { dischargeDocDensity } from '@/lib/ipd-audit/db13';
import { Locked, IpdTabs, PipelineStrip, addDays, todayIst } from './ui';

export const dynamic = 'force-dynamic';

const DOMAIN_COL: Record<string, string> = {
  appropriateness: 'score_appropriateness', efficiency: 'score_efficiency', safety: 'score_safety',
  cost: 'score_cost', documentation: 'score_documentation', patient_centred: 'score_patient_centred',
};

export default async function IpdAuditOverview({ searchParams }: { searchParams: Promise<{ day?: string; period?: string; locked?: string }> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;

  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.day ?? '') ? sp.day! : todayIst();
  const period: Period = sp.period === 'week' || sp.period === 'month' ? sp.period : 'day';
  const { from, to } = istDateRange(day, period);

  const domainSelect = VALUE_DOMAINS.map((d) => `round(avg(${DOMAIN_COL[d]}))::int AS ${DOMAIN_COL[d]}`).join(', ');
  const [statsRows, bandRows, recentRows, filed] = await Promise.all([
    sql(
      `SELECT count(*)::int AS total, round(avg(care_value_index))::int AS mean_cvi,
              round(avg(completeness_pct))::int AS mean_compl,
              sum(n_low_value)::int AS lv, sum(n_context_dependent)::int AS cd, ${domainSelect}
       FROM ipd_discharge_audits
       WHERE engine_version = $1 AND (coalesce(discharged_at, audited_at) AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date`,
      [IPD_ENGINE_VERSION, from, to],
    ) as unknown as Promise<Array<Record<string, unknown>>>,
    sql(
      `SELECT band, count(*)::int AS n FROM ipd_discharge_audits
       WHERE engine_version = $1 AND (coalesce(discharged_at, audited_at) AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date
       GROUP BY band`,
      [IPD_ENGINE_VERSION, from, to],
    ) as unknown as Promise<Array<{ band: string; n: number }>>,
    sql(
      `SELECT id, ip_uid, speciality, care_value_index, band, n_low_value, n_context_dependent, completeness_pct,
              to_char(audited_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') AS audited, engine_version
       FROM ipd_discharge_audits ORDER BY audited_at DESC LIMIT 20`,
    ) as unknown as Promise<Array<Record<string, unknown>>>,
    dischargeDocDensity(from, to).catch(() => ({} as Record<string, number>)),
  ]);

  const st = statsRows[0] ?? {};
  const total = Number(st.total ?? 0);
  const meanCvi = Number(st.mean_cvi ?? 0);
  const band = bandFor(meanCvi);
  const filedCount = Object.values(filed).reduce((a, b) => a + b, 0);
  const periodLabel = period === 'day' ? fmtIstDateLong(day) : `${fmtIstDateLong(from)} → ${fmtIstDateLong(to)}`;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">IPD Discharge Audit</div>
          <h1 className="font-serif text-[28px] font-semibold leading-tight text-slate-900 sm:text-[31px]">Discharge-summary quality</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] text-slate-500">{periodLabel} · every KareXpert discharge summary, read by the Case-Audit engine. Advisory — a process &amp; documentation proxy, not a clinician scorecard.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex overflow-hidden rounded-lg border border-slate-200">
            {(['day', 'week', 'month'] as Period[]).map((p) => (
              <Link key={p} href={`/admin/ipd-audit?day=${day}&period=${p}`} className={`px-3 py-1.5 text-xs capitalize ${period === p ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{p}</Link>
            ))}
          </span>
          <span className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600">
            <Link href={`/admin/ipd-audit?day=${addDays(day, -1)}&period=${period}`} className="px-1 hover:text-brand">‹</Link>
            <span className="tabular-nums">{day}</span>
            <Link href={`/admin/ipd-audit?day=${addDays(day, 1)}&period=${period}`} className="px-1 hover:text-brand">›</Link>
          </span>
          {day !== todayIst() && <Link href={`/admin/ipd-audit?period=${period}`} className="text-xs text-brand hover:underline">latest</Link>}
          <form method="POST" action="/api/admin/unlock?action=logout"><button className="whitespace-nowrap text-xs text-slate-400 hover:text-brand">Lock</button></form>
        </div>
      </div>

      <IpdTabs active="overview" />

      {total === 0 ? (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No audits for this {period} yet{filedCount > 0 ? <> — <b>{filedCount}</b> discharge summar{filedCount === 1 ? 'y was' : 'ies were'} filed in the period</> : null}.
          Audit one from <Link href="/admin/ipd-audit/calendar" className="text-brand hover:underline">the calendar</Link> or <Link href="/admin/ipd-audit/search" className="text-brand hover:underline">search</Link>; the daily worker (S5) will fill this automatically.
        </div>
      ) : (
        <>
          {/* HERO band card */}
          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="flex flex-col gap-5 p-5 sm:flex-row">
              <div className="flex shrink-0 flex-row items-center gap-4 border-b border-slate-100 pb-4 sm:w-[132px] sm:flex-col sm:gap-1 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-5">
                <div className="font-serif text-[58px] font-semibold leading-none" style={{ color: bandColor(band) }}>{band}</div>
                <div className="flex flex-col sm:items-center">
                  <div className="text-[13px] text-slate-500"><span className="font-serif text-[18px] font-semibold text-slate-800">{meanCvi}</span> / 100</div>
                  <div className="mt-1 rounded-md px-2 py-0.5 text-[11px] font-semibold text-white" style={{ background: bandColor(band) }}>{meanCvi >= 70 ? 'On track' : meanCvi >= 55 ? 'Watch' : 'Needs attention'}</div>
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-serif text-[16.5px] font-semibold text-slate-900">{period === 'day' ? `How ${fmtIstDateLong(day)} looked` : 'How this period looked'}</h2>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-700">
                  <b>{total} discharge summar{total === 1 ? 'y' : 'ies'}</b> audited ({filedCount} filed). Mean Care-Value Index <b style={{ color: bandColor(band) }}>{meanCvi}</b>, completeness <b>{Number(st.mean_compl ?? 0)}%</b>, with <b>{Number(st.lv ?? 0)}</b> low-value and <b>{Number(st.cd ?? 0)}</b> context-dependent findings.
                  {' '}Bands: {bandRows.sort((a, b) => a.band.localeCompare(b.band)).map((b) => `${b.band}×${b.n}`).join(' · ') || '—'}.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-[10px] text-slate-400">E</span>
                  <div className="relative h-2 flex-1 rounded-full" style={{ background: 'linear-gradient(90deg,#dc2626 0%,#ea580c 28%,#d97706 50%,#16a34a 74%,#0d9488 100%)' }}>
                    <span className="absolute top-[-3px] h-[14px] w-[3px] rounded-sm bg-slate-900 ring-2 ring-white" style={{ left: `${Math.max(0, Math.min(100, meanCvi))}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-400">A</span>
                </div>
              </div>
            </div>
          </div>

          {/* six Care-Value domain pillars */}
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {VALUE_DOMAINS.map((d) => {
              const score = st[DOMAIN_COL[d]] == null ? null : Number(st[DOMAIN_COL[d]]);
              return (
                <div key={d} className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-[11px] font-semibold text-slate-500">{DOMAIN_LABEL[d]}</div>
                  <div className="mt-1 font-serif text-[24px] font-semibold leading-none text-slate-900">{score ?? '—'}</div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-slate-100">
                    <div className="h-1.5 rounded-full bg-brand" style={{ width: `${score ?? 0}%` }} />
                  </div>
                  <div className="mt-1 text-[10px] text-slate-400">weight {Math.round(DEFAULT_WEIGHTS[d] * 100)}%</div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <PipelineStrip />

      {/* recent audits */}
      <div className="mt-5 rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-3 text-[13px] font-semibold text-slate-800">Recent audits</div>
        {recentRows.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-slate-500">Nothing audited yet.</div>
        ) : (
          <table className="w-full text-left text-[12.5px]">
            <thead><tr className="text-[11px] uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2">IP</th><th className="px-2 py-2">Speciality</th><th className="px-2 py-2">CVI</th>
              <th className="px-2 py-2">Findings</th><th className="px-2 py-2">Compl.</th><th className="px-2 py-2">Audited</th><th className="px-2 py-2">Engine</th>
            </tr></thead>
            <tbody>
              {recentRows.map((r) => (
                <tr key={String(r.id)} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2"><Link href={`/admin/ipd-audit/${r.id}`} className="font-semibold text-brand hover:underline">{String(r.ip_uid ?? r.id).slice(0, 18)}</Link></td>
                  <td className="px-2 py-2 text-slate-600">{String(r.speciality ?? '—')}</td>
                  <td className="px-2 py-2"><span className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ background: bandColor(String(r.band)) }}>{String(r.band)} · {Number(r.care_value_index)}</span></td>
                  <td className="px-2 py-2 text-slate-600">{Number(r.n_low_value)} LV · {Number(r.n_context_dependent)} CD</td>
                  <td className="px-2 py-2 text-slate-600">{r.completeness_pct == null ? '—' : `${Number(r.completeness_pct)}%`}</td>
                  <td className="px-2 py-2 text-slate-500">{String(r.audited)}</td>
                  <td className="px-2 py-2 text-slate-400">{String(r.engine_version).replace('ipd-discharge-audit/', '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
