// lib/__tests__/ipd-audit-gold.test.ts — the IPD audit gold governance pin (S2 close).
// The committed ipd-audit-gold/1.0 artifact must load, match the pinned content hash
// (drift = CI red = re-ratification required), stay de-identified, and keep the ratified
// stratification. Plus the loader's drift-rejection paths on synthetic mutations.
// Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadIpdAuditGold, goldContentSha256, IPD_AUDIT_GOLD_SHA256, IPD_AUDIT_GOLD_VERSION } from '../ipd-audit/gold';
import GOLD from '../../data/ipd-audit-gold.json';

test('the committed gold artifact is frozen, ratified, and hash-pinned', () => {
  const g = loadIpdAuditGold(GOLD);
  assert.equal(g.version, IPD_AUDIT_GOLD_VERSION);
  assert.equal(g.n, 25);
  assert.equal(g.validator, 'V');
  assert.equal(g.ratified_at, '2026-07-16');
  assert.equal(g.engine_version, 'ipd-discharge-audit/0.1');
  // the pin: in-file hash == recomputed == the governance constant
  assert.equal(goldContentSha256(g.cases), IPD_AUDIT_GOLD_SHA256);
  assert.equal(g.content_sha256, IPD_AUDIT_GOLD_SHA256);
  // ratified stratification holds
  assert.ok(new Set(g.cases.map((c) => c.speciality)).size >= 6, '≥6 specialities');
  assert.ok(new Set(g.cases.map((c) => c.month)).size >= 6, 'spread across months');
});

test('1.1 distribution block: every case carries the K=5 modal band + ranges; the S4 drift cases landed as ratified', () => {
  const g = loadIpdAuditGold(GOLD);
  for (const c of g.cases) {
    assert.ok(/^[A-E]$/.test(c.band_modal), `${c.id} band_modal`);
    assert.ok(/^[A-E](–[A-E])?$/.test(c.band_range), `${c.id} band_range shape`);
    assert.equal(c.k, 5);
    assert.ok(c.cvi_range[0] <= c.cvi_mean && c.cvi_mean <= c.cvi_range[1], `${c.id} mean inside range`);
    assert.ok(!('cvi' in c) && !('band' in c), `${c.id} carries no point cvi/band`);
  }
  // the decision doc's named drift cases (S4, V-ratified)
  const by = Object.fromEntries(g.cases.map((c) => [c.id, c]));
  assert.equal(by['IPD-G-08'].band_modal, 'C');
  assert.equal(by['IPD-G-18'].band_modal, 'C');
  assert.equal(by['IPD-G-16'].band_modal, 'D');
  assert.equal(by['IPD-G-17'].band_modal, 'A');
});

test('the gold is de-identified: no UHID / phone / honorific-name patterns anywhere', () => {
  const txt = JSON.stringify((GOLD as { cases: unknown[] }).cases);
  assert.ok(!/UHID[-\s]?\d/i.test(txt), 'no UHID');
  assert.ok(!/\b[6-9]\d{9}\b/.test(txt), 'no 10-digit phone');
  assert.ok(!/\b(Mr|Mrs|Ms|Master|Baby of|B\/O|W\/O|S\/O|D\/O)\.?\s+[A-Z]/.test(txt), 'no honorific+name');
  // the PHI-safety redaction holds: no resolvable GCS URLs in the committed gold (public repo
  // + publicly-readable bucket — document_id/ip_uid are the only re-identification keys)
  assert.ok(!/storage\.googleapis\.com|https?:\/\//.test(txt), 'no URLs in the committed gold');
  // only the sanctioned link-back keys exist — never a name/uhid field
  for (const c of (GOLD as { cases: Array<Record<string, unknown>> }).cases) {
    for (const k of Object.keys(c)) {
      assert.ok(!/name|uhid|phone|address|dob/i.test(k), `case field '${k}' looks like PHI`);
    }
  }
});

test('loadIpdAuditGold rejects drift: edited case, wrong version/status, dup id, bad verdict', () => {
  const clone = () => JSON.parse(JSON.stringify(GOLD)) as Record<string, unknown> & { cases: Array<Record<string, unknown>> };
  const edited = clone();
  (edited.cases[0] as { cvi_mean: number }).cvi_mean = 99;             // content edit → hash mismatch
  assert.throws(() => loadIpdAuditGold(edited), /drifted/);
  assert.throws(() => loadIpdAuditGold({ ...clone(), version: 'ipd-audit-gold/2.0' }), /version/);
  assert.throws(() => loadIpdAuditGold({ ...clone(), status: 'draft' }), /ratified/);
  assert.throws(() => loadIpdAuditGold({ ...clone(), validator: 'not-V' }), /single-validator/);
  const dup = clone();
  dup.cases[1].id = dup.cases[0].id;
  assert.throws(() => loadIpdAuditGold(dup));
});
