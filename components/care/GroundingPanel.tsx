'use client';

/**
 * Even-LVC grounding worker status panel (CDMSS-EVEN-LVC-GROUNDING-WORKER §7) — rendered by LvcBoard on
 * /care/lvc. Compact day-to-day view: state badge, drain progress bar, four counters, a recent-tick
 * feed (incl. epoch-bump context), Pause/Resume, and a deeper-logs pointer. Polls the status endpoint
 * every ~15s while open. Every field soft-fails; the panel never blocks the library above it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Activity, Pause, Play, Gauge } from 'lucide-react';

type Tick = { ts: string; status: string; processed: number; citations_added: number; epoch: number | null; note: string | null };
type Status = {
  ok: boolean; state: 'draining' | 'idle' | 'paused' | 'disabled'; epoch: number; paused: boolean;
  active_assertions: number | null; total_lv_notes: number | null; grounded_at_epoch: number | null;
  citations_added_total: number | null; last_tick: Tick | null; recent_ticks: Tick[]; drain_pct: number | null;
};

const STATE_STYLE: Record<string, { dot: string; text: string; label: string }> = {
  draining: { dot: 'bg-sky-500', text: 'text-sky-700', label: 'Draining' },
  idle: { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Idle — fully grounded' },
  paused: { dot: 'bg-amber-500', text: 'text-amber-700', label: 'Paused' },
  disabled: { dot: 'bg-slate-400', text: 'text-slate-500', label: 'Disabled (flag off)' },
};
const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());
const shortTs = (ts: string) => ts.replace('T', ' ').slice(5, 16);

export default function GroundingPanel() {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/care/lvc/ground-status');
      const j = (await r.json()) as Status;
      if (!r.ok || !j.ok) { setErr(true); return; }
      setSt(j); setErr(false);
    } catch { setErr(true); }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  const togglePause = async () => {
    if (!st) return;
    setBusy(true);
    try {
      await fetch('/api/care/lvc/ground-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: !st.paused }) });
      await load();
    } catch { /* soft */ } finally { setBusy(false); }
  };

  if (err && !st) return null;   // endpoint unreachable / disabled surface ⇒ render nothing (fail-safe)
  const style = STATE_STYLE[st?.state ?? 'idle'] ?? STATE_STYLE.idle;
  const pct = st?.drain_pct ?? null;

  return (
    <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-slate-400" />
          <h2 className="text-[14px] font-semibold text-slate-800">Grounding worker</h2>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.text}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />{style.label}
          </span>
        </div>
        {st && st.state !== 'disabled' && (
          <button onClick={togglePause} disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            {st.paused ? <><Play className="h-3.5 w-3.5" />Resume</> : <><Pause className="h-3.5 w-3.5" />Pause</>}
          </button>
        )}
      </div>

      {/* drain progress */}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[11.5px] text-slate-500">
          <span className="inline-flex items-center gap-1"><Gauge className="h-3.5 w-3.5" />Drain at epoch {st?.epoch ?? '—'}</span>
          <span>{pct == null ? '—' : `${pct}%`}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${pct ?? 0}%` }} />
        </div>
      </div>

      {/* four counters */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Counter label="Notes grounded" value={`${num(st?.grounded_at_epoch)} / ${num(st?.total_lv_notes)}`} />
        <Counter label="Citations added" value={num(st?.citations_added_total)} />
        <Counter label="Active assertions" value={num(st?.active_assertions)} />
        <Counter label="Last tick" value={st?.last_tick ? shortTs(st.last_tick.ts) : '—'} />
      </div>

      {/* recent tick feed */}
      {st?.recent_ticks && st.recent_ticks.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Recent ticks</div>
          <div className="space-y-0.5">
            {st.recent_ticks.slice(0, 6).map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-[11.5px] text-slate-500">
                <span className="w-24 shrink-0 tabular-nums text-slate-400">{shortTs(t.ts)}</span>
                <span className={`w-16 shrink-0 font-medium ${t.status === 'ok' ? 'text-sky-600' : t.status === 'paused' ? 'text-amber-600' : t.status === 'error' ? 'text-red-600' : 'text-slate-500'}`}>{t.status}</span>
                <span className="text-slate-500">{t.processed} notes · +{t.citations_added} cites{t.epoch != null ? ` · epoch ${t.epoch}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mt-3 text-[11px] text-slate-400">Deterministic, no-LLM · appends citations only (never a score) · deeper logs in <span className="font-medium text-slate-500">/admin/lvc-ground</span>.</p>
    </section>
  );
}

function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="mt-0.5 text-[13.5px] font-semibold tabular-nums text-slate-800">{value}</div>
    </div>
  );
}
