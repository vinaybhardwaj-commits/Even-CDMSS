/**
 * lib/__tests__/rule-governance-core.test.ts — R3-A: the pure core.
 * Acceptance 2 (no valid_to; the window is DERIVED; reactivation yields TWO windows) and §3.4
 * (the evidence tuple is mandatory and ratified_by is never a role).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeVersionAt, asEvidence, DEFINITION_HASH_FIELDS, deriveValidityWindows,
  EVALUATOR_DISPOSITION, isRuleGovernanceEnabled, missingSnapshotKeys, PATTERN_SNAPSHOT_KEYS,
  RULE_GOVERNANCE_FLAG, ruleGovernanceGate, validateEvidence,
  type ActivationEvent,
} from '../rule-governance-core.ts';

// ══ the derived validity window (S2, §3.3, acceptance 2) ════════════════════════════════════════

const T = (n: number) => `2026-08-${String(n).padStart(2, '0')}T00:00:00.000Z`;

test('an activate with nothing after it is the OPEN window (valid_to null)', () => {
  const events: ActivationEvent[] = [{ rule_ref: 'r1', version: 1, event: 'activate', effective_at: T(1), id: 1 }];
  assert.deepEqual(deriveValidityWindows(events), [
    { rule_ref: 'r1', version: 1, valid_from: T(1), valid_to: null },
  ]);
});

test('a retire closes the window it follows; a retired rule has NO open window', () => {
  const events: ActivationEvent[] = [
    { rule_ref: 'r1', version: 1, event: 'activate', effective_at: T(1), id: 1 },
    { rule_ref: 'r1', version: 1, event: 'retire', effective_at: T(5), id: 2 },
  ];
  assert.deepEqual(deriveValidityWindows(events), [
    { rule_ref: 'r1', version: 1, valid_from: T(1), valid_to: T(5) },
  ]);
  assert.equal(activeVersionAt(events, 'r1', T(9)), null);
});

test('activating v2 closes v1 — the stream is per RULE, not per version', () => {
  const events: ActivationEvent[] = [
    { rule_ref: 'r1', version: 1, event: 'activate', effective_at: T(1), id: 1 },
    { rule_ref: 'r1', version: 2, event: 'activate', effective_at: T(4), id: 2 },
  ];
  assert.deepEqual(deriveValidityWindows(events), [
    { rule_ref: 'r1', version: 1, valid_from: T(1), valid_to: T(4) },
    { rule_ref: 'r1', version: 2, valid_from: T(4), valid_to: null },
  ]);
  assert.equal(activeVersionAt(events, 'r1', T(2)), 1);
  assert.equal(activeVersionAt(events, 'r1', T(4)), 2);
  assert.equal(activeVersionAt(events, 'r1', T(9)), 2);
});

// THE test acceptance 2 names: a stored valid_to could not represent this at all.
test('REACTIVATION yields TWO windows for the same version', () => {
  const events: ActivationEvent[] = [
    { rule_ref: 'r1', version: 1, event: 'activate', effective_at: T(1), id: 1 },
    { rule_ref: 'r1', version: 2, event: 'activate', effective_at: T(4), id: 2 },
    { rule_ref: 'r1', version: 1, event: 'activate', effective_at: T(7), id: 3 },   // back to v1
  ];
  const windows = deriveValidityWindows(events);
  assert.equal(windows.filter((w) => w.version === 1).length, 2, 'version 1 must have TWO windows');
  assert.deepEqual(windows, [
    { rule_ref: 'r1', version: 1, valid_from: T(1), valid_to: T(4) },
    { rule_ref: 'r1', version: 2, valid_from: T(4), valid_to: T(7) },
    { rule_ref: 'r1', version: 1, valid_from: T(7), valid_to: null },
  ]);
  assert.equal(activeVersionAt(events, 'r1', T(2)), 1);
  assert.equal(activeVersionAt(events, 'r1', T(5)), 2);
  assert.equal(activeVersionAt(events, 'r1', T(8)), 1);
});

test('two rules do not close each other’s windows', () => {
  const events: ActivationEvent[] = [
    { rule_ref: 'r1', version: 1, event: 'activate', effective_at: T(1), id: 1 },
    { rule_ref: 'r2', version: 1, event: 'activate', effective_at: T(2), id: 2 },
  ];
  assert.deepEqual(deriveValidityWindows(events), [
    { rule_ref: 'r1', version: 1, valid_from: T(1), valid_to: null },
    { rule_ref: 'r2', version: 1, valid_from: T(2), valid_to: null },
  ]);
});

test('events stamped in the same instant order by id, the way they were appended', () => {
  const events: ActivationEvent[] = [
    { rule_ref: 'r1', version: 2, event: 'activate', effective_at: T(1), id: 2 },
    { rule_ref: 'r1', version: 1, event: 'activate', effective_at: T(1), id: 1 },
  ];
  assert.deepEqual(deriveValidityWindows(events), [
    { rule_ref: 'r1', version: 1, valid_from: T(1), valid_to: T(1) },
    { rule_ref: 'r1', version: 2, valid_from: T(1), valid_to: null },
  ]);
});

test('a retire with no preceding activate produces no window at all', () => {
  const events: ActivationEvent[] = [{ rule_ref: 'r1', version: 1, event: 'retire', effective_at: T(3), id: 1 }];
  assert.deepEqual(deriveValidityWindows(events), []);
});

// ══ the evidence tuple (§3.4) ═══════════════════════════════════════════════════════════════════

const GOOD = {
  ratified_by: 'V (Dr Vinay Bhardwaj)', rationale: 'ruled on the 20 Aug sample',
  sample_size: 40, reviewed_n: 12, sample_seed: 'r3a-2026-08-20', n_not_belonging: 3,
};

test('a complete tuple validates', () => {
  assert.deepEqual(validateEvidence(GOOD), []);
  assert.deepEqual(asEvidence(GOOD), GOOD);
});

test('reviewed_n = 0 is LEGITIMATE — it is a ruling on an abstraction, not an error (0020:36)', () => {
  // ⚠️ `n_not_belonging` MUST BE null HERE, AND THAT IS THE NEW BOUND TALKING (R3-A2 §2). This
  // fixture previously carried `n_not_belonging: 3` alongside `reviewed_n: 0` and passed — a tuple
  // claiming three rows did not belong among zero reviewed. Nothing caught it because the bound
  // did not exist. Nothing reviewed means the count is not meaningful, and the core's own rule for
  // that case is "null is honest, 0 is a claim".
  assert.deepEqual(validateEvidence({ ...GOOD, reviewed_n: 0, sample_size: 0, n_not_belonging: null }), []);
});

test('R3A2 — n_not_belonging cannot exceed reviewed_n, and the bound is not vacuous', () => {
  // The bound the kickoff names as missing. Among the rows a human REVIEWED, how many did not
  // belong — so it cannot exceed the number reviewed.
  const over = validateEvidence({ ...GOOD, reviewed_n: 5, n_not_belonging: 6 });
  assert.equal(over.length, 1);
  assert.match(over[0], /^n_not_belonging: cannot exceed reviewed_n$/);
  // Equal is legal: every reviewed row may fail to belong.
  assert.deepEqual(validateEvidence({ ...GOOD, reviewed_n: 5, n_not_belonging: 5 }), []);
  assert.deepEqual(validateEvidence({ ...GOOD, reviewed_n: 5, n_not_belonging: 0 }), []);
  // Absent stays legal — "where meaningful" (§3.4).
  assert.deepEqual(validateEvidence({ ...GOOD, n_not_belonging: null }), []);
  // …and the OLD bound still holds, so the new one did not replace it.
  const negative = validateEvidence({ ...GOOD, n_not_belonging: -1 });
  assert.equal(negative.length, 1);
  assert.match(negative[0], /non-negative integer/);
  const reviewedOver = validateEvidence({ ...GOOD, reviewed_n: 41 });
  assert.ok(reviewedOver.some((x) => /reviewed_n: cannot exceed sample_size/.test(x)));
});

test('ratified_by must be a named human — every role literal is refused', () => {
  for (const role of ['admin', 'ADMIN', 'system', 'cron', 'worker', 'care-manager']) {
    const problems = validateEvidence({ ...GOOD, ratified_by: role });
    assert.equal(problems.length, 1, `${role} must be refused`);
    assert.match(problems[0], /^ratified_by:/);
  }
});

test('every evidence column is mandatory', () => {
  for (const k of ['ratified_by', 'rationale', 'sample_size', 'reviewed_n', 'sample_seed'] as const) {
    const bad: Record<string, unknown> = { ...GOOD };
    delete bad[k];
    assert.ok(validateEvidence(bad).some((p) => p.startsWith(`${k}:`)), `${k} must be required`);
  }
});

test('n_not_belonging is optional (null is honest where it is not meaningful) but typed when present', () => {
  assert.deepEqual(validateEvidence({ ...GOOD, n_not_belonging: null }), []);
  assert.deepEqual(asEvidence({ ...GOOD, n_not_belonging: null }).n_not_belonging, null);
  assert.ok(validateEvidence({ ...GOOD, n_not_belonging: -1 }).length);
  assert.ok(validateEvidence({ ...GOOD, n_not_belonging: 1.5 }).length);
});

test('reviewed_n cannot exceed sample_size, and neither may be negative or fractional', () => {
  assert.ok(validateEvidence({ ...GOOD, reviewed_n: 41 }).length);
  assert.ok(validateEvidence({ ...GOOD, sample_size: -1 }).length);
  assert.ok(validateEvidence({ ...GOOD, reviewed_n: 1.5 }).length);
});

test('asEvidence throws rather than writing an invalid tuple', () => {
  assert.throws(() => asEvidence({ ...GOOD, ratified_by: 'admin' }), /invalid evidence/);
});

// ══ the flag predicate (S3) ═════════════════════════════════════════════════════════════════════

test('the flag name and disposition are the ruled literals', () => {
  assert.equal(RULE_GOVERNANCE_FLAG, 'LVC_RULE_GOVERNANCE_ENABLED');
  assert.equal(EVALUATOR_DISPOSITION, 'informational');   // S4 — hardcoded, never an argument
});

test('only the exact string "1" enables', () => {
  assert.equal(isRuleGovernanceEnabled({ LVC_RULE_GOVERNANCE_ENABLED: '1' }), true);
  assert.deepEqual(ruleGovernanceGate({ LVC_RULE_GOVERNANCE_ENABLED: '1' }), { enabled: true });
});

// ══ the frozen snapshot (§3.7, S8) ══════════════════════════════════════════════════════════════

test('the snapshot key set names slots_provenance and all three shelf constants', () => {
  for (const k of ['slots_provenance', 'lvp_floor', 'lvp_cap', 'lvp_non_overuse_cap']) {
    assert.ok((PATTERN_SNAPSHOT_KEYS as readonly string[]).includes(k), `${k} must be a snapshot key`);
  }
});

test('missingSnapshotKeys names every absent key', () => {
  assert.deepEqual(missingSnapshotKeys({}).sort(), [...PATTERN_SNAPSHOT_KEYS].map(String).sort());
  const full = Object.fromEntries(PATTERN_SNAPSHOT_KEYS.map((k) => [k, null]));
  assert.deepEqual(missingSnapshotKeys(full), []);
  delete (full as Record<string, unknown>).slots_provenance;
  assert.deepEqual(missingSnapshotKeys(full), ['slots_provenance']);
});

test('the definition-hash field order is the five executable fields, fixed', () => {
  assert.deepEqual([...DEFINITION_HASH_FIELDS],
    ['statement', 'precondition', 'action_type', 'keywords', 'category']);
});
