'use client';

import { useState, useEffect } from 'react';
import { CheckCircle2, Loader2, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';

export type TraceEvent = {
  stage: string;
  msg: string;
  ms?: number;
  done: boolean;
  error?: boolean;
  ts: number;
};

const STAGE_LABEL: Record<string, string> = {
  expanding: 'Query expansion',
  retrieving: 'Hybrid retrieval',
  reranking: 'Reranking',
  generating: 'LLM generation',
  parsing: 'Parsing response',
  persisting: 'Saving',
  done: 'Done',
};

export default function TracePanel({ events, totalMs }: { events: TraceEvent[]; totalMs?: number }) {
  const [open, setOpen] = useState(true);
  if (events.length === 0) return null;
  const last = events[events.length - 1];
  const isComplete = events.some((e) => e.stage === 'done') || !!totalMs;
  const hasError = events.some((e) => e.error);
  // Detect stall: no events in 45s on an open pipeline
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isComplete || hasError) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [isComplete, hasError]);
  const stalled = !isComplete && !hasError && (now - last.ts) > 45_000;

  return (
    <div className={`mb-3 rounded-lg border text-xs ${hasError ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-slate-50'}`}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        {hasError ? <AlertTriangle className="h-3.5 w-3.5 text-rose-600" />
          : isComplete ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          : <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />}
        <span className="flex-1 font-medium text-slate-700">
          {isComplete ? `Pipeline complete${totalMs ? ` · ${totalMs}ms` : ''}` : (STAGE_LABEL[last.stage] || last.stage)}
        </span>
        <span className="text-slate-400">{events.length} step{events.length !== 1 ? 's' : ''}</span>
        {open ? <ChevronUp className="h-3 w-3 text-slate-400" /> : <ChevronDown className="h-3 w-3 text-slate-400" />}
      </button>
      {open && stalled && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          ⚠ No progress for {Math.round((now - last.ts) / 1000)}s. Mac Mini Ollama may be queuing behind ingest work — this can take up to 90s. If it crosses 120s the Vercel function will time out.
        </div>
      )}
      {open && (
        <ol className="space-y-1 border-t border-slate-200 px-3 py-2">
          {events.map((e, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center">
                {e.error ? <AlertTriangle className="h-3 w-3 text-rose-600" />
                  : e.done ? <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                  : <Loader2 className="h-3 w-3 animate-spin text-slate-400" />}
              </span>
              <span className="flex-1">
                <span className="font-medium text-slate-700">{STAGE_LABEL[e.stage] || e.stage}</span>
                {e.msg && <span className="text-slate-500"> — {e.msg}</span>}
              </span>
              {e.ms !== undefined && <span className="shrink-0 text-slate-400">{e.ms}ms</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
