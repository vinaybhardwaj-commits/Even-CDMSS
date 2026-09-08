/**
 * lib/__tests__/doctor-response-idempotency.test.ts — one response per thread (IG-D1..D6).
 *
 *   node --test --import tsx lib/__tests__/doctor-response-idempotency.test.ts
 *
 * THE RULE: a thread takes one doctor response. The same answer again is a REPLAY — HTTP 200 with
 * the thread's current state and not one byte written. A different answer to an answered thread is
 * a CONFLICT — HTTP 409, nothing written. Only a thread with no `latest_response` follows today's
 * path. Before this guard a repeat POST overwrote `latest_response`, appended a second `responded`
 * event (and on a repeat disagree a second `escalated`), and inserted a second opd_audit_feedback
 * row into the calibration corpus.
 *
 * FORM USED: the classifier is a pure function and is exercised directly. The ROUTE is exercised
 * for real — its module graph does load under `node --test` — with the ONLY substitution at
 * `globalThis.fetch`, which is where the neon HTTP driver puts every statement. Every statement the
 * request issues is therefore recorded here, so "writes nothing" is checked as "the recorded log
 * holds no INSERT/UPDATE/DELETE": the store's write functions (applyDoctorResponse → UPDATE
 * opd_gov_signal + INSERT opd_gov_signal_event) and the route's feedback INSERT cannot have run
 * without appearing in it. The stub answers reads from an in-memory row, so the replay in these
 * tests is a replay of a response this same harness actually recorded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyDoctorResponse } from '../opd-gov-signal-core.ts';

// ── the harness ───────────────────────────────────────────────────────────────
// A dummy service key and an unreachable database URL: nothing leaves this process, because every
// statement stops at the fetch stub below.
process.env.GOV_API_KEY = 'test-gov-key';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';

const SIGNAL_ID = '11111111-2222-3333-4444-555555555555';
const AUDIT_ID = '99999999-8888-7777-6666-555555555555';
const REF = 'EHRC-AUD-2026-0007';

type Row = Record<string, unknown>;
const issued: { text: string; params: unknown[] }[] = [];
const writes = () => issued.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text));
let signalRow: Row;
let auditRows: Row[];

/** Reset the in-memory row set. `latest` is the thread's stored latest_response (null = unanswered). */
function reset(latest: unknown = null, status = 'routed'): void {
  issued.length = 0;
  signalRow = {
    signal_id: SIGNAL_ID, reference: REF, doctor_uid: 'DOC-1', signal_type: 'drug_interaction',
    importance: 'high', response_required: 'explanation', status, source_triage_ref: null,
    window_from: '2026-08-01', window_to: '2026-08-31', sla_due_at: '2026-08-08T00:00:00.000Z',
    latest_response: latest == null ? null : JSON.stringify(latest), ruling: null,
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  };
  // One audit instance of the thread's signal_type, so the calibration (opd_audit_feedback) write
  // on a first disagree is actually reachable — and its absence on a replay is meaningful.
  auditRows = [{
    id: AUDIT_ID, note_date: '2026-08-15',
    findings: JSON.stringify([{
      subject: 'Drug interaction: warfarin + aspirin', domain: 'prescribing',
      verdict: 'unsafe', rationale: 'bleeding risk', citation_ids: [],
    }]),
    sources: JSON.stringify([]),
  }];
}

/** A neon HTTP result body: every column typed text (dataTypeID 25); the store parses from there. */
function resultBody(rows: Row[]): string {
  const names = rows.length ? Object.keys(rows[0]) : [];
  return JSON.stringify({
    command: 'SELECT', rowCount: rows.length, rowAsArray: false,
    fields: names.map((name, i) => ({
      name, tableID: 0, columnID: i + 1, dataTypeID: 25, dataTypeSize: -1, dataTypeModifier: -1, format: 'text',
    })),
    rows: rows.map((r) => names.map((n) => (r[n] == null ? null : String(r[n])))),
  });
}
const ok = (rows: Row[]) => new Response(resultBody(rows), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
  const sent = JSON.parse(String(init?.body ?? '{}')) as { query?: string; params?: unknown[] };
  const text = String(sent.query ?? '');
  const params = sent.params ?? [];
  issued.push({ text, params });
  if (/^\s*UPDATE opd_gov_signal\b/i.test(text)) {
    signalRow = { ...signalRow, latest_response: params[1], status: params[2] };
    return ok([]);
  }
  if (/^\s*SELECT/i.test(text) && /FROM opd_gov_signal\b/i.test(text)) return ok([signalRow]);
  if (/FROM opd_note_audits/i.test(text)) return ok(auditRows);
  return ok([]);
}) as typeof fetch;

async function post(payload: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('../../app/api/governance/doctor-response/route.ts');
  const req = new NextRequest('https://cat.test/api/governance/doctor-response', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': String(process.env.GOV_API_KEY) },
    body: JSON.stringify(payload),
  });
  const res = await POST(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const AGREE = { reference: REF, type: 'explanation', verdict: 'agree', comment: 'Dose was reduced the same day.' };
const DISAGREE = { reference: REF, type: 'explanation', verdict: 'disagree', comment: 'The pair is separated by 6 hours.' };

// ── IG-D1..D4 — the classifier ────────────────────────────────────────────────
test('classifyDoctorResponse: no stored response is a first response', () => {
  assert.equal(classifyDoctorResponse(null, { type: 'explanation', verdict: 'agree', comment: 'x' }), 'first');
  assert.equal(classifyDoctorResponse(undefined as unknown as null, { type: 'acknowledgment', verdict: null, comment: null }), 'first');
});

test('classifyDoctorResponse: the same answer again is a replay — type, verdict and comment all match', () => {
  const stored = { type: 'explanation', verdict: 'agree', comment: 'Dose was reduced.', responded_at: '2026-08-02T10:00:00.000Z' };
  assert.equal(classifyDoctorResponse(stored, { type: 'explanation', verdict: 'agree', comment: 'Dose was reduced.' }), 'replay');
  // an acknowledgment carries verdict null on both sides — absence must compare equal to absence
  const ack = { type: 'acknowledgment', verdict: null, comment: null, responded_at: '2026-08-02T10:00:00.000Z' };
  assert.equal(classifyDoctorResponse(ack, { type: 'acknowledgment', verdict: null, comment: null }), 'replay');
  assert.equal(classifyDoctorResponse({ type: 'acknowledgment', comment: null }, { type: 'acknowledgment', verdict: null, comment: null }), 'replay');
});

test('classifyDoctorResponse: any difference in type, verdict or comment is a conflict', () => {
  const stored = { type: 'explanation', verdict: 'agree', comment: 'Dose was reduced.' };
  assert.equal(classifyDoctorResponse(stored, { type: 'explanation', verdict: 'disagree', comment: 'Dose was reduced.' }), 'conflict');
  assert.equal(classifyDoctorResponse(stored, { type: 'acknowledgment', verdict: 'agree', comment: 'Dose was reduced.' }), 'conflict');
  assert.equal(classifyDoctorResponse(stored, { type: 'explanation', verdict: 'agree', comment: 'Dose was not reduced.' }), 'conflict');
  // verdict is compared exactly — no normalisation, no case folding
  assert.equal(classifyDoctorResponse(stored, { type: 'explanation', verdict: 'AGREE', comment: 'Dose was reduced.' }), 'conflict');
  // a stored value that is present but is not a recorded answer: the thread has been answered
  assert.equal(classifyDoctorResponse('some string', { type: 'explanation', verdict: 'agree', comment: 'Dose was reduced.' }), 'conflict');
  assert.equal(classifyDoctorResponse({}, { type: 'explanation', verdict: 'agree', comment: 'Dose was reduced.' }), 'conflict');
});

test('classifyDoctorResponse: comment normalisation — trim, collapse runs, null equals ""', () => {
  const stored = { type: 'explanation', verdict: 'agree', comment: 'Dose  was\n reduced\tthe same day.' };
  const same = (comment: string | null) => classifyDoctorResponse(stored, { type: 'explanation', verdict: 'agree', comment });
  assert.equal(same('Dose was reduced the same day.'), 'replay', 'internal runs collapse to one space');
  assert.equal(same('   Dose was reduced the same day.   '), 'replay', 'leading and trailing space is trimmed');
  assert.equal(same('Dose was reduced the same  day.'), 'replay', 'a run on either side normalises the same way');
  assert.equal(same('Dose was reduced.'), 'conflict', 'normalisation does not make different text equal');
  // null and '' are the same absence of a comment, in both directions
  const ack = (storedComment: unknown, incoming: string | null) =>
    classifyDoctorResponse({ type: 'acknowledgment', verdict: null, comment: storedComment }, { type: 'acknowledgment', verdict: null, comment: incoming });
  assert.equal(ack(null, null), 'replay');
  assert.equal(ack(null, ''), 'replay');
  assert.equal(ack('', null), 'replay');
  assert.equal(ack('   ', null), 'replay', 'whitespace-only trims to the empty comment');
  assert.equal(ack(null, 'a note'), 'conflict');
});

// ── IG-D5 — the route: the first response is unchanged ────────────────────────
test('route: a first response follows today\'s path — update, responded event, 200', async () => {
  reset(null);
  const res = await post(AGREE);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.status, 'responded');
  const w = writes();
  assert.equal(w.length, 2, 'exactly the two writes of today\'s path');
  assert.match(w[0].text, /^UPDATE opd_gov_signal SET latest_response=\$2::jsonb, status=\$3/);
  assert.match(w[1].text, /^INSERT INTO opd_gov_signal_event/);
  assert.equal(w[1].params[1], 'responded');
  const signal = res.json.signal as Record<string, unknown>;
  const response = signal.response as Record<string, unknown>;
  assert.equal(response.type, 'explanation');
  assert.equal(response.verdict, 'agree');
  assert.equal(response.comment, AGREE.comment);
  assert.equal(signal.reference, REF);
});

test('route: a first disagree escalates and writes the calibration row — unchanged', async () => {
  reset(null);
  const res = await post(DISAGREE);
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'escalated');
  const w = writes();
  assert.equal(w.length, 4);
  assert.match(w[0].text, /^UPDATE opd_gov_signal SET latest_response/);
  assert.equal(w[1].params[1], 'responded');
  assert.equal(w[2].params[1], 'escalated');
  assert.match(w[3].text, /^INSERT INTO opd_audit_feedback/);
  assert.deepEqual(w[3].params, [AUDIT_ID, null, DISAGREE.comment, 'doctor:DOC-1']);
});

// ── IG-D1 — the replay ────────────────────────────────────────────────────────
test('route: an identical replay returns 200 with the current state and writes nothing', async () => {
  reset(null);
  const first = await post(AGREE);
  assert.equal(first.status, 200);
  issued.length = 0;                      // keep the recorded response; forget the statements

  const replay = await post(AGREE);
  assert.equal(replay.status, 200);
  assert.deepEqual(writes(), [], 'no UPDATE, no event INSERT, no feedback INSERT');
  assert.ok(!issued.some((q) => /opd_audit_feedback/i.test(q.text)), 'the calibration corpus is untouched');
  assert.ok(!issued.some((q) => /opd_gov_signal_event/i.test(q.text)), 'no second event on the log');
  assert.deepEqual(replay.json, first.json, 'the same signalObject the route returned the first time');
});

test('route: a replay whose comment differs only in whitespace is still a replay', async () => {
  reset(null);
  await post(DISAGREE);
  issued.length = 0;
  const replay = await post({ ...DISAGREE, comment: `  The pair is   separated by\n6 hours.  ` });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.status, 'escalated');
  assert.deepEqual(writes(), [], 'a second disagree must not re-escalate or re-file calibration');
});

// ── IG-D2 — the conflict ──────────────────────────────────────────────────────
test('route: a different answer to an answered thread returns 409 and writes nothing', async () => {
  reset(null);
  await post(AGREE);
  issued.length = 0;

  const conflict = await post({ ...AGREE, verdict: 'disagree' });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.json, { ok: false, error: 'already responded — revisions go through your care manager' });
  assert.deepEqual(writes(), [], 'a rejected revision writes nothing');
  assert.equal(signalRow.status, 'responded', 'the thread keeps the answer it had');

  // a changed comment is equally a conflict
  issued.length = 0;
  const reworded = await post({ ...AGREE, comment: 'Actually the dose was unchanged.' });
  assert.equal(reworded.status, 409);
  assert.deepEqual(writes(), []);
});

test('route: the 409 on a ruled thread is unchanged — validation still runs first', async () => {
  reset({ type: 'explanation', verdict: 'agree', comment: 'x' }, 'ruled');
  const res = await post(AGREE);
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { ok: false, error: 'signal already closed' });
  assert.deepEqual(writes(), []);
});

// ── the shape of the route (structural) ───────────────────────────────────────
test('route source: the guard sits after validation and before every write', () => {
  const src = readFileSync('app/api/governance/doctor-response/route.ts', 'utf8');
  const validate = src.indexOf('validateDoctorResponse(body, signal)');
  const classify = src.indexOf('classifyDoctorResponse(signal.latest_response, v.value)');
  const apply = src.indexOf('applyDoctorResponse(signal, v.value)');
  const feedback = src.indexOf('INSERT INTO opd_audit_feedback');
  assert.ok(validate > 0 && classify > validate, 'classified only after validation passes');
  assert.ok(apply > classify && feedback > classify, 'no write precedes the classification');
  assert.ok(src.includes(`const updated = replay ? signal : await applyDoctorResponse(signal, v.value);`),
    'the store write is skipped on a replay, not made conditional inside the store');
  assert.ok(src.includes(`if (!replay && v.value.type === 'explanation' && v.value.verdict === 'disagree')`),
    'the calibration write is skipped on a replay too');
  assert.ok(!/\bstudy\b/.test(src), 'this route still never sets study (D16)');
});
