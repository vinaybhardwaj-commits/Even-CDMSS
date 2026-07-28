/**
 *   node --test --import tsx lib/__tests__/ml-label-trial.test.ts
 *
 * ML Phase 1 — retrospective validation (PRD 28 Jul 2026). THIS BUILD ONLY MEASURES.
 *
 * WRITTEN FIRST, BEFORE THE PROMPT (kickoff order): the D1 blindness assertions. If any triage
 * field leaks into the prompt, every number the trial produces is worthless and it will not be
 * obvious from the output. The fixture below is POISONED — every human-side field carries a
 * sentinel string, and the rendered prompt must contain none of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  renderLabelPrompt, parseLabelResponse, cohenKappa, computeTrialReport, planTrial,
  TRIAL_PROMPT_VERSION, MAX_TRIAL_CALLS, LABEL_CLASSES,
  type TrialFinding, type TrialRow,
} from '../ml-label-trial/core.ts';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · D1 — BLINDNESS. The single assumption the whole result rests on.
// ═════════════════════════════════════════════════════════════════════════════════════════════

// The renderer's INPUT TYPE has no field for any human-side value — blindness is structural
// first, asserted second. This fixture is what a leak would look like if someone widened it.
const FINDING: TrialFinding = {
  subject: 'Serratiopeptidase co-prescription',
  verdict: 'low-value',
  domain: 'appropriateness',
  signal_type: 'lvc_drug',
  rationale: 'Proteolytic enzyme with no outcome evidence for this indication.',
  confidence: 0.82,
};
const NOTE_CONTEXT = 'Presenting complaints: knee pain · Diagnosis: osteoarthritis · Medications: serratiopeptidase 10mg';

// Sentinels a leak would carry. NOTE: 'nitpick'/'false' legitimately appear in the RUBRIC (the
// model must be told its three classes) — blindness is about the HUMAN'S data, not the taxonomy.
const POISON = {
  humanVerdict: 'true_positive',
  reviewerName: 'ZAKI-SENTINEL-9Q4',
  humanComment: 'COMMENT-SENTINEL-7X2 — I checked this one myself',
  triageField: 'finding_ref_SENTINEL',
  contested: 'contested',
};

test('D1 FIRST: the rendered prompt contains NO human label, reviewer name, or triage field', () => {
  const { system, user } = renderLabelPrompt(FINDING, NOTE_CONTEXT);
  const rendered = `${system}\n${user}`;
  assert.ok(!rendered.includes(POISON.reviewerName), 'no reviewer name can leak — the type has no field for one');
  assert.ok(!rendered.includes(POISON.humanComment), 'no human comment');
  assert.ok(!rendered.includes(POISON.triageField), 'no triage field');
  assert.ok(!rendered.includes('true_positive'), 'the HUMAN vocabulary must not appear — the model answers tp|nitpick|false');
  assert.ok(!/\bauthor\b/i.test(rendered), 'no author field');
  assert.ok(!/\breviewer\b/i.test(rendered), 'no reviewer framing — calibrate, don\'t cosplay (ruling §2a)');
  assert.ok(!/\bDr\.?\s/i.test(rendered), 'no persona (ruling §2a: no "Dr. Zaki" costume)');
  // 'contested' is reserved for humans (D3) — the model must never even see the word.
  assert.ok(!rendered.includes('contested'), 'contested is the clinician\'s speech act, never offered to the model');
});

test('D1 structural: the renderer accepts ONLY the finding + note context — no third argument', () => {
  assert.equal(renderLabelPrompt.length, 2, 'widening the signature is how a leak would start');
  const src = readFileSync('lib/ml-label-trial/core.ts', 'utf8');
  for (const banned of ['human_verdict', 'humanVerdict', 'author', 'reviewed_by', 'triage']) {
    const fn = src.slice(src.indexOf('export function renderLabelPrompt'), src.indexOf('export function parseLabelResponse'));
    assert.ok(!fn.includes(banned), `renderLabelPrompt must not reference "${banned}"`);
  }
});

test('D2: the model sees what a reviewer sees — all six finding fields plus the note context', () => {
  const { user } = renderLabelPrompt(FINDING, NOTE_CONTEXT);
  for (const v of [FINDING.subject, FINDING.verdict, FINDING.domain, FINDING.signal_type!, FINDING.rationale, '0.82', NOTE_CONTEXT]) {
    assert.ok(user.includes(String(v)), `payload must include: ${String(v).slice(0, 40)}`);
  }
  // Missing note context is sent as an explicit marker, never silently omitted (D2).
  const { user: bare } = renderLabelPrompt(FINDING, null);
  assert.ok(bare.includes('(note context unavailable)'), 'absence must be explicit in the payload');
});

test('the rubric uses the reviewer surface\'s own definitions, verbatim', () => {
  const { system } = renderLabelPrompt(FINDING, NOTE_CONTEXT);
  assert.ok(system.includes('Correct and worth surfacing.'));                    // tp
  assert.ok(system.includes('Technically correct but low-value noise.'));        // nitpick
  assert.ok(system.includes('Wrong / not supported by the note.'));              // false
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · §6.3 — the parser: three classes or `unparseable`, NEVER coerced, NEVER dropped
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the parser accepts exactly the three classes', () => {
  assert.deepEqual(LABEL_CLASSES, ['tp', 'nitpick', 'false']);
  assert.equal(parseLabelResponse('{"label":"tp","rationale":"correct flag"}').cls, 'tp');
  assert.equal(parseLabelResponse('{"label":"nitpick","rationale":"noise"}').cls, 'nitpick');
  assert.equal(parseLabelResponse('{"label":"false","rationale":"not in note"}').cls, 'false');
  // tolerated wrappers: code fences, surrounding prose around ONE json object
  assert.equal(parseLabelResponse('```json\n{"label":"tp","rationale":"x"}\n```').cls, 'tp');
});

test('anything outside the three classes is `unparseable` and COUNTED — never coerced', () => {
  for (const bad of [
    '{"label":"true_positive","rationale":"x"}',   // the HUMAN vocabulary is not a model class
    '{"label":"contested","rationale":"x"}',       // reserved for humans, permanently (D3)
    '{"label":"likely_disputed","rationale":"x"}',
    '{"label":"TP","rationale":"x"}',              // case is not coerced
    '{"label":"false positive","rationale":"x"}',
    '{"rationale":"no label at all"}',
    'the finding is probably fine',
    '',
  ]) {
    const r = parseLabelResponse(bad);
    assert.equal(r.cls, 'unparseable', `must be unparseable: ${bad.slice(0, 40)}`);
    assert.ok(typeof r.raw === 'string', 'the raw text is retained for the artefact');
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · κ and the metric core
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('cohenKappa: perfect agreement 1, computed example exact, degenerate cases total', () => {
  assert.equal(cohenKappa([['tp', 'tp'], ['false', 'false'], ['nitpick', 'nitpick']]), 1);
  // Worked example (2x2): po = 0.7, pe = 0.5 → κ = 0.4
  const pairs: [string, string][] = [];
  for (let i = 0; i < 35; i++) pairs.push(['tp', 'tp']);
  for (let i = 0; i < 35; i++) pairs.push(['false', 'false']);
  for (let i = 0; i < 15; i++) pairs.push(['tp', 'false']);
  for (let i = 0; i < 15; i++) pairs.push(['false', 'tp']);
  assert.ok(Math.abs(cohenKappa(pairs) - 0.4) < 1e-9);
  assert.equal(cohenKappa([]), 0, 'empty set: κ 0, never NaN');
  assert.equal(cohenKappa([['tp', 'tp']]), 1, 'single agreeing pair: pe=1 guarded, κ 1 not 0/0');
});

function mkRow(over: Partial<TrialRow>): TrialRow {
  return {
    key: `${over.key ?? 'a:f1'}`, human: 'tp', engine: 'opd-note-audit/0.81.14',
    signalType: 'lvc_drug', pass1: 'tp', pass2: 'tp', contested: false, ...over,
  };
}

test('D5: contested rows are EXCLUDED from κ and every rate, but present and described', () => {
  const rows: TrialRow[] = [
    mkRow({ key: 'a:1', human: 'tp', pass1: 'tp', pass2: 'tp' }),
    mkRow({ key: 'a:2', human: 'false', pass1: 'false', pass2: 'false' }),
    mkRow({ key: 'a:3', human: 'contested', contested: true, pass1: 'tp', pass2: 'false' }),
  ];
  const rep = computeTrialReport(rows);
  assert.equal(rep.reconciliation.scored, 2);
  assert.equal(rep.reconciliation.contested, 1);
  assert.equal(rep.reconciliation.total, 3);
  assert.equal(rep.scored.n, 2, 'κ set excludes the contested row');
  assert.equal(rep.contestedSection.n, 1, '…but the contested answers are STORED and described');
  assert.deepEqual(rep.contestedSection.modelDistribution.pass1, { tp: 1 });
  // The contested row's model answers appear NOWHERE in the confusion matrix.
  const totalCells = Object.values(rep.scored.pooled.confusion).flatMap((r) => Object.values(r)).reduce((s, x) => s + x, 0);
  assert.equal(totalCells, 4, '2 scored rows × 2 passes — nothing contested leaked in');
});

test('unparseable is a COUNTED outcome: disagreement, never dropped, never coerced', () => {
  const rows: TrialRow[] = [
    mkRow({ key: 'a:1', human: 'tp', pass1: 'unparseable', pass2: 'tp' }),
    mkRow({ key: 'a:2', human: 'false', pass1: 'false', pass2: 'false' }),
  ];
  const rep = computeTrialReport(rows);
  assert.equal(rep.unparseable.total, 1);
  assert.equal(rep.scored.n, 2, 'the row with an unparseable answer STAYS in the set');
  // agreement rate for pass1 counts it as a miss: 1 of 2 agree
  assert.equal(rep.scored.pass1.agreementRate, 0.5);
  // self-agreement counts it as a self-disagreement too
  assert.equal(rep.selfAgreement.rate, 0.5);
});

test('κ by engine version partitions the scored set', () => {
  const rows: TrialRow[] = [
    mkRow({ key: 'a:1', engine: 'opd-note-audit/0.81.3', human: 'tp', pass1: 'tp', pass2: 'tp' }),
    mkRow({ key: 'a:2', engine: 'opd-note-audit/0.81.14', human: 'false', pass1: 'tp', pass2: 'tp' }),
  ];
  const rep = computeTrialReport(rows);
  assert.equal(rep.byEngine.length, 2);
  const v3 = rep.byEngine.find((e) => e.engine === 'opd-note-audit/0.81.3')!;
  assert.equal(v3.n, 1);
  assert.equal(v3.agreementRate, 1);
});

test('self-agreement is its own readout, and the kill-condition comparison is computed', () => {
  const rows: TrialRow[] = [
    mkRow({ key: 'a:1', human: 'tp', pass1: 'tp', pass2: 'nitpick' }),      // self-disagrees, p1 agrees w/ human
    mkRow({ key: 'a:2', human: 'false', pass1: 'false', pass2: 'false' }),  // all agree
  ];
  const rep = computeTrialReport(rows);
  assert.equal(rep.selfAgreement.rate, 0.5);
  assert.equal(rep.scored.pass1.agreementRate, 1);
  assert.equal(rep.killCondition.selfAgreementClearlyAboveHuman, false,
    'self 0.5 vs pooled human 0.75 — the §3 conclusion must be COMPUTED, not left to the reader');
  assert.ok(rep.killCondition.statement.length > 0, 'the summary states the conclusion in words');
});

test('per-class precision/recall come from the pooled confusion matrix', () => {
  const rows: TrialRow[] = [
    mkRow({ key: 'a:1', human: 'tp', pass1: 'tp', pass2: 'tp' }),
    mkRow({ key: 'a:2', human: 'tp', pass1: 'false', pass2: 'tp' }),
    mkRow({ key: 'a:3', human: 'false', pass1: 'false', pass2: 'false' }),
  ];
  const rep = computeTrialReport(rows);
  const tp = rep.scored.pooled.perClass.find((c) => c.cls === 'tp')!;
  // human tp appears 4 times across passes; model said tp 3 of those → recall 0.75; model said tp 3 times total, all human-tp → precision 1
  assert.equal(tp.recall, 0.75);
  assert.equal(tp.precision, 1);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · D9 — the hard cap, checked before the first call
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('planTrial: 778 scored + 39 contested ⇒ 1,634 planned calls, under the cap', () => {
  const plan = planTrial(778, 39);
  assert.equal(plan.calls, 1634, 'the D9 expected figure, exactly');
  assert.equal(plan.ok, true);
  assert.ok(plan.calls <= MAX_TRIAL_CALLS);
});

test('planTrial REFUSES over the cap — before the first call, not after', () => {
  const plan = planTrial(MAX_TRIAL_CALLS, 1);   // 2×cap+2 calls
  assert.equal(plan.ok, false);
  assert.match(plan.reason ?? '', /cap/i);
});

test('prompt version is pinned and single-sourced', () => {
  assert.match(TRIAL_PROMPT_VERSION, /^ml-label-trial\/\d+\.\d+$/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · The untouched list — this build ONLY measures
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('no write path to opd_audit_feedback exists anywhere in the trial code', () => {
  for (const f of ['lib/ml-label-trial/core.ts', 'lib/ml-label-trial/client.ts', 'app/api/lab/ml-label-trial/route.ts']) {
    const src = readFileSync(f, 'utf8');
    const code = src.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
    assert.ok(!/INSERT INTO opd_audit_feedback|UPDATE opd_audit_feedback|DELETE FROM opd_audit_feedback/i.test(code),
      `${f} must never write the human label stream (ruling §2b — the moment the streams mix, the ground truth is gone)`);
  }
});

test('label_source shape is the ruling\'s, and the id comes from the RESPONSE', () => {
  const client = readFileSync('lib/ml-label-trial/client.ts', 'utf8');
  assert.ok(client.includes('model:${'), 'label_source = model:<resolved-id>@<prompt-version>');
  assert.ok(client.includes("resolvedModel = typeof j.model === 'string' && j.model ? j.model : 'unresolved'"),
    'the resolved id is read from the provider RESPONSE, never assumed from the request');
  assert.ok(client.includes('temperature: 0'), 'temperature pinned where supported');
  const core = readFileSync('lib/ml-label-trial/core.ts', 'utf8');
  assert.ok(!/DEFAULT_MODEL|'openrouter\/|'google\/|'qwen\/|'anthropic\//.test(core), 'no hardcoded model default in the metric path');
});
