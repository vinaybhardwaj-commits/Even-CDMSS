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
  buildOrderEvents, checkpointPlanFromEvents, eventsBeforeCutoff, isProcedureEvent, MAX_CHECKPOINTS, collapseSpaces, dayIndexFor, dayStartIso, diffPassEvents,
  episodeLevelEvents, eventsBeforeDayStart, fidelityPassEvents, isoFromEpochMs, losDaysFor,
  noteSummaryFrom, normalizeAuthorName, parseComponentJson, componentValue, tierForTable,
  queryNarrativeFrom, QUERY_FALLBACK_CAP, stripMarkup,
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

test('DECISION 43: checkpoints are anchored to EVENTS, and blinding is re-derived per anchor', () => {
  // ⚠️ THIS REPLACES the calendar plan (day 0..min(los,6)). Two failures at opposite ends drove it:
  // cp-d0's cutoff was the ADMISSION INSTANT, so it saw the admission event and nothing else —
  // retrieval skipped on 10 of 12 episodes, every expectation uncited. And days beyond 6 were never
  // checkpointed: on IPNO-495 days 7-11 held 115 of 414 events, 28% of the admission, and produced
  // no expectations at all.
  const admit = '2026-08-01T06:00:00.000Z';
  const ev = (id: string, iso: string | null, type: EpisodeEvent['event_type'] = 'note', detail: Record<string, unknown> = {}) => ({
    event_id: id, occurred_at: iso, day_index: 0, event_type: type, summary: '', detail,
    author_name: null, author_role: null, responsible_clinician_id: null,
    provenance: { source_table: 't', source_record_id: id, source_timestamp: iso }, evidence_tier: 'A' as const,
  });
  const events = [
    ev('adm', admit, 'admission'),
    ev('n1', '2026-08-01T10:00:00.000Z'),
    ev('ot', '2026-08-03T09:00:00.000Z', 'ot_note'),
    ev('n2', '2026-08-06T09:00:00.000Z'),
    ev('n3', '2026-08-10T09:00:00.000Z'),
  ];
  const plan = checkpointPlanFromEvents({
    admittedAt: admit, dischargedAt: '2026-08-11T10:00:00.000Z', losDays: 10, events,
  });

  // the first anchor is a 24-hour WINDOW, not the admission instant
  const first = plan[0];
  assert.equal(first.anchor_kind, 'first_24h');
  assert.ok(first.cutoff_at > admit, 'its cutoff is after the door, so it can see the first day');
  assert.ok(eventsBeforeCutoff(events, first.cutoff_at).some((e) => e.event_id === 'n1'),
    'and it does see the first day’s note — the whole point');

  // the procedure and its follow-ups are anchored, and the late days are reachable
  const kinds = plan.map((p) => p.anchor_kind);
  assert.ok(kinds.includes('procedure'), 'the procedure day is an anchor');
  assert.ok(kinds.includes('procedure_plus_2') || kinds.includes('procedure_plus_4'), 'and its follow-ups');
  assert.ok(kinds.includes('pre_discharge'), 'and the decision to discharge');
  assert.ok(plan.some((p) => p.day_index > 6), 'a day beyond 6 is now reachable');

  // capped, deduplicated by day, and exactly one episode-level checkpoint, always last
  assert.ok(plan.length <= MAX_CHECKPOINTS, `at most ${MAX_CHECKPOINTS}`);
  assert.equal(plan.filter((p) => p.checkpoint_type === 'episode').length, 1);
  assert.equal(plan[plan.length - 1].checkpoint_type, 'episode');
  assert.equal(new Set(plan.map((p) => p.day_index)).size >= plan.length - 1, true, 'days deduplicated');
});

test('DECISION 46: only an OT note or a `Surgery` order anchors a procedure checkpoint', () => {
  // ⚠️ WHAT THE LOOSE TEST DID, MEASURED. `Procedure` is the billing category this mirror files
  // GRBS, nebulisation, IV cannulation, dressings, crossmatch and dialysis under, and the first
  // version matched it as a substring: 16 of the 20 procedure anchors across the twelve episodes
  // were set by lines like these, six by GRBS alone. They also ate the budget — with the plan
  // capped at MAX_CHECKPOINTS, no `procedure_plus_4` checkpoint existed anywhere in the cohort.
  const admit = '2026-08-01T06:00:00.000Z';
  const order = (id: string, iso: string, service: string, name: string): EpisodeEvent => ({
    event_id: id, occurred_at: iso, day_index: 0, event_type: 'order', summary: name,
    detail: { service_type: service, ordered_item_name: name },
    author_name: null, author_role: null, responsible_clinician_id: null,
    provenance: { source_table: 'billing', source_record_id: id, source_timestamp: iso }, evidence_tier: 'B',
  });
  const glucose = order('b1', '2026-08-02T09:00:00.000Z', 'Procedure', 'GRBS');
  const neb = order('b2', '2026-08-03T09:00:00.000Z', 'Procedure', 'NEBULISATION');
  const otCharge = order('b3', '2026-08-04T09:00:00.000Z', 'OT Charge', 'OT CHARGES');
  const surgery = order('b4', '2026-08-05T09:00:00.000Z', 'Surgery', 'DJ STENTING');

  assert.equal(isProcedureEvent(glucose), false, 'a finger-prick glucose is not a procedure anchor');
  assert.equal(isProcedureEvent(neb), false);
  assert.equal(isProcedureEvent(otCharge), false, 'nor is a theatre CHARGE — the OT note is the event');
  assert.equal(isProcedureEvent(surgery), true, 'a Surgery order is');
  assert.equal(isProcedureEvent({ ...glucose, event_type: 'ot_note' }), true, 'and an OT note always is');

  // exact match, not substring: `Procedure` must not slip back in through a looser test
  assert.equal(isProcedureEvent(order('b5', '2026-08-06T09:00:00.000Z', 'Day Care Surgery Procedure', 'X')), false,
    'a compound service type containing the word is not `Surgery`');
  assert.equal(isProcedureEvent(order('b6', '2026-08-06T09:00:00.000Z', ' surgery ', 'X')), true,
    'but whitespace and case do not matter');

  // and the plan follows: the glucose and nebulisation days are no longer checkpoints
  const mk = (id: string, iso: string, type: EpisodeEvent['event_type'] = 'note'): EpisodeEvent => ({
    event_id: id, occurred_at: iso, day_index: 0, event_type: type, summary: '', detail: {},
    author_name: null, author_role: null, responsible_clinician_id: null,
    provenance: { source_table: 't', source_record_id: id, source_timestamp: iso }, evidence_tier: 'A',
  });
  const plan = checkpointPlanFromEvents({
    admittedAt: admit, dischargedAt: '2026-08-12T10:00:00.000Z', losDays: 11,
    events: [mk('adm', admit, 'admission'), glucose, neb, otCharge, surgery],
  });
  const procDays = plan.filter((p) => p.anchor_kind === 'procedure').map((p) => p.day_index);
  // ⚠️ ONE anchor, and its day_index is 5 for a surgery on day 4: the cutoff is the END of the
  // procedure day, so the checkpoint can see the procedure itself, and the day is read off the
  // cutoff. The label names the moment the checkpoint looks BACK from, not the day it looks at.
  assert.deepEqual(procDays, [5], 'one procedure anchor, cutting off at the end of the surgery day');
  // with the spurious anchors gone there is room for the follow-up window that never existed
  assert.ok(plan.some((p) => p.anchor_kind === 'procedure_plus_4'),
    'and the +4 follow-up finally fits inside the cap');
});

test('DECISION 43: blinding — each anchor sees only what precedes its own cutoff', () => {
  const admit = '2026-08-01T06:00:00.000Z';
  const mk = (id: string, iso: string | null, type: EpisodeEvent['event_type'] = 'note') => ({
    event_id: id, occurred_at: iso, day_index: 0, event_type: type, summary: '', detail: {},
    author_name: null, author_role: null, responsible_clinician_id: null,
    provenance: { source_table: 't', source_record_id: id, source_timestamp: iso }, evidence_tier: 'A' as const,
  });
  const events = [
    mk('adm', admit, 'admission'),
    mk('early', '2026-08-01T09:00:00.000Z'),
    mk('late', '2026-08-09T09:00:00.000Z'),
    mk('untimed', null),
    mk('disch', '2026-08-11T10:00:00.000Z', 'discharge'),
  ];
  const seen = eventsBeforeCutoff(events, '2026-08-02T06:00:00.000Z').map((e) => e.event_id);
  assert.ok(seen.includes('adm'), 'the admission event is always visible');
  assert.ok(seen.includes('early'));
  assert.ok(!seen.includes('late'), 'nothing after the cutoff');
  assert.ok(!seen.includes('untimed'), 'an untimestamped event reaches no checkpoint (§3.2.2)');
  assert.ok(!seen.includes('disch'), 'the discharge event reaches no checkpoint, ever');
});

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
    { name: 'T-3', valueString: 'Testpatient Gamma remains febrile' },
    { name: 'T-35', valueString: '' },
  ]));
  const scrub = (t: string) => t.split('Testpatient Gamma').join('[PATIENT]');
  const out = noteSummaryFrom(entries, scrub);
  for (const gone of ['esfewqf', 'Inver43', 'fycjtkuvyj', 'liubf', 'observationId', 'doctor_id', 'tag_data', 'DOC-9', 'obs-1']) {
    assert.ok(!out.includes(gone), `${gone} must not reach a note summary`);
  }
  assert.ok(out.includes('[PATIENT]') && !out.includes('Testpatient Gamma'), 'the de-identifier ran');
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


// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 20 ITEM 3 — THE QUERY THAT WAS SILENTLY EMPTY
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const comp = (name: string, valueString: string) => ({ name, valueString });

test('ITEM 3a: the assessment contributes `loc`, and its FORM TABLES stay out', () => {
  // ⚠️ MEASURED, THEN CUT BACK. histoyerjfj / risky / vulnerass were whitelisted for exactly one
  // run. Stripping their HTML showed the tables hold form scaffolding, not narrative, and on
  // IPNO-573 that filled 641-1,200 chars of every query from day 1 and took off-topic excerpts
  // from 11 to 37. An empty query had been replaced by a worse one.
  const out = queryNarrativeFrom([
    comp('vulnerass', '<table><thead><tr><th>Sr. No.</th><th>Categories</th><th>Yes</th><th>No</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>Age more than 65 years</td><td>NO</td></tr></tbody></table>'),
    comp('loc', '["Alert"]'),
  ]);
  assert.equal(out, 'Alert', 'only the clean clinical word reaches retrieval');
  for (const junk of ['Sr. No.', 'Categories', 'Age more than 65', '<table', 'thead']) {
    assert.ok(!out.includes(junk), `form scaffolding ${junk} must not reach retrieval`);
  }
});

test('ITEM 3a: stripMarkup still unwraps markup where a whitelisted field carries it', () => {
  assert.equal(stripMarkup('<p>Breathlessness since three days</p>'), 'Breathlessness since three days');
  assert.equal(stripMarkup('{"a":"Alert"}'), 'a Alert');
  assert.equal(stripMarkup('K/C/O DM,HTN'), 'K/C/O DM,HTN', 'prose commas survive');
});

test('ITEM 3a: the base64 signature blob never reaches the query OR the summary', () => {
  const png = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(400);
  assert.equal(queryNarrativeFrom([comp('signnur', png)]), '', 'not in the query');
  const summary = noteSummaryFrom([comp('signnur', png), comp('T-3', 'patient reviewed')], (t) => t);
  assert.ok(!summary.includes('base64'), 'not in the note summary either');
  assert.match(summary, /patient reviewed/, 'and the real narrative is untouched');
});

test('ITEM 3b: the handover problem list is whitelisted, its staff names are not', () => {
  const out = queryNarrativeFrom([
    comp('nhc16', 'K/C/O DM,HTN,CKD ON MM & MHD PAST'),
    comp('nhc13', 'conscious AND ORIENTED'),
    comp('nursing_handover', 'SRUTHI'),
    comp('nursing_receiving', 'AKHILA'),
    comp('nhc05', '{"tableVal":[{"rowheader":"basic care","nhc08":"GIVEN"}]}'),
  ]);
  assert.match(out, /K\/C\/O DM,HTN,CKD/, 'the standing problem list reaches retrieval');
  assert.match(out, /conscious AND ORIENTED/);
  for (const name of ['SRUTHI', 'AKHILA']) assert.ok(!out.includes(name), `${name} must not`);
  assert.ok(!out.includes('rowheader'), 'nor the care-checklist table');
});

test('ITEM 3c: the fallback fires ONLY when the whitelist matched nothing', () => {
  // a known template is as tightly controlled as before — the fallback never runs
  const known = queryNarrativeFrom([comp('T-3', 'reviewed, afebrile'), comp('unknown_junk', 'ABSTACK 30-.-5MM-COVIDEN')]);
  assert.equal(known, 'reviewed, afebrile', 'the unknown field contributes nothing beside a known one');

  // an entirely unknown template contributes something cleaned rather than nothing at all
  const unknown = queryNarrativeFrom([comp('zzz_novel_field', 'Acute pyelonephritis with obstructive uropathy')]);
  assert.match(unknown, /Acute pyelonephritis with obstructive uropathy/);
});

test('ITEM 3c: the fallback is more suspicious than the whitelist, not less', () => {
  const png = 'data:image/png;base64,' + 'A'.repeat(300);
  const out = queryNarrativeFrom([
    comp('some_surgeon_name', 'Dr Testperson Alpha'),   // person-named field
    comp('sig_blob', png),                               // data URI
    comp('x', 'ok'),                                     // too short to be narrative
    comp('novel_finding', 'Right hydroureteronephrosis noted on imaging'),
  ]);
  assert.match(out, /Right hydroureteronephrosis/, 'real narrative survives');
  assert.ok(!out.includes('Testperson'), 'a person-named field is dropped by name');
  assert.ok(!out.includes('base64'), 'a data URI is dropped whole');
  assert.ok(out.length <= QUERY_FALLBACK_CAP, 'and the fallback is capped tighter than the whitelist');
});

test('ITEM 3: an empty component block still yields an empty query, not junk', () => {
  assert.equal(queryNarrativeFrom([]), '');
  assert.equal(queryNarrativeFrom([comp('a', ''), comp('b', '   ')]), '');
});
