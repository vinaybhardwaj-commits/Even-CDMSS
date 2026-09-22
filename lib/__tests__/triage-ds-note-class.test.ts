/**
 * P3 discharge-summary lander onto the shared Action queue.
 *
 *   node --test --import tsx lib/__tests__/triage-ds-note-class.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildQueue, type TriageFinding, type TriageDecisionRow } from '../opd-triage-core.ts';
import { stampFindingIdentity, type OpdFinding } from '../opd-note-audit-core.ts';
import { signalObject, type SignalRow } from '../opd-gov-signal-core.ts';
import {
  landDischargeAudits, visibleUnmappedCards, type DischargeAuditSource,
} from '../triage/ds-lander.ts';
import { flattenActionQueueItems, readActionQueue } from '../triage/queue-read.ts';
import {
  parseQueueItemRef, sameQueueItem, triageClassMintAllowed, triageWriteClasses, validateTriageStamp,
} from '../triage/stamp-schema.ts';
import { actionQueueItemRef } from '../triage/shadow-schema.ts';
import { unmappedQueueDoctor } from '../triage/note-class.ts';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';
process.env.METABASE_URL = 'https://metabase.invalid.test';
process.env.METABASE_API_KEY = 'test-metabase-key';

const DS_SUBJECT = 'Antibiotic stewardship: prolonged IV course';
const DS_FINDING: OpdFinding = {
  subject: DS_SUBJECT,
  verdict: 'low-value' as const,
  confidence: 0.8,
  domain: 'appropriateness' as const,
  rationale: 'Clean procedure kept on IV antibiotics',
  evidence: [] as string[],
  estimates: [] as string[],
  citation_ids: [] as number[],
  source: 'llm' as const,
};
const DS_SIGNAL = stampFindingIdentity([DS_FINDING])[0].signal_type as string;

const MAPPED_AUDIT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const UNMAPPED_AUDIT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2';

test('class-safe ref parse: legacy OPD form still means opd, and the body must echo class on a 3-part ref', () => {
  assert.equal(actionQueueItemRef('DOC-1', 'drug_interaction'), 'opd|DOC-1|drug_interaction');
  assert.deepEqual(parseQueueItemRef('DOC-1|drug_interaction'), {
    note_class: 'opd', doctor_uid: 'DOC-1', signal_type: 'drug_interaction',
  });
  assert.equal(sameQueueItem('DOC-1|drug_interaction', 'opd|DOC-1|drug_interaction'), true);
  assert.deepEqual(parseQueueItemRef('discharge_summary|DOC-DS|antibiotic_stewardship'), {
    note_class: 'discharge_summary', doctor_uid: 'DOC-DS', signal_type: 'antibiotic_stewardship',
  });
  assert.equal(parseQueueItemRef('opd|DOC-1|drug_interaction|extra'), null);
  assert.equal(parseQueueItemRef('not-a-class|DOC-1|drug_interaction'), null);
  assert.equal(sameQueueItem('opd|DOC-1|drug_interaction', 'discharge_summary|DOC-1|drug_interaction'), false);

  const legacy = validateTriageStamp({
    queue_item_ref: 'DOC-1|drug_interaction', verb: 'route', reason: 'Safety',
    actor: 'triage-bot', policy_version: 'triage/1',
  });
  assert.equal(legacy.ok, true);
  if (legacy.ok) assert.equal(legacy.value.note_class, 'opd');

  const missing = validateTriageStamp({
    queue_item_ref: 'discharge_summary|DOC-DS|antibiotic_stewardship', verb: 'route', reason: 'Safety',
    actor: 'triage-bot', policy_version: 'triage/1',
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /note_class required/);

  const echoed = validateTriageStamp({
    queue_item_ref: 'discharge_summary|DOC-DS|antibiotic_stewardship',
    note_class: 'discharge_summary', verb: 'hold', reason: 'Awaiting consultant',
    actor: 'triage-bot', policy_version: 'triage/1',
  });
  assert.equal(echoed.ok, true);
  if (echoed.ok) assert.equal(echoed.value.note_class, 'discharge_summary');

  const mismatch = validateTriageStamp({
    queue_item_ref: 'discharge_summary|DOC-DS|antibiotic_stewardship',
    note_class: 'opd', verb: 'hold', reason: 'no',
    actor: 'triage-bot', policy_version: 'triage/1',
  });
  assert.equal(mismatch.ok, false);
});

test('write-class allow-list defaults to opd and does not treat a typo as an opening', () => {
  assert.deepEqual(triageWriteClasses({}), ['opd']);
  assert.deepEqual(triageWriteClasses({ TRIAGE_BOT_WRITE_CLASSES: '' }), ['opd']);
  assert.deepEqual(triageWriteClasses({ TRIAGE_BOT_WRITE_CLASSES: 'nope' }), ['opd']);
  assert.equal(triageClassMintAllowed('opd', {}), true);
  assert.equal(triageClassMintAllowed('discharge_summary', {}), false);
  assert.equal(triageClassMintAllowed('ot', {}), false);
  assert.equal(triageClassMintAllowed('discharge_summary', { TRIAGE_BOT_WRITE_CLASSES: 'opd,discharge_summary' }), true);
  assert.equal(triageClassMintAllowed('opd', { TRIAGE_BOT_WRITE_CLASSES: 'discharge_summary' }), false);
});

test('an OPD hold does not hide the discharge card for the same doctor and signal', () => {
  const findings: TriageFinding[] = [
    {
      audit_id: 'n1', doctor_uid: 'docA', note_date: '2026-09-22', note_class: 'opd',
      subject: 'Interaction (major): A + B', rationale: 'r', verdict: 'low-value',
      domain: 'prescribing_safety', signal_type: 'drug_interaction', finding_ref: 'r1',
    },
    {
      audit_id: 'ds1', doctor_uid: 'docA', note_date: '2026-09-22', note_class: 'discharge_summary',
      subject: 'Interaction (major): A + B', rationale: 'r', verdict: 'low-value',
      domain: 'prescribing_safety', signal_type: 'drug_interaction', finding_ref: 'r2',
    },
  ];
  const decisions: TriageDecisionRow[] = [{
    scope: 'type', doctor_uid: 'docA', signal_type: 'drug_interaction', note_class: 'opd',
    validity: 'non_clinical', routed: false, disposition: 'hold', created_at: '2026-09-22T01:00:00.000Z',
  }];
  const { doctors } = buildQueue(findings, decisions, { status: 'untriaged' });
  assert.equal(doctors.length, 1);
  assert.equal(doctors[0].types.length, 1);
  assert.equal(doctors[0].types[0].note_class, 'discharge_summary');
  assert.equal(doctors[0].types[0].signal_type, 'drug_interaction');
});

test('DS lander keeps a resolved hop uid and fail-closes every other stay without inventing one', () => {
  const rows: DischargeAuditSource[] = [
    {
      id: MAPPED_AUDIT, ip_uid: 'IP-1', speciality: 'Medicine', note_date: '2026-09-22',
      findings: [DS_FINDING],
    },
    {
      id: UNMAPPED_AUDIT, ip_uid: 'IP-2', speciality: 'Surgery', note_date: '2026-09-22',
      findings: [{ ...DS_FINDING, subject: 'Antibiotic stewardship: second stay' }],
    },
    {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3', ip_uid: 'IP-3', note_date: '2026-09-22',
      findings: [DS_FINDING],
    },
  ];
  const named = rows[1] as DischargeAuditSource & { treating_doctor_name?: string };
  named.treating_doctor_name = 'Dr Name Match';

  const landed = landDischargeAudits(rows, {
    coverage: { unavailable: false },
    byIpUid: {
      'IP-1': { doctorUid: 'DOC-DS', reason: 'resolved' },
      'IP-2': { doctorUid: null, reason: 'unmatched_practitioner' },
      'IP-3': { doctorUid: null, reason: 'ambiguous_practitioner' },
    },
  });

  assert.equal(landed.findings.length, 1);
  assert.equal(landed.findings[0].doctor_uid, 'DOC-DS');
  assert.equal(landed.findings[0].note_class, 'discharge_summary');
  assert.equal(landed.findings[0].signal_type, DS_SIGNAL);
  assert.equal(landed.unmapped.length, 2);
  for (const card of landed.unmapped) {
    assert.equal(card.doctor_uid, null);
    assert.equal(card.attribution, 'unmapped');
    assert.equal(card.note_class, 'discharge_summary');
    assert.match(card.queue_item_ref, new RegExp(`^discharge_summary\\|unmapped:${card.audit_id}\\|`));
    assert.ok(!card.queue_item_ref.includes('Name Match'));
  }
  assert.deepEqual(
    landed.unmapped.map((c) => c.hop_reason).sort(),
    ['ambiguous_practitioner', 'unmatched_practitioner'],
  );

  const dark = landDischargeAudits(rows, { coverage: { unavailable: true }, byIpUid: { 'IP-1': { doctorUid: 'DOC-DS', reason: 'resolved' } } });
  assert.equal(dark.findings.length, 0);
  assert.equal(dark.unmapped.length, 3);
  assert.ok(dark.unmapped.every((c) => c.hop_reason === 'hop_unavailable' && c.doctor_uid === null));
});

test('a discharge hold on the queue-local marker clears that card and does not clear another stay', () => {
  const landed = landDischargeAudits([
    { id: UNMAPPED_AUDIT, ip_uid: 'IP-2', note_date: '2026-09-22', findings: [DS_FINDING] },
    { id: MAPPED_AUDIT, ip_uid: '', note_date: '2026-09-22', findings: [DS_FINDING] },
  ], { coverage: { unavailable: false }, byIpUid: {} });
  assert.equal(landed.unmapped.length, 2);
  const hidden = visibleUnmappedCards(landed.unmapped, [{
    scope: 'type', note_class: 'discharge_summary',
    doctor_uid: unmappedQueueDoctor(UNMAPPED_AUDIT), signal_type: DS_SIGNAL,
  }], 'untriaged');
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].audit_id, MAPPED_AUDIT);
  const opdDoesNotHide = visibleUnmappedCards(landed.unmapped, [{
    scope: 'type', note_class: 'opd',
    doctor_uid: unmappedQueueDoctor(UNMAPPED_AUDIT), signal_type: DS_SIGNAL,
  }], 'untriaged');
  assert.equal(opdDoesNotHide.length, 2);
});

test('lander and queue reader do not name-match or open a second queue door', () => {
  const lander = readFileSync('lib/triage/ds-lander.ts', 'utf8');
  const queue = readFileSync('lib/triage/queue-read.ts', 'utf8');
  const admin = readFileSync('app/api/admin/triage/queue/route.ts', 'utf8');
  const audits = readFileSync('app/api/governance/doctor-audits/route.ts', 'utf8');
  const migration = readFileSync('migrations/0060_triage_note_class.sql', 'utf8');
  for (const banned of ['doctor-lookup', 'normalizeDoctorName', 'resolveDoctor', 'treating_doctor_team', 'queue-ds']) {
    assert.ok(!lander.includes(banned), banned);
    assert.ok(!queue.includes(banned), banned);
  }
  assert.match(queue, /ipd_discharge_audits/);
  assert.match(queue, /fetchIpdDoctorHop/);
  assert.match(admin, /flattenActionQueueItems\(result\.doctors, result\.unmapped\)/);
  assert.ok(!/queue-ds/.test(admin));
  assert.match(audits, /note_class/);
  assert.match(audits, /s\.note_class === 'opd'/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS note_class/);
  assert.ok(!/TRIAGE_BOT_WRITE\s*=/.test(migration));
  assert.match(readFileSync('lib/opd-gov-signal-store.ts', 'utf8'), /note_class/);
});

test('doctor-audits signal object carries note_class and defaults history to opd', () => {
  const row: SignalRow = {
    reference: 'EHRC-AUD-2026-0009', signal_id: 'uuid', doctor_uid: 'DOC-DS', signal_type: 'antibiotic_stewardship',
    importance: 'high', response_required: 'explanation', status: 'routed',
    window_from: '2026-09-22', window_to: '2026-09-22', routed_at: '2026-09-22T00:00:00.000Z',
    sla_due_at: null, latest_response: null, ruling: null,
  };
  assert.equal(signalObject(row, null, '2026-09-22T00:00:00.000Z').note_class, 'opd');
  assert.equal(signalObject({ ...row, note_class: 'discharge_summary' }, null, '2026-09-22T00:00:00.000Z').note_class, 'discharge_summary');
});

// ── stamp door: OPD regression, DS gate, unmapped hold, class-scoped idempotency ─────────

type Row = Record<string, unknown>;
const issued: { text: string; params: unknown[] }[] = [];
const stamps: Row[] = [];
const triageRows: Row[] = [];
const signals: Row[] = [];

function resetStore(): void {
  issued.length = 0;
  stamps.length = 0;
  triageRows.length = 0;
  signals.length = 0;
  process.env.TRIAGE_BOT_WRITE = '1';
  delete process.env.TRIAGE_BOT_WRITE_CLASSES;
}

function pgTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  const text = String(value ?? '').trim();
  if (!text || text === '{}') return [];
  if (text.startsWith('{') && text.endsWith('}')) {
    return text.slice(1, -1).split(',').map((part) => part.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  }
  return [text];
}

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

const OPD_FINDING = JSON.stringify([{
  subject: 'Drug interaction: A + B', rationale: 'Interaction requires review', verdict: 'unsafe',
  domain: 'prescribing', signal_type: 'drug_interaction', finding_ref: 'f-1', informational: false, citation_ids: [],
}]);

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
  if (/INSERT INTO triage_stamp_events/.test(text)) {
    const candidate: Row = {
      id: String(params[0]),
      queue_item_ref: params[2] == null ? null : String(params[2]),
      verb: params[3] == null ? null : String(params[3]),
      reason: params[4] == null ? null : String(params[4]),
      actor: params[5] == null ? null : String(params[5]),
      policy_version: params[6] == null ? null : String(params[6]),
      run_id: params[7] == null ? null : String(params[7]),
      outcome: 'accepted',
      decision_id: null, signal_reference: null,
      client_request_id: params[9] == null ? null : String(params[9]),
      result: null, error: null,
    };
    const key = candidate.client_request_id == null ? null : String(candidate.client_request_id);
    const runId = candidate.run_id == null ? null : String(candidate.run_id);
    const clash = stamps.some((existing) =>
      (key != null && existing.client_request_id === key)
      || (runId != null && existing.queue_item_ref === candidate.queue_item_ref && existing.run_id === runId));
    if (clash) return neon([]);
    stamps.push(candidate);
    return neon([{ id: candidate.id }]);
  }
  if (/WHERE client_request_id = \$1/.test(text)) {
    const row = stamps.find((existing) => existing.client_request_id === params[0]);
    return neon(row ? [row] : []);
  }
  if (/WHERE queue_item_ref = \$1 AND run_id = \$2/.test(text)) {
    const row = stamps.find((existing) => existing.queue_item_ref === params[0] && existing.run_id === params[1]);
    return neon(row ? [row] : []);
  }
  if (/UPDATE triage_stamp_events/.test(text)) {
    const row = stamps.find((existing) => existing.id === String(params[0]));
    if (row && /decision_id=\$3/.test(text)) {
      row.outcome = params[1];
      row.decision_id = params[2];
      row.signal_reference = params[3];
      row.error = params[4];
      row.result = params[5];
    }
    return neon([]);
  }
  if (/INSERT INTO opd_audit_triage/.test(text)) {
    triageRows.push({
      scope: String(params[1]),
      doctor_uid: String(params[2]),
      signal_type: String(params[3]),
      validity: String(params[8]),
      routed: params[11] === true || params[11] === 'true',
      disposition: /disposition/.test(text) ? String(params[15]) : null,
      note_class: String(params[params.length - 1]),
      created_at: '2026-09-22T06:00:00.000Z',
    });
    return neon([]);
  }
  if (/FROM opd_audit_triage/.test(text) && /doctor_uid = ANY\(\$1\)/.test(text)) {
    const uids = pgTextArray(params[0]);
    return neon(triageRows.filter((row) => uids.includes(String(row.doctor_uid))));
  }
  if (/INSERT INTO opd_gov_signal\b/.test(text)) {
    signals.push({
      signal_id: String(params[0]),
      reference: String(params[1]),
      doctor_uid: String(params[2]),
      signal_type: String(params[3]),
      importance: String(params[4]),
      response_required: String(params[5]),
      status: String(params[6]),
      source_triage_ref: params[7] == null ? null : String(params[7]),
      window_from: params[8] == null ? null : String(params[8]),
      window_to: params[9] == null ? null : String(params[9]),
      sla_due_at: params[10] == null ? null : String(params[10]),
      note_class: String(params[11]),
      latest_response: null, ruling: null,
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
    });
    return neon([]);
  }
  if (/FROM opd_gov_signal/i.test(text)) {
    if (/count\(\*\)/i.test(text)) return neon([{ n: signals.length }]);
    if (/signal_id=\$1/.test(text)) {
      const row = signals.find((s) => s.signal_id === String(params[0]));
      return neon(row ? [row] : []);
    }
    if (/note_class=\$5/.test(text)) {
      const row = signals.find((s) => s.doctor_uid === String(params[0]) && s.signal_type === String(params[1]) && s.note_class === String(params[4]));
      return neon(row ? [row] : []);
    }
    return neon([]);
  }
  if (/opd_note_audits/.test(text) && /DISTINCT ON/.test(text)) {
    return neon([{
      id: '99999999-8888-7777-6666-555555555555',
      doctor_uid: 'DOC-OPD',
      note_date: '2026-09-22',
      findings: OPD_FINDING,
      complexity_band: 'LOW',
      complexity_inputs: '{}',
    }]);
  }
  if (/ipd_discharge_audits/.test(text) && /DISTINCT ON/.test(text)) {
    return neon([
      {
        id: MAPPED_AUDIT, ip_uid: 'IP-1', speciality: 'Medicine', note_date: '2026-09-22',
        findings: JSON.stringify([DS_FINDING]),
      },
      {
        id: UNMAPPED_AUDIT, ip_uid: 'IP-2', speciality: 'Surgery', note_date: '2026-09-22',
        findings: JSON.stringify([{ ...DS_FINDING, subject: 'Antibiotic stewardship: unnamed stay' }]),
        treating_doctor_name: 'Dr Name Match',
      },
    ]);
  }
  return neon([]);
}) as typeof fetch;

function signalInserts() {
  return issued.filter((query) => /INSERT INTO opd_gov_signal\b/.test(query.text));
}
function decisionInserts() {
  return issued.filter((query) => /INSERT INTO opd_audit_triage/.test(query.text));
}

async function post(payload: Record<string, unknown>) {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('../../app/api/admin/triage/stamp/route.ts');
  const response = await POST(new NextRequest('https://cat.test/api/admin/triage/stamp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-admin-token',
      'content-type': 'application/json',
      'x-request-id': 'ds-test',
    },
    body: JSON.stringify({ day: '2026-09-22', days: 1, ...payload }),
  }));
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

test('Action queue lists mapped DS, unmapped DS, and OPD together', async () => {
  resetStore();
  const queue = await readActionQueue({ day: '2026-09-22', days: 1, doctor_uid: '', status: 'untriaged', includeQuieted: false });
  const items = flattenActionQueueItems(queue.doctors, queue.unmapped);
  const opd = items.find((i) => i.note_class === 'opd');
  const mapped = items.find((i) => i.note_class === 'discharge_summary' && i.attribution === 'mapped');
  const unmapped = items.find((i) => i.attribution === 'unmapped');
  assert.ok(opd);
  assert.equal(opd?.queue_item_ref, 'opd|DOC-OPD|drug_interaction');
  assert.equal(opd?.doctor_uid, 'DOC-OPD');
  assert.ok(mapped);
  assert.equal(mapped?.doctor_uid, 'DOC-DS');
  assert.equal(mapped?.queue_item_ref, `discharge_summary|DOC-DS|${DS_SIGNAL}`);
  assert.ok(unmapped);
  assert.equal(unmapped?.doctor_uid, null);
  assert.match(String(unmapped?.queue_item_ref), new RegExp(`^discharge_summary\\|unmapped:${UNMAPPED_AUDIT}\\|`));
  assert.ok(!items.some((i) => String(i.doctor_uid || '').includes('Name')));
});

test('default write classes block a mapped DS route and still mint OPD', async () => {
  resetStore();
  const blocked = await post({
    queue_item_ref: `discharge_summary|DOC-DS|${DS_SIGNAL}`,
    note_class: 'discharge_summary',
    verb: 'route',
    reason: 'Needs the discharging consultant',
    actor: 'triage-bot',
    policy_version: 'triage/1',
    run_id: 'ds-route-blocked',
  });
  assert.equal(blocked.status, 403, JSON.stringify(blocked.json));
  assert.match(String(blocked.json.error), /TRIAGE_BOT_WRITE_CLASSES/);
  assert.equal(signalInserts().length, 0);
  assert.equal(decisionInserts().length, 0);

  const opd = await post({
    queue_item_ref: 'DOC-OPD|drug_interaction',
    verb: 'route',
    reason: 'Safety signal requires a doctor',
    actor: 'triage-bot',
    policy_version: 'triage/1',
    run_id: 'opd-still-mints',
  });
  assert.equal(opd.status, 200, JSON.stringify(opd.json));
  assert.equal(opd.json.note_class, 'opd');
  assert.equal(opd.json.outcome, 'applied');
  assert.equal(signalInserts().length, 1);
  assert.equal(signalInserts()[0].params[11], 'opd');
});

test('unmapped DS route is refused and hold with unmapped_doctor records no signal', async () => {
  resetStore();
  const ref = `discharge_summary|${unmappedQueueDoctor(UNMAPPED_AUDIT)}|${DS_SIGNAL}`;
  const refused = await post({
    queue_item_ref: ref,
    note_class: 'discharge_summary',
    verb: 'route',
    reason: 'guess',
    actor: 'triage-bot',
    policy_version: 'triage/1',
    run_id: 'unmapped-route',
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.json));
  assert.match(String(refused.json.error), /unmapped_doctor/);
  assert.equal(signalInserts().length, 0);
  assert.equal(decisionInserts().length, 0);

  const held = await post({
    queue_item_ref: ref,
    note_class: 'discharge_summary',
    verb: 'hold',
    reason: 'unmapped_doctor',
    actor: 'triage-bot',
    policy_version: 'triage/1',
    run_id: 'unmapped-hold',
  });
  assert.equal(held.status, 200, JSON.stringify(held.json));
  assert.equal(held.json.outcome, 'held');
  assert.equal(held.json.signal, null);
  assert.equal(signalInserts().length, 0);
  assert.equal(decisionInserts().length, 1);
  assert.equal(decisionInserts()[0].params[paramsNoteClass(decisionInserts()[0])], 'discharge_summary');
  assert.match(String(decisionInserts()[0].params[2]), /^unmapped:/);

  const again = await readActionQueue({ day: '2026-09-22', days: 1, doctor_uid: '', status: 'untriaged', includeQuieted: false });
  const still = flattenActionQueueItems(again.doctors, again.unmapped).filter((i) => i.attribution === 'unmapped');
  assert.equal(still.length, 0);

  const replay = await post({
    queue_item_ref: ref,
    note_class: 'discharge_summary',
    verb: 'hold',
    reason: 'unmapped_doctor',
    actor: 'triage-bot',
    policy_version: 'triage/1',
    run_id: 'unmapped-hold',
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.json.replayed, true);
  assert.equal(decisionInserts().length, 1);
  assert.equal(signalInserts().length, 0);
});

function paramsNoteClass(query: { params: unknown[] }): number {
  return query.params.length - 1;
}

test('class-extended refs are distinct idempotency keys, and DS route mints only when the allow-list names it', async () => {
  resetStore();
  process.env.TRIAGE_BOT_WRITE_CLASSES = 'opd,discharge_summary';
  try {
    const runId = 'shared-run-22';
    const opdRef = 'opd|DOC-OPD|drug_interaction';
    const dsRef = `discharge_summary|DOC-DS|${DS_SIGNAL}`;
    const opd = await post({
      queue_item_ref: opdRef, note_class: 'opd', verb: 'route', reason: 'OPD safety',
      actor: 'triage-bot', policy_version: 'triage/1', run_id: runId,
    });
    const ds = await post({
      queue_item_ref: dsRef, note_class: 'discharge_summary', verb: 'route', reason: 'DS safety',
      actor: 'triage-bot', policy_version: 'triage/1', run_id: runId,
    });
    assert.equal(opd.status, 200, JSON.stringify(opd.json));
    assert.equal(ds.status, 200, JSON.stringify(ds.json));
    assert.equal(opd.json.replayed, false);
    assert.equal(ds.json.replayed, false);
    assert.notEqual(opd.json.stamp_id, ds.json.stamp_id);
    assert.equal(signalInserts().length, 2);
    assert.deepEqual(signalInserts().map((q) => q.params[11]).sort(), ['discharge_summary', 'opd']);

    const replay = await post({
      queue_item_ref: dsRef, note_class: 'discharge_summary', verb: 'route', reason: 'DS safety',
      actor: 'triage-bot', policy_version: 'triage/1', run_id: runId,
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.stamp_id, ds.json.stamp_id);
    assert.equal(signalInserts().length, 2);
    assert.equal((replay.json.signal as { signal_id: string }).signal_id, (ds.json.signal as { signal_id: string }).signal_id);
  } finally {
    delete process.env.TRIAGE_BOT_WRITE_CLASSES;
  }
});
