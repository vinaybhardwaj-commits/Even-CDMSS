#!/usr/bin/env node
/**
 * scripts/corpus-eval/run-baseline.mjs — Brainstem PR 0: orchestrate sample → verify → metrics.
 *
 * Loads the assembled pack, samples cited findings per consumer, scores each through the GOVERNED
 * Pro verifier (lib/corpus-eval/verify.ts), and computes the support-rate metrics + CI. Grain =
 * (finding, cited-sources-bundle): ONE verdict per cited finding, the finding's cited excerpts passed
 * together (PRD §5 "sources-bundle" — the cleaner, cheaper unit; stated in the report).
 *
 * SL0 mode (`--sl0`): scores only the first ~10 cited findings and reports MEASURED tokens + ₹ per
 * verdict (PRD §5 / cost plan) — run this BEFORE the full baseline to replace the cost-plan estimates.
 *
 * `node --env-file=.env.local --import tsx scripts/corpus-eval/run-baseline.mjs [--sl0] [--per=120]`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readFileSync as _rf } from 'node:fs';
import { verifyClaim } from '../../lib/corpus-eval/verify.ts';
import { supportStats, citeOrLabel } from '../../lib/corpus-eval/verify-core.ts';
import { perCallInr } from '../../lib/llm-cost-core.ts';

const PRICING = JSON.parse(_rf(new URL('../../data/llm-pricing.json', import.meta.url), 'utf8'));

const SL0 = process.argv.includes('--sl0');
const PER = Math.max(1, parseInt((process.argv.find((a) => a.startsWith('--per='))?.split('=')[1]) || process.env.PER || '120', 10));
const SL0_N = 10;
const PACK = '.corpus-eval/pack.json';

/** ₹ for one verdict from measured tokens (data/llm-pricing.json, gemini-2.5-pro, auto tier). */
function inr(usage) {
  try { return perCallInr('gemini-2.5-pro', usage.prompt_tokens, usage.completion_tokens, PRICING); }
  catch { return 0; }
}

async function main() {
  const pack = JSON.parse(readFileSync(PACK, 'utf8'));
  const perConsumer = {};
  const costRows = [];
  let scored = 0;

  for (const consumer of ['opd', 'ipd', 'ccb']) {
    const all = pack.units.filter((u) => u.consumer === consumer);
    const col = citeOrLabel(all.map((u) => ({ cited: u.cited })));
    const cited = all.filter((u) => u.cited && u.excerpts.length);
    const sample = (SL0 ? cited.slice(0, SL0_N) : cited.slice(0, PER));
    const verdicts = [];
    for (const u of sample) {
      const excerpts = u.excerpts.map((e) => ({ text: e.text, meta: e.meta }));
      const out = await verifyClaim(u.claim, excerpts);
      verdicts.push(out.verdict);
      costRows.push({ consumer, tokens_in: out.usage.prompt_tokens, tokens_out: out.usage.completion_tokens, ms: out.usage.ms, inr: inr(out.usage), verdict: out.verdict });
      scored++;
      if (scored % 10 === 0) console.error(`  …scored ${scored} (${consumer})`);
      if (SL0 && verdicts.length >= SL0_N) break;
    }
    perConsumer[consumer] = {
      cite_or_label: col,
      n_cited_findings: cited.length,
      n_scored: sample.length,
      support: supportStats(verdicts),
    };
    console.error(`[${consumer}] cited ${col.cited}/${col.n_claims} · scored ${sample.length} · support ${perConsumer[consumer].support.support_rate?.toFixed(3) ?? '—'} (incl-partial ${perConsumer[consumer].support.support_rate_incl_partial?.toFixed(3) ?? '—'})`);
  }

  // SL0 cost summary (measured)
  const n = costRows.length || 1;
  const sum = (k) => costRows.reduce((a, r) => a + (r[k] || 0), 0);
  const cost = {
    n_verdicts: costRows.length,
    avg_tokens_in: Math.round(sum('tokens_in') / n), avg_tokens_out: Math.round(sum('tokens_out') / n),
    avg_ms: Math.round(sum('ms') / n), avg_inr: sum('inr') / n, total_inr: sum('inr'),
    not_assessable: costRows.filter((r) => r.verdict === 'not_assessable').length,
  };

  const out = { version: 'corpus-eval/1.0', mode: SL0 ? 'sl0-cost-probe' : 'baseline', per_consumer: perConsumer, measured_cost: cost };
  writeFileSync(SL0 ? '.corpus-eval/sl0-cost.json' : '.corpus-eval/baseline.json', JSON.stringify(out, null, 2));
  console.error(`\n[${SL0 ? 'SL0' : 'baseline'}] MEASURED cost: n=${cost.n_verdicts} · avg ${cost.avg_tokens_in} in / ${cost.avg_tokens_out} out tokens · ${cost.avg_ms}ms · ₹${cost.avg_inr.toFixed(4)}/verdict · total ₹${cost.total_inr.toFixed(2)}`);
  console.error(`[${SL0 ? 'SL0' : 'baseline'}] not_assessable: ${cost.not_assessable}/${cost.n_verdicts}`);
  process.exit(0);
}
main().catch((e) => { console.error('run-baseline failed:', e); process.exit(1); });
