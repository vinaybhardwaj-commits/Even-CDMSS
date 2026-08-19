/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-load-core.test.ts
 * R5.1 (CDMSS Readmissions R5.1 PRD v1.0) — the board's load-state decisions: the exact copy, the
 * timeout / slow thresholds, abort classification, and the board wiring (source-read: AbortController
 * at 45 s, slow line at 8 s, error state + Retry, no polling / auto-retry, R5 untouched).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyLoadFailure, isAbortError, loadingLines,
  LOAD_TIMEOUT_MS, SLOW_AFTER_MS, LOADING_COPY, SLOW_LOAD_COPY, LOAD_ERROR_HEADING, LOAD_ERROR_TIMEOUT_DETAIL, LOAD_ERROR_OTHER_DETAIL, RETRY_LABEL,
} from '../readmission-load-core.ts';

const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

test('the normative numbers and copy, verbatim', () => {
  assert.equal(LOAD_TIMEOUT_MS, 45_000);
  assert.equal(SLOW_AFTER_MS, 8_000);
  assert.equal(LOADING_COPY, 'Loading…');
  assert.equal(SLOW_LOAD_COPY, 'Still loading — the record systems are slow right now.');
  assert.equal(LOAD_ERROR_HEADING, 'The case list did not load.');
  assert.equal(LOAD_ERROR_TIMEOUT_DETAIL, 'It took too long. The record systems may be slow.');
  assert.equal(LOAD_ERROR_OTHER_DETAIL, 'Something went wrong on the way to the server.');
  assert.equal(RETRY_LABEL, 'Retry');
});

test('isAbortError / classifyLoadFailure: an AbortError (DOMException or shaped error) → timeout detail; anything else → other detail; never throws', () => {
  const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  assert.equal(isAbortError(abort), true);
  assert.deepEqual(classifyLoadFailure(abort), { kind: 'timeout', heading: LOAD_ERROR_HEADING, detail: LOAD_ERROR_TIMEOUT_DETAIL });
  assert.equal(classifyLoadFailure(Object.assign(new Error('x'), { name: 'TimeoutError' })).kind, 'timeout');
  assert.equal(classifyLoadFailure(new Error('signal is aborted without reason')).kind, 'timeout');
  assert.deepEqual(classifyLoadFailure(new Error('status 502')), { kind: 'other', heading: LOAD_ERROR_HEADING, detail: LOAD_ERROR_OTHER_DETAIL });
  assert.equal(classifyLoadFailure(new TypeError('Failed to fetch')).kind, 'other');
  assert.equal(classifyLoadFailure(null).kind, 'other'); assert.equal(classifyLoadFailure('junk').kind, 'other'); assert.equal(classifyLoadFailure(undefined).kind, 'other');
  assert.equal(isAbortError(null), false); assert.equal(isAbortError({}), false);
});

test('loadingLines: only "Loading…" before 8 s; the slow line joins at and after 8 s', () => {
  assert.deepEqual(loadingLines(0), [LOADING_COPY]);
  assert.deepEqual(loadingLines(7_999), [LOADING_COPY]);
  assert.deepEqual(loadingLines(8_000), [LOADING_COPY, SLOW_LOAD_COPY]);
  assert.deepEqual(loadingLines(44_000), [LOADING_COPY, SLOW_LOAD_COPY]);
});

test('board wiring (source-read): AbortController aborted at LOAD_TIMEOUT_MS, slow line at SLOW_AFTER_MS, error state with heading + detail + Retry re-running the same load, no setInterval / auto-retry; R5 filter wiring and the Suspense wrapper untouched', () => {
  const b = code('components/care/ReadmissionsBoard.tsx');
  assert.match(b, /new AbortController\(\)/);
  assert.match(b, /setTimeout\(\(\) => ctrl\.abort\(\), LOAD_TIMEOUT_MS\)/);
  assert.match(b, /fetch\('\/api\/care\/readmissions\/list', \{ signal: ctrl\.signal \}\)/);
  assert.match(b, /setTimeout\(\(\) => setSlow\(true\), SLOW_AFTER_MS\)/);
  assert.match(b, /classifyLoadFailure\(e\)/);
  assert.match(b, /\{loadError\.heading\}/); assert.match(b, /\{loadError\.detail\}/); assert.match(b, /\{RETRY_LABEL\}/);
  assert.match(b, /onClick=\{\(\) => void load\(\)\}[^\n]*\{RETRY_LABEL\}/);
  assert.ok(!/setInterval/.test(b), 'nothing polls');
  assert.equal((b.match(/void load\(\)/g) ?? []).length, 3, 'exactly: mount effect, Refresh, Retry — no automatic retry');
  // R5 untouched
  assert.match(b, /applyFilters\(eligible, filters\)/); assert.match(b, /showingLine\(visible\.length, eligible\.length\)/);
  assert.match(b, /<Suspense fallback=/); assert.match(b, /router\.replace\(/);
});
