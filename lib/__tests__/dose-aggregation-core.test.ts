/**
 *   node --experimental-strip-types --test lib/__tests__/dose-aggregation-core.test.ts
 * Pure core: molecule-level daily-dose aggregation (parse frequency/strength, aggregate, verdict).
 * The two meeting cases are pinned as fixtures: paracetamol stacking (flag) and a correctly-dosed
 * NSAID + a different-indication antihistamine (no false flag).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrequency, unitsPerDose, strengthTokenToMg, canonicalMolecule,
  moleculesOf, aggregateDailyDose, doseAggregationFindings, isVolumetric,
  type DoseLimitsTable,
} from '../dose-aggregation-core.ts';
import type { OpdMed } from '../opd-ingest-core.ts';

const TABLE: DoseLimitsTable = {
  version: 'dose-limits/test',
  default_sos_cap_per_day: 3,
  limits: [
    { molecule: 'paracetamol', aliases: ['acetaminophen'], max_mg_per_day: 4000, caution_mg_per_day: 3000, caution_note: 'Elderly/hepatic 3 g.', note: 'Hepatotoxic above ceiling.' },
    { molecule: 'aceclofenac', max_mg_per_day: 200 },
    { molecule: 'ibuprofen', max_mg_per_day: 2400 },
    { molecule: 'caffeine', max_mg_per_day: 400 },
  ],
};

// ── frequency parse ───────────────────────────────────────────────────────────
test('parseFrequency: dosing grid sums slots', () => {
  assert.equal(parseFrequency('1-0-1', 3).scheduled, 2);
  assert.equal(parseFrequency('1-1-1', 3).scheduled, 3);
  assert.equal(parseFrequency('1-1-0', 3).scheduled, 2);
  assert.equal(parseFrequency('0-0-1', 3).scheduled, 1);
  assert.equal(parseFrequency('1-0-1-1', 3).scheduled, 3);
});

test('parseFrequency: spoken/abbreviated frequencies', () => {
  assert.equal(parseFrequency('TID', 3).scheduled, 3);
  assert.equal(parseFrequency('BD', 3).scheduled, 2);
  assert.equal(parseFrequency('once a day', 3).scheduled, 1);
  assert.equal(parseFrequency('HS', 3).scheduled, 1);          // once at bedtime = 1/day (the case the auditor missed)
  assert.equal(parseFrequency('every 8 hours', 3).scheduled, 3);
});

test('parseFrequency: SOS is a ceiling, not a fixed dose', () => {
  const bare = parseFrequency('as needed', 3);
  assert.equal(bare.isSos, true); assert.equal(bare.scheduled, 0); assert.equal(bare.sosCap, 3); assert.equal(bare.assumed, true);
  const capped = parseFrequency('sos for fever max TID', 3);
  assert.equal(capped.isSos, true); assert.equal(capped.sosCap, 3); assert.equal(capped.assumed, false);
  const maxN = parseFrequency('SOS max 2', 3);
  assert.equal(maxN.sosCap, 2);
});

test('parseFrequency: empty/garbage → unknown', () => {
  assert.equal(parseFrequency('', 3).unknown, true);
  assert.equal(parseFrequency('take with water', 3).unknown, true);
});

// ── units + strength ──────────────────────────────────────────────────────────
test('unitsPerDose', () => {
  assert.equal(unitsPerDose('1 tablet'), 1);
  assert.equal(unitsPerDose('2 caps'), 2);
  assert.equal(unitsPerDose(''), 1);
  assert.equal(unitsPerDose('1-0-1'), 1);          // a grid mis-entered in the dosage field is not a unit count
});

test('strengthTokenToMg: unit conversion', () => {
  assert.equal(strengthTokenToMg('325mg'), 325);
  assert.equal(strengthTokenToMg('650 MG'), 650);
  assert.equal(strengthTokenToMg('1 g'), 1000);
  assert.equal(strengthTokenToMg('500mcg'), 0.5);
  assert.equal(strengthTokenToMg('abc'), null);
});

// ── molecule split + alignment ────────────────────────────────────────────────
test('canonicalMolecule maps synonyms + ignores non-ceiling co-molecules', () => {
  assert.equal(canonicalMolecule('Paracetamol/Acetaminophen ', TABLE.limits), 'paracetamol');
  assert.equal(canonicalMolecule('Chlorpheniramine Maleate', TABLE.limits), 'chlorpheniramine maleate');
  assert.equal(canonicalMolecule('Aceclofenac', TABLE.limits), 'aceclofenac');
});

test('moleculesOf zips + aligns per-molecule strengths in a combo', () => {
  const m: OpdMed = { generic: 'Aceclofenac+Paracetamol+Serratiopeptidase', brand: 'Zerodol-SP', strength: '100mg+325mg+15mg', dose: '1 tab', frequency: '1-0-1' };
  const mols = moleculesOf(m, TABLE.limits);
  const para = mols.find((x) => x.molecule === 'paracetamol');
  const acl = mols.find((x) => x.molecule === 'aceclofenac');
  assert.equal(para?.perUnitMg, 325);
  assert.equal(acl?.perUnitMg, 100);
});

test('moleculesOf: parenthetical strength list in the generic name does not misalign (real EMR shape)', () => {
  // "Dicyclomine+Paracetamol (20Mg+500Mg)" — the '+' inside the parens must not create a phantom split.
  const m: OpdMed = { generic: 'Dicyclomine+Paracetamol (20Mg+500Mg)', brand: 'Cyclopam', strength: '20MG+500MG', dose: '1 tablet', frequency: '1-0-1' };
  const mols = moleculesOf(m, TABLE.limits);
  const para = mols.find((x) => x.molecule === 'paracetamol');
  assert.equal(para?.perUnitMg, 500);      // not 20 (the dicyclomine strength)
});

// ── the two pinned meeting cases ──────────────────────────────────────────────
test('CASE A — paracetamol stacking across products flags an exceedance', () => {
  const meds: OpdMed[] = [
    { generic: 'Paracetamol', brand: 'Dolo 650', strength: '650mg', dose: '1 tab', frequency: '1-1-1' },             // 1950
    { generic: 'Mefenamic Acid+Paracetamol', brand: 'Meftal-Forte', strength: '500mg+325mg', dose: '1 tab', frequency: '1-1-1' }, // +975
    { generic: 'Chlorpheniramine Maleate+Paracetamol+Phenylephrine', brand: 'Sinarest New', strength: '2mg+500mg+10mg', dose: '1 tablet', frequency: '1-1-1' }, // +1500
  ];
  const loads = aggregateDailyDose(meds, TABLE);
  assert.equal(Math.round(loads.get('paracetamol')!.scheduledMgPerDay), 4425);
  const findings = doseAggregationFindings(meds, TABLE);
  const flag = findings.find((f) => f.subject.startsWith('Daily dose exceeds ceiling: paracetamol'));
  assert.ok(flag, 'expected a paracetamol ceiling flag');
  assert.equal(flag!.verdict, 'low-value');
  assert.ok(flag!.confidence >= 0.8);
  assert.ok(!flag!.informational);
});

test('CASE B — a single correctly-dosed NSAID + a different-indication drug does NOT flag', () => {
  const meds: OpdMed[] = [
    { generic: 'Aceclofenac', brand: 'Hifenac', strength: '100mg', dose: '1 tab', frequency: '1-0-1' },   // 200 = ceiling, not over
    { generic: 'Levocetirizine', brand: 'Levocet', strength: '5mg', dose: '1 tab', frequency: '0-0-1' },   // no ceiling → never flagged
  ];
  const findings = doseAggregationFindings(meds, TABLE);
  assert.equal(findings.filter((f) => !f.informational).length, 0, 'no penalising flags expected');
});

test('single product over its own ceiling still flags (no stacking required)', () => {
  const meds: OpdMed[] = [
    { generic: 'Aceclofenac', brand: 'Aceclo', strength: '100mg', dose: '1 tab', frequency: '1-1-1' },   // 300 > 200
  ];
  const findings = doseAggregationFindings(meds, TABLE);
  assert.ok(findings.some((f) => f.subject.startsWith('Daily dose exceeds ceiling: aceclofenac')));
});

test('SOS-only exceedance is a softer, lower-confidence advisory', () => {
  const meds: OpdMed[] = [
    { generic: 'Paracetamol', brand: 'Dolo 650', strength: '650mg', dose: '1 tab', frequency: '1-1-1' },        // 1950 scheduled
    { generic: 'Paracetamol', brand: 'Dolo 1000', strength: '1000mg', dose: '1 tab', frequency: 'sos max TID' }, // +3000 if all taken → 4950
  ];
  const findings = doseAggregationFindings(meds, TABLE);
  // scheduled alone (1950) is under 4000, so the hard flag must NOT fire...
  assert.ok(!findings.some((f) => f.subject.startsWith('Daily dose exceeds ceiling: paracetamol')));
  // ...but the SOS-max advisory should.
  const soft = findings.find((f) => f.subject.startsWith('Daily dose may exceed ceiling if all SOS taken: paracetamol'));
  assert.ok(soft, 'expected an SOS-max advisory');
  assert.equal(soft!.verdict, 'context-dependent');
  assert.ok(soft!.confidence <= 0.4);
});

test('paediatric liquid/suspension (concentration strength, ml dose) is excluded — no false flag', () => {
  // Real EMR shape: Calpol 250mg/5ml, 5 ml QID. The tablet model would compute 250*5*4 = 5000 mg;
  // it must instead be skipped (concentration formulation, weight-based paeds dosing, out of scope).
  assert.equal(isVolumetric({ strength: '250mg/5ml', dose: '5 ml', frequency: '1-1-1-1' }), true);
  const meds: OpdMed[] = [
    { generic: 'Paracetamol', brand: 'Calpol 250mg Paediatric Suspension', strength: '250mg/5ml', dose: '5 ml', frequency: '1-1-1-1' },
  ];
  const loads = aggregateDailyDose(meds, TABLE);
  assert.equal(loads.get('paracetamol')!.scheduledMgPerDay, 0);   // not 5000
  assert.equal(loads.get('paracetamol')!.incomplete, true);
  assert.equal(doseAggregationFindings(meds, TABLE).filter((f) => !f.informational).length, 0);
});

test('same molecule in two products but within ceiling → informational only', () => {
  const meds: OpdMed[] = [
    { generic: 'Paracetamol', brand: 'Dolo 500', strength: '500mg', dose: '1 tab', frequency: '1-0-1' },   // 1000
    { generic: 'Aceclofenac+Paracetamol', brand: 'Zerodol-P', strength: '100mg+325mg', dose: '1 tab', frequency: '1-0-1' }, // +650
  ];
  const findings = doseAggregationFindings(meds, TABLE);
  const info = findings.find((f) => f.subject.includes('within ceiling') && f.subject.includes('paracetamol'));
  assert.ok(info, 'expected an informational within-ceiling note');
  assert.equal(info!.informational, true);
  assert.equal(info!.confidence, 0);
});


test('BUG-0.8-13: a syrup dosed "10ml (2 tsp)" is volumetric and its volume is never a tablet count', () => {
  const med = { strength: '5mg+2mg+10mg', dose: '10ml (2 tsp)', brand: 'Ascoril D Plus Syrup', frequency: '1-0-1' } as any;
  assert.equal(isVolumetric(med), true);
  assert.equal(unitsPerDose('10ml (2 tsp)'), 1);
  assert.equal(unitsPerDose('2 tsp'), 1);
  assert.equal(unitsPerDose('2 tablet'), 2);   // real tablet counts still parse
});
