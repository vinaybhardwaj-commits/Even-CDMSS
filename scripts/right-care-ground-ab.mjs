// scripts/right-care-ground-ab.mjs — Right Care × ClinicalState Slice 2: the golden A/B.
// For every case in the FROZEN right-care-eval/1.0 bank, runs each mode UNGROUNDED (OFF —
// exactly prod) vs GROUNDED (ON — PATIENT PICTURE injected via the Part-A optional params;
// no env flag is flipped: the runner passes clinicalStateText explicitly, which is precisely
// what the flag gates in the routes). An LLM pair-judge classifies every change; OFF-vs-OFF
// repeat pairs on a subset give the noise floor. Writes the scorecard JSON + prints the
// per-mode delta report for V's ratification.
//
// Run: node --env-file=.env.local --import tsx scripts/right-care-ground-ab.mjs [outfile]
// Cost: ~49 pipeline arms + ~31 Flash/Pro judge calls. Manual, credentialed — never in CI.

import { writeFileSync, mkdirSync } from 'fs';
import { matchLowValueCare } from '../lib/lvc.ts';
import { traceSkeleton, enrichPathway } from '../lib/pathway.ts';
import { analyzeCase } from '../lib/doc-audit.ts';
import { buildRightCareState, rightCareExtractInput, patientPictureBlock } from '../lib/right-care-state.ts';
import { extractedCaseToState } from '../lib/clinical-state/to-audit-family.ts';
import { chatWithFallback, geminiModelFor, geminiUtilityModel, TEXT_MODEL } from '../lib/llm.ts';
import {
  GROUND_BANK, RIGHT_CARE_EVAL_BANK, RIGHT_CARE_GROUND_EVAL_VERSION,
  checkView, pathwayView, auditView, diffCheckFlags,
  PAIR_JUDGE_SYSTEM, buildPairJudgeUser, parsePairJudgeResponse, summarizeMode,
} from '../lib/right-care-ground-eval-core.ts';

const OUT = process.argv[2] || 'data/right-care-eval/ground-ab-scorecard-v1.json';
// OFF-vs-OFF noise subset (13 repeat arms) — includes both safety sentinels.
const NOISE_IDS = new Set(['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'P01', 'P03', 'P06', 'A01', 'A03']);

async function judgeChat(system, user) {
  const gemini = geminiModelFor('appropriateness') ?? geminiUtilityModel();
  const r = await chatWithFallback({
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.1,
    max_tokens: 1200,
    ...( { options: { num_ctx: 8192 }, keep_alive: '15m' } ),
  }, gemini);
  return r.choices?.[0]?.message?.content ?? '';
}

async function judgePair(c, offV, onV, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await judgeChat(PAIR_JUDGE_SYSTEM, buildPairJudgeUser(c, offV, onV));
      return parsePairJudgeResponse(raw);
    } catch (e) {
      if (attempt === 2) {
        console.warn(`[judge] ${label} unparseable twice: ${e.message}`);
        return { overall: 'neutral', changes: [], safety: [], note: 'judge-unparseable (excluded-as-neutral)' };
      }
    }
  }
}

function pictureFor(c) {
  if (c.mode === 'audit') return patientPictureBlock(extractedCaseToState(c.extracted));
  return null; // check/pathway build async below
}

async function runCheck(c, grounded) {
  const input = {
    scenario: c.scenario, proposedActions: c.proposedActions, patient: c.patient,
    surface: 'surface', trace: false,
  };
  if (grounded) {
    const built = await buildRightCareState(rightCareExtractInput('check', {
      scenario: c.scenario, proposedActions: c.proposedActions, age: c.patient?.age, sex: c.patient?.sex,
    }));
    if (built) input.clinicalStateText = patientPictureBlock(built.state);
  }
  const r = await matchLowValueCare(input);
  return checkView(r);
}

async function runPathway(c, grounded) {
  let clinicalStateText;
  if (grounded) {
    const built = await buildRightCareState(rightCareExtractInput('pathway', {
      scenario: c.scenario, age: c.patient?.age, sex: c.patient?.sex,
    }));
    if (built) clinicalStateText = patientPictureBlock(built.state);
  }
  const base = { scenario: c.scenario, patient: c.patient, trace: false, ...(clinicalStateText ? { clinicalStateText } : {}) };
  const { skeleton } = await traceSkeleton(base);
  if (!skeleton) return pathwayView(null, null);
  const { enrichment } = await enrichPathway({ ...base, stages: skeleton.stages, workingDiagnosis: skeleton.workingDiagnosis });
  return pathwayView(skeleton, enrichment);
}

async function runAudit(c, grounded) {
  const opts = { trace: false, ...(grounded ? { clinicalStateText: pictureFor(c) } : {}) };
  const { report } = await analyzeCase(c.extracted, {}, opts);
  return auditView(report);
}

const RUNNERS = { check: runCheck, pathway: runPathway, audit: runAudit };

// Small concurrency pool — kind to Vertex + the local mini.
async function pool(items, width, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

const t0 = Date.now();
console.log(`right-care ground A/B · bank ${RIGHT_CARE_EVAL_BANK} · ${GROUND_BANK.length} cases`);

// Phase 1 — all arms (OFF, ON, and OFF2 for the noise subset), 3-wide.
const arms = [];
for (const c of GROUND_BANK) {
  arms.push({ c, arm: 'off' }, { c, arm: 'on' });
  if (NOISE_IDS.has(c.id)) arms.push({ c, arm: 'off2' });
}
const armResults = await pool(arms, 3, async ({ c, arm }) => {
  const t = Date.now();
  try {
    const view = await RUNNERS[c.mode](c, arm === 'on');
    console.log(`  ${c.id} ${arm.padEnd(4)} done ${((Date.now() - t) / 1000).toFixed(0)}s`);
    return { id: c.id, arm, view };
  } catch (e) {
    console.warn(`  ${c.id} ${arm} FAILED: ${e.message}`);
    return { id: c.id, arm, error: String(e.message) };
  }
});
const byIdArm = new Map(armResults.map((r) => [`${r.id}:${r.arm}`, r]));

// Phase 2 — judge ON-vs-OFF pairs + OFF2-vs-OFF noise pairs, 4-wide.
const judgeJobs = [];
for (const c of GROUND_BANK) {
  const off = byIdArm.get(`${c.id}:off`);
  const on = byIdArm.get(`${c.id}:on`);
  if (off?.view && on?.view) judgeJobs.push({ c, kind: 'ab', a: off.view, b: on.view });
  const off2 = byIdArm.get(`${c.id}:off2`);
  if (off?.view && off2?.view) judgeJobs.push({ c, kind: 'noise', a: off.view, b: off2.view });
}
const judged = await pool(judgeJobs, 4, async ({ c, kind, a, b }) => {
  const verdict = await judgePair(c, a, b, `${c.id}:${kind}`);
  console.log(`  judge ${c.id} ${kind}: ${verdict.overall}${verdict.safety.length ? ` · SAFETY ${verdict.safety.map((s) => s.class).join(',')}` : ''}`);
  return { caseId: c.id, mode: c.mode, kind, verdict };
});

// Phase 3 — scorecards + artifact.
const scorecards = {};
for (const mode of ['check', 'pathway', 'audit']) {
  const pairs = judged.filter((j) => j.mode === mode && j.kind === 'ab').map(({ caseId, verdict }) => ({ caseId, verdict }));
  const noise = judged.filter((j) => j.mode === mode && j.kind === 'noise').map(({ caseId, verdict }) => ({ caseId, verdict }));
  scorecards[mode] = summarizeMode(mode, pairs, noise.length ? noise : null);
}
const checkDiffs = GROUND_BANK.filter((c) => c.mode === 'check').map((c) => {
  const off = byIdArm.get(`${c.id}:off`)?.view;
  const on = byIdArm.get(`${c.id}:on`)?.view;
  return off && on ? { caseId: c.id, ...diffCheckFlags(off, on), offN: off.flags.length, onN: on.flags.length } : { caseId: c.id, error: 'arm missing' };
});

const artifact = {
  version: RIGHT_CARE_GROUND_EVAL_VERSION,
  bank: RIGHT_CARE_EVAL_BANK,
  generated: new Date().toISOString(),
  judgeModel: geminiModelFor('appropriateness') ?? geminiUtilityModel() ?? TEXT_MODEL,
  scorecards,
  checkFlagDiffs: checkDiffs,
  pairs: judged,
  arms: armResults.map((r) => ({ id: r.id, arm: r.arm, ...(r.error ? { error: r.error } : { view: r.view }) })),
  bankNotes: Object.fromEntries(GROUND_BANK.map((c) => [c.id, c.note])),
};
mkdirSync(OUT.split('/').slice(0, -1).join('/'), { recursive: true });
writeFileSync(OUT, JSON.stringify(artifact, null, 2));

console.log(`\n== DELTA REPORT (bank ${RIGHT_CARE_EVAL_BANK}) ==`);
for (const [mode, sc] of Object.entries(scorecards)) {
  console.log(`${mode}: n=${sc.n} · +${sc.improvements} improvement / ${sc.neutrals} neutral / -${sc.regressions} regression · changedRate ${(sc.changedRate * 100).toFixed(0)}% (noise ${sc.noise ? (sc.noise.changedRate * 100).toFixed(0) + '%' : 'n/a'}) · safety ${sc.safetyViolations.length} · GATE ${sc.gate}`);
  for (const v of sc.safetyViolations) console.log(`   SAFETY ${v.class}: ${v.item} — ${v.note ?? ''}`);
}
console.log(`\nwrote ${OUT} · total ${((Date.now() - t0) / 60000).toFixed(1)} min`);
