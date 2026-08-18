/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-brief.test.ts
 * The R1 case brief composer (CDMSS-READMISSIONS-R1-PRD v1.1 §7) — a GOLDEN FILE pins the
 * structure verbatim, including the bill sentences and (R3, READMISSIONS-R3 PRD v1.0 §3.4)
 * the two service-type bill tables. Regenerate deliberately with
 *   UPDATE_BRIEF_GOLDEN=1 node --test --import tsx lib/__tests__/readmission-brief.test.ts
 * and review the diff — a changed brief is a changed deliverable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BILL_SENTENCE_EVEN, BILL_SENTENCE_OON, briefFilename, candidatePattern, composeBrief,
  toExtractSubset, withholdNumbers, type ExtractSubset,
} from '../readmission/brief.ts';
import type { SurfaceFinding } from '../readmission-surface-core.ts';

const GOLDEN = join(process.cwd(), 'lib/__tests__/fixtures/readmission-brief.golden.md');

const row = (over: Partial<SurfaceFinding> = {}): SurfaceFinding => ({
  dedupKey: 'IP-2026-0101|IP-2026-0342', findingClass: 'even_even', lane: 'tight_bounce', auditStatus: 'audited',
  patientName: 'Asha Khan', uhid: 'UH-77812', ageGender: '58F', gapDays: 4,
  indexDepartment: 'Orthopaedics', readmitDepartment: 'Orthopaedics', indexDoctor: 'Dr R Menon', readmitDoctor: 'Dr S Iyer',
  indexDischargeAt: '2026-06-01T10:00:00+05:30', readmitAdmitAt: '2026-06-05T09:30:00+05:30',
  payerIndex: 'Even', payerReadmit: 'Even', cmNote: 'Patient called on day 3 — fever and wound discharge; advised to return. Contact 98765 43210.',
  planned: 'unplanned', sameCondition: 'same', avoidable: 'needs_adjudication',
  labTier: 'tier1', labTimingProfile: 'has_late_labs', nOmissions: 1,
  needsHumanReview: true, promotedToFull: false, notAuditableReason: null,
  finding: {
    planned: { verdict: 'unplanned' }, sameCondition: { verdict: 'same' },
    omissions: [{ claim: 'surgical site infection — late culture, wound discharge', danger: 'moderate', confidence: 'moderate', source: 'model' }],
    exculpatory: [{ claim: 'patient non-adherent to dressing advice', corroborated: false }],
    avoidable: { verdict: 'needs_adjudication', reason: 'passes agree on the label but cite disjoint evidence' },
    labSourceProvenance: { indexCase: 'store', readmitCase: 'store', structuredLabCount: 6, indexDocumentId: 'DOC-1', readmitDocumentId: 'DOC-2' },
    // R2: five-state coverage — one of each looked-state so the artefact table exercises them.
    templateCoverage: { ot: { status: 'present', count: 1 }, pac: { status: 'absent', count: 0 }, progress: { status: 'empty', count: 3 } },
    stabilityAssessment: 'contradicted', corroborationTrack: 'lab_corroborated',
    refusalRecord: [
      { lookedFor: 'ot_note', found: true, note: '1 row(s) with usable text' },
      { lookedFor: 'pac_note', found: false, note: 'no row in db13 for this stay/window' },
      { lookedFor: 'progress_note', found: false, note: '3 row(s) exist but none carries usable text' },
    ],
  },
  omissionEvidence: null,
  preventableInjury: 'suspected', negligence: 'unknown', judgementRuleVersion: 'readmit-judgement/1',
  indexCase: { diagnosis: 'Fracture neck of femur (L)', indication: null, procedure: 'Cemented hemiarthroplasty', age: 58, sex: 'F' },
  // R3: the return stay's hospital bill value object, as the list / case route computes it.
  returnBill: { state: 'billed', netRs: 96450, lines: 38 },
  ...over,
});

// R3 §3.4 — the two stays' bills by service_type, as the case route returns them.
const indexBill = {
  ok: true, lines: 52, totalRs: 184000,
  groups: [
    { serviceType: 'IP Package', netRs: 150000, lines: 1 }, { serviceType: 'Pharmacy', netRs: 21500, lines: 34 },
    { serviceType: 'Investigations', netRs: 8600, lines: 12 }, { serviceType: 'Room Rent', netRs: 6400, lines: 4 },
    { serviceType: 'Refund', netRs: -2500, lines: 1 },
  ],
};
const readmitBill = {
  ok: true, lines: 38, totalRs: 96450,
  groups: [
    { serviceType: 'Surgery', netRs: 45000, lines: 1 }, { serviceType: 'Pharmacy', netRs: 28950, lines: 26 },
    { serviceType: 'Room Rent', netRs: 12000, lines: 6 }, { serviceType: 'Investigations', netRs: 10500, lines: 5 },
  ],
};

const indexExtract: ExtractSubset = {
  diagnosis: 'Fracture neck of femur (L)', indication: 'Displaced intracapsular fracture', procedure: 'Cemented hemiarthroplasty',
  investigations: ['Hb 10.2', 'CRP 48'], treatments: ['IV cefuroxime 48h'], medications: ['Enoxaparin 40 mg OD', 'Paracetamol 650 mg TDS'],
  courseSummary: 'Uneventful stay; mobilised day 2; wound clean at discharge.', disposition: 'Home', followUp: 'OPD in 2 weeks',
  riskFactors: ['T2DM'], patient: { age: 58, sex: 'F' },
};
const readmitExtract: ExtractSubset = {
  diagnosis: 'Superficial SSI', indication: null, procedure: null,
  investigations: ['CRP 132', 'Wound swab: MRSA'], treatments: ['IV vancomycin'], medications: [],
  courseSummary: 'Wound opened and washed; culture-directed antibiotics.', disposition: null, followUp: null,
  riskFactors: [], patient: { age: null, sex: null },
};

test('golden — the Even→Even brief structure is verbatim §7 (Part 1 · Part 2, source tags, fixed sentences, R3 bill tables)', () => {
  const b = composeBrief({ row: row(), indexExtract, readmitExtract, indexBill, readmitBill, detailFetched: true });
  if (process.env.UPDATE_BRIEF_GOLDEN === '1') writeFileSync(GOLDEN, b.markdown);
  const golden = readFileSync(GOLDEN, 'utf8');
  assert.equal(b.markdown, golden);
  assert.equal(b.filename, 'uh-77812-khan-readmission-brief.md');
  // R3 (R3-8): a BILLED return replaces the R1 sentence with the measured, tagged figure; the
  // Part 1 cell reads the same figure; both tables are present; the advisory line is verbatim.
  assert.doesNotMatch(b.markdown, /Return stay bill not yet measured — no figure is available for this return\./);
  assert.match(b.markdown, /- Bill: Return stay bill: ₹96,450 — hospital bill, net of refunds\. \[hospital bill, db13\]/);
  assert.match(b.markdown, /- Return stay bill: ₹96,450 \[finding row\]/);
  assert.match(b.markdown, /- Index stay bill — 52 line\(s\) \[hospital bill, db13\]/);
  assert.match(b.markdown, /\| Total \| ₹1,84,000 \| \[hospital bill, db13\] \|/);
  assert.match(b.markdown, /- Return stay bill — 38 line\(s\) \[hospital bill, db13\]/);
  assert.match(b.markdown, /\| Total \| ₹96,450 \| \[hospital bill, db13\] \|/);
  assert.match(b.markdown, /\| Refund \| ₹-2,500 \| \[hospital bill, db13\] \|/);   // refunds render as computed, negative
  assert.match(b.markdown, /\| Hospital bill \| present \|/);
  assert.match(b.markdown, /advisory — not a court or council finding/);
  assert.match(b.markdown, /## Part 1 — Intern presentation/);
  assert.match(b.markdown, /## Part 2 — Actuarial \/ low-value-care/);
  for (const h of ['### Why this case', '### Index stay', '### Interval', '### Return', '### Artefacts', '### Assessment', '### Looked for and not found']) {
    assert.ok(b.markdown.includes(h), h);
  }
  // Mobiles never — the CM note's number is withheld; the rest of the note survives.
  assert.doesNotMatch(b.markdown, /98765 43210/);
  assert.match(b.markdown, /\[number withheld\]/);
  // R3-8 amended contract: the ONLY rupees are the hospital's measured bill — every ₹ line
  // carries the [hospital bill, db13] tag or is the Part 1 cell reading the same value object.
  for (const l of b.markdown.split('\n').filter((x) => /₹|Rs\.? ?\d/.test(x) && !/^\| Service \|/.test(x))) {
    assert.match(l, /\[hospital bill, db13\]|^- Return stay bill: ₹[\d,.]+ \[finding row\]$/, l);
  }
  // A pre-R3 caller (no returnBill, no breakdowns) still writes NO rupee anywhere.
  const pre = composeBrief({ row: row({ returnBill: undefined }), indexExtract, readmitExtract, detailFetched: true });
  assert.doesNotMatch(pre.markdown, /₹|Rs\.? ?\d/);
  assert.match(pre.markdown, /Return stay bill not yet measured — no figure is available for this return\./);
  assert.match(pre.markdown, /- Index stay bill: not available \[hospital bill, db13\]/);
  // Every extracted line is source-tagged.
  for (const l of b.markdown.split('\n').filter((x) => /^- (Diagnosis|Indication|Procedure|Course|Investigations|Treatments|Medications)/.test(x))) {
    assert.match(l, /\[discharge summary — (first|return) stay\]$/, l);
  }
});

test('OON brief: the other-hospital bill sentence, the POST_IPD form line, no readmit extract lines', () => {
  const b = composeBrief({
    row: row({
      dedupKey: 'IP-2026-0101|form:F-9', findingClass: 'out_of_network', lane: 'out_of_network',
      readmitDepartment: null, readmitDoctor: null, payerReadmit: null, avoidable: null, indexCase: null,
      // An OON finding carries no readmit document (§5a) — its provenance says so.
      finding: { ...row().finding, avoidable: null, labSourceProvenance: { indexCase: 'store', readmitCase: null, structuredLabCount: 6, indexDocumentId: 'DOC-1', readmitDocumentId: null } },
      // R3: an OON row's value object is `na`; the class rule would win even if it were not.
      returnBill: { state: 'na', netRs: null, lines: null },
    }),
    indexExtract: null, readmitExtract: null, indexBill, readmitBill: null, detailFetched: true,
  });
  assert.match(b.markdown, new RegExp(BILL_SENTENCE_OON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(b.markdown, new RegExp(BILL_SENTENCE_EVEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // R3: the index table prints; there is NO return table and no "not available" line for the return.
  assert.match(b.markdown, /- Index stay bill — 52 line\(s\) \[hospital bill, db13\]/);
  assert.doesNotMatch(b.markdown, /Return stay bill: not available|Return stay bill —/);
  assert.match(b.markdown, /- Department: out of network — no second IP stay at Even/);
  assert.match(b.markdown, /- Care-manager follow-up form held: Patient called on day 3/);
  assert.match(b.markdown, /\| Discharge summary — return stay \| n\/a \|/);
  assert.match(b.markdown, /\| Hospital bill \| n\/a \|/);
  assert.match(b.markdown, /Return stay bill: n\/a/);
  assert.match(b.markdown, /Medical justification: Needs adjudication \(no avoidable verdict is made on the other hospital\)/);
  assert.match(b.markdown, /Diagnosis \/ indication \/ procedure: unknown — no index extract available/);
});

test('join down (indexCase null, no extracts, case route unreachable): the brief still composes, thinner and honest', () => {
  const b = composeBrief({ row: row({ indexCase: null, finding: null, omissionEvidence: null, preventableInjury: null, negligence: null, judgementRuleVersion: null }), indexExtract: null, readmitExtract: null, detailFetched: false });
  assert.match(b.markdown, /Case detail could not be fetched — this brief is built from the card row alone\./);
  assert.match(b.markdown, /Preventable injury: Unknown \(rule unknown\)/);
  assert.match(b.markdown, /Negligence: Unknown — advisory/);
  assert.match(b.markdown, /- No omission recorded/);
  assert.match(b.markdown, /Stability at discharge: unknown · evidence track: unknown/);
  assert.doesNotMatch(b.markdown, /\bnull\b|undefined/);
});

test('not-yet-audited rows say so in the assessment and assert no candidate pattern', () => {
  const b = composeBrief({ row: row({ auditStatus: 'not_auditable', notAuditableReason: 'tier3: no index discharge-summary PDF', avoidable: null, finding: null }), indexExtract: null, readmitExtract: null });
  assert.match(b.markdown, /- Not yet audited — tier3: no index discharge-summary PDF/);
  assert.match(b.markdown, /Candidate pattern: None — not yet audited\./);
  const h = composeBrief({ row: row({ auditStatus: 'excluded', lane: 'excluded', avoidable: null, finding: null }), indexExtract: null, readmitExtract: null });
  assert.match(h.markdown, /- Not yet audited — held out by design/);
});

test('candidate pattern is one deterministic sentence from the judgements; never asserted without the situation', () => {
  assert.equal(candidatePattern(row(), indexExtract, 1),
    'Unplanned same-condition return after Cemented hemiarthroplasty with 1 documentation omission(s) — candidate for Even Adjudicated LVC review.');
  assert.equal(candidatePattern(row({ indexCase: null }), null, 2),
    'Unplanned same-condition return after the index stay with 2 documentation omission(s) — candidate for Even Adjudicated LVC review.');
  assert.equal(candidatePattern(row({ sameCondition: 'different' }), indexExtract, 1),
    'None asserted — planned: unplanned, condition: different, 1 documentation omission(s).');
});

test('filename rule: uhid + surname slug; no name → uhid; no uhid → dedup key', () => {
  assert.equal(briefFilename({ uhid: 'UH-77812', patientName: 'Asha Khan', dedupKey: 'a|b' }), 'uh-77812-khan-readmission-brief.md');
  assert.equal(briefFilename({ uhid: 'UH-77812', patientName: null, dedupKey: 'a|b' }), 'uh-77812-readmission-brief.md');
  assert.equal(briefFilename({ uhid: null, patientName: 'Asha Khan', dedupKey: 'IP-1|form:F-9' }), 'ip-1-form-f-9-readmission-brief.md');
  assert.equal(briefFilename({ uhid: 'UH-1', patientName: '  Mohd. Al-Rashid  ', dedupKey: 'x' }), 'uh-1-al-rashid-readmission-brief.md');
});

test('withholdNumbers is PHONE-shaped (Addendum A1) — the five mandatory boundary cases', () => {
  // withheld: a bare 10-digit mobile, and a country-prefixed one with a hyphen
  assert.equal(withholdNumbers('call 98765 43210'), 'call [number withheld]');
  assert.equal(withholdNumbers('call +91 98765-43210'), 'call [number withheld]');
  // survives: two adjacent dashed dates (a date shape inside the run)
  assert.equal(withholdNumbers('01-06-2026 05-06-2026'), '01-06-2026 05-06-2026');
  // survives: a two-line numeric block (spans a newline)
  assert.equal(withholdNumbers('98765\n43210'), '98765\n43210');
  assert.equal(withholdNumbers('BP 120 80 HR 98\n37 2 96 18 14'), 'BP 120 80 HR 98\n37 2 96 18 14');
  // survives: labs — never ten digits in one run
  assert.equal(withholdNumbers('Hb 10.2, TLC 11 400'), 'Hb 10.2, TLC 11 400');
});

test('withholdNumbers — the shape rule at its edges', () => {
  assert.equal(withholdNumbers('9876543210'), '[number withheld]');                 // 10
  assert.equal(withholdNumbers('09876543210'), '[number withheld]');                // 11, leading 0
  assert.equal(withholdNumbers('919876543210'), '[number withheld]');               // 12, leading 91
  assert.equal(withholdNumbers('19876543210'), '19876543210');                      // 11, not leading 0
  assert.equal(withholdNumbers('929876543210'), '929876543210');                    // 12, not leading 91
  assert.equal(withholdNumbers('98765432101234'), '98765432101234');                // 14 — too long, not a phone
  assert.equal(withholdNumbers('2026-06-01 987654'), '2026-06-01 987654');          // 10 digits but a date shape
  assert.equal(withholdNumbers('Hb 10.2, CRP 48, K 2.9 on 2026-06-01'), 'Hb 10.2, CRP 48, K 2.9 on 2026-06-01');
  assert.equal(withholdNumbers('IP-2026-0342'), 'IP-2026-0342');
  assert.equal(withholdNumbers('call 9876543210 or +91 98765 43210'), 'call [number withheld] or [number withheld]');
});

test('toExtractSubset tolerates a partial / odd extract', () => {
  assert.equal(toExtractSubset(null), null);
  const x = toExtractSubset({ diagnosis: 'D', investigations: 'not-an-array', patient: { age: 'x' } } as never);
  assert.deepEqual(x, {
    diagnosis: 'D', indication: null, procedure: null, investigations: [], treatments: [], medications: [],
    courseSummary: null, disposition: null, followUp: null, riskFactors: [], patient: { age: null, sex: null },
  });
});
