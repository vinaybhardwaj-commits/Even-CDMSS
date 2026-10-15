/**
 *   node --import tsx --test lib/__tests__/readmission-response-errtext.test.ts
 * FU-READMIT-RESPONSE-ERRTEXT: narrateOne's returned reason and the refresh leg record's verdicts.error carry a CODE
 * from WORKER_ERROR_CODES, never exception text. finishTrace keeps the raw text (traces are the admin error store).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORKER_ERROR_CODES } from '../readmission/health.ts';

process.env.GEMINI_READMIT_AUDIT = '1'; process.env.GCP_PROJECT = 'p'; process.env.GCP_SA_KEY = '{}';
process.env.DATABASE_URL = 'postgres://u:p@localhost.invalid/db';

const set = WORKER_ERROR_CODES as readonly string[];
const HOSTILES = [
  'arn:aws:iam::ACCOUNTID:role/secret-role',
  'sa-x@proj.iam.gserviceaccount.com',
  'AssumeRoleWithWebIdentity failed audience=//iam.googleapis.com/pool',
];
const leaks = (v: string) => /arn:|@|AssumeRole|iam\.|googleapis/.test(v);

const row = { dedup_key: 'IP-1|IP-2', finding_class: 'even_even', index_encounter_id: 'IP-1', readmit_encounter_id: 'IP-2', form_uid: null, uhid: 'UH-1', lane: 'tight_bounce', gap_days: 4, index_department: 'O', readmit_department: 'O', index_doctor: null, readmit_doctor: null, index_discharge_at: '2026-06-01T10:00:00+05:30', readmit_admit_at: '2026-06-05T09:30:00+05:30', cm_note: null, form_is_planned: null, form_same_condition: null, finding: {}, audited_at: '2026-08-18T00:00:00Z' };

test('narrateOne: a thrown hostile error returns a code, logs raw once with the prefix', async () => {
  const nb = await import('../readmission/narrative-backfill.ts');
  const logged: string[] = [];
  const orig = console.warn; console.warn = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    for (const h of HOSTILES) {
      logged.length = 0;
      // finding is a non-JSON-able getter that throws hostile text inside the try block via assembleForRow's field reads
      const bad = { ...row, finding: { x: 1 }, get index_encounter_id(): string { throw new Error(h); } };
      const r = await nb.narrateOne(bad as never);
      assert.equal(r.ok, false);
      assert.ok(set.includes(r.reason!), `code: ${r.reason}`);
      assert.ok(!leaks(r.reason!));
      assert.equal(logged.filter((l) => l.startsWith('[readmission-narrative] ')).length, 1);
    }
    assert.equal((await nb.narrateOne(bad2(HOSTILES[2]) as never)).reason, 'sts_denied');
  } finally { console.warn = orig; }
});
function bad2(h: string) { return { ...row, finding: { x: 1 }, get index_encounter_id(): string { throw new Error(h); } }; }

test('narrateOne: fixed literal reasons are unchanged', async () => {
  const nb = await import('../readmission/narrative-backfill.ts');
  assert.equal((await nb.narrateOne({ ...row, finding: null } as never)).reason, 'no finding blob on the audited row');
  assert.equal((await nb.narrateOne({ ...row, finding: { caseNarrative: 'x' } } as never)).reason, 'already has a caseNarrative (use force to rewrite)');
});

test('refresh leg record: a hostile leg error is a code in verdicts.error; absent error stays unparseable', async () => {
  const m = await import('../readmission/refresh.ts');
  const logged: string[] = [];
  const orig = console.warn; console.warn = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    const mk = (throwing: string | null) => m.reanalyzeOnOpus({ ...row, finding_class: 'out_of_network' } as never, { save: false }, {
      assemble: async () => ({ inputs: { catalog: { items: [] }, labProfile: '' }, indexDischargeAt: null, identity: {} }) as never,
      trace: { start: async () => 't', finish: async () => {} } as never,
      usage: (async () => ({ tokensIn: 0, tokensOut: 0 })) as never,
      pass: (() => async () => { if (throwing) throw new Error(throwing); return null; }) as never,
    });
    for (const h of HOSTILES) {
      logged.length = 0;
      const r = await mk(h);
      const errs = r.legs.map((l) => (l.verdicts as { error?: string }).error).filter((e): e is string => !!e);
      assert.ok(errs.length >= 1, 'a leg was recorded');
      for (const e of errs) { assert.ok(set.includes(e), e); assert.ok(!leaks(e)); }
      assert.ok(logged.some((l) => l.startsWith('[readmission-refresh] ')));
      assert.ok(!leaks(JSON.stringify(r.legs)));
    }
    const r2 = await mk(null);
    for (const l of r2.legs) assert.equal((l.verdicts as { error?: string }).error, 'unparseable');
  } finally { console.warn = orig; }
});

test('source: finishTrace still receives raw text; both sites use classifyWorkerError', () => {
  const nb = readFileSync(new URL('../readmission/narrative-backfill.ts', import.meta.url), 'utf8');
  const rf = readFileSync(new URL('../readmission/refresh.ts', import.meta.url), 'utf8');
  assert.match(nb, /finishTrace\(traceId, r\.ok \? 'success' : 'error', r\.ok \? undefined : r\.reason\)/);
  assert.match(nb, /finishTrace\(traceId, 'error', msg\)/);
  assert.match(nb, /workerCatchCode\(e, 'narrative_failed', '\[readmission-narrative\]'\)/);
  assert.match(rf, /classifyWorkerError\(err, 'refresh_failed'\)/);
});

test('narrateOne leg-failure branch classifies r.reason (no seam: composeCaseArtefacts is a direct import, so source assert)', () => {
  const nb = readFileSync(new URL('../readmission/narrative-backfill.ts', import.meta.url), 'utf8');
  assert.match(nb, /legReason = classifyWorkerError\(r\.reason, 'narrative_failed'\)/);
  assert.match(nb, /reason: legReason/);
});

