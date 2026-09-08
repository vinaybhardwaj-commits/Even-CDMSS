/**
 * lib/__tests__/signal-reaction.test.ts — WM2 v1: the reaction store and its route (reaction/0.1).
 *
 *   node --test --import tsx lib/__tests__/signal-reaction.test.ts
 *
 * THE RULE: one reaction per signal per physician, immutable. The same verb again is a REPLAY —
 * 200 with the stored row and not one byte written. A different verb is a CONFLICT — 409, nothing
 * written. A reaction notifies nobody: this route must never touch a governance thread's answer.
 *
 * FORM USED: the B1 harness (lib/__tests__/doctor-response-idempotency.test.ts). The classifier is
 * pure and is exercised directly; the ROUTE is exercised for real, with the only substitution at
 * `globalThis.fetch`, which is where the neon HTTP driver puts every statement. Every statement the
 * request issues is recorded, so "writes nothing" is checked as "the recorded log holds no INSERT,
 * UPDATE or DELETE", and the in-memory rows make a replay a replay of a row this harness actually
 * wrote a moment earlier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyReaction, isReactionVerb, REACTION_VERBS } from '../cognition/reactions.ts';

// ── the harness ───────────────────────────────────────────────────────────────
// A dummy service key and an unreachable database URL. ADMIN_TOKEN is deliberately left unset, so
// `isAdminUnlocked` returns false without reaching for a cookie jar that does not exist here.
process.env.GOV_API_KEY = 'test-gov-key';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';

const SIGNAL_ID = '11111111-2222-3333-4444-555555555555';
const AUDIT_ID = '99999999-8888-7777-6666-555555555555';
const REF = 'EHRC-AUD-2026-0007';
const DOCTOR = 'DOC-1';
const PHYSICIAN = 'phy_42';

type Row = Record<string, unknown>;
const issued: { text: string; params: unknown[] }[] = [];
const writes = () => issued.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text));
let signalRow: Row | null;
let auditRows: Row[];
let reactionRows: Row[];

function reset(opts: { signal?: boolean } = {}): void {
  issued.length = 0;
  reactionRows = [];
  signalRow = opts.signal === false ? null : {
    signal_id: SIGNAL_ID, reference: REF, doctor_uid: DOCTOR, signal_type: 'drug_interaction',
    importance: 'high', response_required: 'explanation', status: 'routed', source_triage_ref: null,
    window_from: '2026-08-01', window_to: '2026-08-31', sla_due_at: '2026-08-08T00:00:00.000Z',
    latest_response: null, ruling: null,
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  };
  auditRows = [{
    id: AUDIT_ID, note_date: '2026-08-15',
    findings: JSON.stringify([{
      subject: 'Drug interaction: warfarin + aspirin', domain: 'prescribing',
      verdict: 'unsafe', rationale: 'bleeding risk', citation_ids: [],
    }]),
    sources: JSON.stringify([]),
  }];
}

/** A neon HTTP result body: every column typed text (dataTypeID 25); the stores parse from there. */
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

  if (/^\s*INSERT INTO cognition_reactions\b/i.test(text)) {
    // ON CONFLICT (signal_id, physician_id) DO NOTHING — the identity index, in memory.
    const [app, signalId, reference, clinicalStateRef, doctorUid, physicianId, reaction, schemaVersion] = params as string[];
    if (reactionRows.some((r) => r.signal_id === signalId && r.physician_id === physicianId)) return ok([]);
    const row: Row = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', created_at: '2026-09-08T06:30:00.000Z',
      app_source: app, signal_id: signalId, reference, clinical_state_ref: clinicalStateRef,
      cdmss_doctor_uid: doctorUid, physician_id: physicianId, reaction,
      provenance: 'CLINICIAN_REPORTED_BELIEF', after_cdmss: true, surface: 'portal_findings',
      schema_version: schemaVersion,
    };
    reactionRows.push(row);
    return ok([row]);
  }
  if (/FROM cognition_reactions\b/i.test(text)) {
    if (/WHERE signal_id=/i.test(text)) {
      const [signalId, physicianId] = params as string[];
      return ok(reactionRows.filter((r) => r.signal_id === signalId && r.physician_id === physicianId));
    }
    const [doctorUid, physicianId] = params as string[];
    return ok(reactionRows.filter((r) => r.cdmss_doctor_uid === doctorUid && r.physician_id === physicianId));
  }
  if (/^\s*SELECT/i.test(text) && /FROM opd_gov_signal\b/i.test(text)) return ok(signalRow ? [signalRow] : []);
  if (/FROM opd_note_audits/i.test(text)) return ok(auditRows);
  return ok([]);
}) as typeof fetch;

const URL_BASE = 'https://cat.test/api/governance/signal-reaction';

async function post(payload: Record<string, unknown>, auth = true): Promise<{ status: number; json: Record<string, unknown> }> {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('../../app/api/governance/signal-reaction/route.ts');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers['x-api-key'] = String(process.env.GOV_API_KEY);
  const req = new NextRequest(URL_BASE, { method: 'POST', headers, body: JSON.stringify(payload) });
  const res = await POST(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(query: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/governance/signal-reaction/route.ts');
  const req = new NextRequest(`${URL_BASE}${query}`, {
    method: 'GET', headers: { 'x-api-key': String(process.env.GOV_API_KEY) },
  });
  const res = await GET(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const PRESS = { signal_id: SIGNAL_ID, physician_id: PHYSICIAN, cdmss_doctor_uid: DOCTOR, reaction: 'already_knew' };

// ── the pure vocabulary and guard ─────────────────────────────────────────────
test('classifyReaction: null is first, the same verb is a replay, a different verb is a conflict', () => {
  assert.equal(classifyReaction(null, 'already_knew'), 'first');
  assert.equal(classifyReaction({ reaction: 'already_knew' }, 'already_knew'), 'replay');
  assert.equal(classifyReaction({ reaction: 'already_knew' }, 'surprised'), 'conflict');
  assert.equal(classifyReaction({ reaction: 'dismiss' }, 'already_knew'), 'conflict');
});

test('isReactionVerb: exactly the three verbs, case- and whitespace-sensitive', () => {
  assert.deepEqual([...REACTION_VERBS], ['already_knew', 'surprised', 'dismiss']);
  for (const v of REACTION_VERBS) assert.equal(isReactionVerb(v), true, v);
  for (const bad of ['disagree', 'Dismiss', '', 'dismiss ', 'agree', null, undefined, 7, {}]) {
    assert.equal(isReactionVerb(bad), false, JSON.stringify(bad));
  }
});

// ── POST ──────────────────────────────────────────────────────────────────────
test('POST first: one INSERT INTO cognition_reactions, ok:true replay:false', async () => {
  reset();
  const res = await post(PRESS);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.replay, false);
  assert.deepEqual(res.json.reaction, {
    signal_id: SIGNAL_ID, reference: REF, reaction: 'already_knew',
    at: '2026-09-08T06:30:00.000Z', after_cdmss: true,
  });
  const w = writes();
  assert.equal(w.length, 1, 'exactly one write');
  assert.match(w[0].text, /^INSERT INTO cognition_reactions/);
  assert.match(w[0].text, /ON CONFLICT \(signal_id, physician_id\) DO NOTHING/);
  // the row carries the resolved audit instance, the thread's reference and the vocabulary version
  assert.equal(reactionRows.length, 1);
  assert.equal(reactionRows[0].clinical_state_ref, AUDIT_ID);
  assert.equal(reactionRows[0].reference, REF);
  assert.equal(reactionRows[0].schema_version, 'reaction/0.1');
  assert.equal(reactionRows[0].provenance, 'CLINICIAN_REPORTED_BELIEF');
});

test('POST replay: 200, replay:true, and the statement log holds no write', async () => {
  reset();
  const first = await post(PRESS);
  assert.equal(first.status, 200);
  issued.length = 0;

  const replay = await post(PRESS);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.ok, true);
  assert.equal(replay.json.replay, true);
  assert.deepEqual(replay.json.reaction, first.json.reaction, 'the stored row, unchanged');
  assert.deepEqual(writes(), [], 'no INSERT, no UPDATE, no DELETE');
  assert.equal(reactionRows.length, 1, 'still one row');
});

test('POST conflict: a different verb is 409 and writes nothing', async () => {
  reset();
  await post(PRESS);
  issued.length = 0;

  const conflict = await post({ ...PRESS, reaction: 'surprised' });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.json, { ok: false, error: 'reaction already recorded' });
  assert.deepEqual(writes(), []);
  assert.equal(reactionRows[0].reaction, 'already_knew', 'the first belief stands');
});

test('POST wrong verb: 400, and no statement is issued after auth', async () => {
  reset();
  const res = await post({ ...PRESS, reaction: 'disagree' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { ok: false, error: 'reaction must be already_knew|surprised|dismiss' });
  assert.deepEqual(issued, [], 'the vocabulary check precedes every read');
});

test('POST missing fields: 400 with the required-fields error, no statements', async () => {
  reset();
  for (const bad of [
    { physician_id: PHYSICIAN, cdmss_doctor_uid: DOCTOR, reaction: 'dismiss' },
    { signal_id: SIGNAL_ID, cdmss_doctor_uid: DOCTOR, reaction: 'dismiss' },
    { signal_id: SIGNAL_ID, physician_id: PHYSICIAN, reaction: 'dismiss' },
    { signal_id: SIGNAL_ID, physician_id: PHYSICIAN, cdmss_doctor_uid: DOCTOR },
    { signal_id: '  ', physician_id: PHYSICIAN, cdmss_doctor_uid: DOCTOR, reaction: 'dismiss' },
  ]) {
    const res = await post(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(res.json, { ok: false, error: 'signal_id, physician_id, cdmss_doctor_uid and reaction are required' });
  }
  assert.deepEqual(issued, []);
});

test('POST mismatched doctor: 403, no INSERT', async () => {
  reset();
  const res = await post({ ...PRESS, cdmss_doctor_uid: 'DOC-OTHER' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json, { ok: false, error: 'doctor_uid does not match the signal' });
  assert.deepEqual(writes(), []);
  assert.equal(reactionRows.length, 0);
});

test('POST unknown signal: 404, no INSERT', async () => {
  reset({ signal: false });
  const res = await post(PRESS);
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { ok: false, error: 'unknown signal' });
  assert.deepEqual(writes(), []);
});

test('POST unauthorized: 401 before anything is read', async () => {
  reset();
  const res = await post(PRESS, false);
  assert.equal(res.status, 401);
  assert.deepEqual(res.json, { ok: false, error: 'unauthorized' });
  assert.deepEqual(issued, []);
});

// ── GET ───────────────────────────────────────────────────────────────────────
test('GET: the map is keyed by signal_id, and empty when the physician has pressed nothing', async () => {
  reset();
  const empty = await get(`?doctor_uid=${DOCTOR}&physician_id=${PHYSICIAN}`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { ok: true, reactions: {} });

  await post(PRESS);
  const one = await get(`?doctor_uid=${DOCTOR}&physician_id=${PHYSICIAN}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.json, {
    ok: true,
    reactions: { [SIGNAL_ID]: { reaction: 'already_knew', at: '2026-09-08T06:30:00.000Z' } },
  });

  // another physician's map is their own
  const other = await get(`?doctor_uid=${DOCTOR}&physician_id=phy_99`);
  assert.deepEqual(other.json, { ok: true, reactions: {} });

  const missing = await get(`?doctor_uid=${DOCTOR}`);
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.json, { ok: false, error: 'doctor_uid and physician_id required' });
});

// ── the shape of the route (structural) ───────────────────────────────────────
test('route source: a reaction never touches a thread\'s answer or the calibration corpus', () => {
  const src = readFileSync('app/api/governance/signal-reaction/route.ts', 'utf8');
  for (const forbidden of ['latest_response', 'applyDoctorResponse', 'opd_audit_feedback']) {
    assert.ok(!src.includes(forbidden), `the reaction route must never mention ${forbidden}`);
  }
  assert.ok(!/opd_gov_signal_event/.test(src), 'and it appends no lifecycle event');
});
