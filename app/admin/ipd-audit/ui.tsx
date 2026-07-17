// Shared server-safe chrome for the IPD Discharge Audit surface (S3): the unlock wall,
// the sub-tab row, the uncertainty-marked band chip, small formatters. No 'use client' —
// everything here renders on the server.
import Link from 'next/link';
import { bandColor } from '@/lib/opd-audit-ui';

/**
 * The HONEST band chip (S4 decision, option b): a single-run band is one noisy draw —
 * S4 measured ±1-band noise (1/25 band-stable at K=5) — so every per-row band carries an
 * explicit "±1 · provisional" marker. When a row someday has K runs (S5/S6), pass `range`
 * (e.g. "B–C") and the marker shows the observed range instead.
 */
export function BandChip({ band, cvi, range }: { band: string; cvi: number; range?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1" title={range ? `observed band range ${range} across repeats` : 'single-run estimate; ±1 band noise (S4-measured)'}>
      <span className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ background: bandColor(band) }}>{band} · {cvi}</span>
      <span className="text-[9.5px] font-medium text-slate-400">{range ? range : '±1 · provisional'}</span>
    </span>
  );
}

/** The admin unlock wall (mirrors the OPD-audit inline Locked idiom). */
export function Locked({ configured, bad }: { configured: boolean; bad?: boolean }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">IPD Discharge Audit</h1>
      <p className="mt-2 text-sm text-slate-500">
        {configured ? 'This surface is access-controlled. Enter the admin token to continue.' : 'ADMIN_TOKEN is not configured on this deployment.'}
      </p>
      {bad && <p className="mt-2 text-xs text-red-600">That token didn’t match — try again.</p>}
      {configured && (
        <form method="POST" action="/api/admin/unlock" className="mt-5 flex justify-center gap-2">
          <input type="hidden" name="next" value="/admin/ipd-audit" />
          <input name="token" type="password" placeholder="Admin token" className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white">Unlock</button>
        </form>
      )}
    </div>
  );
}

/** Sub-tab row: Overview · Search · Calendar. */
export function IpdTabs({ active }: { active: 'overview' | 'search' | 'calendar' }) {
  const tab = (href: string, key: string, label: string) => (
    <Link href={href} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${active === key ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'}`}>{label}</Link>
  );
  return (
    <div className="mt-4 flex items-center gap-2">
      {tab('/admin/ipd-audit', 'overview', 'Overview')}
      {tab('/admin/ipd-audit/search', 'search', 'Search')}
      {tab('/admin/ipd-audit/calendar', 'calendar', 'Calendar')}
    </div>
  );
}

/** The 7-stage pipeline strip — LVC is stage 3 and runs on EVERY summary by construction. */
export const PIPELINE_STAGES = [
  { n: 1, label: 'Fetch PDF', note: 'GCS, service account' },
  { n: 2, label: 'Extract', note: 'de-identified read' },
  { n: 3, label: 'Low-Value Care', note: 'every summary, intrinsic' },
  { n: 4, label: 'Idealised course', note: 'diff vs actual' },
  { n: 5, label: 'Care-Value score', note: 'deterministic, 6 domains' },
  { n: 6, label: 'Billing envelope', note: 'db13 join · coarse recon' },
  { n: 7, label: 'Persist', note: 'de-identified + link-back keys' },
] as const;

export function PipelineStrip() {
  return (
    <div className="mt-4 overflow-x-auto">
      <div className="flex min-w-[720px] items-stretch gap-1.5">
        {PIPELINE_STAGES.map((s) => (
          <div key={s.n} className={`flex-1 rounded-lg border px-2.5 py-2 ${s.n === 3 ? 'border-brand/40 bg-brand/5' : 'border-slate-200 bg-white'}`}>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Stage {s.n}</div>
            <div className={`text-[12.5px] font-semibold ${s.n === 3 ? 'text-brand' : 'text-slate-800'}`}>{s.label}</div>
            <div className="text-[10.5px] text-slate-500">{s.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
