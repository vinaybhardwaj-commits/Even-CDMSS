/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-brief.test.ts
 * The R1 case brief composer (CDMSS-READMISSIONS-R1-PRD v1.1 §7) — a GOLDEN FILE pins the
 * structure verbatim, including the two fixed bill sentences. Regenerate deliberately with
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
    stabilityAssessment: 'contradicted', corroborationTrack: 'lab_corroborated',
    refusalRecord: [{ lookedFor: 'an intra-op note or OT record', found: false, note: 'no OT artefact is read in R1' }],
  },
  omissionEvidence: null,
  preventableInjury: 'suspected', negligence: 'unknown', judgementRuleVersion: 'readmit-judgement/1',
  indexCase: { diagnosis: 'Fracture neck of femur (L)', indication: null, procedure: 'Cemented hemiarthroplasty', age: 58, sex: 'F' },
  ...over,
});

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

test('golden — the Even→Even brief structure is verbatim §7 (Part 1 · Part 2, source tags, fixed sentences)', () => {
  const b = composeBrief({ row: row(), indexExtract, readmitExtract, detailFetched: true });
  if (process.env.UPDATE_BRIEF_GOLDEN === '1') writeFileSync(GOLDEN, b.markdown);
  const golden = readFileSync(GOLDEN, 'utf8');
  assert.equal(b.markdown, golden);
  assert.equal(b.filename, 'uh-77812-khan-readmission-brief.md');
  // The two fixed sentences and the advisory line are present verbatim.
  assert.match(b.markdown, /Return stay bill not yet measured — no figure is available for this return\./);
  assert.match(b.markdown, /advisory — not a court or council finding/);
  assert.match(b.markdown, /## Part 1 — Intern presentation/);
  assert.match(b.markdown, /## Part 2 — Actuarial \/ low-value-care/);
  for (const h of ['### Why this case', '### Index stay', '### Interval', '### Return', '### Artefacts', '### Assessment', '### Looked for and not found']) {
    assert.ok(b.markdown.includes(h), h);
  }
  // Mobiles never — the CM note's number is withheld; the rest of the note survives.
  assert.doesNotMatch(b.markdown, /98765 43210/);
  assert.match(b.markdown, /\[number withheld\]/);
  // No rupee, no invented figure.
  assert.doesNotMatch(b.markdown, /₹|Rs\.? ?\d/);
  // Every extracted line is source-tagged.
  for (const l of b.markdown.split('\n').filter((x) => /^- (Diagnosis|Indication|Procedure|Course|Investigations|Treatments|Medications)/.test(x))) {
    assert.match(l, /\[(index|readmit) DS, extracted\]$/, l);
  }
});

test('OON brief: the other-hospital bill sentence, the POST_IPD form line, no readmit extract lines', () => {
  const b = composeBrief({
    row: row({
      dedupKey: 'IP-2026-0101|form:F-9', findingClass: 'out_of_network', lane: 'out_of_network',
      readmitDepartment: null, readmitDoctor: null, payerReadmit: null, avoidable: null, indexCase: null,
      // An OON finding carries no readmit document (§5a) — its provenance says so.
      finding: { ...row().finding, avoidable: null, labSourceProvenance: { indexCase: 'store', readmitCase: null, structuredLabCount: 6, indexDocumentId: 'DOC-1', readmitDocumentId: null } },
    }),
    indexExtract: null, readmitExtract: null, detailFetched: true,
  });
  assert.match(b.markdown, new RegExp(BILL_SENTENCE_OON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(b.markdown, new RegExp(BILL_SENTENCE_EVEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(b.markdown, /- Department: out of network — no second IP stay at Even/);
  assert.match(b.markdown, /- POST_IPD form held: Patient called on day 3/);
  assert.match(b.markdown, /\| Readmit DS \| n\/a \|/);
  assert.match(b.markdown, /\| Bill \| n\/a \|/);
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
