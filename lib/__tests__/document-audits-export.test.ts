/**
 * Document-audit export (Pipe B) + findings PDF.
 *
 *   node --test --import tsx lib/__tests__/document-audits-export.test.ts
 *
 * OT route mint stays off. The export does not set TRIAGE_BOT_WRITE_CLASSES and does not mint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stampFindingIdentity, type OpdFinding } from '../opd-note-audit-core.ts';
import { triageClassMintAllowed } from '../triage/stamp-schema.ts';
import {
  buildDocumentAuditExport,
  interpretProgressColumns,
  parseExportQuery,
  signalReferenceFor,
  toStampedFindings,
  OT_WRITE_MINT_NOTE,
} from '../triage/document-audits-export.ts';
import type { DischargeHopView } from '../triage/ds-lander.ts';
import { landOtAudits } from '../triage/ot-lander.ts';
import { buildFindingsPdf } from '../triage/document-audits-pdf.ts';

delete process.env.ADMIN_TOKEN;
process.env.GOV_API_KEY = 'test-gov-key';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';
process.env.METABASE_URL = 'https://metabase.invalid.test';
process.env.METABASE_API_KEY = 'test-metabase-key';
delete process.env.TRIAGE_BOT_WRITE_CLASSES;

const FINDING: OpdFinding = {
  subject: 'Documentation completeness: OT note body is thin or empty',
  verdict: 'context-dependent',
  confidence: 0.9,
  domain: 'appropriateness',
  rationale: 'thin note',
  evidence: [],
  estimates: [],
  citation_ids: [],
  source: 'deterministic',
};
const OT_SIGNAL = stampFindingIdentity([FINDING])[0].signal_type as string;
const OT_REF = stampFindingIdentity([FINDING])[0].finding_ref as string;

const OT_ID = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const OT_UNMAPPED = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2';
const DS_ID = 'cccccccc-cccc-4ccc-8ddd-eeeeeeeeeee3';
const DS_MISS = 'cccccccc-cccc-4ccc-8ddd-eeeeeeeeeee4';
const PR_ID = 'dddddddd-dddd-4ccc-8ddd-eeeeeeeeeee5';

const HOP_OK: DischargeHopView = {
  byIpUid: { 'IP-1': { doctorUid: 'DOC-DS', reason: 'resolved' } },
  coverage: { unavailable: false },
};
const HOP_DOWN: DischargeHopView = { byIpUid: {}, coverage: { unavailable: true } };

function otRow(id: string, map_status: string, doctor_uid: string | null, findings: unknown = [FINDING]) {
  return { id, map_status, doctor_uid, note_day: '2026-09-22', hospital_uid: 'HOSP-OT', findings };
}
function dsRow(id: string, ip_uid: string) {
  return { id, ip_uid, note_date: '2026-09-22', findings: [FINDING] };
}

const signals = [{
  reference: 'EHRC-AUD-2026-0099',
  note_class: 'ot',
  doctor_uid: 'DOC-OT',
  signal_type: OT_SIGNAL,
  window_from: '2026-09-01',
  window_to: '2026-09-30',
  created_at: '2026-09-22T00:00:00.000Z',
}, {
  reference: 'EHRC-AUD-2026-0001',
  note_class: 'discharge_summary',
  doctor_uid: 'DOC-DS',
  signal_type: OT_SIGNAL,
  window_from: '2026-09-01',
  window_to: '2026-09-30',
  created_at: '2026-09-22T00:00:00.000Z',
}, {
  reference: 'not-a-ref',
  note_class: 'ot',
  doctor_uid: 'DOC-OT',
  signal_type: OT_SIGNAL,
  window_from: '2026-09-01',
  window_to: '2026-09-30',
  created_at: '2026-09-23T00:00:00.000Z',
}];

test('OT write mint stays off and this door does not flip it', () => {
  assert.equal(triageClassMintAllowed('ot', {}), false);
  assert.equal(triageClassMintAllowed('ot', { TRIAGE_BOT_WRITE_CLASSES: 'opd,discharge_summary' }), false);
  for (const file of [
    'app/api/governance/document-audits-export/route.ts',
    'app/api/governance/audits/[id]/pdf/route.ts',
    'lib/triage/document-audits-export.ts',
    'lib/triage/document-audits-export-read.ts',
  ]) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /OT route mint stays off/);
    assert.ok(!/TRIAGE_BOT_WRITE_CLASSES\s*=/.test(src), file);
    assert.ok(!/mintOrUpdateSignal/.test(src), file);
    assert.ok(!/\b(INSERT|UPDATE|DELETE)\s+/i.test(src), file);
  }
});

test('mapped OT exports with join keys; unmapped and empty notes do not', () => {
  const body = buildDocumentAuditExport({
    from: '2026-09-01',
    to: '2026-09-22',
    otRows: [
      otRow(OT_ID, 'mapped', 'DOC-OT', [FINDING]),
      otRow('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee8', 'mapped', 'DOC-OT', []),
      otRow(OT_UNMAPPED, 'unmapped', null),
      otRow('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee9', 'multi_surgeon_hold', null),
    ],
    dischargeRows: [],
    dischargeHop: HOP_DOWN,
    progress: { status: 'absent' },
    signals,
    otWriteMint: 'off',
    noteClass: 'ot',
  });
  assert.equal(body.ot_write_mint, 'off');
  assert.equal(body.ot_write_mint_note, OT_WRITE_MINT_NOTE);
  assert.equal(body.audits.length, 1);
  const card = body.audits[0];
  assert.equal(card.audit_id, OT_ID);
  assert.equal(card.external_ref, OT_ID);
  assert.equal(card.finding_ref, OT_REF);
  assert.equal(card.doctor_uid, 'DOC-OT');
  assert.equal(card.note_class, 'ot');
  assert.equal(card.doc_type, 'ot');
  assert.equal(card.note_date, '2026-09-22');
  assert.equal(card.hospital_uid, 'HOSP-OT');
  assert.equal(card.pdf, `/api/governance/audits/${OT_ID}/pdf`);
  assert.equal(card.findings.length, 1);
  assert.equal(card.findings[0].queue_item_ref, `ot|DOC-OT|${OT_SIGNAL}`);
  assert.equal(card.findings[0].signal_reference, 'EHRC-AUD-2026-0099');
  assert.deepEqual(card.routed_refs, ['EHRC-AUD-2026-0099']);
  assert.equal(body.counts.ot?.exported, 1);
  assert.equal(body.counts.ot?.skipped_unmapped, 2);
  assert.equal(body.counts.ot?.skipped_no_findings, 1);
  assert.equal(body.counts.discharge, null);
  const blob = JSON.stringify(body);
  for (const banned of ['uhid', 'surgeon_raw', 'member_id', 'pdfUrl', 'patient_name']) {
    assert.ok(!blob.includes(banned), banned);
  }
});

test('finding_ref matches the OT lander, and a discharge thread does not join an OT card', () => {
  const raw = [FINDING];
  const landed = landOtAudits([{ id: OT_ID, map_status: 'mapped', doctor_uid: 'DOC-OT', note_day: '2026-09-22', findings: raw }]);
  assert.equal(toStampedFindings(raw)[0].finding_ref, landed.findings[0].finding_ref);
  assert.equal(signalReferenceFor(signals, 'ot', 'DOC-OT', OT_SIGNAL, '2026-09-22'), 'EHRC-AUD-2026-0099');
  assert.equal(signalReferenceFor(signals, 'ot', 'DOC-OT', OT_SIGNAL, '2026-08-01'), null);
  assert.equal(signalReferenceFor(signals, 'discharge_summary', 'DOC-OT', OT_SIGNAL, '2026-09-22'), null);
});

test('discharge exports only a resolved hop; unavailable hop exports nothing', () => {
  const ok = buildDocumentAuditExport({
    from: '2026-09-01', to: '2026-09-22',
    otRows: [],
    dischargeRows: [dsRow(DS_ID, 'IP-1'), dsRow(DS_MISS, 'IP-9')],
    dischargeHop: HOP_OK,
    progress: { status: 'absent' },
    signals,
    otWriteMint: 'off',
    noteClass: 'discharge_summary',
  });
  assert.equal(ok.audits.length, 1);
  assert.equal(ok.audits[0].audit_id, DS_ID);
  assert.equal(ok.audits[0].note_class, 'discharge_summary');
  assert.equal(ok.audits[0].doc_type, 'discharge');
  assert.equal(ok.audits[0].doctor_uid, 'DOC-DS');
  assert.equal(ok.audits[0].hospital_uid, null);
  assert.equal(ok.audits[0].findings[0].queue_item_ref, `discharge_summary|DOC-DS|${OT_SIGNAL}`);
  assert.equal(ok.audits[0].findings[0].signal_reference, 'EHRC-AUD-2026-0001');
  assert.equal(ok.counts.discharge?.skipped_unmapped, 1);

  const down = buildDocumentAuditExport({
    from: '2026-09-01', to: '2026-09-22',
    otRows: [],
    dischargeRows: [dsRow(DS_ID, 'IP-1')],
    dischargeHop: HOP_DOWN,
    progress: { status: 'absent' },
    signals,
    otWriteMint: 'off',
  });
  assert.equal(down.audits.filter((a) => a.note_class === 'discharge_summary').length, 0);
  assert.equal(down.counts.discharge?.exported, 0);
  assert.equal(down.counts.discharge?.skipped_unmapped, 1);
});

test('progress is absent unless a store with doctor_uid exists', () => {
  assert.deepEqual(interpretProgressColumns([]), { status: 'absent' });
  assert.equal(interpretProgressColumns([
    { table_name: 'progress_note_audits', column_name: 'id' },
    { table_name: 'progress_note_audits', column_name: 'findings' },
  ]).status, 'unreadable');
  const readable = interpretProgressColumns([
    { table_name: 'progress_note_audits', column_name: 'id' },
    { table_name: 'progress_note_audits', column_name: 'findings' },
    { table_name: 'progress_note_audits', column_name: 'doctor_uid' },
    { table_name: 'progress_note_audits', column_name: 'note_day' },
    { table_name: 'progress_note_audits', column_name: 'hospital_uid' },
  ]);
  assert.equal(readable.status, 'readable');

  const absent = buildDocumentAuditExport({
    from: '2026-09-01', to: '2026-09-22',
    otRows: [], dischargeRows: [], dischargeHop: HOP_DOWN,
    progress: { status: 'absent' }, signals: [], otWriteMint: 'off',
  });
  assert.equal(absent.progress.included, false);
  assert.match(absent.progress.reason || '', /no progress audit store/);

  const live = buildDocumentAuditExport({
    from: '2026-09-01', to: '2026-09-22',
    otRows: [], dischargeRows: [], dischargeHop: HOP_DOWN,
    progress: {
      status: 'rows',
      table: 'progress_note_audits',
      rows: [
        { id: PR_ID, doctor_uid: 'DOC-PR', note_date: '2026-09-20', hospital_uid: 'HOSP-PR', findings: [FINDING] },
        { id: 'dddddddd-dddd-4ccc-8ddd-eeeeeeeeeee6', doctor_uid: null, note_date: '2026-09-20', findings: [FINDING] },
      ],
    },
    signals,
    otWriteMint: 'off',
    noteClass: 'progress',
  });
  assert.equal(live.progress.included, true);
  assert.equal(live.audits.length, 1);
  assert.equal(live.audits[0].note_class, 'progress');
  assert.equal(live.audits[0].doc_type, 'progress');
  assert.equal(live.audits[0].hospital_uid, 'HOSP-PR');
  assert.equal(live.audits[0].findings[0].queue_item_ref, null);
  assert.equal(live.audits[0].findings[0].signal_reference, null);
  assert.deepEqual(live.audits[0].routed_refs, []);
  assert.equal(live.counts.progress?.skipped_unmapped, 1);
});

test('query window is bounded', () => {
  const bad = parseExportQuery({ get: (k) => (k === 'window' ? '900' : null) });
  assert.equal(bad.ok, false);
  const ok = parseExportQuery({ get: (k) => (k === 'from' ? '2026-09-01' : k === 'to' ? '2026-09-22' : null) });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.from, '2026-09-01');
    assert.equal(ok.value.to, '2026-09-22');
  }
  const klass = parseExportQuery({ get: (k) => (k === 'note_class' ? 'opd' : null) });
  assert.equal(klass.ok, false);
});

test('findings PDF is an audit page, not the clinical source', async () => {
  const bytes = await buildFindingsPdf({
    audit_id: OT_ID,
    note_class: 'ot',
    doctor_uid: 'DOC-OT',
    note_date: '2026-09-22',
    findings: [{ finding_ref: OT_REF, signal_type: OT_SIGNAL, subject: FINDING.subject, verdict: 'context-dependent', rationale: 'thin note' }],
  });
  assert.equal(Buffer.from(bytes).subarray(0, 4).toString(), '%PDF');
});

// ── route (fetch stands in for Neon + Metabase) ──────────────────────────────

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

const otStored: Row[] = [
  {
    id: OT_ID, hospital_uid: 'HOSP-OT', note_day: '2026-09-22', note_date: '2026-09-22',
    doctor_uid: 'DOC-OT', map_status: 'mapped', findings: JSON.stringify([FINDING]),
  },
  {
    id: OT_UNMAPPED, hospital_uid: 'HOSP-OT', note_day: '2026-09-21', note_date: '2026-09-21',
    doctor_uid: null, map_status: 'unmapped', findings: JSON.stringify([FINDING]),
  },
];
const dsStored: Row[] = [
  { id: DS_ID, ip_uid: 'IP-1', note_date: '2026-09-22', findings: JSON.stringify([FINDING]) },
];
const signalStored: Row[] = [{
  reference: 'EHRC-AUD-2026-0099', doctor_uid: 'DOC-OT', signal_type: OT_SIGNAL, note_class: 'ot',
  window_from: '2026-09-01', window_to: '2026-09-30', created_at: '2026-09-22T00:00:00.000Z',
}];

globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
  const sent = JSON.parse(String(init.body || '{}')) as { query?: string; params?: unknown[]; native?: { query?: string } };
  if (sent.native?.query) {
    const q = String(sent.native.query);
    if (q.includes('karexpert_metadata__practitioner_id')) {
      return metabase(['pid', 'n_uids', 'uid'], [['PX-1', 1, 'DOC-DS']]);
    }
    if (q.includes('kx_ip_admissions')) {
      return metabase(['encounter_id', 'current_treating_doctor_id'], [['IP-1', 'PX-1']]);
    }
    return metabase([], []);
  }
  const text = String(sent.query || '');
  const params = sent.params || [];
  issued.push({ text, params });
  if (/information_schema\.columns/.test(text)) return neon([]);
  if (/opd_gov_signal/.test(text) && /reference = \$1/.test(text)) {
    return neon(signalStored.filter((s) => s.reference === params[0]));
  }
  if (/opd_gov_signal/.test(text)) return neon(signalStored);
  if (/ot_note_audits/.test(text) && /WHERE id =/.test(text)) {
    return neon(otStored.filter((r) => r.id === params[0]));
  }
  if (/ot_note_audits/.test(text) && /map_status = 'mapped'/.test(text)) {
    return neon(otStored.filter((r) => r.map_status === 'mapped' && r.doctor_uid === params[0]));
  }
  if (/ot_note_audits/.test(text)) return neon(otStored);
  if (/ipd_discharge_audits/.test(text) && /WHERE id =/.test(text)) {
    return neon(dsStored.filter((r) => r.id === params[0]));
  }
  if (/ipd_discharge_audits/.test(text)) return neon(dsStored);
  return neon([]);
}) as typeof fetch;

const EXPORT_URL = 'https://cat.test/api/governance/document-audits-export';

async function getExport(query: string, auth = true) {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/governance/document-audits-export/route.ts');
  const headers: Record<string, string> = {};
  if (auth) headers['x-api-key'] = String(process.env.GOV_API_KEY);
  const req = new NextRequest(`${EXPORT_URL}${query}`, { method: 'GET', headers });
  const res = await GET(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function getPdf(id: string, auth = true) {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/governance/audits/[id]/pdf/route.ts');
  const headers: Record<string, string> = {};
  if (auth) headers['x-api-key'] = String(process.env.GOV_API_KEY);
  const req = new NextRequest(`https://cat.test/api/governance/audits/${id}/pdf`, { method: 'GET', headers });
  const res = await GET(req, { params: Promise.resolve({ id }) });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type'), buf };
}

test('export route requires GOV_API_KEY and returns mapped OT plus a live EHRC ref', async () => {
  issued.length = 0;
  const denied = await getExport('?note_class=ot&from=2026-09-01&to=2026-09-22', false);
  assert.equal(denied.status, 401);

  const res = await getExport('?note_class=ot&from=2026-09-01&to=2026-09-22');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.ot_write_mint, 'off');
  const audits = res.json.audits as Record<string, unknown>[];
  assert.equal(audits.length, 1);
  assert.equal(audits[0].audit_id, OT_ID);
  assert.equal(audits[0].doctor_uid, 'DOC-OT');
  assert.equal(audits[0].hospital_uid, 'HOSP-OT');
  const findings = audits[0].findings as Record<string, unknown>[];
  assert.equal(findings[0].queue_item_ref, `ot|DOC-OT|${OT_SIGNAL}`);
  assert.equal(findings[0].signal_reference, 'EHRC-AUD-2026-0099');
  assert.equal((res.json.progress as { included: boolean }).included, false);
  assert.ok(issued.every((q) => !/^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text)));
  assert.ok(issued.some((q) => /ot_note_audits/.test(q.text)));
  assert.ok(!issued.some((q) => /ipd_discharge_audits/.test(q.text)));
});

test('export route fail-closes discharge through the treating-doctor hop', async () => {
  const res = await getExport('?note_class=discharge_summary&from=2026-09-01&to=2026-09-22');
  assert.equal(res.status, 200);
  const audits = res.json.audits as Record<string, unknown>[];
  assert.equal(audits.length, 1);
  assert.equal(audits[0].audit_id, DS_ID);
  assert.equal(audits[0].doctor_uid, 'DOC-DS');
  assert.equal(audits[0].note_class, 'discharge_summary');
  assert.equal(audits[0].hospital_uid, null);
});

test('audits/:id/pdf serves findings for an audit uuid and an EHRC-AUD ref', async () => {
  const denied = await getPdf(OT_ID, false);
  assert.equal(denied.status, 401);

  const pdf = await getPdf(OT_ID);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.type, 'application/pdf');
  assert.equal(pdf.buf.subarray(0, 4).toString(), '%PDF');

  const byRef = await getPdf('EHRC-AUD-2026-0099');
  assert.equal(byRef.status, 200);
  assert.equal(byRef.type, 'application/pdf');
  assert.equal(byRef.buf.subarray(0, 4).toString(), '%PDF');

  const missing = await getPdf('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(missing.status, 404);

  const bad = await getPdf('not-an-id');
  assert.equal(bad.status, 400);
});
