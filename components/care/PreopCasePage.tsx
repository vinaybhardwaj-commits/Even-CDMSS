'use client';

/**
 * /care/preop/case/[key] — everything the board asserts, proven (mockup §2).
 *
 * The factor tables with per-input provenance, the snapshot timeline that is the module's
 * core demo, and the anaesthetist's own verdict displayed alongside — never replaced.
 * ALL judgement lives in the pure cores; this file is markup and fetch, and it recomputes
 * nothing: what it renders is the snapshot the sweep stored.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { FactorRow, InstrumentScore } from '@/lib/preop-instruments-core';
import { charlsonPanelLine, mfi5PanelLine, rcriPanelLine, type Tier } from '@/lib/preop-tier-core';
import {
  cardChips, caseSubtitle, daysToSurgery, identityLine, isReviewed, longDate, pacBanner,
  pacChip, provenanceChip, reviewState, shortDate, whenText,
  CORRELATED_LENSES_NOTE, PAC_BANNER_NOTE, PROVENANCE_CHIPS, REVIEW_LABEL, SCORES_FOOTER,
  TIER_GLYPH, type PreopCardRow, type PreopProvenance,
} from '@/lib/preop-surface-core';

interface ResolvedInput {
  inputId: string; status: string; detail: string | null; value: string | number | null;
  source: string | null; confidence: number | null; conflict: boolean; closedWorld: boolean;
  corroborating?: Array<{ source: string }>;
}
interface Snapshot {
  inputs?: ResolvedInput[];
  rcri?: InstrumentScore; mfi5?: InstrumentScore; charlson?: InstrumentScore;
  lines?: { why: string; missing: string; situation: string };
  pac?: { workflowStatus?: string | null };
}
interface VersionRow {
  captured_at: string; capture_reason: string; version_no: number | null; tier: string | null;
  rcri_lo: number | null; rcri_hi: number | null; mfi_lo: number | null; mfi_hi: number | null;
  cci_lo: number | null; cci_hi: number | null;
}
interface Payload {
  ok: boolean; engine: string; row: PreopCardRow; snapshot: Snapshot | null;
  versions: VersionRow[]; extraction: string; narrative: string; error: string | null;
}

const TIER_PILL: Record<Tier, string> = {
  CRITICAL: 'bg-red-800 border-red-800 text-white',
  RED: 'bg-red-50 border-red-200 text-red-700',
  AMBER: 'bg-amber-50 border-amber-200 text-amber-800',
  GREEN: 'bg-emerald-50 border-emerald-200 text-emerald-800',
};

function istToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const band = (n: number | null, m: number | null) => (n == null ? '—' : n === m ? String(n) : `${n}–${m}`);

export default function PreopCasePage({ episodeKey }: { episodeKey: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setFailed(null);
    try {
      const r = await fetch(`/api/care/preop/case?key=${encodeURIComponent(episodeKey)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 404 ? 'no case at this key for the current engine version' : `the case could not load (HTTP ${r.status})`);
      setData((await r.json()) as Payload);
    } catch (e) { setFailed(String((e as Error).message)); }
  }, [episodeKey]);

  useEffect(() => { void load(); }, [load]);

  const markReviewed = useCallback(async () => {
    if (!data?.row.versionNo) return;
    setSaving(true);
    try {
      const r = await fetch('/api/care/preop/review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeKey, versionNo: data.row.versionNo }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `could not save (HTTP ${r.status})`);
      }
      await load();
    } catch (e) { setFailed(String((e as Error).message)); } finally { setSaving(false); }
  }, [data, episodeKey, load]);

  if (failed && !data) return <Shell><Back /><div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-[13px] text-rose-800">{failed}</div></Shell>;
  if (!data) return <Shell><Back /><div className="mt-6 text-[13px] text-slate-500">Loading the case…</div></Shell>;

  const { row, snapshot } = data;
  const id = identityLine(row);
  const today = istToday();
  const days = daysToSurgery(today, row.surgeryDate);
  const banner = pacBanner(row);
  const pac = pacChip(row, new Date().toISOString());
  const rev = reviewState(row);
  const tier = row.tier ?? 'AMBER';
  const inputs = snapshot?.inputs ?? [];
  const byId = new Map(inputs.map((i) => [i.inputId, i]));

  return (
    <Shell>
      <Back />
      {failed && <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800">{failed}</div>}

      {/* header */}
      <div className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[17px] font-semibold text-slate-900">
              {id.name}{id.sub && <span className="ml-2 text-[12px] font-normal text-slate-400">{id.sub}</span>}
            </h1>
            <div className="mt-0.5 text-[12.5px] text-slate-600">{caseSubtitle(row)}</div>
            <div className="mt-0.5 text-[12px] text-slate-500">{longDate(row.surgeryDate)} · {whenText(days)}</div>
          </div>
          <div className="text-right">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[2px] text-[10.5px] font-bold tracking-wide ${TIER_PILL[tier]}`}>
              <span aria-hidden>{TIER_GLYPH[tier]}</span>{tier}
            </span>
            <div className="mt-1 text-[11px] text-slate-400">snapshot v{row.versionNo ?? 1}{row.computedAt ? ` · ${shortDate(row.computedAt)}` : ''}</div>
            <div className="mt-1.5">
              {isReviewed(row)
                ? <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-[2px] text-[10.5px] text-emerald-800">{rev.label}</span>
                : <button onClick={() => void markReviewed()} disabled={saving}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 disabled:opacity-50">
                    {saving ? 'Saving…' : rev.reopened ? 'Re-review' : REVIEW_LABEL}
                  </button>}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className={`rounded-full border px-2 py-[2px] text-[10.5px] ${
            pac.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : pac.tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-slate-200 bg-white text-slate-500'}`}>{pac.text}</span>
          {row.bookingOnly && <span className="rounded-full border border-slate-200 bg-white px-2 py-[2px] text-[10.5px] text-slate-500">booking-only</span>}
        </div>

        {/* the anaesthetist's own words, in the most prominent slot — never replaced */}
        <div className={`mt-3 rounded-xl px-3.5 py-3 ${banner.tone === 'quoted' ? 'bg-[#002054] text-white' : 'border border-amber-200 bg-amber-50'}`}>
          <div className={`text-[10px] uppercase tracking-widest ${banner.tone === 'quoted' ? 'text-slate-300' : 'text-amber-700'}`}>{banner.label}</div>
          <div className={`mt-1 whitespace-pre-line text-[13px] font-semibold ${banner.tone === 'quoted' ? 'text-white' : 'text-amber-900'}`}>
            {banner.tone === 'quoted' ? `“${banner.text}”` : banner.text}
          </div>
          <div className={`mt-1.5 text-[10.5px] italic ${banner.tone === 'quoted' ? 'text-slate-300' : 'text-amber-700'}`}>
            {banner.caveat ? `${banner.caveat} ${PAC_BANNER_NOTE}` : PAC_BANNER_NOTE}
          </div>
        </div>

        <div className="mt-3"><ChipRow row={row} /></div>
        {row.whyLine && <p className="mt-2 text-[12px] text-slate-600"><b className="font-semibold text-slate-900">Why:</b> {row.whyLine}</p>}
        {row.missingLine && <p className="mt-1 text-[12px] font-medium text-amber-800">{row.missingLine}</p>}
        {row.situationLine && <p className="mt-1 text-[12px] font-semibold text-red-700">{row.situationLine}</p>}
      </div>

      {/* the timeline — how this score ripened */}
      <Section title="Snapshot history — how this score ripened">
        <ol className="mt-1 space-y-1.5">
          {data.versions.map((v) => (
            <li key={`${v.captured_at}-${v.version_no}`} className="flex flex-wrap items-baseline gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px]">
              <span className="font-semibold text-slate-900">v{v.version_no ?? '—'}</span>
              <span className="text-slate-400">{shortDate(v.captured_at)}</span>
              <span className="text-slate-600">RCRI {band(v.rcri_lo, v.rcri_hi)} · mFI {band(v.mfi_lo, v.mfi_hi)} · CCI {band(v.cci_lo, v.cci_hi)}</span>
              <span className="ml-auto rounded-full border border-slate-200 px-2 py-[1px] text-[10px] text-slate-400">capture: {v.capture_reason}</span>
            </li>
          ))}
          <li className="flex flex-wrap items-baseline gap-2 rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-2 text-[12px]">
            <span className="font-semibold text-slate-900">v{row.versionNo ?? 1}</span>
            <span className="text-slate-400">{shortDate(row.computedAt)}</span>
            <span className="text-slate-600">
              RCRI {band(row.rcri?.lo ?? null, row.rcri?.hi ?? null)} · mFI {band(row.mfi5?.lo ?? null, row.mfi5?.hi ?? null)} · CCI {band(row.charlson?.lo ?? null, row.charlson?.hi ?? null)}
            </span>
            <span className="ml-auto rounded-full border border-blue-200 bg-white px-2 py-[1px] text-[10px] text-blue-700">current · live row</span>
          </li>
        </ol>
        {!data.versions.length && (
          <p className="mt-1.5 text-[11.5px] text-slate-400">
            One snapshot so far — nothing has changed since this episode was first computed. A new lab, a finalized PAC or a corrected comorbidity mints the next step.
          </p>
        )}
      </Section>

      {/* the factor tables */}
      {snapshot?.rcri && <FactorTable title={`RCRI — Revised Cardiac Risk Index · ${band(snapshot.rcri.lo, snapshot.rcri.hi)} of 6`}
        score={snapshot.rcri} byId={byId} footer={rcriPanelLine(snapshot.rcri)} />}
      {snapshot?.mfi5 && <FactorTable title={`mFI-5 — Modified Frailty Index · ${band(snapshot.mfi5.lo, snapshot.mfi5.hi)} of 5`}
        score={snapshot.mfi5} byId={byId} footer={mfi5PanelLine(snapshot.mfi5)} />}
      {snapshot?.charlson && <FactorTable title={`Charlson Comorbidity Index · ${band(snapshot.charlson.lo, snapshot.charlson.hi)}`}
        score={snapshot.charlson} byId={byId} footer={charlsonPanelLine(snapshot.charlson)} onlyScoring />}

      <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11.5px] text-slate-600">{CORRELATED_LENSES_NOTE}</p>

      {/* the narrative rail, rendered visibly OFF (mockup note 6) */}
      <Section title="Narrative — rail dark">
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3.5 py-3 text-[12px] text-slate-500">
          Ships behind <code className="rounded bg-white px-1 text-[11px]">PREOP_NARRATIVE_ENABLED={data.narrative === 'on' ? '1' : '0'}</code>.
          When flipped, prose is written from the factor tables above — the model summarises a computed result, it never scores.
          Model label derived from the call, never typed.
        </div>
      </Section>

      {/* provenance legend — five chips (Amendment A1-2) */}
      <Section title="Every input above carries provenance">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(PROVENANCE_CHIPS) as PreopProvenance[]).map((k) => (
            <span key={k} title={PROVENANCE_CHIPS[k].title}
              className={`rounded-md border px-2 py-[2px] text-[10.5px] ${sourceClass(k)}`}>{PROVENANCE_CHIPS[k].label}</span>
          ))}
        </div>
        <p className="mt-1.5 text-[11.5px] text-slate-500">
          Pink marks the model boundary; below the confidence floor an extracted input is treated as UNKNOWN and the instrument
          widens to a range. Extraction is currently <b>{data.extraction}</b>.
        </p>
      </Section>

      <p className="mt-5 border-t border-slate-200 pt-3 text-[11.5px] leading-relaxed text-slate-400">{SCORES_FOOTER}</p>
    </Shell>
  );
}

function sourceClass(source: string | null): string {
  switch (source) {
    case 'LAB': return 'border-sky-200 bg-sky-50 text-sky-800';
    case 'PAC': return 'border-indigo-200 bg-indigo-50 text-indigo-800';
    case 'OPD': return 'border-teal-200 bg-teal-50 text-teal-800';
    case 'BOOKING': return 'border-slate-200 bg-white text-slate-600';
    case 'EXTRACTED': return 'border-pink-200 bg-pink-50 text-pink-700';
    default: return 'border-slate-200 bg-white text-slate-400';
  }
}

function FactorTable({ title, score, byId, footer, onlyScoring }: {
  title: string; score: InstrumentScore; byId: Map<string, ResolvedInput>; footer: string; onlyScoring?: boolean;
}) {
  // Charlson has nineteen categories; showing all of them on every case would bury the
  // three that matter. Its table shows what SCORES plus anything still unknown.
  const rows: FactorRow[] = onlyScoring
    ? score.factors.filter((f) => f.points > 0 || f.status === 'unknown')
    : score.factors;
  return (
    <Section title={title}>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[520px] text-[12px]">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
              <th className="px-3 py-2 text-left font-bold">Factor</th>
              <th className="px-3 py-2 text-left font-bold">Status</th>
              <th className="px-3 py-2 text-left font-bold">Source</th>
              <th className="px-3 py-2 text-right font-bold">Pts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => {
              const input = byId.get(f.id);
              return (
                <tr key={f.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 text-slate-800">{f.label}</td>
                  <td className="px-3 py-2">
                    <span className={`font-semibold ${f.status === 'present' ? 'text-slate-900' : f.status === 'unknown' ? 'text-amber-700' : 'text-slate-400'}`}>
                      {f.status.toUpperCase()}
                    </span>
                    {input?.detail && <span className="ml-1.5 text-slate-500">{input.detail}</span>}
                    {input?.conflict && <span className="ml-1.5 rounded border border-amber-200 bg-amber-50 px-1 text-[10px] text-amber-800">sources conflict</span>}
                  </td>
                  <td className="px-3 py-2">
                    {input?.source
                      ? <span className={`rounded border px-1.5 py-[1px] text-[10px] ${sourceClass(input.source)}`}>
                          {provenanceChip(input.source)?.label ?? input.source}
                          {input.confidence != null && ` · ${input.confidence.toFixed(2)}`}
                        </span>
                      : <span className="text-[10.5px] text-slate-300">— not observed</span>}
                    {input?.closedWorld && <span className="ml-1 text-[10px] text-slate-400">(not listed on the booking form)</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{f.points}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11.5px] font-medium text-slate-600">{footer}</p>
    </Section>
  );
}

function ChipRow({ row }: { row: PreopCardRow }) {
  const chips = cardChips(row);
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span key={c.instrument}
          className={`rounded-lg px-2.5 py-1 text-[11.5px] ${c.dashed ? 'border border-dashed border-slate-300 bg-slate-50/60' : 'border border-slate-200 bg-white'}`}>
          {c.title} <b className="tabular-nums text-slate-900">{c.score}</b>
          {c.cls && <span className="ml-1 text-[10.5px] text-slate-400">{c.cls}</span>}
        </span>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="mb-1.5 text-[13px] font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

function Back() {
  return (
    <Link href="/care/preop" className="inline-flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-slate-800">
      <ArrowLeft className="h-3.5 w-3.5" /> Pre-op Risk
    </Link>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-4xl px-5 py-6" style={{ fontFamily: 'system-ui, sans-serif' }}>{children}</div>;
}
