'use client';

/**
 * TriageBoard — the care-manager OPD Audit Triage workspace (PRD §5 / spec §3.3).
 *
 * Doctor switcher ranked by attention → the selected doctor's signal-type cards ranked by
 * severity × noise → the four-step decision (validity → importance → route → response) applied to
 * the whole type ("Apply to all N"), with the audit-bug path short-circuiting to the bug feed.
 * Reads GET /api/opd-triage/queue, writes POST /api/opd-triage/decide. Advisory framing throughout.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, AlertTriangle, ChevronRight, CheckCircle2, Bug, ShieldAlert, RefreshCw } from 'lucide-react';

type Importance = 'low' | 'med' | 'high';
type ResponseReq = 'none' | 'explanation' | 'acknowledgment' | 'recommend_privilege_review';

interface Representative {
  audit_id: string; finding_ref: string; subject: string; verdict: string;
  rationale: string; note_date: string; citation_ids: number[];
}
interface TypeDecisionState {
  validity: string; bug_type: string | null; importance: string | null;
  routed: boolean; response_required: string | null; reason: string | null; cm_user: string | null; decided_at: string;
}
interface TypeGroup {
  signal_type: string; label: string; count: number; notes: number;
  severity_weight: number; importance_hint: Importance; concentrated: boolean; noisiest: boolean;
  representative: Representative; triage: TypeDecisionState | null;
}
interface DoctorGroup {
  doctor_uid: string; name?: string; speciality?: string;
  notes: number; instances: number; untriaged_types: number; max_importance_hint: Importance; types: TypeGroup[];
}
interface QueueResp {
  ok: boolean; window: { from: string; to: string; days: number }; status: string;
  doctors_total: number; doctors: DoctorGroup[]; error?: string;
}

const verdictPill: Record<string, string> = {
  'low-value': 'bg-rose-100 text-rose-700', 'context-dependent': 'bg-amber-100 text-amber-700',
  'high-value': 'bg-emerald-100 text-emerald-700', 'uncertain': 'bg-slate-100 text-slate-600',
};
const impPill: Record<Importance, string> = {
  high: 'bg-rose-100 text-rose-700', med: 'bg-amber-100 text-amber-700', low: 'bg-slate-100 text-slate-600',
};
const RESPONSE_LABELS: Record<ResponseReq, string> = {
  none: 'FYI (no response)', explanation: 'Ask for explanation', acknowledgment: 'Ask to acknowledge',
  recommend_privilege_review: 'Recommend privilege review',
};

// Per-card working state for the decision pipeline.
interface Draft {
  validity?: 'valid_signal' | 'audit_bug';
  bug_type?: 'process_bug' | 'structural_bug';
  importance?: Importance;
  routed?: boolean;
  response_required?: ResponseReq;
  busy?: boolean;
  done?: string; // a short receipt once applied
  error?: string;
}

// Explicit active-class map (Tailwind JIT can't see dynamically-built class names).
const TONE_ACTIVE: Record<string, string> = {
  slate: 'border-slate-500 bg-slate-100 text-slate-800',
  emerald: 'border-emerald-500 bg-emerald-50 text-emerald-800',
  rose: 'border-rose-500 bg-rose-50 text-rose-800',
  sky: 'border-sky-500 bg-sky-50 text-sky-800',
  purple: 'border-purple-500 bg-purple-50 text-purple-800',
};
const Btn = ({ active, onClick, children, tone = 'slate' }: { active?: boolean; onClick: () => void; children: React.ReactNode; tone?: string }) => (
  <button onClick={onClick}
    className={`rounded-md border px-2.5 py-1 text-[12px] font-medium transition ${
      active ? (TONE_ACTIVE[tone] || TONE_ACTIVE.slate) : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
    }`}>{children}</button>
);

export default function TriageBoard() {
  const [data, setData] = useState<QueueResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'untriaged' | 'all'>('untriaged');
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const load = useCallback(async (status: 'untriaged' | 'all') => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/opd-triage/queue?status=${status}`, { cache: 'no-store' });
      const j = (await r.json()) as QueueResp;
      if (!j.ok) throw new Error(j.error || 'failed to load queue');
      setData(j);
      setSelected((prev) => (prev && j.doctors.some((d) => d.doctor_uid === prev) ? prev : j.doctors[0]?.doctor_uid ?? null));
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(statusFilter); }, [load, statusFilter]);

  const doctor = useMemo(() => data?.doctors.find((d) => d.doctor_uid === selected) ?? null, [data, selected]);

  const setDraft = (key: string, patch: Draft) => setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }));

  async function apply(dg: DoctorGroup, t: TypeGroup) {
    const key = `${dg.doctor_uid}|${t.signal_type}`;
    const draft = drafts[key] || {};
    const body: Record<string, unknown> = {
      scope: 'type', doctor_uid: dg.doctor_uid, signal_type: t.signal_type,
      window_from: data?.window.from, window_to: data?.window.to,
      validity: draft.validity,
    };
    let receipt = '';
    if (draft.validity === 'audit_bug') {
      body.bug_type = draft.bug_type; body.routed = false;
      receipt = `Audit bug · ${draft.bug_type === 'process_bug' ? 'process' : 'structural'} → engineering feed`;
    } else {
      body.importance = draft.importance ?? t.importance_hint;
      body.routed = !!draft.routed;
      if (draft.routed) body.response_required = draft.response_required;
      receipt = draft.routed
        ? `${String(body.importance).toUpperCase()} · routed · ${RESPONSE_LABELS[(draft.response_required || 'none') as ResponseReq]}`
        : `${String(body.importance).toUpperCase()} · not routed (logged)`;
    }
    setDraft(key, { busy: true, error: undefined });
    try {
      const r = await fetch('/api/opd-triage/decide', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'decision failed');
      setDraft(key, { busy: false, done: receipt });
    } catch (e) { setDraft(key, { busy: false, error: String((e as Error).message) }); }
  }

  const canApply = (key: string): boolean => {
    const d = drafts[key];
    if (!d?.validity) return false;
    if (d.validity === 'audit_bug') return !!d.bug_type;
    if (!d.routed) return true;                    // valid + not routed (importance defaults to hint)
    return !!d.response_required;                  // routed needs a response requirement
  };

  return (
    <div className="mx-auto max-w-6xl px-5 py-7" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-[20px] font-semibold text-slate-900">OPD Audit Triage</h1>
          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">Advisory · care management</span>
        </div>
        <div className="flex items-center gap-2">
          <a href="/care/triage/health" className="text-[12.5px] text-sky-700 hover:underline">Signal health →</a>
          <div className="flex rounded-lg border border-slate-200 p-0.5 text-[12px]">
            {(['untriaged', 'all'] as const).map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`rounded-md px-2.5 py-1 font-medium ${statusFilter === s ? 'bg-slate-800 text-white' : 'text-slate-500'}`}>
                {s === 'untriaged' ? 'To do' : 'All'}
              </button>
            ))}
          </div>
          <button onClick={() => load(statusFilter)} className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:border-slate-300" title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {data && (
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          Window {data.window.from}{data.window.to !== data.window.from ? ` → ${data.window.to}` : ''} · {data.doctors_total} doctor(s) audited · {data.doctors.length} with {statusFilter === 'untriaged' ? 'open' : ''} signals
        </p>
      )}

      {loading ? (
        <div className="mt-16 flex items-center justify-center text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : err ? (
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700"><AlertTriangle className="h-4 w-4" /> {err}</div>
      ) : !data || data.doctors.length === 0 ? (
        <div className="mt-16 text-center text-[13px] text-slate-400">
          {statusFilter === 'untriaged' ? 'Nothing to triage — every signal is cleared. Nice.' : 'No audited notes in this window.'}
        </div>
      ) : (
        <div className="mt-5 grid gap-5 md:grid-cols-[220px_1fr]">
          {/* Doctor switcher */}
          <aside className="space-y-1">
            {data.doctors.map((d) => (
              <button key={d.doctor_uid} onClick={() => setSelected(d.doctor_uid)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                  selected === d.doctor_uid ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                <div className="flex items-center justify-between">
                  <span className="truncate text-[13px] font-medium text-slate-800">{d.name || d.doctor_uid}</span>
                  <span className={`ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${impPill[d.max_importance_hint]}`}>{d.untriaged_types}</span>
                </div>
                <div className="truncate text-[11px] text-slate-400">{d.speciality || '—'} · {d.notes} notes · {d.instances} findings</div>
              </button>
            ))}
          </aside>

          {/* Signal-type cards for the selected doctor */}
          <section className="space-y-3">
            {doctor?.types.map((t) => {
              const key = `${doctor.doctor_uid}|${t.signal_type}`;
              const draft = drafts[key] || {};
              const rep = t.representative;
              if (draft.done) {
                return (
                  <div key={key} className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-[12.5px] text-emerald-800">
                    <CheckCircle2 className="h-4 w-4 shrink-0" /> <span className="font-medium">{t.label}</span> · {t.count} — {draft.done}
                  </div>
                );
              }
              const existing = t.triage;
              return (
                <div key={key} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold text-slate-900">{t.label}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">×{t.count}</span>
                    {t.noisiest && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">loudest</span>}
                    {t.concentrated && <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold text-purple-700">concentrated</span>}
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${impPill[t.importance_hint]}`}>hint: {t.importance_hint}</span>
                    {existing && (
                      <span className="ml-auto rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-white">
                        {existing.validity === 'audit_bug' ? 'bug' : existing.routed ? `routed · ${existing.response_required}` : existing.importance || 'logged'}
                      </span>
                    )}
                  </div>

                  {/* Representative instance */}
                  <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${verdictPill[rep.verdict] || verdictPill.uncertain}`}>{rep.verdict}</span>
                      <span className="text-[12.5px] font-medium text-slate-800">{rep.subject}</span>
                      <span className="ml-auto text-[11px] text-slate-400">{rep.note_date} · 1 of {t.count}</span>
                    </div>
                    {rep.rationale && <p className="mt-1 text-[12px] leading-relaxed text-slate-600">{rep.rationale}</p>}
                  </div>

                  {/* Decision pipeline */}
                  <div className="mt-3 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">Validity</span>
                      <Btn active={draft.validity === 'valid_signal'} tone="emerald" onClick={() => setDraft(key, { validity: 'valid_signal', bug_type: undefined })}>Valid signal</Btn>
                      <Btn active={draft.validity === 'audit_bug'} tone="rose" onClick={() => setDraft(key, { validity: 'audit_bug', importance: undefined, routed: undefined, response_required: undefined })}>
                        <span className="inline-flex items-center gap-1"><Bug className="h-3 w-3" /> Audit bug</span>
                      </Btn>
                    </div>

                    {draft.validity === 'audit_bug' && (
                      <div className="flex items-center gap-2">
                        <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">Bug type</span>
                        <Btn active={draft.bug_type === 'process_bug'} onClick={() => setDraft(key, { bug_type: 'process_bug' })}>Process</Btn>
                        <Btn active={draft.bug_type === 'structural_bug'} onClick={() => setDraft(key, { bug_type: 'structural_bug' })}>Structural</Btn>
                      </div>
                    )}

                    {draft.validity === 'valid_signal' && (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">Importance</span>
                          {(['low', 'med', 'high'] as Importance[]).map((i) => (
                            <Btn key={i} active={(draft.importance ?? t.importance_hint) === i} onClick={() => setDraft(key, { importance: i })}>{i}</Btn>
                          ))}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">Route?</span>
                          <Btn active={draft.routed === true} tone="sky" onClick={() => setDraft(key, { routed: true })}>Route to doctor</Btn>
                          <Btn active={draft.routed === false} onClick={() => setDraft(key, { routed: false, response_required: undefined })}>Don’t route</Btn>
                        </div>
                        {draft.routed && (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">Response</span>
                            {(Object.keys(RESPONSE_LABELS) as ResponseReq[]).map((rr) => (
                              <Btn key={rr} active={draft.response_required === rr} tone={rr === 'recommend_privilege_review' ? 'purple' : 'sky'} onClick={() => setDraft(key, { response_required: rr })}>
                                {rr === 'recommend_privilege_review' ? <span className="inline-flex items-center gap-1"><ShieldAlert className="h-3 w-3" /> Privilege review</span> : RESPONSE_LABELS[rr].replace('Ask for ', '').replace('Ask to ', '')}
                              </Btn>
                            ))}
                          </div>
                        )}
                      </>
                    )}

                    {draft.error && <div className="text-[11.5px] text-rose-600">{draft.error}</div>}

                    <div className="flex items-center gap-2 pt-0.5">
                      <button disabled={!canApply(key) || draft.busy} onClick={() => apply(doctor, t)}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-white transition ${
                          canApply(key) && !draft.busy ? 'bg-slate-800 hover:bg-slate-900' : 'cursor-not-allowed bg-slate-300'}`}>
                        {draft.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        {draft.validity === 'audit_bug' ? `Junk all ${t.count}` : `Apply to all ${t.count}`}
                      </button>
                      <span className="text-[11px] text-slate-400">Batches the decision across all {t.count} instance(s)</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {doctor && doctor.types.length === 0 && (
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-[13px] text-slate-400">All of {doctor.name || doctor.doctor_uid}’s signals are cleared.</div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
