/**
 * GET /api/governance/doctor-audits — the doctor-facing payload.
 *
 * The response is built from an allowlist. These tests plant every internal the audit found
 * (a triage stamp with a Jev route dump, a governance ruling with a note and actor, importance,
 * engine versions) and assert none of it comes back, while the new per-instance fields do:
 * routed, note_class, note_date, evidence_excerpt, citations and patient.
 *
 *   node --test --import tsx lib/__tests__/doctor-audits-payload.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampFindingIdentity, type OpdFinding } from '../opd-note-audit-core.ts';

process.env.GOV_API_KEY = 'test-gov-key';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';
process.env.METABASE_URL = 'https://metabase.invalid.test';
process.env.METABASE_API_KEY = 'test-metabase-key';
delete process.env.TRIAGE_BOT_WRITE_CLASSES;

const DOCTOR = '0q9pSZHR24ysquO6V4Xg';
const DS_AUDIT = '404bb3b3-a0a8-4178-97ec-d562adb2d017';
const OT_AUDIT = '76eeea4d-95db-4246-ae5b-f52fd32c1f0b';
const OPD_AUDIT = '11111111-2222-4333-8444-555555555555';
const TRIAGE_DECISION = 'dddddddd-0000-4000-8000-000000000001';
const WINDOW_FROM = '2026-09-17';
const WINDOW_TO = '2026-09-23';

function rawFinding(subject: string, extra: Partial<OpdFinding> = {}): OpdFinding {
  return {
    subject, verdict: 'context-dependent', confidence: 0.82, domain: 'appropriateness',
    rationale: `Why: ${subject}`, evidence: [], estimates: [], citation_ids: [], source: 'llm', ...extra,
  };
}

const DS_FINDING = rawFinding('Post-operative Oral Antibiotic Course', {
  evidence: ['Course extended to 7 days after a clean laparoscopic procedure.', 'Guideline limits prophylaxis to a single dose.'],
  citation_ids: [1, 2],
});
const OT_FINDING = rawFinding('Documentation completeness: OT note body is thin or empty');
const OPD_FINDING = rawFinding('Antibiotic stewardship: OPD viral course', {
  verdict: 'low-value', evidence: ['Viral pharyngitis does not need an antibiotic.'], citation_ids: [1],
});
const DS_SIGNAL = stampFindingIdentity([DS_FINDING])[0].signal_type as string;
const OT_SIGNAL = stampFindingIdentity([OT_FINDING])[0].signal_type as string;
const OPD_SIGNAL = stampFindingIdentity([OPD_FINDING])[0].signal_type as string;

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
  return new Response(JSON.stringify({ data: { cols: cols.map((name) => ({ name })), rows } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const DS_ROWS: Row[] = [{
  id: DS_AUDIT, ip_uid: 'IP-0111', speciality: 'Obstetrics', note_date: '2026-09-19',
  findings: JSON.stringify([DS_FINDING]),
}];
const OT_ROWS: Row[] = [{
  id: OT_AUDIT, doctor_uid: DOCTOR, map_status: 'mapped', note_day: '2026-09-20', uhid: 'UHID-77',
  findings: JSON.stringify([OT_FINDING]),
}];
const OPD_ROWS: Row[] = [{
  id: OPD_AUDIT, note_date: '2026-09-20', findings: JSON.stringify([OPD_FINDING]),
  sources: JSON.stringify([{ n: 1, id: 1, source: 'mksap', book: 'MKSAP', chapter: 'Pharyngitis', url: 'https://pubmed.test/opd1' }]),
}];
const DS_REPORT_SOURCES = [
  { n: 1, id: 1, source: 'statpearls', book: 'StatPearls', chapter: 'Surgical prophylaxis', url: 'https://pubmed.test/ds1' },
  { n: 2, id: 2, source: 'mksap', book: 'MKSAP', chapter: null, url: null },
];

function signalRow(partial: Row): Row {
  return {
    signal_id: 'sig', reference: 'EHRC-AUD-2026-0000', doctor_uid: DOCTOR, signal_type: DS_SIGNAL, note_class: 'opd',
    importance: 'high', response_required: 'explanation', status: 'routed', source_triage_ref: null,
    window_from: WINDOW_FROM, window_to: WINDOW_TO, sla_due_at: '2099-01-01T00:00:00.000Z',
    latest_response: null, ruling: null,
    created_at: '2026-09-23T13:00:00.000Z', updated_at: '2026-09-23T13:00:00.000Z', ...partial,
  };
}
const RULING = JSON.stringify({ action: 'privilege_action', note: 'GOV-ONLY-NOTE', actor: 'gov:42', gov_intervention_ref: 'EPI-INT-9', ruled_at: '2026-09-24T00:00:00.000Z' });
const SIGNALS: Row[] = [
  signalRow({
    signal_id: 'sig-ds', reference: 'EHRC-AUD-2026-0111', signal_type: DS_SIGNAL, note_class: 'discharge_summary',
    source_triage_ref: TRIAGE_DECISION, ruling: RULING,
    latest_response: JSON.stringify({ verb: 'agree', type: 'explanation', verdict: 'agree', comment: 'Agreed.', client_request_id: 'req-secret-1', responded_at: '2026-09-24T09:00:00.000Z' }),
  }),
  signalRow({ signal_id: 'sig-opd', reference: 'EHRC-AUD-2026-0030', signal_type: OPD_SIGNAL, note_class: 'opd', window_from: '2026-09-16', window_to: '2026-09-22' }),
  signalRow({ signal_id: 'sig-ot', reference: 'EHRC-AUD-2026-0901', signal_type: OT_SIGNAL, note_class: 'ot' }),
];

globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
  const sent = JSON.parse(String(init.body || '{}')) as { query?: string; params?: unknown[]; native?: { query?: string } };
  if (sent.native?.query) {
    const q = String(sent.native.query);
    if (q.includes('karexpert_metadata__practitioner_id')) return metabase(['pid', 'n_uids', 'uid'], [['PX-POOR', 1, DOCTOR]]);
    if (q.includes('kx_ip_admissions')) return metabase(['encounter_id', 'current_treating_doctor_id'], [['IP-0111', 'PX-POOR']]);
    return metabase([], []);
  }
  const text = String(sent.query || '');
  issued.push({ text, params: sent.params || [] });
  if (/triage_stamp_events/.test(text)) {
    // The old route read this and spread it into every signal. Serve the Jev dump so a regression shows.
    return neon([{ decision_id: TRIAGE_DECISION, reason: 'jev:route conf=0.82; hard_bar=1; should_route=true', policy_version: 'triage-shadow-policy/0.1.3' }]);
  }
  if (/report->'sources'/.test(text)) return neon([{ id: DS_AUDIT, sources: JSON.stringify(DS_REPORT_SOURCES) }]);
  if (/ipd_discharge_audits/.test(text)) return neon(DS_ROWS);
  if (/ot_note_audits/.test(text)) return neon(OT_ROWS);
  if (/opd_note_audits/.test(text) && /findings/.test(text) && !/DISTINCT ON/.test(text)) return neon(OPD_ROWS);
  if (/FROM opd_gov_signal/i.test(text) && /doctor_uid=\$1/.test(text)) return neon(SIGNALS);
  return neon([]);
}) as typeof fetch;

async function getFeed(query = '') {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/governance/doctor-audits/route.ts');
  const res = await GET(new NextRequest(
    `https://cat.test/api/governance/doctor-audits?doctor_uid=${encodeURIComponent(DOCTOR)}&window=30${query}`,
    { headers: { 'x-api-key': 'test-gov-key' } },
  ));
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, any> };
}

const INSTANCE_KEYS = [
  'audit_id', 'citations', 'evidence_excerpt', 'note_class', 'note_date', 'patient', 'rationale', 'routed', 'subject', 'verdict',
];
const SIGNAL_KEYS = [
  'doctor_uid', 'instances', 'label', 'note_class', 'overdue', 'reference', 'representative', 'response',
  'response_required', 'routed_at', 'signal_id', 'signal_type', 'sla_due_at', 'status', 'window',
];

test('no triage, ruling, importance, engine or policy text anywhere in the feed', async () => {
  issued.length = 0;
  const { status, text, json } = await getFeed();
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(!issued.some((q) => /triage_stamp_events/.test(q.text)), 'the route no longer reads triage stamps');
  for (const banned of [
    'triage', 'policy_version', 'triage-shadow', 'jev', 'conf=', 'hard_bar', 'should_route',
    'ruling', 'GOV-ONLY-NOTE', 'privilege_action', 'EPI-INT-9', 'gov:42',
    'importance', 'engine_version', 'oldest_engine', 'client_request_id', 'req-secret-1', 'confidence',
    'finding_ref', 'bug_type', 'validity',
  ]) {
    assert.ok(!text.includes(banned), `leaked: ${banned}`);
  }
  assert.equal(json.advisory, 'These are documentation and prescribing observations reviewed by the quality team. They are not a performance score.');
  assert.deepEqual(Object.keys(json.metrics.audit).sort(), [
    'as_of', 'band_a_pct', 'documentation_completeness', 'notes_audited', 'nqi_mean', 'prescribing_safety', 'top_gap',
  ]);
});

test('every signal and instance is exactly the allowlisted shape', async () => {
  const { json } = await getFeed();
  assert.equal(json.signals.length, 3);
  for (const s of json.signals) {
    assert.deepEqual(Object.keys(s).sort(), SIGNAL_KEYS, s.reference);
    assert.ok(s.representative, s.reference);
    assert.deepEqual(Object.keys(s.representative).sort(), INSTANCE_KEYS, s.reference);
    assert.deepEqual(Object.keys(s.representative.patient).sort(), ['age', 'ip_number', 'name', 'sex', 'uhid']);
    assert.equal(s.representative.routed, true);
  }
});

test('discharge thread: note class, date, IP number, evidence and citations resolved from the stored report', async () => {
  const { json } = await getFeed();
  const ds = json.signals.find((s: any) => s.reference === 'EHRC-AUD-2026-0111');
  assert.equal(ds.note_class, 'discharge');
  assert.equal(ds.instances, 1);
  const rep = ds.representative;
  assert.equal(rep.audit_id, DS_AUDIT);
  assert.equal(rep.note_class, 'discharge');
  assert.equal(rep.note_date, '2026-09-19');
  assert.equal(rep.patient.ip_number, 'IP-0111');
  assert.equal(rep.patient.uhid, null);
  assert.equal(rep.patient.name, null);
  assert.equal(rep.patient.age, null);
  assert.equal(rep.patient.sex, null);
  assert.equal(rep.evidence_excerpt, 'Course extended to 7 days after a clean laparoscopic procedure. · Guideline limits prophylaxis to a single dose.');
  assert.deepEqual(rep.citations, [
    { title: 'StatPearls — Surgical prophylaxis', url: 'https://pubmed.test/ds1' },
    { title: 'MKSAP', url: null },
  ]);
  // The doctor's own answer is kept, without the request id.
  assert.deepEqual(ds.response, { verb: 'agree', type: 'explanation', verdict: 'agree', comment: 'Agreed.', responded_at: '2026-09-24T09:00:00.000Z' });
});

test('OT thread carries the UHID, no citations, no evidence; OPD thread has no patient fields', async () => {
  const { json } = await getFeed();
  const ot = json.signals.find((s: any) => s.reference === 'EHRC-AUD-2026-0901');
  assert.equal(ot.note_class, 'ot');
  assert.equal(ot.representative.audit_id, OT_AUDIT);
  assert.equal(ot.representative.patient.uhid, 'UHID-77');
  assert.equal(ot.representative.patient.ip_number, null);
  assert.equal(ot.representative.evidence_excerpt, null);
  assert.deepEqual(ot.representative.citations, []);

  const opd = json.signals.find((s: any) => s.reference === 'EHRC-AUD-2026-0030');
  assert.equal(opd.note_class, 'opd');
  assert.equal(opd.representative.audit_id, OPD_AUDIT);
  assert.deepEqual(opd.representative.patient, { name: null, age: null, sex: null, ip_number: null, uhid: null });
  assert.equal(opd.representative.evidence_excerpt, 'Viral pharyngitis does not need an antibiotic.');
  assert.deepEqual(opd.representative.citations, [{ title: 'MKSAP — Pharyngitis', url: 'https://pubmed.test/opd1' }]);
});

test('note_class filter accepts the doctor-facing spelling and rejects junk', async () => {
  const discharge = await getFeed('&note_class=discharge');
  assert.deepEqual(discharge.json.signals.map((s: any) => s.reference), ['EHRC-AUD-2026-0111']);
  const legacy = await getFeed('&note_class=discharge_summary');
  assert.deepEqual(legacy.json.signals.map((s: any) => s.reference), ['EHRC-AUD-2026-0111']);
  const bad = await getFeed('&note_class=progress');
  assert.equal(bad.status, 400);
});

test('the enriched read touches report.sources only for the audits the thread shows', async () => {
  issued.length = 0;
  await getFeed();
  const sourceReads = issued.filter((q) => /report->'sources'/.test(q.text));
  assert.equal(sourceReads.length, 1);
  assert.ok(JSON.stringify(sourceReads[0].params).includes(DS_AUDIT));
  assert.ok(!issued.some((q) => /\breport\b/.test(q.text) && !/report->'sources'/.test(q.text)), 'the whole report column is never selected');
});
