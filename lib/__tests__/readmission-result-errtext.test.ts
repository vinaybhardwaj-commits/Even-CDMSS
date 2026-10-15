/**
 *   node --import tsx --test lib/__tests__/readmission-result-errtext.test.ts
 * FU-READMIT-RESULT-ERRTEXT: the readmission workers store and return a CODE from WORKER_ERROR_CODES, never
 * exception text (backfill_runs.last_error / status message, readmission_findings.last_error, cron/admin JSON).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REFRESH_ERROR_CODES, WORKER_ERROR_CODES, classifyWorkerError, workerCatchCode } from '../readmission/health.ts';

// Read at module load by lib/llm.ts (GCP_PROJECT) before any dynamic import below.
process.env.GEMINI_READMIT_AUDIT = '1'; process.env.GCP_PROJECT = 'p'; process.env.GCP_SA_KEY = '{}';
process.env.DATABASE_URL = 'postgres://u:p@localhost.invalid/db';

const set = WORKER_ERROR_CODES as readonly string[];
const HOSTILES = [
  'arn:aws:iam::ACCOUNTID:role/secret-role',
  'sa-x@proj.iam.gserviceaccount.com',
  'AssumeRoleWithWebIdentity failed audience=//iam.googleapis.com/pool',
  'connect ETIMEDOUT db.example.invalid:443',
  'AccessDenied: arn:aws:iam::ACCOUNTID:role/x sa@proj.iam.gserviceaccount.com',
  'arn:aws:iam::12345:role/short-id',
];

test('WORKER_ERROR_CODES is the five bedrock codes plus the four worker codes', () => {
  assert.deepEqual([...WORKER_ERROR_CODES].sort(), ['audit_failed', 'error', 'id_token_failed', 'narrative_failed', 'not_configured', 'refresh_failed', 'run_failed', 'sts_denied', 'timeout'].sort());
});

test('classifyWorkerError: hostile text gives a code in the set and never echoes the input', () => {
  for (const h of HOSTILES) {
    for (const fb of ['refresh_failed', 'narrative_failed', 'audit_failed', 'run_failed'] as const) {
      const c = classifyWorkerError(h, fb);
      assert.ok(set.includes(c), c);
      assert.ok(c.length < 20 && !/arn:|@|ETIMEDOUT/.test(c));
    }
  }
  assert.equal(classifyWorkerError(HOSTILES[2], 'run_failed'), 'sts_denied');
  assert.equal(classifyWorkerError(HOSTILES[0], 'run_failed'), 'run_failed');
  assert.equal(classifyWorkerError(HOSTILES[3], 'audit_failed'), 'audit_failed');
  assert.equal(classifyWorkerError('timeout after 30000ms', 'run_failed'), 'timeout');
  assert.equal(classifyWorkerError('Bedrock is not configured', 'run_failed'), 'not_configured');
  assert.equal(classifyWorkerError(null, 'narrative_failed'), 'narrative_failed');
  assert.equal(classifyWorkerError(undefined, 'audit_failed'), 'audit_failed');
  assert.equal(classifyWorkerError('x', 'bogus' as never), 'run_failed');
});

test('workerCatchCode: returns a code, logs the raw message once with the prefix', () => {
  const logged: string[] = [];
  const orig = console.warn; console.warn = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    const c = workerCatchCode(new Error(HOSTILES[4]), 'run_failed', '[readmission-refresh]');
    assert.equal(c, 'sts_denied');
    assert.equal(logged.length, 1);
    assert.ok(logged[0].startsWith('[readmission-refresh] '));
    assert.ok(set.includes(workerCatchCode('plain string throw', 'audit_failed', '[t]')));
  } finally { console.warn = orig; }
});

test('refresh tick: a failed case writes its code (or a classified code) to last_error, never the reason text', async () => {
  const m = await import('../readmission/refresh.ts');
  assert.equal(m.refreshLastError({ code: 'model_disagreement', reason: HOSTILES[4] }), 'model_disagreement');
  const inSets = (v: string) => (REFRESH_ERROR_CODES as readonly string[]).includes(v) || set.includes(v);
  assert.ok(inSets(m.refreshLastError({ code: 'model_disagreement' })));
  const c = m.refreshLastError({ reason: HOSTILES[2] });
  assert.ok(inSets(c)); assert.equal(c, 'sts_denied');
  assert.equal(m.refreshLastError({ reason: HOSTILES[0] }), 'refresh_failed');
  assert.equal(m.refreshLastError({}), 'refresh_failed');
});

test('refresh result for a thrown leg carries code + attempt suffix only', async () => {
  const m = await import('../readmission/refresh.ts');
  const row = { dedup_key: 'IP-1|IP-2', finding_class: 'even_even', index_encounter_id: 'IP-1', readmit_encounter_id: 'IP-2', form_uid: null, uhid: 'UH-1', lane: 'tight_bounce', gap_days: 4, index_department: 'O', readmit_department: 'O', index_doctor: null, readmit_doctor: null, index_discharge_at: '2026-06-01T10:00:00+05:30', readmit_admit_at: '2026-06-05T09:30:00+05:30', cm_note: null, form_is_planned: null, form_same_condition: null, finding: {}, audited_at: '2026-08-18T00:00:00Z' };
  const r = await m.reanalyzeOnOpus(row as never, { save: false }, { assemble: async () => { throw new Error(HOSTILES[4]); }, trace: { start: async () => 't', finish: async () => {} } as never, usage: (async () => ({ tokensIn: 0, tokensOut: 0 })) as never });
  assert.equal(r.reason, 'sts_denied'); assert.equal(r.code, 'sts_denied');
});

test('narrative tick failure path stores a code, and both ticks and the audit use the helpers in source', () => {
  const nb = readFileSync(new URL('../readmission/narrative-backfill.ts', import.meta.url), 'utf8');
  const rf = readFileSync(new URL('../readmission/refresh.ts', import.meta.url), 'utf8');
  const rn = readFileSync(new URL('../readmission/run.ts', import.meta.url), 'utf8');
  assert.match(nb, /lastError = classifyWorkerError\(b\.reason, 'narrative_failed'\)/);
  assert.match(nb, /workerCatchCode\(e, 'run_failed', '\[readmission-narrative\]'\)/);
  assert.match(rf, /lastError = refreshLastError\(result\)/);
  assert.match(rf, /workerCatchCode\(e, 'run_failed', '\[readmission-refresh\]'\)/);
  assert.equal((rn.match(/workerCatchCode\(e, 'audit_failed', '\[readmission-audit\]'\)/g) ?? []).length, 2);
  assert.ok(!/String\(\(e as Error\)\.message\)\.slice\(0, 500\);\s*await setRunStatus/.test(nb + rf), 'no raw message into setRunStatus');
  assert.ok(!/recordAuditError\(row\.dedup_key, msg\)/.test(rn));
});

test('audit throw: recordAuditError receives a code from the set (SQL params captured at the neon fetch)', async () => {
  const bodies: string[] = [];
  const origFetch = globalThis.fetch; const origWarn = console.warn;
  console.warn = () => {};
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    bodies.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ message: HOSTILES[4], code: 'XX000' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const run = await import('../readmission/run.ts');
    // A row whose field read throws hostile text: the throw lands in the outer audit catch (no DB needed to provoke it).
    const row = { dedup_key: 'IP-1|IP-2', get finding_class(): string { throw new Error(HOSTILES[4]); } };
    const r = await run.runReadmissionAudit(row as never);
    assert.equal(r.status, 'failed');
    assert.ok(set.includes(r.reason!), `reason is a code: ${r.reason}`);
    const upd = bodies.map((b) => { try { return JSON.parse(b) as { query?: string; params?: unknown[] }; } catch { return {}; } }).find((j) => /UPDATE readmission_findings SET last_error/.test(j.query ?? ''));
    assert.ok(upd, 'recordAuditError issued its UPDATE');
    assert.ok(set.includes(String(upd!.params![2])), `last_error param is a code: ${String(upd!.params![2])}`);
    assert.ok(!JSON.stringify(upd).includes('arn:aws'));
  } finally { globalThis.fetch = origFetch; console.warn = origWarn; }
});
