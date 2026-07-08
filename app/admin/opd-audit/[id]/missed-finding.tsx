'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

// PRD §9.4 — note-level "Flag something the audit missed" affordance. Covers recall / false
// negatives, which by definition have no card to attach a pill to. Dashed card → textarea → Save,
// posting scope='missed' (comment required). Lists prior missed-flags beneath.

export type MissedEntry = { id: string; created_at: string; comment: string | null; author: string | null };

function getReviewer(): string {
  if (typeof window === 'undefined') return '';
  try { return (window.localStorage.getItem('opd-reviewer') || '').trim(); } catch { return ''; }
}
function rel(ts: string): string {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function MissedFindingCapture({ auditId, initial }: { auditId: string; initial: MissedEntry[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    if (busy || !text.trim()) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/opd-audit/feedback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'missed', auditId, verdict: 'missed', comment: text.trim(), author: getReviewer() || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setErr(j.error || `status ${r.status}`); }
      else { setText(''); setOpen(false); router.refresh(); }
    } catch (e) {
      setErr(String((e as Error).message));
    }
    setBusy(false);
  }

  return (
    <div className="mt-3">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)}
          className="w-full rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-left text-[11.5px] font-medium text-slate-500 hover:border-brand/40 hover:text-brand">
          + Flag something the audit missed
        </button>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-2.5">
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} autoFocus rows={2}
            placeholder="What should the audit have caught but didn't?"
            className="w-full resize-y rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] leading-snug text-slate-700 outline-none focus:border-brand/50" />
          <div className="mt-1.5 flex items-center gap-2">
            <button type="button" onClick={save} disabled={busy || !text.trim()}
              className={`rounded-lg border px-3 py-1 text-[11.5px] font-medium ${busy || !text.trim() ? 'border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand-faint'}`}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => { setOpen(false); setText(''); setErr(''); }} className="text-[11px] text-slate-400 hover:text-slate-600">Cancel</button>
            {err && <span className="text-[11px] text-red-500">{err}</span>}
          </div>
        </div>
      )}

      {initial.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {initial.map((m) => (
            <li key={m.id} className="rounded-lg border border-slate-100 bg-slate-50/50 px-3 py-2">
              <div className="text-[10.5px] text-slate-400">Missed · {m.author || 'Anonymous'} · {rel(m.created_at)}</div>
              {m.comment && <div className="mt-0.5 text-[12px] leading-snug text-slate-700">{m.comment}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
