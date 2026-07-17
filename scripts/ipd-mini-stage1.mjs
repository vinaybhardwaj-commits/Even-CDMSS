// scripts/ipd-mini-stage1.mjs — S6 Stage 1: the capped first Mini/Qwen backfill batch.
//
// WHY A SCRIPT AND NOT THE CRON: a single mini doc measured 303s end-to-end (Gemini multimodal
// extract + Qwen analyze/critique/revise) — OVER the routes' 300s Vercel maxDuration cap, so the
// /api/admin/ipd-audit-mini-backfill autopilot tick cannot complete even one doc per tick (both
// aborted ticks persisted 0 rows). The route ships for the cron path once that's resolved; this
// credentialed local runner delivers V's Stage-1 batch meanwhile. Flagged in the build report.
//
// Same chain as the route (lib/ipd-audit/run.ts, mini:true → analyze on Qwen, isolated
// '-mini' engine version, K=1), oldest-first, persisted PER DOC so a partial run is real work.
//
// Run (credentialed, never CI):
//   node --env-file=.env.local --import tsx scripts/ipd-mini-stage1.mjs [--n 100] [--conc 3] [--out ipd-mini-stage1.json]

import { writeFileSync } from 'fs';
import { fetchBacklogDocs } from '../lib/ipd-audit/db13.ts';
import { auditedDocIdsAnyVersion } from '../lib/ipd-audit/store.ts';
import { runIpdAudit } from '../lib/ipd-audit/run.ts';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const N = Math.max(1, Number(argOf('--n') ?? 100) | 0);
const CONC = Math.max(1, Math.min(4, Number(argOf('--conc') ?? 3) | 0));
const OUT = argOf('--out') ?? 'ipd-mini-stage1.json';

const t0 = Date.now();
const already = await auditedDocIdsAnyVersion();
// fetchBacklogDocs caps at 20/page — page through to the batch size, oldest-first.
const docs = [];
const seen = new Set(already);
while (docs.length < N) {
  const page = await fetchBacklogDocs([...seen], Math.min(20, N - docs.length));
  if (!page.length) break;
  for (const d of page) { docs.push(d); seen.add(d.documentId); }
}
console.log(`[stage1] ${docs.length} backlog docs (oldest ${docs[0]?.day} → newest ${docs.at(-1)?.day}) · conc ${CONC} · engine ipd-discharge-audit/0.1-mini`);

const results = [];
let i = 0, done = 0;
await Promise.all(Array.from({ length: Math.min(CONC, docs.length) }, async () => {
  for (;;) {
    const idx = i++;
    if (idx >= docs.length) return;
    const r = await runIpdAudit(docs[idx], { mini: true });
    results.push({ ...r, day: docs[idx].day });
    done++;
    const rate = done / ((Date.now() - t0) / 3600_000);
    console.log(`[stage1] ${done}/${docs.length} ${r.ip_uid ?? r.documentId} · ${r.skip ?? r.error ?? `${r.band}·${r.cvi} (${r.nLowValue} LV)`} · ${Math.round((r.latencyMs ?? 0) / 1000)}s · ${rate.toFixed(1)} docs/hr`);
    writeFileSync(OUT, JSON.stringify({ results, elapsed_min: +((Date.now() - t0) / 60000).toFixed(1) }, null, 2));
  }
}));

const ok = results.filter((r) => r.status);
const mins = (Date.now() - t0) / 60000;
const bands = {};
for (const r of ok) bands[r.band] = (bands[r.band] ?? 0) + 1;
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
console.log(`\n== S6 STAGE-1 BATCH (Mini/Qwen, K=1) ==`);
console.log(`persisted ${ok.length}/${docs.length} · skips ${results.filter((r) => r.skip).length} · errors ${results.filter((r) => r.error).length} · ${mins.toFixed(1)} min`);
console.log(`throughput: ${(ok.length / (mins / 60)).toFixed(1)} docs/hr · mean ${Math.round(mean(ok.map((r) => r.latencyMs ?? 0)) / 1000)}s/doc`);
console.log(`bands: ${Object.entries(bands).sort().map(([b, n]) => `${b}×${n}`).join(' · ')}`);
console.log(`findings/doc: ${mean(ok.map((r) => r.nFindings ?? 0)).toFixed(1)} · low-value/doc: ${mean(ok.map((r) => r.nLowValue ?? 0)).toFixed(1)}`);
writeFileSync(OUT, JSON.stringify({ results, elapsed_min: +mins.toFixed(1) }, null, 2));
console.log(`wrote ${OUT}`);
process.exit(0);
