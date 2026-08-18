/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-r1-card.test.ts
 * R1 case-card logic (CDMSS-READMISSIONS-R1-PRD v1.1 §3): flat-list sort, the toggle
 * predicate, KX-first identity, the situation line, the eight coverage chips (incl.
 * POST_IPD on a LEAD pair with a held form), the justification mapping, the path line.
 * The badge predicate itself (isReviewFinding) is asserted BYTE-IDENTICAL by source read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ageSexForCard, cardIdentityLine, countsLine, coverageChips, isHeldOut, isReviewFinding,
  judgementLabel, justificationCell, justificationLabel, pathSegments, returnStayBill, situationLine, sortForCardList,
  NEGLIGENCE_ADVISORY, toFindingClass, type FindingClass, type SurfaceFinding,
} from '../readmission-surface-core.ts';

const f = (over: Partial<SurfaceFinding> = {}): SurfaceFinding => ({
  dedupKey: 'IP-1|IP-2', findingClass: 'even_even', lane: 'structural_30d', auditStatus: 'audited',
  patientName: null, uhid: 'UH-1', ageGender: null, gapDays: 5,
  indexDepartment: 'Orthopaedics', readmitDepartment: 'Orthopaedics', indexDoctor: null, readmitDoctor: null,
  indexDischargeAt: '2026-06-01T10:00:00+05:30', readmitAdmitAt: '2026-06-06T10:00:00+05:30',
  payerIndex: 'Even', payerReadmit: 'Even', cmNote: null,
  planned: 'unplanned', sameCondition: 'same', avoidable: 'justified',
  labTier: 'tier1', labTimingProfile: 'has_late_labs', nOmissions: 0,
  needsHumanReview: false, promotedToFull: false, notAuditableReason: null,
  finding: null, omissionEvidence: null,
  ...over,
});

// ── the badge predicate is untouched (hard rule) ─────────────────────────────────

test('the three copies of the badge predicate are byte-identical to the ratified text', () => {
  const store = readFileSync(join(process.cwd(), 'lib/readmission/store.ts'), 'utf8');
  const core = readFileSync(join(process.cwd(), 'lib/readmission-surface-core.ts'), 'utf8');
  assert.equal((store.match(/audit_status = 'audited'\s*\n?\s*AND avoidable IN \('avoidable','needs_adjudication'\)/g) ?? []).length, 2);
  assert.match(core, /return row\.auditStatus === 'audited' && \(row\.avoidable === 'avoidable' \|\| row\.avoidable === 'needs_adjudication'\);/);
  assert.equal(isReviewFinding(f({ avoidable: 'avoidable' })), true);
  assert.equal(isReviewFinding(f({ avoidable: 'justified' })), false);
});

// ── sort + toggle + counts ───────────────────────────────────────────────────────

test('flat list: review rows first, then other audited, then the rest — newest readmit first within each', () => {
  const rows = [
    f({ dedupKey: 'held-out', lane: 'excluded', auditStatus: 'excluded', avoidable: null, readmitAdmitAt: '2026-07-30T00:00:00+05:30' }),
    f({ dedupKey: 'audited-old', avoidable: 'justified', readmitAdmitAt: '2026-01-01T00:00:00+05:30' }),
    f({ dedupKey: 'review-old', avoidable: 'avoidable', readmitAdmitAt: '2026-01-02T00:00:00+05:30' }),
    f({ dedupKey: 'audited-new', avoidable: 'justified', readmitAdmitAt: '2026-07-01T00:00:00+05:30' }),
    f({ dedupKey: 'review-new', avoidable: 'needs_adjudication', readmitAdmitAt: '2026-07-20T00:00:00+05:30' }),
    f({ dedupKey: 'not-auditable', auditStatus: 'not_auditable', avoidable: null, readmitAdmitAt: '2026-07-31T00:00:00+05:30' }),
  ];
  assert.deepEqual(sortForCardList(rows).map((r) => r.dedupKey),
    ['review-new', 'review-old', 'audited-new', 'audited-old', 'not-auditable', 'held-out']);
  // Stable: an undated row does not jump.
  const undated = [f({ dedupKey: 'a', readmitAdmitAt: null }), f({ dedupKey: 'b', readmitAdmitAt: null })];
  assert.deepEqual(sortForCardList(undated).map((r) => r.dedupKey), ['a', 'b']);
});

test('the toggle hides exactly the excluded lane and the not-auditable rows', () => {
  assert.equal(isHeldOut(f({ lane: 'excluded', auditStatus: 'excluded' })), true);
  assert.equal(isHeldOut(f({ auditStatus: 'not_auditable' })), true);
  assert.equal(isHeldOut(f()), false);
  assert.equal(isHeldOut(f({ lane: 'out_of_network', findingClass: 'out_of_network' })), false);
  assert.equal(countsLine(3, 7), '3 to review · 7 pending audit');
});

// ── identity (decision 13) ───────────────────────────────────────────────────────

test('identity is KX-first: the extract fills age/sex ONLY when KX has none; name unresolved → UHID alone', () => {
  const ext = { diagnosis: null, indication: null, procedure: null, age: 61, sex: 'female' };
  assert.equal(cardIdentityLine(f({ patientName: 'Asha Khan', ageGender: '58F', indexCase: ext })), 'Asha Khan · UH-1 · 58F');
  assert.equal(cardIdentityLine(f({ patientName: 'Asha Khan', ageGender: null, indexCase: ext })), 'Asha Khan · UH-1 · 61/F');
  assert.equal(ageSexForCard(f({ ageGender: null, indexCase: { ...ext, age: null } })), 'F');
  assert.equal(ageSexForCard(f({ ageGender: null, indexCase: null })), null);
  assert.equal(cardIdentityLine(f({ patientName: null, ageGender: null, indexCase: null })), 'UH-1');
  assert.equal(cardIdentityLine(f({ patientName: null, uhid: null })), 'Unidentified patient');
});

// ── situation line (decision 15) ─────────────────────────────────────────────────

test('situation line only when unplanned AND same-condition; reads the blob when the scalars are absent', () => {
  assert.equal(situationLine(f()), 'Situation · Unplanned return');
  assert.equal(situationLine(f({ sameCondition: 'different' })), null);
  assert.equal(situationLine(f({ sameCondition: 'unknown' })), null);
  assert.equal(situationLine(f({ planned: 'planned' })), null);
  assert.equal(situationLine(f({ planned: null, sameCondition: null, finding: { planned: { verdict: 'unplanned' }, sameCondition: { verdict: 'same' } } })), 'Situation · Unplanned return');
  assert.equal(situationLine(f({ planned: null, sameCondition: null, finding: null })), null);
});

// ── coverage chips (§3 zone 3) ───────────────────────────────────────────────────

const states = (row: SurfaceFinding) => Object.fromEntries(coverageChips(row).map((c) => [c.key, c.state]));

// REWRITTEN for R2 (READMISSIONS-R2 PRD v1.0 §3.9): OT / PAC / Progress are no longer
// pinned to `unknown` — they read the five-state templateCoverage; a row with NO coverage
// (never looked: R1-era or tier-3) still reads `unknown`.
// REWRITTEN for R3 (READMISSIONS-R3 PRD v1.0, R3-7 — constraint 22 fulfilled): Bill reads the
// route's `returnBill` value object — present when billed, absent (`Bill pending`) when looked
// and no rows, unknown on a fault or when no object was carried; template work never moves it.
test('eight chips in order; OT / PAC / Progress read templateCoverage (five states) and are unknown when never looked; Bill reads returnBill and is unknown without one', () => {
  const chips = coverageChips(f());
  assert.deepEqual(chips.map((c) => c.label), ['Index DS', 'Readmit DS', 'Labs', 'OT', 'PAC', 'Progress', 'POST_IPD', 'Bill']);
  const never = states(f());
  assert.equal(never.ot, 'unknown'); assert.equal(never.pac, 'unknown'); assert.equal(never.progress, 'unknown'); assert.equal(never.bill, 'unknown');
  const looked = states(f({ finding: { templateCoverage: { ot: { status: 'present', count: 1 }, pac: { status: 'absent', count: 0 }, progress: { status: 'empty', count: 3 } } } }));
  assert.equal(looked.ot, 'present'); assert.equal(looked.pac, 'absent'); assert.equal(looked.progress, 'empty'); assert.equal(looked.bill, 'unknown');   // template coverage never moves Bill
  assert.equal(states(f({ returnBill: { state: 'billed', netRs: 51968, lines: 40 } })).bill, 'present');
  assert.equal(states(f({ returnBill: { state: 'not_finalised', netRs: null, lines: null } })).bill, 'absent');
  assert.equal(states(f({ returnBill: { state: 'unknown', netRs: null, lines: null } })).bill, 'unknown');
  const faulted = states(f({ finding: { templateCoverage: { ot: { status: 'fetch_failed', count: 0 }, pac: { status: 'fetch_failed', count: 0 }, progress: { status: 'fetch_failed', count: 0 } } } }));
  assert.equal(faulted.ot, 'unknown'); assert.equal(faulted.pac, 'unknown'); assert.equal(faulted.progress, 'unknown');   // a fault is never absent
});

test('POST_IPD is a fact about holding a form: present on a LEAD pair with cmNote, present on OON with a note, unknown on OON without', () => {
  assert.equal(states(f({ cmNote: 'Patient called — fever day 3, went to City Hospital' })).post_ipd, 'present');   // LEAD pair, form attached (detect-core:355)
  assert.equal(states(f({ cmNote: null })).post_ipd, 'unknown');
  assert.equal(states(f({ cmNote: '   ' })).post_ipd, 'unknown');
  const oon = f({ findingClass: 'out_of_network', lane: 'out_of_network', readmitDepartment: null, avoidable: null });
  assert.equal(states({ ...oon, cmNote: 'reported readmission' }).post_ipd, 'present');
  assert.equal(states({ ...oon, cmNote: null }).post_ipd, 'unknown');
});

test('Index DS / Readmit DS / Labs read the provenance; OON makes Readmit DS and Bill n/a; a join-down row is unknown, never a crash', () => {
  const prov = { labSourceProvenance: { indexCase: 'store', readmitCase: 'fresh_extract', structuredLabCount: 4, indexDocumentId: 'D1', readmitDocumentId: 'D2' } };
  const s1 = states(f({ finding: prov }));
  assert.equal(s1.index_ds, 'present'); assert.equal(s1.readmit_ds, 'present'); assert.equal(s1.labs, 'present'); assert.equal(s1.bill, 'unknown');   // provenance never moves Bill (R3: returnBill does)
  // Index DS present from the extract join even when the provenance says nothing.
  assert.equal(states(f({ finding: null, indexCase: { diagnosis: 'x', indication: null, procedure: null, age: null, sex: null } })).index_ds, 'present');
  const s2 = states(f({ finding: { labSourceProvenance: { indexCase: null, readmitCase: null, structuredLabCount: 0 } }, indexCase: null }));
  assert.equal(s2.index_ds, 'unknown'); assert.equal(s2.readmit_ds, 'unknown'); assert.equal(s2.labs, 'unknown');
  const oon = states(f({ findingClass: 'out_of_network', finding: null, indexCase: null }));
  assert.equal(oon.readmit_ds, 'n/a'); assert.equal(oon.bill, 'n/a'); assert.equal(oon.index_ds, 'unknown');
  // R3: OON stays n/a even when a value object is carried
  assert.equal(states(f({ findingClass: 'out_of_network', returnBill: { state: 'billed', netRs: 1, lines: 1 } })).bill, 'n/a');
  // Provenance of an odd shape narrows to unknown.
  assert.equal(states(f({ finding: { labSourceProvenance: { structuredLabCount: 'four' as unknown as number } } })).labs, 'unknown');
});

// ── judgements + bill (§3 zone 4, §4 mapping) ────────────────────────────────────

test('medical justification is the verbatim §4 display mapping; null on an audited row → Needs adjudication', () => {
  assert.equal(justificationLabel({ avoidable: 'justified' }), 'Justified');
  assert.equal(justificationLabel({ avoidable: 'needs_adjudication' }), 'Needs adjudication');
  assert.equal(justificationLabel({ avoidable: 'avoidable' }), 'Not justified');
  assert.equal(justificationLabel({ avoidable: null }), 'Needs adjudication');
  // Addendum A2: the CARD cell on an OON row says "Index side only" — never a verdict on the
  // other hospital's stay. Even–Even rows keep the §4 mapping (null → Needs adjudication).
  assert.equal(justificationCell({ avoidable: null, findingClass: 'out_of_network' }), 'Index side only');
  assert.equal(justificationCell({ avoidable: 'justified', findingClass: 'out_of_network' }), 'Index side only');
  assert.equal(justificationCell({ avoidable: null, findingClass: 'even_even' }), 'Needs adjudication');
  assert.equal(justificationCell({ avoidable: 'avoidable', findingClass: 'even_even' }), 'Not justified');
  assert.equal(judgementLabel('suspected'), 'Suspected');
  assert.equal(judgementLabel('not_suggested'), 'Not suggested');
  assert.equal(judgementLabel(null), 'Unknown');
  assert.equal(judgementLabel('anything-else'), 'Unknown');
  // R3 (R3-6): the cell reads the returnBill value object — no object / unknown → the R1
  // unknown; not_finalised → `bill not finalised`; billed → the computed figure; OON → n/a always.
  assert.equal(returnStayBill({ findingClass: 'even_even' }), 'unknown — not yet measured');
  assert.equal(returnStayBill({ findingClass: 'even_even', returnBill: { state: 'unknown', netRs: null, lines: null } }), 'unknown — not yet measured');
  assert.equal(returnStayBill({ findingClass: 'even_even', returnBill: { state: 'not_finalised', netRs: null, lines: null } }), 'bill not finalised');
  assert.equal(returnStayBill({ findingClass: 'even_even', returnBill: { state: 'billed', netRs: 51968, lines: 40 } }), '₹51,968');
  assert.equal(returnStayBill({ findingClass: 'out_of_network' }), 'n/a');
  assert.equal(returnStayBill({ findingClass: 'out_of_network', returnBill: { state: 'billed', netRs: 51968, lines: 40 } }), 'n/a');
  assert.equal(NEGLIGENCE_ADVISORY, 'advisory — not a court or council finding');
});

// ── path line (§3 zone 2) ────────────────────────────────────────────────────────

test('path segments drop nulls, render OON as out of network, and never assume a second admission', () => {
  const ext = { diagnosis: 'Fracture neck of femur', indication: null, procedure: 'Hemiarthroplasty', age: null, sex: null };
  assert.deepEqual(pathSegments(f({ indexCase: ext })),
    ['Orthopaedics → Orthopaedics', 'discharged 1 Jun → readmitted 6 Jun', 'gap 5.0 d', 'Even', 'Fracture neck of femur', 'Hemiarthroplasty']);
  assert.deepEqual(pathSegments(f({ payerIndex: 'Even', payerReadmit: 'Insurer X' }))[3], 'Even / Insurer X');
  assert.deepEqual(pathSegments(f({ findingClass: 'out_of_network', readmitDepartment: null, payerReadmit: null }))[0], 'Orthopaedics → out of network');
  assert.equal(pathSegments(f({ findingClass: 'out_of_network', readmitDepartment: null }))[1], 'discharged 1 Jun → readmitted elsewhere ~6 Jun');
  assert.equal(pathSegments(f({ readmitDepartment: null, readmitAdmitAt: null, gapDays: null }))[0], 'Orthopaedics → no second IP stay');
  assert.equal(pathSegments(f({ readmitDepartment: null }))[0], 'Orthopaedics → unknown');
  assert.equal(pathSegments(f({ indexDepartment: null }))[0], 'unknown → Orthopaedics');
  const bare = pathSegments(f({ indexDischargeAt: null, readmitAdmitAt: null, gapDays: null, payerIndex: null, payerReadmit: null, indexCase: null }));
  assert.deepEqual(bare, ['Orthopaedics → Orthopaedics']);
  assert.equal(bare.some((s) => /null|undefined/.test(s)), false);
});

// ── R2 Addendum A3: FindingClass is the closed union, narrowed once at the row boundary ──
test('A3: toFindingClass passes the three known classes and falls back to even_even (hides nothing) for anything else', () => {
  const known: FindingClass[] = ['even_even', 'out_of_network', 'delayed_ssi'];
  for (const k of known) assert.equal(toFindingClass(k), k);
  assert.equal(toFindingClass('delayed-ssi'), 'even_even');
  assert.equal(toFindingClass(''), 'even_even');
  assert.equal(toFindingClass(null), 'even_even');
  assert.equal(toFindingClass(undefined), 'even_even');
  assert.equal(toFindingClass(42), 'even_even');
});
