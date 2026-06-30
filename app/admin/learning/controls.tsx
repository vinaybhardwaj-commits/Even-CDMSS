'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function MineButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function run() {
    if (busy) return;
    setBusy(true); setMsg('mining recent audits…');
    try {
      const r = await fetch('/api/learning/mine?days=90', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) setMsg('error: ' + (j.error || `status ${r.status}`));
      else { setMsg(`scanned ${j.scanned} audits · ${j.candidates} clusters cleared the gates · ${j.inserted} new · ${j.refreshed} refreshed`); router.refresh(); }
    } catch (e) { setMsg('failed: ' + String((e as Error).message)); }
    setBusy(false);
  }
  return (
    <span className="flex items-center gap-2">
      <button onClick={run} disabled={busy}
        className={`whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs ${busy ? 'border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand-faint'}`}>
        {busy ? 'Mining…' : '↻ Run miner'}
      </button>
      {msg && <span className="text-[11px] text-slate-500">{msg}</span>}
    </span>
  );
}

export function ReviewButtons({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [note, setNote] = useState('');
  const [who, setWho] = useState('');
  async function act(action: 'approve' | 'reject') {
    if (busy) return;
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/learning/review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, action, reviewer: who.trim() || null, note: note.trim() || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) setMsg('error: ' + (j.error || `status ${r.status}`));
      else router.refresh();
    } catch (e) { setMsg('failed: ' + String((e as Error).message)); }
    setBusy(false);
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="reviewer (optional)"
        className="h-7 w-36 rounded border border-slate-200 px-2 text-[11px] text-slate-700 outline-none focus:border-brand/50" />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)"
        className="h-7 min-w-[8rem] flex-1 rounded border border-slate-200 px-2 text-[11px] text-slate-700 outline-none focus:border-brand/50" />
      <button onClick={() => act('approve')} disabled={busy}
        className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11.5px] font-medium text-emerald-800 hover:bg-emerald-100">Approve</button>
      <button onClick={() => act('reject')} disabled={busy}
        className="rounded-lg border border-red-300 bg-red-50 px-2.5 py-1 text-[11.5px] font-medium text-red-700 hover:bg-red-100">Reject</button>
      {msg && <span className="text-[11px] text-slate-500">{msg}</span>}
    </div>
  );
}
