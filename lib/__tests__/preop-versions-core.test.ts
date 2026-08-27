/**
 *   node --test --import tsx lib/__tests__/preop-versions-core.test.ts
 *
 * The snapshot versions rail (PRD §5, the readmissions R8.1 pattern). One decision —
 * "is the reading about to be written a DIFFERENT reading?" — carries idempotency, the
 * case-page timeline, and the review-reopening rule all at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildOverwriteSnapshot, buildReplaySnapshot, describeChange, isEpisodeKeyShape,
  needsOverwriteSnapshot, nextVersionNo, PREOP_CAPTURE_REASONS, PREOP_VERSIONS_RULE_VERSION,
} from '../preop-versions-core.ts';
import { composeSnapshot, type SnapshotInput } from '../preop-assemble-core.ts';

test('the capture-reason set is closed at exactly three, and the third is a person', () => {
  // B8b added 'confirm' deliberately: a clinician pressing Confirm on a suggestion changes
  // an input's STATUS, which changes a score, which mints a version — and that step is not
  // a sweep overwriting itself, it is somebody deciding something. Calling it 'overwrite'
  // would hide the one capture reason a reader of the timeline most wants to see.
  assert.deepEqual([...PREOP_CAPTURE_REASONS], ['overwrite', 'replay', 'confirm']);
});

test('no stored row is not an overwrite — the first write destroys nothing', () => {
  assert.equal(needsOverwriteSnapshot(null, 'abc12345'), false);
  assert.equal(needsOverwriteSnapshot(undefined, 'abc12345'), false);
});

test('the same reading snapshots NOTHING — this is the double-tick gate', () => {
  assert.equal(needsOverwriteSnapshot({ snapshot_fingerprint: 'abc12345', version_no: 3 }, 'abc12345'), false);
});

test('a different reading snapshots the one it replaces', () => {
  assert.equal(needsOverwriteSnapshot({ snapshot_fingerprint: 'abc12345', version_no: 3 }, 'def67890'), true);
});

test('an unreadable stored fingerprint snapshots anyway — a hole in history is worse', () => {
  assert.equal(needsOverwriteSnapshot({ version_no: 1 }, 'abc12345'), true);
  assert.equal(needsOverwriteSnapshot({ snapshot_fingerprint: '', version_no: 1 }, 'abc12345'), true);
  assert.equal(needsOverwriteSnapshot({ snapshot_fingerprint: 42 }, 'abc12345'), true);
});

test('version numbering — bumps only on a real change, and never goes backwards', () => {
  assert.equal(nextVersionNo(null, false), 1);
  assert.equal(nextVersionNo({ version_no: 3 }, true), 4);
  assert.equal(nextVersionNo({ version_no: 3 }, false), 3);
  assert.equal(nextVersionNo({ version_no: null }, false), 1);
  assert.equal(nextVersionNo({}, true), 1);
});

test('episode key shape', () => {
  assert.equal(isEpisodeKeyShape('SC-2026-0871'), true);
  assert.equal(isEpisodeKeyShape('a'), false);
  assert.equal(isEpisodeKeyShape("SC'; DROP TABLE preop_findings; --"), false);
});

const episode = {
  episodeKey: 'SC-2026-0871', individualUid: 'IND-1', uhid: 'UH-1', patientName: 'Test Patient',
  age: 61, sex: 'F', procedure: 'Total knee replacement (left)', hospital: 'EHRC',
  surgeryDate: '2026-09-01', surgeon: 'Dr T', department: 'Orthopaedics',
};
const base: SnapshotInput = {
  engineVersion: 'preop-risk/0.1', episode,
  observations: [{ inputId: 'high_risk_surgery', status: 'absent', source: 'BOOKING' }],
  pac: { onFile: false, status: null, verdict: null, reportUid: null, finalizedAt: null, workflowStatus: null, workflowLoggedAt: null },
  daysToSurgery: 20, reviewed: false, includeExtracted: false, bookingEnumerated: true,
  bookingOnly: true, computedAt: '2026-08-12T05:30:00Z',
};

test('the overwrite row is built from the reading being DESTROYED, not the new one', () => {
  const stored = composeSnapshot(base);
  const row = buildOverwriteSnapshot({
    episodeKey: stored.episodeKey, engineVersion: stored.engineVersion, versionNo: 2,
    tier: stored.tier.tier, snapshot: stored as unknown as Record<string, unknown>,
    snapshotFingerprint: stored.fingerprint, computedAt: stored.computedAt, traceId: null,
  });
  assert.equal(row.captureReason, 'overwrite');
  assert.equal(row.versionNo, 2);
  assert.equal(row.snapshotFingerprint, stored.fingerprint);
  assert.deepEqual([row.rcriLo, row.rcriHi], [stored.rcri.lo, stored.rcri.hi]);
  assert.deepEqual([row.cciLo, row.cciHi], [stored.charlson.lo, stored.charlson.hi]);
  assert.equal(row.rowSnapshot.versions_rule_version, PREOP_VERSIONS_RULE_VERSION);
});

test('a replay snapshot is the NEW reading and carries no version number', () => {
  const reading = composeSnapshot(base);
  const row = buildReplaySnapshot(reading, 'trace-1');
  assert.equal(row.captureReason, 'replay');
  assert.equal(row.versionNo, null);              // the live row's numbering is untouched
  assert.equal(row.snapshotFingerprint, reading.fingerprint);
  assert.equal(row.traceId, 'trace-1');
});

test('describeChange narrates the timeline in clinical words, not hashes', () => {
  const v1 = composeSnapshot(base);
  const v2 = composeSnapshot({
    ...base,
    observations: [...base.observations, { inputId: 'creatinine_over_2', status: 'absent', source: 'LAB', value: 1.4 }],
  });
  assert.equal(describeChange(null, v1), 'first snapshot');
  assert.equal(describeChange(v1, v2), 'creatinine over 2: 1.4 → unknown → absent');
  assert.equal(describeChange(v2, v2), 'recomputed — no input changed status');
});

// ── B8b · why a version minted ──────────────────────────────────────────────────

test('a version whose HUMAN inputs moved is captured as `confirm`, not `overwrite`', () => {
  // Pinned at the source, because the store is the only place holding both readings at once
  // and there is no way to exercise it without Neon. A sweep overwriting itself and a
  // clinician deciding something are different events; the timeline must not call them the
  // same thing.
  const store = readFileSync('lib/preop/store.ts', 'utf8');
  const save = store.slice(store.indexOf('export async function saveSnapshot'), store.indexOf('// ── reads'));
  assert.match(save, /humanIds\(row\.snapshot\) !== humanIds\(snap\) \? 'confirm' : 'overwrite'/);
  assert.match(save, /i\.source === 'HUMAN'/);
  // and it reaches the version row rather than being computed and dropped
  assert.match(save, /\}\), captureReason \}\)/);
});
