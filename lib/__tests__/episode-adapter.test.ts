// lib/__tests__/episode-adapter.test.ts — EpisodeState (#4) SL2: the toKxEnvelope PHI-drop mapper.
//
// THE SECURITY BOUNDARY. IpdAdmissionHeader carries PHI (patientName, uhid, ageGender, team).
// EpisodeState lands in a persisted, de-identified store; nothing PHI may cross toKxEnvelope. This
// test is STRUCTURAL, not example-based: it feeds a header with EVERY PHI field set to a sentinel,
// then asserts (a) no sentinel survives anywhere in the output, and (b) the output keys are EXACTLY
// the KxEnvelope whitelist — so a header that later grows a new PHI field still can't leak, because
// the mapper constructs from a fixed key set rather than spreading the header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IpdAdmissionHeader } from '../ipd-audit/db13';
import type { BillingEnvelope } from '../ipd-audit/billing';
import { toKxEnvelope } from '../ipd-audit/episode-adapter';

const PHI = {
  patientName: '__PHI_NAME__Jane Q Patient',
  uhid: '__PHI_UHID__UH0099123',
  ageGender: '__PHI_AGEGENDER__43/F',
  team: '__PHI_TEAM__Dr Sensitive Consultant',
};

const HEADER: IpdAdmissionHeader = {
  ipUid: 'IP-9001',
  patientName: PHI.patientName,   // PHI
  uhid: PHI.uhid,                 // PHI
  ageGender: PHI.ageGender,       // PHI (coarse, still identifying)
  speciality: 'Cardiology',
  team: PHI.team,                 // PHI
  ward: 'CCU',
  dischargeType: 'Routine',
  admitDate: '2026-07-01',
  dischargeDate: '2026-07-05',
  losDays: 4,
  status: 'discharged',
};

const BILLING = { ipUid: 'IP-9001', netTotal: 73210.339999, saleTotal: 80000, refundTotal: -6789.66,
  lineCount: 42, billCount: 1, categories: [], wardClasses: [], pharmacyItems: [], pharmacyClasses: [] } as unknown as BillingEnvelope;

const ALLOWED_KEYS = ['episodeRef', 'speciality', 'ward', 'dischargeType', 'admitDate', 'dischargeDate', 'losDays', 'netTotal'];

test('toKxEnvelope drops ALL PHI — no sentinel value survives anywhere in the output', () => {
  const kx = toKxEnvelope(HEADER, BILLING);
  const blob = JSON.stringify(kx);
  for (const [field, sentinel] of Object.entries(PHI)) {
    assert.ok(!blob.includes(sentinel), `PHI '${field}' leaked into the KxEnvelope`);
  }
  // even the bare substring markers must be gone
  assert.ok(!blob.includes('__PHI_'), 'no PHI sentinel marker survives');
});

test('toKxEnvelope is a WHITELIST — output keys are exactly the non-PHI set', () => {
  const kx = toKxEnvelope(HEADER, BILLING)!;
  assert.deepEqual(Object.keys(kx).sort(), [...ALLOWED_KEYS].sort(),
    'the envelope carries only the whitelisted non-PHI fields — no PHI key can ride along');
  // the non-PHI facts DO come through
  assert.equal(kx.episodeRef, 'IP-9001');
  assert.equal(kx.speciality, 'Cardiology');
  assert.equal(kx.ward, 'CCU');
  assert.equal(kx.losDays, 4);
  // ₹ float noise is killed at this boundary
  assert.equal(kx.netTotal, 73210.34);
});

test('toKxEnvelope keys on any available link-back id, and returns null when there is none', () => {
  // header missing but billing present ⇒ episodeRef from billing
  const fromBilling = toKxEnvelope(null, BILLING);
  assert.equal(fromBilling?.episodeRef, 'IP-9001');
  assert.equal(fromBilling?.speciality, null, 'no header ⇒ null clinical-admin facts, never invented');
  // both null ⇒ nothing to key on ⇒ null (no envelope)
  assert.equal(toKxEnvelope(null, null), null);
  // a header with no ipUid and no billing ⇒ null
  assert.equal(toKxEnvelope({ ...HEADER, ipUid: '' } as IpdAdmissionHeader, null), null);
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the mapper never spreads the header (a structural guard against future PHI fields)', () => {
  const src = code('lib/ipd-audit/episode-adapter.ts');
  // a spread of the header would silently forward any PHI field the type gains later
  assert.ok(!/\.\.\.header/.test(src), 'toKxEnvelope must not spread the header — whitelist construction only');
  // and it must never name the PHI fields
  for (const phi of ['patientName', 'uhid', 'ageGender']) {
    assert.ok(!new RegExp(`header[?.]*\\.${phi}`).test(src), `toKxEnvelope must not read header.${phi}`);
  }
});

test('persist is BEST-EFFORT: never throws, and runs AFTER the audit is saved', () => {
  const adapter = code('lib/ipd-audit/episode-adapter.ts');
  // persistEpisodeState wraps everything in try/catch and returns null on failure
  assert.ok(/export async function persistEpisodeState[\s\S]*try \{[\s\S]*\} catch \([\s\S]*return null;/.test(adapter),
    'persistEpisodeState must swallow all errors and return null (a failure never breaks the audit)');

  // both audit pipelines call it AFTER their save, so a persist failure can never undo the audit
  for (const [file, saveCall] of [
    ['lib/ipd-audit/run.ts', 'saveIpdAudit(row)'],
    ['app/api/admin/ipd-audit-now/route.ts', 'saveIpdAudit(row)'],
  ] as const) {
    const src = code(file);
    const iSave = src.indexOf(saveCall);
    const iPersist = src.indexOf('persistEpisodeState(');
    assert.ok(iSave >= 0 && iPersist > iSave, `${file}: persistEpisodeState must be called AFTER saveIpdAudit`);
  }
});

test('the store is idempotent + de-identified (UPSERT on document_id+version, no PHI columns)', () => {
  const store = code('lib/episode-state/store.ts');
  assert.ok(/ON CONFLICT \(document_id, version\) DO UPDATE/.test(store), 'idempotent upsert on (document_id, version)');
  // writes only link-back keys + the (already de-identified) state — no PHI column exists to write
  assert.ok(/INSERT INTO episode_states \(document_id, ip_uid, version, state\)/.test(store), 'only link-back keys + state are written');
  for (const phi of ['patient_name', 'uhid', 'patientName', 'ageGender']) {
    assert.ok(!store.includes(phi), `the store must never reference '${phi}'`);
  }
  const mig = readFileSync(join(process.cwd(), 'migrations/0016_episode_states.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.ok(/UNIQUE \(document_id, version\)/.test(mig), 'the table enforces one row per (document_id, version)');
  for (const phi of ['patient_name', 'uhid ', 'age_gender', 'pdf_url']) {
    assert.ok(!mig.toLowerCase().includes(phi), `the table must have no '${phi.trim()}' column`);
  }
});

test('EpisodeState stays STANDALONE — the namespace never imports ipd-audit', () => {
  // the adapter lives in ipd-audit (the consumer); episode-state must not depend back on it
  for (const f of ['lib/episode-state/schema.ts', 'lib/episode-state/build-intra.ts', 'lib/episode-state/store.ts']) {
    assert.ok(!/from '\.\.\/ipd-audit/.test(code(f)), `${f} must not import ipd-audit (EpisodeState is standalone)`);
  }
});
