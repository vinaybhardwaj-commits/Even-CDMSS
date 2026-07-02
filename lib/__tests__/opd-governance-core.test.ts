import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGovernanceSignals, GOV_DEFAULT_THRESHOLDS } from '../opd-governance-core.ts';

const doc = (uid: string, attr: string, mean: number, n = 5, name?: string) =>
  ({ uid, name, attrs: { [attr]: { mean, n } } });

test('healthy attribute produces no signal', () => {
  const r = computeGovernanceSignals({ current: [{ attr: 'accurate', mean: 4.3, n: 100 }] });
  assert.equal(r.signals.length, 0);
  assert.equal(r.healthy[0].attr, 'accurate');
});

test('act_now severity below 2.5, watch below 3.5', () => {
  const r = computeGovernanceSignals({
    current: [{ attr: 'thorough', mean: 1.7, n: 100 }, { attr: 'up_to_date', mean: 3.1, n: 100 }],
  });
  assert.equal(r.signals[0].attr, 'thorough');
  assert.equal(r.signals[0].severity, 'act_now');
  assert.equal(r.signals[1].attr, 'up_to_date');
  assert.equal(r.signals[1].severity, 'watch');
});

test('trend computed vs prior window with ±0.3 threshold', () => {
  const r = computeGovernanceSignals({
    current: [{ attr: 'thorough', mean: 1.7, n: 50 }, { attr: 'useful', mean: 2.1, n: 50 }, { attr: 'up_to_date', mean: 3.1, n: 50 }],
    prior: { thorough: 2.1, useful: 2.2, up_to_date: 2.8 },
  });
  const byAttr = Object.fromEntries(r.signals.map((s) => [s.attr, s]));
  assert.equal(byAttr.thorough.trend, 'worsening');
  assert.equal(byAttr.useful.trend, 'flat');
  assert.equal(byAttr.up_to_date.trend, 'improving');
  assert.equal(byAttr.up_to_date.delta, 0.3);
});

test('no baseline ⇒ no_baseline trend', () => {
  const r = computeGovernanceSignals({ current: [{ attr: 'succinct', mean: 2.0, n: 20 }] });
  assert.equal(r.signals[0].trend, 'no_baseline');
  assert.equal(r.signals[0].delta, null);
});

test('systemic scope when most eligible doctors are affected — hospital-level action', () => {
  const doctors = [
    doc('d1', 'synthesized', 1.5), doc('d2', 'synthesized', 2.0), doc('d3', 'synthesized', 2.5),
    doc('d4', 'synthesized', 2.8), doc('d5', 'synthesized', 4.0),
  ];
  const r = computeGovernanceSignals({ current: [{ attr: 'synthesized', mean: 1.8, n: 200 }], doctors });
  const s = r.signals[0];
  assert.equal(s.scope, 'systemic');
  assert.equal(s.affected_share, 0.8);
  assert.match(s.action, /documentation norm/i);
  assert.doesNotMatch(s.action, /\{doctors\}/);
});

test('concentrated scope names the affected doctors, worst first', () => {
  const doctors = [
    doc('d1', 'up_to_date', 2.1, 12, 'Dr Manoj C'), doc('d2', 'up_to_date', 2.3, 8, 'Dr Sanjeev M N'),
    doc('d3', 'up_to_date', 4.2), doc('d4', 'up_to_date', 4.0), doc('d5', 'up_to_date', 3.8),
    doc('d6', 'up_to_date', 4.5), doc('d7', 'up_to_date', 3.9), doc('d8', 'up_to_date', 4.1),
  ];
  const r = computeGovernanceSignals({ current: [{ attr: 'up_to_date', mean: 3.2, n: 150 }], doctors });
  const s = r.signals[0];
  assert.equal(s.scope, 'concentrated');
  assert.equal(s.affected.length, 2);
  assert.equal(s.affected[0].name, 'Dr Manoj C'); // worst first
  assert.match(s.action, /Dr Manoj C \(2\.1, 12 notes\)/);
  assert.match(s.action, /Dr Sanjeev M N/);
});

test('mixed scope appends the lowest-scoring doctors to the systemic action', () => {
  // 40% affected (below systemicShare) but 6 doctors (> concentratedMax 5) ⇒ mixed
  const doctors = Array.from({ length: 15 }, (_, i) =>
    doc(`d${i}`, 'thorough', i < 6 ? 2.0 : 4.0, 5, `Dr ${i}`));
  const r = computeGovernanceSignals({ current: [{ attr: 'thorough', mean: 3.0, n: 150 }], doctors });
  const s = r.signals[0];
  assert.equal(s.scope, 'mixed');
  assert.match(s.action, /huddle teaching point/i);
  assert.match(s.action, /Start with the lowest-scoring doctors/);
});

test('insufficient eligible doctors falls back to systemic wording', () => {
  const doctors = [doc('d1', 'organized', 2.0), doc('d2', 'organized', 2.2)];
  const r = computeGovernanceSignals({ current: [{ attr: 'organized', mean: 2.4, n: 12 }], doctors });
  const s = r.signals[0];
  assert.equal(s.scope, 'insufficient_data');
  assert.equal(s.affected_share, null);
  assert.match(s.action, /SOAP-style/);
});

test('doctors below doctorMinNotes are not eligible', () => {
  const doctors = [
    doc('d1', 'accurate', 1.0, 1), doc('d2', 'accurate', 1.0, 2),
    doc('d3', 'accurate', 4.0, 5), doc('d4', 'accurate', 4.1, 6), doc('d5', 'accurate', 4.2, 7),
  ];
  const r = computeGovernanceSignals({ current: [{ attr: 'accurate', mean: 3.2, n: 30 }], doctors });
  const s = r.signals[0];
  assert.equal(s.eligible_doctors, 3);
  assert.equal(s.affected.length, 0);
});

test('ranking: act_now before watch, then mean ascending; healthy sorted best-first', () => {
  const r = computeGovernanceSignals({
    current: [
      { attr: 'up_to_date', mean: 3.1, n: 50 }, { attr: 'synthesized', mean: 1.8, n: 50 },
      { attr: 'thorough', mean: 1.7, n: 50 }, { attr: 'accurate', mean: 4.3, n: 50 },
      { attr: 'organized', mean: 3.9, n: 50 },
    ],
  });
  assert.deepEqual(r.signals.map((s) => s.attr), ['thorough', 'synthesized', 'up_to_date']);
  assert.deepEqual(r.healthy.map((h) => h.attr), ['accurate', 'organized']);
});

test('thresholds are overridable', () => {
  const r = computeGovernanceSignals({
    current: [{ attr: 'succinct', mean: 3.6, n: 40 }],
    thresholds: { signalBelow: 4.0 },
  });
  assert.equal(r.signals.length, 1);
  assert.equal(r.thresholds.signalBelow, 4.0);
  assert.equal(r.thresholds.actNowBelow, GOV_DEFAULT_THRESHOLDS.actNowBelow);
});
