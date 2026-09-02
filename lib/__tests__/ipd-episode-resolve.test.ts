/**
 * lib/__tests__/ipd-episode-resolve.test.ts — the deterministic omission resolver (PRD decision 33).
 *
 * WHY THIS FILE MATTERS MORE THAN ITS SIZE SUGGESTS. Three runs of IP-1286 scored 96, 100 and 80
 * on byte-identical checkpoints, and every point of that spread came from the judge's verdicts on
 * omissions. Decision 33 moves those verdicts into code. If this module is deterministic and
 * correct, the omission half of the score stops moving; these tests are what "deterministic and
 * correct" means in practice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classIsRepresented, confoundFor, findMatch, termMatches, haystackFor, eventTypesFor,
  resolveEntry, resolveAll, resolutionCounts,
  type ExpectationMatcher, type ResolvableEntry,
} from '../ipd-episode/resolve-core';
import type { EpisodeEvent } from '../ipd-episode/assemble-core';

const ev = (o: Partial<EpisodeEvent> & { event_id: string }): EpisodeEvent => ({
  occurred_at: '2026-08-02T04:00:00.000Z', day_index: 0, event_type: 'note', summary: '', detail: {},
  author_name: null, author_role: null, responsible_clinician_id: null,
  provenance: { source_table: 't', source_record_id: o.event_id, source_timestamp: null },
  evidence_tier: 'A', ...o,
});

const drugOrder = (name: string, day = 0) => ev({
  event_id: `d-${name}-${day}`, event_type: 'order', day_index: day,
  detail: { service_type: 'Pharmacy', ordered_item_name: name },
  provenance: { source_table: 'kx_billing_records', source_record_id: `b-${name}`, source_timestamp: null },
});
const labOrder = (name: string, day = 0) => ev({
  event_id: `l-${name}-${day}`, event_type: 'lab_order', day_index: day,
  detail: { service_name: name },
  provenance: { source_table: 'kx_lab_reports', source_record_id: `l-${name}`, source_timestamp: null },
});

const entry = (o: Partial<ResolvableEntry> & { matcher: ExpectationMatcher | null }): ResolvableEntry => ({
  ref: 'cp-d0/therapeutics/1', checkpointId: 'cp-d0', dayIndex: 0, section: 'therapeutics',
  item: 'an expectation', rationale: 'because', byDay: 0, citationIds: [4021],
  proposedSeverity: 'major', ...o,
});

// ── PRESENT ─────────────────────────────────────────────────────────────────────────────────

test('PRESENT: a matching drug order resolves concordant', () => {
  const events = [drugOrder('ENOXAPARIN 40MG INJ'), labOrder('Complete Blood Count')];
  const r = resolveEntry(entry({ matcher: { kind: 'drug', terms: ['enoxaparin', 'heparin'] } }), events);
  assert.equal(r.resolution, 'present');
  assert.equal(r.verdict, 'concordant');
  assert.equal(r.matchedTerm, 'enoxaparin');
  assert.match(r.statement, /The record shows it/);
});

test('PRESENT: an event EARLIER than by_day still counts — the course was ahead of the expectation', () => {
  const events = [drugOrder('ENOXAPARIN 40MG', 0)];
  const r = resolveEntry(entry({ byDay: 2, matcher: { kind: 'drug', terms: ['enoxaparin'] } }), events);
  assert.equal(r.resolution, 'present', 'narrowing to an exact day would manufacture omissions out of timing');
});

test('a matcher only searches its own event types — a drug is not satisfied by a note mentioning it', () => {
  const events = [ev({ event_id: 'n', event_type: 'note', summary: 'plan: start enoxaparin tomorrow' })];
  const r = resolveEntry(entry({ matcher: { kind: 'drug', terms: ['enoxaparin'] } }), events);
  assert.notEqual(r.resolution, 'present', 'a plan to give a drug is not a drug order');
  assert.deepEqual(eventTypesFor('drug'), ['order']);
});

// ── ABSENT, class present → divergent ───────────────────────────────────────────────────────

test('ABSENT with the class represented resolves divergent at the PROPOSED severity', () => {
  const events = [drugOrder('PARACETAMOL 1G'), drugOrder('CEFAZOLIN 1G')];
  const r = resolveEntry(entry({ proposedSeverity: 'major', matcher: { kind: 'drug', terms: ['enoxaparin', 'heparin'] } }), events);
  assert.equal(r.resolution, 'absent_class_present');
  assert.equal(r.verdict, 'divergent');
  assert.equal(r.severity, 'major', 'severity was chosen while the model was blinded, and code does not revisit it');
  assert.match(r.statement, /the absence is real/);
});

// ── ABSENT, class missing → unassessable (the ONLY path) ────────────────────────────────────

test('ABSENT with NO data of that class resolves unassessable — the only path that may', () => {
  const events = [drugOrder('PARACETAMOL 1G')];   // drugs exist, labs do not
  const r = resolveEntry(entry({ matcher: { kind: 'lab', terms: ['creatinine'] } }), events);
  assert.equal(r.resolution, 'absent_class_missing');
  assert.equal(r.verdict, 'unassessable');
  assert.match(r.statement, /cannot answer/);
});

test('vitals and imaging are NEVER represented — this mirror holds neither', () => {
  const rich = [drugOrder('X'), labOrder('Y'), ev({ event_id: 'n', event_type: 'note', summary: 'BP 120/80 recorded' })];
  for (const kind of ['vitals', 'imaging'] as const) {
    assert.equal(classIsRepresented(kind, rich), false, kind);
    const r = resolveEntry(entry({ matcher: { kind, terms: ['blood pressure', 'chest x-ray'] } }), rich);
    assert.equal(r.verdict, 'unassessable', `${kind} must always be unassessable`);
    assert.match(r.statement, /absent from the mirror entirely/);
  }
});

test('class representation is measured off the events, per class', () => {
  const none: EpisodeEvent[] = [];
  assert.equal(classIsRepresented('lab', none), false);
  assert.equal(classIsRepresented('lab', [labOrder('CBC')]), true);
  assert.equal(classIsRepresented('drug', [drugOrder('X')]), true);
  assert.equal(classIsRepresented('drug', [labOrder('CBC')]), false);
  assert.equal(classIsRepresented('note', [ev({ event_id: 'n', event_type: 'note' })]), true);
  assert.equal(classIsRepresented('other', [drugOrder('X')]), false, '"other" is not checkable by construction');
});

// ── AMBIGUOUS: the confounds, enumerated in code ────────────────────────────────────────────

test('a bundled billing line makes a missing drug AMBIGUOUS, not divergent', () => {
  const events = [
    drugOrder('PARACETAMOL 1G'),
    ev({ event_id: 'pkg', event_type: 'order', detail: { service_type: 'Procedure', service_item_name: 'LAP HERNIA SURGERY PACKAGE' } }),
  ];
  const r = resolveEntry(entry({ matcher: { kind: 'drug', terms: ['enoxaparin'] } }), events);
  assert.equal(r.resolution, 'ambiguous_confounded');
  assert.equal(r.verdict, 'context_dependent');
  assert.match(r.confound ?? '', /hide a dispensed drug/);
});

test('a panel order makes a missing analyte AMBIGUOUS', () => {
  const events = [labOrder('LIVER FUNCTION PROFILE')];
  const r = resolveEntry(entry({ matcher: { kind: 'lab', terms: ['bilirubin'] } }), events);
  assert.equal(r.resolution, 'ambiguous_confounded');
  assert.match(r.confound ?? '', /panel order/);
  // and the confound is discoverable on its own
  assert.ok(confoundFor('lab', events));
  assert.equal(confoundFor('lab', [labOrder('SERUM SODIUM')]), null, 'a single named test confounds nothing');
});

test('an entry with NO matcher is uncheckable, and says so rather than scoring', () => {
  const r = resolveEntry(entry({ matcher: null }), [drugOrder('X')]);
  assert.equal(r.resolution, 'ambiguous_confounded');
  assert.equal(r.verdict, 'context_dependent');
  assert.match(r.confound ?? '', /no matcher/);
});

// ── matching mechanics ──────────────────────────────────────────────────────────────────────

test('a single-word term matches on a word boundary, not a substring', () => {
  assert.equal(termMatches('heparin', 'ENOXAPARIN SODIUM 40MG'), false, '"heparin" is not inside "enoxaparin"');
  assert.equal(termMatches('heparin', 'HEPARIN 5000IU'), true);
  assert.equal(termMatches('low molecular weight heparin', 'inj low molecular weight heparin'), true, 'a phrase matches as a substring');
  assert.equal(termMatches('iv', 'IV FLUIDS'), false, 'terms under 3 chars are ignored — they match everything');
});

test('the haystack is narrow per event type, so a matcher cannot match on unrelated JSON', () => {
  assert.equal(haystackFor(labOrder('Serum Creatinine')).trim(), 'Serum Creatinine');
  assert.ok(haystackFor(drugOrder('ENOXAPARIN')).includes('ENOXAPARIN'));
});

test('findMatch returns the first satisfying event, or null', () => {
  const events = [drugOrder('PARACETAMOL'), drugOrder('ENOXAPARIN')];
  assert.equal(findMatch({ kind: 'drug', terms: ['enoxaparin'] }, null, events)?.event.event_id, 'd-ENOXAPARIN-0');
  assert.equal(findMatch({ kind: 'drug', terms: ['warfarin'] }, null, events), null);
  assert.equal(findMatch({ kind: 'other', terms: ['anything'] }, null, events), null, '"other" matches nothing');
});

// ── determinism, which is the whole point ───────────────────────────────────────────────────

test('the resolver is a pure function: the same inputs give byte-identical output, every time', () => {
  const events = [drugOrder('PARACETAMOL'), labOrder('LIVER FUNCTION PROFILE'), drugOrder('CEFAZOLIN')];
  const entries = [
    entry({ ref: 'cp-d0/therapeutics/1', matcher: { kind: 'drug', terms: ['enoxaparin'] } }),
    entry({ ref: 'cp-d0/diagnostics/1', section: 'diagnostics', matcher: { kind: 'lab', terms: ['bilirubin'] } }),
    entry({ ref: 'cp-d1/therapeutics/1', matcher: { kind: 'drug', terms: ['cefazolin'] } }),
    entry({ ref: 'cp-d1/monitoring/1', section: 'monitoring', matcher: { kind: 'vitals', terms: ['blood pressure'] } }),
  ];
  const a = JSON.stringify(resolveAll(entries, events).map((r) => r.outcome));
  for (let i = 0; i < 25; i++) {
    assert.equal(JSON.stringify(resolveAll(entries, events).map((r) => r.outcome)), a,
      'this is what replaces a judge that returned 0, 12 and 11 unassessable on identical input');
  }
  const counts = resolutionCounts(resolveAll(entries, events));
  // one of each path, which is also the clearest statement of what the resolver does:
  //   cefazolin ordered            -> present
  //   enoxaparin absent, drugs exist and nothing bundles -> absent_class_present (divergent)
  //   bilirubin absent behind an LFT panel               -> ambiguous_confounded
  //   blood pressure, a class this mirror lacks          -> absent_class_missing (unassessable)
  assert.deepEqual(counts, { present: 1, absent_class_present: 1, absent_class_missing: 1, ambiguous_confounded: 1 });
});

test('every outcome carries the four fields a reader needs to re-run the lookup by hand', () => {
  const events = [drugOrder('ENOXAPARIN 40MG')];
  const r = resolveEntry(entry({ matcher: { kind: 'drug', terms: ['enoxaparin'] } }), events);
  assert.ok(r.resolution && r.verdict && r.severity && r.statement);
  assert.equal(r.matchedEvent?.provenance.source_table, 'kx_billing_records');
  assert.equal(r.matchedTerm, 'enoxaparin');
});
