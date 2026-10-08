/**
 * Round 1, item 6: doctor-directory carries alias_uids for mobile-collapsed doctors and keeps
 * disabled doctors with disabled: true.
 *
 *   node --test --import tsx lib/__tests__/doctor-directory-aliases.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRoster, type RosterInput } from '../doctor-directory-core.ts';

process.env.GOV_API_KEY = 'test-gov-key';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';

const base = (over: Partial<RosterInput>): RosterInput => ({
  doctor_uid: 'U0',
  name: 'Dr Asha Rao',
  email: null,
  mobile: null,
  specialty: 'Medicine',
  channel: null,
  audit_active: false,
  operational_active: false,
  ...over,
});

test('buildRoster: two uids on one mobile collapse to one row listing the other in alias_uids', () => {
  const rows = buildRoster([
    base({ doctor_uid: 'U-OLD', name: 'Dr Asha Rao', mobile: '98450 11111' }),
    base({ doctor_uid: 'U-NEW', name: 'Asha Rao', mobile: '9845011111', audit_active: true }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].doctor_uid, 'U-NEW');
  assert.deepEqual(rows[0].alias_uids, ['U-OLD']);
  assert.equal(rows[0].disabled, false);
  assert.equal(rows[0].mobile_last4, '1111');
});

test('buildRoster: a doctor with no twin has empty alias_uids; no-mobile rows never alias each other', () => {
  const rows = buildRoster([
    base({ doctor_uid: 'A', name: 'Dr Solo One' }),
    base({ doctor_uid: 'B', name: 'Dr Solo Two' }),
  ]);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.deepEqual(r.alias_uids, []);
});

test('buildRoster: disabled doctors are kept and flagged, and sort after enabled ones', () => {
  const rows = buildRoster([
    base({ doctor_uid: 'GONE', name: 'Dr Left Hospital', disabled: true, audit_active: true }),
    base({ doctor_uid: 'HERE', name: 'Dr Still Here' }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].doctor_uid, 'HERE');
  assert.equal(rows[0].disabled, false);
  assert.equal(rows[1].doctor_uid, 'GONE');
  assert.equal(rows[1].disabled, true);
});

test('buildRoster: an enabled uid is canonical over a disabled twin even when the disabled one is busier', () => {
  const rows = buildRoster([
    base({ doctor_uid: 'OLD-DISABLED', name: 'Dr Twin', mobile: '9000000001', disabled: true, audit_active: true, operational_active: true }),
    base({ doctor_uid: 'NEW-ENABLED', name: 'Dr Twin', mobile: '9000000001' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].doctor_uid, 'NEW-ENABLED');
  assert.equal(rows[0].disabled, false);
  assert.deepEqual(rows[0].alias_uids, ['OLD-DISABLED']);
  // activity is folded across the cluster, so the live signal is not lost
  assert.equal(rows[0].audit_active, true);
  assert.equal(rows[0].operational_active, true);
});

test('buildRoster: three uids on one mobile list both others, sorted', () => {
  const rows = buildRoster([
    base({ doctor_uid: 'C', name: 'Dr Triple', mobile: '9111111111' }),
    base({ doctor_uid: 'B', name: 'Dr Triple', mobile: '9111111111' }),
    base({ doctor_uid: 'A', name: 'Dr Triple', mobile: '9111111111', audit_active: true }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].doctor_uid, 'A');
  assert.deepEqual(rows[0].alias_uids, ['B', 'C']);
});

// ── store + route, against a stubbed Neon driver ─────────────────────────────────────────────
type Row = Record<string, unknown>;
const issued: string[] = [];
let newColumnsExist = true;

function neon(rows: Row[]): Response {
  const names = rows.length ? Object.keys(rows[0]) : [];
  return new Response(JSON.stringify({
    command: 'SELECT', rowCount: rows.length, rowAsArray: false,
    fields: names.map((name, i) => ({ name, tableID: 0, columnID: i + 1, dataTypeID: ['true', 'false'].includes(String(rows[0][name])) ? 16 : 25, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' })),
    rows: rows.map((row) => names.map((name) => row[name] == null ? null : String(row[name]))),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const NEW_ROWS: Row[] = [
  {
    doctor_uid: 'U-NEW', name: 'Asha Rao', name_normalized: 'asha rao', specialty: 'Medicine', channel: null,
    mobile_last4: '1111', has_email: 'true', audit_active: 'true', operational_active: 'false',
    alias_uids: JSON.stringify(['U-OLD']), disabled: 'false',
  },
  {
    doctor_uid: 'U-GONE', name: 'Left Hospital', name_normalized: 'hospital left', specialty: null, channel: null,
    mobile_last4: null, has_email: 'false', audit_active: 'false', operational_active: 'false',
    alias_uids: '[]', disabled: 'true',
  },
];
const OLD_ROWS: Row[] = NEW_ROWS.map(({ alias_uids: _a, disabled: _d, ...rest }) => rest);

globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
  const sent = JSON.parse(String(init.body || '{}')) as { query?: string };
  const text = String(sent.query || '');
  issued.push(text);
  if (/FROM doctor_roster/.test(text)) {
    if (/alias_uids/.test(text)) {
      if (!newColumnsExist) {
        return new Response(JSON.stringify({ message: 'column "alias_uids" does not exist', code: '42703' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return neon(NEW_ROWS);
    }
    return neon(OLD_ROWS);
  }
  return neon([]);
}) as typeof fetch;

test('readRoster returns alias_uids and disabled when the columns exist', async () => {
  newColumnsExist = true;
  const { readRoster } = await import('../doctor-metrics-store.ts');
  const rows = await readRoster();
  assert.equal(rows.length, 2);
  const live = rows.find((r) => r.doctor_uid === 'U-NEW');
  const gone = rows.find((r) => r.doctor_uid === 'U-GONE');
  assert.deepEqual(live?.alias_uids, ['U-OLD']);
  assert.equal(live?.disabled, false);
  assert.deepEqual(gone?.alias_uids, []);
  assert.equal(gone?.disabled, true);
});

test('readRoster falls back to the old projection before the schema step has run', async () => {
  newColumnsExist = false;
  const { readRoster } = await import('../doctor-metrics-store.ts');
  const rows = await readRoster();
  assert.equal(rows.length, 2, 'the directory is not served empty');
  for (const r of rows) {
    assert.deepEqual(r.alias_uids, []);
    assert.equal(r.disabled, false);
  }
  newColumnsExist = true;
});

test('GET /api/governance/doctor-directory emits alias_uids and disabled and keeps the existing fields', async () => {
  newColumnsExist = true;
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/governance/doctor-directory/route.ts');
  const unauth = await GET(new NextRequest('https://cat.test/api/governance/doctor-directory'));
  assert.equal(unauth.status, 401);

  const res = await GET(new NextRequest('https://cat.test/api/governance/doctor-directory', { headers: { 'x-api-key': 'test-gov-key' } }));
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; count: number; doctors: Record<string, unknown>[] };
  assert.equal(body.ok, true);
  assert.equal(body.count, 2);
  const live = body.doctors.find((d) => d.doctor_uid === 'U-NEW')!;
  assert.deepEqual(live.alias_uids, ['U-OLD']);
  assert.equal(live.disabled, false);
  const gone = body.doctors.find((d) => d.doctor_uid === 'U-GONE')!;
  assert.equal(gone.disabled, true);
  assert.deepEqual(gone.alias_uids, []);
  // existing fields are untouched
  for (const k of ['doctor_uid', 'name', 'name_normalized', 'specialty', 'channel', 'mobile_last4', 'has_email', 'audit_active', 'operational_active']) {
    assert.ok(k in live, k);
  }
});

test('the refresh job no longer filters disabled doctors out of the roster source', () => {
  const src = readFileSync('lib/doctor-metrics-refresh.ts', 'utf8');
  assert.match(src, /coalesce\(disabled,\s*false\) AS disabled/);
  assert.doesNotMatch(src, /coalesce\(disabled,\s*false\)\s*=\s*false/);
});
