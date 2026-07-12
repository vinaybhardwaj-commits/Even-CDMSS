'use client';

// MemberState Stage 2 (Phase 1) — the CM's whole-person VALIDATED clinical context (prep).
// Read-only render of the frozen, Stage-1-validated MemberStateSnapshot via /api/care/member-state.
// All five sections, safety-first. Dumb component; the honest labelling is in present-core (tested).
// Clarity idiom (system-ui, slate/teal, bg-*-50 badges). Never blocks the dossier — soft states.

import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck, AlertTriangle, Activity, Pill, Ban, FlaskConical } from 'lucide-react';
import type { MemberStateView, StateTone } from '@/lib/member-state/present-core';

const TONE: Record<StateTone['tone'], string> = {
  ok: 'bg-emerald-50 text-emerald-800',
  active: 'bg-teal-50 text-teal-800',
  uncertain: 'bg-amber-50 text-amber-700',
  stopped: 'bg-slate-100 text-slate-600',
  warn: 'bg-orange-50 text-orange-800',
  critical: 'bg-rose-50 text-rose-800',
  muted: 'bg-slate-100 text-slate-500',
};
export function Badge({ t }: { t: StateTone }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${TONE[t.tone]}`}>{t.label}</span>;
}
const SEV: Record<string, string> = { safety_critical: 'bg-rose-50 text-rose-800 border-rose-200', review: 'bg-amber-50 text-amber-800 border-amber-200', informational: 'bg-slate-50 text-slate-600 border-slate-200' };

export function useMemberState(query: string) {
  const [view, setView] = useState<MemberStateView | null>(null);
  const [individualUid, setIndividualUid] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  useEffect(() => {
    let alive = true;
    setState('loading');
    fetch(`/api/care/member-state?${query}`)
      .then(async (r) => (r.ok ? r.json() : { __status: r.status }))
      .then((j) => {
        if (!alive) return;
        if (j?.ok && j.view) { setView(j.view); setIndividualUid(j.individualUid ?? null); setState('ready'); }
        else if (j?.__status === 404) setState('empty');
        else setState('error');
      })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [query]);
  return { view, individualUid, state };
}

function ConflictStrip({ view }: { view: MemberStateView }) {
  if (!view.conflicts.length) return null;
  return (
    <div className="mb-3 space-y-1.5">
      {view.conflicts.map((c, i) => (
        <div key={i} className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[12px] ${SEV[c.severity] ?? SEV.informational}`}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span><b className="font-semibold capitalize">{c.domain} {c.type.replace(/_/g, ' ')}</b>{c.detail ? ` — ${c.detail}` : ''}</span>
        </div>
      ))}
    </div>
  );
}

function Section({ icon: Icon, title, count, children }: { icon: typeof Activity; title: string; count: number; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
        <Icon className="h-3.5 w-3.5" /> {title} <span className="font-medium text-slate-400">· {count}</span>
      </div>
      {children}
    </div>
  );
}

export default function MemberStatePanel({ individualUid }: { individualUid: string }) {
  const { view, state } = useMemberState(`individual_uid=${encodeURIComponent(individualUid)}`);

  if (state === 'empty' || (state === 'error')) return null;   // never block the dossier
  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-slate-200 px-4 py-3">
        <ShieldCheck className="h-4 w-4 text-teal-600" />
        <span className="text-[14px] font-semibold text-slate-800">Clinical state</span>
        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700">validated · advisory</span>
        {view && (
          <span className="ml-auto text-[11px] text-slate-400">
            as of {view.asOf} · {view.versions.reconciliation} · {view.counts.problems}p/{view.counts.medications}m/{view.counts.allergies}a/{view.counts.investigations}i
          </span>
        )}
      </div>
      <div className="px-4 py-3">
        {state === 'loading' && <div className="flex items-center gap-2 py-4 text-[12.5px] text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Building validated clinical state…</div>}
        {view && (
          <>
            <ConflictStrip view={view} />

            <Section icon={Activity} title="Problems" count={view.counts.problems}>
              <div className="space-y-1">
                {view.problems.map((p, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-slate-700">
                    <span className="font-medium">{p.concept}</span>
                    <Badge t={p.status} /> <Badge t={p.course} />
                    <span className="text-[11px] text-slate-400">{p.first === p.last ? p.last : `${p.first} → ${p.last}`} · {p.occurrences}× · conf {p.confidencePct}%</span>
                  </div>
                ))}
              </div>
            </Section>

            <Section icon={Pill} title="Medications" count={view.counts.medications}>
              <div className="space-y-1">
                {view.medications.map((m, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-slate-700">
                    <span className="font-medium">{m.concept}</span>
                    <Badge t={m.currentness} />
                    {m.caption && <span className="text-[11px] italic text-slate-400">{m.caption}</span>}
                    <span className="text-[11px] text-slate-400">{m.latestDose ? `${m.latestDose} · ` : ''}{m.occurrences}×</span>
                  </div>
                ))}
              </div>
            </Section>

            <Section icon={Ban} title="Allergies" count={view.counts.allergies}>
              <div className="flex flex-wrap gap-1.5">
                {view.allergies.map((a, i) => (
                  <span key={i} className="inline-flex items-center gap-1 text-[12.5px] text-slate-700">
                    <span className="font-medium">{a.substance}</span> <Badge t={a.status} />
                    {a.conflicted && <span className="rounded bg-rose-50 px-1 py-0.5 text-[10px] font-bold text-rose-700">conflict</span>}
                  </span>
                ))}
              </div>
            </Section>

            <Section icon={FlaskConical} title="Investigations" count={view.counts.investigations}>
              <table className="w-full text-[12px]">
                <tbody>
                  {view.investigations.map((iv, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0">
                      <td className="py-1 pr-2 font-medium text-slate-700">{iv.analyte}</td>
                      <td className="py-1 pr-2 text-slate-600">{iv.latest ?? '—'}{iv.unit ? ` ${iv.unit}` : ''}{iv.direction ? ` ${iv.direction === 'up' ? '↑' : iv.direction === 'down' ? '↓' : '→'}` : ''}</td>
                      <td className="py-1 text-[11px] text-slate-400">{iv.points.length}× {iv.mixedUnits ? '· mixed units' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <div className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1 text-[11px] text-slate-500">
              Read-only reconciled state · not a substitute for the record
            </div>
          </>
        )}
      </div>
    </div>
  );
}
