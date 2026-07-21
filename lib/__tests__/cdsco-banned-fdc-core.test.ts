// CDSCO banned-FDC check (PRD CDMSS-CDSCO-BANNED-FDC §8) — the C5 exact-set boundary, the C4
// signal-identity amendment + its collapse regression guard, the severity floor (both halves),
// and the §7 fail-safes. Test fixtures use PLACEHOLDER molecule names (mol-a/mol-b/…) on purpose:
// no real banned-drug data may originate from a builder, including in tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannedFdcFindings, normalizeMoleculeSet, type BannedFdcTable } from '../cdsco-banned-fdc-core';
import { bannedFdcFindings as loaderFindings, CDSCO_BANNED_FDC_VERSION } from '../cdsco-banned-fdc';
import { stampFindingIdentity, BANNED_FDC_SUBJECT_RE, OPD_SIGNAL_TYPES, type OpdFinding } from '../opd-note-audit-core';
import { applyDemotes, demoteRuleViolatesSeverityFloor, isSafetySignalType, type Suppression } from '../audit-suppression-core';
import type { OpdMed } from '../opd-ingest-core';

const med = (over: Partial<OpdMed> = {}): OpdMed => ({ name: 'BrandX', ...over } as OpdMed);
const TABLE: BannedFdcTable = {
  version: 'cdsco-banned-fdc/test',
  entries: [
    { id: 'test-entry-1', molecules: ['mol-a', 'mol-b'], notification_date: '2026-06-11', gazette_ref: 'S.O. TEST(E)' },
    { id: 'test-entry-2', molecules: ['mol-c', 'mol-d', 'mol-e'], notification_date: '2026-06-11', gazette_ref: 'S.O. TEST2(E)' },
  ],
};

test('exact two-molecule match fires: confidence 1.0, det shape, gazette ref + date in rationale', () => {
  const out = bannedFdcFindings([med({ resolvedGeneric: 'Mol-A + Mol-B' })], TABLE);
  assert.equal(out.length, 1);
  const f = out[0];
  assert.equal(f.subject, 'Banned fixed-dose combination: mol-a + mol-b');
  assert.equal(f.verdict, 'low-value');
  assert.equal(f.confidence, 1.0);
  assert.equal(f.domain, 'prescribing_safety');
  assert.equal(f.source, 'deterministic');
  assert.deepEqual([f.evidence, f.estimates, f.citation_ids], [[], [], []]);
  assert.match(f.rationale, /Section 26A/);
  assert.match(f.rationale, /S\.O\. TEST\(E\)/);
  assert.match(f.rationale, /2026-06-11/);
});

test('C5 boundary: superset does NOT fire (banned core + one extra molecule)', () => {
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b + mol-z' })], TABLE), []);
  // 4-molecule product containing the banned 3-molecule core
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-c/mol-d/mol-e/mol-f' })], TABLE), []);
});

test('C5 boundary: subset does NOT fire (single molecule of a banned pair; 2 of a banned 3)', () => {
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a' })], TABLE), []);
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-c + mol-d' })], TABLE), []);
});

test('order-independence + separator variants + case: ["b","a"] matches an entry stored ["a","b"]', () => {
  for (const g of ['mol-b + mol-a', 'MOL-B/MOL-A', 'mol-b, mol-a', ' mol-b +  mol-a ']) {
    assert.equal(bannedFdcFindings([med({ resolvedGeneric: g })], TABLE).length, 1, g);
  }
  assert.deepEqual(normalizeMoleculeSet(['B', ' a ', '', 'b']), ['a', 'b']);
});

test('unresolved brand (no resolvedGeneric, no generic) → no finding, no throw — the accepted miss', () => {
  assert.deepEqual(bannedFdcFindings([med()], TABLE), []);
  assert.deepEqual(bannedFdcFindings([med({ generic: '' })], TABLE), []);
});

test('empty / malformed table → empty array, never a throw (§7 fail-safe)', () => {
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b' })], { version: 'x', entries: [] }), []);
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b' })], {} as never), []);
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b' })], null as never), []);
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b' })], { version: 'x', entries: [{ id: 'bad', molecules: 'not-an-array' }] } as never), []);
  // a malformed single-molecule "combination" entry can never fire either
  assert.deepEqual(bannedFdcFindings([med({ resolvedGeneric: 'mol-a' })], { version: 'x', entries: [{ id: 'one', molecules: ['mol-a'], notification_date: '', gazette_ref: '' }] }), []);
});

test('same banned combination in two products → ONE finding (per-entry dedupe)', () => {
  const out = bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b' }), med({ resolvedGeneric: 'mol-b + mol-a' })], TABLE);
  assert.equal(out.length, 1);
});

test('STAGE-1 DORMANCY: the shipped seed has zero entries — the bound loader can never fire', () => {
  assert.equal(CDSCO_BANNED_FDC_VERSION, 'cdsco-banned-fdc/0.0');
  assert.deepEqual(loaderFindings([med({ resolvedGeneric: 'mol-a + mol-b' })]), []);
});

// ── C4 — signal identity ──────────────────────────────────────────────────────
const lv = (subject: string): OpdFinding => ({
  subject, verdict: 'low-value', confidence: 1, domain: 'prescribing_safety',
  rationale: 'r', evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
});

test('stampFindingIdentity: banned-FDC subject keeps banned_fdc; EVERY other low-value collapses to low_value_care', () => {
  const [fdc] = stampFindingIdentity([lv('Banned fixed-dose combination: mol-a + mol-b')]);
  assert.equal(fdc.signal_type, 'banned_fdc');
  assert.ok(BANNED_FDC_SUBJECT_RE.test(fdc.subject));
  assert.equal(OPD_SIGNAL_TYPES.banned_fdc, 'Banned fixed-dose combination');
  // regression guard: the C4 carve-out is surgical — other low-value subjects still batch as LVC,
  // including ones that would hit a SIGNAL_TYPE_RULES prefix if the verdict collapse didn't win
  for (const s of ['Unindicated vitamin D test', 'Interaction: a + b', 'Perioperative PPI without indication', 'Daily dose exceeds ceiling: x']) {
    const [f] = stampFindingIdentity([lv(s)]);
    assert.equal(f.signal_type, 'low_value_care', s);
  }
});

// ── C4 — quieting severity floor, both halves ─────────────────────────────────
test('severity floor: banned_fdc is protected — store half refuses, engine half skips a hostile rule', () => {
  assert.equal(isSafetySignalType('banned_fdc'), true);
  assert.equal(demoteRuleViolatesSeverityFloor({ action: 'demote', signal_type: 'banned_fdc' }), true);
  const hostile: Suppression = {
    id: 'hostile', signal_type: 'banned_fdc', discriminator: 'mol-a', match_kind: 'subject_contains',
    scope: 'all', doctor_uid: null, action: 'demote', active: true, status: 'active',
  };
  const stamped = stampFindingIdentity([lv('Banned fixed-dose combination: mol-a + mol-b')]);
  const { findings, quieted } = applyDemotes(stamped, null, [hostile]);
  assert.equal(quieted.length, 0);
  assert.equal((findings[0] as unknown as Record<string, unknown>).informational, undefined);
  assert.equal((findings[0] as unknown as Record<string, unknown>).quieted_by, undefined);
});
