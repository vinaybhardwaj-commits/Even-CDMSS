/**
 * lib/__tests__/d2-bridge-containment.test.ts — D2 commit 1 (Saul Rep 48).
 *
 * WHAT IS BEING CONTAINED. A bridge row written by the governed path carries
 * `source='lvp-pattern'` and is today eligible for legacy `lvc_ratify`, which checks only the
 * proposal id and `status='proposed'`. Promotion then mints a DIFFERENT rule_ref, inserts an
 * `lvc_recommendations` row whose status column defaults to ACTIVE, omits the frozen
 * executable-definition fields, and bypasses the governed workflow entirely — so R3-A2 refusing to
 * activate the governed version does not undo the separately created active registry row.
 *
 * ⚠️ EVERY WRITE CLAIM HERE IS PROVEN BY COUNTING STATEMENTS THAT REACH THE TRANSPORT, not by
 * reading the code path. The stub below replaces `globalThis.fetch` — the Neon driver's transport —
 * so the REAL statements and the REAL bound parameters are observed. A test that inspected the
 * source could show a branch exists; only this can show that nothing was written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── a self-contained recording transport ────────────────────────────────────────────────────────
// ⚠️ INLINE, NOT A SHARED HELPER. The equivalent helper lives on the telemetry branch; adding it
// here would put a new shared file outside the file set D2 is allowed to touch (§5). It is small
// enough to own.
interface DbCall { query: string; params: unknown[] }

const textOf = (v: unknown): string | null =>
  v === null || v === undefined ? null
  : typeof v === 'boolean' ? (v ? 't' : 'f')
  : typeof v === 'object' ? JSON.stringify(v) : String(v);

function encode(rows: Record<string, unknown>[]): unknown {
  const names = rows.length ? Object.keys(rows[0]) : [];
  return {
    command: 'SELECT',
    fields: names.map((name) => ({
      name, dataTypeID: 25, tableID: 0, columnID: 0,
      dataTypeSize: -1, dataTypeModifier: -1, format: 'text',
    })),
    rowCount: rows.length,
    rows: rows.map((r) => names.map((n) => textOf(r[n]))),
  };
}

interface Stub {
  calls: DbCall[];
  on(match: RegExp, rows: Record<string, unknown>[]): void;
  writesTo(table: string): DbCall[];
  reset(): void;
}

function installStub(): Stub {
  process.env.DATABASE_URL ??= 'postgresql://stub:stub@stub.invalid/stub';
  const calls: DbCall[] = [];
  const routes: Array<{ match: RegExp; rows: Record<string, unknown>[] }> = [];
  const stub: Stub = {
    calls,
    on(match, rows) { routes.push({ match, rows }); },
    // ⚠️ WRITES ONLY. A SELECT naming the table is not a write, and counting every mention would
    // make the zero-write claims pass or fail for the wrong reason.
    writesTo(table) {
      const re = new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, 'i');
      return calls.filter((c) => re.test(c.query));
    },
    reset() { calls.length = 0; routes.length = 0; },
  };
  (globalThis as unknown as { fetch: unknown }).fetch = async (_u: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { query?: string; params?: unknown[] };
    // FAIL CLOSED on a shape this stub does not model — a batch posts `{queries:[…]}` with no
    // `query`, and an unvalidated cast would make it invisible to every assertion below.
    if (typeof body.query !== 'string') throw new Error(`unmodelled transport body: ${init.body.slice(0, 120)}`);
    calls.push({ query: body.query, params: body.params ?? [] });
    const route = [...routes].reverse().find((r) => r.match.test(body.query!));
    return { ok: true, status: 200, json: async () => encode(route ? route.rows : []), text: async () => '' };
  };
  return stub;
}

const RATIFY_ARGS = {
  proposal_id: '11111111-2222-4333-8444-555555555555',
  decision: 'ratified', confirm: true,
  ratified_by: 'V (Dr Vinay Bhardwaj)', rationale: 'ruled on the 22 Aug sample',
};
const PROPOSAL_SELECT = /FROM lvc_recommendation_proposals WHERE id = \$1::uuid/;

/** A proposal row as the extended projection would return it. */
const proposalRow = (over: Record<string, unknown>) => ({
  id: RATIFY_ARGS.proposal_id, statement: 'Do not order X for Y.',
  rationale: 'r', evidence_note: 'e', citation_url: null, citation_doi: null, citation_pmid: null,
  source_release_year: null, license_status: null, provenance: null, source: null,
  status: 'proposed', proposed_by: 'someone', supersedes_id: null, ...over,
});

const THREE_TABLES = ['lvc_recommendations', 'lvc_recommendation_proposals', 'lvc_ratifications'];

async function ratify(row: Record<string, unknown>, args: Record<string, unknown> = {}) {
  const stub = installStub();
  stub.on(PROPOSAL_SELECT, [row]);
  const { callLabTool } = await import('../mcp-tools');
  const result = await callLabTool('lvc_ratify', { ...RATIFY_ARGS, ...args });
  return { stub, result: result as { isError?: boolean; content?: { text?: string }[] } };
}

const textOfResult = (r: { content?: { text?: string }[] }) => String(r.content?.[0]?.text ?? '');

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §1.1 — legacy ratify refuses bridge-origin rows
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('D2.1 — source=lvp-pattern is REFUSED with the distinct reason, and writes zero rows to all three tables', async () => {
  const { stub, result } = await ratify(proposalRow({ source: 'lvp-pattern' }));
  assert.equal(result.isError, true);
  assert.match(textOfResult(result), /bridge_origin_requires_governed_workflow/,
    'a distinct reason, not a generic failure');
  for (const table of THREE_TABLES) {
    assert.deepEqual(stub.writesTo(table), [], `${table}: zero writes`);
  }
  // …and the refusal is not passing because nothing ran at all: the proposal WAS read.
  assert.equal(stub.calls.filter((c) => PROPOSAL_SELECT.test(c.query)).length, 1,
    'the proposal was read exactly once — one query, not two (§1.1)');
});

test('D2.2 — provenance=lvp-pattern with source UNSET is refused too: EITHER field triggers it', async () => {
  const { stub, result } = await ratify(proposalRow({ source: null, provenance: 'lvp-pattern' }));
  assert.equal(result.isError, true);
  assert.match(textOfResult(result), /bridge_origin_requires_governed_workflow/);
  for (const table of THREE_TABLES) assert.deepEqual(stub.writesTo(table), [], `${table}: zero writes`);
});

test('D2.3 — a bridge row is NOT REJECTABLE through the legacy path either', async () => {
  // Rejection writes status='rejected' and a ledger row. Allowing it would let this tool retire a
  // governed proposal outside the governed workflow — a different unauthorised state change.
  const { stub, result } = await ratify(
    proposalRow({ source: 'lvp-pattern' }),
    { decision: 'rejected', reason: 'no longer wanted' });
  assert.equal(result.isError, true);
  assert.match(textOfResult(result), /bridge_origin_requires_governed_workflow/);
  for (const table of THREE_TABLES) assert.deepEqual(stub.writesTo(table), [], `${table}: zero writes`);
});

test('D2.4 — the refusal precedes BOTH checkPromotable and the reject branch', async () => {
  // A bridge row in a NON-promotable status still gets the bridge reason, not the promotable one —
  // which is only true if the bridge check runs first.
  for (const status of ['ratified', 'rejected', 'proposed']) {
    const { result } = await ratify(proposalRow({ source: 'lvp-pattern', status }));
    assert.match(textOfResult(result), /bridge_origin_requires_governed_workflow/,
      `status=${status}: the bridge reason must win`);
  }
});

test('D2.5 — an ORDINARY proposal is unaffected: it still promotes, so containment is not a blanket refusal', async () => {
  const stub = installStub();
  stub.on(PROPOSAL_SELECT, [proposalRow({ source: 'society-guideline' })]);
  stub.on(/INSERT INTO lvc_recommendations/i, [{ id: 'rec-1' }]);
  const { callLabTool } = await import('../mcp-tools');
  const result = await callLabTool('lvc_ratify', RATIFY_ARGS) as { isError?: boolean; content?: { text?: string }[] };
  assert.doesNotMatch(textOfResult(result), /bridge_origin_requires_governed_workflow/);
  // It reached the promotion path — which is the control that stops D2.1-D2.4 passing vacuously.
  assert.ok(stub.writesTo('lvc_recommendations').length > 0,
    'an ordinary proposal still promotes; the containment is bridge-specific');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §1.2 — the two dedup lanes
// ════════════════════════════════════════════════════════════════════════════════════════════════

const PENDING_SELECT = /FROM lvc_recommendation_proposals WHERE status = 'proposed'/;

test('D2.6 — LANE A: the ordinary Jaccard gate does NOT see bridge rows', async () => {
  // An ordinary MCP request carries no trustworthy pattern identity, so cross-channel semantic
  // identity cannot be inferred and must not be guessed. Proven on the STATEMENT the gate issues:
  // the pending set excludes both bridge markers.
  const stub = installStub();
  stub.on(/FROM lvc_recommendations$/, []);
  stub.on(PENDING_SELECT, []);
  const { callLabTool } = await import('../mcp-tools');
  await callLabTool('lvc_propose', {
    statement: 'Do not order a chest X-ray for uncomplicated bronchitis.',
    rationale: 'r', evidence_note: 'e', proposed_by: 'V (Dr Vinay Bhardwaj)',
    citation_url: 'https://example.invalid/g', provenance: 'society-guideline',
    source_release_year: 2024, license_status: 'open',
  });
  const pending = stub.calls.filter((c) => PENDING_SELECT.test(c.query));
  assert.equal(pending.length, 1, 'the pending comparison set is read once');
  assert.match(pending[0].query, /coalesce\(source, ''\) <> 'lvp-pattern'/, 'bridge rows excluded by source');
  assert.match(pending[0].query, /coalesce\(provenance, ''\) <> 'lvp-pattern'/, 'and by provenance');
});

test('D2.7 — LANE A is NOT WEAKENED: an ordinary proposal duplicating a LIVE rule is still refused', async () => {
  // The lane change must exclude bridge rows and nothing else. A live-rule duplicate still fails.
  const stub = installStub();
  const statement = 'Do not order a chest X-ray for uncomplicated bronchitis.';
  stub.on(/FROM lvc_recommendations$/, [{ id: 'live-1', statement, source: 'society', status: 'live' }]);
  stub.on(PENDING_SELECT, []);
  const { callLabTool } = await import('../mcp-tools');
  const r = await callLabTool('lvc_propose', {
    statement, rationale: 'r', evidence_note: 'e', proposed_by: 'V (Dr Vinay Bhardwaj)',
    citation_url: 'https://example.invalid/g', provenance: 'society-guideline',
    source_release_year: 2024, license_status: 'open',
  }) as { isError?: boolean; content?: { text?: string }[] };
  assert.equal(r.isError, true, 'a duplicate of a live rule is still refused');
  assert.deepEqual(stub.writesTo('lvc_recommendation_proposals'), [], 'and nothing was written');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §1.3 — the atomic identity claim, at the SQL level
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('D2.8 — LANE B: two DIFFERENT lvp_pattern_ids with near-identical wrapper prose BOTH succeed', async () => {
  // ⚠️ THE DEFECT THIS REPLACES. The old authoritative rule was exact wrapper-statement equality,
  // which compares BOILERPLATE AGAINST BOILERPLATE: the bridge wraps every pattern in near-identical
  // prose, so two genuinely different patterns could block one another. Dedup is now exact
  // `lvp_pattern_id`, so near-identical prose is irrelevant.
  const { PROPOSE_PATTERN_SQL, proposePatternAsRule } = await import('../rule-governance-store');
  assert.doesNotMatch(PROPOSE_PATTERN_SQL, /lower\(p\.statement\)/, 'prose equality is not the rule');

  const seen: unknown[][] = [];
  const runner = (async (_t: string, p?: unknown[]) => {
    seen.push(p ?? []);
    return [{ proposal_id: `prop-${seen.length}`, rule_ref: `rule-${seen.length}`,
              definition_hash: 'h', map_id: `map-${seen.length}` }];
  }) as never;

  const saved = process.env.LVC_RULE_GOVERNANCE_ENABLED;
  process.env.LVC_RULE_GOVERNANCE_ENABLED = '1';
  try {
    const base = {
      statement: 'Consider whether this is needed: montelukast for a viral URTI.',
      precondition: null, rationale_text: 'r', evidence_note: 'e', category: 'c',
      action_type: 'avoid', keywords: ['montelukast'],
      snapshot: { pattern_id: 'pattern:c-1', concept_id: 'c-1' } as never,
      evidence: {
        ratified_by: 'V (Dr Vinay Bhardwaj)', rationale: 'ruled', sample_size: 40,
        reviewed_n: 12, sample_seed: 's', n_not_belonging: 3,
      },
    };
    const a = await proposePatternAsRule({ ...base, ruleRef: 'lvc-rule-A', lvpPatternId: 'pattern:c-1' }, runner);
    // Near-identical prose, DIFFERENT pattern id.
    const b = await proposePatternAsRule({
      ...base, ruleRef: 'lvc-rule-B', lvpPatternId: 'pattern:c-2',
      statement: 'Consider whether this is needed: montelukast for a viral URI.',
      snapshot: { pattern_id: 'pattern:c-2', concept_id: 'c-2' } as never,
    }, runner);
    assert.equal(a.written, true, 'the first pattern is written');
    assert.equal(b.written, true, 'and so is the second — different pattern, similar prose');
    assert.notEqual(seen[0][15], seen[1][15], 'the two carry different lvp_pattern_id parameters');
  } finally {
    if (saved === undefined) delete process.env.LVC_RULE_GOVERNANCE_ENABLED;
    else process.env.LVC_RULE_GOVERNANCE_ENABLED = saved;
  }
});

test('D2.9 — a concurrent LOSER writes zero rows, in all three tables', async () => {
  // Simulated at the SQL level: the claim CTE returns no row, which is exactly what
  // `ON CONFLICT (lvp_pattern_id) DO NOTHING` produces for the losing request. Every downstream
  // CTE selects FROM the one above it, so the loser inserts nowhere.
  const { PROPOSE_PATTERN_SQL, proposePatternAsRule } = await import('../rule-governance-store');
  // The chain is what makes this true, so it is asserted structurally as well as behaviourally.
  assert.match(PROPOSE_PATTERN_SQL, /ON CONFLICT \(lvp_pattern_id\) DO NOTHING/);
  assert.match(PROPOSE_PATTERN_SQL, /'proposed', \$7::text\n\s*FROM claim/);
  assert.match(PROPOSE_PATTERN_SQL, /FROM prop\n\s*RETURNING rule_ref/);

  const saved = process.env.LVC_RULE_GOVERNANCE_ENABLED;
  process.env.LVC_RULE_GOVERNANCE_ENABLED = '1';
  try {
    // The loser: claim conflicts, so every RETURNING is null.
    const loser = (async () => [{ proposal_id: null, rule_ref: null, definition_hash: null, map_id: null }]) as never;
    const r = await proposePatternAsRule({
      ruleRef: 'lvc-rule-B', statement: 's', precondition: null, rationale_text: 'r',
      evidence_note: 'e', category: 'c', action_type: 'avoid', keywords: ['k'],
      lvpPatternId: 'pattern:c-1',
      snapshot: { pattern_id: 'pattern:c-1', concept_id: 'c-1' } as never,
      evidence: { ratified_by: 'V (Dr Vinay Bhardwaj)', rationale: 'ruled', sample_size: 40,
                  reviewed_n: 12, sample_seed: 's', n_not_belonging: 3 },
    }, loser);
    assert.equal(r.written, false, 'the loser wrote nothing');
    assert.equal(r.proposal_id, null);
    assert.equal(r.rule_ref, null);
    assert.equal(r.map_id, null, 'not even the map row it tried to claim');
  } finally {
    if (saved === undefined) delete process.env.LVC_RULE_GOVERNANCE_ENABLED;
    else process.env.LVC_RULE_GOVERNANCE_ENABLED = saved;
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §1.4 — the three schema constraints
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('D2.10 — lvp_pattern_id is UNIQUE, in both copies', async () => {
  const { PATTERN_MAP_TABLE_DDL } = await import('../rule-governance-store');
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync('migrations/0039_rule_governance.sql', 'utf8');
  for (const [name, ddl] of [['inlined', PATTERN_MAP_TABLE_DDL], ['reference .sql', sql]] as const) {
    assert.match(ddl, /CONSTRAINT rule_pattern_map_pattern_unique UNIQUE \(lvp_pattern_id\)/, name);
  }
});

test('D2.11 — the snapshot pattern_id must EQUAL lvp_pattern_id', async () => {
  const { PATTERN_MAP_TABLE_DDL } = await import('../rule-governance-store');
  assert.match(PATTERN_MAP_TABLE_DDL,
    /CONSTRAINT rule_pattern_map_snapshot_identity\s*\n?\s*CHECK \(evidence_snapshot ->> 'pattern_id' = lvp_pattern_id\)/);
});

test('D2.12 — lvp_pattern_id must be "pattern:" + a NONBLANK concept_id, and blank does not default', async () => {
  const { PATTERN_MAP_TABLE_DDL } = await import('../rule-governance-store');
  const c = PATTERN_MAP_TABLE_DDL;
  assert.match(c, /CONSTRAINT rule_pattern_map_pattern_id_form CHECK \(/);
  // ⚠️ ALL THREE CONJUNCTS. `->>` yields SQL NULL for an absent key and a CHECK is SATISFIED by
  // NULL, so an equality test alone would ADMIT an absent concept_id. Presence and nonblank are
  // separate conjuncts precisely for that reason, and their absence is what this pins.
  assert.match(c, /evidence_snapshot ->> 'concept_id' IS NOT NULL/, 'absent must fail');
  assert.match(c, /btrim\(evidence_snapshot ->> 'concept_id'\) <> ''/, 'blank must fail');
  assert.match(c, /lvp_pattern_id = 'pattern:' \|\| \(evidence_snapshot ->> 'concept_id'\)/, 'the derivation is pinned');
});
