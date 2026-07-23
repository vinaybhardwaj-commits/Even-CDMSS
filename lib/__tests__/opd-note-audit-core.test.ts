/**
 *   node --experimental-strip-types --test lib/__tests__/opd-note-audit-core.test.ts
 * Pure cores: row→case ingest (opd-ingest-core) + completeness/prescribing/parse (opd-note-audit-core).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowToOpdCase, opdCaseText, isTeleconsultEncounter, hasHandsOnExam } from '../opd-ingest-core.ts';
import { computeOpdScore } from '../opd-note-score-core.ts';
import { opdCompleteness, prescribingChecks, parseOpdAnalysis, medDoseDocumented, resolveMedRoute, opdSignalType, stampFindingIdentity, followUpDocumented, consolidateDecisions, neutralizeMetadataFindings, medHasMoleculeFrom, bpDocumented, obstetricDosingComplete, NSAID_MOLECULES, MUSCLE_RELAXANT_MOLECULES, OPD_SIGNAL_TYPES, OPD_AUDIT_SYSTEM, type OpdFinding } from '../opd-note-audit-core.ts';
import type { DeidOpdCase } from '../opd-ingest-core.ts';

// Mirrors a real GP row (medications + jsonb arrive as JSON strings via Metabase).
const ROW: Record<string, unknown> = {
  uid: 'MqG3ihcPeU4ptLWCBiY6', consult_uid: 'tg3doq', doctor_uid: 'HalPy', kx_encounter_id: null,
  type_of_prescription: 'GENERAL_PRACTITIONER', consult_type: null, timestamp: '2026-06-29T05:00:00+05:30',
  presenting_complaints: '[]',
  diagnosis_icd_codes: ['R10.12', 'E78.2', 'E55'],
  impression_icd_codes: [],
  medications: '[{"generic_name":"Dicyclomine+Mefenamic Acid","brand_name":"Mef Spas","strength":"10mg+250mg","dosage":"1 tab","frequency":"1-1-1","duration":"3 days","route_of_administration":"oral","instruction_to_patient":"after meal"},{"generic_name":"Fenofibrate+Rosuvastatin","brand_name":"Rosuvas F","strength":"160mg+20mg","dosage":"1 tablet","frequency":"0-0-1","duration":"3 months","route_of_administration":""}]',
  further_investigation: '[{"investigation":{"name":"USG ABDOMEN"}}]',
  general_advice: '{}',
  patient_details__allergies: null,
  followup__followup_type: 'FOLLOW_UP_WITH_REPORTS', next_follow_up_date: null,
  relevant_medical_history: '[]', comorbidities: '[]',
};

test('rowToOpdCase parses stringified JSONB + separates de-identified case from keys', () => {
  const { case: c, keys } = rowToOpdCase(ROW);
  assert.equal(c.medications.length, 2);
  assert.equal(c.medications[0].generic, 'Dicyclomine+Mefenamic Acid');
  assert.deepEqual(c.diagnosisCodes, ['R10.12', 'E78.2', 'E55']);
  assert.deepEqual(c.investigations, ['USG ABDOMEN']);
  assert.equal(c.presentingComplaints.length, 0); // no nested + empty top-level
  assert.equal(c.followUpType, 'FOLLOW_UP_WITH_REPORTS');
  assert.equal(c.followUpDateSet, false);
  assert.equal(keys.uid, 'MqG3ihcPeU4ptLWCBiY6');
  assert.equal(keys.doctorUid, 'HalPy');
});

// The extraction fix: medical-consult content lives in the nested GP fields, not top-level.
const GP_ROW: Record<string, unknown> = {
  uid: 'abc123def', doctor_uid: 'doc1', type_of_prescription: 'GENERAL_PRACTITIONER', timestamp: '2026-06-29T05:00:00+05:30',
  presenting_complaints: '[]', relevant_medical_history: '[]', general_advice: '{}',
  general_practitioner_prescription__presenting_complaints: '[{"symptoms":"<ul><li>cough since 3 days</li><li>mild fever</li></ul>","diagnoses":[{"icd_code":"J06.9","diagnosis_or_impression":"Acute URTI","general_advice":"steam inhalation","treatment_plan":""}]}]',
  general_practitioner_prescription__plan_of_management: '[{"management_plan":"<p>rest and oral fluids</p>"}]',
  general_practitioner_prescription__examination: '<p>throat congested</p>',
  diagnosis_icd_codes: ['J06.9'], impression_icd_codes: [],
  medications: '[{"generic_name":"Paracetamol","dosage":"650mg","frequency":"1-1-1","duration":"3d","route_of_administration":"oral"}]',
  further_investigation: '[]', followup__followup_type: 'FOLLOW_UP_AS_NEEDED',
  prescription_url: 'https://storage.googleapis.com/even-prod-prescription/abc_2.pdf',
};

test('rowToOpdCase reads the NESTED GP fields (the extraction fix)', () => {
  const { case: c, keys } = rowToOpdCase(GP_ROW);
  assert.ok(c.presentingComplaints.includes('cough since 3 days'));
  assert.ok(c.presentingComplaints.includes('mild fever'));
  assert.deepEqual(c.impressions, ['Acute URTI']);
  assert.ok(c.advice.some((a) => /rest and oral fluids/.test(a)));
  // 0.6: per-diagnosis general_advice is auto-templated patient education → NOT clinician advice
  assert.ok(!c.advice.some((a) => /steam inhalation/.test(a)));
  assert.ok((c.patientEducation || []).some((a) => /steam inhalation/.test(a)));
  assert.ok(c.examination.includes('throat congested'));
  assert.equal(keys.prescriptionUrl, 'https://storage.googleapis.com/even-prod-prescription/abc_2.pdf');
  const comp = opdCompleteness(c);
  assert.ok(!comp.missing.includes('Presenting complaint'));
  assert.ok(!comp.missing.includes('Advice / plan'));
  assert.ok(!comp.missing.includes('Diagnosis / impression'));
});

// The hybrid source: clean content comes from the dpipe pipeline columns (dpipe_pc text,
// dpipe_dx names+codes, dpipe_pom plan), taking precedence over the source nested fields.
const DPIPE_ROW: Record<string, unknown> = {
  uid: 'pq9rs7tuv', doctor_uid: 'doc9', type_of_prescription: 'GENERAL_PRACTITIONER', timestamp: '2026-06-27T05:00:00+05:30',
  // nested source fields present but DELIBERATELY different — dpipe must win
  general_practitioner_prescription__presenting_complaints: '[{"symptoms":"<ul><li>old nested complaint</li></ul>","diagnoses":[{"diagnosis_or_impression":"Nested DX"}]}]',
  diagnosis_icd_codes: ['J06.9'],
  medications: '[{"generic_name":"Paracetamol","dosage":"650mg","frequency":"1-1-1","duration":"3d","route_of_administration":"oral"}]',
  followup__followup_type: 'FOLLOW_UP_WITH_REPORTS', prescription_url: 'https://x/y.pdf',
  dpipe_pc: 'Chief Complaints: fever and cough since 3 days. HOPI: gradual onset, no breathlessness.',
  dpipe_dx: '[{"icd_code":"J06.9","diagnosis":"Acute upper respiratory tract infection (URTI)"}]',
  dpipe_pom: '[{"management_plan":"symptomatic care; review if persists"}]',
  dpipe_inv: '[{"name":"CBC"}]',
};

test('rowToOpdCase prefers the dpipe pipeline content over the nested source fields', () => {
  const { case: c } = rowToOpdCase(DPIPE_ROW);
  assert.ok(c.presentingComplaints.join(' ').includes('fever and cough since 3 days'));
  assert.ok(!c.presentingComplaints.join(' ').includes('old nested complaint')); // dpipe wins
  assert.ok(c.impressions.includes('Acute upper respiratory tract infection (URTI)'));
  assert.deepEqual(c.diagnosisCodes, ['J06.9']);
  assert.ok(c.advice.some((a) => /symptomatic care/.test(a)));
  assert.ok(c.investigations.includes('CBC'));
  const comp = opdCompleteness(c);
  assert.ok(!comp.missing.includes('Presenting complaint'));
  assert.ok(!comp.missing.includes('Advice / plan'));
});

// 0.6 — the false Band-A: a teleconsult ORTHO REFERRAL note whose only plan was "Medical management"
// but which carried an auto-attached NHS back-pain leaflet (exercises + YouTube). The engine must
// (a) see the referral + teleconsult, (b) keep the leaflet OUT of clinician advice, (c) not expect a
// physical exam on a teleconsult.
const REFERRAL_ROW: Record<string, unknown> = {
  uid: 'PNvdYxbYo7NMgKUY7hwN', doctor_uid: 'docS', type_of_prescription: 'GENERAL_PRACTITIONER', consult_type: null,
  timestamp: '2026-07-02T09:00:00+05:30',
  general_practitioner_prescription__presenting_complaints: '[{"symptoms":"<p>Complaints of pain lower back on and off for 6 days</p>","diagnoses":[{"icd_code":"M54.40","diagnosis_or_impression":"Lumbago (lower back pain)","general_advice":"<b>DO</b><ul><li>Stay as active as possible</li><li>Do regular back exercises</li><li>Basic: <a href=\\"\\">https://www.youtube.com/watch?v=VDf43fOTH1E</a></li></ul>","treatment_plan":""}]}]',
  general_practitioner_prescription__plan_of_management: '[{"management_plan":"<p>Medical management</p>"}]',
  general_practitioner_prescription__examination: '',
  diagnosis_icd_codes: ['M54.40'], impression_icd_codes: [], medications: '[]', further_investigation: '[]',
  refer_to: '[{"specialist_type":{"name":"Orthopedics","is_in_house":false,"in_house_doctor_type":"ORTHOPAEDICIAN"},"recommended_by_even":true}]',
  num_referrals: 1,
  followup__followup_type: 'FOLLOW_UP_WITH_REFERRAL_PRESCRIPTION', next_follow_up_date: '2026-07-09',
  prescription_url: 'https://x/y.pdf',
};

test('0.6: referral handoff — leaflet excluded, referral + teleconsult surfaced', () => {
  const { case: c } = rowToOpdCase(REFERRAL_ROW);
  // clinician plan is ONLY "Medical management" — the templated leaflet is patient-education, not advice
  assert.deepEqual(c.advice, ['Medical management']);
  assert.ok(!c.advice.join(' ').toLowerCase().includes('youtube'));
  assert.ok((c.patientEducation || []).join(' ').toLowerCase().includes('youtube'));
  // referral + teleconsult context captured
  assert.equal(c.isTeleconsult, true);
  assert.equal(c.isReferralHandoff, true);
  assert.equal(c.numReferrals, 1);
  assert.ok((c.referrals || []).some((r) => /In-Person Orthopedics \(Even-recommended\)/.test(r)));
  // the LLM prompt text must carry the framing that prevents the false "avoidance = high value" praise
  const txt = opdCaseText(c);
  assert.match(txt, /TELECONSULT/);
  assert.match(txt, /REFERRAL \/ HANDOFF/);
  assert.match(txt, /Patient-education material attached/);
  assert.match(txt, /Clinician advice \/ plan: Medical management/);
});

test('0.6: teleconsult completeness — examination is not scored (N/A), referral counts as the plan', () => {
  const { case: c } = rowToOpdCase(REFERRAL_ROW);
  const comp = opdCompleteness(c);
  assert.ok(!comp.items.some((i) => i.key === 'examination'));      // teleconsult → exam N/A
  assert.equal(comp.items.find((i) => i.key === 'advice_given')!.present, true); // "Medical management" + referral = a plan
  // an IN-PERSON note WOULD be scored on examination
  const inperson = rowToOpdCase({ ...REFERRAL_ROW, consult_type: 'IN_PERSON', type_of_prescription: 'HOSPITAL_ORTHO' }).case;
  const compIP = opdCompleteness(inperson);
  assert.ok(compIP.items.some((i) => i.key === 'examination'));
  assert.equal(compIP.items.find((i) => i.key === 'examination')!.present, false); // no exam recorded → real gap in-person
});

test('opdCompleteness flags the real gaps; allergy + history items removed', () => {
  const { case: c } = rowToOpdCase(ROW);
  const comp = opdCompleteness(c);
  assert.ok(comp.coverage < 1);
  assert.ok(comp.missing.includes('Presenting complaint'));
  assert.ok(comp.missing.includes('Advice / plan'));
  assert.ok(!comp.missing.includes('Complete medication dosing')); // 0.5: 2nd med's blank route is inferred oral ("1 tablet") → complete, not a false gap
  assert.ok(!comp.missing.includes('Allergy status documented')); // removed — never stored
  assert.ok(!comp.missing.includes('Relevant history'));          // removed — folded into complaint
  assert.equal(comp.items.length, 5);
  assert.equal(comp.items.find((i) => i.key === 'diagnosis')!.present, true);
  assert.deepEqual(comp.patientCentred, { present: 1, total: 2 });
});

test('route inference: documented → used; blank → inferred from form; no form → null (real gap)', () => {
  assert.equal(resolveMedRoute({ generic: 'X', route: 'oral' }), 'oral');
  assert.equal(resolveMedRoute({ brand: 'Cefix 200mg Tab', route: '' }), 'oral');
  assert.equal(resolveMedRoute({ brand: 'Leupromak 3.75mg Inj', route: '' }), 'parenteral');
  assert.equal(resolveMedRoute({ brand: 'Soliwax Ear Drop', route: '' }), 'otic');
  assert.equal(resolveMedRoute({ brand: 'Augmentin', route: '' }), null); // no route, no inferable form → ambiguous
});

test('dose documented from the field, the strength field, or the strength embedded in the drug name', () => {
  assert.equal(medDoseDocumented({ brand: 'X', dose: '1 tab' }), true);
  assert.equal(medDoseDocumented({ brand: 'X', strength: '200mg' }), true);
  assert.equal(medDoseDocumented({ brand: 'Cefix 200mg Tab' }), true);   // strength lives in the name
  assert.equal(medDoseDocumented({ brand: 'Menogen Cap' }), false);      // amount documented nowhere
});

test('prescribingChecks: dosing gap only when route is truly ambiguous / amount is absent (0.5)', () => {
  // ROW's meds are complete once the blank route is inferred (2nd med "1 tablet" → oral) → no false gap
  const { case: c } = rowToOpdCase(ROW);
  assert.ok(!prescribingChecks(c).some((x) => x.subject.startsWith('Incomplete dosing')));
  // A med with no route field, no inferable form, and no dose/strength anywhere → a real gap
  const ambiguous = {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [], impressionCodes: [],
    impressions: [], history: [], comorbidities: [], investigations: [], advice: [], examination: [],
    allergies: null, followUpType: null, followUpDateSet: false,
    medications: [{ generic: 'Some Molecule', dose: '', strength: '', frequency: '', route: '', duration: '' }],
  };
  const inc = prescribingChecks(ambiguous).find((x) => x.subject.startsWith('Incomplete dosing'));
  assert.ok(inc && inc.domain === 'prescribing_safety');
  assert.match(inc!.rationale, /dose\/strength/);
  assert.match(inc!.rationale, /route/);
});

test('prescribingChecks: unverified brand, duplicate by RESOLVED generic, high-alert info (v0.4)', () => {
  const c = {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [], impressionCodes: [],
    impressions: [], history: [], comorbidities: [], investigations: [], advice: [], examination: [],
    allergies: null, followUpType: null, followUpDateSet: false,
    medications: [
      // brand-only, unresolved (no formulary match) → flagged as unverified
      { brand: 'Mystery Tonic', dose: '1', frequency: '1-0-1', route: 'PO', duration: '5d' },
      // brand-only but RESOLVED to Aspirin via the formulary…
      { brand: 'Ecosprin', resolvedGeneric: 'Aspirin', formularyMatch: 'brand-exact' as const, schedule: 'H', dose: '75mg', frequency: '0-1-0', route: 'PO', duration: '30d' },
      // …so it now dedupes against an aspirin written generically (the whole point of v0.4)
      { generic: 'aspirin', dose: '150mg', frequency: '0-1-0', route: 'PO', duration: '30d' },
      // high-alert drug → informational, non-penalising
      { brand: 'Lonopin', resolvedGeneric: 'Enoxaparin', formularyMatch: 'brand-exact' as const, highAlert: true, schedule: 'H1', dose: '40mg', frequency: '0-0-1', route: 'SC', duration: '5d' },
    ],
  };
  const f = prescribingChecks(c);
  assert.ok(f.some((x) => x.subject.startsWith('Unverified brand: Mystery Tonic')));
  assert.ok(f.some((x) => /^Duplicate prescription: aspirin$/i.test(x.subject)));   // resolved brand + generic deduped
  const ha = f.find((x) => x.subject.startsWith('High-alert'));
  assert.ok(ha && ha.informational === true && ha.confidence === 0);
  assert.ok(f.every((x) => x.source === 'deterministic'));
});

test('parseOpdAnalysis extracts findings + PDQI-9 + suggestions and clamps citations', () => {
  const json = `{"findings":[{"subject":"Antibiotic for viral URTI","verdict":"low-value","confidence":0.85,"domain":"prescribing_safety","rationale":"viral","evidence":["x"],"estimates":[],"citation_ids":[1,5]}],"pdqi9":{"thorough":2,"accurate":4,"bogus":9},"suggestions":[{"priority":2,"text":"add complaint"},{"priority":1,"text":"document plan"}]}`;
  const a = parseOpdAnalysis(json, 2);
  assert.ok(a);
  assert.equal(a!.findings.length, 1);
  assert.equal(a!.findings[0].domain, 'prescribing_safety');
  assert.deepEqual(a!.findings[0].citation_ids, [1]); // 5 dropped (only 2 sources)
  assert.equal(a!.pdqi9!.thorough, 2);
  assert.equal(a!.pdqi9!.accurate, 4);
  assert.equal((a!.pdqi9 as Record<string, number>).bogus, undefined);
  assert.equal(a!.suggestions[0].priority, 1); // sorted
});

test('C1: parseOpdAnalysis strips a reasoning <think> block (DeepSeek-R1) before parsing', () => {
  // R1 prepends a think block whose prose contains braces {like this}; the parser must
  // parse the JSON AFTER the final </think>, not the first brace inside the reasoning.
  const raw = '<think>Let me consider {the azithromycin} and weigh options { }...</think>\n```json\n{"findings":[{"subject":"Antibiotic for viral URI","verdict":"low-value","confidence":0.9,"domain":"appropriateness","rationale":"viral","evidence":[],"estimates":["viral URI"],"citation_ids":[]}],"pdqi9":{"thorough":3},"suggestions":[{"priority":1,"text":"avoid abx"}]}\n```';
  const a = parseOpdAnalysis(raw, 0);
  assert.ok(a, 'should parse despite the think block + code fence');
  assert.equal(a!.findings.length, 1);
  assert.equal(a!.findings[0].domain, 'appropriateness');
  assert.equal(a!.pdqi9!.thorough, 3);
  assert.equal(a!.suggestions[0].text, 'avoid abx');
});

// ── Finding identity (governance spec v2.0 §2) ─────────────────────────────────
const mkFinding = (subject: string, domain: 'appropriateness' | 'prescribing_safety' = 'prescribing_safety'): OpdFinding => ({
  subject, verdict: 'context-dependent', confidence: 0.5, domain,
  rationale: 'r', evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
});

test('opdSignalType maps every deterministic subject shape to the controlled vocab', () => {
  const cases: [string, string][] = [
    ['Interaction (major): Aceclofenac + Methotrexate', 'drug_interaction'],
    ['Incomplete dosing: Cefixime', 'incomplete_dosing'],
    ['Duplicate prescription: aspirin', 'duplicate_prescription'],
    ['Unverified brand: Mystery Tonic', 'unverified_brand'],
    ['LASA pair co-prescribed: hydroxyzine & hydralazine', 'lasa_pair'],
    ['Daily dose exceeds ceiling: paracetamol', 'dose_ceiling_exceeded'],
    ['Daily dose may exceed ceiling if all SOS taken: paracetamol', 'dose_ceiling_sos'],
    ['Same molecule in 3 products (within ceiling): paracetamol', 'duplicate_molecule'],
    ['High-alert medications: Enoxaparin, Insulin', 'high_alert_medication'],
    ['Schedule X drug: Alprazolam', 'schedule_x'],
    ['Off-formulary items: 2 not in formulary', 'off_formulary'],
  ];
  for (const [subject, expected] of cases) {
    assert.equal(opdSignalType(subject, 'prescribing_safety'), expected, subject);
    assert.ok(OPD_SIGNAL_TYPES[expected], `${expected} in vocab`);
  }
});

test('opdSignalType: LLM subjects — antibiotic rule, coarse domain×verdict buckets, general fallback', () => {
  assert.equal(opdSignalType('Antibiotic for likely-viral URTI', 'prescribing_safety'), 'antibiotic_stewardship');
  // free-text LLM findings batch into a COARSE domain×verdict bucket (the fragmentation fix) —
  // two different low-value appropriateness subjects land in the SAME bucket
  assert.equal(opdSignalType('Cefixime for acute pharyngitis', 'appropriateness', { verdict: 'low-value' }), 'appropriateness_low_value');
  assert.equal(opdSignalType('Unnecessary PPI co-prescription', 'appropriateness', { verdict: 'low-value' }), 'appropriateness_low_value');
  assert.equal(opdSignalType('Uncertain indication for MRI', 'appropriateness', { verdict: 'context-dependent' }), 'appropriateness_review');
  assert.equal(opdSignalType('Duplicate statin risk', 'prescribing_safety', { verdict: 'low-value' }), 'prescribing_low_value');
  assert.equal(opdSignalType('Appropriate step-down of therapy', 'prescribing_safety', { verdict: 'high-value' }), 'prescribing_high_value');
  // no verdict to class on → the domain's general bucket
  assert.equal(opdSignalType('—', 'appropriateness'), 'appropriateness_general');
  assert.equal(opdSignalType('::', 'prescribing_safety'), 'prescribing_general');
});

test('stampFindingIdentity: stable refs, severity-change stable, distinct details distinct', () => {
  const [a] = stampFindingIdentity([mkFinding('Interaction (moderate): Aceclofenac + Methotrexate')]);
  const [b] = stampFindingIdentity([mkFinding('Interaction (major): Aceclofenac + Methotrexate')]);
  const [c] = stampFindingIdentity([mkFinding('Interaction (major): Aspirin + Warfarin')]);
  assert.equal(a.signal_type, 'drug_interaction');
  assert.match(a.finding_ref!, /^[0-9a-f]{12}$/);
  assert.equal(a.finding_ref, b.finding_ref);        // severity in the prefix → same ref (stable across re-audit)
  assert.notEqual(a.finding_ref, c.finding_ref);      // different drug pair → distinct
  // deterministic: re-stamping reproduces the same refs regardless of array order
  const two = stampFindingIdentity([mkFinding('Incomplete dosing: Cefixime'), mkFinding('Incomplete dosing: Azithromycin')]);
  const twoRev = stampFindingIdentity([mkFinding('Incomplete dosing: Azithromycin'), mkFinding('Incomplete dosing: Cefixime')]);
  assert.equal(two[0].finding_ref, twoRev[1].finding_ref);
  assert.equal(two[1].finding_ref, twoRev[0].finding_ref);
});

// ── Form plumbing (0.81.11, Matcher-Scoping Audit Stage 1) — SCORE-INVARIANCE guard ──
// Populating form/dosageForm on a med must NOT change any deterministic finding: no matcher reads
// them in Stage 1. If a later fix starts consuming form and forgets its dry-run gate, this fails.
test('0.81.11: form/dosageForm are inert — prescribingChecks output is byte-identical with them present vs absent', () => {
  const meds = [
    { generic: 'Metformin', resolvedGeneric: 'Metformin', frequency: 'BD', dose: '500 mg', duration: '30 days' },
    { generic: 'Metformin', resolvedGeneric: 'Metformin', frequency: 'OD', dose: '500 mg', duration: '30 days' }, // duplicate
    { generic: 'Insulin', resolvedGeneric: 'Insulin', highAlert: true, frequency: 'OD', dose: '10 units', duration: '30 days' },
    { generic: 'Warfarin', resolvedGeneric: 'Warfarin', schedule: 'H1', frequency: 'OD', dose: '5 mg', lasa: ['Warfarin'], duration: '30 days' },
  ];
  const mkCase = (ms: unknown[]) => ({ medications: ms } as unknown as Parameters<typeof prescribingChecks>[0]);
  const withForm = mkCase(meds.map((m) => ({ ...m, form: 'Tablet 10 MG', dosageForm: 'tablet' })));
  const without = mkCase(meds.map((m) => ({ ...m })));
  assert.deepEqual(prescribingChecks(withForm), prescribingChecks(without));
});

// ── Matcher-Scoping Audit Stage 2 (0.81.12): lasa_pair DELETED + molecule-subset duplication ──
const mkMedCase = (ms: unknown[]) => ({ medications: ms } as unknown as Parameters<typeof prescribingChecks>[0]);

test('0.81.12 CANARY: guideline-recommended vaccine co-administration produces NO finding (LASA deleted)', () => {
  // The 4 vaccine-co-admin notes LASA used to penalise. Even with the (misnamed) lasa column populated,
  // no LASA finding fires, and two different vaccines are not a duplication. This must never regress.
  const fs = prescribingChecks(mkMedCase([
    { generic: 'Pneumococcal Polysaccharide Vaccine', resolvedGeneric: 'Pneumococcal Polysaccharide Vaccine', lasa: ['Influenza Vaccine'] },
    { generic: 'Influenza Vaccine', resolvedGeneric: 'Influenza Vaccine', lasa: ['Pneumococcal Polysaccharide Vaccine'] },
  ]));
  assert.equal(fs.filter((f) => /^LASA pair/.test(f.subject)).length, 0, 'LASA check is deleted — no name-confusion finding');
  assert.equal(fs.filter((f) => /^Duplicate prescription/.test(f.subject)).length, 0, 'two different vaccines are not a duplication');
});

test('0.81.12 (Stage 2a): the SCORING molecule-subset dedup is NOT present — a mono+FDC produces no new penalty', () => {
  // The subset-dedup was rejected at dry run (fired 82×, paracetamol-dominated, collided with the
  // informational duplicate_molecule policy). A mono inside a co-prescribed FDC must NOT be flagged as a
  // scoring duplicate here — the within-ceiling duplication stays the dose-aggregation informational
  // roll-up. A dose-gated replacement is Stage 2b (separate dry run).
  const fs = prescribingChecks(mkMedCase([
    { generic: 'Metformin', resolvedGeneric: 'Metformin' },
    { generic: 'Glimepiride+Metformin', resolvedGeneric: 'Glimepiride+Metformin' },
  ]));
  assert.equal(fs.filter((f) => /^Duplicate prescription/.test(f.subject)).length, 0, 'no scoring subset-dup in Stage 2a');
  // exact same generic twice still fires the original (unchanged) path
  const exact = prescribingChecks(mkMedCase([
    { generic: 'Amlodipine', resolvedGeneric: 'Amlodipine' }, { generic: 'Amlodipine', resolvedGeneric: 'Amlodipine' },
  ]));
  assert.ok(exact.find((f) => /^Duplicate prescription: Amlodipine/.test(f.subject)), 'exact-generic duplicate still fires');
});

// ── Signal-Type Collapse fix (0.81.10, PRD CDMSS-SIGNAL-TYPE-COLLAPSE §5.1 / S3) ──
test('0.81.10: a low-value deterministic finding RETAINS its specific signal_type (no collapse to low_value_care)', () => {
  const lv = (subject: string, domain: 'prescribing_safety' | 'appropriateness' = 'prescribing_safety', source: 'deterministic' | 'llm' = 'deterministic'): OpdFinding =>
    ({ subject, verdict: 'low-value', confidence: 0.8, domain, rationale: '', evidence: [], estimates: [], citation_ids: [], source });
  // the three re-homed clusters keep their own type (→ they inherit their 0.81.9 tier/citation)
  assert.equal(stampFindingIdentity([lv('Interaction (major): A + B')])[0].signal_type, 'drug_interaction');
  assert.equal(stampFindingIdentity([lv('Daily dose exceeds ceiling: Paracetamol')])[0].signal_type, 'dose_ceiling_exceeded');
  assert.equal(stampFindingIdentity([lv('Duplicate prescription: Pantoprazole')])[0].signal_type, 'duplicate_prescription');
  // a GENERIC free-text low-value finding still collapses to the unified LVC bucket (unchanged)
  assert.equal(stampFindingIdentity([lv('Unindicated multivitamin, no indication', 'appropriateness')])[0].signal_type, 'low_value_care');
  assert.equal(stampFindingIdentity([lv('Azithromycin for a viral URTI', 'appropriateness', 'llm')])[0].signal_type, 'low_value_care');
});

test('0.81.10: the muscle-relaxant documentation subject maps to signal_type muscle_relaxant_indication', () => {
  assert.equal(opdSignalType('Muscle relaxant prescribed — document the indication', 'appropriateness', { verdict: 'context-dependent' }), 'muscle_relaxant_indication');
  assert.equal(OPD_SIGNAL_TYPES.muscle_relaxant_indication, 'Muscle relaxant — document the indication');
});

test('stampFindingIdentity: within-note collision suffixes #2, #3 deterministically', () => {
  const three = stampFindingIdentity([
    mkFinding('Incomplete dosing: Cefixime'),
    mkFinding('Incomplete dosing:   cefixime'),   // normalizes identical → collision
    mkFinding('Incomplete dosing: CEFIXIME'),
  ]);
  const refs = three.map((f) => f.finding_ref!);
  assert.equal(new Set(refs).size, 3);              // all unique within the note
  assert.equal(refs[1], `${refs[0]}#2`);
  assert.equal(refs[2], `${refs[0]}#3`);
  assert.ok(three.every((f) => f.signal_type === 'incomplete_dosing'));
});

test('stampFindingIdentity: every finding stamped non-empty (acceptance, spec §2)', () => {
  const batch = stampFindingIdentity([
    mkFinding('Interaction (major): A + B'),
    mkFinding('Some novel LLM observation about the plan', 'appropriateness'),
    mkFinding('High-alert medication: Insulin'),
  ]);
  for (const f of batch) {
    assert.ok(f.signal_type && f.signal_type.length > 0);
    assert.ok(f.finding_ref && f.finding_ref.length >= 12);
  }
});

// B4 — specialty context line in the case text
test('opdCaseText includes the treating specialty line when provided (B4)', () => {
  const { case: c } = rowToOpdCase(GP_ROW);
  const withSpec = opdCaseText(c, { specialty: 'Dermatologist' });
  assert.match(withSpec, /Treating clinician specialty: Dermatologist/);
  assert.match(withSpec, /this specialty's standards/);
  // no specialty → no line (backwards compatible)
  assert.ok(!/Treating clinician specialty/.test(opdCaseText(c)));
  assert.ok(!/Treating clinician specialty/.test(opdCaseText(c, { specialty: '' })));
});

// B2 — follow-up documented only for a real disposition / explicit date; UNKNOWN/blank does not count
test('followUpDocumented + completeness: UNKNOWN/blank excluded, real dispositions count (B2)', () => {
  const base = { uid: 'x', doctor_uid: 'd', type_of_prescription: 'GENERAL_PRACTITIONER', timestamp: '2026-07-02T05:00:00+05:30',
    presenting_complaints: '[]', diagnosis_icd_codes: ['J06.9'],
    medications: '[{"generic_name":"Paracetamol","dosage":"650mg","frequency":"1-1-1","duration":"3d","route_of_administration":"oral"}]',
    general_practitioner_prescription__plan_of_management: '[{"management_plan":"<p>rest</p>"}]' };
  const withType = (t: string | null, date?: string) => rowToOpdCase({ ...base, followup__followup_type: t, next_follow_up_date: date ?? null }).case;

  assert.equal(followUpDocumented(withType('UNKNOWN')), false);
  assert.equal(followUpDocumented(withType('')), false);
  assert.equal(followUpDocumented(withType(null)), false);
  assert.equal(followUpDocumented(withType('IF_REQUIRED')), true);
  assert.equal(followUpDocumented(withType('MANDATORY_FOLLOW_UP')), true);
  assert.equal(followUpDocumented(withType('FOLLOW_UP_WITH_REPORTS')), true);
  assert.equal(followUpDocumented(withType('UNKNOWN', '2026-07-10')), true); // explicit date wins

  // completeness reflects it: UNKNOWN → follow_up missing; MANDATORY → present
  assert.ok(opdCompleteness(withType('UNKNOWN')).missing.includes('Follow-up specified'));
  assert.ok(!opdCompleteness(withType('MANDATORY_FOLLOW_UP')).missing.includes('Follow-up specified'));
  // and patient-centred continuity drops for UNKNOWN (follow_up is 1 of its 2 fields)
  assert.equal(opdCompleteness(withType('UNKNOWN')).patientCentred.present, 1);
  assert.equal(opdCompleteness(withType('MANDATORY_FOLLOW_UP')).patientCentred.present, 2);
});

// 0.8 — each field scored ONCE: advice/follow-up stay on the checklist (display, missing-fields)
// but no longer move the Documentation coverage — they are scored in the Continuity domain only.
test('completeness coverage excludes continuity fields — scored once (0.8)', () => {
  const base = { uid: 'x8', doctor_uid: 'd', type_of_prescription: 'GENERAL_PRACTITIONER', consult_type: 'IN_PERSON', timestamp: '2026-07-02T05:00:00+05:30',
    presenting_complaints: '[{"complaint":"fever"}]', diagnosis_icd_codes: ['J06.9'],
    medications: '[{"generic_name":"Paracetamol","dosage":"650mg","frequency":"1-1-1","duration":"3d","route_of_administration":"oral"}]',
    general_practitioner_prescription__plan_of_management: '[{"management_plan":"<p>rest</p>"}]' };
  const mk = (over: Record<string, unknown>) => rowToOpdCase({ ...base, ...over }).case;

  const withFu = opdCompleteness(mk({ followup__followup_type: 'MANDATORY_FOLLOW_UP' }));
  const noFu = opdCompleteness(mk({ followup__followup_type: 'UNKNOWN' }));
  assert.equal(noFu.coverage, withFu.coverage);             // follow-up no longer moves Documentation
  assert.ok(noFu.missing.includes('Follow-up specified'));  // but is still tracked as missing
  assert.equal(noFu.patientCentred.present, 1);             // and still penalised in Continuity

  const noAdvice = opdCompleteness(mk({ followup__followup_type: 'MANDATORY_FOLLOW_UP', general_practitioner_prescription__plan_of_management: '[]' }));
  assert.equal(noAdvice.coverage, withFu.coverage);         // advice no longer moves Documentation
  assert.equal(noAdvice.patientCentred.present, 1);

  // the checklist still carries both fields for display
  assert.equal(withFu.items.filter((i) => ['advice_given', 'follow_up'].includes(i.key)).length, 2);
  // and the Documentation denominator is the clinical-record core (complaint/dx/dosing/exam[/vitals]).
  // v0.81.1 K: this is an in-person FEVER note, so a vitals requirement is added — exam AND vitals
  // are both missing here, so coverage is 3/5 (was 3/4 before the presentation-aware vitals check).
  assert.equal(withFu.coverage, 3 / 5);
});

// B1 — empty-medications case text tells the auditor there's no prescription to fault
test('opdCaseText marks a zero-medication note explicitly (B1)', () => {
  const { case: c } = rowToOpdCase({ uid: 'z', doctor_uid: 'd', type_of_prescription: 'GENERAL_PRACTITIONER',
    timestamp: '2026-07-02T05:00:00+05:30', diagnosis_icd_codes: ['J06.9'], medications: '[]',
    followup__followup_type: 'FOLLOW_UP_WITH_REPORTS' });
  assert.equal(c.medications.length, 0);
  assert.match(opdCaseText(c), /NONE prescribed this encounter/);
  assert.match(opdCaseText(c), /no prescription to assess/);
});

// ── v0.81 BUG-0.8-04: encounter-modality classification (in-person vs teleconsult) ──────────────
test('v0.81 BUG-0.8-04: HOSPITAL_* prescription types are IN-PERSON, not teleconsult', () => {
  assert.equal(isTeleconsultEncounter('HOSPITAL_GP', null), false);
  assert.equal(isTeleconsultEncounter('HOSPITAL_GP_INVESTIGATION_REFERRAL', null), false);
  assert.equal(isTeleconsultEncounter('HOSPITAL_PAEDIATRIC', null), false);
  assert.equal(isTeleconsultEncounter('GENERAL_PRACTITIONER', null), true); // app e-consult = teleconsult
  // explicit consult_type still overrides in both directions
  assert.equal(isTeleconsultEncounter('HOSPITAL_GP', 'Teleconsult'), true);
  assert.equal(isTeleconsultEncounter('GENERAL_PRACTITIONER', 'In-Person'), false);
});

test('v0.81 FIX I: a documented hands-on exam downgrades a teleconsult classification', () => {
  assert.equal(hasHandsOnExam(['P/A - soft, periumbilical tenderness +']), true);
  assert.equal(hasHandsOnExam(['PA: Small umbilical Hernia']), true);
  assert.equal(hasHandsOnExam(['throat congested']), false); // visual-only, not hands-on
  assert.equal(hasHandsOnExam([]), false);
  // integration: a GENERAL_PRACTITIONER row (would-be teleconsult) with a hands-on exam → in-person
  const c = rowToOpdCase({ ...ROW, type_of_prescription: 'GENERAL_PRACTITIONER',
    general_practitioner_prescription__examination: '<p>P/A soft, non-tender</p>' }).case;
  assert.equal(c.isTeleconsult, false);
  assert.ok(c.examination.length > 0);
});

test('v0.81 BUG-0.8-04: HOSPITAL_GP in-person note IS scored on examination', () => {
  const c = rowToOpdCase({ ...ROW, type_of_prescription: 'HOSPITAL_GP',
    general_practitioner_prescription__examination: '' }).case;
  assert.equal(c.isTeleconsult, false);
  const comp = opdCompleteness(c);
  assert.ok(comp.items.some((i) => i.key === 'examination')); // in-person → examination IS scored
  assert.equal(comp.items.find((i) => i.key === 'examination')!.present, false); // empty → real gap
});

// ── v0.81 BUG-0.8-05/07: domain aggregation degrades gracefully (no flat 0) ─────────────────────
test('v0.81 BUG-0.8-05/07: stacked findings degrade gracefully, never a flat 0; single finding unchanged', () => {
  const lv = { verdict: 'low-value' as const, confidence: 1, domain: 'appropriateness' as const };
  const appr = (fs: any[]) => computeOpdScore({ findings: fs, completenessCoverage: 1, pdqi9: null, patientCentred: { present: 0, total: 0 } })
    .domains.find((d) => d.domain === 'appropriateness')!.score;
  assert.equal(appr([lv]), 55);          // one low-value finding: unchanged vs the old additive model
  const two = appr([lv, lv]), three = appr([lv, lv, lv]);
  assert.ok(two < 55 && two > 0);        // ~30
  assert.ok(three < two && three > 0);   // ~17 — NOT a flat 0 (old additive gave 0)
});

// ── v0.81 BUG-0.8-03: a formal referral satisfies follow-up / continuity ────────────────────────
test('v0.81 BUG-0.8-03: a formal referral counts as documented follow-up', () => {
  const withRef = rowToOpdCase({ ...ROW, followup__followup_type: 'UNKNOWN', next_follow_up_date: null,
    refer_to: '[{"specialist_type":{"name":"Orthopedics","is_in_house":false},"recommended_by_even":true}]' }).case;
  assert.equal(followUpDocumented(withRef), true);
  const noRef = rowToOpdCase({ ...ROW, followup__followup_type: 'UNKNOWN', next_follow_up_date: null, refer_to: '[]' }).case;
  assert.equal(followUpDocumented(noRef), false);
});

// ── v0.81 BUG-0.8-01: injectable with only a concentration is NOT dose-documented ───────────────
test('v0.81 BUG-0.8-01: injectable concentration is not a dose; oral strength still counts', () => {
  const inj: any = { generic: 'Ferric Carboxymaltose', brand: 'Orofer FCM Injection', strength: '50mg/ml', dose: '', frequency: 'STAT', route: '' };
  assert.equal(medDoseDocumented(inj), false);                 // parenteral + no dose → incomplete
  assert.equal(medDoseDocumented({ ...inj, dose: '500mg' }), true); // explicit total dose → documented
  const oral: any = { generic: 'Paracetamol', brand: 'Dolo 650 Tablet', strength: '650mg', dose: '', frequency: '1-0-1', route: 'oral' };
  assert.equal(medDoseDocumented(oral), true);                 // non-injectable: strength counts
});

// ── v0.81.1 P1: PDQI reasoning rubric is presentation-adjusted (the 85%/73% floor fix) ──────────
test('v0.81.1 P1: reasoning rubric judges by presentation, not sparseness', () => {
  assert.ok(!/fall for sparseness/.test(OPD_AUDIT_SYSTEM));               // old floor clause gone
  assert.ok(!/\(low if sparse\)/.test(OPD_AUDIT_SYSTEM));                 // per-attribute "low if sparse" gone
  assert.match(OPD_AUDIT_SYSTEM, /THIS presentation's acuity and risk/i); // presentation-adjusted guidance present
  assert.match(OPD_AUDIT_SYSTEM, /never lower these for appropriate brevity/i);
});

// ── v0.81.1 P/O/F/N: prompt-hardening clauses + O-render ─────────────────────────────────────────
test('v0.81.1 P/O/F/N: prompt-hardening guards are present', () => {
  assert.match(OPD_AUDIT_SYSTEM, /UNINDICATED \/ CONTRADICTED DRUG/);          // P + L
  assert.match(OPD_AUDIT_SYSTEM, /code AUTO-MAPPING gap, not a missing diagnosis/); // O
  assert.match(OPD_AUDIT_SYSTEM, /VERIFY BEFORE FLAGGING AN ABSENCE/);         // F
  assert.match(OPD_AUDIT_SYSTEM, /ONE ISSUE, ONE FINDING/);                    // N
});

test('v0.81.1 O-render: an impression without an ICD code is not shown as "(none documented)"', () => {
  const c = rowToOpdCase({ ...ROW, diagnosis_icd_codes: [],
    general_practitioner_prescription__presenting_complaints:
      '[{"symptoms":"<p>neck pain</p>","diagnoses":[{"icd_code":"","diagnosis_or_impression":"Cervical Spondylosis"}]}]' }).case;
  const txt = opdCaseText(c);
  assert.ok(!/Diagnosis \(ICD-10\): \(none documented\)/.test(txt));   // no longer reads as absent
  assert.match(txt, /ICD code not auto-resolved/);
  assert.match(txt, /Cervical Spondylosis/);
});

// ── v0.81.1 D: all documented diagnoses captured (dpipe + nested merged, not either/or) ──────────
test('v0.81.1 D (BUG-0.8-02): a nested diagnosis is not dropped when dpipe captured only one', () => {
  const c = rowToOpdCase({ ...ROW,
    dpipe_dx: '[{"diagnosis":"Anxiety","icd_code":"F41"}]',           // dpipe path: Anxiety only
    diagnosis_icd_codes: [],
    general_practitioner_prescription__presenting_complaints:
      '[{"symptoms":"<p>chest pain</p>","diagnoses":[{"diagnosis_or_impression":"Chest pain","icd_code":""},{"diagnosis_or_impression":"Anxiety","icd_code":"F41"}]}]' }).case;
  assert.ok(c.impressions.includes('Chest pain'));  // was DROPPED pre-D (dpipe-only won)
  assert.ok(c.impressions.includes('Anxiety'));
  assert.ok(c.diagnosisCodes.includes('F41'));
});

// ── v0.81.1 K (BUG-0.8-06a): presentation-required vitals ───────────────────────────────────────
test('v0.81.1 K: in-person febrile note with no vitals gets a documentation gap; controls do not', () => {
  // febrile, in-person, NO vitals → vitals gap, coverage < 1
  const noVitals = rowToOpdCase({ ...ROW, type_of_prescription: 'HOSPITAL_GP',
    general_practitioner_prescription__presenting_complaints:
      '[{"symptoms":"<p>fever and body ache since 2 days</p>","diagnoses":[{"diagnosis_or_impression":"Acute febrile illness","icd_code":"R50.9"}]}]',
    general_practitioner_prescription__examination: '' }).case;
  const c1 = opdCompleteness(noVitals);
  assert.ok(c1.items.some((i) => i.key === 'vitals' && !i.present));
  assert.ok(c1.missing.some((m) => /Vitals/i.test(m)));
  assert.ok(c1.coverage < 1);

  // febrile WITH a temperature recorded → no vitals gap
  const withTemp = rowToOpdCase({ ...ROW, type_of_prescription: 'HOSPITAL_GP',
    general_practitioner_prescription__presenting_complaints:
      '[{"symptoms":"<p>fever since 2 days</p>","diagnoses":[{"diagnosis_or_impression":"AFI","icd_code":"R50.9"}]}]',
    general_practitioner_prescription__examination: '<p>Temp 101F, BP 120/80, pulse 88</p>' }).case;
  assert.ok(!opdCompleteness(withTemp).items.some((i) => i.key === 'vitals' && !i.present));

  // non-febrile in-person note → no vitals requirement at all
  const nonFever = rowToOpdCase({ ...ROW, type_of_prescription: 'HOSPITAL_GP',
    general_practitioner_prescription__presenting_complaints:
      '[{"symptoms":"<p>knee pain</p>","diagnoses":[{"diagnosis_or_impression":"OA knee","icd_code":"M17"}]}]',
    general_practitioner_prescription__examination: '<p>knee crepitus</p>' }).case;
  assert.ok(!opdCompleteness(nonFever).items.some((i) => i.key === 'vitals'));
});


test('BUG-0.8-12: consolidateDecisions merges the deterministic NSAID interaction + LLM duplication', () => {
  const fs: OpdFinding[] = [
    { subject: 'Interaction (moderate): Aceclofenac + Diclofenac', verdict: 'context-dependent', confidence: 0.6, domain: 'prescribing_safety', rationale: 'Two NSAIDs — additive GI and renal toxicity. Avoid concurrent NSAIDs.', evidence: [], estimates: [], citation_ids: [], source: 'deterministic' },
    { subject: 'Therapeutic duplication with concurrent oral and topical NSAIDs', verdict: 'low-value', confidence: 0.9, domain: 'prescribing_safety', rationale: 'The patient was prescribed both an oral NSAID and a topical NSAID.', evidence: [], estimates: [], citation_ids: [], source: 'llm' },
    { subject: 'Unindicated antihistamine', verdict: 'low-value', confidence: 0.8, domain: 'appropriateness', rationale: 'x', evidence: [], estimates: [], citation_ids: [], source: 'llm' },
  ];
  const out = consolidateDecisions(fs);
  assert.equal(out.length, 2, 'the LLM NSAID duplication is dropped');
  assert.ok(out.some((f) => f.source === 'deterministic' && /^Interaction/.test(f.subject)), 'deterministic interaction survives');
  assert.ok(!out.some((f) => /Therapeutic duplication/.test(f.subject)), 'llm duplication removed');
  assert.ok(out.some((f) => f.domain === 'appropriateness'), 'unrelated appropriateness finding untouched');
});

test('BUG-0.8-12: consolidateDecisions is a no-op when there is no deterministic NSAID interaction', () => {
  const fs: OpdFinding[] = [
    { subject: 'Therapeutic duplication with concurrent oral and topical NSAIDs', verdict: 'low-value', confidence: 0.9, domain: 'prescribing_safety', rationale: 'x', evidence: [], estimates: [], citation_ids: [], source: 'llm' },
  ];
  assert.equal(consolidateDecisions(fs).length, 1);
});


test('BUG-0.8-16: an "inaccurate drug class" finding is neutralised (non-scoring) not a clinician penalty', () => {
  const fs: OpdFinding[] = [
    { subject: 'Incorrect drug class documented for Pantoprazole', verdict: 'low-value', confidence: 0.9, domain: 'appropriateness', rationale: 'The medication list incorrectly classifies Pantoprazole, a PPI, as an "Antibiotic".', evidence: [], estimates: [], citation_ids: [], source: 'llm' },
    { subject: 'Routine gastroprotection for a short NSAID course', verdict: 'low-value', confidence: 0.7, domain: 'appropriateness', rationale: 'PPI without risk factors', evidence: [], estimates: [], citation_ids: [], source: 'llm' },
  ];
  const out = neutralizeMetadataFindings(fs);
  const meta = out.find((f) => /drug class/i.test(f.subject))!;
  assert.equal(meta.informational, true, 'metadata finding is non-scoring');
  assert.equal(meta.signal_type, 'metadata_accuracy');
  const other = out.find((f) => /gastroprotection/.test(f.subject))!;
  assert.ok(!other.informational, 'genuine clinical finding untouched');
});


test('Q (0.8-10): an NSAID ingredient is detected inside a combination whose primary is a non-NSAID', () => {
  // topical Volitra: the parsed primary can be Methyl Salicylate, but Diclofenac is an NSAID.
  assert.equal(medHasMoleculeFrom({ resolvedGeneric: 'Methyl Salicylate+Diclofenac+Menthol+Linseed' }, NSAID_MOLECULES), true);
  assert.equal(medHasMoleculeFrom({ generic: 'Aceclofenac+Paracetamol+Chlorzoxazone' }, NSAID_MOLECULES), true);
  assert.equal(medHasMoleculeFrom({ resolvedGeneric: 'Pantoprazole' }, NSAID_MOLECULES), false);
});

test('R (0.8-11): a muscle relaxant is detected + consolidateDecisions drops the LLM version when a deterministic one exists', () => {
  assert.equal(medHasMoleculeFrom({ resolvedGeneric: 'Etodolac+Thiocolchicoside' }, MUSCLE_RELAXANT_MOLECULES), true);
  const fs: OpdFinding[] = [
    { subject: 'Muscle relaxant prescribed — document the indication', verdict: 'context-dependent', confidence: 0.5, domain: 'appropriateness', rationale: 'det', evidence: [], estimates: [], citation_ids: [], source: 'deterministic' },
    { subject: 'Indication for muscle relaxant not documented', verdict: 'low-value', confidence: 0.6, domain: 'appropriateness', rationale: 'The prescription includes Thiocolchicoside, a muscle relaxant...', evidence: [], estimates: [], citation_ids: [], source: 'llm' },
  ];
  const out = consolidateDecisions(fs);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'deterministic');
});

test('Part 1: an ICD/coding-completeness gap finding is neutralised to non-scoring', () => {
  const fs: OpdFinding[] = [
    { subject: 'Missing ICD-10 code for the documented diagnosis', verdict: 'low-value', confidence: 0.8, domain: 'appropriateness', rationale: 'The diagnosis is documented in words but no ICD-10 code is assigned.', evidence: [], estimates: [], citation_ids: [], source: 'llm' },
  ];
  const out = neutralizeMetadataFindings(fs);
  assert.equal(out[0].informational, true);
  assert.equal(out[0].signal_type, 'coding_completeness');
});

// ── Obstetric-template extraction adapter (CDMSS-OBGYN-TEMPLATE-EXTRACTION-FIX) ───────────────────
const OBS_ROW: Record<string, unknown> = {
  uid: 'obs1234567', doctor_uid: 'docR', type_of_prescription: 'HOSPITAL_GYNAECOLOGY_OBSTETRICS',
  timestamp: '2026-07-20T05:00:00+05:30', prescription_url: 'https://x/y.pdf',
  visit_notes: JSON.stringify([
    // an older, carried-over visit that must be IGNORED by current-visit selection
    { show_in_prescription: false, is_carried_over: true, date_of_visit: '2026-06-01', symptoms_notes: '<p>old carried-over note</p>' },
    // the current visit (show_in_prescription = true)
    { show_in_prescription: true, is_carried_over: false, date_of_visit: '2026-07-20', trimester_at_visit: '3',
      gestational_age_at_visit: '31w', patient_weight_kgs: '62', symphysis_fundal_height_cm: '30',
      fetal_heart_rate_bpm: '142', fetal_presentation: 'Cephalic', amniotic_fluid_index_cm: '12', estimated_fetal_weight_g: '1800',
      symptoms_notes: '<p>H/O amenorrhoea. BP 110/70 mmHg, no pedal edema.</p>' },
  ]),
  gynae_patient_history__menstrual_history__last_menstrual_period: '2025-12-10',
  gynae_patient_history__obstetric_history__gravidity: '2',
  gynae_patient_history__obstetric_history__parity: '1',
  medications: JSON.stringify([
    { brand_name: 'Femzact', dosage: '1-0-1', frequency: '', duration: '', route_of_administration: 'oral' },
    { brand_name: 'Gravipro', generic_name: 'Progesterone', dosage: '1', frequency: '0-0-1', duration: '8w', route_of_administration: 'oral' },
  ]),
  further_investigation: JSON.stringify([{ name: 'CBC' }, { name: 'GCT' }, { name: 'USG' }]),
  followup__followup_type: 'MANDATORY_FOLLOW_UP', followup__followup_date: '2026-08-03',
};

test('obstetric adapter (flag ON): populates canonical fields from the obstetric template + current-visit selection', () => {
  process.env.OBSTETRIC_EXTRACTION_ENABLED = '1';
  try {
    const { case: c } = rowToOpdCase(OBS_ROW);
    assert.equal(c.isObstetric, true);
    assert.ok(c.presentingComplaints.join(' ').toLowerCase().includes('amenorrhoea'), 'complaint from symptoms_notes');
    assert.ok(!c.presentingComplaints.join(' ').includes('old carried-over'), 'current-visit selection ignored the carried-over element');
    assert.ok(c.examination.some((e) => /SFH 30 cm/.test(e)), 'fetal measures rendered into examination');
    assert.ok([...c.examination, ...c.presentingComplaints].some((t) => /BP 110\/70/.test(t)), 'BP present in narrative');
    assert.ok(c.impressions.some((i) => /POG 31w/.test(i)), 'assessment = gestational status');
    assert.ok(c.impressions.some((i) => /G2 P1/.test(i)), 'gravidity/parity in assessment');
    assert.equal(c.medications.length, 2);
    assert.ok(c.investigations.includes('CBC'));
    assert.equal(c.obstetric?.trimester, 3);
    assert.equal(c.obstetric?.gaDocumented, true);
    assert.equal(c.obstetric?.lmpOrEddDocumented, true);
    assert.equal(c.obstetric?.gravidityParityDocumented, true);
    assert.equal(c.obstetric?.weightDocumented, true);
    assert.equal(c.obstetric?.sfhDocumented, true);

    const comp = opdCompleteness(c);
    assert.ok(comp.items.some((i) => i.key === 'ga_pog'), 'obstetric mandatory set is used');
    assert.ok(!comp.missing.includes('Complete medication dosing'), '1-0-1 schedule counts as valid dosing (blank frequency)');
    assert.ok(comp.coverage > 0.8, `a rich antenatal note must score near-complete, got ${comp.coverage}`);
    // the auditor prompt gets the obstetric encounter context (no ICD-diagnosis fault)
    assert.match(opdCaseText(c), /ANTENATAL \/ OBSTETRIC/);
  } finally { delete process.env.OBSTETRIC_EXTRACTION_ENABLED; }
});

test('obstetric adapter (flag OFF): the obstetric note audits via the GP path, byte-identical (no isObstetric)', () => {
  delete process.env.OBSTETRIC_EXTRACTION_ENABLED;
  const { case: c } = rowToOpdCase(OBS_ROW);
  assert.equal(c.isObstetric, undefined);
  assert.equal(c.obstetric, undefined);
  assert.equal(c.presentingComplaints.length, 0, 'GP mapping reads nothing from the obstetric block (the current bug, unchanged)');
  const comp = opdCompleteness(c);
  assert.ok(comp.items.every((i) => i.key !== 'ga_pog'), 'GP checklist, not the obstetric set');
  assert.ok(!opdCaseText(c).includes('ANTENATAL / OBSTETRIC'));
});

// direct-case helpers for the mandatory-set logic (no env / no row needed)
function obsCase(over: Partial<DeidOpdCase>): DeidOpdCase {
  return {
    consultType: null, reasonForConsult: null, presentingComplaints: ['H/O amenorrhoea'],
    diagnosisCodes: [], impressionCodes: [], impressions: ['POG 31w'], history: [], comorbidities: [],
    medications: [{ brand: 'Femzact', dose: '1-0-1', route: 'oral' }], investigations: ['CBC'], advice: [],
    examination: ['BP 110/70 mmHg', 'Weight 62 kg', 'SFH 30 cm'], allergies: null,
    followUpType: 'MANDATORY_FOLLOW_UP', followUpDateSet: true, isObstetric: true,
    obstetric: { trimester: 3, gaDocumented: true, lmpOrEddDocumented: true, gravidityParityDocumented: true, weightDocumented: true, sfhDocumented: true, fhrDocumented: true, presentationDocumented: true },
    ...over,
  };
}

test('obstetric mandatory set: SFH/FHR/presentation required only in the 2nd/3rd trimester', () => {
  const noFetal = { trimester: 3, gaDocumented: true, lmpOrEddDocumented: true, gravidityParityDocumented: true, weightDocumented: true, sfhDocumented: false, fhrDocumented: false, presentationDocumented: false };
  const t3 = opdCompleteness(obsCase({ obstetric: { ...noFetal, trimester: 3 } }));
  assert.equal(t3.items.find((i) => i.key === 'obstetric_vitals')!.present, false, 'T3 with no fetal params ⇒ vitals gap');
  assert.match(t3.items.find((i) => i.key === 'obstetric_vitals')!.label, /fetal/);
  const t1 = opdCompleteness(obsCase({ obstetric: { ...noFetal, trimester: 1 } }));
  assert.equal(t1.items.find((i) => i.key === 'obstetric_vitals')!.present, true, 'T1 with BP+weight ⇒ vitals met (fetal not required)');
  assert.ok(!/fetal/.test(t1.items.find((i) => i.key === 'obstetric_vitals')!.label));
});

test('obstetric mandatory set: rich note near-complete; follow-up scored in Continuity not Documentation', () => {
  const comp = opdCompleteness(obsCase({}));
  assert.deepEqual(comp.missing, [], 'a fully-documented antenatal note has no gaps');
  assert.equal(comp.coverage, 1);
  assert.equal(comp.patientCentred.total, 1, 'follow-up is the Continuity subset');
  assert.equal(comp.patientCentred.present, 1);
  const keys = comp.items.map((i) => i.key);
  assert.deepEqual(keys, ['ga_pog', 'lmp_edd', 'gravidity_parity', 'presenting_complaint', 'obstetric_vitals', 'medication_dosing', 'investigations', 'follow_up']);
});

test('obstetricDosingComplete: a 1-0-1 schedule counts even with a blank frequency field', () => {
  assert.equal(obstetricDosingComplete({ brand: 'Femzact', dose: '1-0-1', frequency: '', route: 'oral' }), true);
  assert.equal(obstetricDosingComplete({ brand: 'Gravipro', dose: '1', frequency: '0-0-1', route: 'oral' }), true);
  assert.equal(obstetricDosingComplete({ generic: 'amoxicillin', dose: '500mg', frequency: '1-1-1', route: 'oral' }), true);
  assert.equal(obstetricDosingComplete({ brand: 'Mystery', dose: '', frequency: '', route: 'oral' }), false, 'no amount + no frequency ⇒ incomplete');
});

test('bpDocumented reads BP from the obstetric narrative (no structured BP column in db13, §9)', () => {
  assert.equal(bpDocumented(obsCase({ examination: ['BP 110/70 mmHg'], presentingComplaints: [], history: [] })), true);
  assert.equal(bpDocumented(obsCase({ examination: ['blood pressure 120/80'], presentingComplaints: [], history: [] })), true);
  assert.equal(bpDocumented(obsCase({ examination: ['fundal height 30cm'], presentingComplaints: ['amenorrhoea'], history: [] })), false);
});
