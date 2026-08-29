/**
 * lib/__tests__/physician-standing.test.ts — S4, the MS standing overlay
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026; spec §6.3 / §12.3, acceptance #5 / #8 / #9).
 *
 *   node --test --import tsx lib/__tests__/physician-standing.test.ts
 *
 * §12.3 asks for a PURE, unit-tested gate, so most of this file is that gate being refused in every
 * way it can be refused. The rest asserts the two absences the overlay is only safe because of: no
 * score moves, and no aggregator can read the blob.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  containsQuote, isPhysicianStanding, standingDecision, standingRow,
  PHYSICIAN_STANDINGS, PHYSICIAN_STANDING_VERSION, STANDING_ADVISORY, STANDING_AUTHORITY,
  STANDING_PROMPT_CLAUSE, STANDING_QUOTE_MAX_CHARS, STANDING_REPLY_SCHEMA,
} from '../physician-standing-core';
import { STANDING_INFERRED_SQL } from '../physician-standing-store';
import { buildCaseAskPrompt, parseAskReply, type CaseAskMaterial } from '../case-ask-core';
import { opdAskMaterial } from '../case-ask/ask';
import { physicianAskMaterial } from '../case-ask/stewardship-material';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CORE = 'lib/physician-standing-core.ts';
const STORE = 'lib/physician-standing-store.ts';
const MIGRATION = 'migrations/0050_physician_standing.sql';
const MIGRATE_ROUTE = 'app/api/admin/migrate-physician-standing/route.ts';
const ASK_ROUTE = 'app/api/admin/stewardship/ask/route.ts';

const TURN = 'Having read the last quarter, I consider this physician a concern and want the pattern watched.';

// ── §12.3, the five conditions ────────────────────────────────────────────────────────────

test('§12.3: a stated assertion with an exact quote and a known standing WRITES', () => {
  const d = standingDecision(TURN, { stated: true, standing: 'concern', quote: 'I consider this physician a concern' });
  assert.deepEqual(d, { write: true, standing: 'concern', quote: 'I consider this physician a concern', reason: 'ok' });
});

test('§12.3: a QUESTION writes no overlay — and is not an error', () => {
  // "Otherwise persist the turn, skip overlay, do not 500." The turn is stored by the shell before
  // this gate ever runs; a refusal here changes nothing the auditor can see except the chip.
  assert.deepEqual(standingDecision('Is this physician a concern?', null),
    { write: false, standing: null, quote: '', reason: 'no_overlay' });
  assert.equal(standingDecision('Is this physician a concern?', { stated: false, standing: 'concern', quote: 'concern' }).reason, 'not_stated');
});

test('§12.3: `stated` must be exactly true — a truthy string is a loose model, not an assertion', () => {
  for (const stated of ['true', 1, {}, [], 'yes'] as unknown[]) {
    assert.equal(standingDecision(TURN, { stated, standing: 'concern', quote: 'a concern' }).reason, 'not_stated',
      `stated=${JSON.stringify(stated)} must not pass`);
  }
});

test('§12.3: the standing enum is closed — a plausible new word is still refused', () => {
  for (const bad of ['warning', 'ok', 'CONCERN', 'restricted_review', '', null, 7]) {
    assert.equal(standingDecision(TURN, { stated: true, standing: bad, quote: 'a concern' }).reason, 'unknown_standing',
      `${JSON.stringify(bad)} must not pass`);
  }
  assert.deepEqual([...PHYSICIAN_STANDINGS], ['standing', 'concern', 'restricted-review', 'insufficient']);
  for (const s of PHYSICIAN_STANDINGS) assert.equal(isPhysicianStanding(s), true);
});

test('§12.3: THE LOAD-BEARING ONE — a paraphrase is discarded, only his own words are stored', () => {
  // A model that reports what it thinks the auditor meant produces no overlay at all. An overlay is
  // a record of what a named person said about a named clinician; a paraphrase is not that.
  const paraphrase = standingDecision(TURN, { stated: true, standing: 'concern', quote: 'the reviewer is worried about this doctor' });
  assert.equal(paraphrase.write, false);
  assert.equal(paraphrase.reason, 'quote_not_in_turn');
  // an empty quote is its own refusal, so the surface can tell them apart
  assert.equal(standingDecision(TURN, { stated: true, standing: 'concern', quote: '   ' }).reason, 'quote_missing');
});

test('§12.3: the quote test forgives spacing and case, and nothing else', () => {
  assert.equal(containsQuote('I  consider   this physician a CONCERN', 'i consider this physician a concern'), true);
  assert.equal(containsQuote(TURN, 'consider this physician'), true);
  // near-misses are misses: one changed word is a different statement
  assert.equal(containsQuote(TURN, 'I consider this physician a serious concern'), false);
  assert.equal(containsQuote(TURN, ''), false);
  assert.equal(containsQuote('', 'anything'), false);
});

test('§12.3: a long quote is capped, not rejected', () => {
  const long = `He said ${'x'.repeat(600)} about it`;
  const d = standingDecision(long, { stated: true, standing: 'insufficient', quote: 'x'.repeat(600) });
  assert.equal(d.write, true);
  assert.equal(d.quote.length, STANDING_QUOTE_MAX_CHARS);
});

// ── the row (§6.3's blob) ─────────────────────────────────────────────────────────────────

test('§6.3: the stored row carries its own gate, its authority and its window', () => {
  const d = standingDecision(TURN, { stated: true, standing: 'restricted-review', quote: 'want the pattern watched' });
  const row = standingRow({
    caseType: 'physician', caseKey: 'HalPyIorNPSOYBL7KSJy', engineVersion: 'opd-0.81.x+ipd-0.2|90d',
    decision: d, actor: 'admin', turnId: 't-1', model: 'global.anthropic.claude-opus-4-6-v1', windowDays: 90,
  })!;
  assert.equal(row.standing, 'restricted-review');
  assert.equal(row.stated, true, 'inferred never writes — the row says so itself');
  assert.equal(row.authority, STANDING_AUTHORITY);
  assert.equal(row.authority, 'medical_superintendent');
  assert.equal(row.windowDays, 90);
  assert.equal(row.model, 'global.anthropic.claude-opus-4-6-v1');
  assert.equal(row.engineVersion, 'opd-0.81.x+ipd-0.2|90d', 'the standing belongs to the numbers it was said about (A3)');
  assert.equal(PHYSICIAN_STANDING_VERSION, 'physician_standing/1');
});

test('§6.3: a refused decision produces NO row, and neither does a keyless one', () => {
  const refused = standingDecision('just asking', null);
  assert.equal(standingRow({ caseType: 'physician', caseKey: 'k', engineVersion: 'e', decision: refused, actor: 'admin', turnId: 't', model: 'm', windowDays: 90 }), null);
  const ok = standingDecision(TURN, { stated: true, standing: 'concern', quote: 'a concern' });
  for (const missing of [{ caseKey: '' }, { caseType: '' }, { engineVersion: '' }, { turnId: '' }]) {
    assert.equal(
      standingRow({ caseType: 'physician', caseKey: 'k', engineVersion: 'e', decision: ok, actor: 'admin', turnId: 't', model: 'm', windowDays: 90, ...missing }),
      null, `a row with ${JSON.stringify(missing)} must not be built`);
  }
});

// ── acceptance #5 / #8 / #9: nothing moves ────────────────────────────────────────────────

test('acceptance #5 / #8: no file on the overlay path writes a score, a band or a pill', () => {
  for (const f of [CORE, STORE, MIGRATION, MIGRATE_ROUTE, ASK_ROUTE]) {
    const src = code(f).replace(/^\s*--.*$/gm, '');
    for (const forbidden of ['opd_note_audits', 'ipd_discharge_audits', 'opd_audit_feedback', 'ipd_audit_feedback',
      'note_quality_index', 'care_value_index', 'avoidable']) {
      assert.ok(!src.includes(forbidden), `${f} names ${forbidden}`);
    }
  }
  assert.ok(code(STORE).includes('physician_standing'), 'the store must name the one table it owns');
});

test('§6.3: the overlay is APPEND-ONLY — there is no UPDATE and no DELETE anywhere on the path', () => {
  // "The MS changed his mind on Tuesday" is a SECOND ROW. A standing is a statement a named person
  // made on a date, and rewriting one would destroy the only thing it is evidence of.
  for (const f of [STORE, MIGRATE_ROUTE]) {
    const src = code(f);
    assert.ok(!/\b(UPDATE\s+\w|DELETE\s+FROM|DROP\s+\w|ALTER\s+TABLE)\b/i.test(src), `${f} can modify a stored standing`);
  }
  const ddl = code(MIGRATION).replace(/^\s*--.*$/gm, '');
  assert.ok(!/\bALTER\s+TABLE\b|\bDROP\b|\bUPDATE\b|\bDELETE\b/i.test(ddl), 'migration 0050 must create and nothing else');
  assert.ok(ddl.includes('CREATE TABLE IF NOT EXISTS physician_standing'), 'and it must be idempotent');
  // no unique index that would force an upsert
  assert.ok(!/CREATE\s+UNIQUE\s+INDEX/i.test(ddl), 'a unique key on the case would force overwrite-on-restate');
});

test('§6.3: NO AGGREGATOR CAN READ THE BLOB — the board module cannot even see it', () => {
  // The surest way to keep "aggregators must not read this" true is that the module which computes
  // means and sorts rows does not import the store at all. The PAGE reads it, for a chip.
  for (const f of ['lib/stewardship-board.ts', 'lib/stewardship-danger-core.ts', 'lib/stewardship-canonical.ts',
    'lib/opd-audit-doctor.ts', 'lib/stewardship-ops.ts', 'lib/stewardship-ops-core.ts']) {
    assert.ok(!/physician-standing|physician_standing/.test(code(f)),
      `${f} reads the standing overlay — an aggregator must not (§6.3)`);
  }
  // and nowhere in the tree does a scoring path read the table
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === '__tests__') continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p, out); else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  };
  // The TABLE, in a SQL position — not the version string `physician_standing/1`, which the pure
  // core legitimately declares and which reads nothing.
  const TABLE_READ = /\b(FROM|INTO|UPDATE|JOIN|TABLE(?:\s+IF\s+NOT\s+EXISTS)?|INDEX\s+\w+\s+ON)\s+physician_standing\b/i;
  const readers = [...walk('lib'), ...walk('app')].filter((f) => TABLE_READ.test(code(f)));
  assert.deepEqual(readers.sort(), [
    'app/api/admin/migrate-physician-standing/route.ts',
    'lib/physician-standing-store.ts',
  ], 'exactly two files may touch the table: the store that owns it and the migration that creates it');
});

test('acceptance #9: the overlay writes no gold pill — pilling a finding is still the pill API', () => {
  for (const f of [CORE, STORE, ASK_ROUTE]) {
    assert.ok(!/true_positive|nitpick|contested|finding_ref/.test(code(f)),
      `${f} touches the finding-verdict vocabulary — a standing is about a clinician, not a finding`);
  }
});

// ── the prompt: stewardship only, and OPD does not move a byte ────────────────────────────

test('O5 holds: the overlay clause reaches the stewardship prompt and no other', () => {
  const stew = physicianAskMaterial({
    doctorName: 'Dr A', speciality: 'Internal Medicine',
    own: { n_notes: 5, avg_nqi: 70, pct_ab: 50, avg_appr: 70, avg_presc: 70, avg_doc: 70, avg_complete: 70, pct_low: 10, sum_low: 1, sum_interactions: 0 },
    peers: null, findings: [],
  });
  const p = buildCaseAskPrompt(stew, [], 'why?');
  assert.ok(p.system.includes(STANDING_PROMPT_CLAUSE), 'the stewardship prompt must carry the clause');
  assert.ok(p.system.includes(STANDING_REPLY_SCHEMA), 'and the reply schema that has a slot for it');
  assert.match(STANDING_PROMPT_CLAUSE, /never what you conclude/);
  assert.match(STANDING_PROMPT_CLAUSE, /a paraphrase is discarded/);
  assert.match(STANDING_PROMPT_CLAUSE, /You never propose a standing/);

  // OPD is untouched, byte for byte — O5 gave it no overlay and this ship does not change that.
  const opd = opdAskMaterial({ note_quality_index: 57, band: 'C', findings: [] }, 'opd-note-audit/0.81.21');
  assert.equal(opd.overlay, undefined);
  const opdPrompt = buildCaseAskPrompt(opd, [], 'why?');
  assert.ok(!opdPrompt.system.includes('overlay'), 'the OPD prompt must not learn the word');
  assert.match(opdPrompt.system, /Return STRICT JSON only: \{"answer": "<your answer with \[id\] markers>", "answerable": true\|false\} — nothing before or after it\.$/);
});

test('the shell carries an overlay claim without understanding it', () => {
  const parsed = parseAskReply('{"answer":"Their mean is below the department [C2].","answerable":true,"overlay":{"stated":true,"standing":"concern","quote":"a concern"}}');
  assert.equal(parsed?.answer, 'Their mean is below the department [C2].');
  assert.deepEqual(parsed?.overlay, { stated: true, standing: 'concern', quote: 'a concern' });
  // a reply with no overlay key produces no overlay key — a surface that never asked cannot receive
  const plain = parseAskReply('{"answer":"x [F1]","answerable":true}');
  assert.equal('overlay' in (plain as object), false);
  // and the shell does not validate it: that is the gate's job, and it is the gate that is tested
  const material: CaseAskMaterial = { caseType: 'physician', engineVersion: 'e', items: [], gaps: [], overlay: { clause: 'C', schema: 'S' } };
  assert.match(buildCaseAskPrompt(material, [], 'q').system, /8\. C\nS$/);
});

// ── the route's wiring ────────────────────────────────────────────────────────────────────

test('the route runs the gate, and a refusal is silent rather than a 500', () => {
  const src = code(ASK_ROUTE);
  assert.ok(src.includes('standingDecision'), 'the route must run the §12.3 gate');
  assert.ok(src.includes('if (!decision.write) return;'), 'a refusal must return quietly — the turn is already stored');
  assert.ok(src.includes('appendStanding'), 'and a passing decision must be persisted');
  // the shell fences the hook so an overlay fault never costs the answer
  // read(), not code(): the fence's reason lives in the comment, and the comment is the evidence
  // that the swallow is deliberate rather than an empty catch someone left behind.
  assert.match(read('lib/case-ask/serve.ts'), /catch \{ \/\* an overlay is never worth a 500/);
  // OPD and IPD pass no hook at all — there is no path for one of their turns to write anything
  for (const f of ['app/api/admin/opd-audit-ask/route.ts', 'app/api/admin/ipd-audit-ask/route.ts']) {
    assert.ok(!/onStatedOverlay/.test(read(f)), `${f} must not grow an overlay path (O5)`);
  }
});

test('the current-standing read is not filtered by engine version, and the version is still stored', () => {
  // A3 makes the thread key a FAMILY string so a patch bump does not abandon a thread. A standing
  // keyed to that thread must survive the same bump, or the board silently drops every judgement the
  // day a version moves.
  const q = STANDING_INFERRED_SQL.standing_current;
  assert.match(q, /SELECT DISTINCT ON \(case_type, case_key\)/);
  assert.match(q, /ORDER BY case_type, case_key, created_at DESC/);
  assert.ok(!/engine_version/.test(q), 'the current read must not filter by engine version');
  assert.match(STANDING_INFERRED_SQL.standing_insert, /engine_version/, 'but every row must still store it');
});

test('the advisory says the thing the chip could otherwise be mistaken for', () => {
  assert.match(STANDING_ADVISORY, /does not change the note-quality index, the Care-Value Index, any band, or any finding’s verdict/);
  assert.ok(code('app/admin/stewardship/page.tsx').includes('STANDING_ADVISORY'), 'the board must carry it');
});
