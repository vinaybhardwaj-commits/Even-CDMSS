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
let rawNoteRows: Row[] = [];
let stabilityRuns: Row[] = [];
let resolveMap: Record<string, string | null> = {};
let resolveThrows = false;
let rawNotesThrow = false;
let seq = 0;

function reset(): void {
  issued.length = 0; db13.length = 0;
  snapshotRows = []; tripleRows = []; reactionRows = []; labRows = [];
  rawNoteRows = []; stabilityRuns = [];
  auditRows = [{ id: AUDIT_ID, uid: PRESC }];
  resolveThrows = false; rawNotesThrow = false; seq = 0;
  resolveMap = { [PRESC]: UID, [PRESC2]: UID };
  shadowEvents = [{
    trigger_kind: 'opd_note_audited', event_ref: PRESC, event_at: '2026-08-10T09:30:00.000Z',
    created_at: '2026-08-10T10:00:00.000Z', eligible: true, policy_version: 'burden-policy/0.1',
    reason: 'would_ask', microworld: 'headache',
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
    // The raw-note candidate read. Checked FIRST: it also names "individuals-prescriptions", and the
    // identity read below would otherwise swallow it.
    if (/presenting_complaints/.test(query)) {
      if (rawNotesThrow) return new Response('db13 down', { status: 500 });
      return okJson(metabaseBody(rawNoteRows));
    }
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
    const [trigger, eventRef, eventAt, uid, microworld, provenance, resolveStatus, oBefore, yStatus, horizon, policyV, schemaV, eraStatus] = params as unknown[];
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
      policy_version: policyV, schema_version: schemaV, era_status: eraStatus,
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
    // The era predicate is the ONLY difference between the two forms of this query, so the fake
    // reads it out of the SQL rather than being told which one was asked for.
    const stale = /e\.eligible = FALSE/.test(text);
    const eraOk = (e: Row) => (stale
      ? e.eligible === false && e.reason === 'stale_era' && e.microworld === 'headache'
      : e.eligible === true);
    return okJson(neonBody(shadowEvents.filter((e) => eraOk(e) && e.policy_version === policyV
      && e.trigger_kind === trigger
      && !tripleRows.some((t) => t.trigger_kind === e.trigger_kind && t.event_ref === e.event_ref && t.schema_version === schemaV))));
  }
  if (/FROM cognition_triples\b/i.test(text)) {
    // tripleExistsForNote — the event_ref alone, across every trigger kind.
    if (/^\s*SELECT 1 FROM cognition_triples\b/i.test(text)) {
      const [eventRef, schemaV] = params as unknown[];
      return okJson(neonBody(tripleRows.filter((r) => r.event_ref === eventRef && r.schema_version === schemaV).slice(0, 1)));
    }
    // rawNoteCursor — the OLDEST raw triple's event time.
    if (/min\(event_at\)/i.test(text)) {
      const [trigger, schemaV] = params as unknown[];
      const mine = tripleRows.filter((r) => r.trigger_kind === trigger && r.schema_version === schemaV);
      const min = mine.map((r) => String(r.event_at)).sort()[0] ?? null;
      return okJson(neonBody([{ t: min }]));
    }
    // the stability sample — triples joined to their O_before capture.
    if (/JOIN cognition_snapshots s ON s\.id = t\.o_before_id/i.test(text)) {
      const [schemaV, limit] = params as unknown[];
      const out: Row[] = [];
      for (const t of tripleRows) {
        if (t.schema_version !== schemaV || t.resolve_status !== 'resolved' || t.o_before_id == null) continue;
        const snap = snapshotRows.find((sr) => sr.id === t.o_before_id && sr.cut_status === 'ok' && sr.schema_version === schemaV);
        if (!snap) continue;
        let computedAt: string | null = null;
        try { computedAt = (JSON.parse(String(snap.snapshot_json)) as { computedAt?: string }).computedAt ?? null; } catch { computedAt = null; }
        out.push({
          triple_id: t.id, individual_uid: t.individual_uid, as_of: snap.as_of,
          snapshot_hash: snap.snapshot_hash, computed_at: computedAt,
        });
        if (out.length >= Number(limit)) break;
      }
      return okJson(neonBody(out));
    }
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

  if (/^\s*INSERT INTO cognition_join_stability\b/i.test(text)) {
    const [sampleN, matchedN, failedN, tripleIds, mismatchedIds, walkV, msV, schemaV] = params as unknown[];
    stabilityRuns.push({
      id: `stability-${++seq}`, run_at: '2026-09-09T06:00:00.000Z', sample_n: sampleN,
      matched_n: matchedN, failed_n: failedN, triple_ids: tripleIds, mismatched_ids: mismatchedIds,
      walk_version: walkV, member_state_version: msV, schema_version: schemaV,
    });
    return okJson(neonBody([]));
  }
  if (/FROM cognition_join_stability\b/i.test(text)) {
    const last = stabilityRuns[stabilityRuns.length - 1];
    return okJson(neonBody(last ? [{ run_at: last.run_at, sample_n: last.sample_n, matched_n: last.matched_n, failed_n: last.failed_n }] : []));
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
  assert.deepEqual(first, { scanned: 1, opened: 1, unresolved: 0, deferred: 0, budgetStopped: false });
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
  assert.deepEqual(second, { scanned: 0, opened: 0, unresolved: 0, deferred: 0, budgetStopped: false }, 'the event already has a triple');
  assert.deepEqual(writes(), [], 'idempotent: nothing written on a re-run');
  assert.equal(snapshotRows.length, 1);
  assert.equal(tripleRows.length, 1);
});

test('phase 1: an unresolved note is closed with no snapshot; a db13 outage defers instead', async () => {
  reset();
  resolveMap = { [PRESC]: null };
  const { runJoinPhase1 } = await import('../cognition/join-sweep.ts');

  const out = await runJoinPhase1(100, DEPS());
  assert.deepEqual(out, { scanned: 1, opened: 1, unresolved: 1, deferred: 0, budgetStopped: false });
  assert.equal(snapshotRows.length, 0, 'no state is invented for a note with no individual');
  assert.equal(tripleRows[0].resolve_status, 'unresolved');
  assert.equal(tripleRows[0].individual_uid, null);
  assert.equal(tripleRows[0].y_status, 'missing_within_horizon', 'the row is closed');

  // an OUTAGE is not an answer: nothing is opened, and the event waits for a later run
  reset();
  resolveThrows = true;
  const deferred = await runJoinPhase1(100, DEPS());
  assert.deepEqual(deferred, { scanned: 1, opened: 0, unresolved: 0, deferred: 1, budgetStopped: false });
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

// ── 9. Fix 2 — one tick must finish ───────────────────────────────────────────
test('the caps and the budget fit one invocation, and the route declares the box they fit in', async () => {
  const sweep = await import('../cognition/join-sweep.ts');
  // Re-sized 8 Sep 2026 after a manual full run returned 504 with phase 3 never started.
  assert.equal(sweep.PHASE1_CAP, 50);
  assert.equal(sweep.PHASE2_CAP, 60);
  assert.equal(sweep.PHASE3_CAP, 30);
  assert.equal(sweep.BACKFILL_CAP, 50, 'the backfill cap is unchanged');
  assert.equal(sweep.PACING_MS, 100, 'the pacing pause is unchanged');
  assert.equal(sweep.SWEEP_BUDGET_MS, 240_000);

  // WM3 fix 3 — phase 0 joins the same one invocation, so its cron cap is the smallest of the four.
  assert.equal(sweep.RAW_PHASE_CAP, 40);
  assert.equal(sweep.RAW_MANUAL_CAP, 100);
  assert.equal(sweep.STABILITY_SAMPLE_N, 30);
  assert.ok(sweep.RAW_PHASE_CAP <= sweep.PHASE1_CAP,
    'the phase that reads an unbounded pool must not out-cap the one draining a finite queue');

  // The budget must leave headroom inside the route's box, or it guards nothing.
  const route = readFileSync('app/api/admin/wm3-join/route.ts', 'utf8');
  const m = /export const maxDuration = (\d+);/.exec(route);
  assert.ok(m, 'the route declares a maxDuration');
  const boxMs = Number(m![1]) * 1000;
  assert.ok(sweep.SWEEP_BUDGET_MS < boxMs, `budget ${sweep.SWEEP_BUDGET_MS}ms must fit inside the ${boxMs}ms box`);
  assert.ok(boxMs - sweep.SWEEP_BUDGET_MS >= 30_000, 'and leave headroom for the response');

  // the same box the sibling sweep runs in
  const shadow = readFileSync('app/api/admin/shadow-sweep/route.ts', 'utf8');
  assert.match(shadow, new RegExp(`export const maxDuration = ${m![1]};`),
    'the join runs in the same box as the shadow sweep it follows');
});

test('the budget stops a run between items, and names the phase it stopped in', async () => {
  reset();
  snapshotByDay = { '2026-08-10': { version: 'member-state/1.2' }, '2026-09-05': { version: 'member-state/1.2' } };
  shadowEvents.push({
    trigger_kind: 'opd_note_audited', event_ref: PRESC2, event_at: '2026-09-05T09:30:00.000Z',
    created_at: '2026-09-08T07:00:00.000Z', eligible: true, policy_version: 'burden-policy/0.1',
  });
  const { runJoinPhase1, runJoinSweep } = await import('../cognition/join-sweep.ts');

  // a clock that is already past the deadline: the first item is refused, nothing is written
  const spent = await runJoinPhase1(100, { ...DEPS(), deadlineAt: 0 });
  assert.equal(spent.budgetStopped, true);
  assert.equal(spent.opened, 0, 'the check happens BEFORE the item, so none was taken');
  assert.deepEqual(writes(), [], 'a run that stops on arrival writes nothing');

  // A clock the WORK advances: the budget expires while the first item is being captured, so the
  // second check refuses. Driven off the capture rather than off a call count, which would couple
  // the test to how many times the sweep happens to consult the clock.
  const deadline = 1_000_000;
  let clock = deadline - 1;
  const out = await runJoinPhase1(100, {
    ...DEPS(), deadlineAt: deadline,
    now: () => new Date(clock),
    reconstruct: async () => { clock = deadline + 1; return { version: 'member-state/1.2' }; },
  });
  assert.equal(out.budgetStopped, true);
  assert.equal(out.opened, 1, 'the item it did start is finished and committed');
  assert.equal(tripleRows.length, 1);

  // the whole sweep names the phase, and does not run the phases after it
  reset();
  snapshotByDay = { '2026-08-10': { version: 'member-state/1.2' } };
  const stopped = await runJoinSweep({ ...DEPS(), deadlineAt: 0 });
  assert.equal(stopped.budget_stopped, 'phase1');
  assert.equal(stopped.phase1?.budgetStopped, true);
  assert.equal(stopped.phase2, null, 'phase 2 never ran');
  assert.equal(stopped.phase3, null, 'nor phase 3');
  assert.equal(stopped.ok, true, 'a spent budget is a bounded run, not a failure');

  // …and with budget to spare, all three phases run and the field stays false
  reset();
  snapshotByDay = { '2026-08-10': { version: 'member-state/1.2' } };
  const full = await runJoinSweep(DEPS());
  assert.equal(full.budget_stopped, false);
  assert.ok(full.phase1 && full.phase2 && full.phase3, 'all three phases ran');
});

// ── 10. WM3 fix 3 · N6 the stale-era backfill ─────────────────────────────────
test('the stale era: only stale_era refusals are re-opened, and the triple says so', async () => {
  reset();
  snapshotByDay = {
    '2026-08-10': { version: 'member-state/1.2', asOf: '2026-08-10' },
    '2026-07-01': { version: 'member-state/1.2', asOf: '2026-07-01' },
    '2026-06-01': { version: 'member-state/1.2', asOf: '2026-06-01' },
  };
  const STALE = 'presc_stale1';
  const NODOC = 'presc_nodoc1';
  resolveMap = { [PRESC]: UID, [STALE]: UID, [NODOC]: UID };
  shadowEvents.push(
    { trigger_kind: 'opd_note_audited', event_ref: STALE, event_at: '2026-07-01T09:30:00.000Z',
      created_at: '2026-07-01T10:00:00.000Z', eligible: false, reason: 'stale_era',
      microworld: 'headache', policy_version: 'burden-policy/0.1' },
    // A DIFFERENT refusal. `eligible = FALSE` alone would sweep this up, and it must not: the
    // policy refused it because the note has no doctor, which is not a statement about the era.
    { trigger_kind: 'opd_note_audited', event_ref: NODOC, event_at: '2026-06-01T09:30:00.000Z',
      created_at: '2026-06-01T10:00:00.000Z', eligible: false, reason: 'no_doctor',
      microworld: 'headache', policy_version: 'burden-policy/0.1' },
  );
  const { runJoinPhase1, runJoinBackfill } = await import('../cognition/join-sweep.ts');

  const stale = await runJoinPhase1(100, DEPS(), 'stale');
  assert.equal(stale.scanned, 1, 'exactly one candidate — the no_doctor row is not an era refusal');
  assert.equal(stale.opened, 1);
  assert.equal(tripleRows.length, 1);
  assert.equal(tripleRows[0].event_ref, STALE);
  assert.equal(tripleRows[0].era_status, 'stale');
  assert.equal(tripleRows[0].y_status, 'pending', 'everything after phase 1 treats it as any other triple');

  // …and the current pass still sees only the eligible one, carrying era_status 'current'.
  const current = await runJoinPhase1(100, DEPS(), 'current');
  assert.equal(current.opened, 1);
  assert.equal(tripleRows.find((r) => r.event_ref === PRESC)!.era_status, 'current');

  // the backfill runs both passes only when asked, and reports them apart
  reset();
  resolveMap = { [PRESC]: UID, [STALE]: UID };
  shadowEvents.push({ trigger_kind: 'opd_note_audited', event_ref: STALE, event_at: '2026-07-01T09:30:00.000Z',
    created_at: '2026-07-01T10:00:00.000Z', eligible: false, reason: 'stale_era',
    microworld: 'headache', policy_version: 'burden-policy/0.1' });

  const plain = await runJoinBackfill(50, DEPS());
  assert.equal(plain.phase1?.opened, 1);
  assert.equal(plain.phase1_stale, null, 'without the flag the stale backlog is not even looked at');
  assert.equal(tripleRows.length, 1);

  const withStale = await runJoinBackfill(50, DEPS(), { include_stale_era: true });
  assert.equal(withStale.phase1?.opened, 0, 'the current backlog is already drained');
  assert.equal(withStale.phase1_stale?.opened, 1);
  assert.equal(tripleRows.length, 2);
  assert.deepEqual(
    tripleRows.map((r) => [r.event_ref, r.era_status]).sort(),
    [[PRESC, 'current'], [STALE, 'stale']].sort());
});

// ── 11. WM3 fix 3 · N8 the raw-note trigger ───────────────────────────────────
const RAW_UID = 'presc_raw001';

test('phase 0: a note with a triple is skipped, a note without one is opened as unaudited', async () => {
  reset();
  snapshotByDay = {
    '2026-08-10': { version: 'member-state/1.2', asOf: '2026-08-10' },
    '2026-09-01': { version: 'member-state/1.2', asOf: '2026-09-01' },
  };
  // PRESC already has an audit-trigger triple (phase 1 opens it below); RAW_UID has none.
  rawNoteRows = [
    { uid: RAW_UID, individual_uid: UID, doctor_uid: 'doc_1', event_at: '2026-09-01T09:30:00Z' },
    { uid: PRESC, individual_uid: UID, doctor_uid: 'doc_1', event_at: '2026-08-10T09:30:00Z' },
  ];
  const { runJoinPhase0, runJoinPhase1 } = await import('../cognition/join-sweep.ts');
  await runJoinPhase1(100, DEPS());
  assert.equal(tripleRows.length, 1);

  const out = await runJoinPhase0(100, DEPS());
  assert.equal(out.scanned, 2);
  assert.equal(out.opened, 1);
  assert.equal(out.skipped_existing, 1, 'one triple per note, and the audit-trigger triple wins');
  assert.equal(out.skipped_bad_row, 0);
  assert.equal(out.error, null);
  assert.equal(tripleRows.length, 2);

  const raw = tripleRows.find((r) => r.event_ref === RAW_UID)!;
  assert.equal(raw.trigger_kind, 'opd_note_matched');
  assert.equal(raw.era_status, 'unaudited');
  assert.equal(raw.provenance, 'reconstructed', 'a note matched by a query run later was never captured live');
  assert.equal(raw.microworld, 'headache');
  assert.equal(raw.resolve_status, 'resolved');
  assert.equal(raw.y_status, 'pending');
  assert.equal(raw.y_horizon_days, 14);
  assert.equal(raw.individual_uid, UID, 'the identity came off the row, with no second db13 round trip');
  // O_before was reconstructed at the note's IST day
  const before = snapshotRows.find((sn) => sn.id === raw.o_before_id)!;
  assert.equal(before.as_of, '2026-09-01');
  assert.equal(before.cut_status, 'ok');

  // …and a second run opens nothing new
  issued.length = 0;
  const again = await runJoinPhase0(100, DEPS());
  assert.equal(again.opened, 0);
  assert.equal(again.skipped_existing, 2);
  assert.deepEqual(writes(), [], 'idempotent');
});

test('phase 0: a bad row is counted and never inserted, a row with no individual is closed, and db13 never throws out', async () => {
  reset();
  snapshotByDay = { '2026-09-01': { version: 'member-state/1.2' } };
  rawNoteRows = [
    { uid: '!!', individual_uid: UID, doctor_uid: 'doc_1', event_at: '2026-09-01T09:30:00Z' },
    { uid: 'presc_baddate', individual_uid: UID, doctor_uid: 'doc_1', event_at: 'not-a-time' },
    { uid: 'presc_noind0', individual_uid: '', doctor_uid: 'doc_1', event_at: '2026-09-01T09:30:00Z' },
  ];
  const { runJoinPhase0 } = await import('../cognition/join-sweep.ts');

  const out = await runJoinPhase0(100, DEPS());
  assert.equal(out.skipped_bad_row, 2, 'a uid that is not a uid, and a timestamp that will not parse');
  assert.equal(out.opened, 1);
  assert.equal(out.unresolved, 1);
  const closed = tripleRows.find((r) => r.event_ref === 'presc_noind0')!;
  assert.equal(closed.resolve_status, 'unresolved');
  assert.equal(closed.individual_uid, null);
  assert.equal(closed.o_before_id, null, 'no state is invented for a note with no individual');
  assert.equal(closed.y_status, 'missing_within_horizon');
  assert.equal(closed.era_status, 'unaudited');
  assert.equal(snapshotRows.length, 0);

  // a db13 outage ENDS phase 0 and reports itself — it does not throw, and it does not look empty
  reset();
  rawNotesThrow = true;
  const failed = await runJoinPhase0(100, DEPS());
  assert.ok(failed.error, 'the phase says it could not look');
  assert.equal(failed.scanned, 0);
  assert.equal(failed.opened, 0);
  assert.deepEqual(writes(), []);

  // …and the sweep behind it still runs its three phases
  reset();
  rawNotesThrow = true;
  snapshotByDay = { '2026-08-10': { version: 'member-state/1.2' } };
  const { runJoinSweep } = await import('../cognition/join-sweep.ts');
  const sweep = await runJoinSweep(DEPS());
  assert.equal(sweep.ok, true, 'a db13 failure in phase 0 is not the run failing');
  assert.ok(sweep.phase0?.error);
  assert.ok(sweep.phase1 && sweep.phase2 && sweep.phase3, 'phases 1 to 3 all ran');
  assert.equal(sweep.phase1?.opened, 1);
});

test('phase 0 cursor: the next run asks for notes strictly older than the oldest raw triple', async () => {
  reset();
  snapshotByDay = { '2026-09-01': { version: 'member-state/1.2' } };
  rawNoteRows = [{ uid: RAW_UID, individual_uid: UID, doctor_uid: 'doc_1', event_at: '2026-09-01T09:30:00Z' }];
  const { runJoinPhase0 } = await import('../cognition/join-sweep.ts');

  await runJoinPhase0(100, DEPS());
  const firstQuery = db13.find((q) => q.includes('presenting_complaints'))!;
  assert.ok(!firstQuery.includes('p.timestamp <'), 'the first run has no cursor');
  assert.ok(firstQuery.includes("p.timestamp >= '2024-01-01'"), 'and it never reaches below the measured floor');

  db13.length = 0;
  await runJoinPhase0(100, DEPS());
  const secondQuery = db13.find((q) => q.includes('presenting_complaints'))!;
  assert.ok(secondQuery.includes("p.timestamp < '2026-09-01T09:30:00Z'"),
    'the cursor is the OLDEST raw triple, read to the second');
});

test('the raw rule is its own rule, and the SQL is the seven fields that were measured', async () => {
  const mw = await import('../cognition/microworld.ts');
  const store = await import('../cognition/join-store.ts');
  assert.equal(mw.RAW_MATCH_RULE, 'headache-raw/1');
  assert.equal(mw.MATCH_RULE, 'headache-strict/1', 'the audit-text rule is untouched');
  assert.equal(mw.HEADACHE_RAW_PATTERN, '(headache|cephalgia|cephalalgia|migraine)');

  const sqlText = store.listRawNoteCandidatesSql(null, 40);
  for (const col of ['presenting_complaints', 'general_practitioner_prescription__presenting_complaints',
    'assessments', 'reason_for_consultation', 'visit_notes', 'relevant_medical_history', 'free_text']) {
    assert.ok(sqlText.includes(col), `the rule names ${col}`);
  }
  assert.ok(sqlText.includes("~* '(headache|cephalgia|cephalalgia|migraine)'"));
  assert.ok(sqlText.includes('p.is_draft = false'));
  assert.ok(!/doctor_uid\s*=/.test(sqlText), 'no doctor filter — the rule string names what was measured');
  assert.ok(sqlText.includes('LIMIT 120'), 'over-fetches 3x the limit, because some rows already have a triple');
  assert.ok(sqlText.includes('ORDER BY p.timestamp DESC'), 'newest first');

  // a cursor that is not a whole-second ISO instant is never inlined
  assert.throws(() => store.listRawNoteCandidatesSql("2026-09-01'; DROP TABLE x; --", 40), /bad beforeTs/);
  assert.throws(() => store.listRawNoteCandidatesSql('2026-09-01T09:30:00.000Z', 40), /bad beforeTs/);
  assert.ok(store.listRawNoteCandidatesSql('2026-09-01T09:30:00Z', 40).includes("p.timestamp < '2026-09-01T09:30:00Z'"));
});

// ── 12. WM3 fix 3 · N5 the stability check ────────────────────────────────────
test('stability: a re-reconstruction that differs is a mismatch, one that throws is a failure', async () => {
  reset();
  const SNAP_A = { version: 'member-state/1.2', asOf: '2026-08-10', computedAt: '2026-09-08T06:00:00.000Z', problems: [] };
  const SNAP_B = { version: 'member-state/1.2', asOf: '2026-09-05', computedAt: '2026-09-08T06:00:00.000Z', problems: [] };
  snapshotByDay = { '2026-08-10': SNAP_A, '2026-09-05': SNAP_B };
  shadowEvents.push({
    trigger_kind: 'opd_note_audited', event_ref: PRESC2, event_at: '2026-09-05T09:30:00.000Z',
    created_at: '2026-09-05T10:00:00.000Z', eligible: true, policy_version: 'burden-policy/0.1',
    reason: 'would_ask', microworld: 'headache',
  });
  const { runJoinPhase1, runJoinStability } = await import('../cognition/join-sweep.ts');
  await runJoinPhase1(100, DEPS());
  assert.equal(tripleRows.length, 2);
  const tripleA = tripleRows.find((r) => r.event_ref === PRESC)!.id;
  const tripleB = tripleRows.find((r) => r.event_ref === PRESC2)!.id;

  // one day re-reads the same, the other has moved underneath us
  issued.length = 0;
  const out = await runJoinStability({
    ...DEPS(),
    reconstruct: async (_uid: string, asOf: string) => (asOf === '2026-08-10'
      ? SNAP_A
      : { ...SNAP_B, problems: [{ normalizedConcept: { raw: 'migraine' } }] }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.sample_n, 2);
  assert.equal(out.matched_n, 1);
  assert.equal(out.failed_n, 0);
  assert.deepEqual(out.mismatched_ids, [tripleB]);
  assert.equal(out.match_rate, 0.5);
  assert.ok(!issued.some((q) => /^\s*(INSERT|UPDATE) .*cognition_snapshots/i.test(q.text)),
    'the check READS the spine and writes nothing back — overwriting would destroy the evidence');
  assert.equal(stabilityRuns.length, 1);
  assert.equal(Number(stabilityRuns[0].sample_n), 2);
  assert.deepEqual(JSON.parse(String(stabilityRuns[0].triple_ids)).sort(), [tripleA, tripleB].sort());
  assert.deepEqual(JSON.parse(String(stabilityRuns[0].mismatched_ids)), [tripleB]);

  // a THROW is a failure, never a mismatch, and it comes out of the denominator
  const thrown = await runJoinStability({
    ...DEPS(),
    reconstruct: async (_uid: string, asOf: string) => {
      if (asOf === '2026-09-05') throw new Error('db13 down');
      return SNAP_A;
    },
  });
  assert.equal(thrown.sample_n, 2);
  assert.equal(thrown.matched_n, 1);
  assert.equal(thrown.failed_n, 1);
  assert.deepEqual(thrown.mismatched_ids, [], 'a reading we could not take is not evidence of drift');
  assert.equal(thrown.match_rate, 1, 'matched / (sampled − failed)');

  // every read failing is NOT a 0% match rate — it is nothing measured
  const allFailed = await runJoinStability({
    ...DEPS(), reconstruct: async () => { throw new Error('db13 down'); },
  });
  assert.equal(allFailed.failed_n, 2);
  assert.equal(allFailed.match_rate, null, 'zero over zero is "not measured", never 0%');
});

test('stability: the sample is deterministic, and the readout reads the last run', async () => {
  reset();
  const SNAP = { version: 'member-state/1.2', asOf: '2026-08-10', computedAt: '2026-09-08T06:00:00.000Z' };
  snapshotByDay = { '2026-08-10': SNAP };
  const { runJoinPhase1, runJoinStability } = await import('../cognition/join-sweep.ts');
  await runJoinPhase1(100, DEPS());

  const a = await runJoinStability({ ...DEPS(), reconstruct: async () => SNAP });
  const b = await runJoinStability({ ...DEPS(), reconstruct: async () => SNAP });
  assert.deepEqual(JSON.parse(String(stabilityRuns[0].triple_ids)), JSON.parse(String(stabilityRuns[1].triple_ids)),
    're-running compares the same rows, or the two rates are not comparable');
  assert.equal(a.match_rate, 1);
  assert.equal(b.match_rate, 1);

  const { latestStabilityRun } = await import('../cognition/join-store.ts');
  const latest = await latestStabilityRun();
  assert.equal(latest?.sample_n, 1);
  assert.equal(latest?.matched_n, 1);
  assert.equal(latest?.match_rate, 1);
});
