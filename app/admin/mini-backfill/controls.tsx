'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type MbState = {
  enabled: boolean; window: 'night' | 'always'; cursor: string | null;
  floor: string; tag: string; n: number;
};

export default function MiniBackfillControls({ state }: { state: MbState }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [cursor, setCursor] = useState(state.cursor || '');
  const [floor, setFloor] = useState(state.floor);
  const [tag, setTag] = useState(state.tag);
  const [n, setN] = useState(String(state.n));

  async function post(body: Record<string, string>) {
    if (busy) return;
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/admin/mini-backfill-settings', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) setMsg('Error: ' + (j.error || r.status));
      else { setMsg('Saved.'); router.refresh(); }
    } catch (e) { setMsg('Failed: ' + String((e as Error).message)); }
    setBusy(false);
  }

  const inputCls = 'h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-[12px] text-slate-700 outline-none focus:border-brand/50';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} onClick={() => post({ enabled: state.enabled ? '0' : '1' })}
          className={`rounded-lg px-4 py-2 text-[13px] font-medium text-white ${state.enabled ? 'bg-red-600 hover:bg-red-700' : 'bg-brand hover:bg-brand-dark'}`}>
          {state.enabled ? '⏸ Pause backfill' : '▶ Start backfill'}
        </button>
        <span className="flex overflow-hidden rounded-lg border border-slate-200 text-[12px]">
          {(['night', 'always'] as const).map((w) => (
            <button key={w} type="button" disabled={busy} onClick={() => post({ window: w })}
              className={`px-3 py-1.5 ${state.window === w ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
              {w === 'night' ? 'Night only · 00–05 IST' : 'Anytime (day use OK\'d)'}
            </button>
          ))}
        </span>
        <span className="text-[11px] text-slate-400">the ⏸/▶ switch + window are checked on every 5-min tick — changes take effect within one tick</span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <label className="text-[11px] text-slate-500">Cursor day (works backwards from here)
          <input type="date" value={cursor} onChange={(e) => setCursor(e.target.value)} className={`${inputCls} mt-1 w-full`} />
        </label>
        <label className="text-[11px] text-slate-500">Floor (stop date)
          <input type="date" value={floor} onChange={(e) => setFloor(e.target.value)} className={`${inputCls} mt-1 w-full`} />
        </label>
        <label className="text-[11px] text-slate-500">Run tag (new tag = fresh re-audit generation)
          <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="mini" className={`${inputCls} mt-1 w-full`} />
        </label>
        <label className="text-[11px] text-slate-500">Notes per 5-min tick (≤4)
          <input value={n} onChange={(e) => setN(e.target.value)} className={`${inputCls} mt-1 w-full`} />
        </label>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" disabled={busy} onClick={() => {
          const body: Record<string, string> = { tag, n };
          if (cursor) body.cursor = cursor;
          if (floor) body.floor = floor;
          post(body);
        }} className="rounded-lg border border-brand/40 px-3 py-1.5 text-[12px] font-medium text-brand hover:bg-brand-faint">Save range & tag</button>
        <span className="text-[11px] text-slate-400">re-audit a period with a new engine/run: set cursor to the period end, floor to its start, and a fresh tag</span>
        {msg && <span className="text-[11px] text-slate-500">{msg}</span>}
      </div>
    </div>
  );
}
