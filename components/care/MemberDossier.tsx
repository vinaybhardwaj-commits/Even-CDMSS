'use client';

// Whole-person dossier for a care-manager call: identity + snapshot + a unified care timeline
// (OPD visits, diagnostics, radiology, IPD/discharge), with the per-visit conversation brief
// reachable from the latest visit. Deterministic data from /api/ccb/dossier (no LLM here).
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Phone, Hash, ArrowRight, Stethoscope, FlaskConical, Scan, BedDouble } from 'lucide-react';

type Kind = 'opd' | 'ipd' | 'diagnostic' | 'radiology';
interface TimelineItem { date: string | null; kind: Kind; title: string; subtitle: string | null; refUid: string | null }
interface Dossier {
  member: { individualUid: string; name: string; gender: string | null; age: number | null; mobile: string | null; uhid: string | null; membershipId: string | null; allergies: string[] };
  snapshot: { opdVisits: number; ipdAdmissions: number; diagnostics: number; radiology: number; lastContact: string | null; medsLastVisit: number | null };
  timeline: TimelineItem[];
  latestEpisodeUid: string | null;
}

const KIND: Record<Kind, { label: string; badge: string; icon: typeof Stethoscope }> = {
  opd: { label: 'OPD visit', badge: 'bg-teal-50 text-teal-800', icon: Stethoscope },
  ipd: { label: 'IPD', badge: 'bg-violet-50 text-violet-800', icon: BedDouble },
  diagnostic: { label: 'Diagnostic', badge: 'bg-blue-50 text-blue-800', icon: FlaskConical },
  radiology: { label: 'Radiology', badge: 'bg-amber-50 text-amber-800', icon: Scan },
};
const prettyPhone = (m: string | null) => (m ? m.replace(/^(\+91)(\d{5})(\d{5})$/, '$1 $2 $3') : '');
const titleCase = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[11.5px] text-slate-400">{label}</div>
      <div className="mt-0.5 text-[17px] font-semibold text-slate-800">{value}</div>
    </div>
  );
}

export default function MemberDossier({ individualUid }: { individualUid: string }) {
  const [d, setD] = useState<Dossier | null>(null);
  const [error, setError] = useState('');
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; started.current = true;
    (async () => {
      try {
        const resp = await fetch(`/api/ccb/dossier?individual_uid=${encodeURIComponent(individualUid)}`);
        const j = await resp.json();
        if (!resp.ok || !j.ok) { setError(j.error || `Request failed (${resp.status})`); return; }
        setD(j.dossier as Dossier);
      } catch (e) { setError(String((e as Error).message)); }
    })();
  }, [individualUid]);

  if (error) return <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">Couldn’t load the member record: {error}</div>;
  if (!d) return (
    <div className="mt-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-5 text-[13px] text-slate-600">
      <Loader2 className="h-4 w-4 animate-spin text-teal-600" /> Assembling the member record…
    </div>
  );

  const m = d.member;
  return (
    <div className="mt-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-semibold text-slate-900">{m.name}</h1>
            {(m.gender || m.age != null) && (
              <span className="text-[13px] text-slate-500">{[titleCase(m.gender), m.age != null ? `${m.age}y` : ''].filter(Boolean).join(' · ')}</span>
            )}
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] text-slate-500">Advisory — not a clinical record</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-slate-500">
            {m.mobile && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{prettyPhone(m.mobile)}</span>}
            {m.uhid && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{m.uhid}</span>}
            {m.membershipId && <span className="inline-flex items-center gap-1"><Hash className="h-3 w-3" />{m.membershipId}</span>}
          </div>
          {m.allergies.length > 0 && (
            <div className="mt-1.5 text-[12px] text-red-700">Allergies: {m.allergies.join(', ')}</div>
          )}
        </div>
        {d.latestEpisodeUid && (
          <button onClick={() => router.push(`/care/${encodeURIComponent(d.latestEpisodeUid!)}`)}
            className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-teal-600 px-3 py-2 text-[12.5px] font-medium text-white hover:bg-teal-700">
            Conversation brief <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="OPD visits" value={d.snapshot.opdVisits} />
        <Stat label="IPD admissions" value={d.snapshot.ipdAdmissions} />
        <Stat label="Diagnostics" value={d.snapshot.diagnostics} />
        <Stat label="Radiology" value={d.snapshot.radiology} />
        <Stat label="Last contact" value={d.snapshot.lastContact || '—'} />
      </div>

      <div className="mt-6 text-[12px] font-medium uppercase tracking-wide text-slate-400">Care timeline</div>
      {d.timeline.length === 0 && <div className="mt-2 text-[13px] text-slate-400">No records found for this member.</div>}
      <ol className="mt-2">
        {d.timeline.map((t, i) => {
          const K = KIND[t.kind];
          const Icon = K.icon;
          const clickable = t.kind === 'opd' && t.refUid;
          return (
            <li key={i} className={`flex gap-3 border-t border-slate-100 py-3 ${clickable ? 'cursor-pointer hover:bg-slate-50' : ''}`}
              onClick={clickable ? () => router.push(`/care/${encodeURIComponent(t.refUid!)}`) : undefined}>
              <div className="w-[86px] shrink-0 text-[12px] text-slate-500">{t.date || '—'}</div>
              <div className="min-w-0 flex-1">
                <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${K.badge}`}>
                  <Icon className="h-3 w-3" />{K.label}
                </span>
                <div className="mt-1 text-[13.5px] text-slate-800">
                  {t.title}{t.subtitle ? <span className="text-slate-500"> · {t.subtitle}</span> : null}
                </div>
              </div>
              {clickable && <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-300" />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
