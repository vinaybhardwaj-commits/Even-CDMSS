/**
 * lib/__tests__/cognition-join.test.ts — WM3: the join (cognition-join/0.1).
 *
 *   node --test --import tsx lib/__tests__/cognition-join.test.ts
 *
 * THE RULES UNDER TEST:
 *   visibility is not the test date, and a row whose lag could not be modelled says so;
 *   Y is the first result the doctor could have SEEN, not the first one drawn;
 *   O_after is as of the day AFTER visibility, because the spine's cut is strictly prior;
 *   a null and a throw are different answers — an outage never becomes an empty record;
 *   every phase is idempotent, and a second run over the same data writes nothing new.
 *
 * FORM USED: the B1/B2a/B4 harness. The pure core is exercised directly; the SWEEP runs for real
 * against `globalThis.fetch`, which carries both transports — Metabase /api/dataset (db13) and the
 * neon HTTP driver (the two join tables, in memory, with both identity indexes enforced).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  chooseY, istDay, oAfterAsOf, provenanceFor, snapshotHash, visibleAtFor, yStatusFor,
  CREATE_TIME_CUTOFF, type LabRow,
} from '../cognition/join-core.ts';

// ── the harness ───────────────────────────────────────────────────────────────
// Placeholders only; nothing leaves this process.
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';
process.env.METABASE_URL = 'https://metabase.invalid.test';
process.env.METABASE_API_KEY = 'test-metabase-key';

const UID = 'ind_abc123';
const PRESC = 'presc_aaa111';
const PRESC2 = 'presc_bbb222';
/** The audit row's own primary key. NOT the same identifier as PRESC — that is the whole point of
 *  the reaction join: B2a writes this id into clinical_state_ref, and event_ref is the uid. */
const AUDIT_ID = '7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';

type Row = Record<string, unknown>;
const issued: { text: string; params: unknown[] }[] = [];
const db13: string[] = [];
const writes = () => issued.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text));

let shadowEvents: Row[] = [];
let snapshotRows: Row[] = [];
let tripleRows: Row[] = [];
let reactionRows: Row[] = [];
let auditRows: Row[] = [];
let labRows: Row[] = [];
let resolveMap: Record<string, string | null> = {};
let resolveThrows = false;
let seq = 0;

function reset(): void {
  issued.length = 0; db13.length = 0;
  snapshotRows = []; tripleRows = []; reactionRows = []; labRows = [];
  auditRows = [{ id: AUDIT_ID, uid: PRESC }];
  resolveThrows = false; seq = 0;
  resolveMap = { [PRESC]: UID, [PRESC2]: UID };
  shadowEvents = [{
    trigger_kind: 'opd_note_audited', event_ref: PRESC, event_at: '2026-08-10T09:30:00.000Z',
    created_at: '2026-08-10T10:00:00.000Z', eligible: true, policy_version: 'burden-policy/0.1',
  }];
}

function neonBody(rows: Row[]): string {
  const names = rows.length ? Object.keys(rows[0]) : [];
  return JSON.stringify({
    command: 'SELECT', rowCount: rows.length, rowAsArray: false,
    fields: names.map((name, i) => ({ name, tableID: 0, columnID: i + 1, dataTypeID: 25, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' })),
    rows: rows.map((r) => names.map((n) => (r[n] == null ? null : typeof r[n] === 'object' ? JSON.stringify(r[n]) : String(r[n])))),
  });
}
const okJson = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
function metabaseBody(rows: Row[]): string {
  const names = rows.length ? Object.keys(rows[0]) : [];
  return JSON.stringify({ data: { cols: names.map((name) => ({ name })), rows: rows.map((r) => names.map((n) => r[n])) } });
}

/** The snapshot the frozen reconstruct is stubbed to return, keyed by as_of. */
let snapshotByDay: Record<string, unknown | null> = {};
let reconstructThrowsFor: string[] = [];

globalThis.fetch = (async (url: unknown, init: { body?: unknown } = {}) => {
  const href = String(url);

  // ── db13 via Metabase: the identity read and the Y read ──
  if (href.includes('/api/dataset')) {
    const sent = JSON.parse(String(init?.body ?? '{}')) as { native?: { query?: string } };
    const query = String(sent.native?.query ?? '');
    db13.push(query);
    if (/individuals-prescriptions/.test(query)) {
      if (resolveThrows) return new Response('db13 down', { status: 500 });
      const m = /uid = '([^']+)'/.exec(query);
      const found = m ? resolveMap[m[1]] : null;
      return okJson(metabaseBody(found ? [{ individual_uid: found }] : []));
    }
    if (/test_digital_values_view/.test(query)) return okJson(metabaseBody(labRows));
    return okJson(metabaseBody([]));
  }

  // ── the join tables via neon ──
  const sent = JSON.parse(String(init?.body ?? '{}')) as { query?: string; params?: unknown[] };
  const text = String(sent.query ?? '');
  const params = sent.params ?? [];
  issued.push({ text, params });

  if (/^\s*INSERT INTO cognition_triples\b/i.test(text)) {
    const [trigger, eventRef, eventAt, uid, microworld, provenance, resolveStatus, oBefore, yStatus, horizon, policyV, schemaV] = params as unknown[];
    if (tripleRows.some((r) => r.trigger_kind === trigger && r.event_ref === eventRef && r.schema_version === schemaV)) {
      return okJson(neonBody([]));                        // ON CONFLICT DO NOTHING
    }
    const row: Row = {
      id: `triple-${++seq}`, created_at: '2026-09-08T06:00:00.000Z', updated_at: '2026-09-08T06:00:00.000Z',
      trigger_kind: trigger, event_ref: eventRef, event_at: eventAt, individual_uid: uid,
      microworld, provenance, resolve_status: resolveStatus, o_before_id: oBefore,
      y_kind: null, y_ref: null, y_test_date: null, y_create_time: null, y_visible_at: null,
      y_visible_rule: null, y_status: yStatus, y_horizon_days: Number(horizon), o_after_id: null,
      o_after_as_of: null, reaction_ref: null, reaction_after_cdmss: null,
      policy_version: policyV, schema_version: schemaV,
    };
    tripleRows.push(row);
    return okJson(neonBody([{ id: row.id }]));
  }
  if (/^\s*UPDATE cognition_triples\b/i.test(text)) {
    if (/SET y_kind=/i.test(text)) {
      const [id, yKind, yRef, testDate, createTime, visibleAt, rule, status] = params as unknown[];
      const row = tripleRows.find((r) => r.id === id);
      if (row) Object.assign(row, { y_kind: yKind, y_ref: yRef, y_test_date: testDate, y_create_time: createTime, y_visible_at: visibleAt, y_visible_rule: rule, y_status: status });
      return okJson(neonBody([]));
    }
    if (/SET o_after_id=/i.test(text)) {
      const [id, oAfterId, asOf] = params as unknown[];
      const row = tripleRows.find((r) => r.id === id);
      if (row) Object.assign(row, { o_after_id: oAfterId, o_after_as_of: asOf });
      return okJson(neonBody([]));
    }
    if (/SET reaction_ref=/i.test(text)) {
      const [id, ref, after] = params as unknown[];
      const row = tripleRows.find((r) => r.id === id && r.reaction_ref == null);
      if (row) Object.assign(row, { reaction_ref: ref, reaction_after_cdmss: after === true || after === 'true' });
      return okJson(neonBody([]));
    }
    return okJson(neonBody([]));
  }
  if (/FROM cognition_shadow_events\b/i.test(text)) {
    const [policyV, trigger, schemaV] = params as unknown[];
    return okJson(neonBody(shadowEvents.filter((e) => e.eligible === true && e.policy_version === policyV
      && e.trigger_kind === trigger
      && !tripleRows.some((t) => t.trigger_kind === e.trigger_kind && t.event_ref === e.event_ref && t.schema_version === schemaV))));
  }
  if (/FROM cognition_triples\b/i.test(text)) {
    if (/min\(created_at\)/i.test(text)) {
      const min = tripleRows.map((r) => String(r.created_at)).sort()[0] ?? null;
      return okJson(neonBody([{ t: min }]));
    }
    if (/GROUP BY/i.test(text) || /percentile_cont/i.test(text) || /count\(\*\)/i.test(text)) {
      return okJson(neonBody([]));
    }
    if (/y_status = 'pending'/i.test(text)) return okJson(neonBody(tripleRows.filter((r) => r.y_status === 'pending' && r.resolve_status === 'resolved')));
    if (/o_after_id IS NULL/i.test(text)) return okJson(neonBody(tripleRows.filter((r) => r.y_status === 'present' && r.o_after_id == null)));
    if (/cut_status = 'context_fetch_failed'/i.test(text)) {
      return okJson(neonBody(tripleRows.filter((r) => r.y_status === 'present' && r.o_after_id != null
        && snapshotRows.some((s) => s.id === r.o_after_id && s.cut_status === 'context_fetch_failed'))));
    }
    const [uid] = params as string[];
    return okJson(neonBody(tripleRows.filter((r) => r.individual_uid === uid)));
  }

  if (/^\s*INSERT INTO cognition_snapshots\b/i.test(text)) {
    const [uid, asOf, cutStatus, provenance, walkV, msV, ipdFold, json, hash, schemaV] = params as unknown[];
    const dupe = snapshotRows.some((r) => r.individual_uid === uid && r.as_of === asOf && r.walk_version === walkV
      && r.member_state_version === msV && r.ipd_fold === ipdFold && r.provenance === provenance);
    if (!dupe) {
      snapshotRows.push({
        id: `snap-${++seq}`, individual_uid: uid, as_of: asOf, cut_status: cutStatus, provenance,
        walk_version: walkV, member_state_version: msV, ipd_fold: ipdFold,
        snapshot_json: json, snapshot_hash: hash, schema_version: schemaV,
      });
    }
    return okJson(neonBody([]));
  }
  if (/^\s*UPDATE cognition_snapshots\b/i.test(text)) {
    const [id, cutStatus, json, hash] = params as unknown[];
    const row = snapshotRows.find((r) => r.id === id && r.cut_status === 'context_fetch_failed');
    if (!row) return okJson(neonBody([]));
    row.cut_status = cutStatus; row.snapshot_json = json; row.snapshot_hash = hash;
    return okJson(neonBody([{ id }]));
  }
  if (/FROM cognition_snapshots\b/i.test(text) && /^\s*SELECT/i.test(text)) {
    if (/WHERE id=/i.test(text)) {
      const [id] = params as string[];
      return okJson(neonBody(snapshotRows.filter((r) => r.id === id)));
    }
    if (/GROUP BY/i.test(text)) {
      const counts = new Map<string, number>();
      for (const r of snapshotRows) counts.set(String(r.cut_status), (counts.get(String(r.cut_status)) ?? 0) + 1);
      return okJson(neonBody([...counts].map(([k, n]) => ({ k, n }))));
    }
    const [uid, asOf, walkV, msV, ipdFold, provenance] = params as unknown[];
    return okJson(neonBody(snapshotRows.filter((r) => r.individual_uid === uid && r.as_of === asOf
      && r.walk_version === walkV && r.member_state_version === msV && r.ipd_fold === ipdFold && r.provenance === provenance)));
  }

  if (/FROM cognition_reactions\b/i.test(text)) {
    // The joined shape: cognition_reactions.clinical_state_ref = opd_note_audits.id::text, matched
    // to the triple's event_ref through opd_note_audits.uid.
    assert.match(text, /JOIN opd_note_audits a ON a\.id::text = r\.clinical_state_ref/);
    const [uid] = params as string[];
    const ids = auditRows.filter((a) => a.uid === uid).map((a) => String(a.id));
    return okJson(neonBody(reactionRows
      .filter((r) => ids.includes(String(r.clinical_state_ref)))
      .map((r) => ({ id: r.id, after_cdmss: r.after_cdmss }))));
  }
  return okJson(neonBody([]));
}) as typeof fetch;

/** Deps: the frozen reconstruct is stubbed by day, and the pacing pause is a no-op in tests. */
const DEPS = () => ({
  reconstruct: async (_uid: string, asOf: string) => {
    if (reconstructThrowsFor.includes(asOf)) throw new Error('db13 down');
    return snapshotByDay[asOf] ?? null;
  },
  flags: { MEMBERSTATE_IPD_FOLD: false, CARE_CALL_ENABLED: false, PROMS_ENABLED: false },
  sleep: async () => {},
  now: () => new Date('2026-09-08T06:00:00.000Z'),
});

const D = (s: string) => new Date(s);

// ── 1. visibleAtFor ───────────────────────────────────────────────────────────
test('visibleAtFor: the lag is modelled only where db13 can support it', () => {
  // before the cutoff — no trustworthy _create_time, so the rule says so
  const before = visibleAtFor(D('2022-05-01T06:00:00Z'), D('2022-05-03T06:00:00Z'));
  assert.equal(before.rule, 'test_date_only');
  assert.deepEqual(before.visibleAt, D('2022-05-01T06:00:00Z'), 'the create time is NOT used before the cutoff');

  // after the cutoff, created later — greatest_v1 picks the creation time
  const after = visibleAtFor(D('2026-08-10T06:00:00Z'), D('2026-08-12T11:00:00Z'));
  assert.equal(after.rule, 'greatest_v1');
  assert.deepEqual(after.visibleAt, D('2026-08-12T11:00:00Z'));

  // a negative lag (created before its own test date) resolves to the test date, not backwards
  const negative = visibleAtFor(D('2026-08-10T06:00:00Z'), D('2026-08-09T06:00:00Z'));
  assert.equal(negative.rule, 'greatest_v1');
  assert.deepEqual(negative.visibleAt, D('2026-08-10T06:00:00Z'));

  // null create time — the lag is unknown, and the row is labelled
  const noCreate = visibleAtFor(D('2026-08-10T06:00:00Z'), null);
  assert.equal(noCreate.rule, 'test_date_only');
  assert.deepEqual(noCreate.visibleAt, D('2026-08-10T06:00:00Z'));

  // the cutoff itself is exclusive
  assert.equal(visibleAtFor(CREATE_TIME_CUTOFF, D('2024-01-01T00:00:00Z')).rule, 'test_date_only');
});

// ── 2. chooseY ────────────────────────────────────────────────────────────────
const LAB = (over: Partial<LabRow> = {}): LabRow => ({
  booking_id: 'b1', test_result_uid: 'r1', test_date: D('2026-08-11T04:00:00Z'),
  create_time: D('2026-08-11T09:00:00Z'), investigation_name: 'CRP', ...over,
});

test('chooseY: the first result the doctor could have SEEN, not the first one drawn', () => {
  const eventAt = D('2026-08-10T09:30:00Z');
  const noteDay = istDay(eventAt);              // 2026-08-10 IST

  // a test dated before the note day belongs to the history the note already had
  assert.equal(chooseY([LAB({ test_date: D('2026-08-08T04:00:00Z'), create_time: D('2026-08-11T04:00:00Z') })], eventAt, noteDay, 14), null);

  // a result already visible at the note is information the doctor HAD
  assert.equal(chooseY([LAB({ test_date: D('2026-08-10T02:00:00Z'), create_time: D('2026-08-10T03:00:00Z') })], eventAt, noteDay, 14), null);

  // beyond the horizon it is not this note's follow-up
  assert.equal(chooseY([LAB({ test_date: D('2026-08-28T04:00:00Z'), create_time: D('2026-08-28T04:00:00Z') })], eventAt, noteDay, 14), null);

  // the earliest by VISIBILITY wins, even when another was drawn first
  const drawnFirstSeenLast = LAB({ booking_id: 'b-early-draw', test_result_uid: 'r-a', test_date: D('2026-08-11T01:00:00Z'), create_time: D('2026-08-20T01:00:00Z') });
  const drawnLastSeenFirst = LAB({ booking_id: 'b-late-draw', test_result_uid: 'r-b', test_date: D('2026-08-12T01:00:00Z'), create_time: D('2026-08-12T02:00:00Z') });
  assert.equal(chooseY([drawnFirstSeenLast, drawnLastSeenFirst], eventAt, noteDay, 14)?.test_result_uid, 'r-b');

  // tie on visibility: booking_id then test_result_uid, stably
  const t1 = LAB({ booking_id: 'b2', test_result_uid: 'r9', create_time: D('2026-08-11T09:00:00Z') });
  const t2 = LAB({ booking_id: 'b1', test_result_uid: 'r9', create_time: D('2026-08-11T09:00:00Z') });
  const t3 = LAB({ booking_id: 'b1', test_result_uid: 'r2', create_time: D('2026-08-11T09:00:00Z') });
  assert.equal(chooseY([t1, t2, t3], eventAt, noteDay, 14)?.test_result_uid, 'r2');
  assert.equal(chooseY([t3, t2, t1], eventAt, noteDay, 14)?.test_result_uid, 'r2', 'input order does not decide');

  // a null investigation_name still counts — a result the spine cannot name is still a result
  const unnamed = LAB({ investigation_name: null, booking_id: 'b0', test_result_uid: 'r0' });
  assert.equal(chooseY([unnamed], eventAt, noteDay, 14)?.test_result_uid, 'r0');
});

// ── 3. oAfterAsOf ─────────────────────────────────────────────────────────────
test('oAfterAsOf: the IST day AFTER visibility, including a UTC evening that is already tomorrow in IST', () => {
  assert.equal(oAfterAsOf(D('2026-08-11T09:00:00Z')), '2026-08-12');
  // 19:30 UTC is 01:00 IST the NEXT day, so the day after is two calendar days on from the UTC date
  assert.equal(istDay(D('2026-08-11T19:30:00Z')), '2026-08-12');
  assert.equal(oAfterAsOf(D('2026-08-11T19:30:00Z')), '2026-08-13');
  // and the boundary itself: 18:29 UTC is still the 11th in IST
  assert.equal(istDay(D('2026-08-11T18:29:00Z')), '2026-08-11');
  assert.equal(oAfterAsOf(D('2026-08-11T18:29:00Z')), '2026-08-12');
  // month and year ends
  assert.equal(oAfterAsOf(D('2026-08-31T05:00:00Z')), '2026-09-01');
  assert.equal(oAfterAsOf(D('2026-12-31T05:00:00Z')), '2027-01-01');
});

// ── 4. yStatusFor ─────────────────────────────────────────────────────────────
test('yStatusFor: present, a conclusion, and not-yet-known are three different answers', () => {
  const eventAt = D('2026-08-10T09:30:00Z');
  assert.equal(yStatusFor(true, D('2026-08-11T00:00:00Z'), eventAt, 14), 'present');
  assert.equal(yStatusFor(false, D('2026-08-11T00:00:00Z'), eventAt, 14), 'pending');
  assert.equal(yStatusFor(false, D('2026-09-01T00:00:00Z'), eventAt, 14), 'missing_within_horizon');
  // exactly at the horizon is still pending — the conclusion needs the horizon to have PASSED
  assert.equal(yStatusFor(false, D('2026-08-24T09:30:00Z'), eventAt, 14), 'pending');
});

// ── 5. snapshotHash ───────────────────────────────────────────────────────────
test('snapshotHash: key order never decides', () => {
  const a = { version: 'member-state/1.2', problems: [{ x: 1, y: 2 }], asOf: '2026-08-10' };
  const b = { asOf: '2026-08-10', problems: [{ y: 2, x: 1 }], version: 'member-state/1.2' };
  assert.equal(snapshotHash(a), snapshotHash(b));
  assert.notEqual(snapshotHash(a), snapshotHash({ ...a, asOf: '2026-08-11' }));
  // array order DOES decide — a different order is a different state
  assert.notEqual(snapshotHash({ p: [1, 2] }), snapshotHash({ p: [2, 1] }));
});

// ── 6. the sweep ──────────────────────────────────────────────────────────────
test('phase 1: one snapshot and one triple per eligible event, and a second run writes nothing', async () => {
  reset();
  snapshotByDay = { '2026-08-10': { version: 'member-state/1.2', asOf: '2026-08-10', problems: [] } };
  reconstructThrowsFor = [];
  const { runJoinPhase1 } = await import('../cognition/join-sweep.ts');

  const first = await runJoinPhase1(100, DEPS());
  assert.deepEqual(first, { scanned: 1, opened: 1, unresolved: 0, deferred: 0 });
  assert.equal(snapshotRows.length, 1);
  assert.equal(tripleRows.length, 1);
  assert.equal(snapshotRows[0].cut_status, 'ok');
  assert.equal(snapshotRows[0].as_of, '2026-08-10', 'as_of is the note day in IST');
  assert.equal(snapshotRows[0].provenance, 'reconstructed', 'the first run has no first-run time');
  assert.equal(tripleRows[0].y_status, 'pending');
  assert.equal(tripleRows[0].resolve_status, 'resolved');
  assert.equal(tripleRows[0].o_before_id, snapshotRows[0].id);
  assert.equal(tripleRows[0].y_horizon_days, 14);

  issued.length = 0;
  const second = await runJoinPhase1(100, DEPS());
  assert.deepEqual(second, { scanned: 0, opened: 0, unresolved: 0, deferred: 0 }, 'the event already has a triple');
  assert.deepEqual(writes(), [], 'idempotent: nothing written on a re-run');
  assert.equal(snapshotRows.length, 1);
  assert.equal(tripleRows.length, 1);
});

test('phase 1: an unresolved note is closed with no snapshot; a db13 outage defers instead', async () => {
  reset();
  resolveMap = { [PRESC]: null };
  const { runJoinPhase1 } = await import('../cognition/join-sweep.ts');

  const out = await runJoinPhase1(100, DEPS());
  assert.deepEqual(out, { scanned: 1, opened: 1, unresolved: 1, deferred: 0 });
  assert.equal(snapshotRows.length, 0, 'no state is invented for a note with no individual');
  assert.equal(tripleRows[0].resolve_status, 'unresolved');
  assert.equal(tripleRows[0].individual_uid, null);
  assert.equal(tripleRows[0].y_status, 'missing_within_horizon', 'the row is closed');

  // an OUTAGE is not an answer: nothing is opened, and the event waits for a later run
  reset();
  resolveThrows = true;
  const deferred = await runJoinPhase1(100, DEPS());
  assert.deepEqual(deferred, { scanned: 1, opened: 0, unresolved: 0, deferred: 1 });
  assert.equal(tripleRows.length, 0, 'an outage must never close a note as unresolved');
  assert.deepEqual(writes(), []);
});

test('phase 1: a failed capture is recorded as an outage, not as an empty record', async () => {
  reset();
  snapshotByDay = {};
  reconstructThrowsFor = ['2026-08-10'];
  const { runJoinPhase1 } = await import('../cognition/join-sweep.ts');
  await runJoinPhase1(100, DEPS());
  assert.equal(snapshotRows.length, 1);
  assert.equal(snapshotRows[0].cut_status, 'context_fetch_failed');
  assert.equal(snapshotRows[0].snapshot_json, null, 'no invented state');
  assert.equal(snapshotRows[0].snapshot_hash, null);
  reconstructThrowsFor = [];
});

test('phase 2: sets present and the four y fields, and attaches a reaction when one exists', async () => {
  reset();
  snapshotByDay = { '2026-08-10': { version: 'member-state/1.2', asOf: '2026-08-10' } };
  // clinical_state_ref is the AUDIT ID — what B2a actually writes — not the uid.
  reactionRows = [{ id: 'reaction-1', clinical_state_ref: AUDIT_ID, after_cdmss: true, created_at: '2026-08-12T00:00:00.000Z' }];
  labRows = [
    { booking_id: 'b1', test_result_uid: 'r1', test_date: '2026-08-11T04:00:00.000Z', _create_time: '2026-08-11T09:00:00.000Z', investigation_name: 'CRP' },
  ];
  const { runJoinPhase1, runJoinPhase2 } = await import('../cognition/join-sweep.ts');
  await runJoinPhase1(100, DEPS());

  const out = await runJoinPhase2(200, DEPS());
  assert.equal(out.present, 1);
  assert.equal(out.reactions, 1);
  const t = tripleRows[0];
  assert.equal(t.y_status, 'present');
  assert.equal(t.y_kind, 'lab');
  assert.equal(t.y_ref, 'b1:r1');
  assert.equal(t.y_test_date, '2026-08-11T04:00:00.000Z');
  assert.equal(t.y_create_time, '2026-08-11T09:00:00.000Z');
  assert.equal(t.y_visible_at, '2026-08-11T09:00:00.000Z', 'greatest_v1 picks the creation time');
  assert.equal(t.y_visible_rule, 'greatest_v1');
  assert.equal(t.reaction_ref, 'reaction-1');
  assert.equal(t.reaction_after_cdmss, true);

  // the Y query really did run against db13, with the note day as its lower bound
  const yq = db13.find((q) => q.includes('test_digital_values_view'));
  assert.ok(yq, 'the Y query ran');
  assert.ok(yq!.includes("'2026-08-10 00:00:00'::timestamp"), 'lower bound is the note IST day');
  assert.ok(yq!.includes("interval '45 days'"), 'the read window, wider than the horizon');
});

test('phase 2: a reaction keyed on the uid — the old wrong key — does not attach', async () => {
  reset();
  snapshotByDay = { '2026-08-10': { version: 'member-state/1.2', asOf: '2026-08-10' } };
  // WM3 flag 4, measured in production on 8 Sep 2026: clinical_state_ref holds opd_note_audits.id,
  // never the uid. A row carrying the uid is not this event's reaction and must not be attached —
  // and the failure it guards is silent, because a join that matches nothing raises nothing.
  reactionRows = [{ id: 'reaction-wrong-key', clinical_state_ref: PRESC, after_cdmss: true, created_at: '2026-08-12T00:00:00.000Z' }];
  labRows = [{ booking_id: 'b1', test_result_uid: 'r1', test_date: '2026-08-11T04:00:00.000Z', _create_time: '2026-08-11T09:00:00.000Z', investigation_name: 'CRP' }];
  const { runJoinPhase1, runJoinPhase2 } = await import('../cognition/join-sweep.ts');
  await runJoinPhase1(100, DEPS());

  const out = await runJoinPhase2(200, DEPS());
  assert.equal(out.present, 1, 'the Y is still found');
  assert.equal(out.reactions, 0, 'but nothing attaches');
  assert.equal(tripleRows[0].reaction_ref, null);
  assert.equal(tripleRows[0].reaction_after_cdmss, null);

  // …and the same row, re-keyed onto the audit id, does attach.
  reset();
  reactionRows = [{ id: 'reaction-right-key', clinical_state_ref: AUDIT_ID, after_cdmss: true, created_at: '2026-08-12T00:00:00.000Z' }];
  labRows = [{ booking_id: 'b1', test_result_uid: 'r1', test_date: '2026-08-11T04:00:00.000Z', _create_time: '2026-08-11T09:00:00.000Z', investigation_name: 'CRP' }];
  await runJoinPhase1(100, DEPS());
  const attached = await runJoinPhase2(200, DEPS());
  assert.equal(attached.reactions, 1);
  assert.equal(tripleRows[0].reaction_ref, 'reaction-right-key');
});

test('phase 2: nothing within the horizon is a conclusion only once the horizon has passed', async () => {
  reset();
  snapshotByDay = { '2026-08-10': { version: 'member-state/1.2' } };
  labRows = [];
  const { runJoinPhase1, runJoinPhase2 } = await import('../cognition/join-sweep.ts');
  await runJoinPhase1(100, DEPS());

  // "now" in DEPS is 8 Sep, well past the 14-day horizon on a 10 Aug event
  const out = await runJoinPhase2(200, DEPS());
  assert.equal(out.missing, 1);
  assert.equal(tripleRows[0].y_status, 'missing_within_horizon');

  // inside the horizon the same absence is still pending
  reset();
  await runJoinPhase1(100, DEPS());
  const early = await runJoinPhase2(200, { ...DEPS(), now: () => new Date('2026-08-12T00:00:00.000Z') });
  assert.equal(early.stillPending, 1);
  assert.equal(tripleRows[0].y_status, 'pending');
});

test('phase 3: O_after is captured as of the day AFTER visibility, and a failed capture is repairable', async () => {
  reset();
  snapshotByDay = {
    '2026-08-10': { version: 'member-state/1.2', asOf: '2026-08-10' },
    '2026-08-12': { version: 'member-state/1.2', asOf: '2026-08-12' },
  };
  labRows = [{ booking_id: 'b1', test_result_uid: 'r1', test_date: '2026-08-11T04:00:00.000Z', _create_time: '2026-08-11T09:00:00.000Z', investigation_name: 'CRP' }];
  const { runJoinPhase1, runJoinPhase2, runJoinPhase3, runJoinRetryFailed } = await import('../cognition/join-sweep.ts');
  await runJoinPhase1(100, DEPS());
  await runJoinPhase2(200, DEPS());

  const out = await runJoinPhase3(100, DEPS());
  assert.equal(out.closed, 1);
  assert.equal(tripleRows[0].o_after_as_of, '2026-08-12', 'visible 11 Aug ⇒ as_of 12 Aug');
  const after = snapshotRows.find((s) => s.id === tripleRows[0].o_after_id)!;
  assert.equal(after.cut_status, 'ok');
  assert.equal(after.as_of, '2026-08-12');

  // a re-run closes nothing new
  issued.length = 0;
  const again = await runJoinPhase3(100, DEPS());
  assert.equal(again.scanned, 0);
  assert.deepEqual(writes(), [], 'idempotent');

  // now the failed-capture path, end to end
  reset();
  snapshotByDay = { '2026-08-10': { version: 'member-state/1.2' } };
  reconstructThrowsFor = ['2026-08-12'];
  labRows = [{ booking_id: 'b1', test_result_uid: 'r1', test_date: '2026-08-11T04:00:00.000Z', _create_time: '2026-08-11T09:00:00.000Z', investigation_name: 'CRP' }];
  await runJoinPhase1(100, DEPS());
  await runJoinPhase2(200, DEPS());
  const failed = await runJoinPhase3(100, DEPS());
  assert.equal(failed.failed, 1);
  assert.equal(failed.closed, 0);
  const placeholder = snapshotRows.find((s) => s.id === tripleRows[0].o_after_id)!;
  assert.equal(placeholder.cut_status, 'context_fetch_failed');
  assert.equal(placeholder.snapshot_json, null);

  // …and the retry fills the placeholder in once the spine answers
  reconstructThrowsFor = [];
  snapshotByDay['2026-08-12'] = { version: 'member-state/1.2', asOf: '2026-08-12' };
  const repaired = await runJoinRetryFailed(100, DEPS());
  assert.equal(repaired.phase3?.repaired, 1);
  assert.equal(snapshotRows.find((s) => s.id === tripleRows[0].o_after_id)!.cut_status, 'ok');
});

// ── 7. provenance ─────────────────────────────────────────────────────────────
test('provenance: the first runs are reconstructed; an event that arrives later is captured', async () => {
  assert.equal(provenanceFor(D('2026-08-10T00:00:00Z'), null), 'reconstructed', 'no first run yet');
  assert.equal(provenanceFor(D('2026-08-10T00:00:00Z'), D('2026-09-01T00:00:00Z')), 'reconstructed', 'the event predates the join');
  assert.equal(provenanceFor(D('2026-09-02T00:00:00Z'), D('2026-09-01T00:00:00Z')), 'captured');

  reset();
  snapshotByDay = { '2026-08-10': { version: 'member-state/1.2' }, '2026-09-05': { version: 'member-state/1.2' } };
  const { runJoinPhase1 } = await import('../cognition/join-sweep.ts');
  await runJoinPhase1(100, DEPS());
  assert.equal(tripleRows[0].provenance, 'reconstructed');

  // a second event, created after the first triple was written, is captured
  shadowEvents.push({
    trigger_kind: 'opd_note_audited', event_ref: PRESC2, event_at: '2026-09-05T09:30:00.000Z',
    // AFTER the first triple's created_at in this harness (06:00) — that is what makes it captured
    created_at: '2026-09-08T07:00:00.000Z', eligible: true, policy_version: 'burden-policy/0.1',
  });
  await runJoinPhase1(100, DEPS());
  const second = tripleRows.find((r) => r.event_ref === PRESC2)!;
  assert.equal(second.provenance, 'captured');
});

// ── 8. the shape of the sweep (structural) ────────────────────────────────────
test('the sweep calls the frozen reconstruct and never reaches into the as-of cut', async () => {
  const src = readFileSync('lib/cognition/join-sweep.ts', 'utf8');
  // Comments legitimately DISCUSS the rule they document, so the prohibitions read code only.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /import \{[^}]*getMemberSnapshotAsOf[^}]*\} from '\.\.\/member-state\/member-state'/,
    'the frozen as-of reconstruct is imported from lib/member-state');
  assert.ok(!/from '\.\.\/as-of-core'/.test(code), 'never imports lib/as-of-core directly');
  assert.ok(!/applyAsOfCut/.test(code), 'and never calls the cut function');

  const mod = await import('../cognition/join-sweep.ts');
  assert.equal((mod as Record<string, unknown>).applyAsOfCut, undefined, 'the module exports no as-of cut');

  // the walk's constants are read, not restated
  assert.match(code, /WORLD_MODEL_WALK_VERSION/);
  assert.match(code, /MEMBER_STATE_VERSION/);

  // the DDL's three fixed literals are in both files
  const migration = readFileSync('migrations/0055_cognition_join.sql', 'utf8');
  const route = readFileSync('app/api/admin/migrate-cognition-join/route.ts', 'utf8');
  for (const s of [migration, route]) {
    assert.ok(s.includes('y_horizon_days INTEGER NOT NULL DEFAULT 14'));
    assert.ok(s.includes('o_before_id UUID REFERENCES cognition_snapshots(id)'));
    assert.ok(s.includes('cognition_triples_identity_uq'));
  }

  // the cron entry, one hour after the shadow sweep
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };
  const entry = vercel.crons.find((c) => c.path === '/api/admin/wm3-join?auto=1');
  assert.ok(entry, 'the join cron is registered');
  assert.equal(entry!.schedule, '0 1,7,13,19 * * *');
});
