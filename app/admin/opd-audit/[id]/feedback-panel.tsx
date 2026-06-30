'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type FeedbackEntry = {
  id: string;
  created_at: string;
  verdict: string | null;
  comment: string | null;
  author: string | null;
};

const VERDICTS: { key: string; label: string; on: string; off: string }[] = [
  { key: 'agree',        label: 'Agree',        on: 'border-emerald-400 bg-emerald-50 text-emerald-800', off: 'border-slate-200 text-slate-500 hover:bg-slate-50' },
  { key: 'disagree',     label: 'Disagree',     on: 'border-red-400 bg-red-50 text-red-700',              off: 'border-slate-200 text-slate-500 hover:bg-slate-50' },
  { key: 'needs_action', label: 'Needs action', on: 'border-amber-400 bg-amber-50 text-amber-800',        off: 'border-slate-200 text-slate-500 hover:bg-slate-50' },
];
const VERDICT_BADGE: Record<string, { label: string; cls: string }> = {
  agree:        { label: 'Agree',        cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  disagree:     { label: 'Disagree',     cls: 'bg-red-50 text-red-700 border-red-200' },
  needs_action: { label: 'Needs action', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
};

function rel(ts: string): string {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function FeedbackPanel({ auditId, uid, initial }: { auditId: string; uid: string | null; initial: FeedbackEntry[] }) {
  const router = useRouter();
  const [verdict, setVerdict] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [author, setAuthor] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function submit() {
    if (busy) return;
    if (!verdict && !comment.trim()) { setMsg('Add a verdict or a comment.'); return; }
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/opd-audit/feedback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auditId, uid, verdict, comment: comment.trim() || null, author: author.trim() || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setMsg('Error: ' + (j.error || `status ${r.status}`)); }
      else { setComment(''); setVerdict(null); router.refresh(); }
    } catch (e) {
      setMsg('Failed: ' + String((e as Error).message));
    }
    setBusy(false);
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">Reviewer feedback</div>
      <p className="mt-0.5 text-[11px] text-slate-400">Read this audit? Leave a verdict and a note — it trains the engine. Optional name; otherwise anonymous.</p>

      {initial.length > 0 && (
        <ul className="mt-3 space-y-2">
          {initial.map((f) => (
            <li key={f.id} className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
              <div className="flex items-center gap-2">
                {f.verdict && VERDICT_BADGE[f.verdict] && (
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${VERDICT_BADGE[f.verdict].cls}`}>{VERDICT_BADGE[f.verdict].label}</span>
                )}
                <span className="text-[10.5px] text-slate-400">{f.author || 'Anonymous'} · {rel(f.created_at)}</span>
              </div>
              {f.comment && <div className="mt-1 text-[12px] leading-snug text-slate-700">{f.comment}</div>}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {VERDICTS.map((v) => (
          <button key={v.key} type="button" onClick={() => setVerdict(verdict === v.key ? null : v.key)}
            className={`rounded-lg border px-2.5 py-1 text-[11.5px] font-medium ${verdict === v.key ? v.on : v.off}`}>
            {v.label}
          </button>
        ))}
      </div>
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3}
        placeholder="What's right or wrong about this audit? Anything to action?"
        className="mt-2 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-[12.5px] text-slate-700 outline-none focus:border-brand/50" />
      <div className="mt-2 flex items-center gap-2">
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Your name (optional)"
          className="h-8 flex-1 rounded-lg border border-slate-200 px-2.5 text-[12px] text-slate-700 outline-none focus:border-brand/50" />
        <button type="button" onClick={submit} disabled={busy}
          className={`whitespace-nowrap rounded-lg border px-3 py-1.5 text-[12px] font-medium ${busy ? 'border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand-faint'}`}>
          {busy ? 'Saving…' : 'Save feedback'}
        </button>
      </div>
      {msg && <div className="mt-1.5 text-[11px] text-slate-500">{msg}</div>}
    </div>
  );
}
