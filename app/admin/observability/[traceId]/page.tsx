import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Trace · CAT Admin' };

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

type Trace = { trace_id: string; feature: string; status: string; started_at: string; total_ms: number | null; question_preview: string | null; severity: string | null; input: unknown; model_summary: unknown; final_answer_text: string | null; error_message: string | null };
type Ev = { seq: number; ts: string; kind: string; stage: string | null; payload: Record<string, unknown> | null; latency_ms: number | null };
type Hit = { n?: number; id?: number; book?: string; chapter?: string; section?: string; page_start?: number; chunk_type?: string; similarity?: number; rerank_score?: number; text?: string; doi?: string; title?: string; year?: number };

const ms = (v: number | null | undefined) => (v == null ? '' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
const MOD_COLOR: Record<string, string> = { ask: '#3b82f6', ddx: '#8b5cf6', drugs: '#10b981', search: '#64748b', topics: '#f59e0b', practice: '#ec4899', coach: '#6366f1' };
const modColor = (m: string) => MOD_COLOR[m.startsWith('coach') ? 'coach' : m] || '#94a3b8';

function Pre({ children }: { children: string }) {
  return <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] leading-snug text-slate-700">{children}</pre>;
}
function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export default async function TraceDetail({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  if (!(await isAdminUnlocked())) {
    return <div><h1 className="text-2xl font-semibold text-slate-900">Locked</h1><p className="mt-2 text-sm text-slate-500"><Link className="text-blue-600 underline" href="/admin/observability">Unlock the observability surface</Link> to view traces.</p></div>;
  }

  const tr = (await run(`SELECT trace_id, feature, status, to_char(started_at,'YYYY-MM-DD HH24:MI:SS') started_at, total_ms, question_preview, severity, input, model_summary, final_answer_text, error_message FROM traces WHERE trace_id=$1 AND app_source=$2 LIMIT 1`, [traceId, APP]).catch(() => []))[0] as Trace | undefined;
  if (!tr) return <div><Link href="/admin/observability?tab=queries" className="text-sm text-blue-600">← Queries</Link><p className="mt-4 text-sm text-slate-500">Trace not found.</p></div>;
  const events = (await run(`SELECT seq, to_char(ts,'HH24:MI:SS') ts, kind, stage, payload, latency_ms FROM trace_events WHERE trace_id=$1 ORDER BY seq`, [traceId]).catch(() => [])) as Ev[];

  const visible = events.filter((e) => e.kind !== 'stream_event');
  const retr = events.find((e) => e.kind === 'retrieval_hydrated');
  const hits = ((retr?.payload?.hits as Hit[]) || []);
  const plos = events.find((e) => e.kind === 'plos_search');
  const plosHits = ((plos?.payload?.hits as Hit[]) || []);
  const finalText = tr.final_answer_text || asText((events.find((e) => e.kind === 'final_answer')?.payload as { answer_text?: unknown })?.answer_text) || '';
  const citeTokens = Array.from(new Set((finalText.match(/\[(P?\d+)\]/g) || []).map((s) => s.slice(1, -1))));

  function sourceLabel(tok: string): string {
    if (tok[0] === 'P') {
      const i = Number(tok.slice(1)) - 1; const h = plosHits[i];
      return h ? `PLOS · ${h.title || h.doi || '?'}${h.year ? ` (${h.year})` : ''}` : 'PLOS source (not found)';
    }
    const k = Number(tok); const h = hits.find((x) => x.n === k) || hits[k - 1];
    return h ? `${h.book || '?'}${h.chapter ? ' · ' + h.chapter : ''}${h.section ? ' · ' + h.section : ''}${typeof h.similarity === 'number' ? ` (sim ${h.similarity.toFixed(2)})` : ''}` : 'source (not found)';
  }

  return (
    <div>
      <Link href="/admin/observability?tab=queries" className="text-sm text-blue-600">← Queries</Link>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded px-2 py-0.5 text-xs" style={{ background: modColor(tr.feature) + '22', color: modColor(tr.feature) }}>{tr.feature}</span>
        <h1 className="text-xl font-semibold text-slate-900">{tr.question_preview || '(no preview)'}</h1>
      </div>
      <div className="mt-1 text-xs text-slate-500">
        trace {tr.trace_id} · {tr.started_at} · {tr.total_ms != null ? ms(tr.total_ms) + ' total · ' : ''}
        <span className={tr.status === 'error' ? 'text-rose-600' : tr.status === 'success' ? 'text-emerald-600' : 'text-amber-600'}>{tr.status}</span>
        {tr.severity ? ` · severity ${tr.severity}` : ''}
      </div>
      {tr.error_message && <div className="mt-3 rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">{tr.error_message}</div>}

      {citeTokens.length > 0 && (
        <div className="mt-5 rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-2 text-sm font-medium text-slate-800">Citation attribution ({citeTokens.length})</div>
          <div className="space-y-1">
            {citeTokens.map((t) => (<div key={t} className="flex gap-2 text-[12px]"><span className="font-mono text-slate-500">[{t}]</span><span className="text-slate-700">{sourceLabel(t)}</span></div>))}
          </div>
        </div>
      )}

      <div className="mt-5 text-sm font-medium text-slate-800">Pipeline timeline</div>
      <div className="mt-2 space-y-2">
        {visible.map((e) => <EventCard key={e.seq} e={e} />)}
      </div>
    </div>
  );
}

function EventCard({ e }: { e: Ev }) {
  const p = (e.payload || {}) as Record<string, unknown>;
  const lat = e.latency_ms != null ? ` · ${ms(e.latency_ms)}` : '';
  const head = (label: string, extra?: string) => (
    <div className="text-[13px] font-medium text-slate-800">{label}<span className="font-normal text-slate-400"> · {e.ts}{e.stage ? ` · ${e.stage}` : ''}{lat}{extra ? ` · ${extra}` : ''}</span></div>
  );

  if (e.kind === 'request_received') {
    const body = (p.body ?? p) as unknown;
    return <div className="rounded-lg border border-slate-200 bg-white p-3">{head('Request received')}<div className="mt-1 text-[11px] text-slate-500">raw input</div><Pre>{asText(body).slice(0, 4000)}</Pre></div>;
  }
  if (e.kind === 'retrieval_hydrated') {
    const hits = (p.hits as Hit[]) || [];
    const variants = (p.variants as string[]) || [];
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        {head('RAG retrieval', `${p.hit_count ?? hits.length} hits`)}
        {variants.length > 0 && <div className="mt-1 text-[11px] text-slate-500">query variants: {variants.map((v, i) => <span key={i} className="mr-1 rounded bg-slate-100 px-1">{v}</span>)}</div>}
        <div className="mt-2 space-y-1">
          {hits.slice(0, 12).map((h, i) => (
            <details key={i} className="rounded bg-slate-50 p-1.5">
              <summary className="cursor-pointer text-[12px] text-slate-700">[{h.n ?? i + 1}] {h.book || '?'}{h.chapter ? ' · ' + h.chapter : ''}{h.section ? ' · ' + h.section : ''} <span className="text-slate-400">{typeof h.similarity === 'number' ? `sim ${h.similarity.toFixed(2)}` : ''}{typeof h.rerank_score === 'number' ? ` · rr ${Number(h.rerank_score).toFixed(2)}` : ''}</span></summary>
              <div className="mt-1 text-[11px] text-slate-600">{(h.text || '').slice(0, 600)}</div>
            </details>
          ))}
        </div>
      </div>
    );
  }
  if (e.kind === 'plos_search') {
    const hits = (p.hits as Hit[]) || [];
    return <div className="rounded-lg border border-slate-200 bg-white p-3">{head('PLOS search', `${p.hit_count ?? hits.length} hits`)}<div className="mt-1 space-y-0.5 text-[11px] text-slate-600">{hits.slice(0, 8).map((h, i) => <div key={i}>[P{i + 1}] {h.title || h.doi}{h.year ? ` (${h.year})` : ''}</div>)}</div></div>;
  }
  if (e.kind === 'llm_request') {
    const msgs = (p.messages as Array<{ role: string; content: string }>) || [];
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        {head('LLM request', String(p.model ?? ''))}
        <details className="mt-1"><summary className="cursor-pointer text-[11px] text-slate-500">prompt ({msgs.length} messages)</summary>{msgs.map((m, i) => (<div key={i} className="mt-1"><div className="text-[11px] font-medium text-slate-500">{m.role}</div><Pre>{String(m.content || '').slice(0, 6000)}</Pre></div>))}</details>
      </div>
    );
  }
  if (e.kind === 'llm_response' || e.kind === 'llm_response_stream_complete') {
    const content = asText(p.content);
    return <div className="rounded-lg border border-slate-200 bg-white p-3">{head('LLM response', `${p.char_count ?? content.length} chars`)}<details className="mt-1"><summary className="cursor-pointer text-[11px] text-slate-500">response</summary><Pre>{content.slice(0, 8000)}</Pre></details></div>;
  }
  if (e.kind === 'critique_parsed') {
    return <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">{head('Self-critique', `severity ${p.severity ?? '?'} · ${p.issue_count ?? '?'} issues`)}<details className="mt-1"><summary className="cursor-pointer text-[11px] text-slate-500">critique detail</summary><Pre>{asText(p.critique).slice(0, 4000)}</Pre></details></div>;
  }
  if (e.kind === 'final_answer') {
    return <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">{head('Final answer', `${p.char_count ?? ''} chars`)}<Pre>{asText(p.answer_text).slice(0, 8000)}</Pre></div>;
  }
  // generic
  return <div className="rounded-lg border border-slate-200 bg-white p-3">{head(e.kind)}<details className="mt-1"><summary className="cursor-pointer text-[11px] text-slate-500">payload</summary><Pre>{asText(p).slice(0, 3000)}</Pre></details></div>;
}
