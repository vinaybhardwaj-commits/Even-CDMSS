/**
 * lib/__tests__/stewardship-ask.test.ts — S1 of the stewardship MS agent
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A2 / A3 / A6; acceptance #18, #19).
 *
 *   node --test --import tsx lib/__tests__/stewardship-ask.test.ts
 *
 * The shared shell's own guarantees — the citation gate, the caps, the IST ceiling, the de-id fence,
 * the withheld discipline, the Opus pin — are tested once in case-ask-core.test.ts and are NOT
 * re-tested here; that file's boundary assertions are extended, never weakened. What this file pins
 * is the part S1 actually added: two new case types, the two thread keys A3 states verbatim, the
 * aggregate material those keys open, and the two refusals that keep a made-up case out of the
 * store.
 *
 * Several assertions read SOURCE. That is deliberate and is the house pattern for a property of
 * what a file NAMES rather than what it returns: "this room gates on the cookie" and "this material
 * builder has no write path" are true of the imports and the statements, and a behavioural test over
 * a mocked DB would pass on a file that had quietly grown either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCaseAskPrompt, caseAskVerdict, isCaseAskType,
  CASE_ASK_SUGGESTIONS, CASE_ASK_TYPES,
} from '../case-ask-core';
import { appendTurn, readThread } from '../case-ask/store';
import {
  deptCaseKey, deptIpdAskMaterial, deptOpdAskMaterial, isStewardshipCaseType,
  parseDeptCaseKey, physicianAskMaterial,
  DEPT_VOCABS, STEWARDSHIP_INFERRED_SQL, STEWARDSHIP_THREAD_ENGINE,
  type DeptIpdFacts, type DeptOpdFacts, type PhysicianFacts,
} from '../case-ask/stewardship-material';
import { ipdCanonParams, ipdCanonical90d, opdCanonParams } from '../stewardship-canonical';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ROUTE = 'app/api/admin/stewardship/ask/route.ts';
const MATERIAL = 'lib/case-ask/stewardship-material.ts';

// ── A3 — the thread keys, byte for byte (acceptance #18) ──────────────────────────────────

test('A3: the stewardship thread engine string is the memo\'s, verbatim', () => {
  assert.equal(STEWARDSHIP_THREAD_ENGINE, 'opd-0.81.x+ipd-0.2|90d');
});

test('A3 / acceptance #18: an OPD patch bump does not open a new physician thread', () => {
  // The defect this forbids: keying the thread on the live engine version, so that 0.81.21 → 0.81.22
  // silently abandons every MS adjudication. The key must name the FAMILY, and it must be a literal
  // — not a string built from an engine constant, which is the same defect one indirection away.
  assert.match(STEWARDSHIP_THREAD_ENGINE, /0\.81\.x/);
  assert.ok(!/0\.81\.\d+/.test(STEWARDSHIP_THREAD_ENGINE), 'the key must not name an exact OPD patch version');
  const src = code(MATERIAL);
  assert.match(src, /STEWARDSHIP_THREAD_ENGINE = 'opd-0\.81\.x\+ipd-0\.2\|90d'/,
    'the key must be a literal, not interpolated from an engine constant');
  assert.ok(!/OPD_ENGINE_VERSION\b/.test(src), 'the material builder must not read the live OPD engine version');

  // and two materials built from different numbers still key to the same thread
  const a = physicianAskMaterial(physician({ own: { ...ZERO_OPD, n_notes: 10, avg_nqi: 71 } }));
  const b = physicianAskMaterial(physician({ own: { ...ZERO_OPD, n_notes: 900, avg_nqi: 44 } }));
  assert.equal(a.engineVersion, STEWARDSHIP_THREAD_ENGINE);
  assert.equal(b.engineVersion, a.engineVersion);
});

test('A3: the department key is <vocab>:<label>, and it round-trips', () => {
  assert.deepEqual([...DEPT_VOCABS], ['opd_speciality', 'ipd_speciality']);
  assert.equal(deptCaseKey('opd_speciality', 'Internal Medicine'), 'opd_speciality:Internal Medicine');
  assert.equal(deptCaseKey('ipd_speciality', 'Orthopedics'), 'ipd_speciality:Orthopedics');
  assert.deepEqual(parseDeptCaseKey('opd_speciality:Internal Medicine'), { vocab: 'opd_speciality', label: 'Internal Medicine' });
  // A label containing a colon survives: the split is on the FIRST colon only.
  assert.deepEqual(parseDeptCaseKey('ipd_speciality:Surgery: General'), { vocab: 'ipd_speciality', label: 'Surgery: General' });
});

test('A3: a key with no vocabulary tag, an unknown tag, or an empty label is refused', () => {
  assert.equal(parseDeptCaseKey('Internal Medicine'), null);
  assert.equal(parseDeptCaseKey('speciality:Internal Medicine'), null);
  assert.equal(parseDeptCaseKey('opd_speciality:'), null);
  assert.equal(parseDeptCaseKey('opd_speciality:   '), null);
  assert.equal(parseDeptCaseKey(':Internal Medicine'), null);
  assert.equal(parseDeptCaseKey(''), null);
});

test('A3: the two vocabularies are two case keys — a shared label does not merge them', () => {
  // The OPD "General Medicine" and the inpatient "General Medicine" are different lists of strings
  // that happen to share a word. Two keys, two threads, no silent merge (D-identity / §4).
  assert.notEqual(deptCaseKey('opd_speciality', 'General Medicine'), deptCaseKey('ipd_speciality', 'General Medicine'));
});

// ── A2 — the union, and the two refusals (acceptance #19) ─────────────────────────────────

test('A2: the shell now serves four case types, and every keyed record covers all four', () => {
  assert.deepEqual([...CASE_ASK_TYPES], ['opd', 'ipd', 'physician', 'dept']);
  for (const t of CASE_ASK_TYPES) {
    assert.ok(CASE_ASK_SUGGESTIONS[t]?.length, `${t} has no suggestions`);
    // CASE_LABEL is module-private; the prompt is where its absence would show, so read it there.
    const p = buildCaseAskPrompt({ caseType: t, engineVersion: 'e', items: [], gaps: [] }, [], 'q');
    assert.doesNotMatch(p.system, /undefined/, `${t} has no CASE_LABEL entry`);
  }
});

test('acceptance #19: an unknown case type is not a case type', () => {
  assert.equal(isCaseAskType('physician'), true);
  assert.equal(isCaseAskType('dept'), true);
  assert.equal(isCaseAskType('sneaky'), false);
  assert.equal(isCaseAskType(''), false);
  assert.equal(isCaseAskType(null), false);
  assert.equal(isCaseAskType(7), false);
  // and the room serves only its own two, even though the shell would key a thread for the others
  assert.equal(isStewardshipCaseType('physician'), true);
  assert.equal(isStewardshipCaseType('opd'), false);
});

test('acceptance #19: the route refuses an unknown case type with a 400, before the loader', () => {
  const src = code(ROUTE);
  assert.ok(src.includes('isCaseAskType'), 'the route must check the case type as a VALUE');
  assert.ok(src.includes('isStewardshipCaseType'), 'the route must refuse another surface\'s case type');
  // The refusal is a 400 and it is reached before anything is served — checked INSIDE each handler,
  // not over the whole file: the imports name both serves at the top and would make a naive
  // whole-file ordering assertion pass for free.
  for (const handler of ['GET', 'POST'] as const) {
    const start = src.indexOf(`export async function ${handler}(`);
    assert.ok(start > -1, `no ${handler} handler`);
    const next = src.indexOf('export async function', start + 1);
    const body = src.slice(start, next > -1 ? next : undefined);
    const gate = body.indexOf('readCase(');
    const serve = body.indexOf('serveCaseAsk');
    assert.ok(gate > -1, `${handler} does not validate the case`);
    assert.ok(serve > -1 && gate < serve, `${handler} serves before it validates the case`);
  }
  assert.match(src, /error: c\.error \}, \{ status: 400 \}/);
});

test('acceptance #19: the STORE is the second refusal — a bad case type never becomes a row', async () => {
  // Behavioural, and it needs no database: badKey returns before any SQL is composed.
  const key = { caseType: 'sneaky' as never, caseKey: 'k', engineVersion: STEWARDSHIP_THREAD_ENGINE };
  assert.equal(await appendTurn({ ...key, role: 'user', content: 'hello' }), null);
  assert.deepEqual(await readThread(key), { turns: [], error: 'case key required' });
});

// ── the room's gate is the COOKIE, and only the cookie (D-audience) ───────────────────────

test('D-audience: the stewardship room gates on isAdminUnlocked, never on the fail-open admin gate', () => {
  const src = code(ROUTE);
  assert.ok(src.includes('isAdminUnlocked'), 'the room must use the fail-closed cookie gate');
  assert.ok(!/admin-gate|requireAdmin/.test(src),
    'requireAdmin fails open in dev when ADMIN_TOKEN is unset — a named-doctor ranking does not get that gate');
});

// ── the material: what an answer may cite, and what it must not claim ─────────────────────

const ZERO_OPD = {
  n_notes: 0, avg_nqi: 0, pct_ab: 0, avg_appr: 0, avg_presc: 0, avg_doc: 0,
  avg_complete: 0, pct_low: 0, sum_low: 0, sum_interactions: 0,
};

function physician(over: Partial<PhysicianFacts> = {}): PhysicianFacts {
  return {
    doctorName: 'Dr A Rao', speciality: 'Internal Medicine',
    own: { ...ZERO_OPD, n_notes: 214, avg_nqi: 68, pct_ab: 54, avg_appr: 71, avg_presc: 66, avg_doc: 74, avg_complete: 81, pct_low: 29, sum_low: 92, sum_interactions: 7 },
    peers: { dept: 'Internal Medicine', n_doctors: 12, n_notes: 1_804, avg_nqi: 72, pct_low: 24 },
    findings: [{ subject: 'Antibiotic without a documented indication', signal_type: 'low_value_care', n: 18 }],
    ...over,
  };
}

test('physician material: the split banner is the FIRST thing the model is told', () => {
  // A1 / D-identity. The room shows an OPD-only record; an answer that talked about "this
  // clinician's inpatients" would be describing stays nobody has attributed to them.
  const m = physicianAskMaterial(physician());
  assert.match(m.gaps[0], /not the same physician key on this spine/);
  assert.match(m.gaps[0], /no inpatient stay is attributed here/);
  const p = buildCaseAskPrompt(m, [], 'how are their inpatients doing?');
  assert.match(p.user, /not the same physician key on this spine/);
});

test('physician material: the ids code minted are exactly the ids the gate accepts', () => {
  const m = physicianAskMaterial(physician());
  const ids = m.items.map((i) => i.id);
  assert.ok(ids.includes('C1') && ids.includes('C2'), 'the stored numbers are citable');
  assert.ok(ids.includes('F1'), 'a recurring finding is citable');
  assert.ok(ids.includes('P1'), 'the department peer group is citable');
  assert.equal(caseAskVerdict({ answer: 'Their mean is below the department [C2, P1].', answerable: true }, ids).ok, true);
  assert.equal(caseAskVerdict({ answer: 'Because of [F9].', answerable: true }, ids).ok, false);
});

test('physician material: no audited notes is an ABSENCE, never a clean record', () => {
  const m = physicianAskMaterial(physician({ own: { ...ZERO_OPD }, findings: [], peers: null }));
  assert.ok(m.gaps.some((g) => /absence of audited work, not an absence of findings and not clean work/.test(g)));
  // and no score item is invented out of a zero
  assert.deepEqual(m.items.filter((i) => i.label !== 'Audited volume').map((i) => i.label), []);
});

test('physician material: an aggregate says it is an aggregate', () => {
  const m = physicianAskMaterial(physician());
  assert.match(String(m.readingNote), /AGGREGATE of many audited artefacts, not a single case/);
  assert.match(String(m.readingNote), /A rate is not a verdict on any individual encounter/);
  const p = buildCaseAskPrompt(m, [], 'is this doctor unsafe?');
  assert.ok(p.user.includes(String(m.readingNote)), 'the sentence that governs how a rate is read must reach the model');
});

test('material: an identifier pasted into a stored finding subject does not reach the model', () => {
  // The per-case builders read ONE de-identified audit row. An aggregate crosses many patients, so
  // the fence runs again on the way in.
  const m = physicianAskMaterial(physician({
    findings: [{ subject: 'Repeat imaging for UHID 883421', signal_type: 'longitudinal_repeat_test', n: 4 }],
  }));
  const f1 = m.items.find((i) => i.id === 'F1');
  assert.equal(f1?.label, 'Repeat imaging for [id]');
  assert.doesNotMatch(buildCaseAskPrompt(m, [], 'why?').user, /883421/);
});

const deptOpd: DeptOpdFacts = {
  label: 'Internal Medicine',
  agg: { ...ZERO_OPD, n_notes: 1_804, avg_nqi: 72, pct_ab: 61, avg_appr: 74, avg_presc: 70, avg_doc: 77, avg_complete: 83, pct_low: 24, sum_low: 612, sum_interactions: 41 },
  clinicians: [{ doctor_name: 'Dr A Rao', n_notes: 214, avg_nqi: 68, pct_low: 29 }],
  findings: [{ subject: 'Antibiotic without a documented indication', signal_type: 'low_value_care', n: 96 }],
};

test('dept material (OPD vocabulary): the two vocabularies are never presented as one', () => {
  const m = deptOpdAskMaterial(deptOpd);
  assert.equal(m.caseType, 'dept');
  assert.ok(m.gaps.some((g) => /OPD speciality vocabulary; the inpatient speciality vocabulary is a different list/.test(g)));
  assert.ok(m.items.some((i) => i.id === 'P1' && i.label === 'Dr A Rao'), 'a named clinician in the department is citable');
});

const deptIpd: DeptIpdFacts = {
  label: 'Orthopedics', n_stays: 130, avg_cvi: 66, pct_ab: 48, avg_safety: 71, avg_complete: 79,
  findings: [{ subject: 'Operative note omits the implant used', domain: 'documentation', n: 9 }],
};

test('dept material (inpatient vocabulary): A6\'s exclusion is stated, not silently applied', () => {
  const m = deptIpdAskMaterial(deptIpd);
  assert.ok(m.gaps.some((g) => /stay-level reading of the same stays is drill context .* not in this aggregate/.test(g)),
    'the model must be told which IPD reading these numbers came from');
  assert.ok(m.gaps.some((g) => /inpatient speciality vocabulary; the OPD speciality vocabulary is a different list/.test(g)));
  // and no person is attributed on the inpatient side, because no physician key resolves one yet
  assert.ok(m.gaps.some((g) => /these numbers belong to the department and to no named person/.test(g)));
  assert.equal(m.items.filter((i) => i.id.startsWith('P')).length, 0);
  assert.match(String(m.items.find((i) => i.label === 'Care-Value Index')?.text), /about one band of noise/);
});

// ── A6 — the IPD board recipe, as A6 states it ────────────────────────────────────────────

test('A6: one row per stay, the discharge engine only, latest audited_at', () => {
  const q = ipdCanonical90d('speciality, care_value_index');
  assert.match(q, /SELECT DISTINCT ON \(ip_uid\) ip_uid/);
  assert.match(q, /engine_version = \$1/);
  assert.match(q, /ORDER BY ip_uid, audited_at DESC/);
  assert.match(q, /ip_uid IS NOT NULL/);
  assert.equal(ipdCanonParams()[0], 'ipd-discharge-audit/0.2');
  // the stay auditor's rows are drill context and can never enter this aggregate
  assert.ok(!q.includes('ipd-stay-audit'), 'the stay engine must not be named in the board recipe');
  assert.deepEqual(opdCanonParams()[1], '90');
});

// ── §3.3 — the room reads; it does not write ──────────────────────────────────────────────

test('§3.3: the stewardship material builder has no write path at all', () => {
  const src = code(MATERIAL);
  assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE)\b/i.test(src),
    'the material builder writes nothing — it is a reader');
  // S4 owns the overlay and it does not exist yet; nothing on this path may pre-empt it.
  assert.ok(!/physician_standing/i.test(src), 'the standing overlay is S4 and is not written from S1');
  assert.ok(!/clinical_review/i.test(src), 'the readmission overlay is not this room\'s');
  for (const q of Object.values(STEWARDSHIP_INFERRED_SQL)) {
    assert.match(q, /^\s*SELECT\b/i, `every inferred query is a SELECT: ${q.trim().slice(0, 60)}`);
  }
});

test('§3.3: the inferred SQL never reads a patient-identifying column', () => {
  for (const [name, q] of Object.entries(STEWARDSHIP_INFERRED_SQL)) {
    for (const forbidden of ['individual_uid', 'member_id', 'uhid', 'document_id', 'patient']) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`, 'i').test(q), `${name} reads ${forbidden}`);
    }
  }
});
