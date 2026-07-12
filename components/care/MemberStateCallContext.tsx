'use client';

// MemberState Stage 2 (Phase 1) — the compact "Clinical context" card the CM reads DURING the call,
// beside the episode brief. Same validated snapshot as the workspace panel, the call-relevant slice:
// safety conflicts first, then active problems, medication currentness (the adherence conversation),
// allergies. Keyed by presc_uid (the call surface's id). Collapses to nothing on empty/error.

import Link from 'next/link';
import { AlertTriangle, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { useMemberState, Badge } from './MemberStatePanel';

const SEV: Record<string, string> = { safety_critical: 'bg-rose-50 text-rose-800 border-rose-200', review: 'bg-amber-50 text-amber-800 border-amber-200', informational: 'bg-slate-50 text-slate-600 border-slate-200' };

export default function MemberStateCallContext({ prescUid }: { prescUid: string }) {
  const { view, individualUid, state } = useMemberState(`presc_uid=${encodeURIComponent(prescUid)}`);
  if (state !== 'ready' || !view) return null;   // safety-first surface only appears when it has content

  const activeProblems = view.problems.filter((p) => p.status.tone === 'active' || p.status.tone === 'uncertain');

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
        <ShieldCheck className="h-3.5 w-3.5 text-teal-600" />
        <span className="text-[12.5px] font-semibold text-slate-800">Clinical context</span>
        <span className="rounded-full bg-teal-50 px-1.5 py-0.5 text-[10px] font-semibold text-teal-700">validated</span>
        {individualUid && (
          <Link href={`/care/m/${encodeURIComponent(individualUid)}`} className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-teal-700 hover:text-teal-800">
            Full clinical state <ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      <div className="px-3 py-2.5 text-[12px]">
        {/* conflicts strip — safety-critical + review, first */}
        {view.conflicts.length > 0 && (
          <div className="mb-2 space-y-1">
            {view.conflicts.map((c, i) => (
              <div key={i} className={`flex items-start gap-1.5 rounded-md border px-2 py-1 ${SEV[c.severity] ?? SEV.informational}`}>
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span><b className="font-semibold capitalize">{c.domain} {c.type.replace(/_/g, ' ')}</b>{c.detail ? ` — ${c.detail}` : ''}</span>
              </div>
            ))}
          </div>
        )}

        {activeProblems.length > 0 && (
          <div className="mb-2">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Active problems</div>
            <div className="flex flex-wrap gap-x-2 gap-y-1">
              {activeProblems.map((p, i) => (
                <span key={i} className="inline-flex items-center gap-1"><span className="font-medium text-slate-700">{p.concept}</span> <Badge t={p.status} /></span>
              ))}
            </div>
          </div>
        )}

        {view.medications.length > 0 && (
          <div className="mb-2">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Medications · currentness</div>
            <div className="space-y-0.5">
              {view.medications.map((m, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-slate-700">{m.concept}</span> <Badge t={m.currentness} />
                  {m.caption && <span className="text-[10.5px] italic text-slate-400">{m.caption}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {view.allergies.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Allergies</div>
            <div className="flex flex-wrap gap-1.5">
              {view.allergies.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-1"><span className="font-medium text-slate-700">{a.substance}</span> <Badge t={a.status} />{a.conflicted && <span className="rounded bg-rose-50 px-1 text-[9.5px] font-bold text-rose-700">conflict</span>}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
