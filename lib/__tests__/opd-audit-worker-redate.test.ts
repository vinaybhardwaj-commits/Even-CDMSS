/**
 * A note re-dated in the source after it was audited must not be sent to the
 * model again, and that day must not stop the sweep.
 *
 *   node --test --import tsx lib/__tests__/opd-audit-worker-redate.test.ts
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  opdCandidatesToAudit,
  opdSourceNoteInstant,
  opdSweepDayCap,
  opdSweepStallDetail,
  opdSweepStep,
  runOpdSweep,
  type OpdSweepDayResult,
} from '../opd-audit-worker-core';

const REDATED = 'redateUid000001';
const FRESH = 'freshUid0000001';

const worker = readFileSync('app/api/opd-audit/worker/route.ts', 'utf8');
const store = readFileSync('lib/opd-audit-store.ts', 'utf8');

function dayResult(over: Partial<OpdSweepDayResult> & { day: string }): OpdSweepDayResult {
  return { total: 1, audited: 0, processed: 0, inserted: 0, remaining: 1, done: false, fetched: 0, ...over };
}

test('a re-dated uid is not part of the model batch', () => {
  const rows = [
    { uid: REDATED, timestamp: '2026-10-07T04:30:00.000Z' },
    { uid: FRESH },
  ];
  const split = opdCandidatesToAudit(rows, [REDATED]);
  assert.deepEqual(split.audit.map((row) => row.uid), [FRESH]);
  assert.deepEqual(split.alreadyAudited.map((row) => row.uid), [REDATED]);
  assert.equal(opdSourceNoteInstant(rows[0].timestamp, '2026-10-07'), '2026-10-07T04:30:00.000Z');
  assert.equal(opdSourceNoteInstant('not a date', '2026-10-07'), '2026-10-07T00:00:00+05:30');
});

test('a re-dated, already-audited note makes no model call and does not block the next day', async () => {
  const model: string[] = [];
  const held = new Set([REDATED]);
  const pages: Record<string, Array<{ uid: string }>> = {
    '2026-10-07': [{ uid: REDATED }],
    '2026-10-08': [{ uid: FRESH }],
  };
  const sweep = await runOpdSweep(['2026-10-07', '2026-10-08'], opdSweepDayCap(4), async (day) => {
    const rows = pages[day] ?? [];
    const split = opdCandidatesToAudit(rows, [...held]);
    for (const row of split.audit) model.push(row.uid);
    const inserted = split.audit.length;
    return dayResult({
      day,
      total: Math.max(rows.length, 1),
      audited: inserted,
      processed: split.audit.length,
      inserted,
      fetched: rows.length,
      remaining: split.alreadyAudited.length,
      done: false,
    });
  }, () => {});
  assert.deepEqual(model, [FRESH], 'the re-dated uid never reaches the model');
  assert.equal(sweep.stalled[0]?.day, '2026-10-07');
  assert.equal(sweep.stalled[0]?.processed, 0);
  assert.equal(sweep.stalled[0]?.inserted, 0);
  assert.equal(sweep.yielded?.day, '2026-10-08');
  assert.equal(sweep.yielded?.inserted, 1);
});

test('a day with processed > 0 and inserted == 0 advances to the next day', async () => {
  assert.equal(opdSweepStep({ processed: 1, inserted: 0, done: false }), 'stall');
  assert.equal(opdSweepStep({ processed: 0, inserted: 0, done: false }), 'stall');
  assert.equal(opdSweepStep({ processed: 1, inserted: 1, done: false }), 'yield');
  assert.equal(opdSweepStep({ processed: 1, inserted: 1, done: true }), 'skip');
  const seen: string[] = [];
  const sweep = await runOpdSweep(['2026-10-07', '2026-10-08'], opdSweepDayCap(4), async (day) => {
    seen.push(day);
    if (day === '2026-10-07') return dayResult({ day, processed: 1, inserted: 0, fetched: 1, remaining: 1, done: false });
    return dayResult({ day, processed: 1, inserted: 1, audited: 1, fetched: 1, remaining: 0, done: false });
  }, () => {});
  assert.deepEqual(seen, ['2026-10-07', '2026-10-08']);
  assert.equal(sweep.stalled.length, 1);
  assert.equal(sweep.stalled[0].processed, 1);
  assert.equal(sweep.stalled[0].inserted, 0);
  assert.equal(sweep.yielded?.day, '2026-10-08');
  assert.match(opdSweepStallDetail(sweep.stalled[0]), /processed 1, inserted 0/);
});

test('the day cap stops a run of stalls from walking past the cap', async () => {
  assert.equal(opdSweepDayCap(4), 4);
  assert.equal(opdSweepDayCap(99), 14);
  const seen: string[] = [];
  const sweep = await runOpdSweep(['2026-10-06', '2026-10-07', '2026-10-08'], 1, async (day) => {
    seen.push(day);
    return dayResult({ day, processed: 1, inserted: 0, done: false });
  }, () => {});
  assert.deepEqual(seen, ['2026-10-06']);
  assert.equal(sweep.exhausted, false);
  assert.equal(sweep.yielded, null);
});

test('the worker drops held uids before the model call, and the reaudit path is unchanged', () => {
  const processBody = worker.slice(worker.indexOf('async function processDay'), worker.indexOf('async function reconcileRedatedNotes'));
  const filterAt = processBody.indexOf('opdCandidatesToAudit');
  const heldAt = processBody.indexOf('auditedUidsHeldAnyDate');
  const modelAt = processBody.indexOf('auditOpdNote(');
  assert.ok(heldAt > 0 && filterAt > heldAt && filterAt < modelAt, 'already-audited uids are removed before auditOpdNote');
  assert.match(worker, /runOpdSweep\(/);
  assert.match(worker, /opdSweepDayCap\(lookback\)/);
  assert.match(worker, /startTrace\('opd_sweep_stall'/);
  assert.match(worker, /startTrace\('opd_note_redate'/);
  const reaudit = worker.slice(worker.indexOf("p.get('reaudit_uids')"), worker.indexOf('const cutoff = await forwardCutoff()'));
  assert.match(reaudit, /auditOpdNote\(row\)/);
  assert.doesNotMatch(reaudit, /auditedUidsHeldAnyDate|alignOpdAuditNoteDate|opdCandidatesToAudit/);
});

test('the any-date hold shares the audited predicate and does not filter on note date', () => {
  const hold = store.slice(
    store.indexOf('export async function auditedUidsHeldAnyDate'),
    store.indexOf('const SOURCE_NOTE_INSTANT'),
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(hold, /uid = ANY\(\$1::text\[\]\)/);
  assert.match(hold, /\$\{AUDITED_HAVING\}/);
  assert.doesNotMatch(hold, /note_date/);
  const align = store.slice(
    store.indexOf('export async function alignOpdAuditNoteDate'),
    store.indexOf('export async function earliestAuditedDay'),
  );
  assert.match(align, /SET note_date = \$2::timestamptz/);
  assert.doesNotMatch(align, /engine_version =/);
  assert.doesNotMatch(align, /note_quality_index/);
});

// ── the route, against stubbed Neon and db13 ──────────────────────────────────
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';
process.env.METABASE_URL = 'https://metabase.invalid.test';
process.env.METABASE_API_KEY = 'test-metabase-key';
delete process.env.PROVIDER_SWITCH_ENABLED;
delete process.env.OPD_AUDIT_LOOKBACK;
delete process.env.VITALS_EXTRACTION_ENABLED;
delete process.env.OBSTETRIC_EXTRACTION_ENABLED;

type SqlRow = Record<string, unknown>;

function neonResponse(rows: SqlRow[], columns = ['uid']): Response {
  const names = rows.length ? Object.keys(rows[0]) : columns;
  return new Response(JSON.stringify({
    command: 'SELECT',
    rowCount: rows.length,
    rowAsArray: false,
    fields: names.map((name, i) => ({
      name, tableID: 0, columnID: i + 1, dataTypeID: 25, dataTypeSize: -1, dataTypeModifier: -1, format: 'text',
    })),
    rows: rows.map((row) => names.map((name) => (row[name] == null ? null : String(row[name])))),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function metabaseResponse(cols: string[], rows: unknown[][]): Response {
  return new Response(JSON.stringify({
    data: { cols: cols.map((name) => ({ name })), rows },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('route: a re-dated audited note is aligned, not re-audited, and the sweep reaches the next day', async () => {
  const modelUrls: string[] = [];
  const metabaseDays: string[] = [];
  const sqlLog: Array<{ query: string; params: unknown[] }> = [];
  const dayIn = (query: string) => query.match(/\(ip\.timestamp AT TIME ZONE 'Asia\/Kolkata'\)::date = '(\d{4}-\d{2}-\d{2})'/)?.[1] ?? '';

  globalThis.fetch = (async (url: unknown, init: { body?: unknown } = {}) => {
    const target = String(url);
    const sent = JSON.parse(String(init.body || '{}')) as { query?: string; params?: unknown[]; native?: { query?: string } };
    if (sent.native?.query) {
      const query = sent.native.query;
      const day = dayIn(query);
      metabaseDays.push(day);
      if (/count\(DISTINCT ip\.uid\)/.test(query)) {
        return metabaseResponse(['n'], [[day === '2026-10-07' ? 1 : 0]]);
      }
      if (day === '2026-10-07') {
        return metabaseResponse(['uid', 'timestamp'], [[REDATED, '2026-10-07T04:30:00.000Z']]);
      }
      return metabaseResponse(['uid', 'timestamp'], []);
    }
    if (typeof sent.query === 'string') {
      const query = sent.query;
      const params = sent.params || [];
      sqlLog.push({ query, params });
      const flat = query.replace(/\s+/g, ' ');
      if (/UPDATE opd_note_audits/.test(flat)) {
        return neonResponse([{ uid: REDATED, from_day: '2026-10-06', to_day: '2026-10-07' }]);
      }
      if (/uid = ANY/.test(flat)) return neonResponse([{ uid: REDATED }]);
      if (/min\(\(note_date/.test(flat)) return neonResponse([{ d: '2026-10-05' }], ['d']);
      if (/\$1::date/.test(flat)) return neonResponse([]);
      return neonResponse([], ['ok']);
    }
    modelUrls.push(target);
    return new Response('unexpected fetch', { status: 500 });
  }) as typeof fetch;

  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-07T20:00:00.000Z') });
  try {
    const { NextRequest } = await import('next/server');
    const { GET } = await import('../../app/api/opd-audit/worker/route.ts');
    const res = await GET(new NextRequest('https://cat.test/api/opd-audit/worker?lookback=4', {
      headers: { 'x-vercel-cron': '1' },
    }));
    const body = await res.json() as {
      ok: boolean;
      mode: string;
      processed: number;
      stalled_days: Array<{ day: string; processed: number; inserted: number }>;
      error?: string;
    };
    assert.equal(res.status, 200, body.error);
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'sweep');
    assert.equal(body.processed, 0);
    assert.ok(body.stalled_days.some((day) => day.day === '2026-10-07' && day.processed === 0 && day.inserted === 0));
    assert.ok(metabaseDays.includes('2026-10-08'), 'the sweep continued to the next day');
    assert.deepEqual(modelUrls, [], 'no model call');
    assert.ok(sqlLog.some((entry) => /uid = ANY/.test(entry.query)), 'the any-date hold was consulted');
    const aligned = sqlLog.find((entry) => /UPDATE opd_note_audits/.test(entry.query));
    assert.ok(aligned, 'the stored note date was aligned');
    assert.equal(aligned?.params[0], REDATED);
    assert.equal(aligned?.params[1], '2026-10-07T04:30:00.000Z');
    assert.ok(sqlLog.some((entry) => entry.params.includes('opd_sweep_stall')));
    assert.ok(sqlLog.some((entry) => entry.params.includes('opd_note_redate')));
    const text = JSON.stringify(body);
    assert.equal(text.includes(REDATED), false);
  } finally {
    mock.timers.reset();
  }
});
