/**
 *   node --test --import tsx lib/__tests__/readmission-health.test.ts
 * READMIT-OBSERVABILITY — the pure health rule. No I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readmissionHealthStatus, HEALTH_STALE_MS, classifyBedrockError, publicBedrock,
  NARRATIVE_ERROR_CODES, normaliseNarrativeCode, classifyNarrativeFailure,
} from '../readmission/health';
import type { ReadmissionHealthCounts } from '../readmission/store';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const H = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();
const LIVE = { ok: true, checkedAt: iso(0), error: null };
const DEAD = { ok: false, checkedAt: iso(0), error: 'x' };
const base = (o: Partial<ReadmissionHealthCounts> = {}): ReadmissionHealthCounts => ({
  readOk: true, lastAuditAt: iso(2), lastNarrativeAt: iso(2), narrativePending: 0, oldestNarrativePendingAt: null,
  detectedPending: 0, oldestDetectedAt: null, narrativeErrors: 0, lastNarrativeErrorAt: null, auditErrors: 0, ...o,
});

const cls = (error: string | null, ok = false) => classifyBedrockError({ ok, error });
test('classifier: one code per failure class, null when ok', () => {
  assert.equal(cls(null, true), null);
  assert.equal(cls('bedrock: not configured — BEDROCK_REGION missing'), 'not_configured');
  assert.equal(cls('timeout after 8000 ms'), 'timeout');
  assert.equal(cls('AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity'), 'sts_denied');
  assert.equal(cls('User is not authorized to perform: sts:AssumeRoleWithWebIdentity on a role'), 'sts_denied');
  assert.equal(cls('IAM Credentials generateIdToken failed: 403'), 'id_token_failed');
  assert.equal(cls('something else'), 'error');
  assert.equal(cls(null), 'error');
});

const REASON_OK = /^(health read failed|bedrock unreachable \((not_configured|sts_denied|timeout|id_token_failed|error)\)|narrative pending for [\d.]+ h|detected case unaudited for [\d.]+ h)$/;
test('public payload: no error key; reasons match the allowlist even with hostile error text', () => {
  const hostile = { ok: false, checkedAt: iso(0), error: 'AccessDenied arn:aws:iam::123456789012:role/secret-role: boom' };
  const pub = publicBedrock(hostile);
  assert.deepEqual(Object.keys(pub).sort(), ['checkedAt', 'code', 'ok']);
  assert.ok(!JSON.stringify(pub).includes('arn:'));
  const r = readmissionHealthStatus(base({ readOk: false, oldestDetectedAt: iso(48), oldestNarrativePendingAt: iso(48) }), hostile, NOW);
  assert.equal(r.reasons.length, 4);
  for (const x of r.reasons) assert.match(x, REASON_OK);
  assert.ok(!JSON.stringify(r).includes('arn:'));
});

test('classifier order: id-token failure beats sts; incomplete credential set is error', () => {
  assert.equal(cls('IAM Credentials generateIdToken failed before AssumeRoleWithWebIdentity'), 'id_token_failed');
  assert.equal(cls('bedrock: STS AssumeRoleWithWebIdentity returned an incomplete credential set'), 'error');
});

test('narrative stamp: closed code set, hostile input normalised, SQL writes exactly {at, code}', () => {
  for (const c of NARRATIVE_ERROR_CODES) assert.equal(normaliseNarrativeCode(c), c);
  for (const bad of ['arn:aws:iam::1:role/x: boom', '', null, undefined, 42, 'STS_DENIED']) {
    assert.equal(normaliseNarrativeCode(bad), 'error');
  }
  assert.equal(classifyNarrativeFailure('narrative reply unparseable — nothing stored'), 'narrative_failed');
  assert.equal(classifyNarrativeFailure('narrative leg failed: timeout after 8000 ms'), 'narrative_failed');
  assert.equal(classifyNarrativeFailure('timeout after 8000 ms'), 'timeout');
  assert.equal(classifyNarrativeFailure('AccessDenied sts:AssumeRoleWithWebIdentity arn:aws:iam::1:role/x'), 'sts_denied');
  assert.ok((NARRATIVE_ERROR_CODES as readonly string[]).includes(classifyNarrativeFailure('anything arn:aws:iam::1:role/x')));
  const store = readFileSync('lib/readmission/store.ts', 'utf8');
  const sqlText = store.slice(store.indexOf('export async function recordNarrativeError'), store.indexOf('export async function clearNarrativeError'));
  assert.ok(sqlText.includes(`jsonb_build_object('at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'code', $2::text)`));
  assert.ok(!/message/.test(sqlText.replace(/\/\*[\s\S]*?\*\//g, '')), 'the stamp has no message field');
  assert.match(sqlText, /normaliseNarrativeCode\(code\)/);
  const health = readFileSync('lib/readmission/store.ts', 'utf8');
  assert.match(health, /last_narrative_error_at/); // the health read uses 'at' only
  assert.ok(!/narrativeError'->>'(message|code)'/.test(health));
});

test('threshold is 24 h', () => assert.equal(HEALTH_STALE_MS, 24 * H));

test('healthy is green with no reasons', () => {
  const r = readmissionHealthStatus(base(), LIVE, NOW);
  assert.equal(r.status, 'green');
  assert.deepEqual(r.reasons, []);
});

test('sparse day: last audit and last narrative 100 h old is still green', () => {
  const r = readmissionHealthStatus(base({ lastAuditAt: iso(100), lastNarrativeAt: iso(100) }), LIVE, NOW);
  assert.equal(r.status, 'green');
  assert.equal(r.ages.lastAuditHours, 100);
  assert.equal(r.ages.lastNarrativeHours, 100);
});

test('oldest narrative pending > 24 h is red', () => {
  const r = readmissionHealthStatus(base({ narrativePending: 3, oldestNarrativePendingAt: iso(25.04) }), LIVE, NOW);
  assert.equal(r.status, 'red');
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /narrative pending/);
  assert.equal(r.ages.oldestNarrativePendingHours, 25);
});

test('oldest narrative pending just under 24 h is green', () => {
  assert.equal(readmissionHealthStatus(base({ oldestNarrativePendingAt: iso(23.9) }), LIVE, NOW).status, 'green');
});

test('oldest detected > 24 h is red', () => {
  const r = readmissionHealthStatus(base({ detectedPending: 1, oldestDetectedAt: iso(30) }), LIVE, NOW);
  assert.equal(r.status, 'red');
  assert.match(r.reasons[0], /detected/);
});

test('bedrock not live is red', () => {
  const r = readmissionHealthStatus(base(), DEAD, NOW);
  assert.equal(r.status, 'red');
  assert.match(r.reasons[0], /^bedrock unreachable \(error\)$/);
});

test('readOk false is red', () => {
  const r = readmissionHealthStatus(base({ readOk: false, lastAuditAt: null, lastNarrativeAt: null }), LIVE, NOW);
  assert.equal(r.status, 'red');
  assert.match(r.reasons[0], /health read/);
});

test('several reasons accumulate; null stamps give null ages', () => {
  const r = readmissionHealthStatus(
    base({ readOk: false, oldestDetectedAt: iso(48), oldestNarrativePendingAt: iso(48) }), DEAD, NOW);
  assert.equal(r.reasons.length, 4);
  const g = readmissionHealthStatus(base({ lastAuditAt: null }), LIVE, NOW);
  assert.equal(g.ages.lastAuditHours, null);
});
