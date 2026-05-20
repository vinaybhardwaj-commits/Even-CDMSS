'use client';

import { useState, useRef, useMemo } from 'react';
import { Mic, MicOff, Send, ChevronDown, ChevronUp, BookOpen, Loader2 } from 'lucide-react';
import { consumeNdjson } from '@/lib/ndjson-client';
import TracePanel, { TraceEvent } from '@/components/TracePanel';

type Citation = { n: number; id: number; book: string; chapter: string | null; page_start: number | null; page_end: number | null; item_number: string | null; chunk_type: string; similarity: number; preview: string; };

const EXAMPLES = [
  'First-line management of HFrEF NYHA III?',
  'Distinguishing IBS from IBD in a 28y with chronic diarrhea',
  'Workup for hyponatremia, serum osmolality 268',
  'Empiric antibiotics for CAP in a 70y with COPD',
];

type SR = { continuous: boolean; interimResults: boolean; lang: string; onresult: ((e: { results: { transcript: string; isFinal?: boolean }[][] & { length: number } }) => void) | null; onerror: ((e: { error?: string }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void; };
function getRecognition(): SR | null {
  if (typeof window === 'undefined') return null;
  const W = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  const C = W.SpeechRecognition || W.webkitSpeechRecognition;
  if (!C) return null;
  const r = new C(); r.continuous = false; r.interimResults = true; r.lang = 'en-IN';
  return r;
}

function renderWithCitations(text: string, citations: Citation[], onCite: (n: number) => void): React.ReactNode[] {
  if (!text) return [];
  const parts: React.ReactNode[] = [];
  const regex = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let last = 0; let m: RegExpExecArray | null; let key = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const nums = m[1].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    parts.push(<span key={key++} className="inline-flex items-baseline gap-0.5">
      {nums.map((n, i) => {
        const valid = citations.some((c) => c.n === n);
        return <button key={i} onClick={() => valid && onCite(n)}
          className={valid ? 'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md bg-brand-faint px-1 text-[10px] font-semibold text-brand hover:bg-brand hover:text-white' : 'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md bg-slate-100 px-1 text-[10px] font-medium text-slate-400'}
          type="button">{n}</button>;
      })}
    </span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<span key={key++}>{text.slice(last)}</span>);
  return parts;
}

export default function AskClient() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [totalMs, setTotalMs] = useState<number | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const recRef = useRef<SR | null>(null);
  const sessionId = useMemo(() => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())), []);
  const sourcesRef = useRef<HTMLDivElement | null>(null);

  function toggleVoice() {
    if (voiceActive) { recRef.current?.stop(); return; }
    const r = getRecognition();
    if (!r) { setVoiceSupported(false); return; }
    recRef.current = r;
    let baseline = question;
    r.onresult = (e) => {
      let interim = '', finalText = '';
      for (let i = 0; i < (e.results as unknown as { length: number }).length; i++) {
        const res = (e.results as unknown as { [k: number]: { transcript: string; isFinal?: boolean } })[i];
        if (res.isFinal) finalText += res.transcript; else interim += res.transcript;
      }
      const sep = baseline && !/[\s,.]$/.test(baseline) ? ' ' : '';
      setQuestion(baseline + sep + finalText + interim);
      if (finalText) baseline = baseline + sep + finalText;
    };
    r.onerror = () => setVoiceActive(false);
    r.onend = () => setVoiceActive(false);
    setVoiceActive(true);
    r.start();
  }

  function pushTrace(stage: string, msg: string, ms?: number, done = false, error = false) {
    setTrace((prev) => {
      // Mark prior in-progress events as done if a new stage starts
      const next = prev.map((p, i) => (i === prev.length - 1 && !p.done) ? { ...p, done: true } : p);
      return [...next, { stage, msg, ms, done, error, ts: Date.now() }];
    });
  }

  async function submit(q: string) {
    setQuestion(q); setAnswer(''); setCitations([]); setError(null); setExpanded({}); setHighlighted(null);
    setTrace([]); setTotalMs(undefined); setLoading(true);
    abortRef.current?.abort();
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const t0 = Date.now();
    let fullAnswer = ''; let citationsLocal: Citation[] = [];
    try {
      const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }), signal: ctrl.signal });
      if (!r.ok) { setError(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); setLoading(false); return; }
      await consumeNdjson(r, (ev) => {
        if (ev.type === 'progress') pushTrace(ev.stage, ev.msg, ev.ms);
        else if (ev.type === 'sources') { citationsLocal = ev.items as Citation[]; setCitations(citationsLocal); }
        else if (ev.type === 'token') { fullAnswer += ev.content; setAnswer(fullAnswer); }
        else if (ev.type === 'done') { setTotalMs(ev.ms); pushTrace('done', '', ev.ms, true); }
        else if (ev.type === 'error') { setError(ev.message); pushTrace('done', ev.message, undefined, true, true); }
      });
      fetch('/api/log/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature: 'ask', query_text: q, answer_text: fullAnswer, citation_ids: citationsLocal.map((c) => c.id), duration_ms: Date.now() - t0, session_id: sessionId }) }).catch(() => {});
    } catch (e) { if ((e as Error).name !== 'AbortError') setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }

  function onSubmit(e: React.FormEvent) { e.preventDefault(); const q = question.trim(); if (q) submit(q); }
  function onCite(n: number) {
    setHighlighted(n); setExpanded((p) => ({ ...p, [n]: true }));
    setTimeout(() => document.getElementById(`cite-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    setTimeout(() => setHighlighted((h) => (h === n ? null : h)), 2000);
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="relative">
          <textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a clinical question…" rows={3}
            className="w-full resize-none rounded-xl border border-slate-300 bg-white p-3 pr-12 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSubmit(e as unknown as React.FormEvent); }} />
          {voiceSupported && (
            <button type="button" onClick={toggleVoice} aria-label={voiceActive ? 'Stop voice input' : 'Start voice input'}
              className={`absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full border transition ${voiceActive ? 'animate-pulse border-rose-300 bg-rose-50 text-rose-600' : 'border-slate-200 bg-white text-slate-500 hover:border-brand hover:text-brand'}`}>
              {voiceActive ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-slate-400">{voiceActive ? 'Listening — speak naturally' : '⌘+Enter to submit'}</span>
          <button type="submit" disabled={loading || !question.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow disabled:cursor-not-allowed disabled:bg-slate-300">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {loading ? 'Thinking…' : 'Ask'}
          </button>
        </div>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button key={ex} onClick={() => submit(ex)} disabled={loading} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:border-brand hover:text-brand disabled:opacity-40">{ex}</button>
        ))}
      </div>

      {(trace.length > 0 || loading) && <div className="mt-5"><TracePanel events={trace} totalMs={totalMs} /></div>}

      {error && <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div>}

      {(answer || loading) && (
        <article className="mt-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-800">
            {renderWithCitations(answer, citations, onCite)}
            {loading && !answer && <span className="text-slate-400">…</span>}
            {loading && answer && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-slate-400" />}
          </div>
        </article>
      )}

      {citations.length > 0 && (
        <section ref={sourcesRef} className="mt-6">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <BookOpen className="h-3.5 w-3.5" /> Sources ({citations.length})
          </h2>
          <ol className="mt-3 space-y-2">
            {citations.map((c) => {
              const isOpen = !!expanded[c.n]; const isHi = highlighted === c.n;
              return (
                <li key={c.n} id={`cite-${c.n}`} className={`rounded-lg border text-sm shadow-sm transition ${isHi ? 'border-brand bg-brand-faint/40' : 'border-slate-200 bg-white'}`}>
                  <button onClick={() => setExpanded((p) => ({ ...p, [c.n]: !isOpen }))} className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5"><span className="rounded bg-brand-faint px-1.5 py-0.5 text-[11px] font-semibold text-brand">[{c.n}]</span><span className="truncate font-medium text-slate-800">{c.book}</span></div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {c.chapter && <span>{c.chapter} · </span>}
                        {c.page_start && <span>p.{c.page_start}{c.page_end && c.page_end !== c.page_start ? `–${c.page_end}` : ''} · </span>}
                        {c.item_number && <span>{c.item_number.startsWith('NBK') ? c.item_number : `Item ${c.item_number}`} · </span>}
                        <span>sim {c.similarity.toFixed(2)}</span>
                      </div>
                    </div>
                    {isOpen ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
                  </button>
                  {isOpen && <div className="border-t border-slate-100 px-3 py-2 text-[13px] leading-relaxed text-slate-700">{c.preview}{c.preview.length >= 600 && <span className="text-slate-400">…</span>}</div>}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
