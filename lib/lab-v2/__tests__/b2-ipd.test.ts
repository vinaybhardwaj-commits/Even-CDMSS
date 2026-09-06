/**
 * LAB-MCP-V2 §17.5 — the IPD episode freeze, adapter and tools (decisions 47–50).
 *
 * ⚠️ THE FIXTURE IS MANUFACTURED, AND THAT IS THE ONLY WAY IT COULD BE. A real 0.2 audit row
 * carries a patient's whole admission; this repository has had PHI history rewritten once and
 * must never carry another. So the "stored row" here is produced by running the real pipeline on
 * the synthetic episode in `fixtures/episode-fixture.ts` and writing down what it wrote. Every
 * mechanism below — the strip, the classification gate, the ordinal inversion, the request-hash
 * keying, the golden comparison — is exercised on it exactly as it is on production data. What is
 * NOT here is the golden A/B over the 24 real episodes: that is a production read, it is in the
 * build report, and no clinical row from it enters this repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers';
import { hash } from '../contracts';
import { ensureBudget, itemsOf, putObject, submitRun, stepsOf, getObject } from '../store';
import { tick } from '../worker';
import { fixtureTransport } from '../transport';
import { callTool } from '../service';
import {
  AUDIT_ROW_SQL, CHECKPOINT_ROWS_SQL, COHORT_SQL, EXTRACTION_SQL, PATIENT_NAME_KEY,
  STATEMENT_RULE_SUFFIXES, deterministicFields, episodeRefFor, freezeIpdCase, ipdStageForLabel,
  keysOf, stripVerbatimSections, unappendRuleSuffixes,
} from '../sources/ipd';
import { makeIpdEpisodeAdapter, recordIpdSteps, rowAsStored } from '../adapters/ipd-episode';
import { episodeCheckpointInspect } from '../tools/episode';
import {
  FIXTURE_AUDIT_ID, FIXTURE_MEMBER_ID, runFixtureEpisode, storedCheckpointsFrom, storedExtractionRow, storedRowFrom,
} from './fixtures/ipd-stored';
import { FIXTURE_ENCOUNTER } from './fixtures/episode-fixture';
import { IPD_EPISODE_CHECKPOINT_SYSTEM } from '../../ipd-episode/prompts';
import type { Db } from '../db';

const SALT = 'b2-test-salt';

/** The three reads, answered from the manufactured row. No database, no db13. */
async function freezeFixture(over: { audit?: Record<string, unknown>; extraction?: Record<string, unknown> } = {}) {
  const { row, checkpoints } = await runFixtureEpisode();
  const audit = { ...storedRowFrom(row), ...(over.audit ?? {}) };
  const extraction = { ...storedExtractionRow(), ...(over.extraction ?? {}) };
  const previous = process.env.LAB_V2_MEMBER_SALT;
  process.env.LAB_V2_MEMBER_SALT = SALT;
  try {
    return await freezeIpdCase(FIXTURE_AUDIT_ID, {
      readAudit: async () => [audit],
      readCheckpoints: async () => storedCheckpointsFrom(checkpoints),
      readExtraction: async () => [extraction],
      recordSteps: recordIpdSteps,
    });
  } finally {
    if (previous === undefined) delete process.env.LAB_V2_MEMBER_SALT;
    else process.env.LAB_V2_MEMBER_SALT = previous;
  }
}

// ── decision 50: the strip, and what may not survive it ──────────────────────────────────────

test('§17.5 decision 50: verbatimSections is removed wherever it sits, and the removal is recorded', () => {
  const out = stripVerbatimSections({
    a: 1, verbatimSections: { header: 'Patient Name: X' },
    nested: [{ verbatimSections: { x: 1 }, keep: 2 }],
  });
  assert.deepEqual(out.stripped, ['verbatimSections']);
  assert.deepEqual(out.value, { a: 1, nested: [{ keep: 2 }] });
  assert.ok(!keysOf(out.value).includes('verbatimSections'));
});

test('§17.5 decision 50: the frozen case carries no verbatimSections and no patient name', async () => {
  const c = await freezeFixture();
  assert.deepEqual(c.frozen.stripped, ['verbatimSections']);
  const keys = keysOf(c.frozen);
  assert.ok(!keys.includes('verbatimSections'), 'the strip held');
  assert.deepEqual(keys.filter((k) => PATIENT_NAME_KEY.test(k)), [], 'no patient-name key survives');
  // The NAME ITSELF, not merely its key: a grep of the whole frozen case for the fixture patient.
  assert.ok(!JSON.stringify(c.frozen).includes('Fixture Testperson'),
    'the patient name reached the frozen case — the strip is the only thing standing between it and the research store');
});

test('§17.5 decision 50: a patient-name key that survives the strip refuses the case', async () => {
  await assert.rejects(
    () => freezeFixture({ extraction: { extracted_json: { patient_name: 'Someone Real', diagnosis: 'x' } } }),
    (e: { code?: string; message?: string }) => e.code === 'CLASSIFICATION_REQUIRED' && /patient_name/.test(String(e.message)),
  );
});

// ── decision 50: the case key, and decision 44's member key ──────────────────────────────────

test('§17.5 decision 50: the case key is the audit row id, and the encounter id is nowhere', async () => {
  const c = await freezeFixture();
  assert.equal(c.case_key, FIXTURE_AUDIT_ID);
  assert.equal(c.frozen.episode_ref, episodeRefFor(FIXTURE_AUDIT_ID));
  assert.notEqual(c.frozen.episode_ref, FIXTURE_ENCOUNTER);
  // The whole object, not just the fields anyone thought to check.
  assert.ok(!JSON.stringify(c.frozen).includes(FIXTURE_ENCOUNTER),
    'the live db13 encounter id reached the frozen case');
  assert.equal(c.frozen.envelope.memberId, null, 'the raw member id is never frozen');
});

test('§17.5 decision 44: the member key is the salted hash, and the raw id is nowhere', async () => {
  const c = await freezeFixture();
  assert.equal(c.member_key, hashHex(`${SALT}${FIXTURE_MEMBER_ID}`));
  assert.ok(!JSON.stringify(c).includes(FIXTURE_MEMBER_ID), 'the raw member id must not appear anywhere on the case');
});

function hashHex(s: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('crypto') as typeof import('crypto')).createHash('sha256').update(s).digest('hex');
}

test('§17.5 decision 44: no salt, no IPD case — never an unsalted digest', async () => {
  const { row, checkpoints } = await runFixtureEpisode();
  const previous = process.env.LAB_V2_MEMBER_SALT;
  delete process.env.LAB_V2_MEMBER_SALT;
  try {
    await assert.rejects(
      () => freezeIpdCase(FIXTURE_AUDIT_ID, {
        readAudit: async () => [storedRowFrom(row)],
        readCheckpoints: async () => storedCheckpointsFrom(checkpoints),
        readExtraction: async () => [storedExtractionRow()],
        recordSteps: recordIpdSteps,
      }),
      (e: { code?: string }) => e.code === 'NOT_CONFIGURED',
    );
  } finally {
    if (previous !== undefined) process.env.LAB_V2_MEMBER_SALT = previous;
  }
});

// ── decision 48: the steps, keyed by the request hash the gateway computes ───────────────────

test('§17.5 decision 48: the freeze keys both judge replies by their real request hash', async () => {
  const c = await freezeFixture();
  const steps = Object.entries(c.frozen.steps);
  assert.equal(steps.length, 2, 'one step per judge pass, and no more');
  assert.deepEqual(steps.map(([, s]) => s.stage).sort(), ['divergence', 'fidelity']);
  for (const [key, s] of steps) {
    assert.equal(key, s.request_hash, 'the key IS the hash');
    assert.match(key, /^[0-9a-f]{64}$/, 'a sha256 of the canonical request');
    assert.ok(s.text.includes('"findings"'), 'the reply is the model reply, put back');
    assert.deepEqual(s.served, { provider: 'bedrock', model: c.frozen.models.judge },
      'attribution replays what actually served the original, not the replay');
  }
});

test('§17.5 decision 48: the stored judge findings invert back into the reply that produced them', async () => {
  const c = await freezeFixture();
  const byStage = Object.fromEntries(Object.values(c.frozen.steps).map((s) => [s.stage, JSON.parse(s.text)]));
  const a1 = byStage.divergence.findings as Record<string, unknown>[];
  const a2 = byStage.fidelity.findings as Record<string, unknown>[];
  assert.equal(a1.length, 2, 'both A1 findings came back');
  assert.equal(a2.length, 1);
  // The finding_id prefix the parser adds is REMOVED again, or the replay would prefix it twice.
  assert.deepEqual(a1.map((f) => f.finding_id), ['1', '2']);
  // The citation ordinal is inverted against the referencing checkpoint's own chunk id list.
  const cp = c.frozen.checkpoints['cp-d1'];
  assert.ok(cp, 'the referencing checkpoint is in the frozen case');
  assert.deepEqual(a1[0].citation_ids, [2], 'chunk 902 is the second excerpt of cp-d1');
  assert.equal(cp.citationIds[Number((a1[0].citation_ids as number[])[0]) - 1], 902);
  // A finding with no checkpoint_ref cites nothing — the A2 shape.
  assert.deepEqual(a2[0].citation_ids, []);
});

test('§17.5 decision 48: a row that discarded findings cannot be frozen at all', async () => {
  await assert.rejects(
    () => freezeFixture({ audit: { n_parse_failed: 2 } }),
    (e: { code?: string; message?: string }) => e.code === 'SOURCE_UNAVAILABLE' && /not a complete record/.test(String(e.message)),
  );
});

test('§17.5: a superseded run is not a case', async () => {
  await assert.rejects(
    () => freezeFixture({ audit: { is_current: false } }),
    (e: { code?: string; message?: string }) => /not is_current/.test(String(e.message)),
  );
});

// ── decision 48: the golden A/B, on the manufactured episode ─────────────────────────────────

const ARM_STAGES = {
  checkpoint: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5_000 },
  divergence: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5_000 },
  fidelity: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5_000 },
};

async function runFrozenCase(db: Db, frozen: Record<string, unknown>, key = 'b2-golden') {
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, key, 'armhash', 86_400_000, [
    {
      case_key: String(frozen.audit_id), arm_hash: 'armhash', repetition: 1,
      payload: { engine: 'ipd_episode', frozen, arm: { stages: ARM_STAGES }, budget_id: budget.id },
    },
  ]);
  // ⚠️ THE LIVE TRANSPORT IS WIRED TO THROW. Decision 48 says zero model calls, and this is what
  // makes that STRUCTURAL rather than observed: if the adapter ever reached a provider, the item
  // would fail rather than quietly costing money.
  const report = await tick({
    db,
    transport: (async () => { throw new Error('a frozen IPD replay must never reach a provider'); }) as never,
    adapters: { ipd_episode: makeIpdEpisodeAdapter() },
  });
  const [item] = await itemsOf(db, run.id);
  return { run, item, report, budget };
}

test('§17.5 decision 48: a frozen episode replays to the stored row, with zero model calls', async () => {
  const db = await freshDb();
  const c = await freezeFixture();
  const { item } = await runFrozenCase(db, c.frozen as unknown as Record<string, unknown>);

  assert.equal(item.state, 'succeeded', `the item failed: ${JSON.stringify(item.error)}`);
  const summary = (item.result as { summary: Record<string, unknown> }).summary;
  assert.equal(summary.exact, true);
  assert.equal(summary.replayed_stages, 2);
  assert.equal(summary.equal, true, 'the replay did not reproduce the stored row');
  assert.equal(summary.source_hash, summary.replay_hash);
  // The comparison is only worth something if the projection is non-trivial.
  assert.ok(Number(summary.n_findings) > 0, 'the episode produced findings');
  assert.equal(summary.source_hash, hash(c.frozen.stored));

  // §6.3 — nothing was reserved, because the gateway was never called.
  const calls = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM lab_v2.calls WHERE item_id = $1`, [item.id]);
  assert.equal(calls[0].n, '0', 'a frozen replay reserves nothing and spends nothing');
  await db.close();
});

test('§17.5 decision 48: the item result IS the deterministic projection, so result_hash is the comparison', async () => {
  const db = await freshDb();
  const c = await freezeFixture();
  const { item } = await runFrozenCase(db, c.frozen as unknown as Record<string, unknown>);
  const artifactId = (item.result as { artifact_id: string }).artifact_id;
  const body = (await getObject(db, artifactId))?.body as Record<string, unknown>;
  assert.deepEqual(body, c.frozen.stored, 'the replayed projection equals the stored one, field for field');
  assert.equal((item.result as { result_hash: string }).result_hash, hash(c.frozen.stored));
  // and nothing run-shaped rode into the hash
  const keys = keysOf(body);
  for (const k of ['trace_id', 'traceId', 'audited_at', 'checkpoint_wall_ms', 'latencyMs']) {
    assert.ok(!keys.includes(k), `${k} must not be in the hashed projection`);
  }
  await db.close();
});

test('§17.5 decision 45: a request that no longer matches a stored step is REPLAY_DIVERGED', async () => {
  const db = await freshDb();
  const c = await freezeFixture();
  // Change the SPECIALITY. The pipeline builds its admission-context line from the envelope and
  // hands that line to both judge passes, so the request hash moves and the stored step no longer
  // answers the question being asked.
  const tampered = { ...c.frozen, envelope: { ...c.frozen.envelope, speciality: 'Cardiology' } };
  const { item } = await runFrozenCase(db, tampered as unknown as Record<string, unknown>, 'b2-diverged');
  // ⚠️ `failed`, NOT a `diff_failed` skip. The engine's model helper catches everything by design,
  // so without the adapter holding and re-throwing, a replay that answered a different question
  // would arrive looking exactly like a slow provider.
  assert.equal(item.state, 'failed');
  assert.equal((item.error as { code?: string }).code, 'REPLAY_DIVERGED');
  assert.match(String((item.error as { message?: string }).message), /not among the 2 the case carries/);
  await db.close();
});

test('§17.5: the steps a frozen run writes are the ones a later replay reads', async () => {
  const db = await freshDb();
  const c = await freezeFixture();
  const { item } = await runFrozenCase(db, c.frozen as unknown as Record<string, unknown>);
  const steps = await stepsOf(db, item.id);
  const names = [...steps.keys()].sort();
  assert.deepEqual(names.filter((n) => !n.startsWith('checkpoint:')), ['divergence', 'fidelity']);
  assert.equal(names.filter((n) => n.startsWith('checkpoint:')).length, 3, 'one step per checkpoint');
  // The judge steps are keyed by the SAME hash the freeze recorded.
  for (const stage of ['divergence', 'fidelity']) {
    const s = steps.get(stage)!;
    assert.ok(c.frozen.steps[s.dependency_hash], `${stage}'s request hash matches the frozen case`);
  }
  await db.close();
});

// ── decision 49: the two tools ───────────────────────────────────────────────────────────────

test('§17.5 decision 49: episode_checkpoint_inspect answers from the dataset, with the arithmetic', async () => {
  const db = await freshDb();
  const c = await freezeFixture();
  const { object } = await putObject(db, 'research', 'dataset', {
    engine: 'ipd_episode',
    cases: [{ case_key: c.case_key, member_key: c.member_key, frozen: c.frozen }],
    snapshot_policy: 'episode_at_creation', exclusions: [], classification: 'deidentified',
    source_versions: {}, replay_exactness: 'frozen',
  }, 'deidentified', null);

  const out = await episodeCheckpointInspect({ db, principal: 'research' }, { case_key: c.case_key, dataset_id: object.id });
  assert.equal(out.source, 'dataset');
  assert.equal(out.checkpoints.length, 3);
  const d1 = out.checkpoints.find((x) => x.checkpoint_id === 'cp-d1') as unknown as {
    expectation: Record<string, number>; arithmetic: Record<string, unknown>;
    class_availability: { citation_ids: number[] }; matched_events: Record<string, number>;
    input_cutoff_at: string;
  };
  assert.equal(d1.expectation.total, 4);
  assert.equal(d1.expectation.diagnostics, 1);
  assert.equal(d1.expectation.escalation, 1);
  assert.equal(d1.arithmetic.entries, 4);
  assert.equal(d1.arithmetic.uncited_entries, 1);
  assert.equal(d1.arithmetic.cited_pct, 75);
  // The blinding proof travels with it: the window and what fell inside it.
  assert.ok(d1.input_cutoff_at);
  assert.ok(Object.values(d1.matched_events).reduce((a, b) => a + b, 0) > 0);
  assert.equal(d1.class_availability.citation_ids.length, 2);

  // One checkpoint, by three names that all mean the same checkpoint.
  for (const want of ['cp-d1', 'd1', 1] as (string | number)[]) {
    const one = await episodeCheckpointInspect({ db, principal: 'research' }, { case_key: c.case_key, dataset_id: object.id, checkpoint: want });
    assert.equal(one.checkpoints.length, 1, `selector ${want}`);
    assert.equal(one.checkpoints[0].checkpoint_id, 'cp-d1');
  }
  await db.close();
});

test('§17.5 decision 49: episode_checkpoint_inspect reads a replayed item and reports its request hashes', async () => {
  const db = await freshDb();
  const c = await freezeFixture();
  const { item } = await runFrozenCase(db, c.frozen as unknown as Record<string, unknown>);
  const out = await episodeCheckpointInspect({ db, principal: 'research' }, { item_id: item.id });
  assert.equal(out.source, 'item');
  assert.equal(out.checkpoints.length, 3);
  for (const cp of out.checkpoints as unknown as { arithmetic: { request_hash: string } }[]) {
    assert.match(String(cp.arithmetic.request_hash), /^[0-9a-f]{64}$/, 'the step this checkpoint was served from');
  }
  await db.close();
});

test('§17.5 decision 49: episode_replay refuses a run of any other engine', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 10_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'not-ipd', 'h', 86_400_000, [
    { case_key: 'x', arm_hash: 'h', repetition: 1, payload: { engine: 'opd_note_audit', frozen: {}, arm: {}, budget_id: budget.id } },
  ]);
  await assert.rejects(
    () => callTool({ db, principal: 'research', protocolVersion: 't', sdkVersion: 't' } as never, 'episode_replay',
      { run_id: run.id, mode: 'exact', idempotency_key: 'k' }),
    (e: { code?: string; message?: string }) => e.code === 'INVALID_INPUT' && /ipd_episode only/.test(String(e.message)),
  );
  await db.close();
});

// ── the surface, the stages and the statements ───────────────────────────────────────────────

test('§17.5: every governed label the pipeline emits maps to a priced stage', () => {
  assert.equal(ipdStageForLabel('ipd_episode_diff'), 'divergence');
  assert.equal(ipdStageForLabel('ipd_episode_fidelity'), 'fidelity');
  assert.equal(ipdStageForLabel('ipd_episode_checkpoint_cp-d0'), 'checkpoint');
  assert.equal(ipdStageForLabel('ipd_episode_checkpoint_cp-episode'), 'checkpoint');
  // ⚠️ ONE STAGE FOR EVERY CHECKPOINT. Six checkpoints must not become six stages, or the arm's
  // cost ceiling would depend on how long the admission was.
  const labels = ['cp-d0', 'cp-d3', 'cp-episode'].map((id) => ipdStageForLabel(`ipd_episode_checkpoint_${id}`));
  assert.deepEqual([...new Set(labels)], ['checkpoint']);
});

test('§17.5: every inferred statement is a SELECT over the three tables the round names', () => {
  const statements = [
    AUDIT_ROW_SQL('11111111-2222-4333-8444-555555555555'),
    CHECKPOINT_ROWS_SQL('11111111-2222-4333-8444-555555555555'),
    EXTRACTION_SQL('IP-1234'),
    COHORT_SQL('ipd-episode-audit/0.2', 24),
  ];
  for (const s of statements) {
    assert.match(s, /^SELECT/, 'read only');
    // Case-SENSITIVE: a lower-case `update` inside an identifier is not a write, and the check
    // must not fire on one (the same narrowing §17.4's source test made).
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT)\b/.test(s), `a write token in: ${s.slice(0, 60)}`);
    assert.equal((s.match(/;/g) ?? []).length, 0, 'a single statement');
  }
  assert.match(statements[0], /FROM ipd_episode_audits/);
  assert.match(statements[1], /FROM ipd_episode_checkpoints/);
  assert.match(statements[2], /FROM discharge_extracted_cases/);
  // Never `SELECT *`: the projection is a fixed column list, so a column added to a production
  // table cannot start arriving in a research object without someone naming it here.
  for (const s of statements) assert.ok(!/SELECT\s+\*/.test(s), 'no SELECT *');
});

test('§17.5: the cohort statement refuses anything that is not an id, rather than escaping it', () => {
  assert.throws(() => COHORT_SQL("0.2'; DROP TABLE x --", 10), (e: { code?: string }) => e.code === 'INVALID_INPUT');
  assert.throws(() => AUDIT_ROW_SQL('not-a-uuid'), (e: { code?: string }) => e.code === 'INVALID_INPUT');
  assert.throws(() => EXTRACTION_SQL("IP-1' OR 1=1"), (e: { code?: string }) => e.code === 'INVALID_INPUT');
});

// ── decision 48: the production golden A/B, as a committed record ───────────────────────────

test('§17.5 decision 48: the golden A/B record is complete, equal on every case, and free of clinical text', () => {
  // ⚠️ THIS IS A RECORD, NOT A RE-RUN. The A/B itself reads production Neon and cannot run in the
  // test suite (npm test loads no .env); what is committed is its verdict per case. The test's job
  // is to make that verdict CHECKABLE — that every case was compared, that every one was equal,
  // that both named cohorts are inside it, that nothing reached a provider — and to make sure the
  // record never grows a column carrying a patient.
  const ab = JSON.parse(readFileSync(join(process.cwd(), 'lib/lab-v2/__tests__/fixtures/golden-ab-06-sep-2026.json'), 'utf8')) as {
    engine_version: string; model_calls: number; gateway_calls: number; refused: unknown[];
    totals: { cases: number; equal: number; decision_40: number; section_1_27: number };
    cases: { case_key: string; episode: string; decision_40: boolean; section_1_27: boolean; source_hash: string; replay_hash: string; equal: boolean; checkpoints: number; n_findings: number; replayed_stages: number }[];
  };
  assert.equal(ab.engine_version, 'ipd-episode-audit/0.2');
  assert.equal(ab.cases.length, ab.totals.cases);
  assert.equal(ab.totals.equal, ab.totals.cases, 'decision 48: any inequality fails the round');
  // Decision 48's two named cohorts, both inside the run and both complete.
  assert.equal(ab.cases.filter((c) => c.decision_40).length, 12, "decision 40's twelve ticks");
  assert.equal(ab.cases.filter((c) => c.section_1_27).length, 7, 'the §1.27 episodes that carry a 0.2 row');
  assert.ok(ab.totals.cases >= 24, 'at least the 24 decision 48 asks for');
  assert.equal(ab.model_calls, 0, 'zero model calls');
  assert.equal(ab.gateway_calls, 0, 'and nothing was reserved against a budget');
  assert.deepEqual(ab.refused, [], 'every selected row could be frozen');
  for (const c of ab.cases) {
    assert.equal(c.equal, true, `${c.episode} did not replay to its stored row`);
    assert.equal(c.source_hash, c.replay_hash, `${c.episode}`);
    assert.match(c.source_hash, /^[0-9a-f]{64}$/);
    assert.equal(c.replayed_stages, 2, `${c.episode}: both judge passes were served from steps`);
    assert.ok(c.checkpoints >= 1 && c.n_findings >= 0);
  }
  // ⚠️ NO CLINICAL CONTENT, EVER. The record is ids, hashes and counts; a future edit that added a
  // statement, a course or a name would put a patient in a public repository.
  const allowed = new Set(['case_key', 'episode', 'decision_40', 'section_1_27', 'source_hash', 'replay_hash', 'equal', 'checkpoints', 'n_findings', 'replayed_stages']);
  for (const c of ab.cases) {
    for (const k of Object.keys(c)) assert.ok(allowed.has(k), `the golden record grew a '${k}' column`);
  }
  for (const k of keysOf(ab)) {
    assert.ok(!PATIENT_NAME_KEY.test(k), `the golden record carries a name key: ${k}`);
  }
});

test('§17.5: the two statement-rewrite suffixes are the ones judge-core actually appends', () => {
  // ⚠️ THIS IS THE TEST THAT STOPS A SILENT DOUBLE SUFFIX. `unappendRuleSuffixes` carries a COPY
  // of two literals that live in a file this round may not edit; if either is reworded there and
  // not here, every replay of an escalation or contradiction finding would come back with the
  // explanation twice, and the golden A/B would fail for a reason that is not the engine's.
  const core = readFileSync(join(process.cwd(), 'lib/ipd-episode/judge-core.ts'), 'utf8');
  const ESCALATION = ' This is measured against an escalation trigger — a conditional whose antecedent (vitals, bedside observation) this pipeline does not carry — so whether the action was required cannot be established here.';
  const CONTRADICTION_HEAD = ' ⚠️ Another finding in this same audit (';
  const CONTRADICTION_TAIL = ") reports this on the record, so this absence is contradicted by the engine's own evidence and is not asserted.";
  assert.ok(core.includes('`${f.statement}' + ESCALATION + '`'), 'judge-core still appends exactly this escalation sentence');
  assert.ok(core.includes('`${f.statement}' + CONTRADICTION_HEAD), 'and exactly this contradiction sentence');
  assert.ok(core.includes(CONTRADICTION_TAIL), 'including its tail');
  assert.equal(STATEMENT_RULE_SUFFIXES.length, 2, 'two rules append to a statement; a third would need a third pattern');
  // And the inversion removes each of them, once, wherever it sits at the end.
  assert.equal(unappendRuleSuffixes(`the drug was late.${ESCALATION}`), 'the drug was late.');
  assert.equal(unappendRuleSuffixes(`the drug was late.${CONTRADICTION_HEAD}a1-F4${CONTRADICTION_TAIL}`), 'the drug was late.');
  assert.equal(unappendRuleSuffixes(`x.${ESCALATION}${ESCALATION}`), 'x.', 'and it removes a doubled one');
  assert.equal(unappendRuleSuffixes('nothing to remove.'), 'nothing to remove.');
});

test('§17.5 decision 48: the two ways of building the projection agree', async () => {
  const { row, checkpoints } = await runFixtureEpisode();
  const stored = storedRowFrom(row);
  const fromStored = deterministicFields(stored, storedCheckpointsFrom(checkpoints).map((c) => ({
    checkpointId: c.checkpoint_type === 'episode' ? 'cp-episode' : `cp-d${c.day_index}`,
    status: String(c.status), entryCount: Number(c.entry_count), uncitedEntryCount: Number(c.uncited_entry_count),
    inputEventCount: Number(c.input_event_count), cutoffAt: String(c.input_cutoff_at),
  })));
  const fromWrite = deterministicFields(rowAsStored(row), checkpoints.map((c) => ({
    checkpointId: c.checkpointType === 'episode' ? 'cp-episode' : `cp-d${c.dayIndex}`,
    status: c.status, entryCount: c.entryCount, uncitedEntryCount: c.uncitedEntryCount,
    inputEventCount: c.inputEventCount, cutoffAt: c.inputCutoffAt,
  })));
  // ⚠️ THE WHOLE GOLDEN A/B RESTS ON THESE TWO MAPPERS AGREEING. One reads a stored row, the other
  // reads what the pipeline just wrote; if they disagreed, every comparison would be measuring the
  // mappers rather than the engine.
  assert.deepEqual(fromWrite, fromStored);
  assert.equal(hash(fromWrite), hash(fromStored));
});

test('§17.5: engine_describe reports ipd_episode as supported, with its three stages', async () => {
  const db = await freshDb();
  const out = await callTool({ db, principal: 'research', protocolVersion: 't', sdkVersion: 't' } as never,
    'engine_describe', { engine: 'ipd_episode' }) as { supported: boolean; stages: { name: string }[]; engine_version: string; frozen_inputs: string[] };
  assert.equal(out.supported, true);
  assert.deepEqual(out.stages.map((s) => s.name), ['checkpoint', 'divergence', 'fidelity']);
  assert.ok(!out.stages.some((s) => s.name === 'commentary'), 'pass B left the pipeline under IPD decision 35');
  assert.match(out.engine_version, /^ipd-episode-audit\//);
  await db.close();
});

test('§17.5: dataset_create refuses the episodes selector for any other engine', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => callTool({ db, principal: 'research', protocolVersion: 't', sdkVersion: 't' } as never, 'dataset_create',
      { engine: 'ask', episodes: { audit_ids: ['11111111-2222-4333-8444-555555555555'] }, idempotency_key: 'k' }),
    (e: { code?: string; message?: string }) => e.code === 'ENGINE_UNSUPPORTED' && /ipd_episode only/.test(String(e.message)),
  );
  await db.close();
});

/** A course the checkpoint parser accepts, so a FRESH run reaches the judge passes. */
const FRESH_COURSE = JSON.stringify({
  expected_diagnostics: [{ item: 'full blood count', by_day: 0, rationale: 'r', citation_ids: [1], proposed_severity: 'moderate', recurrence: 'once' }],
  expected_therapeutics: [], expected_monitoring: [], escalation_triggers: [],
  expected_los_days: 3, expected_disposition: 'home', uncertainty: [],
});

test('§17.5: a fresh (non-frozen) case prices EVERY stage through the gateway', async () => {
  const db = await freshDb();
  const c = await freezeFixture();
  // No steps ⇒ FRESH mode: the checkpoints run for real and the judge passes run for real, and
  // every one of them is reserved, dispatched and settled by the gateway like any other engine.
  const fresh = { ...c.frozen, steps: {} };
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'b2-fresh', 'armhash', 86_400_000, [
    {
      case_key: c.case_key, arm_hash: 'armhash', repetition: 1,
      payload: { engine: 'ipd_episode', frozen: fresh, arm: { stages: ARM_STAGES }, budget_id: budget.id },
    },
  ]);
  // One transport, two answers, chosen by which system prompt arrived — a checkpoint needs an
  // expected course and a judge pass needs a findings array, and neither parses the other.
  const transport = (async (req: { params: unknown }) => {
    const system = String((req.params as { messages?: { content?: unknown }[] })?.messages?.[0]?.content ?? '');
    const text = system === IPD_EPISODE_CHECKPOINT_SYSTEM ? FRESH_COURSE : JSON.stringify({ findings: [] });
    return {
      completion: { choices: [{ finish_reason: 'stop', message: { content: text } }] },
      text, served: { provider: 'ollama', model: 'local-model' },
      usage: { input_tokens: 10, output_tokens: 10 },
    };
  }) as never;
  await tick({
    db, transport,
    adapters: { ipd_episode: makeIpdEpisodeAdapter({ retrieve: async () => ({ hits: [], expandedQuery: '', meta: {} }) as never }) },
  });
  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'succeeded', `the fresh item failed: ${JSON.stringify(item.error)}`);
  const calls = await db.query<{ stage: string; state: string }>(
    `SELECT stage, state FROM lab_v2.calls WHERE item_id = $1 ORDER BY created_at`, [item.id]);
  const stages = calls.map((x) => x.stage);
  assert.equal(stages.filter((x) => x === 'checkpoint').length, 3, 'one call per checkpoint, all priced as one stage');
  assert.deepEqual(stages.slice(-2), ['divergence', 'fidelity'], 'the judge passes come last, in order');
  assert.ok(calls.every((x) => x.state === 'settled'), 'every stage settled');
  assert.equal((item.result as { summary: { exact: boolean } }).summary.exact, false);
  await db.close();
});
