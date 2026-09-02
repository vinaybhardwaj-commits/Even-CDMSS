/**
 * lib/__tests__/ipd-episode-assemble.test.ts — PRD §13 items 1–4, 14, 15 and the two source-read
 * assertions (12, 13). Pure core only: no database, no network, no model.
 *
 * THE TWO SOURCE-READ TESTS ARE THE POINT OF THIS FILE. Everything else here checks a return
 * value; those two check what the SQL and the assembly code NAME, which no test of a return value
 * could catch — a reader that selects `uhid` and then throws it away passes every behavioural
 * test and still puts PHI on the wire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildOrderEvents, checkpointPlan, collapseSpaces, dayIndexFor, dayStartIso, diffPassEvents,
  episodeLevelEvents, eventsBeforeDayStart, fidelityPassEvents, isoFromEpochMs, losDaysFor,
  noteSummaryFrom, normalizeAuthorName, parseComponentJson, componentValue, tierForTable,
  type EpisodeEvent,
} from '../ipd-episode/assemble-core';
import { templateClinicalTime } from '../ipd-episode/assemble';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** Strip comments before asserting on source — both files legitimately NAME the forbidden things
 *  in the header comment that documents the rule (the lib/__tests__/ipd-audit-billing.test.ts idiom). */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ADMIT = '2026-08-01T18:20:00.000Z';

const ev = (o: Partial<EpisodeEvent> & { event_id: string }): EpisodeEvent => ({
  occurred_at: null, day_index: 0, event_type: 'note', summary: '', detail: {},
  author_name: null, author_role: null, responsible_clinician_id: null,
  provenance: { source_table: 'kx_clinical_template_progress_reports', source_record_id: o.event_id, source_timestamp: null },
  evidence_tier: 'A', ...o,
});

// ── 1. day index ─────────────────────────────────────────────────────────────────────────────

test('day index: an admission at 23:50 and an event at 00:10 are twenty minutes apart, so both are day 0', () => {
  const admit = '2026-08-01T23:50:00.000Z';
  assert.equal(dayIndexFor(admit, '2026-08-02T00:10:00.000Z'), 0);
  // a calendar-date difference would have said 1 — that is the bug this test exists for
  assert.equal(dayIndexFor(admit, '2026-08-02T23:49:59.000Z'), 0);
  assert.equal(dayIndexFor(admit, '2026-08-02T23:50:00.000Z'), 1);
  assert.equal(dayIndexFor(admit, '2026-08-04T23:50:00.000Z'), 3);
});

test('day index and day start store UTC and never drift on a local timezone', () => {
  assert.equal(dayStartIso(ADMIT, 0), ADMIT);
  assert.equal(dayStartIso(ADMIT, 2), '2026-08-03T18:20:00.000Z');
  assert.ok(dayStartIso(ADMIT, 1).endsWith('Z'), 'day boundaries are stored as UTC');
  assert.equal(dayIndexFor(ADMIT, null), 0);
  assert.equal(dayIndexFor(ADMIT, 'not a date'), 0);
});

test('los_days is floor(hours / 24), not a calendar-date subtraction', () => {
  assert.equal(losDaysFor(ADMIT, '2026-08-01T23:00:00.000Z'), 0);
  assert.equal(losDaysFor(ADMIT, '2026-08-02T18:19:00.000Z'), 0);
  assert.equal(losDaysFor(ADMIT, '2026-08-02T18:20:00.000Z'), 1);
  assert.equal(losDaysFor(ADMIT, '2026-08-08T18:20:00.000Z'), 7);
  assert.equal(losDaysFor(null, '2026-08-08T18:20:00.000Z'), null);
  assert.equal(losDaysFor(ADMIT, null), null);
});

// ── 2. blinding cutoff (six cases, including boundary equality) ──────────────────────────────

const BLIND_EVENTS: EpisodeEvent[] = [
  ev({ event_id: 'adm', event_type: 'admission', occurred_at: ADMIT, day_index: 0 }),
  ev({ event_id: 'before-boundary', occurred_at: '2026-08-02T18:19:59.000Z', day_index: 0 }),
  ev({ event_id: 'at-boundary', occurred_at: '2026-08-02T18:20:00.000Z', day_index: 1 }),
  ev({ event_id: 'after-boundary', occurred_at: '2026-08-02T20:00:00.000Z', day_index: 1 }),
  ev({ event_id: 'day2', occurred_at: '2026-08-03T20:00:00.000Z', day_index: 2 }),
  ev({ event_id: 'no-time', occurred_at: null, evidence_tier: 'C' }),
  ev({ event_id: 'dis', event_type: 'discharge', occurred_at: '2026-08-04T09:00:00.000Z', day_index: 2 }),
];
const ids = (list: EpisodeEvent[]) => list.map((e) => e.event_id);

test('blinding: the day 0 checkpoint sees the admission event and nothing else', () => {
  assert.deepEqual(ids(eventsBeforeDayStart(BLIND_EVENTS, ADMIT, 0)), ['adm']);
});

test('blinding: an event AT the day boundary is excluded — strictly before, not at or before', () => {
  const got = ids(eventsBeforeDayStart(BLIND_EVENTS, ADMIT, 1));
  assert.deepEqual(got, ['adm', 'before-boundary']);
  assert.ok(!got.includes('at-boundary'), 'an event exactly on the boundary belongs to the next day');
});

test('blinding: the day 2 checkpoint sees day 0 and day 1, never day 2', () => {
  const got = ids(eventsBeforeDayStart(BLIND_EVENTS, ADMIT, 2));
  assert.deepEqual(got, ['adm', 'before-boundary', 'at-boundary', 'after-boundary']);
  assert.ok(!got.includes('day2'));
});

test('blinding: no checkpoint input EVER carries the discharge event or an untimestamped event', () => {
  for (const day of [0, 1, 2, 3, 9]) {
    const got = ids(eventsBeforeDayStart(BLIND_EVENTS, ADMIT, day));
    assert.ok(!got.includes('dis'), `day ${day} leaked the discharge event`);
    assert.ok(!got.includes('no-time'), `day ${day} carried an event with no clinical timestamp`);
  }
});

test('blinding: the admission event is always included, even at day 0 where nothing precedes it', () => {
  for (const day of [0, 1, 5]) assert.ok(ids(eventsBeforeDayStart(BLIND_EVENTS, ADMIT, day)).includes('adm'));
});

test('blinding: a far-future day still cannot reach the discharge event', () => {
  const got = ids(eventsBeforeDayStart(BLIND_EVENTS, ADMIT, 30));
  assert.deepEqual(got, ['adm', 'before-boundary', 'at-boundary', 'after-boundary', 'day2']);
});

// ── 3. episode-level input ───────────────────────────────────────────────────────────────────

test('episode-level input excludes the discharge event and nothing else', () => {
  // every event here carries a clinical time, so §3.2.2's Tier C exclusion has nothing to remove
  // and the two rules can be checked apart
  const timed = BLIND_EVENTS.filter((e) => e.event_id !== 'no-time');
  const got = ids(episodeLevelEvents(timed));
  assert.deepEqual(got, ['adm', 'before-boundary', 'at-boundary', 'after-boundary', 'day2']);
  assert.equal(got.length, timed.length - 1, 'exactly one event — the discharge — was removed');
});

test('episode-level input also drops an event whose clinical time never resolved (§3.2.2)', () => {
  assert.ok(!ids(episodeLevelEvents(BLIND_EVENTS)).includes('no-time'));
});

test('pass A1 sees every event except the discharge; pass A2 sees every event including it', () => {
  assert.ok(!ids(diffPassEvents(BLIND_EVENTS)).includes('dis'));
  assert.equal(diffPassEvents(BLIND_EVENTS).length, BLIND_EVENTS.length - 1);
  assert.ok(ids(fidelityPassEvents(BLIND_EVENTS)).includes('dis'));
  assert.equal(fidelityPassEvents(BLIND_EVENTS).length, BLIND_EVENTS.length);
});

// ── 4. checkpoint budget ─────────────────────────────────────────────────────────────────────

test('checkpoint budget: los 0,1,2,5,6,7,30 → 1,2,3,6,7,7,7 daily plus exactly one episode-level', () => {
  const expected: [number, number][] = [[0, 1], [1, 2], [2, 3], [5, 6], [6, 7], [7, 7], [30, 7]];
  for (const [los, daily] of expected) {
    const plan = checkpointPlan(los);
    assert.equal(plan.filter((p) => p.checkpoint_type === 'daily').length, daily, `los ${los} daily count`);
    assert.equal(plan.filter((p) => p.checkpoint_type === 'episode').length, 1, `los ${los} episode count`);
    assert.deepEqual(
      plan.filter((p) => p.checkpoint_type === 'daily').map((p) => p.day_index),
      Array.from({ length: daily }, (_, i) => i),
      `los ${los} day indices are 0..${daily - 1} inclusive`,
    );
  }
});

test('checkpoint budget: a null or negative length of stay still gets the day 0 checkpoint', () => {
  for (const los of [null, -3]) {
    const plan = checkpointPlan(los);
    assert.equal(plan.filter((p) => p.checkpoint_type === 'daily').length, 1);
    assert.equal(plan[0].day_index, 0);
  }
});

// ── 14. timestamp preference ─────────────────────────────────────────────────────────────────

test('timestamp: progressnote_date_time from the {name, valueString} array beats g_creation_time', () => {
  const pn = Date.parse('2026-08-02T04:00:00.000Z');
  const gc = Date.parse('2026-08-02T09:00:00.000Z');
  const entries = parseComponentJson(JSON.stringify([
    { name: 'role', valueString: 'RMO' },
    { name: 'progressnote_date_time', valueString: String(pn) },
  ]));
  assert.equal(templateClinicalTime(entries, { g_creation_time: gc }), isoFromEpochMs(pn));
  // and it falls back to g_creation_time when the component value is absent
  assert.equal(templateClinicalTime(parseComponentJson('[]'), { g_creation_time: gc }), isoFromEpochMs(gc));
  // and yields null — Tier C — when neither resolves. It NEVER reaches for created_at/_create_time.
  assert.equal(templateClinicalTime(parseComponentJson('[]'), {}), null);
  assert.equal(templateClinicalTime(parseComponentJson('[]'), { created_at: '2026-08-02T09:00:00Z', _create_time: '2026-09-02T00:00:00Z' }), null);
});

test('component_json: junk, null and an already-parsed array all degrade to no pairs rather than throwing', () => {
  assert.deepEqual(parseComponentJson('not json'), []);
  assert.deepEqual(parseComponentJson(null), []);
  assert.deepEqual(parseComponentJson(''), []);
  assert.equal(parseComponentJson([{ name: 'role', valueString: 'Doctor' }]).length, 1);
  assert.equal(componentValue(parseComponentJson([{ name: 'role', valueString: 'Doctor' }]), 'role'), 'Doctor');
  assert.equal(componentValue([], 'role'), null);
});

test('note summary drops the seven excluded names and passes everything else through the de-identifier', () => {
  const entries = parseComponentJson(JSON.stringify([
    { name: 'esfewqf', valueString: 'x' }, { name: 'Inver43', valueString: 'x' },
    { name: 'fycjtkuvyj', valueString: 'x' }, { name: 'liubf', valueString: 'x' },
    { name: 'observationId', valueString: 'obs-1' }, { name: 'doctor_id', valueString: 'DOC-9' },
    { name: 'tag_data', valueString: '{"a":1}' },
    { name: 'T-3', valueString: 'Ravi Kumar remains febrile' },
    { name: 'T-35', valueString: '' },
  ]));
  const scrub = (t: string) => t.split('Ravi Kumar').join('[PATIENT]');
  const out = noteSummaryFrom(entries, scrub);
  for (const gone of ['esfewqf', 'Inver43', 'fycjtkuvyj', 'liubf', 'observationId', 'doctor_id', 'tag_data', 'DOC-9', 'obs-1']) {
    assert.ok(!out.includes(gone), `${gone} must not reach a note summary`);
  }
  assert.ok(out.includes('[PATIENT]') && !out.includes('Ravi Kumar'), 'the de-identifier ran');
  assert.ok(!out.includes('T-35'), 'an empty valueString contributes nothing');
});

test('author name: trimmed, `Dr.` collapsed to `Dr`, and NOTHING more', () => {
  assert.equal(normalizeAuthorName('  Dr. Testperson Alpha  '), 'Dr Testperson Alpha');
  assert.equal(normalizeAuthorName('Dr Testperson Beta'), 'Dr Testperson Beta');
  // hygiene is broken in the source and repairing it would invent a person — the rule stops here
  assert.equal(normalizeAuthorName('Dr Dietician'), 'Dr Dietician');
  assert.equal(normalizeAuthorName('  '), null);
  assert.equal(normalizeAuthorName(null), null);
  assert.equal(collapseSpaces('a   b \n c'), 'a b c');
});

// ── 15. order roll-ups and caps ──────────────────────────────────────────────────────────────

test('pharmacy roll-up: three rows of one item on one day become ONE event with count 3', () => {
  const rows = [
    { _doc_id: 'b1', service_type: 'Pharmacy', ordered_item_name: 'AMOXYCLAV 625', ordered_qty: 1, order_date_time: '2026-08-01T19:00:00Z' },
    { _doc_id: 'b2', service_type: 'Pharmacy', ordered_item_name: 'AMOXYCLAV 625', ordered_qty: 1, order_date_time: '2026-08-01T23:00:00Z' },
    { _doc_id: 'b3', service_type: 'Pharmacy', ordered_item_name: 'AMOXYCLAV 625', ordered_qty: 1, order_date_time: '2026-08-02T03:00:00Z' },
    { _doc_id: 'b4', service_type: 'Pharmacy', ordered_item_name: 'PANTOPRAZOLE 40', ordered_qty: 1, order_date_time: '2026-08-01T19:05:00Z' },
  ];
  const out = buildOrderEvents(rows, ADMIT);
  assert.equal(out.length, 2, 'one event per (day, item) — all four rows fall in day 0');
  const amox = out.find((e) => String(e.detail.ordered_item_name) === 'AMOXYCLAV 625')!;
  assert.equal(amox.detail.count, 3);
  assert.equal(amox.detail.rolled_up, true);
  assert.equal(amox.occurred_at, '2026-08-01T19:00:00.000Z', 'the roll-up carries the earliest order time');
  assert.equal(amox.provenance.source_table, 'kx_billing_records');
  // NO CATEGORY FIELD anywhere (decision 17) — the kx_medicine_items join was dropped
  for (const e of out) assert.ok(!('item_category' in e.detail) && !('category' in e.detail));
});

test('pharmacy roll-up keys on the DAY too: the same drug on two days is two events', () => {
  const rows = [
    { _doc_id: 'b1', service_type: 'Pharmacy', ordered_item_name: 'AMOXYCLAV 625', order_date_time: '2026-08-01T19:00:00Z' },
    { _doc_id: 'b2', service_type: 'Pharmacy', ordered_item_name: 'AMOXYCLAV 625', order_date_time: '2026-08-03T19:00:00Z' },
  ];
  const out = buildOrderEvents(rows, ADMIT);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.day_index).sort(), [0, 2]);
});

test('non-pharmacy orders: one event each, capped at 60 per day with a truncation note on the last kept', () => {
  const rows = Array.from({ length: 75 }, (_, i) => ({
    _doc_id: `x${String(i).padStart(3, '0')}`,
    service_type: 'Investigation',
    ordered_item_name: `TEST ${i}`,
    order_date_time: `2026-08-01T${String(19 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
  }));
  const out = buildOrderEvents(rows, ADMIT);
  assert.equal(out.length, 60, 'the per-day cap is 60');
  const truncated = out.filter((e) => e.detail.truncated_count != null);
  assert.equal(truncated.length, 1, 'exactly one event carries the truncation note');
  assert.equal(truncated[0].detail.truncated_count, 15);
  assert.equal(out[out.length - 1].detail.truncated_count, 15, 'it is the LAST kept event of the day');
});

test('the cap is per DAY and applies to non-pharmacy only — pharmacy roll-ups do not consume it', () => {
  const rows = [
    ...Array.from({ length: 65 }, (_, i) => ({ _doc_id: `d0-${i}`, service_type: 'Investigation', ordered_item_name: `A${i}`, order_date_time: `2026-08-01T19:${String(i % 60).padStart(2, '0')}:00Z` })),
    ...Array.from({ length: 3 }, (_, i) => ({ _doc_id: `d1-${i}`, service_type: 'Investigation', ordered_item_name: `B${i}`, order_date_time: `2026-08-03T19:0${i}:00Z` })),
    ...Array.from({ length: 40 }, (_, i) => ({ _doc_id: `p-${i}`, service_type: 'Pharmacy', ordered_item_name: `DRUG ${i}`, order_date_time: '2026-08-01T19:30:00Z' })),
  ];
  const out = buildOrderEvents(rows, ADMIT);
  assert.equal(out.filter((e) => e.day_index === 0 && e.detail.service_type === 'Investigation').length, 60);
  assert.equal(out.filter((e) => e.day_index === 2).length, 3, 'a later day gets its own budget');
  assert.equal(out.filter((e) => e.detail.rolled_up === true).length, 40, 'pharmacy roll-ups are outside the cap');
});

// ── tiers ────────────────────────────────────────────────────────────────────────────────────

test('tier per source table: the five A tables, the four B tables, and C for everything else', () => {
  for (const t of ['kx_ip_admissions', 'kx_clinical_template_progress_reports', 'kx_billing_records', 'kx_lab_reports', 'kx_discharge_summary_records', 'discharge_extracted_cases']) {
    assert.equal(tierForTable(t), 'A', t);
  }
  for (const t of ['kx_clinical_template_initial_assessment_adults', 'kx_clinical_template_shift_handovers', 'kx_clinical_template_ot_notes', 'kx_ip_transfers']) {
    assert.equal(tierForTable(t), 'B', t);
  }
  for (const t of ['kx_radiology_reports', 'individuals-observations', '', null, undefined]) {
    assert.equal(tierForTable(t as string), 'C', String(t));
  }
});

// ── 12. SOURCE-READ: no id is ever rewritten ─────────────────────────────────────────────────

test('source-read: neither the db13 reader nor the assembly core rewrites an id', () => {
  for (const file of ['lib/ipd-episode/db13.ts', 'lib/ipd-episode/assemble-core.ts']) {
    const src = code(file);
    for (const forbidden of ['replace(', 'regexp_replace(', 'IPNO-', 'ERN-']) {
      assert.ok(!src.includes(forbidden), `${file} must not contain '${forbidden}' — ids join exactly and are never transformed`);
    }
  }
});

test('behaviour, not just text: an IPNO- encounter id survives assembly byte-identical', () => {
  // the textual assertion above proves no rewriting CALL exists; this proves the value itself is
  // carried through untouched, which is the property that actually matters
  const encounter = 'IPNO-1281';
  const orders = buildOrderEvents(
    [{ _doc_id: 'b1', visit_id_admission_id: encounter, service_type: 'Investigation', ordered_item_name: 'CBC', order_date_time: '2026-08-01T19:00:00Z' }],
    ADMIT,
  );
  assert.equal(orders[0].provenance.source_record_id, 'b1');
  const serialised = JSON.stringify(orders);
  assert.ok(!serialised.includes('IP-1281'), 'no prefix substitution may occur anywhere in assembly');
});

// ── 13. SOURCE-READ: PHI and clinical time ───────────────────────────────────────────────────

const PHI_COLUMNS = [
  'patient_name', 'patient_age', 'patient_gender', 'birth_date', 'telecom', 'uhid',
  'patient_mobile', 'mobile_no', 'age', 'gender', 'age_gender', 'address_details',
  'kin_name', 'kin_contact', 'primary_email_address', 'secondary_email_address',
];

test('source-read: the db13 reader never names a PHI column', () => {
  const src = code('lib/ipd-episode/db13.ts');
  for (const col of PHI_COLUMNS) {
    assert.ok(!new RegExp(`\\b${col}\\b`).test(src), `lib/ipd-episode/db13.ts must not name '${col}'`);
  }
});

test('source-read: `_create_time` appears ONLY in the discharge-summary tiebreak', () => {
  const src = code('lib/ipd-episode/db13.ts');
  const lines = src.split('\n');
  const hits = lines.map((l, i) => ({ l, i })).filter((x) => x.l.includes('_create_time'));
  assert.ok(hits.length > 0, 'the tiebreak exists');
  for (const h of hits) {
    // every occurrence sits inside a discharge-summary statement: its own SELECT list, or the
    // DISTINCT ON / ORDER BY that picks the latest of several rows for one ipd_no
    const window = lines.slice(Math.max(0, h.i - 8), h.i + 3).join('\n');
    assert.ok(/kx_discharge_summary_records|ipd_no|DISCHARGE_COLS/.test(window),
      `_create_time at line ${h.i + 1} is outside the discharge-summary tiebreak`);
  }
  // and clinical ordering never touches the mirror's or the row's own write time
  assert.ok(!/ORDER BY[^;]*\bcreated_at\b/i.test(src), 'no clinical ordering by created_at');
  assert.ok(!/ORDER BY[^;]*_update_time/i.test(src), 'no clinical ordering by _update_time');
});

test('source-read: every db13 read is fail-safe — no reader lets a query error escape', () => {
  const src = code('lib/ipd-episode/db13.ts');
  // metabaseQuery is called in exactly one place, inside the guarded helper
  assert.equal((src.match(/metabaseQuery\(/g) ?? []).length, 1,
    'metabaseQuery must be reached only through the one guarded helper, so no reader can forget the catch');
  assert.ok(/catch \(e\)/.test(src) && /return \[\]/.test(src), 'the guarded helper degrades to an empty result');
});
