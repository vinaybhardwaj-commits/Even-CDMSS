'use client';

// PromsPanel — PROMs 0.2a-2 surgical-recovery tracker (per the approved normative mockup). Mounted on
// the member workspace behind PROMS_ENABLED (server-read prop). Fetches the compiled schedule from
// /api/care-call/proms/schedule, administers the open window's house/CORE items VERBATIM (chips = each
// item's scale), previews the DETERMINISTIC score client-side (scoreInstrument, the same pure fn the
// server authoritatively re-runs on save), surfaces ⚠ escalations, and posts each administration.
// WHODAS-12 + PREM show "pending" until their verbatim item text is entered (WHO source / V-supplied).

import { useEffect, useMemo, useState } from 'react';
import { Loader2, ClipboardList, CalendarDays, Target, Mic, Calculator, AlertTriangle } from 'lucide-react';
import type { SurgicalSeries } from '@/lib/proms/schedule';
import type { DueInstrument } from '@/lib/proms/schedule-core';
import { scoreInstrument, type ItemResponse } from '@/lib/proms/schedule-core';
import { instrumentById, SHARED_SCALES, ARCHETYPE_WINDOWS, ESCALATION, type Window, type Scale } from '@/lib/proms/catalog';

interface Administered { instrument_id: string; window: string; administered_at: string; score: number | null; score_scale: string; escalations: string[] }
interface ScheduleResp { ok: boolean; series: SurgicalSeries | null; administered?: Administered[] }

const WINDOW_LABEL: Record<Window, string> = {
  baseline: 'Baseline pre-op', d72h: '72 hours', w2: '2 weeks', w6: '6 weeks', m3: '3 months', m6: '6 months', m12: '12 months',
};
const day = (s: string | null | undefined) => (typeof s === 'string' ? s.slice(0, 10) : '');
const escLabel = (code: string) => ESCALATION.find((e) => e.code === code)?.rule ?? code;

export default function PromsPanel({ individualUid }: { individualUid: string }) {
  const [data, setData] = useState<ScheduleResp | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [answers, setAnswers] = useState<Record<string, string>>({});   // `${instrumentId}:${itemId}` → value
  const [saved, setSaved] = useState<string>('');

  useEffect(() => {
    let alive = true;
    setState('loading');
    fetch(`/api/care-call/proms/schedule?individual_uid=${encodeURIComponent(individualUid)}`)
      .then(async (r) => (r.ok ? r.json() : { __status: r.status }))
      .then((j: ScheduleResp & { __status?: number }) => {
        if (!alive) return;
        if (j?.ok && j.series) { setData(j); setState('ready'); }
        else if (j?.ok && j.series === null) setState('empty');
        else setState('error');
      })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [individualUid]);

  const series = data?.series ?? null;
  const administered = data?.administered ?? [];
  const doneWindows = useMemo(() => new Set(administered.map((a) => a.window)), [administered]);

  // per-window bounds/status from the compiled due list (all instruments in a window share bounds).
  const windows = series ? ARCHETYPE_WINDOWS[series.archetype] : [];
  const byWindow = useMemo(() => {
    const m = new Map<string, DueInstrument[]>();
    for (const d of series?.due ?? []) { const a = m.get(d.window) ?? []; a.push(d); m.set(d.window, a); }
    return m;
  }, [series]);
  const openWindow = windows.find((w) => byWindow.get(w)?.some((d) => d.status === 'in_window')) ?? null;
  const openInstruments = openWindow
    ? Array.from(new Set((byWindow.get(openWindow) ?? []).map((d) => d.instrumentId)))
    : [];

  if (state === 'empty' || state === 'error') return null;   // no surgical series → hide (fail-safe)

  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-slate-200 px-4 py-3">
        <ClipboardList className="h-4 w-4 text-teal-600" />
        <span className="text-[14px] font-semibold text-slate-800">Surgical recovery · PROMs</span>
        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700">advisory · care-call/0.2</span>
        {series && (
          <span className="ml-auto text-right text-[11px] text-slate-400">
            {series.procedureName || series.family}{series.plannedDate ? ` · surgery ${series.plannedDate}` : ''}<br />
            {series.family} · {series.archetype} · prom-catalog/0.1
          </span>
        )}
      </div>

      <div className="space-y-5 px-4 py-4">
        {state === 'loading' && <div className="flex items-center gap-2 py-4 text-[12.5px] text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Detecting surgical series…</div>}

        {series && (
          <>
            {/* ── Recovery schedule strip ─────────────────────────────── */}
            <div>
              <SectionHead icon={CalendarDays} title="Recovery schedule" sub={`${series.archetype} archetype · anchored on surgery/discharge`} />
              <div className="flex overflow-hidden rounded-lg border border-slate-200">
                {windows.map((w) => {
                  const items = byWindow.get(w) ?? [];
                  const st = items[0]?.status;
                  const done = doneWindows.has(w);
                  const cls = done ? 'bg-emerald-50' : st === 'in_window' ? 'bg-amber-50 ring-2 ring-inset ring-amber-300'
                    : st === 'missed' ? 'bg-rose-50' : 'bg-slate-50/60';
                  const stTxt = done ? '✓ captured' : st === 'in_window' ? '● DUE now' : st === 'missed' ? 'missed' : 'upcoming';
                  const stColor = done ? 'text-emerald-700' : st === 'in_window' ? 'text-amber-700' : st === 'missed' ? 'text-rose-700' : 'text-slate-400';
                  const range = w === 'baseline' ? 'pre-op' : items[0] ? `${day(items[0].opensAt)}–${day(items[0].closesAt)}` : '';
                  return (
                    <div key={w} className={`flex-1 border-r border-slate-200 px-2 py-2.5 text-center last:border-r-0 ${cls}`}>
                      <div className="text-[12px] font-bold text-slate-700">{WINDOW_LABEL[w]}</div>
                      <div className="text-[10px] text-slate-400">{range}</div>
                      <div className={`mt-1 text-[10.5px] font-bold ${stColor}`}>{stTxt}</div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">Windows are deterministic (± tolerance off the discharge/surgery date). prom-sched/0.1.</p>
            </div>

            {/* ── Due this call ───────────────────────────────────────── */}
            <div>
              <SectionHead icon={Target} title="Due this call" sub={openWindow ? `${WINDOW_LABEL[openWindow]} window` : 'no open window'} />
              {openInstruments.length ? (
                <div className="space-y-0.5">
                  {openInstruments.map((id) => {
                    const def = instrumentById(id);
                    return (
                      <div key={id} className="flex items-center gap-2 border-b border-dashed border-slate-100 py-1.5 text-[12.5px] last:border-0">
                        <span className="font-semibold text-slate-700">{def?.label ?? id}</span>
                        <span className="ml-auto text-[11px] text-slate-400">
                          {def?.kind === 'validated' ? (id === 'whodas12' ? 'validated · WHO item text pending' : 'validated') : `house${def?.items?.length ? ` · ${def.items.length} items` : ''}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : <p className="text-[12px] text-slate-500">No instruments are due in an open window right now.</p>}
            </div>

            {/* ── Administer ──────────────────────────────────────────── */}
            {openInstruments.length > 0 && (
              <div>
                <SectionHead icon={Mic} title="Administer" sub="read each item verbatim · tap the patient's answer" />
                <div className="space-y-3">
                  {openInstruments.map((id) => (
                    <Administer key={id} instrumentId={id} answers={answers} setAnswers={setAnswers} />
                  ))}
                </div>
              </div>
            )}

            {/* ── Score + escalation ──────────────────────────────────── */}
            <ScorePanel openInstruments={openInstruments} answers={answers} />

            {/* ── Save ────────────────────────────────────────────────── */}
            {openWindow && openInstruments.length > 0 && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => saveAll(series, openWindow, openInstruments, answers, setSaved)}
                  className="rounded-lg bg-teal-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-teal-700"
                >Save administration</button>
                {saved && <span className="text-[11.5px] text-slate-500">{saved}</span>}
              </div>
            )}

            <p className="text-[11px] text-slate-400">
              Scores land as dated numeric series feeding the MemberState spine (pre-op baseline = the appropriateness signal).
              Raw responses stored immutably; house scores never cross-patient benchmarked. prom-sched/0.1 · prom-scoring/0.1.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function SectionHead({ icon: Icon, title, sub }: { icon: typeof Target; title: string; sub?: string }) {
  return (
    <div className="mb-2 flex items-baseline gap-1.5">
      <Icon className="h-4 w-4 shrink-0 translate-y-0.5 text-slate-400" />
      <span className="text-[13px] font-semibold text-slate-800">{title}</span>
      {sub && <span className="text-[11.5px] font-normal text-slate-400">· {sub}</span>}
    </div>
  );
}

/** One instrument's items rendered verbatim; chips = the item's scale. Pending for validated/PREM. */
function Administer({ instrumentId, answers, setAnswers }: { instrumentId: string; answers: Record<string, string>; setAnswers: (f: (a: Record<string, string>) => Record<string, string>) => void }) {
  const def = instrumentById(instrumentId);
  if (!def) return null;
  const pick = (itemId: string, value: string) => setAnswers((a) => ({ ...a, [`${instrumentId}:${itemId}`]: value }));

  // pain_nrs is validated with items:[] but administrable as a single NRS-11 row (mockup).
  const rows: { itemId: string; text: string | null; scale: Scale; escalation?: string | null }[] =
    def.items.length ? def.items.map((it) => ({ itemId: it.id, text: it.text, scale: it.scale, escalation: it.escalation }))
    : instrumentId === 'pain_nrs' ? [{ itemId: 'pain', text: 'Pain at the operation site today (0 = none, 10 = worst)', scale: 'NRS-11' }]
    : [];

  if (!rows.length) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-3 py-2 text-[12px] italic text-slate-400">
        {def.label} — {instrumentId === 'whodas12' ? 'WHODAS 2.0 item text pending (entered verbatim from the WHO source at 0.2a-2)' : 'item text pending'}.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2">
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">{def.label}</div>
      {rows.map((r) => {
        const opts = SHARED_SCALES[r.scale] ?? [];
        const sel = answers[`${instrumentId}:${r.itemId}`];
        return (
          <div key={r.itemId} className="border-b border-slate-100 py-2 last:border-0">
            <div className="mb-1.5 text-[12.5px] font-medium text-slate-700">
              {r.text ?? <span className="italic text-slate-400">item text pending</span>}
              {r.escalation && <span className="ml-1.5 text-[10.5px] font-bold text-amber-600">⚠ {r.escalation}</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {opts.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => pick(r.itemId, o)}
                  className={`rounded-full border px-2.5 py-1 text-[12px] ${sel === o ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300'}`}
                >{o}</button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Deterministic score preview (scoreInstrument) + ⚠ escalations for the answered house instruments. */
function ScorePanel({ openInstruments, answers }: { openInstruments: string[]; answers: Record<string, string> }) {
  const scored = openInstruments.map((id) => {
    const responses: ItemResponse[] = Object.entries(answers)
      .filter(([k]) => k.startsWith(`${id}:`))
      .map(([k, value]) => ({ itemId: k.slice(id.length + 1), value }));
    if (!responses.length) return null;
    const s = scoreInstrument(id, responses);
    return { id, label: instrumentById(id)?.label ?? id, ...s };
  }).filter(Boolean) as { id: string; label: string; score: number | null; scale: string; escalations: string[] }[];

  if (!scored.length) return null;
  const escalations = Array.from(new Set(scored.flatMap((s) => s.escalations)));

  return (
    <div>
      <SectionHead icon={Calculator} title="Score" sub="deterministic · house sum · within-patient trend only" />
      <div className="space-y-2">
        {scored.map((s) => (
          <div key={s.id} className="flex items-center gap-3 rounded-lg border border-teal-100 bg-teal-50/40 px-3 py-2">
            <div className="text-[20px] font-extrabold text-teal-800">{s.score ?? '—'}</div>
            <div className="text-[12px] text-slate-600"><b className="text-slate-700">{s.label}</b> · {s.scale}{s.score == null ? ' · needs the full set to score' : ' · lands as a dated point on this member’s series'}</div>
          </div>
        ))}
      </div>
      {escalations.map((code) => (
        <div key={code} className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span><b>▲ {code} escalation</b> — {escLabel(code)}. Scripted advise-review + added to today's escalation list.</span>
        </div>
      ))}
    </div>
  );
}

/** POST each answered instrument as one administration (server re-scores authoritatively). */
async function saveAll(
  series: SurgicalSeries, window: string, openInstruments: string[],
  answers: Record<string, string>, setSaved: (s: string) => void,
) {
  setSaved('Saving…');
  const uid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.round(Math.random() * 1e6)}`);
  let ok = 0, fail = 0;
  for (const id of openInstruments) {
    const raw: ItemResponse[] = Object.entries(answers)
      .filter(([k]) => k.startsWith(`${id}:`))
      .map(([k, value]) => ({ itemId: k.slice(id.length + 1), value }));
    if (!raw.length) continue;
    try {
      const r = await fetch('/api/care-call/proms/response', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: uid(), individual_uid: series.individualUid, instrument_id: id, window, raw, series_id: `psr:${series.individualUid}` }),
      });
      if (r.ok) ok++; else fail++;
    } catch { fail++; }
  }
  setSaved(fail ? `Saved ${ok}, ${fail} failed (check migration)` : `Saved ${ok} administration${ok === 1 ? '' : 's'} · folds into the spine`);
}
