/**
 * Document-audit export: the per-finding doctor fields, and the routed-only findings PDF.
 *
 *   node --test --import tsx lib/__tests__/document-audits-export-doctor-fields.test.ts
 *
 * A finding is `routed` only when a routed thread exists for ITS OWN signal_type (same class,
 * doctor and window). A sibling finding of another signal_type in the same audit is not routed, and
 * the doctor PDF must not print it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stampFindingIdentity, type OpdFinding } from '../opd-note-audit-core.ts';
import {
  buildDocumentAuditExport,
  routedFindingsOnly,
  type RoutedSignalRef,
} from '../triage/document-audits-export.ts';
import type { DischargeHopView } from '../triage/ds-lander.ts';
import { buildFindingsPdf, findingsPdfLines, type FindingsPdfInput } from '../triage/document-audits-pdf.ts';

process.env.GOV_API_KEY = 'test-gov-key';
process.env.DATABASE_URL = 'postgresql://test:test@db.invalid.test/neondb';
process.env.METABASE_URL = 'https://metabase.invalid.test';
process.env.METABASE_API_KEY = 'test-metabase-key';
delete process.env.TRIAGE_BOT_WRITE_CLASSES;

function raw(subject: string, extra: Partial<OpdFinding> = {}): OpdFinding {
  return {
    subject, verdict: 'low-value', confidence: 0.9, domain: 'appropriateness', rationale: `Why: ${subject}`,
    evidence: [], estimates: [], citation_ids: [], source: 'llm', ...extra,
  };
}
const ABX = raw('Post-operative Oral Antibiotic Course', {
  evidence: ['Course extended to 7 days after a clean procedure.'], citation_ids: [1],
});
const THIN = raw('Documentation completeness: OT note body is thin or empty', { verdict: 'context-dependent', source: 'deterministic' });
const ABX_TYPE = stampFindingIdentity([ABX])[0].signal_type as string;
const THIN_TYPE = stampFindingIdentity([THIN])[0].signal_type as string;
const ABX_REF = stampFindingIdentity([ABX])[0].finding_ref as string;

const DS_ID = 'cccccccc-cccc-4ccc-8ddd-eeeeeeeeeee3';
const OT_ID = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const OT_OTHER = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee7';

const HOP_OK: DischargeHopView = {
  byIpUid: { 'IP-1': { doctorUid: 'DOC-DS', reason: 'resolved' } },
  coverage: { unavailable: false },
};

function thread(partial: Partial<RoutedSignalRef>): RoutedSignalRef {
  return {
    reference: 'EHRC-AUD-2026-0001', note_class: 'discharge_summary', doctor_uid: 'DOC-DS', signal_type: ABX_TYPE,
    window_from: '2026-09-01', window_to: '2026-09-30', created_at: '2026-09-22T00:00:00.000Z', ...partial,
  };
}

const SOURCES = { [DS_ID]: [{ n: 1, book: 'StatPearls', chapter: 'Surgical prophylaxis', url: 'https://pubmed.test/ds1' }] };

function dischargeExport(signals: RoutedSignalRef[], extra: Record<string, unknown> = {}) {
  return buildDocumentAuditExport({
    from: '2026-09-01', to: '2026-09-30',
    otRows: [],
    dischargeRows: [{ id: DS_ID, ip_uid: 'IP-1', note_date: '2026-09-22', findings: [ABX, THIN] }],
    dischargeHop: HOP_OK,
    progress: { status: 'absent' },
    signals,
    otWriteMint: 'off',
    noteClass: 'discharge_summary',
    ...extra,
  });
}

// ── routed is per finding, per its own signal_type ────────────────────────────
test('routed: the routed type is true, the sibling in the same audit is false', () => {
  const body = dischargeExport([thread({})], { dischargeSources: SOURCES });
  assert.equal(body.audits.length, 1);
  const byType = new Map(body.audits[0].findings.map((f) => [f.signal_type, f]));
  assert.equal(byType.get(ABX_TYPE)?.routed, true);
  assert.equal(byType.get(ABX_TYPE)?.signal_reference, 'EHRC-AUD-2026-0001');
  assert.equal(byType.get(THIN_TYPE)?.routed, false);
  assert.equal(byType.get(THIN_TYPE)?.signal_reference, null);
  assert.deepEqual(body.audits[0].routed_refs, ['EHRC-AUD-2026-0001']);
});

test('routed: another doctor\'s thread, another class\'s thread and an out-of-window thread route nothing', () => {
  for (const wrong of [
    thread({ doctor_uid: 'DOC-OTHER' }),
    thread({ note_class: 'ot' }),
    thread({ window_from: '2026-08-01', window_to: '2026-08-31' }),
    thread({ signal_type: 'some_other_type' }),
  ]) {
    const body = dischargeExport([wrong]);
    assert.ok(body.audits[0].findings.every((f) => f.routed === false), JSON.stringify(wrong));
  }
});

test('routed: progress notes never route', () => {
  const body = buildDocumentAuditExport({
    from: '2026-09-01', to: '2026-09-30', otRows: [], dischargeRows: [], dischargeHop: HOP_OK,
    progress: { status: 'rows', table: 'progress_note_audits', rows: [{ id: 'p1', doctor_uid: 'DOC-DS', note_date: '2026-09-22', findings: [ABX] }] },
    signals: [thread({ note_class: 'progress' })], otWriteMint: 'off', noteClass: 'progress',
  });
  const f = body.audits[0].findings[0];
  assert.equal(f.routed, false);
  assert.equal(f.note_class, null);
  assert.deepEqual(f.patient, { name: null, age: null, sex: null, ip_number: null, uhid: null });
});

// ── the other new fields ──────────────────────────────────────────────────────
test('every finding carries note_class, note_date, evidence_excerpt, citations and patient', () => {
  const body = dischargeExport([thread({})], { dischargeSources: SOURCES });
  const abx = body.audits[0].findings.find((f) => f.signal_type === ABX_TYPE)!;
  assert.equal(abx.note_class, 'discharge');
  assert.equal(abx.note_date, '2026-09-22');
  assert.equal(abx.evidence_excerpt, 'Course extended to 7 days after a clean procedure.');
  assert.deepEqual(abx.citations, [{ title: 'StatPearls — Surgical prophylaxis', url: 'https://pubmed.test/ds1' }]);
  assert.deepEqual(abx.patient, { name: null, age: null, sex: null, ip_number: 'IP-1', uhid: null });
  const thin = body.audits[0].findings.find((f) => f.signal_type === THIN_TYPE)!;
  assert.equal(thin.evidence_excerpt, null);
  assert.deepEqual(thin.citations, []);
  // Existing governance join keys are untouched.
  assert.equal(abx.finding_ref, ABX_REF);
  assert.equal(abx.queue_item_ref, `discharge_summary|DOC-DS|${ABX_TYPE}`);
  assert.deepEqual(abx.citation_ids, [1]);
});

test('citations stay [] when the audit has no stored sources', () => {
  const body = dischargeExport([thread({})]);
  assert.deepEqual(body.audits[0].findings.find((f) => f.signal_type === ABX_TYPE)!.citations, []);
});

test('evidence excerpt is clipped to 600 characters', () => {
  const long = raw('Post-operative IV Antibiotic Course', { evidence: ['z'.repeat(1500)] });
  const body = buildDocumentAuditExport({
    from: '2026-09-01', to: '2026-09-30', otRows: [],
    dischargeRows: [{ id: DS_ID, ip_uid: 'IP-1', note_date: '2026-09-22', findings: [long] }],
    dischargeHop: HOP_OK, progress: { status: 'absent' }, signals: [], otWriteMint: 'off', noteClass: 'discharge_summary',
  });
  const ex = body.audits[0].findings[0].evidence_excerpt as string;
  assert.ok(ex.length <= 600 && ex.length > 500);
});

test('OT findings carry the UHID and no citations', () => {
  const body = buildDocumentAuditExport({
    from: '2026-09-01', to: '2026-09-30',
    otRows: [{ id: OT_ID, map_status: 'mapped', doctor_uid: 'DOC-OT', note_day: '2026-09-22', uhid: 'UHID-77', findings: [THIN] }],
    dischargeRows: [], dischargeHop: HOP_OK, progress: { status: 'absent' },
    signals: [thread({ note_class: 'ot', doctor_uid: 'DOC-OT', signal_type: THIN_TYPE, reference: 'EHRC-AUD-2026-0099' })],
    otWriteMint: 'off', noteClass: 'ot',
  });
  const f = body.audits[0].findings[0];
  assert.equal(f.routed, true);
  assert.equal(f.note_class, 'ot');
  assert.deepEqual(f.patient, { name: null, age: null, sex: null, ip_number: null, uhid: 'UHID-77' });
  assert.deepEqual(f.citations, []);
});

// ── the findings PDF, doctor layout ───────────────────────────────────────────
const PDF_INPUT: FindingsPdfInput = {
  audit_id: OT_ID, note_class: 'discharge_summary', doctor_uid: 'DOC-DS', note_date: '2026-09-22',
  patient: { ip_number: 'IP-1', uhid: null },
  findings: [
    { finding_ref: ABX_REF, signal_type: ABX_TYPE, subject: ABX.subject, verdict: 'low-value', rationale: 'Too long.', evidence_excerpt: 'Seven days.' },
    { finding_ref: 'sibling-ref', signal_type: THIN_TYPE, subject: THIN.subject, verdict: 'context-dependent', rationale: 'Thin.' },
  ],
};

test('routedFindingsOnly drops the sibling and marks the result routed_only', () => {
  const out = routedFindingsOnly(PDF_INPUT, [thread({})]);
  assert.equal(out.routed_only, true);
  assert.deepEqual(out.findings.map((f) => f.signal_type), [ABX_TYPE]);
  const none = routedFindingsOnly({ ...PDF_INPUT, doctor_uid: null }, [thread({})]);
  assert.deepEqual(none.findings, []);
  const noThreads = routedFindingsOnly(PDF_INPUT, []);
  assert.deepEqual(noThreads.findings, []);
});

test('doctor PDF text carries no internal id, code, triage or engine wording', () => {
  const lines = findingsPdfLines(routedFindingsOnly(PDF_INPUT, [thread({})])).map((l) => l.text).join('\n');
  assert.match(lines, /Discharge summary findings/);
  assert.match(lines, /Note date 2026-09-22 · IP IP-1/);
  assert.match(lines, /Post-operative Oral Antibiotic Course/);
  assert.match(lines, /Low value/);
  assert.match(lines, /Evidence: Seven days\./);
  assert.match(lines, /not a performance score/);
  assert.doesNotMatch(lines, /Thin\./, 'the sibling finding is not printed');
  for (const banned of [OT_ID, 'DOC-DS', ABX_REF, ABX_TYPE, 'antibiotic_stewardship', 'discharge_summary', 'EHRC', /triage/i, /policy/i, /jev/i, /engine/i, /CDMSS/, /RMO/, /fail-closed/, /audit /]) {
    if (banned instanceof RegExp) assert.doesNotMatch(lines, banned, String(banned));
    else assert.ok(!lines.includes(banned), String(banned));
  }
});

test('governance PDF layout is unchanged: audit id, doctor uid, finding ref and signal type still print', () => {
  const lines = findingsPdfLines(PDF_INPUT).map((l) => l.text).join('\n');
  assert.match(lines, new RegExp(`audit ${OT_ID}`));
  assert.match(lines, /doctor DOC-DS/);
  assert.match(lines, new RegExp(`low-value · ${ABX_TYPE} · ${ABX_REF}`));
  assert.match(lines, /Not an outcomes measure and not a clinician scorecard/);
});

test('both layouts render to a real PDF', async () => {
  for (const input of [PDF_INPUT, routedFindingsOnly(PDF_INPUT, [thread({})])]) {
    const bytes = await buildFindingsPdf(input);
    assert.equal(Buffer.from(bytes).subarray(0, 4).toString(), '%PDF');
  }
});

// ── routes (fetch stands in for Neon + Metabase) ──────────────────────────────
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

const otStored: Row[] = [
  { id: OT_ID, hospital_uid: 'HOSP-OT', note_day: '2026-09-22', note_date: '2026-09-22', doctor_uid: 'DOC-OT', map_status: 'mapped', uhid: 'UHID-77', findings: JSON.stringify([THIN, ABX]) },
  { id: OT_OTHER, hospital_uid: 'HOSP-OT', note_day: '2026-09-21', note_date: '2026-09-21', doctor_uid: 'DOC-OT', map_status: 'mapped', uhid: 'UHID-88', findings: JSON.stringify([ABX]) },
];
const dsStored: Row[] = [{ id: DS_ID, ip_uid: 'IP-1', note_date: '2026-09-22', findings: JSON.stringify([ABX, THIN]) }];
const signalStored: Row[] = [
  { reference: 'EHRC-AUD-2026-0099', doctor_uid: 'DOC-OT', signal_type: THIN_TYPE, note_class: 'ot', window_from: '2026-09-01', window_to: '2026-09-30', created_at: '2026-09-22T00:00:00.000Z' },
  { reference: 'EHRC-AUD-2026-0001', doctor_uid: 'DOC-DS', signal_type: ABX_TYPE, note_class: 'discharge_summary', window_from: '2026-09-01', window_to: '2026-09-30', created_at: '2026-09-22T00:00:00.000Z' },
];

globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
  const sent = JSON.parse(String(init.body || '{}')) as { query?: string; params?: unknown[]; native?: { query?: string } };
  if (sent.native?.query) {
    const q = String(sent.native.query);
    if (q.includes('karexpert_metadata__practitioner_id')) return metabase(['pid', 'n_uids', 'uid'], [['PX-1', 1, 'DOC-DS']]);
    if (q.includes('kx_ip_admissions')) return metabase(['encounter_id', 'current_treating_doctor_id'], [['IP-1', 'PX-1']]);
    return metabase([], []);
  }
  const text = String(sent.query || '');
  const params = sent.params || [];
  issued.push({ text, params });
  if (/information_schema\.columns/.test(text)) return neon([]);
  if (/report->'sources'/.test(text)) {
    return neon([{ id: DS_ID, sources: JSON.stringify(SOURCES[DS_ID]) }]);
  }
  if (/opd_gov_signal/.test(text) && /reference = \$1/.test(text)) return neon(signalStored.filter((s) => s.reference === params[0]));
  if (/opd_gov_signal/.test(text)) return neon(signalStored);
  if (/ot_note_audits/.test(text) && /WHERE id =/.test(text)) return neon(otStored.filter((r) => r.id === params[0]));
  if (/ot_note_audits/.test(text) && /map_status = 'mapped'/.test(text) && /doctor_uid = \$1/.test(text)) {
    return neon(otStored.filter((r) => r.map_status === 'mapped' && r.doctor_uid === params[0]));
  }
  if (/ot_note_audits/.test(text)) return neon(otStored);
  if (/ipd_discharge_audits/.test(text) && /WHERE id =/.test(text)) return neon(dsStored.filter((r) => r.id === params[0]));
  if (/ipd_discharge_audits/.test(text)) return neon(dsStored);
  return neon([]);
}) as typeof fetch;

async function getExport(query: string) {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/governance/document-audits-export/route.ts');
  const res = await GET(new NextRequest(`https://cat.test/api/governance/document-audits-export${query}`, { headers: { 'x-api-key': 'test-gov-key' } }));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function getPdf(id: string, query = '') {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../../app/api/governance/audits/[id]/pdf/route.ts');
  const res = await GET(
    new NextRequest(`https://cat.test/api/governance/audits/${id}/pdf${query}`, { headers: { 'x-api-key': 'test-gov-key' } }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition') || '', buf: Buffer.from(await res.arrayBuffer()) };
}

test('export route: discharge citations come from the stored report, read only for routed audits', async () => {
  issued.length = 0;
  const res = await getExport('?note_class=discharge_summary&from=2026-09-01&to=2026-09-30');
  assert.equal(res.status, 200);
  const abx = res.json.audits[0].findings.find((f: any) => f.signal_type === ABX_TYPE);
  assert.equal(abx.routed, true);
  assert.deepEqual(abx.citations, [{ title: 'StatPearls — Surgical prophylaxis', url: 'https://pubmed.test/ds1' }]);
  assert.deepEqual(abx.patient, { name: null, age: null, sex: null, ip_number: 'IP-1', uhid: null });
  const sourceReads = issued.filter((q) => /report->'sources'/.test(q.text));
  assert.equal(sourceReads.length, 1);
  assert.ok(JSON.stringify(sourceReads[0].params).includes(DS_ID));
});

test('export route: no routed discharge audit means the report column is never read', async () => {
  const saved = signalStored.splice(0, signalStored.length);
  try {
    issued.length = 0;
    const res = await getExport('?note_class=discharge_summary&from=2026-09-01&to=2026-09-30');
    assert.equal(res.status, 200);
    assert.ok(res.json.audits[0].findings.every((f: any) => f.routed === false && f.citations.length === 0));
    assert.ok(!issued.some((q) => /report->'sources'/.test(q.text)));
  } finally {
    signalStored.push(...saved);
  }
});

test('export route: OT UHID reaches the finding', async () => {
  const res = await getExport('?note_class=ot&from=2026-09-01&to=2026-09-30');
  const audit = res.json.audits.find((a: any) => a.audit_id === OT_ID);
  assert.ok(audit.findings.every((f: any) => f.patient.uhid === 'UHID-77' && f.note_class === 'ot'));
  const thin = audit.findings.find((f: any) => f.signal_type === THIN_TYPE);
  const abx = audit.findings.find((f: any) => f.signal_type === ABX_TYPE);
  assert.equal(thin.routed, true);
  assert.equal(abx.routed, false, 'a sibling of another signal_type in a routed audit is not routed');
});

test('routed signals exclude a thread the care manager withdrew (closed with no ruling)', () => {
  const src = readFileSync('lib/triage/document-audits-export-read.ts', 'utf8');
  assert.match(src, /AND NOT \(status = 'closed' AND ruling IS NULL\)/);
  assert.ok(issued.some((q) => /opd_gov_signal/.test(q.text) && /status = 'closed' AND ruling IS NULL/.test(q.text)));
});

test('pdf route routed_only=1: prints only the routed finding and names the file from the date, not the audit id', async () => {
  const res = await getPdf(OT_ID, '?routed_only=1');
  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/pdf');
  assert.equal(res.buf.subarray(0, 4).toString(), '%PDF');
  assert.equal(res.disposition, 'attachment; filename="findings-2026-09-22.pdf"');
  assert.ok(!res.disposition.includes(OT_ID));

  const { loadFindingsPdf } = await import('../triage/document-audits-export-read.ts');
  const loaded = await loadFindingsPdf(OT_ID, { routedOnly: true });
  assert.ok(loaded && loaded !== 'bad-id');
  assert.equal(loaded.routed_only, true);
  assert.deepEqual(loaded.findings.map((f) => f.signal_type), [THIN_TYPE]);
  assert.equal(loaded.patient?.uhid, 'UHID-77');
});

test('pdf route routed_only=1: an audit with no routed finding answers 404, never a full document', async () => {
  const res = await getPdf(OT_OTHER, '?routed_only=1');
  assert.equal(res.status, 404);
  const body = JSON.parse(res.buf.toString());
  assert.equal(body.error, 'no routed findings for this note');
  // The governance copy of the same audit is unchanged.
  const staff = await getPdf(OT_OTHER);
  assert.equal(staff.status, 200);
  assert.match(staff.disposition, new RegExp(OT_OTHER));
});

test('pdf route by EHRC ref with routed_only=1 keeps only the thread\'s own signal_type', async () => {
  const { loadFindingsPdf } = await import('../triage/document-audits-export-read.ts');
  const strict = await loadFindingsPdf('EHRC-AUD-2026-0099', { routedOnly: true });
  assert.ok(strict && strict !== 'bad-id');
  assert.deepEqual(strict.findings.map((f) => f.signal_type), [THIN_TYPE]);
  const staff = await loadFindingsPdf('EHRC-AUD-2026-0099');
  assert.ok(staff && staff !== 'bad-id');
  assert.equal(staff.findings.length, 2, 'the governance copy still prints every finding');
});
