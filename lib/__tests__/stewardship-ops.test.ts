/**
 * lib/__tests__/stewardship-ops.test.ts — S2-ops: the consult-ops pane
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A4 / A7–A10; acceptance #13, #14, #17, #20).
 *
 *   node --test --import tsx lib/__tests__/stewardship-ops.test.ts
 *
 * The decisions this pane exists under are mostly NEGATIVE — it must not rank, must not merge two
 * department dictionaries, must not poll a dated card, must not show a rate without a denominator,
 * and must not let a deck-basis figure stand on its own. Negative rules are the ones that rot, so
 * most of what follows is written to fail loudly the first time one is bent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEmailMap, buildOpsRow, orderOpsRows, rate, rateLabel, resolveOpsEmail,
  DECK_NOTES, GRAIN_NOTE, OPS_NOT_A_RANK, TC_ADHERENCE_LABEL, TC_ADHERENCE_NOTE,
  type EmailMapRow, type OpsInputs,
} from '../stewardship-ops-core';
import { OPS_INFERRED_SQL, OPS_WINDOW_DAYS } from '../stewardship-ops';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const OPS_LIB = 'lib/stewardship-ops.ts';
const OPS_CORE = 'lib/stewardship-ops-core.ts';
const PANE = 'app/admin/stewardship/ops-pane.tsx';
const ALL_SQL = Object.values(OPS_INFERRED_SQL).join('\n');

const noMap = buildEmailMap([]);
const nameOf = () => undefined;

// ── D-ops-identity: unique e-mail or nothing ──────────────────────────────────────────────

/** The three MEASURED duplicate pairs. Mahendra Jain's two clinician records share one address
 *  outright, which is what makes e-mail unusable as a tiebreak on the inpatient hop as well. */
const EMAIL_ROWS: EmailMapRow[] = [
  { email: 'poornima.parasuraman@even.in', nUids: 1, uid: 'HalPyIorNPSOYBL7KSJy' },
  { email: 'mahijain@yahoo.com', nUids: 2, uid: '74zZm5tNZYe1NRoipidm' },
  { email: 'srikanth.kn@even.in', nUids: 2, uid: 'hh5wHWVgthwC4ESLzx88' },
  { email: 'drvinitoswal@gmail.com', nUids: 2, uid: 'TeWNbrcDIm3Fy3EL0NfK' },
];

test('D-ops-identity: a unique ops e-mail joins; a shared one joins nobody', () => {
  const m = buildEmailMap(EMAIL_ROWS);
  assert.deepEqual(resolveOpsEmail('poornima.parasuraman@even.in', m), { uid: 'HalPyIorNPSOYBL7KSJy', reason: 'joined' });
  for (const dup of ['mahijain@yahoo.com', 'srikanth.kn@even.in', 'drvinitoswal@gmail.com']) {
    assert.deepEqual(resolveOpsEmail(dup, m), { uid: null, reason: 'duplicate_email' },
      `${dup} is a known duplicate and must fail closed`);
    assert.equal(m.unique.has(dup), false, 'a duplicate must not be lookup-able at all');
  }
  assert.deepEqual(resolveOpsEmail('nobody@even.in', m), { uid: null, reason: 'no_doctor_row' });
  // the two refusals are DIFFERENT, so the surface can say which one it is
  assert.notEqual(resolveOpsEmail('mahijain@yahoo.com', m).reason, resolveOpsEmail('nobody@even.in', m).reason);
});

test('D-ops-identity: e-mail matching is case- and whitespace-insensitive, and nothing else', () => {
  const m = buildEmailMap([{ email: '  Poornima.Parasuraman@Even.IN ', nUids: 1, uid: 'X' }]);
  assert.equal(resolveOpsEmail('poornima.parasuraman@even.in', m).uid, 'X');
  // no fuzzy match, ever: a near-miss is a different person
  assert.equal(resolveOpsEmail('poornima@even.in', m).uid, null);
});

// ── acceptance #20: every metric shows its denominator ────────────────────────────────────

test('acceptance #20: a rate cannot exist without a denominator, and an empty one is not zero', () => {
  assert.deepEqual(rate(3, 12), { n: 3, of: 12, pct: 25 });
  assert.deepEqual(rate(0, 12), { n: 0, of: 12, pct: 0 });
  // THE ONE THAT MATTERS: nothing over nothing is UNKNOWN, not zero percent.
  assert.deepEqual(rate(0, 0), { n: 0, of: 0, pct: null });
  assert.equal(rateLabel(rate(0, 0)), '— of 0');
  assert.equal(rateLabel(rate(3, 12)), '25% (3/12)');
  assert.equal(rateLabel(null), '—');
});

test('acceptance #20: CSAT never shows a mean without n rated and a response rate (A8)', () => {
  const row = buildOpsRow('a@b.c', {
    csat: { nRx: 100, withFeedbackRow: 40, nRated: 10, meanRated: 4.6, meanDeck: 1.15 },
  }, noMap, nameOf);
  assert.equal(row.csat.primary.mean, 4.6);
  assert.deepEqual(row.csat.primary.rated, { n: 10, of: 100, pct: 10 });
  // and the deflated deck figure is present, labelled, and cannot be read alone
  assert.equal(row.csat.deck?.mean, 1.15);
  assert.match(row.csat.deckNote, /scores an unrated consult as zero/);
  assert.ok(row.csat.primary.mean! > row.csat.deck!.mean!, 'the deck basis deflates — that is the whole note');
});

test('acceptance #20: TC adherence shows its telemetry coverage beside it (A10)', () => {
  const row = buildOpsRow('a@b.c', {
    calendar: { booked: 200, cancelled: 0, patientNoShow: 0, doctorNoShow: 0, rescheduled: 0, completed: 200, teleconsults: 160, rxPresent: 0, rxPresentDeck: 0 },
    tc: { measurable: 100, onTime: 92, measurableDeck: 90, onTimeDeck: 83 },
  }, noMap, nameOf);
  assert.deepEqual(row.tcAdherence.primary.onTime, { n: 92, of: 100, pct: 92 });
  // 100 measurable of 160 TC events — the 63% the dictionary measured, said out loud
  assert.deepEqual(row.tcAdherence.primary.coverage, { n: 100, of: 160, pct: 63 });
  assert.equal(TC_ADHERENCE_LABEL, 'TC schedule adherence (≤180s from scheduled start)');
  assert.match(TC_ADHERENCE_NOTE, /schedule adherence, not waiting/);
});

// ── acceptance #17: deck-basis figures never sort, and never appear alone ──────────────────

test('acceptance #17: a deck figure is a FIELD of its primary — there is no shape where it is alone', () => {
  const row = buildOpsRow('a@b.c', {
    calendar: { booked: 10, cancelled: 1, patientNoShow: 1, doctorNoShow: 0, rescheduled: 0, completed: 8, teleconsults: 6, rxPresent: 5, rxPresentDeck: 4 },
  }, noMap, nameOf);
  for (const two of [row.rxShare, row.csat, row.tcAdherence]) {
    assert.ok('primary' in two && 'deck' in two && 'deckNote' in two);
    assert.ok(two.deckNote.startsWith('deck basis:'), 'every deck note names itself as one');
  }
  assert.deepEqual(row.rxShare.primary, { n: 5, of: 8, pct: 63 }, 'A7 primary is over COMPLETED consults');
  assert.deepEqual(row.rxShare.deck, { n: 4, of: 8, pct: 50 });
});

test('A7: the Rx deck basis reads EQUAL OR LOWER than its primary, never higher', () => {
  // Measured across the window: equal for 142 of 148 clinicians, lower for 6, higher for NONE. It
  // is arithmetic, not a coincidence — the replica's numerator is a strict subset of the primary's
  // over the same denominator, because a prescription id found in the pipeline is by definition a
  // prescription id that is present. The earlier fixture here had deck ABOVE primary, which is a
  // shape the data cannot produce; the copy is now explicit about the direction.
  assert.match(DECK_NOTES.rx, /EQUAL OR LOWER, never higher/);
  assert.match(DECK_NOTES.rx, /strict subset/);
  assert.match(DECK_NOTES.rx, /142 of 148/);
  assert.ok(!/higher than|exceeds|over-?states/i.test(DECK_NOTES.rx.replace('never higher', '')),
    'no wording may suggest the replica can read higher');

  // the same denominator on both sides, whatever the numerators are
  for (const [primaryN, deckN] of [[5, 5], [5, 4], [0, 0], [12, 11]]) {
    const r = buildOpsRow('a@b.c', {
      calendar: { booked: 20, cancelled: 0, patientNoShow: 0, doctorNoShow: 0, rescheduled: 0, completed: 20, teleconsults: 0, rxPresent: primaryN, rxPresentDeck: deckN },
    }, noMap, nameOf);
    assert.equal(r.rxShare.primary.of, r.rxShare.deck!.of, 'both bases share one denominator');
    assert.ok(r.rxShare.deck!.n <= r.rxShare.primary.n, 'the replica is a subset of the primary');
  }
});

test('acceptance #17 / D-ops-not-rank: no deck figure and no ops metric reaches a sort', () => {
  // The pane's own order is booking VOLUME, which is a fact about how busy a clinic was, never a
  // judgement. Nothing here exports a comparator the board could use.
  const rows = [
    buildOpsRow('quiet@x', { calendar: { booked: 2, cancelled: 0, patientNoShow: 0, doctorNoShow: 0, rescheduled: 0, completed: 2, teleconsults: 0, rxPresent: 2, rxPresentDeck: 2 } }, noMap, nameOf),
    buildOpsRow('busy@x', { calendar: { booked: 90, cancelled: 40, patientNoShow: 20, doctorNoShow: 9, rescheduled: 0, completed: 21, teleconsults: 0, rxPresent: 1, rxPresentDeck: 1 } }, noMap, nameOf),
  ];
  assert.deepEqual(orderOpsRows(rows).map((r) => r.email), ['busy@x', 'quiet@x']);

  // and the board's sort cannot see any of this: the danger core imports nothing from ops.
  const danger = code('lib/stewardship-danger-core.ts');
  assert.ok(!/stewardship-ops/.test(danger), 'the board sort must not import the ops module');
  const board = code('lib/stewardship-board.ts');
  assert.ok(!/stewardship-ops/.test(board), 'the board reads must not import the ops module');
  for (const f of [OPS_CORE, OPS_LIB]) {
    assert.ok(!/sortBoardRows|physician_standing|note_quality_index|care_value_index/.test(code(f)),
      `${f} touches a ranking or a score — ops is not a rank column (D-ops-not-rank)`);
  }
});

// ── acceptance #14: three grains, three denominators ──────────────────────────────────────

test('acceptance #14: a clinician with bookings and no audited notes still appears, with a zero denominator', () => {
  const row = buildOpsRow('a@b.c', {
    calendar: { booked: 40, cancelled: 2, patientNoShow: 3, doctorNoShow: 1, rescheduled: 0, completed: 34, teleconsults: 30, rxPresent: 30, rxPresentDeck: 30 },
    wait: { chartConsults: 22, sameDay: 15, previousDayStamps: 7, medianMin: 12, overThreeHours: 1 },
    auditedNotes: 0,
  }, noMap, nameOf);
  assert.equal(row.booked, 40);
  assert.equal(row.chartConsults, 22);
  assert.equal(row.auditedNotes, 0, 'the third grain is present and it is zero, not absent');
  assert.match(GRAIN_NOTE, /a calendar BOOKING is not a Chart CONSULT is not an audited NOTE/);
});

test('acceptance #14: a note with no Chart consult never invents a wait', () => {
  const row = buildOpsRow('a@b.c', { auditedNotes: 300 }, noMap, nameOf);
  assert.equal(row.wait.medianMin, null, 'no Chart consult, no wait — not a zero-minute wait');
  assert.deepEqual(row.wait.sameDay, { n: 0, of: 0, pct: null });
  assert.equal(row.chartConsults, 0);
});

test('a failed read is UNKNOWN, never zero — absence survives assembly', () => {
  const row = buildOpsRow('a@b.c', {} as OpsInputs, noMap, nameOf);
  for (const r of [row.cancelRate, row.patientNoShowRate, row.doctorNoShowRate, row.tcShare, row.rxShare.primary]) {
    assert.equal(r.pct, null, 'a missing read must render as an em-dash, not as 0%');
  }
  assert.equal(row.csat.primary.mean, null);
  assert.equal(row.csat.deck, null, 'no deck figure is invented from a read that did not happen');
});

// ── A4 / A9: what the dictionary measured, applied ────────────────────────────────────────

test('A4: card 8747 is never fetched, and the window is live and labelled', () => {
  const src = read(OPS_LIB);
  assert.ok(!/8747/.test(code(OPS_LIB)), 'the card id must not appear in code — it is a dated extract');
  assert.ok(!/question|\/api\/card/.test(code(OPS_LIB)), 'nothing here may call a Metabase card endpoint');
  // no hardcoded quarter: the card's own bounds must not be copied
  assert.ok(!/2026-06-01|2026-09-01/.test(ALL_SQL), 'the card\'s frozen window must not be reproduced');
  assert.match(ALL_SQL, /now\(\) AT TIME ZONE 'Asia\/Kolkata'/, 'the window must be live and IST');
  assert.equal(OPS_WINDOW_DAYS, 90);
  assert.ok(src.includes('CARD 8747 IS NEVER FETCHED'), 'and the file must say so where someone would add it');
});

test('A9: patient no-show is the STATUS, and is_no_show is never read', () => {
  // is_no_show is null on 92% of rows and TRUE on 3 CANCELED and 6 DOCTOR_NO_SHOW rows.
  assert.ok(!/is_no_show/.test(ALL_SQL), 'is_no_show conflates three outcomes and must not be read');
  assert.match(OPS_INFERRED_SQL.ops_calendar, /ce\.status = 'NO_SHOW'/);
  assert.match(OPS_INFERRED_SQL.ops_calendar, /ce\.status = 'DOCTOR_NO_SHOW'/);
});

test('A4: the cancelling actor is the last history element, not the sparse cancelled_by', () => {
  const q = OPS_INFERRED_SQL.ops_cancel_source;
  assert.match(q, /jsonb_array_length\(ce\.history\) - 1/);
  assert.match(q, /->> 'action_source'/);
  assert.ok(!/cancelled_by/.test(ALL_SQL), 'cancelled_by is populated on a fifth of cancelled rows');
  // and the fragment only trusts the last element when it IS the cancellation
  assert.match(q, /->> 'status' = 'CANCELED'/);
});

test('A4: a teleconsult is the resolved Meet URL, not a blank facility name', () => {
  assert.match(OPS_INFERRED_SQL.ops_calendar, /consultation_conference__resolved_join_url IS NOT NULL/);
  assert.ok(!/consult_facility_info__name/.test(ALL_SQL),
    'the blank-facility test disagrees with the URL test on real rows; one rule, and it is the artefact');
});

test('A4: the Chart services read is DEDUPED before anything joins it', () => {
  // 59 calendar_uids carry 2-5 rows; the card multiplies on them.
  assert.match(OPS_INFERRED_SQL.ops_wait, /SELECT DISTINCT ON \(svc\.uid\)/);
  // and the calendar grain counts the identity, not the row
  assert.match(OPS_INFERRED_SQL.ops_calendar, /count\(DISTINCT ce\.event_uuid\)/);
  assert.ok(!/count\(\*\)::int AS booked/.test(OPS_INFERRED_SQL.ops_calendar));
});

test('A8: the CSAT denominator is COMPLETED consults, same as Rx share', () => {
  // Round-2 finding F-2: without this filter a cancelled or no-showed event carrying a
  // prescription_uid entered n_rx — 80 of 39,322 in the window. It deflates the response rate by
  // counting consults that never happened as consults nobody rated.
  const q = OPS_INFERRED_SQL.ops_csat;
  assert.match(q, /AND ce\.status NOT IN \('CANCELED', 'NO_SHOW', 'DOCTOR_NO_SHOW', 'RESCHEDULED'\)/);
  // and it is the SAME predicate the Rx-share denominator uses, so one row's two rates are over one
  // population rather than two that nearly agree
  const rxDenom = OPS_INFERRED_SQL.ops_calendar.match(/ce\.status NOT IN \([^)]*\)/)![0];
  assert.ok(q.includes(rxDenom), 'the two denominators must be the same predicate, not two copies');
});

test('A8: CSAT averages RATED rows, and the text timestamp is cast before ordering', () => {
  const q = OPS_INFERRED_SQL.ops_csat;
  assert.match(q, /avg\(fb\.score\) FILTER \(WHERE fb\.rating__value IS NOT NULL\)/, 'the primary excludes unrated rows');
  assert.match(q, /avg\(COALESCE\(fb\.score, 0\)\)/, 'the deck replica is the card\'s ELSE 0 figure');
  assert.match(q, /\(f\.rating__submitted_at\)::timestamptz/, 'a TEXT timestamp must not be sorted lexically');
  assert.match(q, /ORDER BY presc_uid, submitted_at DESC NULLS LAST/);
});

test('A10: the gmail filter is gone from the primary and kept only as the deck replica', () => {
  const q = OPS_INFERRED_SQL.ops_tc_adherence;
  // the patient side is "not the doctor, not staff" — the domain assumption dropped 496 patients
  assert.match(q, /lower\(p_email\) <> lower\(employee_email\)/);
  assert.match(q, /NOT LIKE '%@even\.in'/);
  // gmail survives ONLY as a flag feeding the deck columns, never as a filter on the primary
  assert.match(q, /\(lower\(p_email\) LIKE '%gmail\.com'\) AS is_gmail/);
  assert.match(q, /count\(\*\) FILTER \(WHERE any_gmail\)::int AS measurable_deck/);
  const primaryLine = q.match(/count\(\*\)::int AS measurable/);
  assert.ok(primaryLine, 'the primary denominator must be the unfiltered one');
});

// ── the wait method (28 Aug) ──────────────────────────────────────────────────────────────

test('wait: same IST day only, both token hops, and previous-day stamps counted not averaged', () => {
  const q = OPS_INFERRED_SQL.ops_wait;
  // both hops — the worked example hopped all 30 consults through the walk-in path
  assert.match(q, /JOIN queue_tokens t ON t\.target_uid = s\.uid/);
  assert.match(q, /JOIN dpipe_pqm_tokens d ON d\.service_request_uid = s\.uid/);
  assert.match(q, /JOIN queue_tokens t ON t\.uid = d\.token_uid/);
  // the same-day gate, and the excluded rows kept as a COUNT
  assert.match(q, /\(k\.token_open AT TIME ZONE 'Asia\/Kolkata'\)::date = \(c\.called_at AT TIME ZONE 'Asia\/Kolkata'\)::date/);
  assert.match(q, /count\(\*\) FILTER \(WHERE prev_day\)::int AS prev_day_stamps/);
  assert.match(q, /count\(\*\) FILTER \(WHERE wait_min > 180\)::int AS over_three_hours/);
  // the call clock is the CONSULTATION step, cast from text; the slot is never subtracted
  assert.match(q, /st\.station = 'CONSULTATION'/);
  assert.match(q, /\(st\.called_at\)::timestamptz/);
  // The SLOT columns are never read. `prescription_start_time` is a different column and a
  // different clock (it is the call / Pulse open), so the pin is on the bare slot names.
  assert.ok(!/\bsvc\.start_time\b|\bsvc\.end_time\b|\bce\.end_time\b/.test(q),
    'the slot is a 10/15/20-minute booking and is never subtracted for a duration');
  // and a case only counts once Pulse actually wrote
  assert.match(q, /svc\.prescription_start_time IS NOT NULL/);
  assert.match(q, /svc\.prescription_upload_time IS NOT NULL/);
});

test('wait: the doctor filter is the e-mail, never the token\'s display name', () => {
  assert.match(OPS_INFERRED_SQL.ops_wait, /svc\.doctor_email/);
  assert.ok(!/DOCTOR_NAME/.test(ALL_SQL), 'token metadata carries a display name only — never filter on it');
});

// ── §6a: read-only, fail-safe ─────────────────────────────────────────────────────────────

test('§6a: every ops query is a read, and the pane writes nothing', () => {
  for (const [name, q] of Object.entries(OPS_INFERRED_SQL)) {
    assert.match(q.trim(), /^(SELECT|WITH)\b/i, `${name} is not a read`);
    assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE)\b/i.test(q), `${name} writes`);
  }
  for (const f of [OPS_LIB, OPS_CORE, PANE]) {
    assert.ok(!/physician_standing/i.test(code(f)), `${f} pre-empts the S4 overlay`);
  }
  assert.match(OPS_NOT_A_RANK, /never sort the board above/);
  assert.ok(code(PANE).includes('OPS_NOT_A_RANK'), 'the pane must carry the not-a-rank sentence');
});

test('§6a: the pane is mounted on BOTH routes, and the dept route scopes by the directory', () => {
  const board = code('app/admin/stewardship/page.tsx');
  const dept = code('app/admin/stewardship/dept/[dept]/page.tsx');
  for (const [f, src] of [['board', board], ['dept', dept]] as const) {
    assert.ok(src.includes('<OpsSection'), `the ${f} route does not render the ops pane`);
    // round-2 note: the pane awaits six db13 reads, one of which 504'd on a single run. It is behind
    // its own Suspense boundary so the AUDIT pane — the board, the queue, the inpatient slice — is
    // never waiting on a consult-ops number.
    assert.ok(/<Suspense fallback=\{<OpsSectionFallback \/>\}>/.test(src),
      `the ${f} route blocks its audit pane on the ops reads`);
  }
  assert.ok(!/await fetchOpsPane/.test(board + dept), 'neither page may await the ops reads inline');
  assert.match(code('app/admin/stewardship/ops-section.tsx'), /await fetchOpsPane\(only\)/);
  // D-ops-identity — the dept route scopes by doctor_directory.speciality, never by mapped_speciality
  assert.match(dept, /const deptUids = Object\.entries\(specMap\)/);
  assert.ok(!/mapped_speciality/.test(dept + board + code(OPS_LIB)),
    'mapped_speciality is a calendar mode computed over all history — it is not a department');
});
