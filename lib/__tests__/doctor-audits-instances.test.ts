/**
 * Discharge and OT instance fan-in for GET /api/governance/doctor-audits.
 *
 * OPD keeps resolveInstances → opd_note_audits. Discharge reads ipd_discharge_audits
 * through the treating-doctor hop. OT reads mapped ot_note_audits rows. A shared
 * signal_type must not cross classes.
 *
 *   node --test --import tsx lib/__tests__/doctor-audits-instances.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stampFindingIdentity, type OpdFinding } from '../opd-note-audit-core.ts';
import { landDischargeAudits } from '../triage/ds-lander.ts';
import { landOtAudits } from '../triage/ot-lander.ts';
import {
  resolveInstances,
  resolveDischargeInstances,
  resolveOtInstances,
  resolveInstancesForNoteClass,
  selectSignalInstances,
} from '../opd-gov-read.ts';

process.env.GOV_API_KEY = 'test-gov-key';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';
process.env.METABASE_URL = 'https://metabase.invalid.test';
process.env.METABASE_API_KEY = 'test-metabase-key';
delete process.env.TRIAGE_BOT_WRITE_CLASSES;

const DOCTOR = '0q9pSZHR24ysquO6V4Xg';
const OTHER = 'OTHERDOC0000000000001';
const DS_AUDIT = '404bb3b3-a0a8-4178-97ec-d562adb2d017';
const OT_AUDIT = '76eeea4d-95db-4246-ae5b-f52fd32c1f0b';
const OPD_AUDIT = '11111111-2222-4333-8444-555555555555';
const NEWER_DS = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9';
const WINDOW_FROM = '2026-09-17';
const WINDOW_TO = '2026-09-23';

function rawFinding(subject: string, verdict: OpdFinding['verdict'] = 'context-dependent'): OpdFinding {
  return {
    subject,
    verdict,
    confidence: 0.8,
    domain: 'appropriateness',
    rationale: subject,
    evidence: [],
    estimates: [],
    citation_ids: [],
    source: 'llm',
  };
}

const ORAL = rawFinding('Post-operative Oral Antibiotic Course');
const IV = rawFinding('Post-operative IV Antibiotic Course');
const DS_OTHER = rawFinding('Documentation completeness: discharge medication list');
const OT_FINDING = rawFinding('Documentation completeness: OT note body is thin or empty');
const OPD_FINDING = rawFinding('Antibiotic stewardship: OPD viral course', 'low-value');

const DS_SIGNAL = stampFindingIdentity([ORAL])[0].signal_type as string;
const OT_SIGNAL = stampFindingIdentity([OT_FINDING])[0].signal_type as string;

type Row = Record<string, unknown>;
const issued: { text: string; params: unknown[] }[] = [];

function neon(rows: Row[]): Response {
  const names = rows.length ? Object.keys(rows[0]) : [];
  return new Response(JSON.stringify({
    command: 'SELECT', rowCount: rows.length, rowAsArray: false,
    fields: names.map((name, i) => ({ name, tableID: 0, columnID: i + 1, dataTypeID: 25, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' })),
    rows: rows.map((row) => names.map((name) => row[name] == null ? null : String(row[name]))),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function metabase(cols: string[], rows: unknown[][]): Response {
  return new Response(JSON.stringify({
    data: { cols: cols.map((name) => ({ name })), rows },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const DS_ROWS: Row[] = [
  {
    id: DS_AUDIT,
    ip_uid: 'IP-0111',
    speciality: 'Obstetrics',
    note_date: '2026-09-19',
    findings: JSON.stringify([ORAL, IV, DS_OTHER]),
  },
  {
    id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2',
    ip_uid: 'IP-9999',
    speciality: 'Medicine',
    note_date: '2026-09-19',
    findings: JSON.stringify([ORAL]),
  },
  {
    id: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeee3',
    ip_uid: 'IP-0111',
    speciality: 'Obstetrics',
    note_date: '2026-09-01',
    findings: JSON.stringify([ORAL]),
  },
  {
    id: 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeee4',
    ip_uid: 'IP-NOHOP',
    speciality: 'Surgery',
    note_date: '2026-09-19',
    findings: JSON.stringify([IV]),
  },
];

const OT_ROWS: Row[] = [
  {
    id: OT_AUDIT,
    doctor_uid: DOCTOR,
    map_status: 'mapped',
    note_day: '2026-09-20',
    findings: JSON.stringify([OT_FINDING]),
  },
  {
    id: 'eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeee5',
    doctor_uid: DOCTOR,
    map_status: 'unmapped',
    note_day: '2026-09-20',
    findings: JSON.stringify([OT_FINDING]),
  },
  {
    id: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeee6',
    doctor_uid: OTHER,
    map_status: 'mapped',
    note_day: '2026-09-20',
    findings: JSON.stringify([OT_FINDING]),
  },
  {
    id: '99999999-bbbb-4ccc-8ddd-eeeeeeeeeee7',
    doctor_uid: DOCTOR,
    map_status: 'mapped',
    note_day: '2026-09-01',
    findings: JSON.stringify([OT_FINDING]),
  },
];

const OPD_ROWS: Row[] = [
  {
    id: OPD_AUDIT,
    note_date: '2026-09-20',
    findings: JSON.stringify([OPD_FINDING]),
    sources: '[]',
  },
];

function signalRow(partial: Row): Row {
  return {
    signal_id: 'sig',
    reference: 'EHRC-AUD-2026-0000',
    doctor_uid: DOCTOR,
    signal_type: DS_SIGNAL,
    note_class: 'opd',
    importance: 'high',
    response_required: 'explanation',
    status: 'routed',
    source_triage_ref: null,
    window_from: WINDOW_FROM,
    window_to: WINDOW_TO,
    sla_due_at: null,
    latest_response: null,
    ruling: null,
    created_at: '2026-09-23T13:00:00.000Z',
    updated_at: '2026-09-23T13:00:00.000Z',
    ...partial,
  };
}

const SIGNALS: Row[] = [
  signalRow({
    signal_id: 'sig-ds',
    reference: 'EHRC-AUD-2026-0111',
    signal_type: DS_SIGNAL,
    note_class: 'discharge_summary',
    created_at: '2026-09-23T13:50:00.000Z',
  }),
  signalRow({
    signal_id: 'sig-opd',
    reference: 'EHRC-AUD-2026-0030',
    signal_type: DS_SIGNAL,
    note_class: 'opd',
    window_from: '2026-09-16',
    window_to: '2026-09-22',
    created_at: '2026-09-22T11:00:00.000Z',
  }),
  signalRow({
    signal_id: 'sig-ot',
    reference: 'EHRC-AUD-2026-0901',
    signal_type: OT_SIGNAL,
    note_class: 'ot',
    created_at: '2026-09-23T13:51:00.000Z',
  }),
];

globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
  const sent = JSON.parse(String(init.body || '{}')) as { query?: string; params?: unknown[]; native?: { query?: string } };
  if (sent.native?.query) {
    const q = String(sent.native.query);
    if (q.includes('karexpert_metadata__practitioner_id')) {
      return metabase(['pid', 'n_uids', 'uid'], [
        ['PX-POOR', 1, DOCTOR],
        ['PX-OTHER', 1, OTHER],
      ]);
    }
    if (q.includes('kx_ip_admissions')) {
      return metabase(['encounter_id', 'current_treating_doctor_id'], [
        ['IP-0111', 'PX-POOR'],
        ['IP-9999', 'PX-OTHER'],
      ]);
    }
    return metabase([], []);
  }
  const text = String(sent.query || '');
  const params = sent.params || [];
  issued.push({ text, params });
  if (/ipd_discharge_audits/.test(text)) return neon(DS_ROWS);
  if (/ot_note_audits/.test(text)) return neon(OT_ROWS);
  if (/opd_note_audits/.test(text) && /findings/.test(text) && !/DISTINCT ON/.test(text)) return neon(OPD_ROWS);
  if (/FROM opd_gov_signal/i.test(text) && /doctor_uid=\$1/.test(text)) return neon(SIGNALS);
  return neon([]);
}) as typeof fetch;

test('golden discharge subjects stamp as antibiotic_stewardship; OT v0 stamps as appropriateness_review', () => {
  assert.equal(DS_SIGNAL, 'antibiotic_stewardship');
  assert.equal(stampFindingIdentity([IV])[0].signal_type, 'antibiotic_stewardship');
  assert.equal(OT_SIGNAL, 'appropriateness_review');
  assert.notEqual(stampFindingIdentity([DS_OTHER])[0].signal_type, 'antibiotic_stewardship');
});

test('selectSignalInstances keeps this doctor and window, newest note first', () => {
  const hop = {
    byIpUid: {
      'IP-0111': { doctorUid: DOCTOR, reason: 'resolved' },
      'IP-9999': { doctorUid: OTHER, reason: 'resolved' },
    },
    coverage: { unavailable: false },
  };
  const landed = landDischargeAudits([
    { id: DS_AUDIT, ip_uid: 'IP-0111', note_date: '2026-09-19', findings: [ORAL, IV] },
    { id: NEWER_DS, ip_uid: 'IP-0111', note_date: '2026-09-22', findings: [ORAL] },
    { id: 'old-audit', ip_uid: 'IP-0111', note_date: '2026-09-01', findings: [ORAL] },
    { id: 'other-audit', ip_uid: 'IP-9999', note_date: '2026-09-20', findings: [ORAL] },
  ], hop);
  const got = selectSignalInstances(landed.findings, DOCTOR, DS_SIGNAL, WINDOW_FROM, WINDOW_TO);
  assert.equal(got.count, 3);
  assert.equal(got.representative?.audit_id, NEWER_DS);
  assert.equal(got.representative?.note_date, '2026-09-22');
  assert.ok(got.instances.every((row) => row.audit_id === DS_AUDIT || row.audit_id === NEWER_DS));
});

test('discharge resolver returns the golden audit and does not read OPD notes', async () => {
  const before = issued.length;
  const got = await resolveInstancesForNoteClass('discharge_summary', DOCTOR, DS_SIGNAL, WINDOW_FROM, WINDOW_TO);
  const queries = issued.slice(before).map((q) => q.text);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /ipd_discharge_audits/);
  assert.match(queries[0], /ipd-discharge-audit\/%/);
  assert.match(queries[0], /NOT LIKE '%-mini'/);
  assert.doesNotMatch(queries[0], /opd_note_audits/);
  assert.doesNotMatch(queries[0], /ot_note_audits/);
  assert.doesNotMatch(queries[0], /doctor_uid/);
  assert.ok(issued[before].params.includes(WINDOW_FROM));
  assert.ok(issued[before].params.includes(WINDOW_TO));
  assert.equal(got.count, 2);
  assert.equal(got.representative?.audit_id, DS_AUDIT);
  assert.equal(got.representative?.note_date, '2026-09-19');
  assert.equal(got.instances.filter((row) => row.audit_id === DS_AUDIT).length, 2);
  assert.ok(!got.instances.some((row) => row.audit_id === OPD_AUDIT));
});

test('OT resolver returns the mapped audit and ignores unmapped and other doctors', async () => {
  const before = issued.length;
  const got = await resolveOtInstances(DOCTOR, OT_SIGNAL, WINDOW_FROM, WINDOW_TO);
  const query = issued[before];
  assert.match(query.text, /ot_note_audits/);
  assert.match(query.text, /map_status = 'mapped'/);
  assert.doesNotMatch(query.text, /opd_note_audits/);
  assert.doesNotMatch(query.text, /ipd_discharge_audits/);
  assert.ok(query.params.includes(DOCTOR));
  assert.ok(query.params.includes(WINDOW_FROM));
  assert.equal(got.count, 1);
  assert.equal(got.representative?.audit_id, OT_AUDIT);
  assert.equal(got.representative?.note_date, '2026-09-20');
  const landed = landOtAudits([{
    id: OT_AUDIT, doctor_uid: DOCTOR, map_status: 'unmapped', note_day: '2026-09-20', findings: [OT_FINDING],
  }]);
  assert.equal(landed.findings.length, 0);
});

test('OPD resolveInstances still reads only opd_note_audits', async () => {
  const before = issued.length;
  const got = await resolveInstances(DOCTOR, DS_SIGNAL, '2026-09-16', '2026-09-22');
  const query = issued[before];
  assert.match(query.text, /opd_note_audits/);
  assert.doesNotMatch(query.text, /ipd_discharge_audits/);
  assert.doesNotMatch(query.text, /ot_note_audits/);
  assert.equal(got.count, 1);
  assert.equal(got.representative?.audit_id, OPD_AUDIT);
  const direct = await resolveDischargeInstances(DOCTOR, DS_SIGNAL, null, null);
  assert.equal(direct.count, 0);
  assert.equal(issued.length, before + 1);
  const unknown = await resolveInstancesForNoteClass('progress', DOCTOR, DS_SIGNAL, WINDOW_FROM, WINDOW_TO);
  assert.equal(unknown.count, 0);
  assert.equal(unknown.representative, null);
  assert.equal(issued.length, before + 1);
});

test('doctor-audits returns instances and a representative audit for discharge and OT', async () => {
  const routeSrc = readFileSync('app/api/governance/doctor-audits/route.ts', 'utf8');
  assert.match(routeSrc, /s\.note_class === 'opd'/);
  assert.match(routeSrc, /resolveInstancesForNoteClass/);
  assert.doesNotMatch(routeSrc, /TRIAGE_BOT_WRITE_CLASSES/);
  assert.doesNotMatch(routeSrc, /count: 0, representative: null/);

  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/governance/doctor-audits/route.ts');
  const response = await GET(new NextRequest(
    `https://cat.test/api/governance/doctor-audits?doctor_uid=${encodeURIComponent(DOCTOR)}&window=30`,
    { headers: { 'x-api-key': 'test-gov-key' } },
  ));
  assert.equal(response.status, 200);
  const body = await response.json() as {
    ok: boolean;
    signals: {
      reference: string;
      note_class: string;
      signal_type: string;
      instances: number;
      representative: { audit_id: string; note_date: string } | null;
    }[];
  };
  assert.equal(body.ok, true);
  const byRef = new Map(body.signals.map((s) => [s.reference, s]));

  const ds = byRef.get('EHRC-AUD-2026-0111');
  assert.ok(ds);
  assert.equal(ds.note_class, 'discharge_summary');
  assert.equal(ds.signal_type, 'antibiotic_stewardship');
  assert.ok(ds.instances >= 1);
  assert.equal(ds.instances, 2);
  assert.equal(ds.representative?.audit_id, DS_AUDIT);

  const opd = byRef.get('EHRC-AUD-2026-0030');
  assert.ok(opd);
  assert.equal(opd.note_class, 'opd');
  assert.equal(opd.instances, 1);
  assert.equal(opd.representative?.audit_id, OPD_AUDIT);

  const ot = byRef.get('EHRC-AUD-2026-0901');
  assert.ok(ot);
  assert.equal(ot.note_class, 'ot');
  assert.equal(ot.signal_type, 'appropriateness_review');
  assert.equal(ot.instances, 1);
  assert.equal(ot.representative?.audit_id, OT_AUDIT);
});
