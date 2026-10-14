import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET } from '../../app/api/engines/member-state/route';

const TOKEN = 'tok-abc-123';
const UID = 'ind_ABC123xyz';
const URL0 = 'https://x.test/api/engines/member-state';
const call = (qs: string, auth: string | null = `Bearer ${TOKEN}`) =>
  GET(new NextRequest(`${URL0}${qs}`, { headers: auth === null ? {} : { authorization: auth } }));

const realFetch = globalThis.fetch;
const realLog = console.log;
let logs: string[] = [];
let fetchCalls = 0;
let mode: 'empty' | 'rows' | 'throw' = 'empty';

const dataset = (cols: string[], rows: unknown[][]) =>
  new Response(JSON.stringify({ status: 'completed', data: { cols: cols.map((name) => ({ name })), rows } }), { status: 200 });

beforeEach(() => {
  process.env.ENGINE_MEMBER_STATE = '1';
  process.env.NEWCAT_ENGINE_TOKEN = TOKEN;
  process.env.METABASE_URL = 'https://mb.test';
  process.env.METABASE_API_KEY = 'k';
  delete process.env.CARE_CALL_ENABLED; delete process.env.PROMS_ENABLED;
  logs = []; fetchCalls = 0; mode = 'empty';
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    fetchCalls++;
    if (mode === 'throw') throw new Error('secret-internal-detail db13 down');
    if (mode === 'rows' && String(init?.body).includes('individuals-prescriptions')) {
      return dataset(['uid', 'visit_date', 'diagnosis_icd_codes', 'impression_icd_codes'], [['presc_1', '2026-03-01', ['E11.9'], []]]);
    }
    return dataset([], []);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; console.log = realLog; });

test('flag off (unset or not "1") => 404, even with a valid bearer', async () => {
  delete process.env.ENGINE_MEMBER_STATE;
  assert.equal((await call(`?individual_uid=${UID}&as_of=2026-04-01`)).status, 404);
  process.env.ENGINE_MEMBER_STATE = 'true';
  assert.equal((await call(`?individual_uid=${UID}&as_of=2026-04-01`)).status, 404);
  assert.equal(fetchCalls, 0);
});

test('auth matrix: absent, wrong, prefix-only, different length, env unset => 401, no fetch', async () => {
  const q = `?individual_uid=${UID}&as_of=2026-04-01`;
  assert.equal((await call(q, null)).status, 401);
  assert.equal((await call(q, 'Bearer wrong-abc-123')).status, 401);
  assert.equal((await call(q, 'Bearer tok-abc')).status, 401);
  assert.equal((await call(q, `Bearer ${TOKEN}-longer`)).status, 401);
  delete process.env.NEWCAT_ENGINE_TOKEN;
  assert.equal((await call(q, `Bearer ${TOKEN}`)).status, 401);
  assert.equal(fetchCalls, 0);
});

test('secret in query string and x-vercel-cron are not accepted', async () => {
  process.env.CRON_SECRET = 'cron-s';
  const r = await GET(new NextRequest(`${URL0}?individual_uid=${UID}&as_of=2026-04-01&secret=cron-s`, { headers: { 'x-vercel-cron': '1' } }));
  assert.equal(r.status, 401);
  delete process.env.CRON_SECRET;
});

test('bad uid, bad date, bad audited_ref => 400 with a fixed body and no echo', async () => {
  const bad = [
    '?as_of=2026-04-01',
    '?individual_uid=short&as_of=2026-04-01',
    "?individual_uid=bad'uid_ECHOME&as_of=2026-04-01",
    `?individual_uid=${UID}`,
    `?individual_uid=${UID}&as_of=2026-02-30`,
    `?individual_uid=${UID}&as_of=01-04-2026`,
    `?individual_uid=${UID}&as_of=2026-04-01&audited_ref=x`,
    `?individual_uid=${UID}&as_of=2026-04-01&audited_ref=`,
  ];
  for (const qs of bad) {
    const r = await call(qs);
    assert.equal(r.status, 400, qs);
    const text = await r.text();
    assert.ok(!text.includes('ECHOME') && !text.includes(UID) && !text.includes('2026'), `no echo: ${qs}`);
  }
  assert.equal(fetchCalls, 0);
});

test('core returns null => 200 no_prior_history', async () => {
  const r = await call(`?individual_uid=${UID}&as_of=2026-04-01`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, status: 'no_prior_history' });
});

test('as_of cut: visit on the as_of date is not knowable => no_prior_history', async () => {
  mode = 'rows';
  const r = await call(`?individual_uid=${UID}&as_of=2026-03-01`);
  assert.deepEqual(await r.json(), { ok: true, status: 'no_prior_history' });
});

test('success => 200 with schema string and the snapshot as the core returns it', async () => {
  mode = 'rows';
  const r = await call(`?individual_uid=${UID}&as_of=2026-04-01&audited_ref=audit_REF123`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.schema, 'member-state/1.2');
  assert.ok(j.snapshot && typeof j.snapshot === 'object');
  assert.equal(j.individualUid, undefined);
  assert.equal(j.view, undefined);
});

test('fetch throws => 503 context_fetch_failed with no message text', async () => {
  mode = 'throw';
  const r = await call(`?individual_uid=${UID}&as_of=2026-04-01`);
  assert.equal(r.status, 503);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { ok: false, status: 'context_fetch_failed' });
  assert.ok(!text.includes('secret-internal-detail'));
});

test('log lines carry status and duration only, never the uid', async () => {
  mode = 'rows';
  await call(`?individual_uid=${UID}&as_of=2026-04-01&audited_ref=audit_REF123`);
  mode = 'throw';
  await call(`?individual_uid=${UID}&as_of=2026-04-01`);
  await call(`?individual_uid=${UID}&as_of=2026-04-01`, null);
  assert.equal(logs.length, 3);
  for (const l of logs) {
    assert.match(l, /status=\d{3}/);
    assert.match(l, /ms=\d+/);
    assert.ok(!l.includes(UID) && !l.includes('audit_REF123') && !l.includes('E11') && !l.includes(TOKEN), l);
  }
});
