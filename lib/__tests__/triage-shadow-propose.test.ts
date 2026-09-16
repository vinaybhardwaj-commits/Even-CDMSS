/**
 * lib/__tests__/triage-shadow-propose.test.ts
 *
 *   node --test --import tsx lib/__tests__/triage-shadow-propose.test.ts
 *
 * Shadow propose: verbs, validation, append-only idempotency on (queue_item_ref, run_id),
 * admin gate, and a hard refusal to stamp real triage / mint opd_gov_signal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TRIAGE_SHADOW_VERBS,
  assertShadowOnlyWrite,
  validateShadowProposal,
} from '../triage/shadow-schema.ts';

process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';
process.env.ADMIN_TOKEN = 'test-admin-token';

const ROUTE = readFileSync('app/api/admin/triage/shadow-propose/route.ts', 'utf8');
const SCHEMA = readFileSync('lib/triage/shadow-schema.ts', 'utf8');
const MIGRATION = readFileSync('migrations/0056_triage_shadow_proposals.sql', 'utf8');

test('verbs are the CM Action-queue set, not Review Mode pills', () => {
  assert.deepEqual([...TRIAGE_SHADOW_VERBS], ['valid', 'bug', 'route', 'hold', 'drop_informational']);
  assert.ok(!TRIAGE_SHADOW_VERBS.includes('true_positive' as never));
  assert.ok(!/true_positive|nitpick|contested/.test(SCHEMA));
});

test('validateShadowProposal: required fields + verb enum', () => {
  const ok = validateShadowProposal({
    queue_item_ref: 'docA|drug_interaction', verb: 'route',
    reason: 'loud safety signal', confidence: 0.9,
    policy_version: 'triage-bot/0.1', run_id: '2026-09-16', actor: 'triage-bot',
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.verb, 'route');
    assert.equal(ok.value.confidence, 0.9);
  }
  assert.equal(validateShadowProposal({ queue_item_ref: 'docA|x', verb: 'junk', policy_version: 'p', run_id: 'r' }).ok, false);
  assert.equal(validateShadowProposal({ verb: 'hold', policy_version: 'p', run_id: 'r' }).ok, false);
  assert.equal(validateShadowProposal({ queue_item_ref: 'docA|x', verb: 'hold', run_id: 'r' }).ok, false);
  assert.equal(validateShadowProposal({ queue_item_ref: 'docA|x', verb: 'hold', policy_version: 'p', confidence: 1.2, run_id: 'r' }).ok, false);
  const viaDefaults = validateShadowProposal(
    { queue_item_ref: 'docA|x', verb: 'hold' },
    { policy_version: 'p', run_id: 'run-1', actor: 'bot' },
  );
  assert.equal(viaDefaults.ok, true);
});

test('stamp is hard-gated SHADOW_ONLY; propose is the only allowed write kind', () => {
  assert.equal(assertShadowOnlyWrite('propose').ok, true);
  const stamp = assertShadowOnlyWrite('stamp');
  assert.equal(stamp.ok, false);
  assert.match(stamp.error || '', /SHADOW_ONLY/);
});

test('route + migration are append-only, idempotent on (queue_item_ref, run_id), no gov mint', () => {
  assert.match(ROUTE, /requireAdmin\(req\)/);
  assert.match(ROUTE, /isAdminUnlocked\(\)/);
  assert.match(ROUTE, /ON CONFLICT \(queue_item_ref, run_id\) DO NOTHING/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS triage_shadow_proposals_identity_uq/);
  assert.match(MIGRATION, /\(queue_item_ref, run_id\)/);
  assert.ok(!/INSERT INTO opd_audit_triage/.test(ROUTE));
  assert.ok(!/insertDecision|mintOrUpdateSignal|opd_gov_signal/.test(ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
  assert.ok(!/UPDATE |DELETE /.test(MIGRATION));
  assert.match(ROUTE, /assertShadowOnlyWrite\('propose'\)/);
  assert.match(ROUTE, /assertShadowOnlyWrite\('stamp'\)/);
});

type Row = Record<string, unknown>;
const issued: { text: string; params: unknown[] }[] = [];
const keys = new Set<string>();

function neonBody(rows: Row[]): string {
  const names = rows.length ? Object.keys(rows[0]) : [];
  return JSON.stringify({
    command: 'SELECT', rowCount: rows.length, rowAsArray: false,
    fields: names.map((name, i) => ({
      name, tableID: 0, columnID: i + 1, dataTypeID: 25, dataTypeSize: -1, dataTypeModifier: -1, format: 'text',
    })),
    rows: rows.map((r) => names.map((n) => (r[n] == null ? null : String(r[n])))),
  });
}
const ok = (rows: Row[]) => new Response(neonBody(rows), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
  const sent = JSON.parse(String(init?.body ?? '{}')) as { query?: string; params?: unknown[] };
  const text = String(sent.query ?? '');
  const params = sent.params ?? [];
  issued.push({ text, params });
  if (/CREATE TABLE IF NOT EXISTS triage_shadow_proposals/i.test(text)) return ok([]);
  if (/CREATE UNIQUE INDEX IF NOT EXISTS triage_shadow_proposals_identity_uq/i.test(text)) return ok([]);
  if (/INSERT INTO triage_shadow_proposals/i.test(text)) {
    const ref = String(params[1]);
    const runId = String(params[6]);
    const key = `${ref}\0${runId}`;
    if (keys.has(key)) return ok([]);
    keys.add(key);
    return ok([{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }]);
  }
  return ok([]);
}) as typeof fetch;

async function post(payload: Record<string, unknown>, token = 'test-admin-token'): Promise<{ status: number; json: Record<string, unknown> }> {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('../../app/api/admin/triage/shadow-propose/route.ts');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new NextRequest('https://cat.test/api/admin/triage/shadow-propose', {
    method: 'POST', headers, body: JSON.stringify(payload),
  });
  const res = await POST(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test('POST appends a proposal and replays the same (queue_item_ref, run_id) without a second write', async () => {
  issued.length = 0; keys.clear();
  const payload = {
    run_id: '2026-09-16', policy_version: 'triage-bot/0.1', actor: 'triage-bot',
    proposals: [{ queue_item_ref: 'docA|drug_interaction', verb: 'route', reason: 'safety', confidence: 0.8 }],
  };
  const first = await post(payload);
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.inserted, 1);
  assert.equal(first.json.replayed, 0);
  const inserts = issued.filter((q) => /INSERT INTO triage_shadow_proposals/i.test(q.text));
  assert.equal(inserts.length, 1);
  const second = await post(payload);
  assert.equal(second.status, 200);
  assert.equal(second.json.inserted, 0);
  assert.equal(second.json.replayed, 1);
  const writes = issued.filter((q) => /^\s*(UPDATE|DELETE)\b/i.test(q.text));
  assert.equal(writes.length, 0);
});

test('POST without admin token is 401', async () => {
  const r = await post({
    run_id: 'x', policy_version: 'p',
    proposals: [{ queue_item_ref: 'docA|x', verb: 'hold' }],
  }, '');
  assert.equal(r.status, 401);
});
