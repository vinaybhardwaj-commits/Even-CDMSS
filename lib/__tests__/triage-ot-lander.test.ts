/**
 * P3 OT lander onto the shared Action queue (Phases A–F). Write mint stays off.
 *
 *   node --test --import tsx lib/__tests__/triage-ot-lander.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildQueue, type TriageFinding, type TriageDecisionRow } from '../opd-triage-core.ts';
import { stampFindingIdentity, type OpdFinding } from '../opd-note-audit-core.ts';
import { signalObject, type SignalRow } from '../opd-gov-signal-core.ts';
import { landOtAudits, visibleUnmappedOtCards, type OtAuditSource } from '../triage/ot-lander.ts';
import { auditOtNote } from '../triage/ot-audit-core.ts';
import { buildOtAuditsForQueueSql } from '../triage/ot-audit-store.ts';
import {
  buildSurgeonLookup, isMultiSurgeonDump, resolveOtSurgeon,
} from '../triage/ot-surgeon-map.ts';
import { flattenActionQueueItems, readActionQueue } from '../triage/queue-read.ts';
import {
  parseQueueItemRef, triageClassMintAllowed, triageWriteClasses, validateTriageStamp,
} from '../triage/stamp-schema.ts';
import { actionQueueItemRef } from '../triage/shadow-schema.ts';
import { unmappedQueueDoctor } from '../triage/note-class.ts';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';
process.env.METABASE_URL = 'https://metabase.invalid.test';
process.env.METABASE_API_KEY = 'test-metabase-key';

const OT_FINDING: OpdFinding = {
  subject: 'Documentation completeness: OT note body is thin or empty',
  verdict: 'context-dependent' as const,
  confidence: 0.9,
  domain: 'appropriateness' as const,
  rationale: 'thin',
  evidence: [] as string[],
  estimates: [] as string[],
  citation_ids: [] as number[],
  source: 'deterministic' as const,
};
const OT_SIGNAL = stampFindingIdentity([OT_FINDING])[0].signal_type as string;

const MAPPED_AUDIT = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const UNMAPPED_AUDIT = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2';
const MULTI_AUDIT = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee3';

test('surgeon map: Y seed resolves, N stays unmapped, multiline holds, treating-doctor never consulted', () => {
  const seed = JSON.parse(readFileSync('data/ot-surgeon-pulse-seed.json', 'utf8')) as {
    mapped: { surgeon: string; doctor_uid: string }[];
  };
  const map = buildSurgeonLookup(seed.mapped);
  assert.ok(seed.mapped.length >= 20);
  assert.ok(map.size >= 18, `unique CI keys=${map.size}`);
  const hit = resolveOtSurgeon('DR MANOJ KUMAR S', map);
  assert.equal(hit.map_status, 'mapped');
  assert.equal(hit.doctor_uid, 'Tbvyk1V5ijpcD194ZOWi');

  const miss = resolveOtSurgeon('DR.NAVEEN KUMAR AG', map);
  assert.equal(miss.map_status, 'unmapped');
  assert.equal(miss.doctor_uid, null);

  const multiRaw = 'DR NAYAR SAJEET\nDR POORNIMA PARASURAMAN';
  assert.equal(isMultiSurgeonDump(multiRaw), true);
  const multi = resolveOtSurgeon(multiRaw, map);
  assert.equal(multi.map_status, 'multi_surgeon_hold');
  assert.equal(multi.doctor_uid, null);

  const empty = resolveOtSurgeon('', map);
  assert.equal(empty.map_status, 'unmapped');
  assert.equal(empty.reason, 'empty_surgeon');

  // Case-insensitive key match
  assert.equal(resolveOtSurgeon('dr manoj kumar s', map).doctor_uid, 'Tbvyk1V5ijpcD194ZOWi');
});

test('v0 OT audit emits stamped findings with queue-compatible shape', () => {
  const thin = auditOtNote({ note: 'short', surgery_name: null, surgeon: null });
  assert.ok(thin.length >= 2);
  assert.ok(thin.every((f) => f.signal_type && f.finding_ref));
  const full = auditOtNote({
    note: 'A'.repeat(120),
    surgery_name: 'Hernia repair',
    surgeon: 'DR MANOJ KUMAR S',
  });
  assert.equal(full.length, 1);
  assert.match(full[0].subject, /OT documentation review/);
  assert.ok(!/screen/i.test(full[0].subject));
  assert.ok(!/screen/i.test(full[0].rationale));
});

test('OT queue SQL selects uid once in DISTINCT ON subquery (Neon ambiguous-uid guard)', () => {
  const sqlText = buildOtAuditsForQueueSql(
    `app_source = $1 AND engine_version = $2 AND note_day BETWEEN $3::date AND $4::date`,
  );
  assert.match(sqlText, /^SELECT id, uid,/);
  const inner = sqlText.match(/SELECT DISTINCT ON \(uid\) (.+?)\s+FROM ot_note_audits/s)?.[1];
  assert.ok(inner, `expected DISTINCT ON subquery; got: ${sqlText}`);
  const uidHits = inner.match(/\buid\b/g) || [];
  assert.equal(
    uidHits.length,
    1,
    `canonicalDistinctOnSql already projects uid — cols must not re-list it (ambiguous for Neon). select list: ${inner}`,
  );
});

test('OT lander keeps mapped Pulse uid and fail-closes unmapped + multi without inventing one', () => {
  const rows: OtAuditSource[] = [
    {
      id: MAPPED_AUDIT, doctor_uid: 'DOC-OT', map_status: 'mapped', note_day: '2026-09-22',
      findings: [OT_FINDING], surgeon_raw: 'DR MANOJ KUMAR S',
    },
    {
      id: UNMAPPED_AUDIT, doctor_uid: null, map_status: 'unmapped', note_day: '2026-09-22',
      findings: [{ ...OT_FINDING, subject: 'Documentation completeness: surgery name missing' }],
      surgeon_raw: 'DR.NAVEEN KUMAR AG',
      // poisoned fields that must never become the doctor
      ...( { current_treating_doctor: 'Dr Treating', treating_doctor_uid: 'TREAT-1' } as object ),
    },
    {
      id: MULTI_AUDIT, doctor_uid: null, map_status: 'multi_surgeon_hold', note_day: '2026-09-22',
      findings: [OT_FINDING],
      surgeon_raw: 'A\nB',
    },
  ];

  const landed = landOtAudits(rows);
  assert.equal(landed.findings.length, 1);
  assert.equal(landed.findings[0].doctor_uid, 'DOC-OT');
  assert.equal(landed.findings[0].note_class, 'ot');
  assert.equal(landed.findings[0].signal_type, OT_SIGNAL);
  assert.equal(landed.unmapped.length, 2);
  for (const card of landed.unmapped) {
    assert.equal(card.doctor_uid, null);
    assert.equal(card.note_class, 'ot');
    assert.equal(card.attribution, 'unmapped');
    assert.match(card.queue_item_ref, new RegExp(`^ot\\|unmapped:${card.audit_id}\\|`));
    assert.ok(!card.queue_item_ref.includes('TREAT'));
    assert.ok(!card.queue_item_ref.includes('Treating'));
  }
  assert.deepEqual(
    landed.unmapped.map((c) => c.hop_reason).sort(),
    ['multi_surgeon_hold', 'unmapped_surgeon'],
  );
});

test('an OPD hold does not hide the OT card for the same doctor and signal', () => {
  const findings: TriageFinding[] = [
    {
      audit_id: 'n1', doctor_uid: 'docA', note_date: '2026-09-22', note_class: 'opd',
      subject: 'Documentation completeness: OT note body is thin or empty', rationale: 'r',
      verdict: 'context-dependent', domain: 'appropriateness',
      signal_type: OT_SIGNAL, finding_ref: 'r1',
    },
    {
      audit_id: 'ot1', doctor_uid: 'docA', note_date: '2026-09-22', note_class: 'ot',
      subject: 'Documentation completeness: OT note body is thin or empty', rationale: 'r',
      verdict: 'context-dependent', domain: 'appropriateness',
      signal_type: OT_SIGNAL, finding_ref: 'r2',
    },
  ];
  const decisions: TriageDecisionRow[] = [{
    scope: 'type', doctor_uid: 'docA', signal_type: OT_SIGNAL, note_class: 'opd',
    validity: 'non_clinical', routed: false, disposition: 'hold', created_at: '2026-09-22T01:00:00.000Z',
  }];
  const { doctors } = buildQueue(findings, decisions, { status: 'untriaged' });
  assert.equal(doctors.length, 1);
  assert.equal(doctors[0].types.length, 1);
  assert.equal(doctors[0].types[0].note_class, 'ot');
});

test('OT unmapped hold is class-scoped', () => {
  const landed = landOtAudits([
    { id: UNMAPPED_AUDIT, map_status: 'unmapped', note_day: '2026-09-22', findings: [OT_FINDING] },
    { id: MULTI_AUDIT, map_status: 'multi_surgeon_hold', note_day: '2026-09-22', findings: [OT_FINDING] },
  ]);
  const hidden = visibleUnmappedOtCards(landed.unmapped, [{
    scope: 'type', note_class: 'ot',
    doctor_uid: unmappedQueueDoctor(UNMAPPED_AUDIT), signal_type: OT_SIGNAL,
  }], 'untriaged');
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].audit_id, MULTI_AUDIT);
  const dsHoldDoesNotHide = visibleUnmappedOtCards(landed.unmapped, [{
    scope: 'type', note_class: 'discharge_summary',
    doctor_uid: unmappedQueueDoctor(UNMAPPED_AUDIT), signal_type: OT_SIGNAL,
  }], 'untriaged');
  assert.equal(dsHoldDoesNotHide.length, 2);
});

test('write-class allow-list keeps ot off by default; class-safe OT refs require body echo', () => {
  assert.equal(triageClassMintAllowed('ot', {}), false);
  assert.equal(triageClassMintAllowed('ot', { TRIAGE_BOT_WRITE_CLASSES: 'opd,discharge_summary' }), false);
  assert.equal(triageClassMintAllowed('ot', { TRIAGE_BOT_WRITE_CLASSES: 'opd,ot' }), true);
  assert.deepEqual(triageWriteClasses({}), ['opd']);

  assert.equal(actionQueueItemRef('DOC-OT', OT_SIGNAL, 'ot'), `ot|DOC-OT|${OT_SIGNAL}`);
  assert.deepEqual(parseQueueItemRef(`ot|DOC-OT|${OT_SIGNAL}`), {
    note_class: 'ot', doctor_uid: 'DOC-OT', signal_type: OT_SIGNAL,
  });

  const missing = validateTriageStamp({
    queue_item_ref: `ot|DOC-OT|${OT_SIGNAL}`, verb: 'route', reason: 'x',
    actor: 'triage-bot', policy_version: 'triage/1',
  });
  assert.equal(missing.ok, false);

  const ok = validateTriageStamp({
    queue_item_ref: `ot|DOC-OT|${OT_SIGNAL}`, note_class: 'ot', verb: 'hold', reason: 'review',
    actor: 'triage-bot', policy_version: 'triage/1',
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.note_class, 'ot');
});

test('lander / queue / migration doors: no surgery_cases grain, no second queue, no write flip', () => {
  const lander = readFileSync('lib/triage/ot-lander.ts', 'utf8');
  const queue = readFileSync('lib/triage/queue-read.ts', 'utf8');
  const db13 = readFileSync('lib/triage/ot-db13.ts', 'utf8');
  const store = readFileSync('lib/triage/ot-audit-store.ts', 'utf8');
  const migration = readFileSync('migrations/0061_ot_note_audits.sql', 'utf8');
  const worker = readFileSync('app/api/ot-audit/worker/route.ts', 'utf8');

  for (const banned of [
    'surgery_cases', 'doctor-lookup', 'normalizeDoctorName',
    'resolveDoctor', 'queue-ot',
  ]) {
    assert.ok(!lander.includes(banned), `lander: ${banned}`);
  }
  assert.match(lander, /never uses the treating-doctor/);
  assert.match(lander, /never name-matches beyond the curated map/);
  assert.ok(!queue.includes('surgery_cases'));
  assert.ok(!db13.includes('surgery_cases'));
  assert.ok(!store.includes('surgery_cases'));
  assert.match(db13, /kx_clinical_template_ot_notes/);
  assert.match(db13, /status = 'final'/);
  assert.ok(!db13.includes('patient_name'));
  assert.ok(!db13.includes('patient_mobile'));
  assert.match(queue, /ot_note_audits|loadOtAuditsForQueue|landOtAudits/);
  assert.match(queue, /ot_load/);
  assert.match(queue, /OT Action-queue load failed/);
  assert.match(store, /buildOtAuditsForQueueSql|loadOtAuditsForQueue failed/);
  assert.ok(!store.includes('id::text AS id, uid, hospital_uid'), 'cols must not re-list uid');
  assert.ok(!/queue-ot/.test(queue));
  assert.match(migration, /ot_note_audits/);
  assert.match(migration, /ot_surgeon_map/);
  assert.ok(!/TRIAGE_BOT_WRITE\s*=/.test(migration));
  assert.match(migration, /Does not set TRIAGE_BOT_WRITE_CLASSES/);
  assert.match(worker, /write_mint/);
  assert.match(worker, /blocked/);
});

test('doctor-audits signal object carries note_class=ot', () => {
  const row: SignalRow = {
    reference: 'EHRC-AUD-2026-0099', signal_id: 'uuid', doctor_uid: 'DOC-OT', signal_type: OT_SIGNAL,
    importance: 'med', response_required: 'explanation', status: 'routed',
    window_from: '2026-09-22', window_to: '2026-09-22', routed_at: '2026-09-22T00:00:00.000Z',
    sla_due_at: null, latest_response: null, ruling: null, note_class: 'ot',
  };
  assert.equal(signalObject(row, null, '2026-09-22T00:00:00.000Z').note_class, 'ot');
});

// ── stamp door + queue union (fetch mock) ─────────────────────────────────────

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

  if (/CREATE TABLE IF NOT EXISTS ot_/.test(text) || /CREATE UNIQUE INDEX IF NOT EXISTS ot_/.test(text)
    || /CREATE INDEX IF NOT EXISTS ot_/.test(text)) {
    return neon([]);
  }
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
      note_class: String(params[11]),
      latest_response: null, ruling: null,
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
    return neon([]);
  }
  if (/ot_note_audits/.test(text) && /DISTINCT ON/.test(text)) {
    return neon([
      {
        id: MAPPED_AUDIT, uid: 'OT-UID-1', hospital_uid: 'vZmEPseTKP3vS3DrZzrv',
        encounter_id: 'IP-1', uhid: null, surgery_name: 'Hernia', surgeon_raw: 'DR MANOJ KUMAR S',
        note_day: '2026-09-22', doctor_uid: 'DOC-OT', map_status: 'mapped',
        findings: JSON.stringify([OT_FINDING]), n_findings: 1, engine_version: 'ot-note-audit/0.1',
      },
      {
        id: UNMAPPED_AUDIT, uid: 'OT-UID-2', hospital_uid: 'vZmEPseTKP3vS3DrZzrv',
        encounter_id: 'IP-2', uhid: null, surgery_name: 'Knee', surgeon_raw: 'DR.NAVEEN KUMAR AG',
        note_day: '2026-09-22', doctor_uid: null, map_status: 'unmapped',
        findings: JSON.stringify([{ ...OT_FINDING, subject: 'Documentation completeness: surgery name missing' }]),
        n_findings: 1, engine_version: 'ot-note-audit/0.1',
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
      'x-request-id': 'ot-test',
    },
    body: JSON.stringify({ day: '2026-09-22', days: 1, ...payload }),
  }));
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

test('Action queue unions mapped OT + unmapped OT + OPD with class-safe refs', async () => {
  resetStore();
  const queue = await readActionQueue({ day: '2026-09-22', days: 1, doctor_uid: '', status: 'untriaged', includeQuieted: false });
  assert.deepEqual(queue.ot_load, { ok: true });
  const items = flattenActionQueueItems(queue.doctors, queue.unmapped);
  const opd = items.find((i) => i.note_class === 'opd');
  const mapped = items.find((i) => i.note_class === 'ot' && i.attribution === 'mapped');
  const unmapped = items.find((i) => i.note_class === 'ot' && i.attribution === 'unmapped');
  assert.ok(opd);
  assert.equal(opd?.queue_item_ref, 'opd|DOC-OPD|drug_interaction');
  assert.ok(mapped);
  assert.equal(mapped?.doctor_uid, 'DOC-OT');
  assert.equal(mapped?.queue_item_ref, `ot|DOC-OT|${OT_SIGNAL}`);
  assert.ok(unmapped);
  assert.equal(unmapped?.doctor_uid, null);
  assert.match(String(unmapped?.queue_item_ref), new RegExp(`^ot\\|unmapped:${UNMAPPED_AUDIT}\\|`));

  const otSql = issued.find((q) => /ot_note_audits/.test(q.text) && /DISTINCT ON/.test(q.text));
  assert.ok(otSql, 'OT queue load must issue DISTINCT ON SQL');
  const inner = otSql.text.match(/SELECT DISTINCT ON \(uid\) (.+?)\s+FROM ot_note_audits/s)?.[1];
  assert.ok(inner);
  assert.equal((inner.match(/\buid\b/g) || []).length, 1);
});

test('OT Neon load failure surfaces ot_load diagnostic (not silent empty)', async () => {
  resetStore();
  const prev = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String((init as { body?: unknown } | undefined)?.body || '{}')) as {
      query?: string; native?: { query?: string };
    };
    if (sent.native?.query) return prev(url as RequestInfo, init);
    const text = String(sent.query || '');
    if (/ot_note_audits/.test(text) && /DISTINCT ON/.test(text)) {
      throw new Error('column reference "uid" is ambiguous');
    }
    return prev(url as RequestInfo, init);
  }) as typeof fetch;
  try {
    const queue = await readActionQueue({
      day: '2026-09-22', days: 1, doctor_uid: '', status: 'untriaged', includeQuieted: false,
    });
    assert.equal(queue.ot_load.ok, false);
    if (queue.ot_load.ok === false) assert.match(queue.ot_load.error, /ambiguous/);
    const items = flattenActionQueueItems(queue.doctors, queue.unmapped);
    assert.equal(items.filter((i) => i.note_class === 'ot').length, 0);
    assert.ok(items.some((i) => i.note_class === 'opd'), 'OPD must still land when OT load fails');
  } finally {
    globalThis.fetch = prev;
  }
});

test('default write classes block OT route mint and still mint OPD', async () => {
  resetStore();
  const blocked = await post({
    queue_item_ref: `ot|DOC-OT|${OT_SIGNAL}`,
    note_class: 'ot',
    verb: 'route',
    reason: 'Needs the operating surgeon',
    actor: 'triage-bot',
    policy_version: 'triage/1',
    run_id: 'ot-route-blocked',
  });
  assert.equal(blocked.status, 403, JSON.stringify(blocked.json));
  assert.match(String(blocked.json.error), /TRIAGE_BOT_WRITE_CLASSES/);
  assert.equal(signalInserts().length, 0);

  const opd = await post({
    queue_item_ref: 'DOC-OPD|drug_interaction',
    verb: 'route',
    reason: 'Safety signal requires a doctor',
    actor: 'triage-bot',
    policy_version: 'triage/1',
    run_id: 'opd-still-mints-ot',
  });
  assert.equal(opd.status, 200, JSON.stringify(opd.json));
  assert.equal(opd.json.note_class, 'opd');
  assert.equal(signalInserts().length, 1);
  assert.equal(signalInserts()[0].params[11], 'opd');
});

test('unmapped OT route refused; hold with unmapped_doctor records no signal', async () => {
  resetStore();
  const ref = `ot|${unmappedQueueDoctor(UNMAPPED_AUDIT)}|${OT_SIGNAL}`;
  const refused = await post({
    queue_item_ref: ref, note_class: 'ot', verb: 'route', reason: 'guess',
    actor: 'triage-bot', policy_version: 'triage/1', run_id: 'ot-unmapped-route',
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.json));
  assert.match(String(refused.json.error), /unmapped_doctor/);
  assert.equal(signalInserts().length, 0);

  const held = await post({
    queue_item_ref: ref, note_class: 'ot', verb: 'hold', reason: 'unmapped_doctor',
    actor: 'triage-bot', policy_version: 'triage/1', run_id: 'ot-unmapped-hold',
  });
  assert.equal(held.status, 200, JSON.stringify(held.json));
  assert.equal(held.json.outcome, 'held');
  assert.equal(held.json.signal, null);
  assert.equal(signalInserts().length, 0);
  assert.equal(decisionInserts().length, 1);
  assert.equal(decisionInserts()[0].params[decisionInserts()[0].params.length - 1], 'ot');
});
