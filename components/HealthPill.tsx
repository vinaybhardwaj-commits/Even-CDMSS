'use client';

import { useEffect, useState } from 'react';
import { Circle, ChevronDown, ChevronUp } from 'lucide-react';

type HealthState = {
  ok: boolean;
  checks: {
    neon: { status: string; latency_ms?: number; chunks?: number; books?: number; error?: string };
    llm:  { status: string; latency_ms?: number; http?: number; models?: string[]; error?: string };
  };
  timestamp: string;
};

function pillState(d: HealthState | null, loading: boolean): { color: string; label: string } {
  if (loading || !d) return { color: 'bg-slate-300', label: 'Checking…' };
  if (!d.ok) return { color: 'bg-rose-500', label: 'Down' };
  const llmL = d.checks.llm.latency_ms ?? 0;
  const neonL = d.checks.neon.latency_ms ?? 0;
  if (llmL > 2000 || neonL > 1500) return { color: 'bg-amber-400', label: 'Slow' };
  return { color: 'bg-emerald-500', label: 'Healthy' };
}

export default function HealthPill() {
  const [data, setData] = useState<HealthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchHealth() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const d = await r.json();
      setData(d);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
      setData({ ok: false, checks: { neon: { status: 'error' }, llm: { status: 'error' } }, timestamp: new Date().toISOString() });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchHealth();
    const t = setInterval(fetchHealth, 30_000);
    return () => clearInterval(t);
  }, []);

  const { color, label } = pillState(data, loading);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-brand"
        aria-label={`Bridge status: ${label}`}
      >
        <span className={`h-2 w-2 rounded-full ${color}`} />
        <span className="hidden sm:inline">{label}</span>
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-700 shadow-lg">
          {error && <div className="rounded border border-rose-200 bg-rose-50 p-2 text-rose-800">Fetch error: {error}</div>}
          <div className="mb-2 text-[10px] uppercase tracking-wide text-slate-400">Bridge health</div>
          {data && (
            <>
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="font-semibold">Neon</span>
                  <span className={data.checks.neon.status === 'ok' ? 'text-emerald-700' : 'text-rose-700'}>
                    {data.checks.neon.status} · {data.checks.neon.latency_ms ?? '?'}ms
                  </span>
                </div>
                <div className="text-[10px] text-slate-500">
                  {data.checks.neon.chunks?.toLocaleString() ?? '?'} chunks · {data.checks.neon.books ?? '?'} sources
                </div>
                <div className="flex items-baseline justify-between pt-1">
                  <span className="font-semibold">LLM tunnel</span>
                  <span className={data.checks.llm.status === 'ok' ? 'text-emerald-700' : 'text-rose-700'}>
                    {data.checks.llm.status} · {data.checks.llm.latency_ms ?? '?'}ms
                  </span>
                </div>
                <div className="text-[10px] text-slate-500">
                  {data.checks.llm.models?.slice(0, 4).join(' · ') ?? '?'}
                </div>
              </div>
              <div className="mt-2 border-t pt-2 text-[10px] text-slate-400">
                last check {new Date(data.timestamp).toLocaleTimeString()}
              </div>
            </>
          )}
          <button
            onClick={fetchHealth}
            className="mt-2 w-full rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-200"
          >
            Recheck now
          </button>
        </div>
      )}
    </div>
  );
}
