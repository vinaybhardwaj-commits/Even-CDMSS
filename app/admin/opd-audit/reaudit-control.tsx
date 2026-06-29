'use client';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

// One-click re-audit of the viewed day. Loops the worker (authorised by the logged-in admin
// session — no token/secret) and shows a LIVE elapsed clock + per-batch progress, then refreshes.
// Each note is a real ~60–90s AI audit, so the first batch takes ~1 min to report — the clock
// makes that wait visibly alive instead of looking frozen.
export default function ReauditControl({ day }: { day: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  async function run() {
    if (busy) return;
    setBusy(true); setElapsed(0); setMsg('auditing first batch… (~1 min)');
    const t0 = Date.now();
    timer.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    try {
      for (let i = 0; i < 150; i++) {
        let r: Response;
        try { r = await fetch(`/api/opd-audit/worker?day=${day}&max=8&conc=8`, { cache: 'no-store' }); }
        catch { setMsg('network hiccup — retrying…'); continue; }
        if (r.status === 401) { setMsg('session expired — reload & unlock'); break; }
        let j: { ok?: boolean; audited?: number; total?: number; done?: boolean; error?: string } | null = null;
        try { j = await r.json(); } catch { setMsg(`server busy (${r.status}) — retrying…`); continue; }
        if (!j || !j.ok) { setMsg('error: ' + (j?.error || `status ${r.status}`)); break; }
        setMsg(`${j.audited}/${j.total} audited`);
        if (j.done) { setMsg(`✓ done · ${j.audited} audited`); router.refresh(); break; }
      }
    } catch (e) {
      setMsg('failed: ' + String((e as Error).message));
    }
    if (timer.current) clearInterval(timer.current);
    setBusy(false);
  }

  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  return (
    <span className="flex items-center gap-1.5">
      <button onClick={run} disabled={busy}
        className={`whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs ${busy ? 'border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand-faint'}`}>
        {busy ? 'Re-auditing…' : '↻ Re-audit day'}
      </button>
      {busy && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-500">{mmss}</span>}
      {msg && <span className="text-[11px] text-slate-500">{msg}</span>}
    </span>
  );
}
