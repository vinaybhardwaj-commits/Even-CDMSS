/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-refresh-errtext.test.ts
 * FU-READMIT-REFRESH-ERRTEXT: lastRefreshError holds a CODE from a closed set, never free text; legacy
 * blobs with reason / message are scrubbed on read (stripCaseArtefacts, toFinding).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFRESH_ERROR_CODES, classifyRefreshFailure, normaliseRefreshCode } from '../readmission/health.ts';
import { stripCaseArtefacts, scrubErrorText } from '../readmission-narrative-core.ts';
import { scrubVersionRows } from '../readmission/versions-store.ts';
import { toFinding } from '../readmission/surface-row.ts';

const HOSTILE = 'AccessDenied: arn:aws:iam::ACCOUNTID:role/secret-role sa-x@proj.iam.gserviceaccount.com audience=//iam.googleapis.com/pool';
const set = REFRESH_ERROR_CODES as readonly string[];

const seamRow = (attempts: number) => ({
  dedup_key: 'IP-1|IP-2', finding_class: 'even_even', index_encounter_id: 'IP-1', readmit_encounter_id: 'IP-2', form_uid: null, uhid: 'UH-1', lane: 'tight_bounce', gap_days: 4,
  index_department: 'Ortho', readmit_department: 'Ortho', index_doctor: null, readmit_doctor: null, index_discharge_at: '2026-06-01T10:00:00+05:30', readmit_admit_at: '2026-06-05T09:30:00+05:30',
  cm_note: null, form_is_planned: null, form_same_condition: null, finding: { refreshAttempts: attempts }, audited_at: '2026-08-18T00:00:00Z',
});
const trace = { start: async () => 't-1', finish: async () => {} };
const usage0 = async () => ({ tokensIn: 0, tokensOut: 0 });
const recorder = () => { const writes: Array<Record<string, unknown>> = []; return { writes, save: async (_k: string, a: Record<string, unknown>) => { writes.push(a); return true; } }; };

test('the stored stamp has exactly {at, code, attempts, stuck} (no reason), on the assemble-failure path', async () => {
  const m = await import('../readmission/refresh.ts');
  const rec = recorder();
  await m.reanalyzeOnOpus(seamRow(0) as never, { save: true }, { assemble: async () => ({ notAuditable: HOSTILE }), saveArtefacts: rec.save as never, trace: trace as never, usage: usage0 as never });
  const e = rec.writes[0].lastRefreshError as Record<string, unknown>;
  assert.deepEqual(Object.keys(e).sort(), ['at', 'attempts', 'code', 'stuck']);
  assert.equal(e.code, 'reassemble_failed');
  assert.ok(!JSON.stringify(rec.writes).includes('arn:aws'), 'no hostile text stored');
});

test('hostile text from a thrown leg gives a code in the set; the stamp stays text-free; the admin result is unchanged', async () => {
  const m = await import('../readmission/refresh.ts');
  const rec = recorder();
  const r = await m.reanalyzeOnOpus(seamRow(0) as never, { save: true }, { assemble: async () => { throw new Error(HOSTILE); }, saveArtefacts: rec.save as never, trace: trace as never, usage: usage0 as never });
  const e = rec.writes[0].lastRefreshError as { code: string; reason?: string };
  assert.ok(set.includes(e.code)); assert.equal(e.code, 'sts_denied'); assert.equal('reason' in e, false);
  assert.match(r.reason!, /AccessDenied/, 'RefreshOneResult.reason (admin route response) is unchanged');
});

test('classifyRefreshFailure / normaliseRefreshCode: every kind and hostile text lands in the closed set', () => {
  assert.equal(classifyRefreshFailure('reassemble', HOSTILE), 'reassemble_failed');
  assert.equal(classifyRefreshFailure('disagreement', HOSTILE), 'model_disagreement');
  assert.equal(classifyRefreshFailure('write', HOSTILE), 'write_failed');
  assert.equal(classifyRefreshFailure('no_rows'), 'no_rows_landed');
  assert.equal(classifyRefreshFailure('thrown', 'timeout after 30000ms'), 'timeout');
  assert.equal(classifyRefreshFailure('thrown', 'generateIdToken failed for sa@x.iam'), 'id_token_failed');
  assert.equal(classifyRefreshFailure('thrown', 'recon pass A unparseable'), 'refresh_failed');
  for (const k of ['reassemble', 'disagreement', 'write', 'no_rows', 'thrown'] as const) assert.ok(set.includes(classifyRefreshFailure(k, HOSTILE)));
  assert.equal(normaliseRefreshCode(HOSTILE), 'refresh_failed');
  assert.equal(normaliseRefreshCode(undefined), 'refresh_failed');
  assert.equal(normaliseRefreshCode('sts_denied'), 'sts_denied');
});

test('a legacy blob with lastRefreshError.reason and narrativeError.message comes out of stripCaseArtefacts and toFinding without either key', () => {
  const legacy = () => ({
    refreshAttempts: 2, evidenceLedger: [{ id: 'S1' }],
    lastRefreshError: { at: '2026-10-01T00:00:00Z', reason: HOSTILE, code: 'x', attempts: 2, stuck: false },
    narrativeError: { at: '2026-10-01T00:00:00Z', code: 'error', message: HOSTILE },
  });
  const s = stripCaseArtefacts(legacy()) as ReturnType<typeof legacy>;
  assert.deepEqual(s.lastRefreshError, { at: '2026-10-01T00:00:00Z', code: 'x', attempts: 2, stuck: false });
  assert.deepEqual(s.narrativeError, { at: '2026-10-01T00:00:00Z', code: 'error' });
  assert.equal('evidenceLedger' in s, false); assert.equal(s.refreshAttempts, 2);
  const f = toFinding({ ...seamRow(0), finding: legacy() } as never, undefined);
  const fb = f.finding as unknown as ReturnType<typeof legacy>;
  assert.equal('reason' in fb.lastRefreshError, false); assert.equal('message' in fb.narrativeError, false);
  assert.equal(fb.lastRefreshError.attempts, 2); assert.equal(fb.lastRefreshError.stuck, false);
  assert.ok(!JSON.stringify(f).includes('AccessDenied'));
  const raw = legacy(); scrubErrorText(raw); assert.equal(raw.lastRefreshError.reason, HOSTILE, 'input is not mutated');
  assert.equal(scrubErrorText(null), null);
  assert.deepEqual(scrubErrorText({ a: 1 }), { a: 1 });
});

test('attempts and stuck logic are unchanged: n+1, parked at the cap, probe writes nothing', async () => {
  const m = await import('../readmission/refresh.ts');
  const a = recorder(); const b = recorder(); const p = recorder();
  const deps = (rec: ReturnType<typeof recorder>) => ({ assemble: async () => ({ notAuditable: 'x' }), saveArtefacts: rec.save as never, trace: trace as never, usage: usage0 as never });
  await m.reanalyzeOnOpus(seamRow(0) as never, { save: true }, deps(a));
  await m.reanalyzeOnOpus(seamRow(2) as never, { save: true }, deps(b));
  await m.reanalyzeOnOpus(seamRow(0) as never, { save: false }, deps(p));
  assert.equal(a.writes[0].refreshAttempts, 1); assert.equal((a.writes[0].lastRefreshError as { stuck: boolean }).stuck, false);
  assert.equal(b.writes[0].refreshAttempts, 3); assert.equal((b.writes[0].lastRefreshError as { stuck: boolean }).stuck, true);
  assert.equal(p.writes.length, 0);
});

test('a legacy row_snapshot comes back from the versions reader path without reason / message (object or JSON-string snapshot; input not mutated)', () => {
  const fin = () => ({ lastRefreshError: { at: 't', reason: HOSTILE, attempts: 1, stuck: false }, narrativeError: { at: 't', code: 'error', message: HOSTILE } });
  const row = { id: 'v1', row_snapshot: { dedup_key: 'k', finding: fin() } };
  const strRow = { id: 'v2', row_snapshot: JSON.stringify({ dedup_key: 'k', finding: JSON.stringify(fin()) }) };
  const [a, b] = scrubVersionRows([row, strRow]);
  for (const r of [a, b]) {
    const f = (r.row_snapshot as { finding: ReturnType<typeof fin> }).finding;
    assert.equal('reason' in f.lastRefreshError, false); assert.equal('message' in f.narrativeError, false);
    assert.equal(f.lastRefreshError.attempts, 1);
    assert.ok(!JSON.stringify(r).includes('AccessDenied'));
  }
  assert.equal((row.row_snapshot.finding.lastRefreshError as { reason?: string }).reason, HOSTILE, 'input not mutated');
  const odd = [{ id: 'v3', row_snapshot: null }, { id: 'v4', row_snapshot: { x: 1 } }];
  assert.deepEqual(scrubVersionRows(odd), odd);
});
