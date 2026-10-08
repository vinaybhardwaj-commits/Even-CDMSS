/**
 * Governance routes resolve a thread against ITS OWN note class, and signal-action is guarded.
 *
 *   node --test --import tsx lib/__tests__/governance-note-class-routes.test.ts
 *
 * Before: audit-signal, signal-action, doctor-response, signal-reaction and roster-audits (per
 * doctor) called the OPD-only resolver for every thread. A discharge or OT thread got OPD text or
 * nothing, and a doctor's `disagree` wrote a discharge/OT audit id into opd_audit_feedback.
 * signal-action overwrote the ruling and appended an event on every call, in any status.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stampFindingIdentity, type OpdFinding } from '../opd-note-audit-core.ts';
import { signalActionTransition, isSignalActionReplay, calibrationTarget } from '../opd-gov-signal-core.ts';

process.env.GOV_API_KEY = 'test-gov-key';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';
process.env.METABASE_URL = 'https://metabase.invalid.test';
process.env.METABASE_API_KEY = 'test-metabase-key';
delete process.env.TRIAGE_BOT_WRITE_CLASSES;

const DOCTOR = '0q9pSZHR24ysquO6V4Xg';
const DS_AUDIT = '404bb3b3-a0a8-4178-97ec-d562adb2d017';
const OT_AUDIT = '76eeea4d-95db-4246-ae5b-f52fd32c1f0b';
const OPD_AUDIT = '11111111-2222-4333-8444-555555555555';
const WINDOW_FROM = '2026-09-17';
const WINDOW_TO = '2026-09-23';

const raw = (subject: string, verdict: OpdFinding['verdict'] = 'context-dependent'): OpdFinding => ({
  subject, verdict, confidence: 0.8, domain: 'appropriateness', rationale: subject,
  evidence: [], estimates: [], citation_ids: [], source: 'llm',
});
const DS_F = raw('Post-operative Oral Antibiotic Course');
const OT_F = raw('Documentation completeness: OT note body is thin or empty');
const OPD_F = raw('Antibiotic stewardship: OPD viral course', 'low-value');
const DS_SIGNAL = stampFindingIdentity([DS_F])[0].signal_type as string;
const OT_SIGNAL = stampFindingIdentity([OT_F])[0].signal_type as string;
const OPD_SIGNAL = stampFindingIdentity([OPD_F])[0].signal_type as string;

type Row = Record<string, unknown>;
const issued: { text: string; params: unknown[] }[] = [];
const writes = () => issued.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text));
let signals: Row[] = [];
let responseRequest: Row | null = null;
let failNextSignalUpdate = false;
let events: Row[] = [];
let metabaseCalls = 0;
let onLostRace: (() => void) | null = null;

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

function signalRow(partial: Row): Row {
  return {
    signal_id: 'sig', reference: 'EHRC-AUD-2026-0000', doctor_uid: DOCTOR, signal_type: DS_SIGNAL, note_class: 'opd',
    importance: 'high', response_required: 'explanation', status: 'routed', source_triage_ref: null,
    window_from: WINDOW_FROM, window_to: WINDOW_TO, sla_due_at: null, latest_response: null, ruling: null,
    created_at: '2026-09-23T13:00:00.000Z', updated_at: '2026-09-23T13:00:00.000Z', ...partial,
  };
}
const SIG_DS = '10000000-0000-4000-8000-000000000001';
const SIG_OT = '10000000-0000-4000-8000-000000000002';
const SIG_OPD = '10000000-0000-4000-8000-000000000003';

function reset(): void {
  issued.length = 0;
  responseRequest = null;
  failNextSignalUpdate = false;
  events = [];
  metabaseCalls = 0;
  onLostRace = null;
  signals = [
    signalRow({ signal_id: SIG_DS, reference: 'EHRC-AUD-2026-0111', signal_type: DS_SIGNAL, note_class: 'discharge_summary' }),
    signalRow({ signal_id: SIG_OT, reference: 'EHRC-AUD-2026-0901', signal_type: OT_SIGNAL, note_class: 'ot' }),
    signalRow({ signal_id: SIG_OPD, reference: 'EHRC-AUD-2026-0030', signal_type: OPD_SIGNAL, note_class: 'opd' }),
  ];
}
const sig = (id: string) => signals.find((s) => s.signal_id === id)!;

globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
  const sent = JSON.parse(String(init.body || '{}')) as { query?: string; params?: unknown[]; native?: { query?: string } };
  if (sent.native?.query) {
    metabaseCalls++;
    const q = String(sent.native.query);
    if (q.includes('karexpert_metadata__practitioner_id')) return metabase(['pid', 'n_uids', 'uid'], [['PX-POOR', 1, DOCTOR]]);
    if (q.includes('kx_ip_admissions')) return metabase(['encounter_id', 'current_treating_doctor_id'], [['IP-0111', 'PX-POOR']]);
    return metabase([], []);
  }
  const text = String(sent.query || '');
  const params = sent.params || [];
  issued.push({ text, params });

  // event log: appended by applySignalAction, read back for the replay check
  if (/^\s*INSERT INTO opd_gov_signal_event\b/i.test(text)) {
    events.push({ signal_id: params[0], event: params[1], actor: params[2], payload: JSON.parse(String(params[3])) });
    return neon([]);
  }
  if (/^\s*SELECT 1 AS hit FROM opd_gov_signal_event\b/i.test(text)) {
    const hit = events.some((e) => e.signal_id === params[0] && (e.event === 'ruled' || e.event === 'closed')
      && (e.payload as any)?.action === params[1] && (e.payload as any)?.gov_intervention_ref === params[2]);
    return neon(hit ? [{ hit: 1 }] : []);
  }

  // thread store
  if (/^\s*UPDATE opd_gov_signal\b/i.test(text) && /ruling=\$2/.test(text)) {
    if (failNextSignalUpdate) { failNextSignalUpdate = false; onLostRace?.(); return neon([]); }
    const row = sig(String(params[0]));
    if (row.status !== params[3]) return neon([]);          // the conditional write
    row.ruling = params[1]; row.status = params[2];
    return neon([{ signal_id: row.signal_id }]);
  }
  if (/^\s*UPDATE opd_gov_signal\b/i.test(text) && /latest_response=\$2/.test(text)) {
    const row = sig(String(params[0])); row.latest_response = params[1]; row.status = params[2];
    return neon([]);
  }
  if (/^\s*SELECT/i.test(text) && /FROM opd_gov_signal\b/i.test(text) && !/opd_gov_signal_event/.test(text)) {
    if (/WHERE signal_id=\$1/.test(text)) return neon(signals.filter((s) => s.signal_id === params[0]));
    if (/WHERE reference=\$1/.test(text)) return neon(signals.filter((s) => s.reference === params[0]));
    if (/doctor_uid=\$1/.test(text)) return neon(signals.filter((s) => s.doctor_uid === params[0]));
    return neon(signals);
  }
  // doctor-response idempotency table
  if (/^\s*SELECT/i.test(text) && /FROM opd_doctor_response_request\b/i.test(text)) return neon(responseRequest ? [responseRequest] : []);
  if (/^\s*INSERT INTO opd_doctor_response_request\b/i.test(text)) {
    responseRequest = { client_request_id: params[2], verb: params[3], comment: params[4] };
    return neon([responseRequest]);
  }
  // reactions
  if (/FROM cognition_reactions/i.test(text)) return neon([]);
  if (/^\s*INSERT INTO cognition_reactions\b/i.test(text)) {
    return neon([{
      id: 'r1', created_at: '2026-09-24T00:00:00.000Z', signal_id: params[1], reference: params[2], clinical_state_ref: params[3],
      cdmss_doctor_uid: params[4], physician_id: params[5], reaction: params[6], provenance: 'CLINICIAN_REPORTED_BELIEF',
      after_cdmss: 'true', surface: 'portal_findings', schema_version: 'reaction/0.1',
    }]);
  }
  // audit stores
  if (/ipd_discharge_audits/.test(text)) {
    return neon([{ id: DS_AUDIT, ip_uid: 'IP-0111', speciality: 'Obstetrics', note_date: '2026-09-19', findings: JSON.stringify([DS_F]) }]);
  }
  if (/ot_note_audits/.test(text)) {
    return neon([{ id: OT_AUDIT, doctor_uid: DOCTOR, map_status: 'mapped', note_day: '2026-09-20', findings: JSON.stringify([OT_F]) }]);
  }
  if (/opd_note_audits/.test(text) && /findings/.test(text) && !/DISTINCT ON/.test(text)) {
    return neon([{ id: OPD_AUDIT, note_date: '2026-09-20', findings: JSON.stringify([OPD_F]), sources: '[]' }]);
  }
  return neon([]);
}) as typeof fetch;

const H = { 'content-type': 'application/json', 'x-api-key': 'test-gov-key' };
async function post(route: string, body: Record<string, unknown>) {
  const { NextRequest } = await import('next/server');
  const mod = await import(`../../app/api/governance/${route}/route.ts`);
  const res = await mod.POST(new NextRequest(`https://cat.test/api/governance/${route}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const reads = (re: RegExp) => issued.filter((q) => re.test(q.text));

// ── pure guard helpers ────────────────────────────────────────────────────────
test('signalActionTransition: closed is terminal, ruled may only close, the rest are open', () => {
  for (const action of ['acknowledged_by_governance', 'privilege_action', 'dismissed', 'closed'] as const) {
    assert.equal(signalActionTransition('closed', action).ok, false, `closed + ${action}`);
    for (const status of ['routed', 'responded', 'escalated']) assert.equal(signalActionTransition(status, action).ok, true, `${status} + ${action}`);
  }
  assert.equal(signalActionTransition('ruled', 'closed').ok, true);
  assert.equal(signalActionTransition('ruled', 'dismissed').ok, true);
  assert.equal(signalActionTransition('ruled', 'acknowledged_by_governance').ok, false);
  // a privilege review after an acknowledgement is a legal escalation
  assert.equal(signalActionTransition('ruled', 'privilege_action').ok, true);
});

test('isSignalActionReplay needs the same action AND the same non-empty gov_intervention_ref', () => {
  const ruling = { action: 'closed', gov_intervention_ref: 'EPI-1' };
  assert.equal(isSignalActionReplay(ruling, { action: 'closed', gov_intervention_ref: 'EPI-1' }), true);
  assert.equal(isSignalActionReplay(ruling, { action: 'dismissed', gov_intervention_ref: 'EPI-1' }), false);
  assert.equal(isSignalActionReplay(ruling, { action: 'closed', gov_intervention_ref: 'EPI-2' }), false);
  assert.equal(isSignalActionReplay(ruling, { action: 'closed', gov_intervention_ref: null }), false);
  assert.equal(isSignalActionReplay({ action: 'closed', gov_intervention_ref: null }, { action: 'closed', gov_intervention_ref: null }), false);
  assert.equal(isSignalActionReplay(null, { action: 'closed', gov_intervention_ref: 'EPI-1' }), false);
});

test('calibrationTarget: only OPD threads have a calibration store', () => {
  assert.deepEqual(calibrationTarget('opd'), { ok: true, table: 'opd_audit_feedback' });
  assert.deepEqual(calibrationTarget(undefined), { ok: true, table: 'opd_audit_feedback' });
  for (const cls of ['discharge_summary', 'ot']) {
    const t = calibrationTarget(cls);
    assert.equal(t.ok, false);
    assert.match(t.ok ? '' : t.reason, new RegExp(cls));
  }
});

// ── audit-signal ──────────────────────────────────────────────────────────────
async function getAuditSignal(reference: string) {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/governance/audit-signal/[reference]/route.ts');
  const res = await GET(
    new NextRequest(`https://cat.test/api/governance/audit-signal/${reference}`, { headers: H }),
    { params: Promise.resolve({ reference }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

test('audit-signal: a discharge thread gets discharge instances, an OT thread OT instances, never OPD text', async () => {
  reset();
  const ds = await getAuditSignal('EHRC-AUD-2026-0111');
  assert.equal(ds.status, 200);
  assert.deepEqual(ds.json.instances.map((i: any) => i.audit_id), [DS_AUDIT]);
  assert.equal(ds.json.signal.instances, 1);
  assert.equal(ds.json.signal.representative.audit_id, DS_AUDIT);
  assert.equal(reads(/opd_note_audits/).length, 0);

  reset();
  const ot = await getAuditSignal('EHRC-AUD-2026-0901');
  assert.deepEqual(ot.json.instances.map((i: any) => i.audit_id), [OT_AUDIT]);
  assert.equal(reads(/opd_note_audits/).length, 0);

  reset();
  const opd = await getAuditSignal('EHRC-AUD-2026-0030');
  assert.deepEqual(opd.json.instances.map((i: any) => i.audit_id), [OPD_AUDIT]);
  assert.equal(reads(/ipd_discharge_audits|ot_note_audits/).length, 0);
});

test('audit-signal stays a governance payload: no doctor enrichment leaks into it', async () => {
  reset();
  const ds = await getAuditSignal('EHRC-AUD-2026-0111');
  const inst = ds.json.instances[0];
  assert.ok(!('patient' in inst) && !('evidence_excerpt' in inst));
  assert.ok('ruling' in ds.json.signal && 'importance' in ds.json.signal && Array.isArray(ds.json.events));
  assert.equal(reads(/report->'sources'/).length, 0);
});

// ── signal-action: class-aware resolver ───────────────────────────────────────
test('signal-action on a discharge thread returns the discharge representative', async () => {
  reset();
  const res = await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'acknowledged_by_governance', gov_intervention_ref: 'EPI-1' });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ruled');
  assert.equal(res.json.replayed, false);
  assert.equal(res.json.signal.representative.audit_id, DS_AUDIT);
  assert.equal(reads(/opd_note_audits/).length, 0);
});

// ── signal-action: guard + idempotency ────────────────────────────────────────
test('signal-action: the same action + gov_intervention_ref twice is one write and two 200s', async () => {
  reset();
  const body = { reference: 'EHRC-AUD-2026-0111', action: 'privilege_action', gov_intervention_ref: 'EPI-7', note: 'n', actor: 'gov:1' };
  const first = await post('signal-action', body);
  assert.equal(first.status, 200);
  assert.equal(first.json.replayed, false);
  assert.equal(writes().length, 2, 'one conditional update + one ruled event');
  issued.length = 0;
  const second = await post('signal-action', body);
  assert.equal(second.status, 200);
  assert.equal(second.json.replayed, true);
  assert.equal(second.json.status, 'ruled');
  assert.deepEqual(writes(), [], 'the replay writes nothing');
});

test('signal-action: a second acknowledgement on a ruled thread is a 409 and writes nothing', async () => {
  reset();
  await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'acknowledged_by_governance', gov_intervention_ref: 'EPI-1' });
  issued.length = 0;
  const res = await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'acknowledged_by_governance', gov_intervention_ref: 'EPI-2' });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /already ruled/);
  assert.deepEqual(writes(), []);
  assert.equal(sig(SIG_DS).status, 'ruled');
  // closing a ruled thread is legal
  const closed = await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'closed', gov_intervention_ref: 'EPI-3' });
  assert.equal(closed.status, 200);
  assert.equal(closed.json.status, 'closed');
});

test('signal-action: anything on a closed thread is a 409 and writes nothing', async () => {
  reset();
  sig(SIG_OT).status = 'closed';
  sig(SIG_OT).ruling = JSON.stringify({ action: 'dismissed', gov_intervention_ref: 'EPI-9' });
  for (const action of ['acknowledged_by_governance', 'privilege_action', 'dismissed', 'closed']) {
    issued.length = 0;
    // a different intervention ref, so it is not a replay of the stored ruling
    const res = await post('signal-action', { reference: 'EHRC-AUD-2026-0901', action, gov_intervention_ref: `EPI-NEW-${action}` });
    assert.equal(res.status, 409, action);
    assert.match(res.json.error, /closed/);
    assert.deepEqual(writes(), [], action);
  }
  // but the same dismissal delivered again is a 200 no-op, even though the thread is closed
  issued.length = 0;
  const replay = await post('signal-action', { reference: 'EHRC-AUD-2026-0901', action: 'dismissed', gov_intervention_ref: 'EPI-9' });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.deepEqual(writes(), []);
});

test('signal-action: a call with no gov_intervention_ref has nothing to key a replay on', async () => {
  reset();
  sig(SIG_OPD).status = 'closed';
  sig(SIG_OPD).ruling = JSON.stringify({ action: 'closed', gov_intervention_ref: null });
  const res = await post('signal-action', { reference: 'EHRC-AUD-2026-0030', action: 'closed' });
  assert.equal(res.status, 409);
});

test('signal-action: losing a race to another action is a 409, not a silent overwrite', async () => {
  reset();
  failNextSignalUpdate = true;
  const res = await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'closed', gov_intervention_ref: 'EPI-5' });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /changed/);
  assert.ok(!writes().some((q) => /opd_gov_signal_event/.test(q.text)), 'no event is appended for a write that did not happen');
});

test('signal-action: bad action and unknown thread keep their old answers', async () => {
  reset();
  assert.equal((await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'nope' })).status, 400);
  assert.equal((await post('signal-action', { reference: 'EHRC-AUD-2026-9999', action: 'closed' })).status, 404);
});

// ── doctor-response ───────────────────────────────────────────────────────────
test('doctor-response disagree on a discharge thread writes nothing to opd_audit_feedback and logs why', async () => {
  reset();
  const logged: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const res = await post('doctor-response', {
      reference: 'EHRC-AUD-2026-0111', verb: 'disagree', comment: 'Course was 3 days.', client_request_id: 'req-ds-1',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'escalated');
    // a discharge thread is not resolved inside the doctor's POST (that needs Metabase)
    assert.equal(res.json.signal.representative, null);
  } finally {
    console.warn = realWarn;
  }
  assert.ok(!issued.some((q) => /opd_audit_feedback/.test(q.text)), 'no OPD calibration row for a discharge audit id');
  assert.equal(reads(/opd_note_audits/).length, 0);
  const line = logged.find((l) => l.includes('doctor_response_calibration_skipped'));
  assert.ok(line, 'the skip is logged');
  const entry = JSON.parse(line!);
  assert.equal(entry.note_class, 'discharge_summary');
  assert.equal(entry.reference, 'EHRC-AUD-2026-0111');
  assert.match(entry.reason, /no calibration store/);
});

test('doctor-response disagree on an OT thread is skipped the same way', async () => {
  reset();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const res = await post('doctor-response', { reference: 'EHRC-AUD-2026-0901', verb: 'disagree', comment: 'Note is complete.', client_request_id: 'req-ot-1' });
    assert.equal(res.status, 200);
  } finally {
    console.warn = realWarn;
  }
  assert.ok(!issued.some((q) => /opd_audit_feedback/.test(q.text)));
});

test('doctor-response disagree on an OPD thread still files the calibration row with the OPD audit id', async () => {
  reset();
  const res = await post('doctor-response', { reference: 'EHRC-AUD-2026-0030', verb: 'disagree', comment: 'Viral, but cultures were pending.', client_request_id: 'req-opd-1' });
  assert.equal(res.status, 200);
  const insert = issued.find((q) => /^\s*INSERT INTO opd_audit_feedback/i.test(q.text));
  assert.ok(insert, 'OPD calibration write is unchanged');
  assert.equal(insert!.params[0], OPD_AUDIT);
});

// ── signal-reaction ───────────────────────────────────────────────────────────
test('signal-reaction on an OT thread records the OT audit as the clinical state ref', async () => {
  reset();
  const res = await post('signal-reaction', { signal_id: SIG_OT, physician_id: 'phy_1', cdmss_doctor_uid: DOCTOR, reaction: 'already_knew' });
  assert.equal(res.status, 200);
  const insert = issued.find((q) => /^\s*INSERT INTO cognition_reactions/i.test(q.text));
  assert.ok(insert);
  assert.equal(insert!.params[3], OT_AUDIT);
  assert.equal(reads(/opd_note_audits/).length, 0);
});

// ── roster-audits ─────────────────────────────────────────────────────────────
test('roster-audits per doctor resolves each thread against its own class', async () => {
  reset();
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/governance/roster-audits/route.ts');
  const res = await GET(new NextRequest(`https://cat.test/api/governance/roster-audits?doctor_uid=${encodeURIComponent(DOCTOR)}`, { headers: H }));
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, any>;
  const byRef = new Map<string, any>(json.doctors[0].signals.map((s: any) => [s.reference, s]));
  assert.equal(byRef.get('EHRC-AUD-2026-0111').representative.audit_id, DS_AUDIT);
  assert.equal(byRef.get('EHRC-AUD-2026-0901').representative.audit_id, OT_AUDIT);
  assert.equal(byRef.get('EHRC-AUD-2026-0030').representative.audit_id, OPD_AUDIT);
  // governance still sees the ruling and importance
  assert.ok('ruling' in byRef.get('EHRC-AUD-2026-0111') && 'importance' in byRef.get('EHRC-AUD-2026-0111'));
});

// ── structural: no route calls the OPD-only resolver for a thread ─────────────
test('the five routes use the class-aware resolver, not resolveInstances', () => {
  for (const file of [
    'app/api/governance/audit-signal/[reference]/route.ts',
    'app/api/governance/signal-action/route.ts',
    'app/api/governance/doctor-response/route.ts',
    'app/api/governance/signal-reaction/route.ts',
    'app/api/governance/roster-audits/route.ts',
    'app/api/governance/doctor-audits/route.ts',
  ]) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /resolveInstancesForSignal|resolveInstancesLocal/, file);
    assert.doesNotMatch(src, /\bresolveInstances\b/, file);
  }
});

// ── Refuter fixes: signal-action history, privilege after acknowledgement ─────
test('signal-action: a privilege review after an acknowledgement is legal (ruled -> ruled)', async () => {
  reset();
  const ack = await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'acknowledged_by_governance', gov_intervention_ref: 'EPI-1' });
  assert.equal(ack.status, 200);
  assert.equal(ack.json.status, 'ruled');
  const priv = await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'privilege_action', gov_intervention_ref: 'EPI-2' });
  assert.equal(priv.status, 200);
  assert.equal(priv.json.replayed, false);
  assert.equal(priv.json.status, 'ruled');
  assert.equal(JSON.parse(String(sig(SIG_DS).ruling)).action, 'privilege_action');
  assert.equal(events.filter((e) => e.event === 'ruled').length, 2);
});

test('signal-action: a delayed retry of an EARLIER (ref, action) pair is a 200 no-op, not a 409', async () => {
  reset();
  const ackBody = { reference: 'EHRC-AUD-2026-0111', action: 'acknowledged_by_governance', gov_intervention_ref: 'EPI-A' };
  assert.equal((await post('signal-action', ackBody)).status, 200);
  const closeBody = { reference: 'EHRC-AUD-2026-0111', action: 'closed', gov_intervention_ref: 'EPI-B' };
  assert.equal((await post('signal-action', closeBody)).status, 200);
  assert.equal(sig(SIG_DS).status, 'closed');
  // the stored ruling is now close/EPI-B; ack/EPI-A survives only in the event log
  issued.length = 0;
  const retry = await post('signal-action', ackBody);
  assert.equal(retry.status, 200);
  assert.equal(retry.json.replayed, true);
  assert.deepEqual(writes(), [], 'the retry writes nothing');
  // a pair that was never applied is still refused on the closed thread
  const fresh = await post('signal-action', { ...ackBody, gov_intervention_ref: 'EPI-NEVER' });
  assert.equal(fresh.status, 409);
  // same ref, different action: not the same pair
  const otherAction = await post('signal-action', { ...ackBody, action: 'privilege_action' });
  assert.equal(otherAction.status, 409);
});

test('signal-action: without a gov_intervention_ref the event log is not consulted', async () => {
  reset();
  await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'closed', gov_intervention_ref: 'EPI-1' });
  issued.length = 0;
  const res = await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'closed' });
  assert.equal(res.status, 409);
  assert.equal(reads(/opd_gov_signal_event/).length, 0);
});

test('signal-action: a pair already in the event log short-circuits before the conditional write', async () => {
  reset();
  events.push({ signal_id: SIG_DS, event: 'ruled', actor: 'gov:1', payload: { action: 'closed', gov_intervention_ref: 'EPI-DONE' } });
  const res = await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'closed', gov_intervention_ref: 'EPI-DONE' });
  assert.equal(res.status, 200);
  assert.equal(res.json.replayed, true);
  assert.deepEqual(writes(), []);
});

test('signal-action: a lost race is a 200 when the winner applied this same pair, a 409 when it applied another', async () => {
  reset();
  // The same pair is delivered twice at once: our read saw nothing, the other delivery wins the write.
  failNextSignalUpdate = true;
  onLostRace = () => { events.push({ signal_id: SIG_DS, event: 'closed', actor: 'gov:1', payload: { action: 'closed', gov_intervention_ref: 'EPI-RACE' } }); };
  const same = await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'closed', gov_intervention_ref: 'EPI-RACE' });
  assert.equal(same.status, 200);
  assert.equal(same.json.replayed, true);

  reset();
  failNextSignalUpdate = true;
  onLostRace = () => { events.push({ signal_id: SIG_DS, event: 'closed', actor: 'gov:1', payload: { action: 'closed', gov_intervention_ref: 'EPI-OTHER' } }); };
  const other = await post('signal-action', { reference: 'EHRC-AUD-2026-0111', action: 'closed', gov_intervention_ref: 'EPI-MINE' });
  assert.equal(other.status, 409);
});

// ── Refuter fixes: doctor-interactive POSTs never leave Neon ──────────────────
test('doctor-response on a discharge thread makes no Metabase call and reads no discharge audit', async () => {
  reset();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const res = await post('doctor-response', {
      reference: 'EHRC-AUD-2026-0111', verb: 'agree', comment: 'Agreed.', client_request_id: 'req-nometa-1',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'responded');
  } finally {
    console.warn = realWarn;
  }
  assert.equal(metabaseCalls, 0, 'no Metabase query inside the doctor POST');
  assert.equal(reads(/ipd_discharge_audits/).length, 0);
});

test('doctor-response on an OPD thread still resolves its representative (Neon only)', async () => {
  reset();
  const res = await post('doctor-response', {
    reference: 'EHRC-AUD-2026-0030', verb: 'agree', comment: 'Agreed.', client_request_id: 'req-opd-1',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.signal.representative.audit_id, OPD_AUDIT);
  assert.equal(metabaseCalls, 0);
});

test('signal-reaction on a discharge thread makes no Metabase call and stores a null state ref', async () => {
  reset();
  const res = await post('signal-reaction', {
    signal_id: SIG_DS, physician_id: 'PHY-1', cdmss_doctor_uid: DOCTOR, reaction: 'already_knew',
  });
  assert.equal(res.status, 200);
  assert.equal(metabaseCalls, 0);
  assert.equal(reads(/ipd_discharge_audits/).length, 0);
  const insert = issued.find((q) => /^\s*INSERT INTO cognition_reactions\b/i.test(q.text));
  assert.ok(insert);
  assert.equal(insert!.params[3], null, 'clinical_state_ref is null: not resolved, which is not the same as none');
});

test('signal-reaction on an OT thread still records the OT audit (Neon only)', async () => {
  reset();
  const res = await post('signal-reaction', {
    signal_id: SIG_OT, physician_id: 'PHY-1', cdmss_doctor_uid: DOCTOR, reaction: 'surprised',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.reaction.signal_id, SIG_OT);
  assert.equal(metabaseCalls, 0);
});

// ── Refuter fixes: roster-audits resolves threads concurrently, bounded ───────
test('mapWithConcurrency: keeps input order, never exceeds the limit, handles empty and short lists', async () => {
  const { mapWithConcurrency } = await import('../opd-gov-read.ts');
  let live = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 5, async (n) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5 + (n % 3)));
    live--;
    return n * 2;
  });
  assert.deepEqual(out, items.map((n) => n * 2));
  assert.equal(peak, 5);
  assert.deepEqual(await mapWithConcurrency([], 5, async (n: number) => n), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 5, async (n) => n + 1), [2, 3]);
});

test('mapWithConcurrency: a failing item rejects the whole read rather than returning a hole', async () => {
  const { mapWithConcurrency } = await import('../opd-gov-read.ts');
  await assert.rejects(mapWithConcurrency([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; }), /boom/);
});

test('roster-audits per doctor: several threads of one doctor all resolve, in order, with a bounded fan-out', async () => {
  reset();
  // seven OPD threads + the OT and discharge ones, all for DOCTOR
  for (let i = 0; i < 7; i++) {
    signals.push(signalRow({
      signal_id: `20000000-0000-4000-8000-00000000000${i}`, reference: `EHRC-AUD-2026-05${i}0`,
      signal_type: OPD_SIGNAL, note_class: 'opd', created_at: `2026-09-${10 + i}T10:00:00.000Z`,
    }));
  }
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/governance/roster-audits/route.ts');
  const res = await GET(new NextRequest(`https://cat.test/api/governance/roster-audits?doctor_uid=${encodeURIComponent(DOCTOR)}`, { headers: H }));
  assert.equal(res.status, 200);
  const body = await res.json() as { doctors: { signals: { reference: string; representative: { audit_id: string } | null }[] }[] };
  const refs = body.doctors[0].signals.map((s) => s.reference);
  assert.equal(refs.length, 10);
  assert.deepEqual(refs, signals.map((s) => String(s.reference)), 'order matches the thread list');
  const byRef = new Map(body.doctors[0].signals.map((s) => [s.reference, s]));
  assert.equal(byRef.get('EHRC-AUD-2026-0111')?.representative?.audit_id, DS_AUDIT);
  assert.equal(byRef.get('EHRC-AUD-2026-0901')?.representative?.audit_id, OT_AUDIT);
  assert.equal(byRef.get('EHRC-AUD-2026-0500')?.representative?.audit_id, OPD_AUDIT);
});

// ── Refuter F9: doctor POST responses carry the allowlisted doctor signal only ─
const DOCTOR_SIGNAL_KEYS = [
  'doctor_uid', 'instances', 'label', 'note_class', 'overdue', 'reference', 'representative', 'response',
  'response_required', 'routed_at', 'signal_id', 'signal_type', 'sla_due_at', 'status', 'window',
];
const GOV_ONLY = ['importance', 'ruling', 'triage', 'events', 'actor', 'source_triage_ref', 'confidence', 'policy_version'];

test('doctor-response returns the doctor signal object: no importance, ruling or other governance keys', async () => {
  for (const [ref, cls] of [['EHRC-AUD-2026-0030', 'opd'], ['EHRC-AUD-2026-0901', 'ot'], ['EHRC-AUD-2026-0111', 'discharge']] as const) {
    reset();
    // plant governance-only content on the thread
    for (const s of signals) s.ruling = JSON.stringify({ action: 'privilege_action', note: 'GOV-ONLY-NOTE', actor: 'gov:42', gov_intervention_ref: 'EPI-1' });
    const res = await post('doctor-response', { reference: ref, verb: 'agree', comment: 'Agreed.', client_request_id: `req-f9-${cls}` });
    assert.equal(res.status, 200, ref);
    assert.deepEqual(Object.keys(res.json.signal).sort(), DOCTOR_SIGNAL_KEYS, ref);
    assert.equal(res.json.signal.note_class, cls);
    const blob = JSON.stringify(res.json);
    for (const k of GOV_ONLY) assert.ok(!(k in res.json.signal) && !blob.includes(`"${k}"`), `${ref}: ${k}`);
    assert.ok(!blob.includes('GOV-ONLY-NOTE') && !blob.includes('gov:42') && !blob.includes('EPI-1'), ref);
    assert.equal(res.json.signal.response.verb, 'agree');
    assert.ok(!('client_request_id' in res.json.signal.response));
    if (cls === 'discharge') assert.equal(res.json.signal.representative, null);
    else assert.ok(!('finding_ref' in res.json.signal.representative));
  }
});

test('doctor-response replay and signal-reaction also return no governance keys', async () => {
  reset();
  const body = { reference: 'EHRC-AUD-2026-0030', verb: 'agree', comment: 'Agreed.', client_request_id: 'req-f9-replay' };
  await post('doctor-response', body);
  const replay = await post('doctor-response', body);
  assert.equal(replay.json.replayed, true);
  assert.deepEqual(Object.keys(replay.json.signal).sort(), DOCTOR_SIGNAL_KEYS);
  assert.ok(!('importance' in replay.json.signal) && !('ruling' in replay.json.signal));

  reset();
  const react = await post('signal-reaction', { signal_id: SIG_OPD, physician_id: 'PHY-1', cdmss_doctor_uid: DOCTOR, reaction: 'surprised' });
  assert.equal(react.status, 200);
  assert.deepEqual(Object.keys(react.json).sort(), ['ok', 'reaction', 'replay']);
  assert.deepEqual(Object.keys(react.json.reaction).sort(), ['after_cdmss', 'at', 'reference', 'signal_id', 'reaction'].sort());
  const blob = JSON.stringify(react.json);
  for (const k of GOV_ONLY) assert.ok(!blob.includes(`"${k}"`), k);
});
