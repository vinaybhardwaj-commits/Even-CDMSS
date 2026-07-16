'use client';
// Per-finding triage for the IPD Low-Value Care panel (S3.4): Agree / Disagree / Needs action.
// Appends to ipd_audit_feedback via /api/admin/ipd-audit-feedback (latest row per finding wins
// on read). Triage chips use a neutral advisory palette (slate/indigo) — the scored A–E
// language never touches advisory verdicts (the Saul semantics line; CI-asserted).
import { useState } from 'react';

const TRIAGE = [
  { key: 'agree', label: 'Agree' },
  { key: 'disagree', label: 'Disagree' },
  { key: 'needs_action', label: 'Needs action' },
] as const;

// Advisory palette — slate/indigo family only (disjoint from the scored A–E palette).
const ACTIVE: Record<string, string> = {
  agree: 'bg-indigo-600 text-white border-indigo-600',
  disagree: 'bg-slate-600 text-white border-slate-600',
  needs_action: 'bg-indigo-100 text-indigo-900 border-indigo-300',
};

export default function FindingTriage({ auditId, findingRef, initial }: { auditId: string; findingRef: string; initial?: string | null }) {
  const [picked, setPicked] = useState<string | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function pick(verdict: string) {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/admin/ipd-audit-feedback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auditId, findingRef, verdict }),
      });
      const j = await res.json();
      if (!j.ok) { setErr(j.error || 'failed'); return; }
      setPicked(verdict);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      {TRIAGE.map((t) => (
        <button key={t.key} onClick={() => pick(t.key)} disabled={busy}
          className={`rounded-md border px-2 py-0.5 text-[10.5px] font-semibold transition ${picked === t.key ? ACTIVE[t.key] : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
          {t.label}
        </button>
      ))}
      {err && <span className="text-[10px] text-red-600">{err}</span>}
    </span>
  );
}
