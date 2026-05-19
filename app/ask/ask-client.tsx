'use client';

import { useState, useRef } from 'react';

type Citation = {
  n: number;
  id: number;
  book: string;
  chapter: string | null;
  page_start: number | null;
  page_end: number | null;
  item_number: string | null;
  chunk_type: string;
  similarity: number;
  preview: string;
};

const EXAMPLES = [
  'First-line treatment for HFrEF with NYHA class III symptoms?',
  'How do I distinguish IBS from IBD in a 28-year-old with chronic diarrhea?',
  'Workup for hyponatremia with a serum osmolality of 268?',
  'Empiric antibiotics for community-acquired pneumonia in a 70-year-old with COPD?',
];

export default function AskClient() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);

  async function submit(q: string) {
    setQuestion(q);
    setAnswer('');
    setCitations([]);
    setError(null);
    setExpanded({});
    setLoading(true);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const txt = await r.text();
        setError(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
        setLoading(false);
        return;
      }
      if (!r.body) {
        setError('no body');
        setLoading(false);
        return;
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let headerParsed = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (!headerParsed) {
          const marker = '\n\n---STREAM---\n';
          const idx = buf.indexOf(marker);
          if (idx !== -1) {
            const header = buf.slice(0, idx);
            try {
              const parsed = JSON.parse(header) as { type: string; items: Citation[] };
              if (parsed.type === 'citations') setCitations(parsed.items);
            } catch {}
            buf = buf.slice(idx + marker.length);
            headerParsed = true;
            setAnswer(buf);
          }
        } else {
          setAnswer(buf);
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (q) submit(q);
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
      <div>
        <form onSubmit={onSubmit} className="space-y-3">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a clinical question…"
            rows={3}
            className="w-full resize-none rounded-lg border border-slate-300 bg-white p-3 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSubmit(e as unknown as React.FormEvent);
            }}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">⌘+Enter to submit</span>
            <button
              type="submit"
              disabled={loading || !question.trim()}
              className="rounded bg-brand px-4 py-2 text-sm font-medium text-white shadow disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {loading ? 'Thinking…' : 'Ask'}
            </button>
          </div>
        </form>

        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => submit(ex)}
              disabled={loading}
              className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:border-brand hover:text-brand disabled:opacity-40"
            >
              {ex}
            </button>
          ))}
        </div>

        {error && (
          <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            {error}
          </div>
        )}

        {(answer || loading) && (
          <article className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-800">
              {answer}
              {loading && !answer && <span className="text-slate-400">…</span>}
              {loading && answer && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-slate-400" />}
            </div>
          </article>
        )}
      </div>

      <aside className="lg:sticky lg:top-4 lg:self-start">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Sources</h2>
        {citations.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">
            Citations appear here when you ask a question. Each cited excerpt is expandable.
          </p>
        ) : (
          <ol className="mt-3 space-y-2">
            {citations.map((c) => {
              const isOpen = !!expanded[c.n];
              return (
                <li key={c.n} className="rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
                  <button
                    onClick={() => setExpanded((p) => ({ ...p, [c.n]: !isOpen }))}
                    className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        <span className="rounded bg-brand-faint px-1.5 py-0.5 text-[11px] font-semibold text-brand">[{c.n}]</span>
                        <span className="truncate font-medium text-slate-800">{c.book}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {c.chapter && <span>{c.chapter} · </span>}
                        {c.page_start && <span>p.{c.page_start}{c.page_end && c.page_end !== c.page_start ? `–${c.page_end}` : ''} · </span>}
                        {c.item_number && <span>Item {c.item_number} · </span>}
                        <span>sim {c.similarity.toFixed(2)}</span>
                      </div>
                    </div>
                    <span className="text-slate-400">{isOpen ? '–' : '+'}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-slate-100 px-3 py-2 text-[13px] leading-relaxed text-slate-700">
                      {c.preview}
                      {c.preview.length >= 600 && <span className="text-slate-400">…</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </aside>
    </div>
  );
}
