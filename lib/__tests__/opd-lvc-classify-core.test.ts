/**
 * Pure-core tests for lib/opd-lvc-classify-core.ts (RIGHT-CARE-INDICATOR-PRD §5 / §9).
 * Run: node --experimental-strip-types --test lib/__tests__/opd-lvc-classify-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLvcCategory, isLowValueVerdict, stampLvcMetadata, classifyLvcFinding,
  suppressedRuleRefs, applyGate, LVC_CATEGORIES,
} from '../opd-lvc-classify-core.ts';

test('classifyLvcCategory: antibiotic | imaging | supplement | other', () => {
  assert.equal(classifyLvcCategory('Azithromycin for a viral URI'), 'antibiotic');
  assert.equal(classifyLvcCategory('MRI lumbar spine for acute low back pain'), 'imaging');
  assert.equal(classifyLvcCategory('Multivitamin supplement without indication'), 'supplement_polypharmacy');
  assert.equal(classifyLvcCategory('Cough syrup for self-limiting cough'), 'other');
  assert.equal(classifyLvcCategory(undefined, null), 'other');
});

test('stampLvcMetadata: low-value findings get rule_ref:null + lvc_category; others untouched; score fields preserved', () => {
  const findings = [
    { subject: 'Azithromycin for viral URI', verdict: 'low-value', confidence: 0.8, domain: 'appropriateness', rationale: 'no bacterial indication' },
    { subject: 'Statin continued', verdict: 'context-dependent', confidence: 0.5, domain: 'appropriateness', rationale: '' },
    { subject: 'Coding gap', verdict: 'low-value', confidence: 0.4, domain: 'appropriateness', rationale: 'uncoded', informational: true },
  ];
  const out = stampLvcMetadata(findings as never[]) as Array<Record<string, unknown>>;
  assert.equal(out[0].rule_ref, null);
  assert.equal(out[0].lvc_category, 'antibiotic');
  // score-relevant fields untouched (invariance)
  assert.equal(out[0].verdict, 'low-value'); assert.equal(out[0].confidence, 0.8); assert.equal(out[0].domain, 'appropriateness');
  // non-low-value → no lvc fields added
  assert.equal(out[1].lvc_category, undefined); assert.equal(out[1].rule_ref, undefined);
  // informational (neutralised) low-value → skipped
  assert.equal(out[2].lvc_category, undefined);
});

test('stampLvcMetadata preserves an existing rule_ref', () => {
  const out = stampLvcMetadata([{ subject: 'X-ray for ankle', verdict: 'low-value', rule_ref: 'cw-42' }] as never[]) as Array<Record<string, unknown>>;
  assert.equal(out[0].rule_ref, 'cw-42');
  assert.equal(out[0].lvc_category, 'imaging');
});

test('classifyLvcFinding: verdict tier authoritative; non-low-value / informational are not LVC', () => {
  assert.equal(classifyLvcFinding({ verdict: 'high-value', subject: 'x' }).is_lvc, false);
  assert.equal(classifyLvcFinding({ verdict: 'low-value', subject: 'x', informational: true }).is_lvc, false);
  assert.ok(isLowValueVerdict('low-value'));
  assert.equal(isLowValueVerdict('context-dependent'), false);
});

test('classifyLvcFinding: stamped row passes its metadata through', () => {
  const c = classifyLvcFinding({ verdict: 'low-value', subject: 'foo', signal_type: 'low_value_care', rule_ref: 'r7', lvc_category: 'imaging' });
  assert.deepEqual(c, { is_lvc: true, rule_ref: 'r7', lvc_category: 'imaging', stamped: true });
  // stamped but bad category → re-derived from text
  const c2 = classifyLvcFinding({ verdict: 'low-value', subject: 'azithromycin course', signal_type: 'low_value_care', rule_ref: null, lvc_category: 'garbage' });
  assert.equal(c2.lvc_category, 'antibiotic');
  assert.equal(c2.stamped, true);
});

test('classifyLvcFinding: fallback text-match to a rule (older engine, no stamp)', () => {
  const rules = [{ id: '17', keywords: ['ppi', 'proton pump'], category: 'other' }, { id: '3', keywords: ['antibiotic', 'uri'], category: 'antibiotic' }];
  const hit = classifyLvcFinding({ verdict: 'low-value', subject: 'Antibiotic for URI' }, rules);
  assert.equal(hit.rule_ref, '3');
  assert.equal(hit.lvc_category, 'antibiotic');
  assert.equal(hit.stamped, false);
  // matches nothing → rule_ref null, category from heuristic (§8: still counts as LVC)
  const miss = classifyLvcFinding({ verdict: 'low-value', subject: 'MRI for headache' }, rules);
  assert.equal(miss.is_lvc, true);
  assert.equal(miss.rule_ref, null);
  assert.equal(miss.lvc_category, 'imaging');
});

test('precision gate: suppress via ledger decision on lvc:<rule_ref>; default keeps all', () => {
  const suppressed = suppressedRuleRefs([
    { cluster_key: 'lvc:17', decision: 'suppress' },
    { cluster_key: 'lvc:3', decision: 'monitor' },   // not suppress → kept
    { cluster_key: 'other:9', decision: 'suppress' }, // wrong prefix → ignored
  ]);
  assert.deepEqual([...suppressed], ['17']);
  const rows = [{ rule_ref: '17' }, { rule_ref: '3' }, { rule_ref: null }];
  assert.deepEqual(applyGate(rows, suppressed).map((r) => r.rule_ref), ['3', null]);
  // v1 default: nothing suppressed → all pass unchanged
  assert.deepEqual(applyGate(rows, new Set<string>()), rows);
});

test('LVC_CATEGORIES vocabulary is the four expected values', () => {
  assert.deepEqual([...LVC_CATEGORIES], ['antibiotic', 'imaging', 'supplement_polypharmacy', 'other']);
});
