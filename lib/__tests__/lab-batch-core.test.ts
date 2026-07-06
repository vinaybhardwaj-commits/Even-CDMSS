/**
 *   node --experimental-strip-types --test lib/__tests__/lab-batch-core.test.ts
 * Pure core for the cohort-scoped Lab eval batch runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampN, sanitizeUids, remainingUids, parseBatchState, batchGate, LB_KEYS, LB_MAX_N, LB_MAX_COHORT,
} from '../lab-batch-core.ts';

test('clampN clamps to 1..LB_MAX_N and floors garbage to 1', () => {
  assert.equal(clampN(2), 2);
  assert.equal(clampN(99), LB_MAX_N);
  assert.equal(clampN(0), 1);
  assert.equal(clampN(-4), 1);
  assert.equal(clampN('abc'), 1);
  assert.equal(clampN(1.9), 1);
});

test('sanitizeUids: id-safe, de-duped, capped', () => {
  assert.deepEqual(sanitizeUids(['aB1', 'aB1', 'c-D_2']), ['aB1', 'c-D_2']);
  assert.deepEqual(sanitizeUids(['bad id!', 'ok', '', null, 3, 'ok']), ['ok', '3']);
  assert.deepEqual(sanitizeUids('nope'), []);
  const big = Array.from({ length: LB_MAX_COHORT + 50 }, (_, i) => 'u' + i);
  assert.equal(sanitizeUids(big).length, LB_MAX_COHORT);
});

test('remainingUids removes the done-set, order preserved', () => {
  assert.deepEqual(remainingUids(['a', 'b', 'c', 'd'], new Set(['b', 'd'])), ['a', 'c']);
  assert.deepEqual(remainingUids(['a', 'b'], ['a', 'b']), []);
});

test('parseBatchState parses settings map', () => {
  const s = {
    [LB_KEYS.enabled]: '1',
    [LB_KEYS.experiment]: 'exp1',
    [LB_KEYS.kind]: 'opd',
    [LB_KEYS.uids]: JSON.stringify(['a', 'a', 'bad!', 'b']),
    [LB_KEYS.n]: '5',
    [LB_KEYS.window]: 'always',
    [LB_KEYS.last]: JSON.stringify({ done: 3 }),
    [LB_KEYS.error]: 'boom',
  } as Record<string, string>;
  const st = parseBatchState(s);
  assert.equal(st.enabled, true);
  assert.equal(st.experiment, 'exp1');
  assert.deepEqual(st.uids, ['a', 'b']);
  assert.equal(st.n, LB_MAX_N);            // 5 clamped
  assert.equal(st.window, 'always');
  assert.deepEqual(st.last, { done: 3 });
  assert.equal(st.lastError, 'boom');
});

test('parseBatchState defaults', () => {
  const st = parseBatchState({});
  assert.equal(st.enabled, false);
  assert.equal(st.experiment, null);
  assert.equal(st.kind, 'opd');
  assert.deepEqual(st.uids, []);
  assert.equal(st.n, 2);                    // default
  assert.equal(st.window, 'night');
});

test('batchGate precedence', () => {
  const base = { enabled: true, hasJob: true, windowOpen: true, lockHeld: false, miniBusy: false };
  assert.equal(batchGate(base), null);
  assert.equal(batchGate({ ...base, enabled: false }), 'disabled');
  assert.equal(batchGate({ ...base, hasJob: false }), 'no_job');
  assert.equal(batchGate({ ...base, windowOpen: false }), 'outside_window');
  assert.equal(batchGate({ ...base, lockHeld: true }), 'locked');
  assert.equal(batchGate({ ...base, miniBusy: true }), 'mini_busy');
});
