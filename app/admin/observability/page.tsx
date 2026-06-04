import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Observability · CAT Admin' };

type ListRow = { trace_id: string; feature: string; status: string; started_at: string; total_ms: number | null; question_preview: string | null; severity: string | null };
type ModRow = { module: string; n: number; p50: number | null; errs: number };
type VolRow = { d: string; module: string; n: number };

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const MOD_COLOR: Record<string, string> = {
  ask: '#3b82f6', ddx: '#8b5cf6', drugs: '#10b981', search: '#64748b',
  topics: '#f59e0b', practice: '#ec4899', coach: '#6366f1',
};
const modColor = (m: string) => MOD_COLOR[m] || '#94a3b8';
function Badge({ m }: { m: string }) {
  const c = modColor(m);
  return <span className="rounded px-1.5 py-0.5 text-[11px]" style={{ background: c + '22', color: c }}>{m}</span>;
}
function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const ms = (v: number | null | undefined) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);

async function num(text: string, params: unknown[]): Promise<number> {
  try { const r = await run(text, params); return Number((r[0] as { n?: number })?.n ?? 0); } catch { return 0; }
}
async function rowsOf<T>(text: string, params: unknown[]): Promise<T[]> {
  try { return (await run(text, params)) as T[]; } catch { return []; }
}

function Locked({ configured, bad }: { configured: boolean; bad: boolean }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Observability</h1>
      <p className="mt-1 text-sm text-slate-500">Internal usage &amp; pipeline audit. This surface shows raw clinical queries, so it is access-controlled.</p>
      <div className="mt-8 max-w-sm rounded-lg border border-slate-200 bg-white p-5">
        {!configured ? (
          <p className="text-sm text-rose-700">Locked. Set the <code className="rounded bg-slate-100 px-1">ADMIN_TOKEN</code> environment variable to enable this surface.</p>
        ) : (
          <form method="POST" action="/api/admin/unlock">
            <label className="block text-sm font-medium text-slate-700">Admin token</label>
            <input type="password" name="token" autoFocus className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Enter admin token" />
            {bad && <p className="mt-2 text-xs text-rose-600">Incorrect token.</p>}
            <button type="submit" className="mt-3 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white">Unlock</button>
          </form>
        )}
      </div>
    </div>
  );
}

export default async function ObservabilityAdmin({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; feature?: string; status?: string; locked?: string }> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;
  const tab = sp.tab === 'queries' ? 'queries' : 'overview';
  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Observability</h1>
          <p className="mt-1 text-sm text-slate-500">Usage, query logs and a full event-based audit trail of every module. Internal — shows raw clinical queries.</p>
        </div>
        <form method="POST" action="/api/admin/unlock?action=logout"><button className="text-xs text-slate-400 hover:text-slate-700">Lock</button></form>
      </div>
      <div className="mt-6 flex gap-5 border-b border-slate-200">
        {[['overview', 'Overview'], ['queries', 'Queries']].map(([k, l]) => (
          <Link key={k} href={`/admin/observability?tab=${k}`} className={`-mb-px pb-2 text-sm ${tab === k ? 'border-b-2 border-slate-900 font-medium text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}>{l}</Link>
        ))}
      </div>
      <div className="mt-5">
        {tab === 'overview' ? <OverviewTab /> : <QueriesTab sp={sp} />}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md bg-slate-100 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold text-slate-900">{value}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

async function OverviewTab() {
  const today = await num(`SELECT count(*)::int n FROM traces WHERE app_source=$1 AND started_at::date=current_date`, [APP]);
  const week = await num(`SELECT count(*)::int n FROM traces WHERE app_source=$1 AND started_at > now()-interval '7 days'`, [APP]);
  const er = (await rowsOf<{ errs: number; total: number }>(`SELECT count(*) FILTER (WHERE status='error')::int errs, count(*)::int total FROM traces WHERE app_source=$1 AND started_at > now()-interval '7 days'`, [APP]))[0] || { errs: 0, total: 0 };
  const lat = (await rowsOf<{ p50: number | null; p95: number | null }>(`SELECT percentile_cont(0.5) within group (order by total_ms)::int p50, percentile_cont(0.95) within group (order by total_ms)::int p95 FROM traces WHERE app_source=$1 AND status='success' AND total_ms IS NOT NULL AND started_at > now()-interval '7 days'`, [APP]))[0] || { p50: null, p95: null };
  const vol = await rowsOf<VolRow>(`SELECT to_char(started_at::date,'YYYY-MM-DD') d, CASE WHEN feature LIKE 'coach%' THEN 'coach' ELSE feature END module, count(*)::int n FROM traces WHERE app_source=$1 AND started_at > now()-interval '13 days' GROUP BY 1,2 ORDER BY 1`, [APP]);
  const perMod = await rowsOf<ModRow>(`SELECT CASE WHEN feature LIKE 'coach%' THEN 'coach' ELSE feature END module, count(*)::int n, percentile_cont(0.5) within group (order by total_ms)::int p50, count(*) FILTER (WHERE status='error')::int errs FROM traces WHERE app_source=$1 AND started_at > now()-interval '7 days' GROUP BY 1 ORDER BY n DESC`, [APP]);
  const recent = await rowsOf<ListRow>(`SELECT trace_id, feature, status, to_char(started_at,'YYYY-MM-DD"T"HH24:MI:SSOF') started_at, total_ms, question_preview, severity FROM traces WHERE app_source=$1 ORDER BY started_at DESC LIMIT 8`, [APP]);

  const errRate = er.total > 0 ? ((er.errs / er.total) * 100).toFixed(1) + '%' : '0%';

  // 14-day buckets
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(); d.setUTCDate(d.getUTCDate() - i); days.push(d.toISOString().slice(0, 10)); }
  const modules = Array.from(new Set(vol.map((v) => v.module)));
  const byDay = new Map<string, Record<string, number>>();
  for (const d of days) byDay.set(d, {});
  let maxTotal = 1;
  for (const v of vol) { const rec = byDay.get(v.d); if (rec) rec[v.module] = (rec[v.module] || 0) + v.n; }
  for (const d of days) { const rec = byDay.get(d)!; const t = Object.values(rec).reduce((a, b) => a + b, 0); if (t > maxTotal) maxTotal = t; }

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <Kpi label="Queries today" value={today.toLocaleString()} />
        <Kpi label="Last 7 days" value={week.toLocaleString()} />
        <Kpi label="Error rate (7d)" value={errRate} sub={`${er.errs} of ${er.total}`} />
        <Kpi label="p50 latency" value={ms(lat.p50)} />
        <Kpi label="p95 latency" value={ms(lat.p95)} />
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-slate-800">Query volume · last 14 days</span>
          <div className="flex flex-wrap gap-2 text-[11px] text-slate-500">
            {modules.map((m) => (<span key={m} className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: modColor(m) }} />{m}</span>))}
          </div>
        </div>
        <div className="flex items-end gap-1.5" style={{ height: 96 }}>
          {days.map((d) => {
            const rec = byDay.get(d)!;
            const total = Object.values(rec).reduce((a, b) => a + b, 0);
            const present = modules.filter((m) => rec[m]);
            return (
              <div key={d} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${d}: ${total}`}>
                <div className="flex w-full flex-col justify-end" style={{ height: 78 }}>
                  {present.map((m) => (<div key={m} style={{ background: modColor(m), height: `${Math.max(2, Math.round((rec[m] / maxTotal) * 78))}px` }} />))}
                </div>
                <span className="text-[10px] text-slate-400">{d.slice(8, 10)}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-1 text-[11px] text-slate-400">peak {maxTotal}/day</div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-medium text-slate-800">By module · last 7 days</div>
          {perMod.length === 0 ? <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">No queries in the last 7 days.</div> : (
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white text-sm">
              <div className="flex px-3 py-2 text-xs text-slate-500"><span className="flex-1">module</span><span className="w-14 text-right">queries</span><span className="w-16 text-right">p50</span><span className="w-14 text-right">errors</span></div>
              {perMod.map((r) => (
                <div key={r.module} className="flex border-t border-slate-100 px-3 py-2"><span className="flex-1"><Badge m={r.module} /></span><span className="w-14 text-right text-slate-700">{r.n}</span><span className="w-16 text-right text-slate-500">{ms(r.p50)}</span><span className="w-14 text-right text-slate-500">{r.errs}</span></div>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="mb-2 text-sm font-medium text-slate-800">Recent queries</div>
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            {recent.length === 0 ? <div className="p-6 text-center text-sm text-slate-500">No queries yet.</div> : recent.map((r) => (
              <Link key={r.trace_id} href={`/admin/observability/${r.trace_id}`} className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-0 hover:bg-slate-50">
                <Badge m={r.feature.startsWith('coach') ? 'coach' : r.feature} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-slate-700">{r.question_preview || '(no preview)'}</span>
                {r.status === 'error' ? <span className="text-[11px] text-rose-600">error</span> : <span className="text-[11px] text-slate-400">{ms(r.total_ms)}</span>}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

async function QueriesTab({ sp }: { sp: { q?: string; feature?: string; status?: string } }) {
  const params: unknown[] = [APP];
  let where = `app_source=$1`;
  if (sp.feature) { params.push(sp.feature); where += ` AND (CASE WHEN feature LIKE 'coach%' THEN 'coach' ELSE feature END)=$${params.length}`; }
  if (sp.status) { params.push(sp.status); where += ` AND status=$${params.length}`; }
  if (sp.q) { params.push(`%${sp.q}%`); where += ` AND question_preview ILIKE $${params.length}`; }
  const list = await rowsOf<ListRow>(`SELECT trace_id, feature, status, to_char(started_at,'YYYY-MM-DD"T"HH24:MI:SSOF') started_at, total_ms, question_preview, severity FROM traces WHERE ${where} ORDER BY started_at DESC LIMIT 100`, params);

  return (
    <div>
      <form method="GET" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="queries" />
        <div><label className="block text-[11px] text-slate-500">Search</label><input name="q" defaultValue={sp.q || ''} placeholder="question text…" className="rounded border border-slate-300 px-2 py-1 text-sm" /></div>
        <div><label className="block text-[11px] text-slate-500">Module</label>
          <select name="feature" defaultValue={sp.feature || ''} className="rounded border border-slate-300 px-2 py-1 text-sm">
            <option value="">all</option>{['ask', 'ddx', 'drugs', 'search', 'topics', 'practice', 'coach'].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div><label className="block text-[11px] text-slate-500">Status</label>
          <select name="status" defaultValue={sp.status || ''} className="rounded border border-slate-300 px-2 py-1 text-sm">
            <option value="">all</option><option value="success">success</option><option value="error">error</option><option value="running">running</option>
          </select>
        </div>
        <button className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white">Filter</button>
        <Link href="/admin/observability?tab=queries" className="px-2 py-1.5 text-sm text-slate-500">Reset</Link>
      </form>

      {list.length === 0 ? <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">No matching queries.</div> : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex px-3 py-2 text-xs text-slate-500"><span className="w-20">when</span><span className="w-16">module</span><span className="flex-1">query</span><span className="w-20 text-right">latency</span><span className="w-20 text-right">status</span></div>
          {list.map((r) => (
            <Link key={r.trace_id} href={`/admin/observability/${r.trace_id}`} className="flex items-center border-t border-slate-100 px-3 py-2 text-sm hover:bg-slate-50">
              <span className="w-20 text-xs text-slate-500">{timeAgo(r.started_at)}</span>
              <span className="w-16"><Badge m={r.feature.startsWith('coach') ? 'coach' : r.feature} /></span>
              <span className="min-w-0 flex-1 truncate text-slate-700">{r.question_preview || '(no preview)'}</span>
              <span className="w-20 text-right text-xs text-slate-500">{ms(r.total_ms)}</span>
              <span className="w-20 text-right text-xs">{r.status === 'error' ? <span className="text-rose-600">error{r.severity ? '' : ''}</span> : r.status === 'running' ? <span className="text-amber-600">running</span> : <span className="text-emerald-600">success</span>}</span>
            </Link>
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-slate-400">Showing latest {list.length} (max 100). Click a row for the full pipeline audit.</p>
    </div>
  );
}
