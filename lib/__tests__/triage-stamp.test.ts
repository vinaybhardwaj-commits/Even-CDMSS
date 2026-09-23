import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flattenActionQueueItems, parseActionQueueQuery, readActionQueue } from '../triage/queue-read.ts';
import { resolveStampRequestId, sameQueueItem, triageWriteEnabled, validateTriageStamp } from '../triage/stamp-schema.ts';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';

type Row = Record<string, unknown>;
const issued: { text: string; params: unknown[] }[] = [];
const stamps: Row[] = [];
const triageRows: Row[] = [];
let gov: Row | null = null;

function resetStore(): void {
  issued.length = 0;
  stamps.length = 0;
  triageRows.length = 0;
  gov = null;
}

function pgTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  const text = String(value ?? '').trim();
  if (!text || text === '{}') return [];
  if (text.startsWith('{') && text.endsWith('}')) {
    return text.slice(1, -1).split(',').map((part) => part.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  }
  return [text];
}

function decisionInserts() {
  return issued.filter((query) => /INSERT INTO opd_audit_triage/.test(query.text));
}
function signalInserts() {
  return issued.filter((query) => /INSERT INTO opd_gov_signal\b/.test(query.text));
}

const finding = (subject: string, findingRef: string) => JSON.stringify([{
  subject,
  rationale: 'Interaction requires review',
  verdict: 'unsafe',
  domain: 'prescribing',
  signal_type: 'drug_interaction',
  finding_ref: findingRef,
  informational: false,
  citation_ids: [],
}]);

/** note_date is what the queue SQL window filters. The mock applies that filter. */
const QUEUE_AUDITS: Row[] = [
  {
    id: '99999999-8888-7777-6666-555555555555',
    doctor_uid: 'DOC-1',
    note_date: '2026-09-22',
    findings: finding('Drug interaction: A + B', 'f-1'),
    complexity_band: 'LOW',
    complexity_inputs: '{}',
  },
  {
    id: '99999999-8888-7777-6666-555555555556',
    doctor_uid: 'DOC-POORNIMA',
    note_date: '2026-09-16',
    findings: finding('Drug interaction: C + D', 'f-week'),
    complexity_band: 'LOW',
    complexity_inputs: '{}',
  },
  {
    id: '99999999-8888-7777-6666-555555555557',
    doctor_uid: 'DOC-OUTSIDE',
    note_date: '2026-09-15',
    findings: finding('Drug interaction: E + F', 'f-old'),
    complexity_band: 'LOW',
    complexity_inputs: '{}',
  },
];

function result(rows: Row[]): Response {
  const names = rows.length ? Object.keys(rows[0]) : [];
  return new Response(JSON.stringify({
    command: 'SELECT',
    rowCount: rows.length,
    rowAsArray: false,
    fields: names.map((name, i) => ({
      name, tableID: 0, columnID: i + 1, dataTypeID: 25,
      dataTypeSize: -1, dataTypeModifier: -1, format: 'text',
    })),
    rows: rows.map((row) => names.map((name) => row[name] == null ? null : String(row[name]))),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
  const sent = JSON.parse(String(init.body || '{}')) as { query?: string; params?: unknown[] };
  const text = String(sent.query || '');
  const params = sent.params || [];
  issued.push({ text, params });
  if (/INSERT INTO triage_stamp_events/.test(text)) {
    const candidate: Row = {
      id: String(params[0]),
      queue_item_ref: params[2] == null ? null : String(params[2]),
      verb: params[3] == null ? null : String(params[3]),
      reason: params[4] == null ? null : String(params[4]),
      actor: params[5] == null ? null : String(params[5]),
      policy_version: params[6] == null ? null : String(params[6]),
      run_id: params[7] == null ? null : String(params[7]),
      outcome: 'accepted',
      decision_id: null,
      signal_reference: null,
      client_request_id: params[9] == null ? null : String(params[9]),
      result: null,
      error: null,
    };
    const key = candidate.client_request_id == null ? null : String(candidate.client_request_id);
    const runId = candidate.run_id == null ? null : String(candidate.run_id);
    const clash = stamps.some((existing) =>
      (key != null && existing.client_request_id === key)
      || (runId != null && existing.queue_item_ref === candidate.queue_item_ref && existing.run_id === runId));
    if (clash) return result([]);
    stamps.push(candidate);
    return result([{ id: candidate.id }]);
  }
  if (/WHERE client_request_id = \$1/.test(text)) {
    const row = stamps.find((existing) => existing.client_request_id === params[0]);
    return result(row ? [row] : []);
  }
  if (/WHERE queue_item_ref = \$1 AND run_id = \$2/.test(text)) {
    const row = stamps.find((existing) => existing.queue_item_ref === params[0] && existing.run_id === params[1]);
    return result(row ? [row] : []);
  }
  if (/UPDATE triage_stamp_events/.test(text)) {
    const row = stamps.find((existing) => existing.id === String(params[0]));
    if (row && /decision_id=\$3/.test(text)) {
      row.outcome = params[1];
      row.decision_id = params[2];
      row.signal_reference = params[3];
      row.error = params[4];
      row.result = params[5];
    } else if (row && /outcome='accepted'/.test(text) && /AND outcome='failed'/.test(text)) {
      if (row.outcome !== 'failed') return result([]);
      row.outcome = 'accepted';
      row.error = null;
      return result([{ id: row.id }]);
    } else if (row && /outcome='failed'/.test(text)) {
      row.outcome = 'failed';
      row.error = params[1];
    }
    return result([]);
  }
  if (/INSERT INTO opd_audit_triage/.test(text)) {
    triageRows.push({
      scope: params[1] == null ? null : String(params[1]),
      doctor_uid: params[2] == null ? null : String(params[2]),
      signal_type: params[3] == null ? null : String(params[3]),
      audit_id: params[4] == null ? null : String(params[4]),
      finding_ref: params[5] == null ? null : String(params[5]),
      validity: params[8] == null ? null : String(params[8]),
      bug_type: params[9] == null ? null : String(params[9]),
      importance: params[10] == null ? null : String(params[10]),
      routed: params[11] === true || params[11] === 'true',
      response_required: params[12] == null ? null : String(params[12]),
      reason: params[13] == null ? null : String(params[13]),
      cm_user: params[14] == null ? null : String(params[14]),
      disposition: /\bdisposition\b/.test(text) && params[15] != null ? String(params[15]) : null,
      note_class: params.length > 15 && params[params.length - 1] != null ? String(params[params.length - 1]) : 'opd',
      created_at: '2026-09-22T06:00:00.000Z',
    });
    return result([]);
  }
  if (/FROM opd_audit_triage/.test(text) && /doctor_uid = ANY\(\$1\)/.test(text)) {
    const uids = pgTextArray(params[0]);
    return result(triageRows.filter((row) => uids.includes(String(row.doctor_uid))));
  }
  if (/INSERT INTO opd_gov_signal\b/.test(text)) {
    gov = {
      signal_id: String(params[0]),
      reference: String(params[1]),
      doctor_uid: String(params[2]),
      signal_type: String(params[3]),
      importance: String(params[4]),
      response_required: String(params[5]),
      status: String(params[6]),
      source_triage_ref: params[7] == null ? null : String(params[7]),
      window_from: params[8] == null ? null : String(params[8]),
      window_to: params[9] == null ? null : String(params[9]),
      sla_due_at: params[10] == null ? null : String(params[10]),
      latest_response: null,
      ruling: null,
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
    };
    return result([]);
  }
  if (/FROM opd_gov_signal/i.test(text)) {
    if (/count\(\*\)/i.test(text)) return result([{ n: 0 }]);
    if (!gov) return result([]);
    if (/signal_id=\$1/.test(text)) return result(String(params[0]) === String(gov.signal_id) ? [gov] : []);
    return result([gov]);
  }
  if (/max\(\(note_date/.test(text)) return result([{ d: '2026-09-22' }]);
  if (/opd_note_audits/.test(text) && /DISTINCT ON/.test(text)) {
    const from = String(params[2] || '');
    const to = String(params[3] || '');
    const doctor = params.length > 4 && params[4] != null ? String(params[4]) : '';
    return result(QUEUE_AUDITS.filter((row) => {
      const note = String(row.note_date);
      if (from && note < from) return false;
      if (to && note > to) return false;
      if (doctor && String(row.doctor_uid) !== doctor) return false;
      return true;
    }));
  }
  return result([]);
}) as typeof fetch;

async function post(
  payload: Record<string, unknown>,
  extra: Record<string, string> = {},
  url = 'https://cat.test/api/admin/triage/stamp',
) {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('../../app/api/admin/triage/stamp/route.ts');
  const response = await POST(new NextRequest(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-admin-token',
      'content-type': 'application/json',
      'x-request-id': 'test-run-request',
      ...extra,
    },
    body: JSON.stringify(payload),
  }));
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

const ROUTE_STAMP = {
  queue_item_ref: 'DOC-1|drug_interaction',
  verb: 'route',
  reason: 'Safety signal requires a doctor',
  actor: 'triage-bot',
  policy_version: 'triage/1',
};

test('stamp gate defaults closed and only exact TRIAGE_BOT_WRITE=1 opens it', () => {
  assert.equal(triageWriteEnabled({}), false);
  assert.equal(triageWriteEnabled({ TRIAGE_BOT_WRITE: 'true' }), false);
  assert.equal(triageWriteEnabled({ TRIAGE_BOT_WRITE: '1' }), true);
});

test('stamp validation keeps the controlled verb and actor vocabularies', () => {
  assert.equal(validateTriageStamp({
    queue_item_ref: 'DOC-1|drug_interaction',
    verb: 'route',
    reason: 'Safety signal',
    actor: 'triage-bot',
    policy_version: 'triage/1',
  }).ok, true);
  assert.equal(validateTriageStamp({
    queue_item_ref: 'DOC-1|drug_interaction',
    verb: 'valid',
    reason: 'Reviewed',
    actor: 'doctor',
    policy_version: 'triage/1',
  }).ok, false);
});

test('POST refuses before reading the body or touching storage when the write flag is off', async () => {
  delete process.env.TRIAGE_BOT_WRITE;
  resetStore();
  const response = await post({ ...ROUTE_STAMP, run_id: 'would-mint' });
  assert.equal(response.status, 403);
  assert.match(String(response.json.error), /SHADOW_ONLY/);
  assert.deepEqual(issued, []);
  assert.equal(decisionInserts().length, 0);
});

test('POST accepts an allowed hold shape when the flag is on and records audit metadata', async () => {
  process.env.TRIAGE_BOT_WRITE = '1';
  resetStore();
  const response = await post({
    queue_item_ref: 'DOC-1|drug_interaction',
    verb: 'hold',
    reason: 'Awaiting policy review',
    actor: 'triage-bot',
    policy_version: 'triage/1',
    run_id: 'run-22-sep',
    run_metadata: { model: 'shadow-eval' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.outcome, 'held');
  assert.equal(response.json.signal, null);
  const decision = response.json.decision as { validity: string; disposition: string; bug_type: string | null; routed: boolean };
  assert.equal(decision.disposition, 'hold');
  assert.equal(decision.validity, 'non_clinical');
  assert.equal(decision.bug_type, null);
  assert.equal(decision.routed, false);
  const auditInsert = issued.find((query) => /INSERT INTO triage_stamp_events/.test(query.text));
  assert.ok(auditInsert);
  assert.equal(auditInsert.params[3], 'hold');
  assert.equal(auditInsert.params[5], 'triage-bot');
  assert.equal(auditInsert.params[6], 'triage/1');
  assert.equal(decisionInserts().length, 1);
  assert.equal(decisionInserts()[0].params[8], 'non_clinical');
  assert.equal(decisionInserts()[0].params[15], 'hold');
  assert.equal(signalInserts().length, 0);
});

test('stamp route delegates clinical mutations to the existing decision/mint store', () => {
  const source = readFileSync('app/api/admin/triage/stamp/route.ts', 'utf8');
  assert.match(source, /insertDecision\(decision\)/);
  assert.match(source, /insertQueueDisposition\(/);
  assert.ok(!/mintOrUpdateSignal/.test(source), 'the route must not invent a second signal mint path');
  assert.match(source, /hold/);
  assert.match(source, /drop_informational/);
  const store = readFileSync('lib/opd-triage-store.ts', 'utf8');
  const sibling = store.slice(store.indexOf('export async function insertQueueDisposition'));
  assert.ok(sibling.length > 0);
  assert.match(sibling, /NONCLINICAL_VALIDITY/);
  assert.ok(!/mintOrUpdateSignal|opd_gov_signal/.test(sibling));
  assert.match(store, /validity IN \('valid_signal', 'audit_bug'\)/);
  const migration = readFileSync('migrations/0059_triage_queue_disposition.sql', 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS disposition text/);
  assert.match(store, /ADD COLUMN IF NOT EXISTS disposition text/);
  assert.ok(!/TRIAGE_BOT_WRITE\s*=\s*1/.test(migration));
});

test('request id resolves from client_request_id then Idempotency-Key', () => {
  assert.equal(resolveStampRequestId('body-key', 'header-key'), 'body-key');
  assert.equal(resolveStampRequestId(null, 'header-key'), 'header-key');
  assert.equal(resolveStampRequestId('   ', '  header-key  '), 'header-key');
  assert.equal(resolveStampRequestId(undefined, null), null);
});

test('migration 0058 is the production idempotency path; the route repeats it as belt-and-suspenders', () => {
  const migration = readFileSync('migrations/0058_triage_stamp_idempotency.sql', 'utf8');
  const route = readFileSync('app/api/admin/triage/stamp/route.ts', 'utf8');
  for (const needle of [
    'ADD COLUMN IF NOT EXISTS client_request_id text',
    'ADD COLUMN IF NOT EXISTS result jsonb',
    'CREATE UNIQUE INDEX IF NOT EXISTS triage_stamp_events_run_uq',
    'ON triage_stamp_events (queue_item_ref, run_id)',
    'WHERE run_id IS NOT NULL',
    'CREATE UNIQUE INDEX IF NOT EXISTS triage_stamp_events_idem_uq',
    'ON triage_stamp_events (client_request_id)',
    'WHERE client_request_id IS NOT NULL',
  ]) {
    assert.ok(migration.includes(needle), `migration missing ${needle}`);
    assert.ok(route.includes(needle), `route missing ${needle}`);
  }
  assert.match(route, /CREATE TABLE IF NOT EXISTS triage_stamp_events/);
  assert.ok(!/TRIAGE_BOT_WRITE\s*=\s*1/.test(migration));
});

test('mint writes the decision uuid into source_triage_ref; doctor-audits does not project stamp audit text', () => {
  const decision = readFileSync('lib/opd-triage-store.ts', 'utf8');
  const mint = readFileSync('lib/opd-gov-signal-store.ts', 'utf8');
  const audits = readFileSync('app/api/governance/doctor-audits/route.ts', 'utf8');
  const stamp = readFileSync('app/api/admin/triage/stamp/route.ts', 'utf8');
  assert.match(decision, /source_triage_ref:\s*id/);
  assert.match(mint, /source_triage_ref=\$2/);
  assert.doesNotMatch(audits, /FROM triage_stamp_events/);
  assert.doesNotMatch(audits, /triageMeta/);
  assert.doesNotMatch(audits, /row\.reason/);
  assert.doesNotMatch(audits, /row\.policy_version/);
  assert.match(stamp, /INSERT INTO triage_stamp_events/);
  assert.match(stamp, /reason, actor, policy_version, run_id, run_metadata/);
});

test('identical Idempotency-Key replays the same decision and signal', async () => {
  process.env.TRIAGE_BOT_WRITE = '1';
  resetStore();
  const first = await post(ROUTE_STAMP, { 'Idempotency-Key': 'stamp-replay-1' });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.replayed, false);
  assert.equal(first.json.outcome, 'applied');
  const decisionId = (first.json.decision as { id: string }).id;
  const signal = first.json.signal as { reference: string; signal_id: string; status: string };
  assert.match(decisionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(signalInserts()[0].params[7], decisionId);
  assert.equal(decisionInserts()[0].params[0], decisionId);
  assert.ok(signal.reference);
  assert.ok(signal.signal_id);

  const second = await post({ ...ROUTE_STAMP, client_request_id: 'stamp-replay-1' });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(second.json.replayed, true);
  assert.equal((second.json.decision as { id: string }).id, decisionId);
  assert.equal((second.json.signal as { reference: string }).reference, signal.reference);
  assert.equal((second.json.signal as { signal_id: string }).signal_id, signal.signal_id);
  assert.equal(decisionInserts().length, 1);
  assert.equal(signalInserts().length, 1);
});

test('identical (queue_item_ref, run_id) replays without a second decision', async () => {
  process.env.TRIAGE_BOT_WRITE = '1';
  resetStore();
  const payload = { ...ROUTE_STAMP, run_id: 'run-22-sep-route' };
  const first = await post(payload);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const decisionId = (first.json.decision as { id: string }).id;
  const second = await post(payload);
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(second.json.replayed, true);
  assert.equal((second.json.decision as { id: string }).id, decisionId);
  assert.equal((second.json.signal as { reference: string }).reference, (first.json.signal as { reference: string }).reference);
  assert.equal(decisionInserts().length, 1);
  assert.equal(signalInserts().length, 1);
});

test('a repeated hold replays one non-clinical disposition and does not mint', async () => {
  process.env.TRIAGE_BOT_WRITE = '1';
  resetStore();
  const payload = {
    queue_item_ref: 'DOC-1|drug_interaction',
    verb: 'hold',
    reason: 'Awaiting policy review',
    actor: 'triage-bot',
    policy_version: 'triage/1',
    run_id: 'run-hold-replay',
  };
  const first = await post(payload);
  const second = await post(payload);
  assert.equal(first.status, 200);
  assert.equal(first.json.outcome, 'held');
  assert.equal(first.json.signal, null);
  assert.equal((first.json.decision as { disposition: string }).disposition, 'hold');
  assert.equal(second.status, 200);
  assert.equal(second.json.replayed, true);
  assert.equal(second.json.stamp_id, first.json.stamp_id);
  assert.equal(second.json.signal, null);
  assert.equal((second.json.decision as { id: string }).id, (first.json.decision as { id: string }).id);
  assert.equal(decisionInserts().length, 1);
  assert.equal(signalInserts().length, 0);
  assert.equal(issued.filter((query) => /INSERT INTO triage_stamp_events/.test(query.text)).length, 1);
});

test('a clinical stamp without run_id or Idempotency-Key is refused before insertDecision', async () => {
  process.env.TRIAGE_BOT_WRITE = '1';
  resetStore();
  const response = await post(ROUTE_STAMP);
  assert.equal(response.status, 400);
  assert.match(String(response.json.error), /run_id or Idempotency-Key/);
  assert.equal(decisionInserts().length, 0);
});

function queueAuditRead() {
  return issued.filter((query) => /opd_note_audits/.test(query.text) && /DISTINCT ON/.test(query.text));
}

test('an item present in the days=7 queue stamps', async () => {
  process.env.TRIAGE_BOT_WRITE = '1';
  resetStore();
  const response = await post({
    ...ROUTE_STAMP,
    queue_item_ref: 'DOC-POORNIMA|drug_interaction',
    run_id: 'run-days-7',
    days: 7,
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.json.ok, true);
  assert.equal(response.json.outcome, 'applied');
  assert.equal(response.json.replayed, false);
  const read = queueAuditRead();
  assert.equal(read.length, 1);
  assert.equal(read[0].params[2], '2026-09-16');
  assert.equal(read[0].params[3], '2026-09-22');
  assert.equal(decisionInserts()[0].params[6], '2026-09-16');
  assert.equal(decisionInserts()[0].params[7], '2026-09-22');

  resetStore();
  const viaQuery = await post({
    ...ROUTE_STAMP,
    queue_item_ref: 'DOC-POORNIMA|drug_interaction',
    run_id: 'run-days-7-query',
  }, {}, 'https://cat.test/api/admin/triage/stamp?days=7&doctor_uid=DOC-POORNIMA');
  assert.equal(viaQuery.status, 200, JSON.stringify(viaQuery.json));
  assert.equal(viaQuery.json.outcome, 'applied');
  const queryRead = queueAuditRead();
  assert.equal(queryRead[0].params[2], '2026-09-16');
  assert.equal(queryRead[0].params[4], 'DOC-POORNIMA');
});

test('an item outside the requested window is still a 404', async () => {
  process.env.TRIAGE_BOT_WRITE = '1';
  resetStore();
  const outsideWeek = await post({
    ...ROUTE_STAMP,
    queue_item_ref: 'DOC-OUTSIDE|drug_interaction',
    run_id: 'run-outside-week',
    days: 7,
  });
  assert.equal(outsideWeek.status, 404);
  assert.match(String(outsideWeek.json.error), /not present in the current Action queue/);
  assert.equal(decisionInserts().length, 0);

  const narrowed = await post({
    ...ROUTE_STAMP,
    queue_item_ref: 'DOC-POORNIMA|drug_interaction',
    run_id: 'run-outside-day',
    day: '2026-09-22',
    days: 1,
  });
  assert.equal(narrowed.status, 404);
  assert.match(String(narrowed.json.error), /not present in the current Action queue/);
  assert.equal(decisionInserts().length, 0);

  const otherDoctor = await post({
    ...ROUTE_STAMP,
    queue_item_ref: 'DOC-POORNIMA|drug_interaction',
    run_id: 'run-other-doctor',
    days: 7,
    doctor_uid: 'DOC-1',
  });
  assert.equal(otherDoctor.status, 404);
  assert.equal(decisionInserts().length, 0);

  const bodyNarrowsQuery = await post({
    ...ROUTE_STAMP,
    queue_item_ref: 'DOC-POORNIMA|drug_interaction',
    run_id: 'run-body-wins',
    days: 1,
  }, {}, 'https://cat.test/api/admin/triage/stamp?days=7');
  assert.equal(bodyNarrowsQuery.status, 404);
  assert.equal(decisionInserts().length, 0);
});

test('omitted day and days keep the single latest-audit-day window', async () => {
  process.env.TRIAGE_BOT_WRITE = '1';
  resetStore();
  const today = await post({ ...ROUTE_STAMP, run_id: 'run-default-day' });
  assert.equal(today.status, 200, JSON.stringify(today.json));
  assert.equal(today.json.outcome, 'applied');
  const read = queueAuditRead();
  assert.equal(read.length, 1);
  assert.equal(read[0].params[2], '2026-09-22');
  assert.equal(read[0].params[3], '2026-09-22');
  assert.equal(read[0].params.length, 4);
  assert.equal(decisionInserts()[0].params[6], '2026-09-22');
  assert.equal(decisionInserts()[0].params[7], '2026-09-22');

  const earlier = await post({
    ...ROUTE_STAMP,
    queue_item_ref: 'DOC-POORNIMA|drug_interaction',
    run_id: 'run-default-miss',
  });
  assert.equal(earlier.status, 404);
  assert.match(String(earlier.json.error), /not present in the current Action queue/);
  assert.equal(decisionInserts().length, 1);
});

async function cardsFor(status: 'untriaged' | 'all') {
  const queue = await readActionQueue(parseActionQueueQuery({ status, day: '2026-09-22' }));
  return flattenActionQueueItems(queue.doctors);
}

test('hold and drop_informational leave untriaged and stay on status=all; route still mints', async () => {
  process.env.TRIAGE_BOT_WRITE = '1';
  const ref = 'DOC-1|drug_interaction';

  resetStore();
  const hold = await post({
    queue_item_ref: ref,
    verb: 'hold',
    reason: 'Awaiting policy review',
    actor: 'triage-bot',
    policy_version: 'triage/1',
    run_id: 'run-queue-hold',
  });
  assert.equal(hold.status, 200, JSON.stringify(hold.json));
  assert.equal(hold.json.outcome, 'held');
  assert.equal(hold.json.signal, null);
  assert.equal(signalInserts().length, 0);
  const heldOpen = await cardsFor('untriaged');
  assert.ok(!heldOpen.some((item) => sameQueueItem(item.queue_item_ref, ref)));
  const heldCard = (await cardsFor('all')).find((item) => sameQueueItem(item.queue_item_ref, ref));
  assert.ok(heldCard);
  assert.equal(heldCard.triage?.disposition, 'hold');
  assert.equal(heldCard.triage?.validity, 'non_clinical');
  assert.notEqual(heldCard.triage?.validity, 'valid_signal');
  assert.notEqual(heldCard.triage?.validity, 'audit_bug');
  assert.equal(heldCard.triage?.bug_type, null);
  assert.equal(heldCard.triage?.routed, false);

  resetStore();
  const drop = await post({
    queue_item_ref: ref,
    verb: 'drop_informational',
    reason: 'Informational only',
    actor: 'human',
    policy_version: 'triage/1',
    run_id: 'run-queue-drop',
  });
  assert.equal(drop.status, 200, JSON.stringify(drop.json));
  assert.equal(drop.json.outcome, 'dropped_informational');
  assert.equal(drop.json.signal, null);
  assert.equal(signalInserts().length, 0);
  assert.ok(!(await cardsFor('untriaged')).some((item) => sameQueueItem(item.queue_item_ref, ref)));
  const droppedCard = (await cardsFor('all')).find((item) => sameQueueItem(item.queue_item_ref, ref));
  assert.ok(droppedCard);
  assert.equal(droppedCard.triage?.disposition, 'drop_informational');
  assert.equal(droppedCard.triage?.validity, 'non_clinical');
  assert.equal(droppedCard.triage?.bug_type, null);
  assert.equal(droppedCard.triage?.routed, false);

  resetStore();
  const routed = await post({ ...ROUTE_STAMP, run_id: 'run-queue-route' });
  assert.equal(routed.status, 200, JSON.stringify(routed.json));
  assert.equal(routed.json.outcome, 'applied');
  const signal = routed.json.signal as { reference: string; signal_id: string };
  assert.ok(signal.reference);
  assert.ok(signal.signal_id);
  assert.equal(signalInserts().length, 1);
  assert.equal(signalInserts()[0].params[7], (routed.json.decision as { id: string }).id);
  assert.equal((routed.json.decision as { validity: string }).validity, 'valid_signal');
  assert.equal((routed.json.decision as { routed: boolean }).routed, true);
  assert.ok(!(await cardsFor('untriaged')).some((item) => sameQueueItem(item.queue_item_ref, ref)));
  const routedCard = (await cardsFor('all')).find((item) => sameQueueItem(item.queue_item_ref, ref));
  assert.equal(routedCard?.triage?.validity, 'valid_signal');
  assert.equal(routedCard?.triage?.routed, true);
  assert.equal(routedCard?.triage?.disposition, null);
});
