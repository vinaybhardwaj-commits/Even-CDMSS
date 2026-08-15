/**
 * lib/__tests__/role-keyed-defects.test.ts — pass 0b, the cross-role contamination.
 *
 * ⚠️ THE DEFECT. `RetrievalTelemetryOutcome.manifestDefects` was one flat `string[]`, described by
 * the store's own comment as "whichever role was dirtiest", and `outcomeForOwnedSave` then marked
 * the WHOLE save dirty if it was non-empty. Two rows, one verdict, belonging to neither: a
 * `normative_channel` defect made the `primary` row `persisted_partial`, and the reverse held.
 *
 * The acceptance property, stated as the kickoff states it:
 *   a primary-role defect must not make a normative row dirty,
 *   a normative-role defect must not make a primary row dirty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDbStub, type DbStub } from './telemetry-db-stub';
import { settleRetrievalTelemetry, settleOwned, outcomeForOwnedSave, upgradeForDefects } from '../retrieval-settlement';
import type { LifecycleHandle } from '../retrieval-telemetry-store';

const AT = '2026-08-15T00:00:00.000Z';
const AUDIT = '11111111-1111-1111-1111-111111111111';
const SELECT_ROW = /SELECT persistence_state, row_revision, audit_id/;
const UPDATE_SETTLE = /SET persistence_state = \$3, audit_id = \$4/;

/** Both roles declared, both terminal-written, both linkable — the two-role handle production builds. */
const twoRoleHandle = (): LifecycleHandle => ({
  invocationId: 'inv-1',
  runs: [
    { role: 'primary', runId: 'r-prim', expectedRevision: 1 },
    { role: 'normative_channel', runId: 'r-norm', expectedRevision: 1 },
  ],
  persistenceIntent: 'will_persist',
});

/** Every role reached `retrieval_complete`, so the outcome applies directly and nothing reconciles. */
function readyStub(): DbStub {
  const db = installDbStub();
  db.on(SELECT_ROW, [{ persistence_state: 'retrieval_complete', row_revision: 1, audit_id: null }]);
  db.on(UPDATE_SETTLE, (c) => [{ row_revision: Number(c.params[1]) + 1 }]);
  return db;
}

/** The state each run was actually settled to, keyed by run id. $1 runId, $3 state, $4 auditId. */
function settledStates(db: DbStub): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of db.matching(UPDATE_SETTLE)) out[String(c.params[0])] = String(c.params[2]);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1–4. Cross-role isolation, the four corners
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('1 — a PRIMARY defect leaves the NORMATIVE run clean', async () => {
  const db = readyStub();
  await settleRetrievalTelemetry(twoRoleHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: { primary: ['scorer_context_hmac_absent'] },
  });
  const states = settledStates(db);
  assert.equal(states['r-prim'], 'persisted_partial', 'the role that HAS the defect is partial');
  assert.equal(states['r-norm'], 'persisted_complete', 'and the role that does not is NOT dragged with it');
});

test('2 — a NORMATIVE defect leaves the PRIMARY run clean', async () => {
  // This is the direction that actually bit: the normative channel is the more permissive manifest,
  // so its defects were the likelier ones to exist — and they were marking the primary row partial.
  const db = readyStub();
  await settleRetrievalTelemetry(twoRoleHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: { normative_channel: ['expansion_served_route_class_absent'] },
  });
  const states = settledStates(db);
  assert.equal(states['r-norm'], 'persisted_partial');
  assert.equal(states['r-prim'], 'persisted_complete', 'THE acceptance property');
});

test('3 — both roles dirty: both settle dirty', async () => {
  const db = readyStub();
  await settleRetrievalTelemetry(twoRoleHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: { primary: ['a'], normative_channel: ['b'] },
  });
  const states = settledStates(db);
  assert.equal(states['r-prim'], 'persisted_partial');
  assert.equal(states['r-norm'], 'persisted_partial');
});

test('4 — neither dirty: both settle clean', async () => {
  const db = readyStub();
  await settleRetrievalTelemetry(twoRoleHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: { primary: [], normative_channel: [] },
  });
  const states = settledStates(db);
  assert.equal(states['r-prim'], 'persisted_complete');
  assert.equal(states['r-norm'], 'persisted_complete');
});

test('4b — an EMPTY array and an ABSENT key both settle clean, and they are different statements', async () => {
  // A role that validated clean has an empty array. A role that never produced a manifest has no
  // key at all. Both settle clean — but only one of them ran, and the map says which.
  const db = readyStub();
  await settleRetrievalTelemetry(twoRoleHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: { primary: [] },     // normative_channel absent entirely
  });
  const states = settledStates(db);
  assert.equal(states['r-prim'], 'persisted_complete');
  assert.equal(states['r-norm'], 'persisted_complete', 'an absent key is not evidence of a defect');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5. The map absent entirely — today's behaviour for a single-role save
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('5 — no map at all: a single-role save behaves exactly as before', async () => {
  const db = readyStub();
  const single: LifecycleHandle = {
    invocationId: 'inv-2',
    runs: [{ role: 'primary', runId: 'r-only', expectedRevision: 1 }],
    persistenceIntent: 'will_persist',
  };
  await settleRetrievalTelemetry(single, { outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT });
  assert.equal(settledStates(db)['r-only'], 'persisted_complete');

  // …and through `settleOwned`, which is the shape every owner actually calls.
  const db2 = readyStub();
  await settleOwned(single, 'persisted_clean', AUDIT);
  assert.equal(settledStates(db2)['r-only'], 'persisted_complete');
});

test('5b — only the CLEAN branch is upgraded; a losing race or a skip is never made partial', () => {
  // Unchanged from before the rekeying, and stated directly because it is the one rule the upgrade
  // has: neither `exists` nor `skipped` persisted anything to be partial about.
  assert.equal(upgradeForDefects('persisted_clean', ['x']), 'persisted_dirty');
  assert.equal(upgradeForDefects('persisted_clean', []), 'persisted_clean');
  assert.equal(upgradeForDefects('losing_conflict', ['x']), 'losing_conflict');
  assert.equal(upgradeForDefects('persistence_skipped', ['x']), 'persistence_skipped');
  assert.equal(upgradeForDefects('audit_persistence_failed', ['x']), 'audit_persistence_failed');
  assert.equal(upgradeForDefects('no_persistence_intended', ['x']), 'no_persistence_intended');

  // NO DEFECT CODE CHANGED MEANING. `outcomeForOwnedSave` now returns the BASE outcome only — the
  // same four mappings it always had — and the upgrade moved to the run, where the manifest is.
  assert.equal(outcomeForOwnedSave('inserted'), 'persisted_clean');
  assert.equal(outcomeForOwnedSave('updated'), 'persisted_clean');
  assert.equal(outcomeForOwnedSave('exists'), 'losing_conflict');
  assert.equal(outcomeForOwnedSave('skipped'), 'persistence_skipped');
});

test('5c — a revision-0 role is still not linked, and the per-run upgrade did not disturb that', async () => {
  // The upgrade happens before the linkable check, so a role that never wrote its terminal manifest
  // is still unlinked and still settled from the failure evidence.
  const db = installDbStub();
  db.on(SELECT_ROW, (c) => (String(c.params[0]) === 'r-norm'
    ? [{ persistence_state: 'started', row_revision: 0, audit_id: null }]
    : [{ persistence_state: 'retrieval_complete', row_revision: 1, audit_id: null }]));
  db.on(UPDATE_SETTLE, (c) => [{ row_revision: Number(c.params[1]) + 1 }]);
  db.on(/SELECT failed_phase/, []);

  const handle: LifecycleHandle = {
    invocationId: 'inv-3',
    runs: [
      { role: 'primary', runId: 'r-prim', expectedRevision: 1 },
      { role: 'normative_channel', runId: 'r-norm', expectedRevision: 0 },
    ],
    persistenceIntent: 'will_persist',
  };
  await settleRetrievalTelemetry(handle, {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
    manifestDefectsByRole: { primary: ['x'] },
  });
  const updates = db.matching(UPDATE_SETTLE);
  const norm = updates.find((c) => String(c.params[0]) === 'r-norm');
  assert.equal(norm?.params[3], null, 'the unwritten role is still not linked to the audit');
  assert.equal(norm?.params[2], 'aborted', 'and is still settled from the failure evidence');
  const prim = updates.find((c) => String(c.params[0]) === 'r-prim');
  assert.equal(prim?.params[2], 'persisted_partial', 'while the primary carries its OWN defect');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6. Every persistence owner reaches the same derivation
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('6 — every persistence owner passes the role map, and none passes an empty one where it holds defects', () => {
  // ⚠️ SOURCE-CHECKED ACROSS ALL SIX OWNERS, because the failure mode is an owner that silently
  // keeps the old behaviour. The field RENAME is what makes that structurally impossible — a stale
  // `.manifestDefects` no longer typechecks — and this pins the positive form as well.
  const owners = [
    'app/api/opd-audit/run/route.ts',
    'app/api/opd-audit/worker/route.ts',
    'app/api/admin/opd-audit-mini-backfill/route.ts',
    'lib/mcp-tools.ts',
    'scripts/bedrock-opd-note-probe.mjs',
  ];
  for (const f of owners) {
    const src = readFileSync(f, 'utf8');
    assert.equal(/\.manifestDefects\b/.test(src), false, `${f} still reads the flat list`);
    assert.match(src, /manifestDefectsByRole/, `${f} does not read the role map`);
    // Every settle that carries a save result must also carry the map.
    for (const m of src.matchAll(/settleOwned\([^)]*outcomeForOwnedSave\([^)]*\)[^)]*\)/g)) {
      assert.match(m[0], /defectsByRole/, `${f}: a save-result settle without the map: ${m[0]}`);
    }
  }
  // The producer keys by role rather than merging.
  const audit = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.match(audit, /defectsByRole\.primary = validateManifest\(/);
  assert.match(audit, /defectsByRole\.normative_channel = validateManifest\(/);
  assert.equal(/defects\.push\(\.\.\.validateManifest/.test(audit), false, 'the flat merge is gone');
});

test('6b — the upgrade is applied in settlement, not by the owners', () => {
  // The design: one base outcome per handle, one settlement call, the upgrade per run inside
  // `settleRetrievalTelemetry`. An owner computing `persisted_dirty` itself would be the old shape.
  const settlement = readFileSync('lib/retrieval-settlement.ts', 'utf8');
  assert.match(settlement, /const roleDefects = input\.manifestDefectsByRole\?\.\[run\.role\] \?\? \[\];/);
  assert.match(settlement, /const runOutcome = upgradeForDefects\(input\.outcome, roleDefects\);/);
  for (const f of [
    'app/api/opd-audit/run/route.ts', 'app/api/opd-audit/worker/route.ts',
    'app/api/admin/opd-audit-mini-backfill/route.ts', 'lib/mcp-tools.ts',
    'scripts/bedrock-opd-note-probe.mjs',
  ]) {
    assert.equal(
      /persisted_dirty/.test(readFileSync(f, 'utf8')), false,
      `${f} computes the dirty upgrade itself — that belongs to the run, not the owner`,
    );
  }
});

test('6c — settleOwned still takes ONE base outcome and makes ONE settlement call', async () => {
  // The design constraint, asserted rather than assumed: the map is a trailing optional argument,
  // so no positional argument moved, and one call still settles the whole handle.
  const db = readyStub();
  await settleOwned(twoRoleHandle(), 'persisted_clean', AUDIT, { primary: ['x'] });
  const updates = db.matching(UPDATE_SETTLE);
  assert.equal(updates.length, 2, 'one call, one UPDATE per declared run — not one call per role');
  const states = settledStates(db);
  assert.equal(states['r-prim'], 'persisted_partial');
  assert.equal(states['r-norm'], 'persisted_complete');
});

test('6d — settlement is fail-safe: a role map on a handle with no runs settles nothing and throws nothing', async () => {
  const db = readyStub();
  await settleOwned(null, 'persisted_clean', AUDIT, { primary: ['x'] });
  await settleOwned({ invocationId: 'i', runs: [], persistenceIntent: 'will_persist' }, 'persisted_clean', AUDIT, { primary: ['x'] });
  assert.equal(db.matching(UPDATE_SETTLE).length, 0, 'the uninstrumented path still costs nothing');
});
