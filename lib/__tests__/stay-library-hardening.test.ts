// lib/__tests__/stay-library-hardening.test.ts — the stay library's hardening slices
// (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026).
//
// H1 (H-D2): a library row is never overwritten without its prior reading landing in
// `clinical_state_versions` in the SAME SQL statement. The behavioural tests here drive
// `upsertClinicalState` through its test seam, so what is asserted is the SQL that would actually
// have been sent and the outcome the caller would actually have got — including the case that
// matters most, a snapshot leg that FAULTS, which must block the overwrite rather than proceed
// without a trail. The source pins carry what a behavioural test cannot see: that the snapshot and
// the overwrite are one statement and not two, and that the new table is append-only.
//
// H2 (H-D3 / H-D4 / H-D5 / H-D6): the deterministic contamination guard. The §2 worked examples are
// pinned as fixtures BY THEIR TOKEN SETS as well as their verdicts — a rule that flagged for the
// wrong reason would satisfy a verdict-only assertion — and the gate tests each state their
// precondition, so a gate that refused everything could not pass them.
// Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { upsertClinicalState, SNAPSHOT_REASONS, type SqlRunner } from '../stay-library/store';
import {
  contaminationSuspect, contaminationNotice, significantTokens,
  CONTAMINATION_STOPLIST, CONTAMINATION_COPY, MIN_TOKEN_LENGTH,
} from '../stay-library/contamination';
import { contaminationOf, STAY_LIBRARY_VERSION } from '../stay-library/core';
import { promotable, stayToEncounter } from '../member-state/ipd-evidence';
import { stayEvidenceInputFrom } from '../member-state/ipd-fold';
import { emptyClinicalState } from '../clinical-state/schema';
import type { ClinicalState, Provenance } from '../clinical-state/schema';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file's CODE, comments stripped — a pin that reads prose fails on a file honest enough to
 *  document what it refuses to do (the P1 lesson, re-applied through P2 and now here). */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

const state = (): ClinicalState => {
  const st = emptyClinicalState('doc_audit');
  st.surfaceExtras = { stayDoc: { docKind: 'ot', sourceUid: 'ot-1' } };
  return st;
};

const input = {
  docKind: 'ot' as const, sourceUid: 'ot-1', memberUid: 'M1',
  encounterRef: 'IP-1472', status: 'ok' as const, state: state(),
};

/** A recording fake runner. `priorRows` is what the pre-read returns; `fail` names the leg that
 *  throws, by substring, so a test can fault exactly one of the two statements. */
function fakeRunner(o: { priorRows?: number; failOn?: string } = {}) {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const run: SqlRunner = async (query, params) => {
    calls.push({ query, params });
    if (o.failOn && query.includes(o.failOn)) throw new Error('simulated fault');
    if (/^\s*SELECT id FROM clinical_states/.test(query)) {
      return Array.from({ length: o.priorRows ?? 0 }, () => ({ id: 'prior-row-id' }));
    }
    return [{ inserted: (o.priorRows ?? 0) === 0 }];
  };
  return { run, calls };
}

// ══ H1 — snapshot before overwrite ═══════════════════════════════════════════════════════

test('H1: overwriting a library row snapshots the prior row in the SAME statement', async () => {
  const { run, calls } = fakeRunner({ priorRows: 1 });
  assert.equal(await upsertClinicalState(input, run), 'updated');

  assert.equal(calls.length, 2, 'one pre-read, then one write statement — not three');
  const write = calls[1].query;
  assert.match(write, /^\s*WITH cur AS \(/, 'the snapshot must lead the statement it guards');
  assert.match(write, /INSERT INTO clinical_state_versions/);
  assert.match(write, /'upsert_overwrite'/);
  assert.match(write, /ON CONFLICT \(doc_kind, source_uid, schema_version\) DO UPDATE/);
  assert.match(write, /RETURNING \(xmax = 0\) AS inserted/, 'the (xmax = 0) return must survive H1');
  // ONE statement, not two: a semicolon between the legs would let a crash separate them.
  assert.equal(write.split(';').length, 1, 'the snapshot and the overwrite must not be two statements');
  // The snapshot reads the row being replaced, not the row replacing it.
  assert.match(write, /SELECT c\.id, c\.doc_kind, c\.source_uid, c\.schema_version, c\.status, c\.state_json/);
  assert.ok(!/EXCLUDED\.[a-z_]+, *'upsert_overwrite'/.test(write), 'the snapshot must not carry EXCLUDED values');
});

test('H1: a FRESH insert snapshots nothing and never names the versions table', async () => {
  const { run, calls } = fakeRunner({ priorRows: 0 });
  assert.equal(await upsertClinicalState(input, run), 'inserted');

  const write = calls[1].query;
  assert.ok(!write.includes('clinical_state_versions'),
    'a fresh insert must not reference the versions table — a deploy ahead of the migration still builds libraries');
  assert.ok(!write.includes('WITH cur'));
  assert.match(write, /^\s*INSERT INTO clinical_states/);
});

test('H1: a FAILED snapshot blocks the overwrite and returns the fail-soft skip', async () => {
  const { run, calls } = fakeRunner({ priorRows: 1, failOn: 'clinical_state_versions' });
  // The whole statement aborts — the overwrite is inside it, so it did not happen either.
  assert.equal(await upsertClinicalState(input, run), 'skipped');
  assert.equal(calls.length, 2, 'the store must not retry the overwrite without its snapshot');
  assert.ok(calls.every((c) => c.query.includes('clinical_state_versions') || c.query.startsWith('SELECT id')),
    'no unsnapshotted write was attempted');
});

test('H1: fail-soft is preserved — the upsert never throws, whatever faults', async () => {
  const both: SqlRunner = async () => { throw new Error('database is gone'); };
  assert.equal(await upsertClinicalState(input, both), 'skipped');

  // A pre-read that faults must NOT be read as "no prior row": unknown takes the snapshot path,
  // because guessing "fresh" on a row that exists is exactly the unsnapshotted overwrite H1 bans.
  const { run, calls } = fakeRunner({ failOn: 'SELECT id FROM clinical_states' });
  await upsertClinicalState(input, run);
  assert.match(calls[1].query, /INSERT INTO clinical_state_versions/,
    'an unknown prior must take the snapshot path, not the fresh-insert path');

  // And the validation guards still short-circuit before any SQL at all.
  const empty = fakeRunner();
  assert.equal(await upsertClinicalState({ ...input, sourceUid: '' }, empty.run), 'skipped');
  assert.equal(empty.calls.length, 0, 'a malformed input must not reach the database');
});

test('H1: the snapshot carries the row identity a diff needs', async () => {
  const { run, calls } = fakeRunner({ priorRows: 1 });
  await upsertClinicalState(input, run);
  const write = calls[1].query;
  for (const col of ['clinical_state_id', 'doc_kind', 'source_uid', 'schema_version', 'status', 'state_json', 'reason']) {
    assert.ok(write.includes(col), `the snapshot must carry ${col}`);
  }
  // The pre-read and the CTE must name the SAME row, or the snapshot guards a different one.
  assert.match(calls[0].query, /doc_kind = \$1 AND source_uid = \$2 AND schema_version = \$3/);
  assert.match(write, /WHERE doc_kind = \$1 AND source_uid = \$2 AND schema_version = \$5/);
  assert.deepEqual(calls[0].params, ['ot', 'ot-1', 'clinical-state/1.2']);
});

// ══ H1 source pins ═══════════════════════════════════════════════════════════════════════

test('H-D2: the reason enum is exactly the two the PRD names', () => {
  assert.deepEqual([...SNAPSHOT_REASONS], ['upsert_overwrite', 'superseded']);
});

test('the versions table is APPEND-ONLY: the store never updates or deletes it', () => {
  const store = code('lib/stay-library/store.ts');
  // Every write verb that names a table names one of exactly two, and the versions table is only
  // ever INSERTed into. (`ON CONFLICT ... DO UPDATE SET` names no table — it is still the INSERT's
  // own target — so it is neutralised before the scan rather than matched as a bare UPDATE.)
  const sqlish = store.replace(/DO\s+UPDATE/gi, 'DO_UPSERT');
  const writes = [...sqlish.matchAll(/(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+([a-z_][a-z0-9_]*)/gi)]
    .map((m) => ({ verb: m[1].toUpperCase().replace(/\s+/g, ' '), table: m[2] }));
  assert.ok(writes.length > 0, 'the store must actually write something');
  for (const w of writes) {
    assert.ok(['clinical_states', 'clinical_state_versions'].includes(w.table), `the store writes ${w.table}`);
    if (w.table === 'clinical_state_versions') {
      assert.equal(w.verb, 'INSERT INTO', 'the version trail is append-only — it is never rewritten');
    }
  }
});

test('H1 migration 0049 is additive and creates the versions table', () => {
  for (const f of ['migrations/0049_stay_library_hardening.sql', 'app/api/admin/migrate-stay-library-hardening/route.ts']) {
    const src = code(f);
    assert.ok(!/\bDROP\b/i.test(src), `${f} contains DROP`);
    assert.ok(src.includes('CREATE TABLE IF NOT EXISTS clinical_state_versions'));
    assert.ok(src.includes('clinical_state_versions_state_idx'));
  }
  // 0049 is the next free number: nothing already claims it.
  const dir = readFileSync(join(ROOT, 'migrations/0049_stay_library_hardening.sql'), 'utf8');
  assert.ok(dir.length > 0);
});

test('H1 touches no engine version, no schema version and no flag', () => {
  const src = code('lib/stay-library/store.ts')
    + code('app/api/admin/migrate-stay-library-hardening/route.ts')
    + code('migrations/0049_stay_library_hardening.sql');
  for (const banned of [
    'ipd-discharge-audit/0', 'ipd-stay-audit/0', 'opd-note-audit/0', 'member-state/1',
    'MEMBERSTATE_IPD_FOLD', 'MEMBER_STATE_UI', 'care_value_index', 'tracedChat', 'governedChat',
  ]) {
    assert.ok(!src.includes(banned), `H1 names ${banned}`);
  }
  assert.ok(!/CLINICAL_STATE_VERSION\s*=\s*'/.test(src), 'H1 must not redeclare the schema version');
});

test('H1 names exactly two tables and no audit / feedback / spine table', () => {
  const store = code('lib/stay-library/store.ts');
  for (const forbidden of [
    'ipd_discharge_audits', 'opd_note_audits', 'ipd_audit_feedback', 'opd_audit_feedback',
    'readmission_findings', 'readmission_finding_versions', 'episode_states', 'member_state',
    'case_ask_turns',
  ]) {
    assert.ok(!store.includes(forbidden), `store.ts names ${forbidden}`);
  }
});

// ══ H2 — the contamination guard ══════════════════════════════════════════════════════════

test('H-D4 fixture 1 (§2, the R10 case): a cholecystectomy inside a hernioplasty stay is SUSPECT', () => {
  const ot = 'BILATERAL LAPAROSCOPIC INGUINAL HERNIOPLASTY -TAPP WITH PRIMARY UMBILICAL HERNIA REPAIR.';
  const discharge = 'LAPAROSCOPIC CHOLECYSTECTOMY';
  // The PRD states both significant sets outright. They are pinned, not merely their conclusion:
  // a rule that flags for the wrong reason would pass a conclusion-only assertion.
  assert.deepEqual(significantTokens(ot), ['HERNIA', 'HERNIOPLASTY', 'INGUINAL', 'UMBILICAL']);
  assert.deepEqual(significantTokens(discharge), ['CHOLECYSTECTOMY']);
  assert.equal(contaminationSuspect(ot, discharge), true);
});

test('H-D4 fixture 2 (§2): the same OT vs "TAPP hernioplasty" shares HERNIOPLASTY and is CLEAN', () => {
  const ot = 'BILATERAL LAPAROSCOPIC INGUINAL HERNIOPLASTY -TAPP WITH PRIMARY UMBILICAL HERNIA REPAIR.';
  assert.deepEqual(significantTokens('TAPP hernioplasty'), ['HERNIOPLASTY'],
    'TAPP is four letters and is dropped; an acronym match is not evidence of the same operation');
  assert.equal(contaminationSuspect(ot, 'TAPP hernioplasty'), false);
});

test('H-D4 stoplist edge: sharing ONLY an approach or side word still flags', () => {
  // Every word these two have in common is on the stoplist. They are different operations.
  assert.equal(contaminationSuspect('LAPAROSCOPIC LEFT NEPHRECTOMY', 'LAPAROSCOPIC RIGHT CHOLECYSTECTOMY'), true);
  assert.equal(contaminationSuspect('OPEN HERNIA REPAIR', 'OPEN APPENDICECTOMY WITH REPAIR'), true);
  for (const word of ['LAPAROSCOPIC', 'OPEN', 'BILATERAL', 'UNILATERAL', 'LEFT', 'RIGHT', 'PRIMARY',
    'SURGERY', 'PROCEDURE', 'OPERATION', 'NOTE', 'NOTES', 'REPAIR', 'WITH', 'AND']) {
    assert.ok(CONTAMINATION_STOPLIST.has(word), `${word} must be on H-D4's stoplist`);
    assert.deepEqual(significantTokens(word), [], `${word} must survive nothing`);
  }
  assert.equal(CONTAMINATION_STOPLIST.size, 15, 'the stoplist is H-D4\'s fifteen words and no more');
});

test('H-D4 stoplist edge: ONE shared substantive token is enough to clear the whole comparison', () => {
  assert.equal(contaminationSuspect('LAPAROSCOPIC CHOLECYSTECTOMY', 'OPEN CHOLECYSTECTOMY'), false);
  assert.equal(contaminationSuspect('TOTAL KNEE REPLACEMENT LEFT', 'KNEE REPLACEMENT REVISION'), false,
    'TOTAL/REVISION differ, but they agree on REPLACEMENT — one shared term is enough');
});

test('H-D4 measured property: the >= 5 rule drops SHORT ANATOMICAL SITES, so a site-only agreement flags', () => {
  // MEASURED, NOT DESIGNED, and reported to the orchestrator rather than worked around: H-D4 fixes
  // the length threshold at 5, and KNEE, HIP, EYE, TOE, EAR are shorter than that. Two honest
  // readings of the same knee operation that agree ONLY on the word KNEE therefore share zero
  // significant tokens and are flagged suspect.
  assert.deepEqual(significantTokens('TOTAL KNEE REPLACEMENT LEFT'), ['REPLACEMENT', 'TOTAL']);
  assert.equal(contaminationSuspect('TOTAL KNEE REPLACEMENT LEFT', 'REVISION KNEE ARTHROPLASTY'), true);
  // The consequence is bounded and it is the SAFE direction: a false flag suppresses one
  // discharge-sourced procedure from the spine and prints one advisory line. It changes no finding,
  // no CVI, and never the OT-sourced fact — which for any stay with an operative note is the fact
  // that actually promotes (precedence rank 1). H-D4 is settled; this is its cost, stated.
  assert.equal(contaminationSuspect('TOTAL KNEE REPLACEMENT', 'TOTAL KNEE ARTHROPLASTY'), false,
    'agreement on any longer word still clears it');
});

test('H-D4 normalisation: punctuation becomes a boundary, not a join', () => {
  assert.deepEqual(significantTokens('HERNIA/HERNIOPLASTY'), ['HERNIA', 'HERNIOPLASTY'],
    'deleting the slash would fuse two real words into one that matches nothing');
  assert.deepEqual(significantTokens('CHOLECYSTECTOMY.'), ['CHOLECYSTECTOMY']);
  assert.deepEqual(significantTokens('  '), []);
  assert.deepEqual(significantTokens(null), []);
  // Alphabetic only, length >= 5.
  assert.deepEqual(significantTokens('LSCS 12345 ABCDE'), ['ABCDE']);
  assert.equal(MIN_TOKEN_LENGTH, 5);
});

test('H-D4 errs toward NOT flagging: an empty significant set on either side never flags', () => {
  // Nothing was learned, so nothing is claimed. (Flagged to the orchestrator: H-D4's literal
  // sentence would flag here, its closing rule would not, and this takes the closing rule.)
  assert.equal(contaminationSuspect('OPEN SURGERY', 'LAPAROSCOPIC CHOLECYSTECTOMY'), false);
  assert.equal(contaminationSuspect('LAPAROSCOPIC CHOLECYSTECTOMY', 'TAPP'), false);
  assert.equal(contaminationSuspect('', 'CHOLECYSTECTOMY'), false);
  assert.equal(contaminationSuspect('CHOLECYSTECTOMY', null), false);
});

test('H2: a stay with SEVERAL operative notes is clean if the discharge matches ANY of them', () => {
  const discharge = 'LAPAROSCOPIC CHOLECYSTECTOMY';
  assert.equal(contaminationNotice(['INGUINAL HERNIOPLASTY', 'OPEN CHOLECYSTECTOMY'], discharge), null,
    'a discharge that agrees with the second of two operations agrees with this stay');
  const flagged = contaminationNotice(['INGUINAL HERNIOPLASTY', 'TOTAL KNEE REPLACEMENT'], discharge);
  assert.ok(flagged, 'sharing nothing with EVERY operative note is the suspect shape');
  assert.deepEqual(flagged.dischargeTokens, ['CHOLECYSTECTOMY']);
  assert.deepEqual(flagged.otTokens, ['HERNIOPLASTY', 'INGUINAL', 'REPLACEMENT', 'TOTAL'],
    'KNEE is four letters and does not survive H-D4\'s length rule');
  assert.equal(flagged.otSurgery, 'INGUINAL HERNIOPLASTY');
});

// ── H2 spine: the gate (§4.3) ─────────────────────────────────────────────────────────────

const prov = (over: Partial<Provenance> = {}): Provenance => ({
  sourceField: 'discharge_extract.procedure', rawText: 'LAPAROSCOPIC CHOLECYSTECTOMY',
  extractionMethod: 'llm', confidence: 0.8, reporter: 'clinician', trust: 'clinician_documented',
  ...over,
});

test('H-D5 condition 6: a contaminated procedure does NOT promote, even with a verified span', () => {
  const base = { slot: 'procedures', provenance: prov(), spanVerified: true, identityResolved: true };
  // Precondition: without the taint this exact candidate PROMOTES. Without this line the test
  // would pass against a gate that refuses everything.
  assert.deepEqual(promotable(base), { ok: true });
  assert.deepEqual(promotable({ ...base, contaminationSuspect: true }),
    { ok: false, reason: 'contamination_suspect' });
  // ...and the taint outranks trust and span, which is the whole point: the R10 case had both.
  assert.deepEqual(
    promotable({ ...base, contaminationSuspect: true, provenance: prov({ trust: 'structured_db' }) }),
    { ok: false, reason: 'contamination_suspect' });
});

test('H-D5: conditions 1–5 are unchanged — absent/false taint behaves exactly as before H2', () => {
  const base = { slot: 'procedures', provenance: prov(), spanVerified: true, identityResolved: true };
  assert.deepEqual(promotable(base), { ok: true });
  assert.deepEqual(promotable({ ...base, contaminationSuspect: false }), { ok: true });
  assert.deepEqual(promotable({ ...base, contaminationSuspect: undefined }), { ok: true });
  // Each pre-H2 refusal still names its own reason, not the new one.
  assert.deepEqual(promotable({ ...base, slot: 'investigations' }), { ok: false, reason: 'slot_not_allowed' });
  assert.deepEqual(promotable({ ...base, inferred: true }), { ok: false, reason: 'inferred' });
  assert.deepEqual(promotable({ ...base, provenance: prov({ trust: 'patient_reported' }) }), { ok: false, reason: 'trust_not_promotable' });
  assert.deepEqual(promotable({ ...base, spanVerified: false, sourceText: 'nothing alike' }), { ok: false, reason: 'span_unverified' });
  assert.deepEqual(promotable({ ...base, identityResolved: false }), { ok: false, reason: 'identity_unresolved' });
});

test('§4.3 spine: a suspect discharge procedure with NO OT row folds NO procedure', () => {
  const suspect = {
    conceptRaw: 'LAPAROSCOPIC CHOLECYSTECTOMY', laterality: null, setting: 'unknown' as const,
    provenance: prov(), spanVerified: true, contaminationSuspect: true,
  };
  const out = stayToEncounter({
    encounterRef: 'IP-1472', date: '2026-08-01', identityResolved: true, procedures: [suspect],
  });
  assert.equal(out.encounter.procedures, undefined, 'a contaminated stay puts NO procedure on the spine');
  assert.deepEqual(out.refused, [{ slot: 'procedures', concept: 'LAPAROSCOPIC CHOLECYSTECTOMY', reason: 'contamination_suspect' }]);
  // The encounter itself is still emitted — "this stay is on the record and evidenced nothing
  // promotable" stays a truthful statement, exactly as it was before H2.
  assert.equal(out.encounter.kind, 'ipd');
});

test('§4.3 spine: the SAME stay with a clean OT row folds the OT procedure only', () => {
  const otFact = {
    conceptRaw: 'BILATERAL LAPAROSCOPIC INGUINAL HERNIOPLASTY', laterality: 'bilateral' as const,
    setting: 'ot' as const, spanVerified: true,
    provenance: prov({ sourceField: 'kx_clinical_template_ot_notes.surgery_name', extractionMethod: 'deterministic', trust: 'structured_db', confidence: 1 }),
  };
  const suspect = {
    conceptRaw: 'LAPAROSCOPIC CHOLECYSTECTOMY', laterality: null, setting: 'unknown' as const,
    provenance: prov(), spanVerified: true, contaminationSuspect: true,
  };
  const out = stayToEncounter({
    encounterRef: 'IP-1472', date: '2026-08-01', identityResolved: true,
    procedures: [otFact, suspect],       // §6.2 precedence order: OT first, discharge second
  });
  assert.equal(out.encounter.procedures?.length, 1);
  assert.equal(out.encounter.procedures?.[0].conceptRaw, 'BILATERAL LAPAROSCOPIC INGUINAL HERNIOPLASTY');
  assert.equal(out.encounter.procedures?.[0].setting, 'ot');
  assert.deepEqual(out.refused.map((r) => r.reason), ['contamination_suspect']);
});

test('H-A2: ipd-fold carries the taint from the stored fact into the gate input, and nothing else', () => {
  const fact = {
    conceptRaw: 'LAPAROSCOPIC CHOLECYSTECTOMY', laterality: null, setting: 'unknown' as const,
    provenance: prov(), spanVerified: true, contaminationSuspect: true,
  };
  const st = emptyClinicalState('doc_audit');
  st.surfaceExtras = { stayDoc: { docKind: 'discharge', sourceUid: 'doc-1' }, procedureFacts: [fact] };
  const input = stayEvidenceInputFrom(
    { encounterRef: 'IP-1472', date: '2026-08-01', uhids: [], memberUid: null, documents: [{ status: 'ok', state: st }] },
    true,
  );
  assert.equal(input.procedures?.length, 1);
  assert.equal(input.procedures?.[0].contaminationSuspect, true, 'the taint must survive the fold mapping');
  // ...and it is the ONLY thing H2 added to that mapping.
  assert.deepEqual(Object.keys(input.procedures![0]).sort(),
    ['conceptRaw', 'contaminationSuspect', 'laterality', 'provenance', 'setting', 'spanVerified']);
  assert.equal(stayToEncounter(input).encounter.procedures, undefined);
});

// ── H2 stamping (library write time) ──────────────────────────────────────────────────────

test('H2: the stamp reads back through the library door, and only off a discharge document', () => {
  const clean = emptyClinicalState('doc_audit');
  assert.equal(contaminationOf(clean), null, 'a state with no notice reads as no notice');
  clean.surfaceExtras = { stayDoc: { docKind: 'discharge', sourceUid: 'd' } };
  assert.equal(contaminationOf(clean), null, 'a pre-H2 stored row reads as no notice, never as an error');
  const notice = contaminationNotice(['INGUINAL HERNIOPLASTY'], 'LAPAROSCOPIC CHOLECYSTECTOMY');
  clean.surfaceExtras = { ...clean.surfaceExtras, contamination: notice! };
  assert.equal(contaminationOf(clean)?.dischargeProcedure, 'LAPAROSCOPIC CHOLECYSTECTOMY');
  // Junk in the passthrough reads as absence, not as a crash.
  clean.surfaceExtras = { contamination: { suspect: false } };
  assert.equal(contaminationOf(clean), null);
});

// ══ H2 source pins ═══════════════════════════════════════════════════════════════════════

test('H-D3: the guard is deterministic — no model, no engine version, no CVI', () => {
  const src = code('lib/stay-library/contamination.ts') + code('lib/stay-library/build.ts')
    + code('lib/stay-library/core.ts') + code('lib/member-state/ipd-evidence.ts');
  for (const banned of [
    'tracedChat', 'governedChat', 'normalizeWithLlm', 'analyzeCase', 'care_value_index',
    'careValueIndex', 'IPD_ENGINE_VERSION', 'IPD_STAY_ENGINE_VERSION', 'ipd-stay-audit/0',
    'ipd-discharge-audit/0',
  ]) {
    assert.ok(!src.includes(banned), `the H2 guard names ${banned}`);
  }
  // PURE: the rule module reaches nothing at all.
  const rule = code('lib/stay-library/contamination.ts');
  assert.ok(!/\bimport\b/.test(rule), 'the contamination rule must import nothing — it is a pure function');
});

test('H-D6: the taint rides in the passthrough — clinical-state/1.2 does not bump or fork', () => {
  const schema = read('lib/clinical-state/schema.ts');
  assert.ok(schema.includes("CLINICAL_STATE_VERSION = 'clinical-state/1.2'"), 'the schema version must not be bumped');
  // zProvenance stays `.strict()` and gains no contamination field: the taint is NOT on provenance.
  assert.ok(/zProvenance\s*=\s*z\.object\(\{[\s\S]*?\}\)\.strict\(\)/.test(schema), 'zProvenance must stay strict');
  assert.ok(!/contaminat/i.test(schema), 'lib/clinical-state must know nothing about H2');
  assert.equal(STAY_LIBRARY_VERSION, 'stay-library/1', 'the library version does not move either');
});

test('H-D3: the taint reaches no prompt — the stay picture is composed without it', () => {
  const material = code('lib/ipd-audit/stay-material.ts');
  assert.ok(!/contaminat/i.test(material),
    'the prompt composer must not read the taint: a finding is not what H2 produces');
  const run = code('lib/ipd-audit/run.ts');
  assert.ok(!/contaminat/i.test(run), 'the audit runner must not read the taint — CVI is untouched');
});

test('H2 touches lib/member-state ONLY in ipd-evidence.ts and the one permitted fold line (H-A2)', () => {
  const fold = code('lib/member-state/ipd-fold.ts');
  const lines = fold.split('\n').filter((l) => l.includes('contaminationSuspect'));
  assert.equal(lines.length, 1, 'H-A2 permits exactly one carrying LINE in ipd-fold.ts');
  assert.ok(fold.includes('contaminationSuspect: p.contaminationSuspect'), 'and it is a pass-through, nothing more');
  // No other file under lib/member-state/ knows about H2 at all.
  for (const f of ['assemble-core.ts', 'member-state.ts', 'aggregate-core.ts', 'present-core.ts',
    'normalize-core.ts', 'schema.ts', 'care-call-evidence.ts', 'present-augment.ts', 'vitals-read.ts']) {
    assert.ok(!/contaminat/i.test(read(`lib/member-state/${f}`)), `lib/member-state/${f} was touched by H2`);
  }
});
