// Shared server-safe chrome for the IPD EPISODE audit surface (PRD §10). No 'use client' —
// everything here renders on the server, mirroring app/admin/ipd-audit/ui.tsx.
//
// ONE SEMANTIC RULE THIS FILE KEEPS. The episode engine produces a DIVERGENCE INDEX, not a
// care-value band. It deliberately does not import the A–E band palette (`bandColor` /
// `opd-audit-ui`) for its own number: borrowing another engine's colour vocabulary would make two
// different measurements look like one. The only band on this surface is the DISCHARGE ENGINE's,
// rendered as its own labelled chip.
import Link from 'next/link';

/** The verbatim label PRD §10 item 5 requires above the commentary block. */
export const OUTCOME_AWARE_NOTICE = 'This commentary was written with knowledge of the patient outcome. The scores above were not.';

/** The verbatim empty-findings copy (PRD §10). */
export const NO_DIVERGENCE_COPY = 'No divergence found against the expected course.';

/**
 * ⚠️ A NUMBER IS ONLY SHOWN WHEN THERE IS ONE TO SHOW.
 *
 * `divergence_index` counts down from 100, so an episode where no expectation was ever formed
 * scores 100 — identical to an admission that ran perfectly. That is the most dangerous output
 * this engine can produce, because a clinician reading 100 has no way to tell the two apart. When
 * `scoring_status` is anything but 'ok', this renders "not scorable" and says why, instead of a
 * figure someone might act on.
 */
export function DivergenceChip({ index, status }: { index: number | null; status?: string | null }) {
  const st = status ?? 'ok';
  if (st !== 'ok' || index == null) {
    const why = st === 'no_expectations' ? 'no checkpoint produced an expected course, so nothing could be measured'
      : st === 'all_capped' ? 'every finding was capped — nothing survived at full weight'
      : 'no score was stored for this episode';
    return (
      <span className="inline-flex items-baseline gap-1" title={why}>
        <span className="text-[13px] font-semibold text-amber-700">not scorable</span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
          {st === 'ok' ? 'no score' : st.replace(/_/g, ' ')}
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-1" title="100 minus 8·major + 4·moderate + 1·minor over divergent findings from both passes">
      <span className="text-[15px] font-semibold tabular-nums text-slate-900">{index}</span>
      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">divergence</span>
    </span>
  );
}

/**
 * The sibling engine's score, ALWAYS labelled as its own (decision 14). A missing row is stated
 * plainly rather than shown as a zero — "not audited" and "scored zero" are different facts.
 */
export function DischargeEngineScore({ cvi, band }: { cvi: number | null; band: string | null }) {
  if (cvi == null) return <span className="text-[11.5px] text-slate-400">not audited by discharge engine</span>;
  return (
    <span className="inline-flex items-baseline gap-1" title="produced by the sibling ipd-discharge-audit/0.2 engine, not by this one">
      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Discharge engine score</span>
      <span className="text-[13px] font-semibold tabular-nums text-slate-700">{cvi}{band ? ` · ${band}` : ''}</span>
    </span>
  );
}

export function EpisodeTabs({ active }: { active: 'episodes' }) {
  const tab = (href: string, key: string, label: string) => (
    <Link href={href} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${active === key ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'}`}>{label}</Link>
  );
  return (
    <div className="mt-4 flex items-center gap-2">
      {tab('/admin/ipd-audit', 'overview', 'Discharge audit')}
      {tab('/admin/ipd-audit/episodes', 'episodes', 'Episode audits')}
    </div>
  );
}

/** The admin unlock wall, mirroring the IPD surface's inline Locked idiom. */
export function Locked({ configured, bad }: { configured: boolean; bad?: boolean }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">IPD Episode Audit</h1>
      <p className="mt-2 text-sm text-slate-500">
        {configured ? 'This surface is access-controlled. Enter the admin token to continue.' : 'ADMIN_TOKEN is not configured on this deployment.'}
      </p>
      {bad && <p className="mt-2 text-xs text-red-600">That token didn’t match — try again.</p>}
      {configured && (
        <form method="POST" action="/api/admin/unlock" className="mt-5 flex justify-center gap-2">
          <input type="hidden" name="next" value="/admin/ipd-audit/episodes" />
          <input name="token" type="password" placeholder="Admin token" className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white">Unlock</button>
        </form>
      )}
    </div>
  );
}

export function fmtDay(v: unknown): string {
  if (v == null) return '—';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtStamp(v: unknown): string {
  if (v == null) return 'time not recorded';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
