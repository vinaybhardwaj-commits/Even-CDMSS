import Link from 'next/link';
import { featureMeta } from '@/lib/observability-meta';
import { fmtInr } from '@/lib/llm-cost-core';
import { costKpis, costByBucket, costByFeature, costByModel, costItemized, costDuplicates, type Scale } from '@/lib/llm-cost';

const SCALES: { k: Scale; l: string }[] = [{ k: 'hour', l: 'Hour' }, { k: 'day', l: 'Day' }, { k: 'week', l: 'Week' }, { k: 'month', l: 'Month' }];

function Kpi({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 px-4 py-3">
      <div className="text-[12px] text-slate-500">{label}</div>
      <div className={`text-[22px] font-medium ${danger ? 'text-red-600' : 'text-slate-900'}`}>{value}</div>
      {sub && <div className={`text-[11px] ${danger ? 'text-red-500' : 'text-slate-400'}`}>{sub}</div>}
    </div>
  );
}

export default async function CostTab({ scale }: { scale: Scale }) {
  const [kpis, chart, byFeat, byModel, items, dupes] = await Promise.all([
    costKpis(), costByBucket(scale), costByFeature(7), costByModel(7), costItemized(60), costDuplicates(24),
  ]);

  // Spike threshold for chart highlighting: 1.8× the mean of the fully-elapsed buckets.
  const full = chart.buckets.slice(0, -1);
  const mean = full.length ? full.reduce((s, b) => s + b.totalInr, 0) / full.length : 0;
  const spikeAt = mean * 1.8;
  const max = Math.max(1, ...chart.buckets.map((b) => b.totalInr));

  return (
    <div>
      <p className="mb-4 max-w-3xl text-sm text-slate-500">
        Rupee cost of every Gemini call, computed from the tokens logged on each run (Vertex list price · Pro $1.25/$10, Flash $0.30/$2.50 per 1M in/out · ₹ at {PRICING_FX()}). Embeddings run on self-hosted Ollama (₹0 marginal). Advisory estimate for spotting spikes and accidental reruns — reconcile against the Vertex invoice.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Today (so far)" value={fmtInr(kpis.today)} sub={kpis.spikePct != null ? `${kpis.spikePct >= 0 ? '+' : ''}${kpis.spikePct}% vs 7-day avg` : undefined} danger={kpis.spikePct != null && kpis.spikePct >= 80} />
        <Kpi label="Yesterday" value={fmtInr(kpis.yesterday)} />
        <Kpi label="Last 7 days" value={fmtInr(kpis.last7)} />
        <Kpi label="Last 30 days" value={fmtInr(kpis.last30)} />
      </div>

      {/* spend chart */}
      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-slate-800">Spend over time · {chart.label}</span>
          <div className="flex gap-1 text-[11px]">
            {SCALES.map((s) => (
              <Link key={s.k} href={`/admin/observability?tab=cost&scale=${s.k}`}
                className={`rounded px-2 py-0.5 ${scale === s.k ? 'bg-brand text-white' : 'text-slate-500 hover:bg-slate-100'}`}>{s.l}</Link>
            ))}
          </div>
        </div>
        {chart.buckets.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">No Gemini calls in this window.</div>
        ) : (
          <>
            <div className="flex items-end gap-1.5" style={{ height: 120 }}>
              {chart.buckets.map((b) => {
                const spike = mean > 0 && b !== chart.buckets[chart.buckets.length - 1] && b.totalInr > spikeAt;
                return (
                  <div key={b.bucket} className="group relative flex-1" title={`${b.bucket} · ${fmtInr(b.totalInr)} · ${b.calls} calls`}>
                    <div className="w-full rounded-t" style={{ height: `${Math.max(2, (b.totalInr / max) * 108)}px`, background: spike ? '#E24B4A' : '#1D9E75' }} />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex justify-between text-[9.5px] text-slate-400">
              <span>{chart.buckets[0]?.bucket}</span>
              <span>{chart.buckets[chart.buckets.length - 1]?.bucket}</span>
            </div>
          </>
        )}
      </div>

      {/* regression watch */}
      {(dupes.groups.length > 0 || (kpis.spikePct != null && kpis.spikePct >= 80)) && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50/60 p-4">
          <div className="text-sm font-medium text-red-700">Regression watch</div>
          <ul className="mt-1.5 space-y-1 text-[12.5px] text-slate-700">
            {kpis.spikePct != null && kpis.spikePct >= 80 && (
              <li>Today's spend is <b>{kpis.spikePct >= 0 ? '+' : ''}{kpis.spikePct}%</b> vs the 7-day daily average ({fmtInr(kpis.today)} vs ~{fmtInr(kpis.last7 / 7)}/day).</li>
            )}
            {dupes.groups.length > 0 && (
              <li><b>~{fmtInr(dupes.totalWastedInr)}</b> likely wasted in the last 24h on {dupes.groups.length} set(s) of identical repeated calls (same feature + token counts):</li>
            )}
          </ul>
          {dupes.groups.length > 0 && (
            <div className="mt-2 space-y-1">
              {dupes.groups.slice(0, 5).map((g, i) => (
                <div key={i} className="flex items-center justify-between rounded bg-white/70 px-2.5 py-1 text-[12px]">
                  <span className="text-slate-700">{featureMeta(g.feature).label} · {g.model} · {g.inTok.toLocaleString()}→{g.outTok.toLocaleString()} tok</span>
                  <span className="tabular-nums text-slate-600">×{g.n} · ~{fmtInr(g.wastedInr, { paise: true })} wasted</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* breakdowns */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.05em] text-slate-400">By feature · last 7 days</div>
          {byFeat.length === 0 ? <div className="text-[12px] text-slate-400">—</div> : byFeat.slice(0, 8).map((g) => (
            <div key={g.key} className="flex items-center justify-between border-t border-slate-100 py-1.5 text-[12.5px] first:border-t-0">
              <span className="text-slate-700">{featureMeta(g.key).label}</span>
              <span className="tabular-nums text-slate-500">{fmtInr(g.inr)} · {g.calls.toLocaleString()} calls</span>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.05em] text-slate-400">By model · last 7 days</div>
          {byModel.length === 0 ? <div className="text-[12px] text-slate-400">—</div> : byModel.map((g) => (
            <div key={g.key} className="flex items-center justify-between border-t border-slate-100 py-1.5 text-[12.5px] first:border-t-0">
              <span className="text-slate-700">{g.key}</span>
              <span className="tabular-nums text-slate-500">{fmtInr(g.inr)} · {g.calls.toLocaleString()} calls</span>
            </div>
          ))}
        </div>
      </div>

      {/* itemized */}
      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.05em] text-slate-400">Itemized calls · latest {items.length}</div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="text-[10.5px] uppercase tracking-wide text-slate-400">
              <tr><th className="py-1 pr-3 font-medium">Date · time (IST)</th><th className="py-1 pr-3 font-medium">Feature</th><th className="py-1 pr-3 font-medium">Model</th><th className="py-1 pr-3 text-right font-medium">In</th><th className="py-1 pr-3 text-right font-medium">Out</th><th className="py-1 text-right font-medium">₹</th></tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="py-1.5 pr-3 tabular-nums text-slate-500">{it.ts}</td>
                  <td className="py-1.5 pr-3"><Link href={`/admin/observability/${it.traceId}`} className="text-slate-700 hover:text-brand">{featureMeta(it.feature).label}</Link></td>
                  <td className="py-1.5 pr-3 text-slate-600">{it.model}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600">{it.inTok.toLocaleString()}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600">{it.outTok.toLocaleString()}</td>
                  <td className="py-1.5 text-right tabular-nums font-medium text-slate-800">{fmtInr(it.inr, { paise: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PRICING_FX(): string {
  const fx = Number(process.env.LLM_FX_USD_INR) || 94.7;
  return `$1 = ₹${fx}`;
}
