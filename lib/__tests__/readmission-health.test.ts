/**
 *   node --test --import tsx lib/__tests__/readmission-health.test.ts
 * READMIT-OBSERVABILITY — the pure health rule. No I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readmissionHealthStatus, HEALTH_STALE_MS } from '../readmission/health';
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
  assert.match(r.reasons[0], /Bedrock/);
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
