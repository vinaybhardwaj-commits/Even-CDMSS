/**
 *   node --experimental-strip-types --test lib/__tests__/opd-note-audit-core.test.ts
 * Pure cores: row→case ingest (opd-ingest-core) + completeness/prescribing/parse (opd-note-audit-core).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowToOpdCase, opdCaseText } from '../opd-ingest-core.ts';
import { opdCompleteness, prescribingChecks, parseOpdAnalysis, medDoseDocumented, resolveMedRoute, opdSignalType, stampFindingIdentity, OPD_SIGNAL_TYPES, type OpdFinding } from '../opd-note-audit-core.ts';

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

test('opdSignalType: LLM subjects — antibiotic rule, bounded slug fallback, domain fallback', () => {
  assert.equal(opdSignalType('Antibiotic for likely-viral URTI', 'prescribing_safety'), 'antibiotic_stewardship');
  // slug fallback is bounded (≤4 words) + deterministic → recurring LLM subjects batch together
  assert.equal(opdSignalType('Low-yield Widal test for afebrile patient', 'appropriateness'),
    opdSignalType('low yield widal test', 'appropriateness'));
  // empty prefix → the domain's general bucket
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
