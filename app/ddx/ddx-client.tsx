'use client';

import { useState, useRef, useMemo } from 'react';
import { consumeNdjson } from '@/lib/ndjson-client';
import TracePanel, { TraceEvent } from '@/components/TracePanel';
import { Send, Loader2, AlertTriangle, ChevronDown, ChevronUp, ClipboardList, BookOpen, Microscope } from 'lucide-react';

type Citation = {
  n: number; id: number; book: string; chapter: string | null;
  page_start: number | null; page_end: number | null;
  item_number: string | null; chunk_type: string;
  similarity: number; preview: string;
};
type Dx = {
  diagnosis: string;
  likelihood?: 'low' | 'moderate' | 'high';
  why_consider?: string;
  distinguishing_features?: string[];
  investigations?: string[];
  citation_ids?: number[];
};
type DdxResponse = {
  summary?: string;
  missing_info?: string[];
  cannot_miss?: Dx[];
  most_likely?: Dx[];
  other?: Dx[];
  citations?: Citation[];
  presentation?: string;
  duration_ms?: number;
  error?: string;
  detail?: string;
};

const EXAMPLES = [
  { age: 58, sex: 'F', cc: 'Sudden onset chest pain radiating to left arm × 30 min', history: 'HTN, hyperlipidemia, smoker', exam: 'Diaphoretic, anxious, lungs clear', vitals: 'HR 112, BP 145/95, RR 22, SpO2 95% RA' },
  { age: 32, sex: 'M', cc: 'Severe headache "worst of my life" × 1 hour', history: 'No prior headaches; smokes', exam: 'Photophobia, neck stiffness, GCS 15', vitals: 'HR 96, BP 168/98, RR 18, T 37.2°C' },
  { age: 72, sex: 'F', cc: 'Confusion and falls × 2 days', history: 'CKD stage 3, T2DM on metformin + glipizide', exam: 'Lethargic, dry mucosa', vitals: 'HR 105, BP 100/60, RR 22, T 37.8°C, glucose 48' },
];

const LIKELIHOOD_COLORS: Record<string, string> = {
  high: 'bg-emerald-100 text-emerald-800',
  moderate: 'bg-amber-100 text-amber-900',
  low: 'bg-slate-100 text-slate-600',
};

function DxCard({ dx, idx, danger, onCite }: { dx: Dx; idx: number; danger?: boolean; onCite: (n: number) => void }) {
  const [open, setOpen] = useState(idx === 0);
  const lk = (dx.likelihood ?? 'moderate').toLowerCase();
  return (
    <article className={`rounded-xl border bg-white shadow-sm ${danger ? 'border-rose-200' : 'border-slate-200'}`}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50"
      >
        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${danger ? 'bg-rose-100 text-rose-700' : 'bg-brand-faint text-brand'}`}>
          {idx + 1}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-slate-900">{dx.diagnosis}</h3>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <span className={`rounded-full px-2 py-0.5 font-semibold ${LIKELIHOOD_COLORS[lk] ?? LIKELIHOOD_COLORS.moderate}`}>
              {lk} likelihood
            </span>
            {dx.citation_ids && dx.citation_ids.length > 0 && (
              <span className="text-slate-400">
                {dx.citation_ids.length} citation{dx.citation_ids.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 px-4 py-3 text-sm">
          {dx.why_consider && (
            <p className="leading-relaxed text-slate-700">{dx.why_consider}</p>
          )}
          {dx.distinguishing_features && dx.distinguishing_features.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <ClipboardList className="h-3 w-3" /> Distinguishing features
              </div>
              <ul className="ml-4 list-disc space-y-0.5 text-slate-700">
                {dx.distinguishing_features.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}
          {dx.investigations && dx.investigations.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <Microscope className="h-3 w-3" /> Investigations
              </div>
              <ul className="ml-4 list-disc space-y-0.5 text-slate-700">
                {dx.investigations.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}
          {dx.citation_ids && dx.citation_ids.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Sources:</span>
              {dx.citation_ids.map((n) => (
                <button
                  key={n}
                  onClick={() => onCite(n)}
                  className="rounded-md bg-brand-faint px-1.5 py-0.5 text-[11px] font-semibold text-brand hover:bg-brand hover:text-white"
                >
                  [{n}]
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function DdxClient() {
  const [age, setAge] = useState('');
  const [sex, setSex] = useState('?');
  const [cc, setCc] = useState('');
  const [history, setHistory] = useState('');
  const [exam, setExam] = useState('');
  const [vitals, setVitals] = useState('');
  const [data, setData] = useState<DdxResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [openCites, setOpenCites] = useState<Record<number, boolean>>({});
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [totalMs, setTotalMs] = useState<number | undefined>(undefined);

  function pushTrace(stage: string, msg: string, ms?: number, done = false, error = false) {
    setTrace((prev) => {
      const next = prev.map((p, i) => (i === prev.length - 1 && !p.done) ? { ...p, done: true } : p);
      return [...next, { stage, msg, ms, done, error, ts: Date.now() }];
    });
  }
  const sourcesRef = useRef<HTMLDivElement | null>(null);
  const sessionId = useMemo(() => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())), []);

  function loadExample(ex: typeof EXAMPLES[number]) {
    setAge(String(ex.age)); setSex(ex.sex); setCc(ex.cc);
    setHistory(ex.history); setExam(ex.exam); setVitals(ex.vitals);
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!cc.trim()) { setError('Chief complaint is required'); return; }
    setError(null); setData(null); setLoading(true); setOpenCites({});
    setTrace([]); setTotalMs(undefined);
    const t0 = Date.now();
    try {
      const r = await fetch('/api/ddx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          age: age ? Number(age) : undefined,
          sex: sex !== '?' ? sex : undefined,
          cc: cc.trim(),
          history: history.trim() || undefined,
          exam: exam.trim() || undefined,
          vitals: vitals.trim() || undefined,
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        setError(`HTTP ${r.status}: ${t.slice(0, 200)}`);
        return;
      }
      let d: DdxResponse | null = null;
      await consumeNdjson(r, (ev) => {
        if (ev.type === 'progress') pushTrace(ev.stage, ev.msg, ev.ms);
        else if (ev.type === 'sources') { /* citations come with result */ }
        else if (ev.type === 'result') { d = ev.data as DdxResponse; setData(d); }
        else if (ev.type === 'done') { setTotalMs(ev.ms); pushTrace('done', '', ev.ms, true); }
        else if (ev.type === 'error') { setError(ev.message); pushTrace('done', ev.message, undefined, true, true); }
      });
      if (!d) return;
      // Fire-and-forget log
      fetch('/api/log/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feature: 'ddx',
          query_text: `${age || '?'}/${sex} ${cc.trim()}`,
          expanded_query: d.presentation,
          answer_text: JSON.stringify({ summary: d.summary, cannot_miss: d.cannot_miss?.map((x) => x.diagnosis), most_likely: d.most_likely?.map((x) => x.diagnosis), other: d.other?.map((x) => x.diagnosis) }),
          citation_ids: (d.citations || []).map((c) => c.id),
          duration_ms: Date.now() - t0,
          session_id: sessionId,
        }),
      }).catch(() => {});
    } catch (err) {
      setError(String((err as Error).message));
    } finally { setLoading(false); }
  }

  function onCite(n: number) {
    setHighlighted(n);
    setOpenCites((p) => ({ ...p, [n]: true }));
    setTimeout(() => {
      document.getElementById(`ddx-cite-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    setTimeout(() => setHighlighted((h) => (h === n ? null : h)), 2000);
  }

  const cannot = data?.cannot_miss ?? [];
  const likely = data?.most_likely ?? [];
  const other = data?.other ?? [];

  return (
    <div>
      <form onSubmit={submit} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex gap-3">
          <div className="w-20">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Age</label>
            <input
              type="number" min="0" max="120"
              value={age} onChange={(e) => setAge(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              placeholder="58"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Sex</label>
            <select
              value={sex} onChange={(e) => setSex(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="?">—</option>
              <option value="M">Male</option>
              <option value="F">Female</option>
              <option value="O">Other</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Chief complaint <span className="text-rose-500">*</span>
          </label>
          <textarea
            value={cc} onChange={(e) => setCc(e.target.value)}
            rows={2} required
            placeholder="Sudden onset chest pain radiating to left arm × 30 min"
            className="mt-1 w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Key history</label>
          <textarea
            value={history} onChange={(e) => setHistory(e.target.value)}
            rows={2}
            placeholder="HTN, hyperlipidemia, smoker"
            className="mt-1 w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Exam findings</label>
          <textarea
            value={exam} onChange={(e) => setExam(e.target.value)}
            rows={2}
            placeholder="Diaphoretic, anxious, lungs clear"
            className="mt-1 w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Vitals</label>
          <input
            value={vitals} onChange={(e) => setVitals(e.target.value)}
            placeholder="HR 112, BP 145/95, RR 22, SpO2 95% RA, T 37.0°C"
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-slate-400">Chief complaint is required. Other fields refine the differential.</span>
          <button
            type="submit"
            disabled={loading || !cc.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {loading ? 'Reasoning…' : 'Generate DDx'}
          </button>
        </div>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        <span className="text-xs text-slate-400">Try:</span>
        {EXAMPLES.map((ex, i) => (
          <button
            key={i}
            onClick={() => loadExample(ex)}
            disabled={loading}
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:border-brand hover:text-brand disabled:opacity-40"
          >
            {ex.age}/{ex.sex} {ex.cc.split(' ').slice(0, 4).join(' ')}…
          </button>
        ))}
      </div>

      {(trace.length > 0 || loading) && <div className="mt-5"><TracePanel events={trace} totalMs={totalMs} /></div>}

      {error && (
        <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div>
      )}

      {loading && (
        <div className="mt-6 rounded-xl border bg-white p-8 text-center text-slate-400 shadow-sm">
          <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin" />
          Reasoning across MKSAP, StatPearls, and UpToDate…
        </div>
      )}

      {data && !loading && (
        <div className="mt-6 space-y-6">
          {data.summary && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Summary</h2>
              <p className="mt-1 text-sm leading-relaxed text-slate-800">{data.summary}</p>
            </div>
          )}

          {data.missing_info && data.missing_info.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">Missing info that would refine this DDx</h2>
              <ul className="mt-1 ml-4 list-disc space-y-0.5 text-sm text-amber-900">
                {data.missing_info.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}

          {cannot.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-rose-700">
                <AlertTriangle className="h-4 w-4" /> Cannot-miss · rule out first
              </h2>
              <div className="space-y-2">
                {cannot.map((dx, i) => <DxCard key={i} dx={dx} idx={i} danger onCite={onCite} />)}
              </div>
            </section>
          )}

          {likely.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-700">Most likely</h2>
              <div className="space-y-2">
                {likely.map((dx, i) => <DxCard key={i} dx={dx} idx={i} onCite={onCite} />)}
              </div>
            </section>
          )}

          {other.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Other considerations</h2>
              <div className="space-y-2">
                {other.map((dx, i) => <DxCard key={i} dx={dx} idx={i} onCite={onCite} />)}
              </div>
            </section>
          )}

          {data.citations && data.citations.length > 0 && (
            <section ref={sourcesRef}>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <BookOpen className="h-3.5 w-3.5" /> Sources ({data.citations.length})
              </h2>
              <ol className="space-y-2">
                {data.citations.map((c) => {
                  const isOpen = !!openCites[c.n];
                  const isHi = highlighted === c.n;
                  return (
                    <li
                      key={c.n}
                      id={`ddx-cite-${c.n}`}
                      className={`rounded-lg border text-sm shadow-sm transition ${
                        isHi ? 'border-brand bg-brand-faint/40' : 'border-slate-200 bg-white'
                      }`}
                    >
                      <button
                        onClick={() => setOpenCites((p) => ({ ...p, [c.n]: !isOpen }))}
                        className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-1.5">
                            <span className="rounded bg-brand-faint px-1.5 py-0.5 text-[11px] font-semibold text-brand">[{c.n}]</span>
                            <span className="truncate font-medium text-slate-800">{c.book}</span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            {c.chapter && <span>{c.chapter} · </span>}
                            {c.page_start && <span>p.{c.page_start} · </span>}
                            <span>sim {c.similarity.toFixed(2)}</span>
                          </div>
                        </div>
                        {isOpen ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
                      </button>
                      {isOpen && (
                        <div className="border-t border-slate-100 px-3 py-2 text-[13px] leading-relaxed text-slate-700">
                          {c.preview}…
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
