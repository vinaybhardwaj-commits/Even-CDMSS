/**
 * lib/__tests__/lvc-rule-merge.test.ts — LVC RULEBOOK REPAIR PRD v1.1 Phase 1, 25 Aug 2026.
 *
 *   node --test --import tsx lib/__tests__/lvc-rule-merge.test.ts
 *
 * Mirrors lvc-ratified-wording.test.ts's discipline. Two things can go wrong with a merge and both
 * are asserted rather than trusted:
 *   (a) the RECORD SET is wrong — an id in two clusters, an id invented, a keyword that would make
 *       a rule a catch-all, a category outside the taxonomy;
 *   (b) the WRITE is wrong — not readback-first, not idempotent, or a partial failure reported as
 *       a success.
 *
 * ⚠️ WHAT IS NOT ASSERTED HERE, AND WHY. PRD's test 7 asks that every precondition round-trip
 * byte-for-byte between the module and migrations/0041. That is IMPOSSIBLE and must be: D-18 puts
 * the rule content in the ratification surface, and the file contract says 0041 carries only the
 * merged_into column. A draft that a human will edit on screen has no byte-exact record to anchor
 * to. What IS anchored is (i) that 0041 contains NO rule content at all, and (ii) that the two
 * RATIFIED preconditions (R3, R5) are byte-identical to lib/lvc-ratified-wording.ts — the texts V
 * actually signed, which are imported rather than retyped so they cannot drift. See the report.
 *
 * The fake runner is not a Postgres: it implements the semantics of the exported statements, matched
 * by identity against the constants the production routes send. That tests the runner's own logic —
 * which ids, in which order, with which parameters, counted how — and leaves the SQL strings to
 * live validation, which is why the build report lists them verbatim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MERGE_RULES, MERGE_RECORD_SET, MOLECULE_ALLOWLIST, DEFAULT_AUTHOR, RETIRED_STATUS,
  MERGE_READBACK_SQL, SURVIVOR_UPDATE_SQL, ABSORBED_UPDATE_SQL, MERGE_DDL_STATEMENTS,
  applyRuleMerge, recordSetIds, validateRecords, keywordError, categoryError, ratifierError,
  parseKeywordColumn, sameKeywords,
  type MergedRule, type SqlRunner,
} from '../lvc-rule-merge';
import { LVC_CATEGORIES } from '../opd-lvc-classify-core';
import { RATIFIED_PRECONDITIONS } from '../lvc-ratified-wording';
import {
  acceptRuleMerge, rejectRule, deriveProgress, previousValues, assembleSurfaceState,
  LEDGER_ANCHOR_INSERT_SQL, LEDGER_INSERT_SQL, getRecordSet,
} from '../lvc-ratify-surface-core';
import { compareSample, buildProposedRules, classifyChange, summarise } from '../lvc-merge-compare';

const MIGRATION = 'migrations/0041_lvc_rule_merge.sql';
const RATIFIER = 'V (Dr Vinay Bhardwaj)';

// ── 1–3: the shape of the record set ──────────────────────────────────────────────────────────

test('1: 19 survivors, 48 absorbed, and the two sets do not intersect', () => {
  assert.equal(MERGE_RULES.length, 19, 'the 19 concepts of PRD §3.2');
  const survivors = MERGE_RULES.map((r) => r.id);
  const absorbed = MERGE_RULES.flatMap((r) => r.absorbs);
  assert.equal(absorbed.length, 48, 'the PRD totals line: 19 survivors + 48 absorbed = 67');
  assert.equal(new Set(survivors).size, 19, 'no survivor id is repeated');
  const survivorSet = new Set(survivors);
  for (const id of absorbed) assert.ok(!survivorSet.has(id), `${id} is both a survivor and absorbed`);
  assert.deepEqual(MERGE_RULES.map((r) => r.section), Array.from({ length: 19 }, (_, i) => `R${i + 1}`));
});

test('2: every absorbed id appears exactly once across all records', () => {
  const absorbed = MERGE_RULES.flatMap((r) => r.absorbs);
  assert.equal(new Set(absorbed).size, absorbed.length, 'an id absorbed twice would retire into two survivors');
  // and the validator says so too, rather than only this test knowing it
  const clash: MergedRule[] = [
    { ...MERGE_RULES[0] },
    { ...MERGE_RULES[1], absorbs: [...MERGE_RULES[1].absorbs, MERGE_RULES[0].absorbs[0]] },
  ];
  assert.match(validateRecords(clash).join(' | '), /appears in both R1 and R2/);
});

test('3: survivors + absorbed are 67 distinct house rule ids, none invented', () => {
  const ids = recordSetIds(MERGE_RULES);
  assert.equal(ids.length, 67, '67 house rules accounted for exactly once');
  assert.equal(new Set(ids).size, 67, 'no id touched twice');
  for (const id of ids) {
    assert.match(id, /^ehrc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      `${id} is not a full lvc_recommendations.id — PRD §3.2 prints an 8-char SHORT FORM and it must be resolved, never shipped`);
  }
  // The two rows retired by migration 0034 are house rules and are therefore in the 67. Absorbing
  // them is what finally gives them a `merged_into` trail (§6.6).
  const absorbed = new Set(MERGE_RULES.flatMap((r) => r.absorbs));
  assert.ok(absorbed.has('ehrc-fe8f229b-d818-4e40-a360-367fa85bfb02'), 'the 0034 D-5a retirement is absorbed by R3');
  assert.ok(absorbed.has('ehrc-cdfcf3bc-b737-4058-91af-600b5ca414fd'), 'the 0034 D-5b retirement is absorbed by R1');
});

// ── 4–6: content guards ───────────────────────────────────────────────────────────────────────

test('4: every category is a member of LVC_CATEGORIES', () => {
  assert.equal(LVC_CATEGORIES.length, 12, 'the taxonomy is 12 members');
  for (const r of MERGE_RULES) {
    assert.ok((LVC_CATEGORIES as readonly string[]).includes(r.category), `${r.section} category '${r.category}'`);
    assert.equal(categoryError(r.category), null);
  }
  assert.match(categoryError('made_up') ?? '', /not one of LVC_CATEGORIES/);
  assert.match(categoryError('') ?? '', /empty/);
});

test('5: no keyword is a single token, except entries on the molecule allowlist', () => {
  for (const r of MERGE_RULES) {
    for (const k of r.keywords) {
      const err = keywordError(k);
      if (err) assert.fail(`${r.section}: ${err}`);
      // Hyphens and slashes are word breaks for the guard (see keywordError): `safety-netting` is a
      // two-word compound, so only a genuinely lone word needs the allowlist.
      if (k.split(/[\s/-]+/).filter(Boolean).length === 1) {
        assert.ok(MOLECULE_ALLOWLIST.includes(k.toLowerCase()), `${r.section}: '${k}' is a lone token and is not allowlisted`);
      }
    }
  }
  // The guard is the thing that matters, so prove it bites where it must and not where it must not.
  assert.match(keywordError('blood') ?? '', /single token/);
  assert.match(keywordError('vitamin') ?? '', /single token/);
  assert.match(keywordError('diagnosis') ?? '', /single token/);
  assert.equal(keywordError('serratiopeptidase'), null, 'the molecule allowlist');
  assert.equal(keywordError('cholecalciferol'), null, 'the molecule allowlist — flagged deviation, PRD §3.4 R4');
  assert.equal(keywordError('safety-netting'), null, 'a hyphenated compound is a phrase, not a stopword');
  assert.equal(keywordError('follow-up advice'), null);
  assert.equal(keywordError('complete blood profile'), null);
  // exactly two entries, so an allowlist that quietly grows is caught in review
  assert.deepEqual([...MOLECULE_ALLOWLIST], ['serratiopeptidase', 'cholecalciferol']);
  // and that it bites BEFORE any write
  const bad = [{ ...MERGE_RULES[6], keywords: ['blood'] }];
  assert.match(validateRecords(bad).join(' | '), /R7 \(ehrc-a98ce8c5-[0-9a-f-]+\): "blood" is a single token/);
});

test('6: no keyword is empty or whitespace after trimming, and no rule is keyword-less', () => {
  for (const r of MERGE_RULES) {
    assert.ok(r.keywords.length > 0, `${r.section} has no keywords and could never match`);
    for (const k of r.keywords) {
      assert.equal(k, k.trim(), `${r.section}: '${k}' has untrimmed whitespace`);
      assert.ok(k.length > 0);
    }
    assert.ok(r.statement.trim().length > 0, `${r.section} statement`);
    assert.ok(r.precondition.trim().length > 0, `${r.section} precondition`);
  }
  assert.match(keywordError('   ') ?? '', /empty/);
  assert.match(validateRecords([{ ...MERGE_RULES[0], keywords: [] }]).join(' | '), /no keywords/);
});

// ── 7 (as amended): the two RATIFIED texts, and the migration carries no rule content ─────────

test('7: R3 and R5 carry V\'s 10 Aug ratified preconditions byte-for-byte', () => {
  const ratifiedByPrdSection = new Map(RATIFIED_PRECONDITIONS.map((p) => [p.section, p]));
  const r3 = MERGE_RULES.find((r) => r.section === 'R3')!;
  const r5 = MERGE_RULES.find((r) => r.section === 'R5')!;

  const safetyNetting = ratifiedByPrdSection.get('3.2')!;
  const antibioticUri = ratifiedByPrdSection.get('3.1')!;

  assert.equal(r3.id, safetyNetting.id, 'R3 IS the safety-netting rule V ratified');
  assert.equal(r5.id, antibioticUri.id, 'R5 IS the antibiotic/URI rule V ratified');
  assert.equal(r3.precondition, safetyNetting.precondition, 'R3 precondition drifted from the ratified text');
  assert.equal(r3.precondition.length, safetyNetting.precondition.length, 'no whitespace difference either');
  assert.equal(r5.precondition, antibioticUri.precondition, 'R5 precondition drifted from the ratified text');
  assert.equal(r5.precondition.length, antibioticUri.precondition.length);

  // The ratified drafting convention must survive the merge — a fact not in the note is ABSENT.
  assert.match(r3.precondition, /must be read as genuinely missing, not as unknown/);
  assert.match(r5.precondition, /insufficient information/);
});

test('7b: NO rule content reaches migrations/0041 — the surface is the write (D-18)', () => {
  const sqlFile = readFileSync(MIGRATION, 'utf8');
  for (const r of MERGE_RULES) {
    assert.ok(!sqlFile.includes(r.statement), `${r.section}'s statement must not be in ${MIGRATION}`);
    assert.ok(!sqlFile.includes(r.precondition), `${r.section}'s precondition must not be in ${MIGRATION}`);
    assert.ok(!sqlFile.includes(`'${r.id}'`), `${r.section}'s id must not be in ${MIGRATION}`);
  }
  assert.ok(!/\bUPDATE\b|\bINSERT\b/i.test(sqlFile), 'schema only: no data statement');
  assert.ok(!/\$txt\$/.test(sqlFile), 'no dollar-quoted clinical text');
});

// ── 8: the migration's own ban ────────────────────────────────────────────────────────────────

test('8: 0041 has no DROP/DELETE/TRUNCATE, and its only ALTER is ADD COLUMN IF NOT EXISTS', () => {
  const sqlFile = readFileSync(MIGRATION, 'utf8');
  // Strip comments first: the header explains WHY there is no data statement, and the words in the
  // prose must not be mistaken for statements. (The pins-must-strip-comments lesson.)
  const code = sqlFile.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  assert.ok(!/\bDROP\b/i.test(code), 'no DROP');
  assert.ok(!/\bDELETE\b/i.test(code), 'no DELETE');
  assert.ok(!/\bTRUNCATE\b/i.test(code), 'no TRUNCATE');
  const alters = code.match(/\bALTER\s+TABLE\b[^;]*/gi) ?? [];
  assert.equal(alters.length, 1, 'exactly one ALTER');
  assert.match(alters[0], /ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS merged_into TEXT/);
  assert.match(code, /CREATE INDEX IF NOT EXISTS lvc_merged_into_idx ON lvc_recommendations \(merged_into\)/);
  assert.match(code, /COMMENT ON COLUMN lvc_recommendations\.merged_into/);
});

test('8b: the shipped DDL constants and the .sql record cannot drift', () => {
  const code = readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const normalisedFile = norm(code);
  for (const stmt of MERGE_DDL_STATEMENTS) {
    assert.ok(normalisedFile.includes(norm(stmt)), `missing from ${MIGRATION}: ${stmt.slice(0, 70)}…`);
  }
  assert.equal(MERGE_DDL_STATEMENTS.length, 3, 'column, comment, index — nothing else');
});

// ── the fake database ─────────────────────────────────────────────────────────────────────────

interface FakeRow {
  id: string; statement: string | null; precondition: string | null; keywords: string[];
  category: string | null; citation_url: string | null; status: string | null;
  merged_into: string | null; ratified_by: string | null; ratified_at: string | null;
}

/**
 * An in-memory `lvc_recommendations` + the two ledger tables, implementing the documented semantics
 * of the exported statements — read by id set, and update ONLY when a targeted column differs
 * (IS DISTINCT FROM), returning the id when it did. Counts every statement so call shape is
 * assertable too. `fail` makes one statement throw, which is how partial failure is tested.
 */
function fakeDb(seed: FakeRow[], fail?: (sqlText: string, params: unknown[]) => boolean) {
  const rows = new Map(seed.map((r) => [r.id, { ...r, keywords: [...r.keywords] }]));
  const calls: { sql: string; params: unknown[] }[] = [];
  const proposals: Record<string, unknown>[] = [];
  const ratifications: Record<string, unknown>[] = [];
  let anchorSeq = 0;

  const run: SqlRunner = async (text, params) => {
    calls.push({ sql: text, params });
    if (fail?.(text, params)) throw new Error('simulated write failure');

    if (text === MERGE_READBACK_SQL) {
      const ids = new Set((params[0] as string[]) ?? []);
      return [...rows.values()].filter((r) => ids.has(r.id)).map((r) => ({ ...r, keywords: [...r.keywords] }));
    }
    if (text === SURVIVOR_UPDATE_SQL) {
      const [id, statement, precondition, keywords, category, citationUrl, by] =
        params as [string, string, string, string[], string, string | null, string];
      const r = rows.get(id);
      if (!r) return [];
      const same = r.statement === statement && r.precondition === precondition
        && sameKeywords(r.keywords, keywords) && r.category === category
        && r.citation_url === citationUrl && r.ratified_by === by;
      if (same) return [];
      Object.assign(r, { statement, precondition, keywords: [...keywords], category, citation_url: citationUrl, ratified_by: by, ratified_at: 'now' });
      return [{ id }];
    }
    if (text === ABSORBED_UPDATE_SQL) {
      const [id, status, mergedInto, by] = params as [string, string, string, string];
      const r = rows.get(id);
      if (!r) return [];
      if (r.status === status && r.merged_into === mergedInto && r.ratified_by === by) return [];
      Object.assign(r, { status, merged_into: mergedInto, ratified_by: by, ratified_at: 'now' });
      return [{ id }];
    }
    if (text === LEDGER_ANCHOR_INSERT_SQL) {
      const id = `00000000-0000-4000-8000-${String(++anchorSeq).padStart(12, '0')}`;
      proposals.push({ id, params });
      return [{ id }];
    }
    if (text === LEDGER_INSERT_SQL) {
      ratifications.push({ params });
      return [{ id: String(ratifications.length) }];
    }
    throw new Error(`unexpected SQL: ${text.slice(0, 60)}`);
  };
  return { run, rows, calls, proposals, ratifications };
}

/** The table as it stands today: every row present, unmerged, un-ratified. */
const preMergeRows = (records: MergedRule[] = MERGE_RULES): FakeRow[] =>
  recordSetIds(records).map((id) => ({
    id,
    statement: `the old mined statement for ${id}`,
    precondition: null,
    keywords: ['old', 'shattered', 'tokens'],
    category: null,
    citation_url: null,
    status: 'active',
    merged_into: null,
    ratified_by: null,
    ratified_at: null,
  }));

const writeCalls = (calls: { sql: string }[]) => calls.filter((c) => c.sql !== MERGE_READBACK_SQL);

// ── 9–13: the runner ──────────────────────────────────────────────────────────────────────────

test('9: the readback runs FIRST, so a broken schema writes nothing at all', async () => {
  const attempted: string[] = [];
  const run: SqlRunner = async (text) => { attempted.push(text); throw new Error('column "merged_into" does not exist'); };
  const r = await applyRuleMerge(run, { ratifiedBy: RATIFIER });
  assert.equal(r.ok, false);
  assert.equal(r.changed, 0);
  assert.match(r.error ?? '', /readback failed, nothing written/);
  assert.deepEqual(attempted, [MERGE_READBACK_SQL], 'exactly one statement was ever sent, and it was a SELECT');
});

test('10: IDEMPOTENCE — the second run changes zero rows', async () => {
  const db = fakeDb(preMergeRows());
  const first = await applyRuleMerge(db.run, { ratifiedBy: RATIFIER });
  assert.equal(first.ok, true, first.error ?? '');
  assert.equal(first.changed, 67, 'every survivor and every absorbed row written once');
  assert.equal(first.verified, true, 'the post-write readback confirms every row');

  const second = await applyRuleMerge(db.run, { ratifiedBy: RATIFIER });
  assert.equal(second.ok, true, second.error ?? '');
  assert.equal(second.changed, 0, 'RE-RUNNING THE MERGE MUST CHANGE ZERO ROWS');
  assert.equal(second.unchanged, 67);
  assert.equal(second.verified, true, 'and the rows still read back exactly');

  const third = await applyRuleMerge(db.run, { ratifiedBy: RATIFIER });
  assert.equal(third.changed, 0, 'and stays at zero');
});

test('11: a dry run reads and plans without writing', async () => {
  const db = fakeDb(preMergeRows());
  const r = await applyRuleMerge(db.run, { ratifiedBy: RATIFIER, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.rows.filter((x) => x.result === 'updated').length, 67, '67 rows WOULD change');
  assert.deepEqual(db.calls.map((c) => c.sql), [MERGE_READBACK_SQL], 'no UPDATE was sent');
  assert.equal(db.rows.get(MERGE_RULES[0].id)!.precondition, null, 'and the table is untouched');
});

test('12: a missing survivor id yields result:missing and ok:false', async () => {
  const db = fakeDb(preMergeRows().filter((r) => r.id !== MERGE_RULES[3].id));
  const r = await applyRuleMerge(db.run, { ratifiedBy: RATIFIER });
  assert.equal(r.ok, false, 'a missing row is not a success');
  assert.equal(r.missing, 1);
  assert.ok(r.rows.some((x) => x.id === MERGE_RULES[3].id && x.result === 'missing'));
  assert.equal(r.verified, false);
});

test('13: merged_into is set on every absorbed row and on no survivor row', async () => {
  const db = fakeDb(preMergeRows());
  await applyRuleMerge(db.run, { ratifiedBy: RATIFIER });
  for (const rec of MERGE_RULES) {
    assert.equal(db.rows.get(rec.id)!.merged_into, null, `${rec.section} survivor must keep merged_into NULL`);
    assert.equal(db.rows.get(rec.id)!.status, 'active', 'a survivor stays active');
    for (const id of rec.absorbs) {
      const row = db.rows.get(id)!;
      assert.equal(row.merged_into, rec.id, `${id} must point at ${rec.section}`);
      assert.equal(row.status, RETIRED_STATUS);
      assert.equal(row.statement, `the old mined statement for ${id}`, 'a retirement never rewrites the variant\'s text');
      assert.equal(row.precondition, null, 'nor its precondition');
    }
  }
});

test('13b: a bad ratifier is refused before the database is touched at all', async () => {
  const attempted: string[] = [];
  const run: SqlRunner = async (t) => { attempted.push(t); return []; };
  for (const who of ['', '   ', DEFAULT_AUTHOR, 'x']) {
    const r = await applyRuleMerge(run, { ratifiedBy: who });
    assert.equal(r.ok, false, `'${who}' must be refused`);
    assert.equal(r.changed, 0);
  }
  assert.deepEqual(attempted, [], 'not one statement was sent');
  assert.match(ratifierError(DEFAULT_AUTHOR) ?? '', /must not be the default/);
  assert.equal(ratifierError(RATIFIER), null);
});

// ── 14: the comparison tool must call the exported matcher ────────────────────────────────────

test('14: the comparison tool calls the exported matchLvcRule and owns no matcher of its own', () => {
  // §6.7 — "If a copy is written, it will drift and the evidence will be worthless." An ESM
  // namespace is frozen, so the import cannot be monkey-patched; the check is therefore made
  // structurally AND behaviourally, and both bite on a reimplementation.
  const src = readFileSync('lib/lvc-merge-compare.ts', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

  // (a) STRUCTURAL — it imports the export, and it builds no matcher machinery.
  assert.match(code, /import\s*\{[^}]*\bmatchLvcRule\b[^}]*\}\s*from\s*'\.\/opd-lvc-classify-core'/,
    'lvc-merge-compare must import matchLvcRule from the matcher core');
  assert.match(code, /\bmatchLvcRule\s*\(/, 'and actually call it');
  assert.ok(!/new RegExp|\\\\b|\.test\(hay|escapeRe|bestMatchedTokens|keywordMatches/.test(code),
    'no private regex/keyword matcher may exist here — that is the drift §6.7 forbids');

  // (b) BEHAVIOURAL — the v3.1 tie rule. Two rules match at the SAME top specificity, so the shared
  // matcher returns null. A hand-rolled matcher that picked a winner (the pre-v3.1 lowest-id
  // tiebreak, say) would return a rule id here and this fails.
  const tie = [
    { id: 'rule-a', keywords: ['pelvic ultrasound'], category: null },
    { id: 'rule-b', keywords: ['ultrasound pelvic'], category: null },
  ];
  const out = compareSample(
    [{ note_id: 'n1', subject: 'Pelvic ultrasound ordered', rationale: null, stored_rule_ref: null }],
    tie, [],
  );
  assert.equal(out[0].old_rule_ref, null, 'an ambiguous attribution must stay null — the shared matcher\'s v3.1 rule');
  assert.equal(out[0].new_rule_ref, null);
  assert.equal(out[0].change, 'unchanged');
});

test('14b: the comparison classifies the five change classes and writes nothing', () => {
  const r7 = MERGE_RULES.find((r) => r.section === 'R7')!;
  const absorbedId = r7.absorbs[0];
  const live = [
    { id: absorbedId, keywords: ['complete blood profile testing'], category: null },
    { id: r7.id, keywords: ['complete blood profile'], category: null },
    { id: 'unrelated-rule', keywords: ['pelvic ultrasound'], category: null },
  ];

  // buildProposedRules drops the absorbed rule and re-keywords the survivor.
  const proposed = buildProposedRules(live, [r7]);
  assert.ok(!proposed.some((p) => p.id === absorbedId), 'an absorbed rule leaves the matcher pool');
  assert.deepEqual(proposed.find((p) => p.id === r7.id)!.keywords, r7.keywords);

  assert.equal(classifyChange(null, null, [r7]), 'unchanged');
  assert.equal(classifyChange('x', 'x', [r7]), 'unchanged');
  assert.equal(classifyChange(null, r7.id, [r7]), 'newly_matched');
  assert.equal(classifyChange(r7.id, null, [r7]), 'lost_match');
  assert.equal(classifyChange(absorbedId, r7.id, [r7]), 'moved_to_survivor');
  assert.equal(classifyChange('unrelated-rule', r7.id, [r7]), 'changed_concept');

  const compared = compareSample(
    [{ note_id: 'n1', subject: 'Complete blood profile testing without indication', rationale: null, stored_rule_ref: absorbedId }],
    live, [r7],
  );
  assert.equal(compared.length, 1);
  assert.equal(compared[0].old_rule_ref, absorbedId, 'the longer phrase wins under the live rulebook');
  assert.equal(compared[0].new_rule_ref, r7.id, 'and the survivor takes it afterwards');
  assert.equal(compared[0].change, 'moved_to_survivor');
  const s = summarise(compared);
  assert.equal(s.sampled, 1);
  assert.equal(s.counts.moved_to_survivor, 1);
});

// ── 15–20: the surface ────────────────────────────────────────────────────────────────────────

test('15: a single-record accept writes one survivor update, one retirement per absorbed id, one ledger row', async () => {
  const record = MERGE_RULES.find((r) => r.section === 'R10')!;   // the Gate A rule: 3 absorbed
  const db = fakeDb(preMergeRows([record]));
  const r = await acceptRuleMerge(db.run, { record, ratifiedBy: RATIFIER, rationale: 'phase 1 sitting' });

  assert.equal(r.ok, true, r.error ?? '');
  assert.equal(r.progress, 'accepted');
  assert.equal(r.ledger, 'written');

  const writes = writeCalls(db.calls);
  assert.deepEqual(writes.map((c) => c.sql), [
    SURVIVOR_UPDATE_SQL,
    ABSORBED_UPDATE_SQL, ABSORBED_UPDATE_SQL, ABSORBED_UPDATE_SQL,
    LEDGER_ANCHOR_INSERT_SQL,
    LEDGER_INSERT_SQL,
  ], 'survivor → each absorbed → ledger anchor → ledger row, in that order and nothing else');
  assert.equal(db.ratifications.length, 1, 'exactly one ledger row');
  assert.equal(db.proposals.length, 1, 'exactly one anchor');

  // and no OTHER rule was touched
  assert.equal(db.rows.size, 4);
});

test('15b: a repeat accept is inert — no rulebook write and NO duplicate ledger row', async () => {
  const record = MERGE_RULES.find((r) => r.section === 'R10')!;
  const db = fakeDb(preMergeRows([record]));
  await acceptRuleMerge(db.run, { record, ratifiedBy: RATIFIER, rationale: 'first' });
  const before = db.ratifications.length;

  const again = await acceptRuleMerge(db.run, { record, ratifiedBy: RATIFIER, rationale: 'second' });
  assert.equal(again.ok, true, again.error ?? '');
  assert.equal(again.merge.changed, 0, 'the guards make the second press change nothing');
  assert.equal(again.ledger, 'skipped_unchanged');
  assert.equal(db.ratifications.length, before, 'an append-only ledger must not fill with identical rows');
  assert.equal(again.progress, 'accepted');
});

test('16: the ledger row carries the survivor\'s PREVIOUS statement, precondition, keywords and category (D-20)', async () => {
  const record = MERGE_RULES.find((r) => r.section === 'R17')!;
  const seed = preMergeRows([record]);
  const survivor = seed.find((s) => s.id === record.id)!;
  survivor.statement = 'Avoid: Therapeutic duplication of antihistamines';
  survivor.precondition = null;
  survivor.keywords = ['therapeutic', 'duplication', 'antihistamines'];
  survivor.category = null;

  const db = fakeDb(seed);
  const r = await acceptRuleMerge(db.run, { record, ratifiedBy: RATIFIER, rationale: 'merge sitting' });
  assert.equal(r.ok, true, r.error ?? '');

  const anchorParams = db.proposals[0].params as unknown[];
  const payload = JSON.parse(String(anchorParams[2]));
  assert.equal(payload.kind, 'lvc-rule-merge');
  assert.equal(payload.section, 'R17');
  assert.equal(payload.survivor_id, record.id);
  assert.deepEqual(payload.absorbs, record.absorbs);
  assert.equal(payload.previous.statement, 'Avoid: Therapeutic duplication of antihistamines', 'the text that was overwritten');
  assert.equal(payload.previous.precondition, null);
  assert.deepEqual(payload.previous.keywords, ['therapeutic', 'duplication', 'antihistamines'], 'the word-shattered keywords, kept so a correction is writable');
  assert.equal(payload.previous.category, null);
  assert.equal(payload.accepted.statement, record.statement);
  assert.deepEqual(payload.accepted.keywords, record.keywords);

  // and the ledger row names the ratifier and the survivor
  const ledgerParams = db.ratifications[0].params as unknown[];
  assert.equal(ledgerParams[1], 'ratified');
  assert.equal(ledgerParams[2], RATIFIER);
  assert.equal(ledgerParams[5], record.id);

  // previousValues is the one place that payload comes from
  assert.deepEqual(previousValues(undefined), { statement: null, precondition: null, keywords: [], category: null, citation_url: null });
});

test('17: a partial failure reports which rows landed and leaves the rule partially_applied (§6.10)', async () => {
  const record = MERGE_RULES.find((r) => r.section === 'R10')!;
  const failingId = record.absorbs[1];
  const db = fakeDb(
    preMergeRows([record]),
    (sqlText, params) => sqlText === ABSORBED_UPDATE_SQL && params[0] === failingId,
  );
  const r = await acceptRuleMerge(db.run, { record, ratifiedBy: RATIFIER, rationale: 'sitting' });

  assert.equal(r.ok, false, 'a half-applied merge is NOT a success');
  assert.equal(r.progress, 'partially_applied', 'and it must not render as accepted');
  // exactly which rows landed:
  const landed = r.merge.rows.filter((x) => x.result === 'updated').map((x) => x.id);
  const errored = r.merge.rows.filter((x) => x.result === 'error').map((x) => x.id);
  assert.deepEqual(errored, [failingId]);
  assert.ok(landed.includes(record.id), 'the survivor landed');
  assert.ok(landed.includes(record.absorbs[0]) && landed.includes(record.absorbs[2]), 'the other two landed');
  assert.equal(db.rows.get(failingId)!.merged_into, null, 'and the failed one really is untouched');

  // pressing accept again completes it, because every write is independently guarded
  const db2 = fakeDb([...db.rows.values()]);
  const retry = await acceptRuleMerge(db2.run, { record, ratifiedBy: RATIFIER, rationale: 'retry' });
  assert.equal(retry.ok, true, retry.error ?? '');
  assert.equal(retry.merge.changed, 1, 'only the row that had failed is written');
  assert.equal(retry.progress, 'accepted');
});

test('17b: rulebook writes that land with a failed ledger are reported, never hidden', async () => {
  const record = MERGE_RULES.find((r) => r.section === 'R14')!;
  const db = fakeDb(preMergeRows([record]), (sqlText) => sqlText === LEDGER_ANCHOR_INSERT_SQL);
  const r = await acceptRuleMerge(db.run, { record, ratifiedBy: RATIFIER, rationale: 'sitting' });
  assert.equal(r.ok, false);
  assert.equal(r.ledger, 'failed');
  assert.match(r.error ?? '', /rulebook writes landed but the ledger row did not/);
  assert.equal(r.merge.changed, 2, 'the merge itself did land, and says so');
});

test('18: progress derivation is PURE — same inputs, same progress, no session state', () => {
  const record = MERGE_RULES.find((r) => r.section === 'R14')!;
  const cur = (over: Partial<Record<string, unknown>> = {}) => new Map([
    [record.id, {
      id: record.id, statement: record.statement, precondition: record.precondition,
      keywords: record.keywords, category: record.category, citationUrl: record.citation_url,
      status: 'active', mergedInto: null, ratifiedBy: RATIFIER, ratifiedAt: 'x', ...over,
    }],
    [record.absorbs[0], {
      id: record.absorbs[0], statement: 'old', precondition: null, keywords: [], category: null,
      citationUrl: null, status: RETIRED_STATUS, mergedInto: record.id, ratifiedBy: RATIFIER, ratifiedAt: 'x',
    }],
  ] as Array<[string, Parameters<typeof deriveProgress>[1] extends Map<string, infer V> ? V : never]>);

  assert.equal(deriveProgress(record, cur(), []), 'accepted');
  // idempotent in the mathematical sense: calling it again cannot give a different answer
  assert.equal(deriveProgress(record, cur(), []), 'accepted');
  assert.equal(deriveProgress(record, cur({ statement: 'something else' }), []), 'partially_applied');
  assert.equal(deriveProgress(record, new Map(), []), 'missing');

  // nothing applied + a ledger rejection ⇒ rejected; without the ledger ⇒ pending
  const untouched = new Map(cur({ statement: 'old', precondition: null, keywords: [], category: null }));
  untouched.set(record.absorbs[0], { ...untouched.get(record.absorbs[0])!, status: 'active', mergedInto: null });
  assert.equal(deriveProgress(record, untouched, []), 'pending');
  assert.equal(deriveProgress(record, untouched, [
    { decision: 'rejected', ratified_by: RATIFIER, rationale: 'r', reason: 'not one concept', created_at: 't', survivor_id: record.id },
  ]), 'rejected');
});

test('18b: the surface state degrades honestly when a read is unavailable', () => {
  const set = getRecordSet('phase1-merge');
  assert.equal(set.key, MERGE_RECORD_SET.key);
  assert.equal(getRecordSet('nonsense').key, MERGE_RECORD_SET.key, 'an unknown key falls back, never an empty screen');

  const state = assembleSurfaceState(set, new Map(), new Map(), [], {
    rulebookAvailable: false, firesAvailable: false, ledgerAvailable: false, mergedIntoPresent: false,
  });
  assert.equal(state.rules.length, 19, 'the record set still renders');
  assert.equal(state.rules[0].current, null);
  assert.equal(state.rules[0].absorbs[0].fires, null, 'an unreadable count is null, never a misleading 0');
  assert.equal(state.notes.length, 4, 'every unavailable read says so');
  assert.match(state.notes.join(' '), /Migration 0041 has not been applied/);
});

test('19: a single-token keyword entered on the surface is refused by the SAME validator', async () => {
  const record: MergedRule = { ...MERGE_RULES[6], keywords: ['complete blood profile', 'blood'] };
  // the screen's check
  assert.match(keywordError('blood') ?? '', /single token/);
  // and the write path's, which must agree
  const attempted: string[] = [];
  const run: SqlRunner = async (t) => { attempted.push(t); return []; };
  const r = await acceptRuleMerge(run, { record, ratifiedBy: RATIFIER, rationale: 'sitting' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /"blood" is a single token/);
  assert.equal(r.ledger, 'not_attempted');
  assert.deepEqual(attempted, [], 'refused before the database was touched');
});

test('20: reject writes a ledger row with a reason and ZERO writes to lvc_recommendations', async () => {
  const record = MERGE_RULES.find((r) => r.section === 'R2')!;
  const db = fakeDb(preMergeRows([record]));
  const r = await rejectRule(db.run, { record, ratifiedBy: RATIFIER, rationale: 'sitting', reason: 'these are two concepts, not one' });

  assert.equal(r.ok, true, r.error ?? '');
  assert.equal(r.ledger, 'written');
  const writes = writeCalls(db.calls);
  assert.deepEqual(writes.map((c) => c.sql), [LEDGER_ANCHOR_INSERT_SQL, LEDGER_INSERT_SQL], 'the rulebook is untouched');
  for (const row of db.rows.values()) {
    assert.equal(row.status, 'active');
    assert.equal(row.merged_into, null);
    assert.equal(row.precondition, null, 'nothing was written to any rule');
  }
  const ledgerParams = db.ratifications[0].params as unknown[];
  assert.equal(ledgerParams[1], 'rejected');
  assert.equal(ledgerParams[4], 'these are two concepts, not one', 'the reason is on the ledger');

  const noReason = await rejectRule(db.run, { record, ratifiedBy: RATIFIER, rationale: 'x', reason: '  ' });
  assert.equal(noReason.ok, false);
  assert.match(noReason.error ?? '', /reason is required/);
});

// ── shape helpers ─────────────────────────────────────────────────────────────────────────────

test('parseKeywordColumn tolerates the shapes a driver can hand back', () => {
  assert.deepEqual(parseKeywordColumn(['a b', 'c d']), ['a b', 'c d']);
  assert.deepEqual(parseKeywordColumn('{"a b","c d"}'), ['a b', 'c d']);
  assert.deepEqual(parseKeywordColumn('{}'), []);
  assert.deepEqual(parseKeywordColumn('["a b"]'), ['a b']);
  assert.deepEqual(parseKeywordColumn(null), []);
  assert.equal(sameKeywords(['a'], ['a']), true);
  assert.equal(sameKeywords(['a'], ['a', 'b']), false);
  assert.equal(sameKeywords(null, []), true);
});

test('the record set the surface loads is the 19 merge rules', () => {
  assert.equal(MERGE_RECORD_SET.records, MERGE_RULES);
  assert.equal(MERGE_RECORD_SET.key, 'phase1-merge');
  assert.equal(validateRecords(MERGE_RULES).length, 0, 'the shipped record set is valid by its own validator');
});
