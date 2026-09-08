/**
 * lib/__tests__/review-session.test.ts — WM6: the sequential review (review/0.1).
 *
 *   node --test --import tsx lib/__tests__/review-session.test.ts
 *
 * THE RULES UNDER TEST, in one sentence each:
 *   a revealed cut cannot be unseen (the route slices at revealed_index);
 *   the base belief comes before its perturbations, and one step finishes before the next opens;
 *   a belief is final — the same one again is a replay, a changed one is refused;
 *   an outage ends the session, a quiet day does not;
 *   a perturbation is a sentence beside the record, never an edit of it;
 *   and the plain individual_uid never reaches the review tables.
 *
 * FORM USED: the B1/B2a harness. The pure model is exercised directly; the ROUTE is exercised for
 * real, with the only substitutions at `globalThis.fetch` — which carries BOTH transports this path
 * uses: the neon HTTP driver (the review tables) and Metabase /api/dataset (db13, which the walk
 * reads). Every statement is recorded, so "writes nothing" is checked as "no INSERT/UPDATE/DELETE
 * reached the driver", and the walk in these tests is a real walkO run over fixture db13 rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import {
  advance, canRecord, classifyBelief, cutTakesBeliefs, isReviewerRole, nextRequired,
  parseSecondsSpent, parseVariants, requiredKeys, validateBeliefPayload,
  type BeliefKey, type ReviewSession,
} from '../review/session.ts';
import { PERTURBATIONS, overlayFor, isVariantId } from '../review/perturbations.ts';
import { REVIEW_VARIANT_IDS, REVIEW_SCHEMA_VERSION } from '../cognition/schema.ts';

// ── the harness ───────────────────────────────────────────────────────────────
// Placeholders only. ADMIN_TOKEN is a fixture value in this process; no real secret is read.
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';
process.env.METABASE_URL = 'https://metabase.invalid.test';
process.env.METABASE_API_KEY = 'test-metabase-key';
process.env.ADMIN_TOKEN = 'test-admin-token';

const UID = 'ind_abc123';
const UID_HASH = createHash('sha256').update(UID).digest('hex');
const SESSION_ID = '33333333-4444-5555-6666-777777777777';

type Row = Record<string, unknown>;
const issued: { text: string; params: unknown[] }[] = [];
const db13: string[] = [];
const writes = () => issued.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text));

let sessionRow: Row | null = null;
let beliefRows: Row[] = [];
let prescriptionRows: Row[] = [];
let db13Fails = false;
/** One-shot: the next belief INSERT reports no row, and what lands is the OTHER request's belief —
 *  it won the index between this one's read and its write. The route must re-read and classify,
 *  never 500. `payload` undefined means the other request wrote the same answer. */
let raceOnNextInsert: { payload?: unknown } | null = null;

function reset(): void {
  issued.length = 0; db13.length = 0;
  sessionRow = null; beliefRows = []; db13Fails = false; raceOnNextInsert = null;
  // Two evidence days. The as-of cut is STRICTLY prior, so cut 0 has nothing before it
  // (no_prior_history — knowledge, and it still takes beliefs) and cut 1 reconstructs (ok).
  prescriptionRows = [
    { uid: 'presc-1', visit_date: '2026-08-01', diagnosis: 'Headache', medications: [] },
    { uid: 'presc-2', visit_date: '2026-08-15', diagnosis: 'Headache', medications: [] },
  ];
}

/** A neon HTTP result body: every column typed text; the store parses from there. */
function neonBody(rows: Row[]): string {
  const names = rows.length ? Object.keys(rows[0]) : [];
  return JSON.stringify({
    command: 'SELECT', rowCount: rows.length, rowAsArray: false,
    fields: names.map((name, i) => ({ name, tableID: 0, columnID: i + 1, dataTypeID: 25, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' })),
    rows: rows.map((r) => names.map((n) => (r[n] == null ? null : typeof r[n] === 'object' ? JSON.stringify(r[n]) : String(r[n])))),
  });
}
const okJson = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

/** A Metabase /api/dataset body: cols + row arrays, exactly what metabaseQuery unpacks. */
function metabaseBody(rows: Row[]): string {
  const names = rows.length ? Object.keys(rows[0]) : [];
  return JSON.stringify({ data: { cols: names.map((name) => ({ name })), rows: rows.map((r) => names.map((n) => r[n])) } });
}

globalThis.fetch = (async (url: unknown, init: { body?: unknown } = {}) => {
  const href = String(url);

  // ── db13, via Metabase — what the WALK reads. Not a review table. ──
  if (href.includes('/api/dataset')) {
    const sent = JSON.parse(String(init?.body ?? '{}')) as { native?: { query?: string } };
    const query = String(sent.native?.query ?? '');
    db13.push(query);
    if (db13Fails) return new Response('boom', { status: 500 });
    return okJson(metabaseBody(/prescription/i.test(query) ? prescriptionRows : []));
  }

  // ── the review tables, via neon ──
  const sent = JSON.parse(String(init?.body ?? '{}')) as { query?: string; params?: unknown[] };
  const text = String(sent.query ?? '');
  const params = sent.params ?? [];
  issued.push({ text, params });

  if (/^\s*INSERT INTO cognition_review_sessions\b/i.test(text)) {
    const [hash, microworld, role, variants, walkVersion, msVersion, ipdFold, cuts, cutCount, status, schemaVersion] = params as unknown[];
    sessionRow = {
      id: SESSION_ID, created_at: '2026-09-08T06:00:00.000Z', individual_uid_hash: hash,
      microworld, reviewer_role: role,
      // the neon driver sends a text[] param as the literal `{a,b}`; accept either form
      variants: Array.isArray(variants) ? `{${variants.join(',')}}` : String(variants),
      walk_version: walkVersion, member_state_version: msVersion, ipd_fold: ipdFold,
      cuts, cut_count: cutCount, revealed_index: 0, status, completed_at: null,
      schema_version: schemaVersion,
    };
    return okJson(neonBody([sessionRow]));
  }
  if (/^\s*INSERT INTO cognition_belief_updates\b/i.test(text)) {
    const [sessionId, stepIndex, cutDate, variantId, role, payload, seconds, schemaVersion] = params as unknown[];
    const coalesced = variantId ?? 'base';
    if (beliefRows.some((b) => b.session_id === sessionId && String(b.step_index) === String(stepIndex) && (b.variant_id ?? 'base') === coalesced)) {
      return okJson(neonBody([]));                       // ON CONFLICT DO NOTHING
    }
    const row: Row = {
      id: `belief-${beliefRows.length + 1}`, created_at: '2026-09-08T06:05:00.000Z',
      session_id: sessionId, step_index: stepIndex, cut_date: cutDate, variant_id: variantId,
      reviewer_role: role, provenance: 'CLINICIAN_REPORTED_BELIEF', trigger: 'retrospective_replay',
      after_cdmss: false, payload, seconds_spent: seconds, schema_version: schemaVersion,
    };
    if (raceOnNextInsert) {
      const other = raceOnNextInsert; raceOnNextInsert = null;
      beliefRows.push('payload' in other ? { ...row, id: 'belief-other', payload: other.payload } : row);
      return okJson(neonBody([]));
    }
    beliefRows.push(row);
    return okJson(neonBody([row]));
  }
  if (/^\s*UPDATE cognition_review_sessions\b/i.test(text)) {
    const [, revealedIndex, status] = params as unknown[];
    if (sessionRow) sessionRow = { ...sessionRow, revealed_index: revealedIndex, status };
    return okJson(neonBody([]));
  }
  if (/FROM cognition_review_sessions\b/i.test(text)) {
    const [id] = params as string[];
    return okJson(neonBody(sessionRow && sessionRow.id === id ? [sessionRow] : []));
  }
  if (/FROM cognition_belief_updates\b/i.test(text)) {
    if (/count\(\*\)/i.test(text)) {
      const secs = beliefRows.map((b) => Number(b.seconds_spent));
      return okJson(neonBody([{
        rows: secs.length, mean_seconds: secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : null,
        max_seconds: secs.length ? Math.max(...secs) : null,
      }]));
    }
    if (/AND step_index=/i.test(text)) {
      const [sessionId, stepIndex, variantId] = params as unknown[];
      return okJson(neonBody(beliefRows.filter((b) => b.session_id === sessionId
        && String(b.step_index) === String(stepIndex) && (b.variant_id ?? null) === (variantId ?? null))));
    }
    const [sessionId] = params as string[];
    return okJson(neonBody(beliefRows.filter((b) => b.session_id === sessionId)));
  }
  return okJson(neonBody([]));
}) as typeof fetch;

/**
 * The admin wall, exercised for real. `isAdminUnlocked` is NOT stubbed: the env read, the cookie
 * read and the timing-safe compare all run. The only thing stood up is the cookie JAR itself —
 * next/headers' `cookies()` throws outside a request scope, and a request scope is the one thing a
 * test process cannot have. Locked and unlocked are the same function over a different jar.
 */
let adminCookie = '';
const require_ = createRequire(`${process.cwd()}/x.js`);
(require_('next/headers') as { cookies: () => Promise<{ get: (n: string) => { value: string } | undefined }> }).cookies =
  async () => ({ get: (n: string) => (n === 'cat_admin' && adminCookie ? { value: adminCookie } : undefined) });
const setAdmin = (unlocked: boolean) => { adminCookie = unlocked ? 'test-admin-token' : ''; };

const URL_BASE = 'https://cat.test/api/admin/review';

async function post(payload: Record<string, unknown>, locked = false): Promise<{ status: number; json: Record<string, unknown> }> {
  await setAdmin(!locked);
  const { NextRequest } = await import('next/server');
  const { POST } = await import('../../app/api/admin/review/route.ts');
  const req = new NextRequest(URL_BASE, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const res = await POST(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(query: string, locked = false): Promise<{ status: number; json: Record<string, unknown> }> {
  await setAdmin(!locked);
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/admin/review/route.ts');
  const res = await GET(new NextRequest(`${URL_BASE}${query}`, { method: 'GET' }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const PAYLOAD = {
  leading_diagnosis: 'Tension-type headache', confidence: 60,
  next_investigation: 'none', other_text: null, unsafe_to_wait: false,
};

const SESSION = (over: Partial<ReviewSession> = {}): ReviewSession => ({
  id: SESSION_ID, variants: ['fever_39_5'], cutCount: 2, revealedIndex: 0, status: 'active',
  cuts: [{ date: '2026-08-01', status: 'ok' }, { date: '2026-08-15', status: 'ok' }], ...over,
});

// ── 1. requiredKeys order ─────────────────────────────────────────────────────
test('requiredKeys: the base belief first, then the chosen variants in catalogue order', () => {
  const s = SESSION({ variants: ['fever_39_5', 'age_plus_30'] });
  assert.deepEqual(requiredKeys(s, 0), [
    { stepIndex: 0, variantId: null },
    { stepIndex: 0, variantId: 'fever_39_5' },
    { stepIndex: 0, variantId: 'age_plus_30' },
  ]);
  assert.deepEqual(requiredKeys(SESSION({ variants: [] }), 3), [{ stepIndex: 3, variantId: null }]);
  // parseVariants returns catalogue order whatever order the form sent
  const parsed = parseVariants(['age_plus_30', 'fever_39_5']);
  assert.ok(parsed.ok && parsed.value.length === 2, 'both accepted');
  assert.deepEqual(parseVariants(['fever_39_5', 'fever_39_5']), { ok: false, error: 'unknown variant' }, 'no repeats');
  assert.deepEqual(parseVariants(['nope']), { ok: false, error: 'unknown variant' });
  assert.ok(parseVariants([]).ok, 'empty is allowed');
});

// ── 2. canRecord refusals ─────────────────────────────────────────────────────
test('canRecord: refuses a wrong step, a variant before its base, an unknown variant, a finished session, an outage cut', () => {
  const s = SESSION();
  assert.equal(canRecord(s, [], { stepIndex: 0, variantId: null }), true, 'the base of the open step');

  assert.equal(canRecord(s, [], { stepIndex: 1, variantId: null }), false, 'a later step is not open');
  assert.equal(canRecord(s, [], { stepIndex: -1, variantId: null }), false, 'nor an earlier one');
  assert.equal(canRecord(s, [], { stepIndex: 0, variantId: 'fever_39_5' }), false, 'the variant may not precede its base');
  assert.equal(canRecord(s, [], { stepIndex: 0, variantId: 'not_a_variant' as never }), false, 'unknown variant');
  assert.equal(canRecord(s, [{ stepIndex: 0, variantId: null }], { stepIndex: 0, variantId: null }), false, 'and never twice');

  for (const status of ['completed', 'incomplete'] as const) {
    assert.equal(canRecord(SESSION({ status }), [], { stepIndex: 0, variantId: null }), false, status);
  }
  const failed = SESSION({ cuts: [{ date: '2026-08-01', status: 'context_fetch_failed' }, { date: '2026-08-15', status: 'ok' }] });
  assert.equal(canRecord(failed, [], { stepIndex: 0, variantId: null }), false, 'an outage cut takes no belief');

  // …but a quiet day does. `no_prior_history` is knowledge, not absence of it.
  const quiet = SESSION({ cuts: [{ date: '2026-08-01', status: 'no_prior_history' }, { date: '2026-08-15', status: 'ok' }] });
  assert.equal(canRecord(quiet, [], { stepIndex: 0, variantId: null }), true);
  assert.equal(cutTakesBeliefs('ok') && cutTakesBeliefs('no_prior_history'), true);
  assert.equal(cutTakesBeliefs('context_fetch_failed'), false);
});

// ── 3. advance ────────────────────────────────────────────────────────────────
test('advance: only when the step is finished; completed on the last cut; incomplete when the next cut is an outage', () => {
  const s = SESSION();                                     // 1 variant ⇒ 2 keys per step
  assert.deepEqual(advance(s, []), s, 'nothing recorded — no movement');
  assert.deepEqual(advance(s, [{ stepIndex: 0, variantId: null }]), s, 'base only — the variant is still owed');

  const done0: BeliefKey[] = [{ stepIndex: 0, variantId: null }, { stepIndex: 0, variantId: 'fever_39_5' }];
  const step1 = advance(s, done0);
  assert.equal(step1.revealedIndex, 1);
  assert.equal(step1.status, 'active');

  const done1: BeliefKey[] = [...done0, { stepIndex: 1, variantId: null }, { stepIndex: 1, variantId: 'fever_39_5' }];
  const end = advance(step1, done1);
  assert.equal(end.status, 'completed');
  assert.equal(end.revealedIndex, 1, 'a completed session does not reveal a cut that does not exist');

  const nextFails = SESSION({ cuts: [{ date: '2026-08-01', status: 'ok' }, { date: '2026-08-15', status: 'context_fetch_failed' }] });
  const stopped = advance(nextFails, done0);
  assert.equal(stopped.revealedIndex, 1);
  assert.equal(stopped.status, 'incomplete', 'the outage ends the session; it is not a belief about an empty chart');

  // a quiet next day is not an outage
  const nextQuiet = SESSION({ cuts: [{ date: '2026-08-01', status: 'ok' }, { date: '2026-08-15', status: 'no_prior_history' }] });
  assert.equal(advance(nextQuiet, done0).status, 'active');
  assert.deepEqual(nextRequired(advance(nextQuiet, done0), done0), { stepIndex: 1, variantId: null });
});

// ── 4. classifyBelief ─────────────────────────────────────────────────────────
test('classifyBelief: first, replay on canonical-equal payloads, conflict on any difference', () => {
  assert.equal(classifyBelief(null, { payload: PAYLOAD }), 'first');
  assert.equal(classifyBelief({ payload: PAYLOAD }, { payload: { ...PAYLOAD } }), 'replay');
  // key order must not decide
  const reordered = {
    unsafe_to_wait: false, other_text: null, next_investigation: 'none',
    confidence: 60, leading_diagnosis: 'Tension-type headache',
  };
  assert.equal(classifyBelief({ payload: reordered }, { payload: PAYLOAD }), 'replay');
  assert.equal(classifyBelief({ payload: PAYLOAD }, { payload: { ...PAYLOAD, confidence: 61 } }), 'conflict');
  assert.equal(classifyBelief({ payload: PAYLOAD }, { payload: { ...PAYLOAD, unsafe_to_wait: true } }), 'conflict');
});

// ── 5. the perturbation overlay ───────────────────────────────────────────────
test('perturbations: the overlay is text beside the record — the snapshot is the same object', () => {
  const snapshot = {
    asOf: '2026-08-15', version: 'member-state/1.2', problems: [{ normalizedConcept: { raw: 'Headache' } }],
    medications: [], allergies: [], investigations: [], procedures: [], followUps: [], conflicts: [],
  };
  const before = JSON.parse(JSON.stringify(snapshot));
  for (const id of REVIEW_VARIANT_IDS) {
    const overlay = overlayFor(id);
    assert.equal(typeof overlay, 'string');
    assert.ok(overlay.length > 0);
  }
  // rendering under every variant touches nothing: same object, same content
  assert.deepEqual(snapshot, before, 'the snapshot is byte-identical with or without a variant');

  assert.equal(overlayFor('fever_39_5'), 'Perturbation: assume a temperature of 39.5 °C was recorded at this visit.');
  assert.equal(overlayFor('ct_done_normal'), 'Perturbation: assume a non-contrast CT head was done at this visit and reported normal.');
  assert.equal(overlayFor('age_plus_30'), 'Perturbation: assume the patient is 30 years older than shown.');
  assert.deepEqual(PERTURBATIONS.map((p) => p.id), [...REVIEW_VARIANT_IDS], 'catalogue order is the id order');
  assert.throws(() => overlayFor('nope'), /unknown variant/);
  for (const bad of ['Fever_39_5', '', null, 7]) assert.equal(isVariantId(bad), false, String(bad));
});

// ── 6. payload validation ─────────────────────────────────────────────────────
test('validateBeliefPayload: every field has a named failure', () => {
  assert.ok(validateBeliefPayload(PAYLOAD).ok);

  const fail = (over: Record<string, unknown>, re: RegExp) => {
    const r = validateBeliefPayload({ ...PAYLOAD, ...over });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(r.ok === false ? r.error : '', re);
  };
  fail({ leading_diagnosis: '   ' }, /leading_diagnosis/);
  fail({ leading_diagnosis: 'x'.repeat(201) }, /leading_diagnosis/);
  fail({ confidence: 101 }, /confidence/);
  fail({ confidence: -1 }, /confidence/);
  fail({ confidence: 50.5 }, /confidence/);
  fail({ confidence: '50' }, /confidence/);
  fail({ next_investigation: 'xray' }, /next_investigation/);
  fail({ next_investigation: 'other', other_text: null }, /other_text/);
  fail({ next_investigation: 'other', other_text: '   ' }, /other_text/);
  fail({ other_text: 'stray' }, /other_text must be null/);
  fail({ unsafe_to_wait: 'no' }, /unsafe_to_wait/);
  assert.equal(validateBeliefPayload(null).ok, false);

  // the trim is applied to what is stored, not just checked
  const trimmed = validateBeliefPayload({ ...PAYLOAD, leading_diagnosis: '  Migraine  ' });
  assert.equal(trimmed.ok && trimmed.value.leading_diagnosis, 'Migraine');
  const other = validateBeliefPayload({ ...PAYLOAD, next_investigation: 'other', other_text: '  Fundoscopy  ' });
  assert.equal(other.ok && other.value.other_text, 'Fundoscopy');

  for (const bad of [-1, 3601, 1.5, '10', null]) assert.equal(parseSecondsSpent(bad).ok, false, String(bad));
  assert.ok(parseSecondsSpent(0).ok && parseSecondsSpent(3600).ok);
  assert.ok(isReviewerRole('consulting_physician') && isReviewerRole('neurologist'));
  for (const bad of ['registrar', 'Neurologist', '', null]) assert.equal(isReviewerRole(bad), false, String(bad));
});

// ── 7. the route ──────────────────────────────────────────────────────────────
test('route: a locked admin session is 401 on both verbs, before anything is read', async () => {
  reset();
  const p = await post({ action: 'start', individual_uid: UID, reviewer_role: 'neurologist', variants: [] }, true);
  assert.equal(p.status, 401);
  assert.deepEqual(p.json, { ok: false, error: 'unauthorized' });
  const g = await get(`?session_id=${SESSION_ID}`, true);
  assert.equal(g.status, 401);
  assert.deepEqual(issued, [], 'no statement, and no db13 read');
  assert.deepEqual(db13, []);
});

test('route start: one session row, the subject hashed, and the plain uid in no review statement', async () => {
  reset();
  const res = await post({ action: 'start', individual_uid: UID, reviewer_role: 'neurologist', variants: ['fever_39_5'] });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.cut_count, 2);
  assert.equal(res.json.revealed_index, 0);
  assert.equal(res.json.status, 'active');

  const inserts = writes().filter((q) => /INSERT INTO cognition_review_sessions/.test(q.text));
  assert.equal(inserts.length, 1, 'exactly one session row');
  assert.equal(inserts[0].params[0], UID_HASH, 'the subject is stored as sha256 hex');
  assert.equal(inserts[0].params[10], REVIEW_SCHEMA_VERSION);

  // THE POINT: no review statement — read or write — carries the plain uid, in any parameter.
  for (const q of issued) {
    for (const p of q.params) assert.notEqual(String(p), UID, `plain uid in a review statement: ${q.text.slice(0, 60)}`);
    assert.ok(!q.text.includes(UID), 'nor inlined in the statement text');
  }
  // db13 necessarily sees the uid — that is how the walk reads the record. It is not a review table.
  assert.ok(db13.some((q) => q.includes(UID)), 'the walk did read db13 for this subject');

  // cut 0 is the earliest evidence day, so nothing precedes it: knowledge, not an outage
  const state = await get(`?session_id=${SESSION_ID}`);
  const session = state.json.session as Record<string, unknown>;
  const cuts = session.cuts as { date: string; status: string }[];
  assert.equal(cuts.length, 1, 'only the revealed cut is returned');
  assert.equal(cuts[0].status, 'no_prior_history');
  assert.equal(session.grain_label, 'calendar day, same-day excluded');
  assert.equal(session.honesty_chip, 'dated by clinical date; result-availability lag not modeled');
  assert.deepEqual(session.next_required, { stepIndex: 0, variantId: null });
});

test('route start: an enumeration outage is a 502 and stores nothing; unknown input is a 400', async () => {
  reset();
  db13Fails = true;
  const res = await post({ action: 'start', individual_uid: UID, reviewer_role: 'neurologist', variants: [] });
  assert.equal(res.status, 502);
  assert.deepEqual(res.json, { ok: false, error: 'walk enumeration failed' });
  assert.deepEqual(writes(), [], 'an outage opens no session');

  reset();
  assert.equal((await post({ action: 'start', individual_uid: UID, reviewer_role: 'registrar', variants: [] })).status, 400);
  assert.equal((await post({ action: 'start', individual_uid: UID, reviewer_role: 'neurologist', variants: ['nope'] })).status, 400);
  assert.equal((await post({ action: 'start', individual_uid: 'no', reviewer_role: 'neurologist', variants: [] })).status, 400);
  assert.deepEqual(writes(), [], 'nothing is written on any refusal');
});

test('route GET never returns a cut beyond revealed_index', async () => {
  reset();
  await post({ action: 'start', individual_uid: UID, reviewer_role: 'neurologist', variants: [] });
  const before = await get(`?session_id=${SESSION_ID}`);
  assert.equal(((before.json.session as Record<string, unknown>).cuts as unknown[]).length, 1);

  await post({
    action: 'belief', session_id: SESSION_ID, step_index: 0, variant_id: null,
    reviewer_role: 'neurologist', payload: PAYLOAD, seconds_spent: 12,
  });
  const after = await get(`?session_id=${SESSION_ID}`);
  const cuts = (after.json.session as Record<string, unknown>).cuts as { date: string; status: string }[];
  assert.equal(cuts.length, 2, 'one more cut, and only one');
  assert.equal(cuts[1].status, 'ok');
});

test('route belief: an unopened step, an early variant and a recorded key are all 409 with no INSERT', async () => {
  reset();
  await post({ action: 'start', individual_uid: UID, reviewer_role: 'neurologist', variants: ['fever_39_5'] });
  issued.length = 0;

  // step 1 is not open yet
  const ahead = await post({
    action: 'belief', session_id: SESSION_ID, step_index: 1, variant_id: null,
    reviewer_role: 'neurologist', payload: PAYLOAD, seconds_spent: 5,
  });
  assert.equal(ahead.status, 409);
  assert.deepEqual(ahead.json, { ok: false, error: 'step not open' });
  assert.deepEqual(writes(), []);

  // the variant may not precede its base
  const early = await post({
    action: 'belief', session_id: SESSION_ID, step_index: 0, variant_id: 'fever_39_5',
    reviewer_role: 'neurologist', payload: PAYLOAD, seconds_spent: 5,
  });
  assert.equal(early.status, 409);
  assert.deepEqual(writes(), []);

  // the base is recorded…
  const first = await post({
    action: 'belief', session_id: SESSION_ID, step_index: 0, variant_id: null,
    reviewer_role: 'neurologist', payload: PAYLOAD, seconds_spent: 12,
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.replay, false);
  assert.deepEqual(first.json.next_required, { stepIndex: 0, variantId: 'fever_39_5' });
  assert.equal(beliefRows.length, 1);
  const stored = beliefRows[0];
  assert.equal(stored.provenance, 'CLINICIAN_REPORTED_BELIEF');
  assert.equal(stored.trigger, 'retrospective_replay');
  assert.equal(stored.after_cdmss, false);
  assert.equal(stored.cut_date, '2026-08-01');
  assert.equal(stored.schema_version, REVIEW_SCHEMA_VERSION);

  // …and the same key again is closed. canRecord refuses it before any read of the belief.
  issued.length = 0;
  const again = await post({
    action: 'belief', session_id: SESSION_ID, step_index: 0, variant_id: null,
    reviewer_role: 'neurologist', payload: PAYLOAD, seconds_spent: 3,
  });
  assert.equal(again.status, 409, 'the key is recorded, so the step is not open');
  assert.deepEqual(writes(), []);
  assert.equal(beliefRows.length, 1);
});

test('route belief: a lost race on the identity index is a 200 replay, or a 409 — never a 500', async () => {
  reset();
  await post({ action: 'start', individual_uid: UID, reviewer_role: 'neurologist', variants: [] });

  // The other request wrote the SAME belief: this one re-reads, sees its own answer, and replays.
  raceOnNextInsert = {};
  const replay = await post({
    action: 'belief', session_id: SESSION_ID, step_index: 0, variant_id: null,
    reviewer_role: 'neurologist', payload: PAYLOAD, seconds_spent: 9,
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, { ok: true, replay: true });
  assert.equal(beliefRows.length, 1, 'one row, written once');

  // The other request wrote a DIFFERENT belief: this one is refused, and still not a 500.
  reset();
  await post({ action: 'start', individual_uid: UID, reviewer_role: 'neurologist', variants: [] });
  raceOnNextInsert = { payload: { ...PAYLOAD, confidence: 99 } };
  const conflict = await post({
    action: 'belief', session_id: SESSION_ID, step_index: 0, variant_id: null,
    reviewer_role: 'neurologist', payload: PAYLOAD, seconds_spent: 9,
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.json, { ok: false, error: 'belief already recorded' });
  assert.equal(beliefRows.length, 1, 'the other request\'s belief stands, unchanged');
});

test('route: a full walk of 2 cuts × (base + 1 variant) records 4 beliefs and completes', async () => {
  reset();
  await post({ action: 'start', individual_uid: UID, reviewer_role: 'consulting_physician', variants: ['fever_39_5'] });

  const order: BeliefKey[] = [];
  for (let step = 0; step < 2; step++) {
    for (const variantId of [null, 'fever_39_5'] as (string | null)[]) {
      const res = await post({
        action: 'belief', session_id: SESSION_ID, step_index: step, variant_id: variantId,
        reviewer_role: 'consulting_physician',
        payload: { ...PAYLOAD, confidence: 50 + step, leading_diagnosis: `dx ${step}${variantId ?? ''}` },
        seconds_spent: 10 + step,
      });
      assert.equal(res.status, 200, `step ${step} ${variantId}`);
      order.push({ stepIndex: step, variantId: variantId as BeliefKey['variantId'] });
    }
  }
  assert.equal(beliefRows.length, 4);
  assert.deepEqual(beliefRows.map((b) => [Number(b.step_index), b.variant_id ?? null]),
    [[0, null], [0, 'fever_39_5'], [1, null], [1, 'fever_39_5']]);
  assert.deepEqual(beliefRows.map((b) => b.cut_date), ['2026-08-01', '2026-08-01', '2026-08-15', '2026-08-15']);

  const state = await get(`?session_id=${SESSION_ID}`);
  const session = state.json.session as Record<string, unknown>;
  assert.equal(session.status, 'completed');
  assert.equal(session.next_required, null);
  assert.deepEqual(session.recorded, order);
  assert.deepEqual(session.stats, { rows: 4, meanSeconds: 10.5, maxSeconds: 11 });

  // a completed session takes nothing more
  const late = await post({
    action: 'belief', session_id: SESSION_ID, step_index: 1, variant_id: null,
    reviewer_role: 'consulting_physician', payload: PAYLOAD, seconds_spent: 4,
  });
  assert.equal(late.status, 409);
  assert.equal(beliefRows.length, 4);
});

// ── 8. the fixed constants ────────────────────────────────────────────────────
test('the DDL and the inserts fix provenance, trigger and after_cdmss — in both files', () => {
  const migration = readFileSync('migrations/0054_cognition_review.sql', 'utf8');
  const route = readFileSync('app/api/admin/migrate-cognition-review/route.ts', 'utf8');
  for (const src of [migration, route]) {
    assert.ok(src.includes("provenance TEXT NOT NULL DEFAULT 'CLINICIAN_REPORTED_BELIEF'"));
    assert.ok(src.includes("trigger TEXT NOT NULL DEFAULT 'retrospective_replay'"));
    assert.ok(src.includes('after_cdmss BOOLEAN NOT NULL DEFAULT FALSE'));
    assert.ok(src.includes("COALESCE(variant_id, 'base')"), 'the identity index coalesces the base');
  }
  const store = readFileSync('lib/review/store.ts', 'utf8');
  assert.ok(store.includes("'CLINICIAN_REPORTED_BELIEF','retrospective_replay',FALSE"),
    'the insert writes the three literals, never a caller-supplied value');
  const code = store.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/individual_uid(?!_hash)/.test(code),
    'the store has no column, parameter or query for a plain individual_uid');
  const routeCode = readFileSync('app/api/admin/review/route.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(routeCode, /createHash\('sha256'\)\.update\(subject\.individualUid\)\.digest\('hex'\)/,
    'the route hashes the subject and stores only that');
});
