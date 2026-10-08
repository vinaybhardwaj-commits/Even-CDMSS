/**
 * Refuter fixes F1/F8 (one doctor-visibility predicate) and F6 (verdicts in plain words).
 *
 *   node --test --import tsx lib/__tests__/doctor-visibility-and-verdicts.test.ts
 *
 * A thread is doctor-visible when it is routed to the doctor and neither withdrawn by the care
 * manager (closed, no ruling) nor dismissed by governance (closed, ruling dismissed). The same rule
 * gates doctor-audits, the document-audits export and the routed-only findings PDF.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stampFindingIdentity, type OpdFinding } from '../opd-note-audit-core.ts';
import { isDoctorVisibleThread, DOCTOR_VISIBLE_SQL } from '../opd-gov-signal-core.ts';
import { verdictLabel, verdictPlain, doctorInstance } from '../doctor-facing.ts';
import { buildDocumentAuditExport, type RoutedSignalRef } from '../triage/document-audits-export.ts';
import type { DischargeHopView } from '../triage/ds-lander.ts';

process.env.GOV_API_KEY = 'test-gov-key';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';
process.env.METABASE_URL = 'https://metabase.invalid.test';
process.env.METABASE_API_KEY = 'test-metabase-key';
delete process.env.TRIAGE_BOT_WRITE_CLASSES;

const DOCTOR = '0q9pSZHR24ysquO6V4Xg';
const OPD_AUDIT = '11111111-2222-4333-8444-555555555555';

// ── the predicate ─────────────────────────────────────────────────────────────
test('isDoctorVisibleThread: open, ruled and closed-after-ruling stay; withdrawn and dismissed go', () => {
  for (const status of ['routed', 'responded', 'escalated', 'ruled']) {
    assert.equal(isDoctorVisibleThread({ status, ruling: null }), true, status);
  }
  // ruled but still valid: governance acknowledged it or opened a privilege review
  assert.equal(isDoctorVisibleThread({ status: 'ruled', ruling: { action: 'acknowledged_by_governance' } }), true);
  assert.equal(isDoctorVisibleThread({ status: 'ruled', ruling: { action: 'privilege_action' } }), true);
  // closed by governance after the thread ran its course
  assert.equal(isDoctorVisibleThread({ status: 'closed', ruling: { action: 'closed' } }), true);
  // withdrawn: the care manager un-routed it, so there is no ruling
  assert.equal(isDoctorVisibleThread({ status: 'closed', ruling: null }), false);
  assert.equal(isDoctorVisibleThread({ status: 'closed' }), false);
  // dismissed by governance
  assert.equal(isDoctorVisibleThread({ status: 'closed', ruling: { action: 'dismissed' } }), false);
  // a re-routed thread leaves `closed`, so a stale dismissal does not hide it
  assert.equal(isDoctorVisibleThread({ status: 'routed', ruling: { action: 'dismissed' } }), true);
  // a ruling that is not an object is not a ruling
  assert.equal(isDoctorVisibleThread({ status: 'closed', ruling: 'dismissed' }), false);
});

test('DOCTOR_VISIBLE_SQL says the same thing as the predicate', () => {
  assert.match(DOCTOR_VISIBLE_SQL, /status = 'closed'/);
  assert.match(DOCTOR_VISIBLE_SQL, /ruling IS NULL/);
  assert.match(DOCTOR_VISIBLE_SQL, /ruling->>'action' = 'dismissed'/);
  assert.match(DOCTOR_VISIBLE_SQL, /^NOT \(/);
  // a tiny evaluator for exactly this fragment, run over the same cases as the predicate
  const sqlVisible = (t: { status: string; ruling: { action?: string } | null }) => {
    const closed = t.status === 'closed';
    const noRuling = t.ruling == null;
    const dismissed = t.ruling?.action === 'dismissed';
    return !(closed && (noRuling || dismissed));
  };
  const cases = [
    { status: 'routed', ruling: null }, { status: 'ruled', ruling: { action: 'privilege_action' } },
    { status: 'closed', ruling: { action: 'closed' } }, { status: 'closed', ruling: null },
    { status: 'closed', ruling: { action: 'dismissed' } }, { status: 'routed', ruling: { action: 'dismissed' } },
  ];
  for (const c of cases) assert.equal(sqlVisible(c), isDoctorVisibleThread(c), JSON.stringify(c));
});

test('the export read and the routed-only PDF use the shared fragment, not their own copy', () => {
  const read = readFileSync('lib/triage/document-audits-export-read.ts', 'utf8');
  assert.match(read, /\$\{DOCTOR_VISIBLE_SQL\}/);
  assert.doesNotMatch(read, /status = 'closed' AND ruling IS NULL/);
  const route = readFileSync('app/api/governance/doctor-audits/route.ts', 'utf8');
  assert.match(route, /isDoctorVisibleThread/);
});

// ── doctor-audits, against a stubbed Neon ─────────────────────────────────────
const OPD_F: OpdFinding = {
  subject: 'Antibiotic stewardship: OPD viral course', verdict: 'low-value', confidence: 0.8, domain: 'appropriateness',
  rationale: 'Viral pharyngitis does not need an antibiotic.', evidence: ['Viral pharyngitis.'], estimates: [], citation_ids: [], source: 'llm',
};
const OPD_SIGNAL = stampFindingIdentity([OPD_F])[0].signal_type as string;

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
function signalRow(partial: Row): Row {
  return {
    signal_id: 'sig', reference: 'EHRC-AUD-2026-0000', doctor_uid: DOCTOR, signal_type: OPD_SIGNAL, note_class: 'opd',
    importance: 'high', response_required: 'explanation', status: 'routed', source_triage_ref: null,
    window_from: '2026-09-16', window_to: '2026-09-22', sla_due_at: '2099-01-01T00:00:00.000Z',
    latest_response: null, ruling: null,
    created_at: '2026-09-23T13:00:00.000Z', updated_at: '2026-09-23T13:00:00.000Z', ...partial,
  };
}
const ruling = (action: string) => JSON.stringify({ action, note: 'GOV-ONLY-NOTE', actor: 'gov:42', gov_intervention_ref: 'EPI-1' });
const SIGNALS: Row[] = [
  signalRow({ signal_id: 's-open', reference: 'EHRC-AUD-2026-0001' }),
  signalRow({ signal_id: 's-withdrawn', reference: 'EHRC-AUD-2026-0002', status: 'closed', ruling: null }),
  signalRow({ signal_id: 's-dismissed', reference: 'EHRC-AUD-2026-0003', status: 'closed', ruling: ruling('dismissed') }),
  signalRow({ signal_id: 's-ruled', reference: 'EHRC-AUD-2026-0004', status: 'ruled', ruling: ruling('acknowledged_by_governance') }),
  signalRow({
    signal_id: 's-closed-after-response', reference: 'EHRC-AUD-2026-0005', status: 'closed', ruling: ruling('closed'),
    latest_response: JSON.stringify({ verb: 'agree', type: 'explanation', verdict: 'agree', comment: 'Agreed, will change.', client_request_id: 'req-9', responded_at: '2026-09-24T09:00:00.000Z' }),
  }),
  signalRow({ signal_id: 's-withdrawn-after-reply', reference: 'EHRC-AUD-2026-0006', status: 'closed', ruling: null,
    latest_response: JSON.stringify({ verb: 'agree', type: 'acknowledgment', comment: null, responded_at: '2026-09-24T09:00:00.000Z' }) }),
];

globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
  const sent = JSON.parse(String(init.body || '{}')) as { query?: string; params?: unknown[]; native?: { query?: string } };
  if (sent.native?.query) return new Response(JSON.stringify({ data: { cols: [], rows: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const text = String(sent.query || '');
  issued.push({ text, params: sent.params || [] });
  if (/opd_note_audits/.test(text) && /findings/.test(text) && !/DISTINCT ON/.test(text)) {
    return neon([{ id: OPD_AUDIT, note_date: '2026-09-20', findings: JSON.stringify([OPD_F]), sources: '[]' }]);
  }
  if (/FROM opd_gov_signal/i.test(text) && /doctor_uid=\$1/.test(text)) return neon(SIGNALS);
  return neon([]);
}) as typeof fetch;

async function feed(query: string) {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/governance/doctor-audits/route.ts');
  const res = await GET(new NextRequest(
    `https://cat.test/api/governance/doctor-audits?doctor_uid=${encodeURIComponent(DOCTOR)}&window=30${query}`,
    { headers: { 'x-api-key': 'test-gov-key' } },
  ));
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { signals: Record<string, any>[] } };
}

test('doctor-audits status=all: withdrawn and dismissed threads are omitted, not sent with routed=false', async () => {
  const { status, json, text } = await feed('&status=all');
  assert.equal(status, 200);
  const refs = json.signals.map((s) => s.reference).sort();
  assert.deepEqual(refs, [
    'EHRC-AUD-2026-0001', 'EHRC-AUD-2026-0004', 'EHRC-AUD-2026-0005',
  ]);
  assert.ok(!text.includes('EHRC-AUD-2026-0002'), 'withdrawn thread is nowhere in the payload');
  assert.ok(!text.includes('EHRC-AUD-2026-0003'), 'dismissed thread is nowhere in the payload');
  assert.ok(!text.includes('EHRC-AUD-2026-0006'), 'a thread withdrawn after the doctor replied is gone too');
  for (const s of json.signals) assert.equal(s.representative.routed, true, s.reference);
});

test('doctor-audits: a thread governance acknowledged (ruled) stays visible, with no ruling in the payload', async () => {
  const { json, text } = await feed('&status=all');
  const ruled = json.signals.find((s) => s.reference === 'EHRC-AUD-2026-0004')!;
  assert.equal(ruled.status, 'ruled');
  assert.equal(ruled.representative.audit_id, OPD_AUDIT);
  assert.ok(!('ruling' in ruled));
  assert.ok(!text.includes('GOV-ONLY-NOTE') && !text.includes('gov:42') && !text.includes('EPI-1'));
});

test('doctor-audits: closed after the doctor answered stays visible and carries the doctor\'s own response', async () => {
  const { json } = await feed('&status=all');
  const closed = json.signals.find((s) => s.reference === 'EHRC-AUD-2026-0005')!;
  assert.equal(closed.status, 'closed');
  assert.deepEqual(Object.keys(closed.response).sort(), ['comment', 'responded_at', 'type', 'verb', 'verdict']);
  assert.equal(closed.response.comment, 'Agreed, will change.');
  assert.equal(closed.response.verb, 'agree');
});

test('doctor-audits: the visibility filter composes with the note_class filter', async () => {
  const { json } = await feed('&status=all&note_class=opd');
  assert.equal(json.signals.length, 3);
  const none = await feed('&status=all&note_class=ot');
  assert.deepEqual(none.json.signals, []);
});

test('doctor-audits: the verdict reaches the doctor in plain words', async () => {
  const { json } = await feed('&status=all');
  assert.equal(json.signals[0].representative.verdict, 'Low value');
});

// ── F6: verdict words ─────────────────────────────────────────────────────────
test('verdictLabel: known codes become words, anything else is null and never the raw code', () => {
  assert.equal(verdictLabel('low-value'), 'Low value');
  assert.equal(verdictLabel('HIGH-VALUE'), 'Appropriate');
  assert.equal(verdictLabel('context-dependent'), 'Depends on the clinical context');
  assert.equal(verdictLabel('uncertain'), 'Uncertain');
  for (const bad of ['weird_enum', 'fail', '', null, undefined, 3, {}]) assert.equal(verdictLabel(bad), null, String(bad));
  // the PDF still needs some word
  assert.equal(verdictPlain('weird_enum'), 'Observation');
});

test('doctorInstance: verdict is the label, null for an unknown code', () => {
  const base = { audit_id: 'a', subject: 's', rationale: 'r', note_date: '2026-09-20', citations: [] };
  assert.equal(doctorInstance({ ...base, verdict: 'low-value' }, 'opd', true).verdict, 'Low value');
  const unknown = doctorInstance({ ...base, verdict: 'unsafe_v2' }, 'opd', true);
  assert.equal(unknown.verdict, null);
  assert.ok(!JSON.stringify(unknown).includes('unsafe_v2'));
});

// ── export: raw verdict kept for ingest, plain words added ────────────────────
test('export: verdict stays the raw code for the governance ingest and verdict_plain carries the words', () => {
  const f = (subject: string, verdict: string): OpdFinding => ({
    subject, verdict: verdict as OpdFinding['verdict'], confidence: 0.9, domain: 'appropriateness', rationale: 'why',
    evidence: [], estimates: [], citation_ids: [], source: 'llm',
  });
  const HOP: DischargeHopView = { byIpUid: { 'IP-1': { doctorUid: 'DOC-DS', reason: 'resolved' } }, coverage: { unavailable: false } };
  const body = buildDocumentAuditExport({
    from: '2026-09-01', to: '2026-09-30', otRows: [], dischargeRows: [{
      id: 'cccccccc-cccc-4ccc-8ddd-eeeeeeeeeee3', ip_uid: 'IP-1', note_date: '2026-09-22',
      findings: [f('Post-operative Oral Antibiotic Course', 'low-value'), f('Documentation completeness: discharge medication list', 'mystery')],
    }],
    dischargeHop: HOP, progress: { status: 'absent' }, signals: [] as RoutedSignalRef[], otWriteMint: 'off', noteClass: 'discharge_summary',
  });
  const byVerdict = new Map(body.audits[0].findings.map((x) => [x.verdict, x]));
  assert.equal(byVerdict.get('low-value')?.verdict_plain, 'Low value');
  assert.equal(byVerdict.get('mystery')?.verdict_plain, null);
});
