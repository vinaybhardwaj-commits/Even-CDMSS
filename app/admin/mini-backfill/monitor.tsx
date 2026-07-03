'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

type Range = '24h' | '7d' | '30d' | 'all';
type Bucket = { t: string; notes: number; avgSec: number | null };
type Tick = { t: string; status: string; processed: number };
type Recent = { uid: string; band: string | null; idx: number | null; sec: number | null; at: string; kind: string | null };
type Payload = {
  ok: boolean;
  kpis: { processedToday: number; totalMini: number; avgSecPerNote: number | null; state: string; window: string; prod: boolean; tag: string; cursor: string | null; floor: string };
  throughput: Bucket[];
  bucketMinutes: number;
  ticks: Tick[];
  inflight: { active: boolean; day?: string | null; sinceSec?: number; ttlSec?: number };
  recent: Recent[];
  generatedAt: string;
};

const RANGES: Range[] = ['24h', '7d', '30d', 'all'];
const TEAL = '#1D9E75';
const RED = '#E24B4A';

function agoLabel(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Zero-fill the throughput series onto a continuous bucket axis so idle stretches read as gaps. */
function continuousSeries(buckets: Bucket[], bucketMinutes: number, hours: number): { notes: number[]; lat: (number | null)[]; labels: string[] } {
  const bucketMs = bucketMinutes * 60000;
  const now = Math.floor(Date.now() / bucketMs) * bucketMs;
  const slots = Math.min(420, Math.max(6, Math.round((hours * 3600000) / bucketMs)));
  const byEpoch = new Map<number, Bucket>();
  for (const b of buckets) { const e = Math.floor(Date.parse(b.t) / bucketMs) * bucketMs; byEpoch.set(e, b); }
  const notes: number[] = [], lat: (number | null)[] = [], labels: string[] = [];
  for (let i = slots - 1; i >= 0; i--) {
    const e = now - i * bucketMs;
    const b = byEpoch.get(e);
    notes.push(b ? b.notes : 0);
    lat.push(b ? b.avgSec : null);
    const d = new Date(e);
    labels.push(bucketMinutes >= 1440
      ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
      : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
  }
  return { notes, lat, labels };
}

function ThroughputChart({ buckets, bucketMinutes, hours }: { buckets: Bucket[]; bucketMinutes: number; hours: number }) {
  const { notes, lat, labels } = continuousSeries(buckets, bucketMinutes, hours);
  const W = 1000, H = 200, padL = 34, padB = 18, padT = 8, padR = 30;
  const iw = W - padL - padR, ih = H - padB - padT;
  const maxN = Math.max(1, ...notes);
  const maxL = Math.max(1, ...lat.filter((x): x is number => x != null));
  const n = notes.length;
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const yN = (v: number) => padT + ih - (v / maxN) * ih;
  const yL = (v: number) => padT + ih - (v / maxL) * ih;
  const areaPts = notes.map((v, i) => `${x(i).toFixed(1)},${yN(v).toFixed(1)}`).join(' ');
  const area = `M ${padL},${(padT + ih).toFixed(1)} L ${areaPts.split(' ').join(' L ')} L ${(padL + iw).toFixed(1)},${(padT + ih).toFixed(1)} Z`;
  const line = `M ${notes.map((v, i) => `${x(i).toFixed(1)},${yN(v).toFixed(1)}`).join(' L ')}`;
  // latency: draw only across contiguous non-null runs
  const latSegs: string[] = [];
  let cur: string[] = [];
  lat.forEach((v, i) => { if (v == null) { if (cur.length > 1) latSegs.push('M ' + cur.join(' L ')); cur = []; } else cur.push(`${x(i).toFixed(1)},${yL(v).toFixed(1)}`); });
  if (cur.length > 1) latSegs.push('M ' + cur.join(' L '));
  const tickEvery = Math.max(1, Math.ceil(n / 8));
  const gy = [0, 0.5, 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[210px] w-full" role="img" aria-label="Notes processed per bucket over time, with idle gaps shown as valleys">
      {gy.map((g, i) => { const yy = padT + ih - g * ih; const val = Math.round(g * maxN); return (
        <g key={i}>
          <line x1={padL} y1={yy} x2={padL + iw} y2={yy} stroke="#e2e8f0" strokeWidth={1} />
          <text x={padL - 6} y={yy + 3} textAnchor="end" fontSize={9} fill="#94a3b8">{val}</text>
        </g>
      ); })}
      <path d={area} fill={TEAL} opacity={0.12} />
      <path d={line} fill="none" stroke={TEAL} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {latSegs.map((d, i) => <path key={i} d={d} fill="none" stroke="#378ADD" strokeWidth={1} strokeDasharray="3 3" opacity={0.75} vectorEffect="non-scaling-stroke" />)}
      {labels.map((l, i) => i % tickEvery === 0 ? (
        <text key={i} x={x(i)} y={H - 5} textAnchor="middle" fontSize={9} fill="#94a3b8">{l}</text>
      ) : null)}
      <text x={padL + iw + 4} y={padT + 6} fontSize={8.5} fill="#378ADD">{maxL}s</text>
    </svg>
  );
}

const STATUS_COLOR: Record<string, string> = {
  running: TEAL, finished: '#0F6E56', paused: '#e2e8f0', closed_window: '#e2e8f0', locked: '#cbd5e1', error: RED,
};

function StateStrip({ ticks }: { ticks: Tick[] }) {
  if (!ticks.length) return <div className="flex h-5 items-center rounded-md border border-slate-200 bg-slate-50 px-2 text-[10px] text-slate-400">no ticks recorded yet — fills in from the next autopilot tick</div>;
  const slots = 96;
  const t0 = Date.parse(ticks[0].t), t1 = Date.parse(ticks[ticks.length - 1].t) || Date.now();
  const span = Math.max(1, t1 - t0);
  const buckets: (Tick[] | null)[] = Array.from({ length: slots }, () => null);
  for (const tk of ticks) {
    const i = Math.min(slots - 1, Math.floor(((Date.parse(tk.t) - t0) / span) * slots));
    (buckets[i] ||= [] as unknown as Tick[])!.push(tk);
  }
  const dom = (b: Tick[] | null): string => {
    if (!b || !b.length) return 'empty';
    if (b.some((x) => x.status === 'error')) return 'error';
    if (b.some((x) => x.processed > 0 || x.status === 'running')) return 'running';
    if (b.some((x) => x.status === 'finished')) return 'finished';
    return b[b.length - 1].status;
  };
  return (
    <div className="flex h-5 overflow-hidden rounded-md border border-slate-200">
      {buckets.map((b, i) => { const s = dom(b); return (
        <div key={i} className="h-full flex-1" title={s === 'empty' ? 'no tick' : s} style={{ background: s === 'empty' ? '#f8fafc' : (STATUS_COLOR[s] || '#e2e8f0') }} />
      ); })}
    </div>
  );
}

const BAND_CLS: Record<string, string> = {
  A: 'bg-teal-50 text-teal-700', B: 'bg-amber-50 text-amber-700', C: 'bg-orange-50 text-orange-700', D: 'bg-rose-50 text-rose-700', E: 'bg-rose-50 text-rose-700',
};

export default function MiniBackfillMonitor() {
  const [range, setRange] = useState<Range>('7d');
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState('');
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/mini-backfill-monitor?range=${rangeRef.current}`, { cache: 'no-store' });
      const j = (await r.json()) as Payload;
      if (!j.ok) { setErr('load error'); return; }
      setErr(''); setData(j);
    } catch { setErr('offline'); }
  }, []);

  useEffect(() => { load(); }, [load, range]);
  useEffect(() => { const id = setInterval(load, 5000); return () => clearInterval(id); }, [load]);

  const hours = range === '24h' ? 24 : range === '7d' ? 168 : range === '30d' ? 720 : 24 * 400;
  const k = data?.kpis;
  const stateLabel = k?.state === 'running' ? 'Running' : k?.state === 'paused' ? 'Paused' : 'Idle (window closed)';
  const stateCls = k?.state === 'running' ? 'text-teal-700' : k?.state === 'paused' ? 'text-slate-400' : 'text-amber-700';

  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${k?.state === 'running' ? 'bg-teal-500' : k?.state === 'paused' ? 'bg-slate-300' : 'bg-amber-400'}`} />
          <span className="font-serif text-[14px] font-semibold text-slate-900">Pipeline activity</span>
          {data?.inflight.active ? <span className="ml-1 rounded bg-teal-50 px-1.5 py-0.5 text-[10px] font-semibold text-teal-700">auditing {data.inflight.day} · {data.inflight.sinceSec}s</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {err ? <span className="text-[10px] text-rose-500">{err}</span> : <span className="text-[10px] text-slate-300">refreshes 5s</span>}
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button key={r} type="button" onClick={() => setRange(r)}
                className={`rounded-md px-2.5 py-1 text-[11px] ${range === r ? 'bg-brand/10 text-brand' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'}`}>{r}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-3 px-4 py-3 sm:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-2.5">
          <div className="text-[10.5px] text-slate-400">Processed today</div>
          <div className="mt-0.5 font-serif text-[20px] font-semibold text-slate-800">{(k?.processedToday ?? 0).toLocaleString('en-IN')}</div>
        </div>
        <div className="rounded-lg bg-slate-50 p-2.5">
          <div className="text-[10.5px] text-slate-400">Total mini-audited</div>
          <div className="mt-0.5 font-serif text-[20px] font-semibold text-slate-800">{(k?.totalMini ?? 0).toLocaleString('en-IN')}</div>
        </div>
        <div className="rounded-lg bg-slate-50 p-2.5">
          <div className="text-[10.5px] text-slate-400">Avg / note</div>
          <div className="mt-0.5 font-serif text-[20px] font-semibold text-slate-800">{k?.avgSecPerNote ? `${k.avgSecPerNote}s` : '—'}</div>
        </div>
        <div className="rounded-lg bg-slate-50 p-2.5">
          <div className="text-[10.5px] text-slate-400">State</div>
          <div className={`mt-0.5 font-serif text-[16px] font-semibold ${stateCls}`}>{data ? stateLabel : '…'}</div>
          <div className="text-[10px] text-slate-400">{k ? `${k.window} · ${k.prod ? 'prod 0.6' : k.tag}` : ''}</div>
        </div>
      </div>

      <div className="px-4 pb-1">
        <div className="mb-1 flex items-center gap-4 text-[10.5px] text-slate-500">
          <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: TEAL }} />notes / {data && data.bucketMinutes >= 1440 ? 'day' : 'hour'}</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-3.5" style={{ background: '#378ADD' }} />avg latency</span>
        </div>
        {data ? <ThroughputChart buckets={data.throughput} bucketMinutes={data.bucketMinutes} hours={hours} /> : <div className="h-[210px] animate-pulse rounded bg-slate-50" />}
      </div>

      <div className="px-4 pb-3 pt-1">
        <div className="mb-1 text-[10.5px] text-slate-400">Pipeline state — last 48h ({data?.ticks.length ?? 0} ticks)</div>
        {data ? <StateStrip ticks={data.ticks} /> : <div className="h-5 animate-pulse rounded bg-slate-50" />}
        <div className="mt-1.5 flex flex-wrap gap-3 text-[10px] text-slate-400">
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: TEAL }} />running</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-200" />paused / window closed</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: RED }} />error</span>
        </div>
      </div>

      <div className="border-t border-slate-100">
        <div className="flex items-center justify-between px-4 py-2">
          <span className="text-[12px] font-semibold text-slate-700">Live feed</span>
          <span className="text-[10px] text-slate-300">last {data?.recent.length ?? 0} audits</span>
        </div>
        <div className="divide-y divide-slate-50">
          {data?.inflight.active ? (
            <div className="flex items-center gap-2.5 bg-teal-50/50 px-4 py-2">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-teal-500" />
              <span className="flex-1 text-[12.5px] text-slate-700">Now auditing <code className="rounded bg-white px-1 text-[11px]">{data.inflight.day}</code></span>
              <span className="text-[11px] text-slate-400">{data.inflight.sinceSec}s elapsed</span>
            </div>
          ) : null}
          {(data?.recent ?? []).map((r, i) => (
            <div key={r.uid + i} className="flex items-center gap-2.5 px-4 py-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${r.band ? (BAND_CLS[r.band] || 'bg-slate-100 text-slate-500') : 'bg-slate-100 text-slate-500'}`}>{r.band ? `${r.band} · ${r.idx}` : '—'}</span>
              <span className="flex-1 truncate text-[12.5px] text-slate-600"><code className="text-[11px]">{r.uid.slice(0, 6)}…{r.uid.slice(-3)}</code>{r.kind ? <span className="ml-1.5 text-slate-400">{r.kind}</span> : null}</span>
              <span className="whitespace-nowrap text-[11px] text-slate-400">{r.sec != null ? `${r.sec}s · ` : ''}{agoLabel(r.at)}</span>
            </div>
          ))}
          {data && !data.recent.length ? <div className="px-4 py-3 text-[11px] text-slate-400">No mini audits yet.</div> : null}
        </div>
      </div>
    </div>
  );
}
