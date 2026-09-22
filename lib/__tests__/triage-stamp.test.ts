import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { triageWriteEnabled, validateTriageStamp } from '../triage/stamp-schema.ts';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';

type Row = Record<string, unknown>;
const issued: { text: string; params: unknown[] }[] = [];

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
  if (/max\(\(note_date/.test(text)) return result([{ d: '2026-09-22' }]);
  if (/FROM \(\s*SELECT DISTINCT ON/.test(text)) {
    return result([{
      id: '99999999-8888-7777-6666-555555555555',
      doctor_uid: 'DOC-1',
      note_date: '2026-09-22',
      findings: JSON.stringify([{
        subject: 'Drug interaction: A + B',
        rationale: 'Interaction requires review',
        verdict: 'unsafe',
        domain: 'prescribing',
        signal_type: 'drug_interaction',
        finding_ref: 'f-1',
        informational: false,
        citation_ids: [],
      }]),
      complexity_band: 'LOW',
      complexity_inputs: '{}',
    }]);
  }
  return result([]);
}) as typeof fetch;

async function post(payload: Record<string, unknown>) {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('../../app/api/admin/triage/stamp/route.ts');
  const response = await POST(new NextRequest('https://cat.test/api/admin/triage/stamp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-admin-token',
      'content-type': 'application/json',
      'x-request-id': 'test-run-request',
    },
    body: JSON.stringify(payload),
  }));
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

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
  issued.length = 0;
  const response = await post({});
  assert.equal(response.status, 403);
  assert.match(String(response.json.error), /SHADOW_ONLY/);
  assert.deepEqual(issued, []);
});

test('POST accepts an allowed hold shape when the flag is on and records audit metadata', async () => {
  process.env.TRIAGE_BOT_WRITE = '1';
  issued.length = 0;
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
  const auditInsert = issued.find((query) => /INSERT INTO triage_stamp_events/.test(query.text));
  assert.ok(auditInsert);
  assert.equal(auditInsert.params[3], 'hold');
  assert.equal(auditInsert.params[5], 'triage-bot');
  assert.equal(auditInsert.params[6], 'triage/1');
});

test('stamp route delegates clinical mutations to the existing decision/mint store', () => {
  const source = readFileSync('app/api/admin/triage/stamp/route.ts', 'utf8');
  assert.match(source, /insertDecision\(decision\)/);
  assert.ok(!/mintOrUpdateSignal/.test(source), 'the route must not invent a second signal mint path');
});
