/**
 * lib/__tests__/stewardship-board.test.ts — S2 of the stewardship MS agent: the board's three
 * columns, its sort, and the danger queue's membership
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A5; spec §4, acceptance #2 / #3 / #7 / #16).
 *
 *   node --test --import tsx lib/__tests__/stewardship-board.test.ts
 *
 * The severity table itself is not re-tested here — `tierFor` has its own suite and this ship does
 * not touch it. What is tested is everything built ON it: which findings the queue admits, what a
 * pill does to one, the lexicographic sort that must never become a weighting, and the honesty copy
 * acceptance #3 asks for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { escalationMatch, tierFor } from '../severity-tier-core';
import {
  ipdDangerVerdict, ipdPillState, opdDangerVerdict, opdPillState, sortBoardRows,
  DANGER_QUEUE_UNIT, IPD_PILL_STATE, IPD_SPLIT_BANNER, IPD_STORED_VERDICTS, IPD_UNJOINED_CELL,
  OPD_PILL_STATE, STEWARDSHIP_HONESTY,
} from '../stewardship-danger-core';
import { BOARD_ESCALATION_PREFILTER, BOARD_INFERRED_SQL } from '../stewardship-board';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const codeJsx = (p: string) => code(p).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const BOARD_PAGE = 'app/admin/stewardship/page.tsx';
const DEPT_PAGE = 'app/admin/stewardship/dept/[dept]/page.tsx';
const BOARD_LIB = 'lib/stewardship-board.ts';

// A tier-1 finding, straight out of the ratified escalation list (finding 36).
const ESCALATED = { signal_type: 'appropriateness_review', verdict: 'low-value', subject: 'Exertional chest pain sent home', rationale: 'Possible acute coronary syndrome routed to OPD review rather than emergency assessment.' };
// A tier-3 finding: logged, never queued.
const TIER3 = { signal_type: 'unverified_brand', verdict: 'low-value', subject: 'Brand not in the formulary', rationale: 'Brand could not be verified.' };
// Praise. It escalates on TEXT and must still never be queued.
const PRAISE = { signal_type: 'appropriateness_high_value', verdict: 'high-value', subject: 'Acute coronary syndrome referred to emergency', rationale: 'Correctly routed for immediate assessment.' };

// ── A5: the seven stored verdicts, mapped (acceptance #16) ────────────────────────────────

test('A5: the IPD mapping is the memo\'s, verdict by verdict', () => {
  assert.equal(ipdPillState('agree'), 'confirmed');
  assert.equal(ipdPillState('true_positive'), 'confirmed');
  assert.equal(ipdPillState('needs_action'), 'open');
  assert.equal(ipdPillState('contested'), 'open');
  assert.equal(ipdPillState('disagree'), 'dropped');
  assert.equal(ipdPillState('false'), 'dropped');
  assert.equal(ipdPillState('nitpick'), 'dropped');
  assert.equal(ipdPillState(null), 'open', 'no pill counts as open');
});

test('A5: every verdict the IPD route accepts is mapped — none falls through unnoticed', () => {
  for (const v of IPD_STORED_VERDICTS) {
    assert.ok(IPD_PILL_STATE[v], `${v} is stored by the route but has no mapping`);
  }
  // and an unrecognised string is OPEN, never silently dropped: removing a possible patient risk
  // from the list on the strength of a word nobody knows is the one unsafe direction here.
  assert.equal(ipdPillState('something_new'), 'open');
  assert.equal(opdPillState('something_new'), 'open');
});

test('A5 / §7: the IPD feedback route is UNTOUCHED — it still accepts what it accepted before', () => {
  const src = code('app/api/admin/ipd-audit-feedback/route.ts');
  for (const v of IPD_STORED_VERDICTS) assert.ok(src.includes(`'${v}'`), `the route no longer names ${v}`);
  assert.match(src, /const VERDICTS = new Set\(\[/);
  // the reader maps; the writer is not edited this ship
  assert.ok(!/stewardship/i.test(src), 'the stewardship ship must not have reached into the feedback route');
});

test('spec §4: the OPD mapping keeps confirmed visible and drops noise off the open count', () => {
  assert.equal(opdPillState('true_positive'), 'confirmed');
  assert.equal(opdPillState('contested'), 'open');
  assert.equal(opdPillState('nitpick'), 'dropped');
  assert.equal(opdPillState('false'), 'dropped');
  assert.equal(opdPillState(null), 'open');
  assert.deepEqual(Object.keys(OPD_PILL_STATE).sort(), ['contested', 'false', 'nitpick', 'true_positive']);
});

// ── membership (acceptance #7) ────────────────────────────────────────────────────────────

test('acceptance #7: an OPD tier-1 finding appears in the queue and counts open', () => {
  assert.equal(tierFor(ESCALATED).tier, 1);
  const v = opdDangerVerdict(ESCALATED, null);
  assert.equal(v.included, true);
  assert.equal(v.leg, 'escalation');
  assert.equal(v.open, true);
  assert.equal(v.escalatedBy, 'E-1');
});

test('acceptance #7: a `false`-pilled finding does not count as open', () => {
  const v = opdDangerVerdict(ESCALATED, 'false');
  assert.equal(v.included, true, 'it is still a tier-1 finding — it is the COUNT it leaves, not the record');
  assert.equal(v.open, false);
  assert.equal(v.state, 'dropped');
  assert.equal(opdDangerVerdict(ESCALATED, 'nitpick').open, false);
});

test('acceptance #7: a confirmed tier-1 finding stays visible as confirmed, not as open', () => {
  const v = opdDangerVerdict(ESCALATED, 'true_positive');
  assert.equal(v.included, true);
  assert.equal(v.state, 'confirmed');
  assert.equal(v.open, false);
});

test('praise never enters the queue — not even when it is contested', () => {
  assert.equal(tierFor(PRAISE).tier, 'praise');
  assert.equal(opdDangerVerdict(PRAISE, null).included, false);
  assert.equal(opdDangerVerdict(PRAISE, 'contested').included, false, 'a contested praise is still praise');
  assert.equal(ipdDangerVerdict({ subject: 'Standard prophylaxis given', domain: 'safety', verdict: 'high-value' }, null).included, false);
});

test('tier 3 is logged, not queued — unless a reviewer contests it', () => {
  assert.equal(tierFor(TIER3).tier, 3);
  assert.equal(opdDangerVerdict(TIER3, null).included, false);
  const contested = opdDangerVerdict(TIER3, 'contested');
  assert.equal(contested.included, true, 'the dispute leg is not a severity claim — it is an unresolved disagreement');
  assert.equal(contested.leg, 'contested');
  assert.equal(contested.open, true);
});

test('IPD membership is the STORED domain and the pill — no invented severity regex', () => {
  const safety = ipdDangerVerdict({ subject: 'Anticoagulant restarted without a platelet count', domain: 'safety', verdict: 'low-value' }, null);
  assert.equal(safety.included, true);
  assert.equal(safety.open, true);
  assert.equal(ipdDangerVerdict({ subject: 'Longer stay than the procedure needs', domain: 'efficiency', verdict: 'low-value' }, null).included, false);
  assert.equal(ipdDangerVerdict({ subject: 'Longer stay than the procedure needs', domain: 'efficiency', verdict: 'low-value' }, 'contested').included, true);
  // needs_action on a safety finding is OPEN — a human said something must still happen
  assert.equal(ipdDangerVerdict({ subject: 's', domain: 'safety', verdict: 'low-value' }, 'needs_action').open, true);
  assert.equal(ipdDangerVerdict({ subject: 's', domain: 'safety', verdict: 'low-value' }, 'agree').state, 'confirmed');
  assert.equal(ipdDangerVerdict({ subject: 's', domain: 'safety', verdict: 'low-value' }, 'disagree').open, false);
  // no text is ever read for severity on this surface
  const src = code('lib/stewardship-danger-core.ts');
  assert.ok(!/new RegExp|\/\^|E1_RE|E2_/.test(src.replace(/'E-[12]'/g, '')), 'no IPD severity regex may be invented here');
});

// ── the sort (acceptance #2, D-no-composite) ──────────────────────────────────────────────

const row = (openDangerous: number, avgNqi: number, ipdCvi: number | null, label: string) =>
  ({ openDangerous, avgNqi, ipdCvi, label });

test('acceptance #2: dangerous desc, then Avg NQI ascending, then IPD — and nothing else', () => {
  const sorted = sortBoardRows([
    row(0, 40, null, 'quiet but weak'),
    row(3, 90, null, 'strong but dangerous'),
    row(3, 60, null, 'dangerous and weaker'),
    row(0, 40, 55, 'quiet, weak, inpatient joined'),
  ]);
  assert.deepEqual(sorted.map((r) => r.label), [
    'dangerous and weaker',       // 3 open, NQI 60
    'strong but dangerous',       // 3 open, NQI 90
    'quiet, weak, inpatient joined',  // 0 open, NQI 40, IPD 55 — a joined row outranks an unjoined tie
    'quiet but weak',
  ]);
});

test('D-no-composite: an unjoined IPD cell sorts LAST, never as a zero', () => {
  const sorted = sortBoardRows([row(0, 50, null, 'unjoined'), row(0, 50, 10, 'joined and poor')]);
  assert.deepEqual(sorted.map((r) => r.label), ['joined and poor', 'unjoined'],
    'ranking an absent measurement as the worst score would be a claim nobody made');
});

test('D-no-composite: the board computes no weighted index anywhere', () => {
  for (const f of [BOARD_LIB, 'lib/stewardship-danger-core.ts', BOARD_PAGE]) {
    const src = code(f);
    assert.ok(!/\b(composite|stewardshipIndex|combinedIndex)\b/i.test(src), `${f} names a composite index`);
    // the shape a weighting would take: an arithmetic operator between two of the three columns
    assert.ok(!/(avgNqi|ipdCvi|openDangerous)\s*[*+]\s*[\d.]+/.test(src), `${f} weights a board column`);
    assert.ok(!/[\d.]+\s*\*\s*(avgNqi|ipdCvi|openDangerous)/.test(src), `${f} weights a board column`);
  }
});

// ── the escalation prefilter is a SUPERSET, and a tripwire guards it ──────────────────────

const prefilterHits = (text: string) =>
  BOARD_ESCALATION_PREFILTER.some((p) => text.toLowerCase().includes(p.replace(/%/g, '').toLowerCase()));

test('the SQL prefilter is a superset of the ratified escalation patterns', () => {
  // Every string tierFor escalates must survive the narrowing, or the queue would silently stop
  // finding it. The prefilter is allowed to be wider; it is not allowed to be narrower.
  const corpus = [
    'Possible acute coronary syndrome routed to OPD review',
    'Query ACS, advised outpatient follow-up',
    'Unstable angina managed as gastritis',
    'Myocardial infarction not considered',
    'Exertional chest pain with no ECG',
    'Exertional chest heaviness, reassured',
    'Persistent neck swelling for 6 weeks with no investigation ordered',
    'Unexplained cervical lymphadenopathy present two months, no work-up',
  ];
  for (const text of corpus) {
    assert.ok(escalationMatch({ subject: text, rationale: '' }), `fixture does not escalate: ${text}`);
    assert.ok(prefilterHits(text), `the prefilter would MISS an escalated finding: ${text}`);
  }
});

test('tripwire: a new escalation entry breaks this test rather than the queue', () => {
  // The prefilter was built for exactly two escalation matchers. If a third is ratified with new
  // vocabulary, this fails HERE — in the same change — instead of the queue quietly going blind.
  const src = read('lib/severity-tier-core.ts');
  const names = [...src.matchAll(/^const (E\d[A-Z0-9_]*_RE)\b/gm)].map((m) => m[1]).sort();
  assert.deepEqual(names, ['E1_RE', 'E2_ENTITY_RE', 'E2_FOLLOWTHROUGH_RE', 'E2_MONTHS_RE', 'E2_NEGATION_STRIP_RE', 'E2_WEEKS_RE', 'E2_WORD_DURATION_RE'],
    'the ratified escalation matchers changed — revisit BOARD_ESCALATION_PREFILTER in this same change');
  // and the decision still belongs to tierFor, not to the SQL
  assert.ok(code(BOARD_LIB).includes('opdDangerVerdict'), 'the board must ask the tier core, not the ILIKE');
});

// ── copy (acceptance #3) ──────────────────────────────────────────────────────────────────

test('acceptance #3: the "not a clinician scorecard" clause is gone from this room', () => {
  for (const f of [BOARD_PAGE, DEPT_PAGE]) {
    const src = codeJsx(f);
    assert.ok(!/not a (standalone )?clinician score/i.test(src), `${f} still calls this not a clinician score`);
    assert.ok(!/clinician scorecard/i.test(src), `${f} still says clinician scorecard`);
  }
});

test('acceptance #3: what replaces it says who never sees this', () => {
  assert.match(STEWARDSHIP_HONESTY, /Internal medical-superintendent stewardship/);
  assert.match(STEWARDSHIP_HONESTY, /Never shown to the clinician being reviewed or to any patient/);
  assert.match(STEWARDSHIP_HONESTY, /advisory rule and model outputs/);
  assert.ok(!/scorecard|accreditation|NABH/i.test(STEWARDSHIP_HONESTY));
  for (const f of [BOARD_PAGE, DEPT_PAGE]) assert.ok(code(f).includes('STEWARDSHIP_HONESTY'), `${f} does not show the honesty line`);
});

test('A1: the split banner is on the board, and the IPD cell is a banner rather than a number', () => {
  assert.equal(IPD_SPLIT_BANNER, 'OPD and IPD are not the same physician key on this spine.');
  const src = code(BOARD_PAGE);
  assert.ok(src.includes('IPD_SPLIT_BANNER'));
  assert.ok(src.includes('IPD_UNJOINED_CELL'));
  assert.equal(IPD_UNJOINED_CELL, 'IPD unjoined');
});

test('§1.4: the danger queue states its reporting unit', () => {
  assert.match(DANGER_QUEUE_UNIT, /One row per finding/);
  assert.match(DANGER_QUEUE_UNIT, /one day is one row, with a count/);
  assert.ok(code(BOARD_PAGE).includes('DANGER_QUEUE_UNIT'));
  assert.ok(code(BOARD_LIB).includes('dedupeTwins'), 'the canonical twin helper is what collapses them');
});

// ── §6a — fail-safe, read-only, study-filtered ────────────────────────────────────────────

test('§6a: every board query is a SELECT and the board writes nothing', () => {
  const src = code(BOARD_LIB);
  assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE)\b/i.test(src));
  assert.ok(!/physician_standing/i.test(src), 'the standing overlay is S4');
  for (const [name, q] of Object.entries(BOARD_INFERRED_SQL)) {
    assert.match(q.trim(), /^SELECT\b/i, `${name} is not a SELECT`);
  }
});

test('§8: every read of opd_audit_feedback carries the study predicate', () => {
  for (const [name, q] of Object.entries(BOARD_INFERRED_SQL)) {
    const reads = (q.match(/FROM opd_audit_feedback/g) ?? []).length;
    const preds = (q.match(/study IS NOT DISTINCT FROM/g) ?? []).length;
    assert.equal(reads, preds, `${name}: ${reads} read(s) of opd_audit_feedback, ${preds} study predicate(s)`);
  }
});

test('A6: the inpatient danger read cannot see the stay auditor\'s rows', () => {
  const q = BOARD_INFERRED_SQL.danger_ipd;
  assert.match(q, /SELECT DISTINCT ON \(ip_uid\) ip_uid/);
  assert.match(q, /engine_version = \$1/);
  assert.ok(!q.includes('ipd-stay-audit'), 'the stay engine must not be named');
  // and no clinician is attributed on that leg — the hop is S3's
  assert.ok(!/doctor_uid|doctor_directory/.test(q), 'the inpatient leg must not claim a clinician');
});
