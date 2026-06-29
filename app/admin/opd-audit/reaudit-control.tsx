'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

// One-click re-audit of the viewed day. Loops the worker (authorised by the logged-in admin
// session — no token/secret) and shows live progress, then refreshes the dashboard. Used to
// re-audit a day on the corrected engine without any console snippet.
export default function ReauditControl({ day }: { day: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function run() {
    if (busy) return;
    setBusy(true);
    setMsg('starting…');
    try {
      for (let i = 0; i < 90; i++) {
        const r = await fetch(`/api/opd-audit/worker?day=${day}&max=16&conc=8`, { method: 'GET', cache: 'no-store' });
        if (r.status === 401) { setMsg('session expired — reload & unlock'); break; }
        const j = await r.json();
        if (!j.ok) { setMsg('error: ' + (j.error || 'failed')); break; }
        setMsg(`${j.audited}/${j.total} audited`);
        if (j.done) { setMsg(`done · ${j.audited} audited`); router.refresh(); break; }
      }
    } catch (e) {
      setMsg('failed: ' + String((e as Error).message));
    }
    setBusy(false);
  }

  return (
    <span className="flex items-center gap-1.5">
      <button onClick={run} disabled={busy}
        className={`whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs ${busy ? 'border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand-faint'}`}>
        {busy ? 'Re-auditing…' : '↻ Re-audit day'}
      </button>
      {msg && <span className="text-[11px] tabular-nums text-slate-500">{msg}</span>}
    </span>
  );
}
