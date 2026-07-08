'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

// PRD §9.1–§9.3. Per-finding "Your call" strip on every finding that FIRED. Four pills
// (True positive · Nitpick · False · Contested); one tap = one optimistic append-row POST.
// Reviewer name is set once (ReviewerBar, §9.2) and stored in localStorage, riding every tap
// as `author`. False / Contested auto-expand a one-line reason (§9.3); "Add note" offers the
// same on all four. No reload on tap; server-loaded current state pre-selects the pill on revisit.

const REVIEWER_KEY = 'opd-reviewer';
const REVIEWER_EVENT = 'opd-reviewer-changed';

function getReviewer(): string {
  if (typeof window === 'undefined') return '';
  try { return (window.localStorage.getItem(REVIEWER_KEY) || '').trim(); } catch { return ''; }
}

type Pill = { key: string; label: string; tip: string; on: string };
const PILLS: Pill[] = [
  { key: 'true_positive', label: 'True positive', tip: 'Correct and worth surfacing.',
    on: 'border-emerald-400 bg-emerald-50 text-emerald-800' },
  { key: 'nitpick', label: 'Nitpick', tip: 'Technically correct but low-value noise.',
    on: 'border-slate-400 bg-slate-100 text-slate-700' },
  { key: 'false', label: 'False', tip: 'Wrong / not supported by the note.',
    on: 'border-red-400 bg-red-50 text-red-700' },
  { key: 'contested', label: 'Contested', tip: 'Guideline-correct but patient-demand / context-constrained.',
    on: 'border-violet-400 bg-violet-50 text-violet-700' },
];
const OFF = 'border-slate-200 text-slate-500 hover:bg-slate-50';

/** §9.2 — "Reviewing as ___" set-once identity. Stored in localStorage; broadcast so open cards refresh. */
export function ReviewerBar() {
  const [name, setName] = useState('');
  useEffect(() => { setName(getReviewer()); }, []);
  function commit(v: string) {
    setName(v);
    try { window.localStorage.setItem(REVIEWER_KEY, v.trim()); } catch { /* ignore */ }
    try { window.dispatchEvent(new CustomEvent(REVIEWER_EVENT)); } catch { /* ignore */ }
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-medium text-slate-500">Reviewing as</span>
      <input
        value={name} onChange={(e) => commit(e.target.value)} placeholder="your name"
        className="h-7 w-40 rounded-lg border border-slate-200 bg-white px-2.5 text-[12px] text-slate-700 outline-none focus:border-brand/50" />
      {!name.trim() && <span className="text-[10.5px] text-slate-400">Add your name so your calls are attributable.</span>}
    </div>
  );
}

export function FindingTriage({ auditId, findingRef, signalType, current }: {
  auditId: string; findingRef?: string; signalType?: string; current?: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(current ?? null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [savedBy, setSavedBy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Keep the confirmation label live if the reviewer sets/changes their name in another card.
  const [, force] = useState(0);
  useEffect(() => {
    const h = () => force((x) => x + 1);
    window.addEventListener(REVIEWER_EVENT, h);
    return () => window.removeEventListener(REVIEWER_EVENT, h);
  }, []);

  if (!findingRef) return null; // legacy finding without identity — nothing to key on

  async function post(verdict: string, comment: string | null) {
    setBusy(true); setErr('');
    const author = getReviewer() || null;
    try {
      const r = await fetch('/api/opd-audit/feedback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'finding', auditId, finding_ref: findingRef, signal_type: signalType || null, verdict, comment, author }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setErr(j.error || `status ${r.status}`); }
      else { setSavedBy(author || 'anon'); router.refresh(); }
    } catch (e) {
      setErr(String((e as Error).message));
    }
    setBusy(false);
  }

  function tap(key: string) {
    if (busy) return;
    if (selected === key) { setSelected(null); setNoteOpen(false); return; } // toggle off (local; append-only keeps last stored)
    setSelected(key);                                                        // optimistic
    const wantsReason = key === 'false' || key === 'contested';
    setNoteOpen(wantsReason);
    void post(key, null);
  }

  return (
    <div className="mt-2 border-t border-slate-100 pt-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-400">Your call</span>
        {PILLS.map((p) => (
          <button key={p.key} type="button" onClick={() => tap(p.key)} title={p.tip} disabled={busy}
            className={`rounded-full border px-2 py-[3px] text-[11px] font-medium ${selected === p.key ? p.on : OFF}`}>
            {p.label}
          </button>
        ))}
        {selected && !noteOpen && (
          <button type="button" onClick={() => setNoteOpen(true)} className="text-[10.5px] text-slate-400 hover:text-brand">Add note</button>
        )}
        {savedBy && !err && <span className="ml-auto text-[10.5px] text-slate-400">Saved · {savedBy}</span>}
        {err && <span className="ml-auto text-[10.5px] text-red-500">{err}</span>}
      </div>
      {noteOpen && selected && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            value={note} onChange={(e) => setNote(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) { void post(selected, note.trim()); setNote(''); setNoteOpen(false); } }}
            placeholder={selected === 'false' ? 'Why is this wrong? (optional)' : selected === 'contested' ? "Why contested? (optional)" : 'Note (optional)'}
            className="h-7 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[11.5px] text-slate-700 outline-none focus:border-brand/50" />
          <button type="button" disabled={busy || !note.trim()}
            onClick={() => { if (note.trim()) { void post(selected!, note.trim()); setNote(''); setNoteOpen(false); } }}
            className={`whitespace-nowrap rounded-lg border px-2 py-1 text-[11px] font-medium ${busy || !note.trim() ? 'border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand-faint'}`}>
            Save note
          </button>
        </div>
      )}
    </div>
  );
}
