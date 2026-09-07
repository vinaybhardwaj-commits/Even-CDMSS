/**
 * LAB-MCP-V2 §17.8 round D1 — the two engines: the freezes, the adapters, decision 99's walk,
 * and the readmission golden A/B.
 *
 * ⚠️ DECISION 99 IS THE TEST THAT MATTERS. "Lab v2 never stores identifying data" is a claim about
 * every object every D tool writes, and the only way to check a claim like that is to WALK what was
 * stored. `no D1 writer produces an object carrying a denylist key` does exactly that, over both
 * engines, using the same `identifyingKeys` walk `freezeRequestCase` uses — so the platform cannot
 * pass by having two ideas of what identifying means.
 *
 * ⚠️ DECISION 87 THROUGHOUT. The one `readmission_findings` statement runs against a real PGlite
 * table whose columns are `pendingFindings`' own selection (`lib/readmission/store.ts:315`) and
 * whose row is shaped like production's with the ids replaced.
 *
 * ⚠️ EXTENDED IN ROUND D2a UNDER CLAUDE.md RULE 1a, CITING DECISION 114. `READMISSION_FINDING_SQL`
 * gained `trace_id` and `promoted_to_full` and `freezeReadmissionFinding` now records `steps` from
 * `trace_events`, so this file's two fixtures — the table and the seeded row — had to grow the
 * columns and the trace rows or every test here fails on a column that does not exist. The edits
 * are mechanical: two columns, one parent table, one child table, and a trace seeded per leg. The
 * three tests that exercise the adapter's FRESH path inject `recordSteps: async () => ({})` so
 * they keep testing what D1 wrote them to test — the gateway, and the stages an arm must price.
 * D2a's own exact path is `d2a-readmission-replay.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedded, type Db } from '../db';
import { LabError } from '../contracts';
import { identifyingKeys, isIdentifyingKey } from '../sources/requests';
import {
  DROPPED_PROVENANCE_KEYS, FROZEN_ROW_FIELDS, READMISSION_FINDING_SQL, READMISSION_VERDICT_SQL,
  auditedVerdict, expectedLegStages, freezeReadmissionFinding, refuseIdentifying,
} from '../sources/readmission';
import {
  PSEUDONYM_KEYS, PSEUDONYM_PREFIX, freezePreopEpisode, pseudonym, pseudonymiseRows,
} from '../sources/preop';
import { AVOIDABLE_VERDICTS, makeReadmissionAdapter } from '../adapters/readmission';
import { ALL_ALIASES, makePreopAdapter, restoreKeys } from '../adapters/preop';
import { runReconSequence } from '../../readmission/run';
import { parsePassClaims } from '../../readmission-prompts';
import type { AdapterContext } from '../adapters/types';

const SALT = 'd1-test-salt';

// ─────────────────────────────────────────────────────────────────────────────────────
// The one SQL statement, and a real table for it (decision 87)
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.8: the two readmission_findings reads are bounded SELECTs and write nothing', () => {
  for (const [name, sql] of [['finding', READMISSION_FINDING_SQL], ['verdict', READMISSION_VERDICT_SQL]] as const) {
    assert.match(sql, /^SELECT/, name);
    assert.match(sql, /LIMIT 1/, `${name} reads one finding`);
    assert.match(sql, /WHERE dedup_key = \$1/, `${name} binds the key, never interpolates it`);
    for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'TRUNCATE']) {
      assert.ok(!new RegExp(`\\b${verb}\\b`).test(sql), `${name} contains ${verb}`);
    }
  }
});

/**
 * `readmission_findings` in production's shape, from `pendingFindings`' own column list, plus the
 * two columns D2a's statement selects (`promoted_to_full`, `trace_id` — both real, `store.ts:197`).
 *
 * ⚠️ AND `trace_events`, VERBATIM FROM `app/api/admin/migrate-v7/route.ts:30-39` (decision 87). Its
 * parent `traces` is created too so the foreign key is a real one; the parent's own
 * `user_id REFERENCES user_profiles(id)` is the single omission, because it would drag a third
 * production table in to hold a column nothing in this platform reads.
 */
async function readmissionDb(): Promise<Db> {
  const db = await embedded();
  await db.exec(`CREATE TABLE readmission_findings (
    dedup_key text PRIMARY KEY, finding_class text, index_encounter_id text, readmit_encounter_id text,
    form_uid text, uhid text, lane text, gap_days int, index_department text, readmit_department text,
    index_doctor text, readmit_doctor text, index_discharge_at timestamptz, readmit_admit_at timestamptz,
    cm_note text, form_is_planned boolean, form_same_condition boolean,
    audit_status text, engine_version text, finding jsonb, model text, provider text,
    promoted_to_full boolean, trace_id text)`);
  await db.exec(`CREATE TABLE traces (
    id              BIGSERIAL PRIMARY KEY,
    trace_id        TEXT NOT NULL UNIQUE,
    feature         TEXT NOT NULL,
    input           JSONB,
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    total_ms        INT,
    status          TEXT DEFAULT 'running',
    error_message   TEXT,
    meta            JSONB)`);
  await db.exec(`CREATE TABLE trace_events (
    id              BIGSERIAL PRIMARY KEY,
    trace_id        TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
    seq             INT NOT NULL,
    ts              TIMESTAMPTZ DEFAULT NOW(),
    kind            TEXT NOT NULL,
    stage           TEXT,
    payload         JSONB,
    latency_ms      INT)`);
  return db;
}

/**
 * One audit's trace, in the shape the survey's Part 1 measured: TWO rows per leg — one
 * `llm_request` carrying `payload.messages`, one `llm_response` carrying `payload.content` — on
 * one `trace_id`, in `seq` order. The reply text is what the freeze records as a step.
 */
async function seedTrace(
  db: Db, traceId: string, stages: readonly string[], reply: (stage: string) => string,
  o: { narrative?: boolean; model?: string; provider?: string } = {},
) {
  await db.query(`INSERT INTO traces (trace_id, feature, status) VALUES ($1, 'readmit_audit', 'ok')
                  ON CONFLICT (trace_id) DO NOTHING`, [traceId]);
  let seq = 0;
  const put = async (kind: string, stage: string, payload: unknown) => {
    seq += 1;
    await db.query(`INSERT INTO trace_events (trace_id, seq, kind, stage, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [traceId, seq, kind, stage, JSON.stringify(payload)]);
  };
  for (const stage of stages) {
    await put('llm_request', stage, { messages: [{ role: 'system', content: 's' }], temperature: 0.1, max_tokens: 3000 });
    await put('llm_response', stage, {
      content: reply(stage), model: o.model ?? 'gemini-2.5-pro', provider: o.provider ?? 'vertex',
      finish_reason: 'stop', usage: { input_tokens: 100, output_tokens: 50 },
    });
  }
  // The R4 narrative leg shares the audit's trace_id (`lib/readmission/narrative.ts:114`) and is
  // NOT a recon leg. Seeded so the statement's `stage <> 'readmit_narrative'` is exercised.
  if (o.narrative !== false) {
    await put('llm_request', 'readmit_narrative', { messages: [] });
    await put('llm_response', 'readmit_narrative', { content: 'a narrative paragraph', model: 'opus', provider: 'bedrock' });
  }
}

/** One row shaped like production's, ids replaced — with the trace production would have left. */
async function seedFinding(db: Db, o: Partial<Record<string, unknown>> = {}, reply: (stage: string) => string = () => CLAIMS) {
  const row = {
    dedup_key: 'RX-1|RX-2', finding_class: 'even_even', index_encounter_id: 'IPX-1',
    readmit_encounter_id: 'IPX-2', form_uid: 'F-1', uhid: 'UH-000001', lane: 'tight_bounce',
    gap_days: 4, index_department: 'General Medicine', readmit_department: 'General Medicine',
    index_doctor: 'Dr A', readmit_doctor: 'Dr B',
    index_discharge_at: '2026-08-01T10:00:00+05:30', readmit_admit_at: '2026-08-05T09:00:00+05:30',
    cm_note: null, form_is_planned: false, form_same_condition: true,
    audit_status: 'audited', engine_version: 'readmission/0.2',
    finding: JSON.stringify({ avoidable: { verdict: 'avoidable' } }), model: 'gemini-x', provider: 'vertex',
    // D2a — the two columns the statement gained, and the trace they point at.
    promoted_to_full: false, trace_id: `TR-${String(o.dedup_key ?? 'RX-1|RX-2')}`,
    ...o,
  };
  const cols = Object.keys(row);
  await db.query(
    `INSERT INTO readmission_findings (${cols.join(', ')}) VALUES (${cols.map((_c, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => (row as Record<string, unknown>)[c]),
  );
  if (row.trace_id) await seedTrace(db, String(row.trace_id), expectedLegStages(row), reply);
  return row;
}

/** DECISION 114's seam, injected where a D1 test means to exercise the FRESH gateway path. */
const NO_STEPS = { recordSteps: async () => ({}) } as const;

const runner = (db: Db) => (async (statement: string, params: unknown[]) => db.query(statement, params)) as never;

/**
 * `ThreeSourceInputs` in the shape `assembleForRow` really returns it, read off
 * `lib/readmission-reconcile-core.ts:83-102`: the catalog is `{items: EvidenceItem[]}` and
 * `labProfile` is one of four string literals, not an object. Shaped from production's row and
 * de-identified: two clinical sentences, one from each side, and no name or id anywhere.
 */
const ASSEMBLED = {
  inputs: {
    catalog: {
      items: [
        { id: 'e1', source: 'index_summary', side: 'index', text: 'Discharged on oral antibiotics; no repeat imaging before discharge.' },
        { id: 'e2', source: 'readmit_summary', side: 'readmit', text: 'Represented with worsening consolidation on the same side.' },
        { id: 'e3', source: 'lab', side: 'index', text: 'CRP 84 mg/L', at: '2026-07-31T06:00:00+05:30', analyte: 'crp', abnormal: true },
      ],
    },
    labProfile: 'has_late_labs', labTier: 'tier1',
    /**
     * ⚠️ DECISION 111 — `LabSourceProvenance` IN FULL (`readmission-reconcile-core.ts:378`),
     * INCLUDING THE TWO KEYS THAT REACHED PRODUCTION. D1's fixture invented a three-field object
     * and the walk passed on it; the real one carries `indexDocumentId` and `readmitDocumentId`,
     * three levels down, and those are what V found in dataset 87b4986e.
     */
    labSourceProvenance: {
      tier: 'tier1', structuredLabCount: 3, window: { from: '2026-07-18', to: '2026-08-03' },
      windowStartInferred: false, caseLabCount: 5, indexCase: 'store', readmitCase: 'store',
      extractionVersion: 'doc-extract/0.4',
      indexDocumentId: 'FIRESTORE-DOC-INDEX-1', readmitDocumentId: 'FIRESTORE-DOC-READMIT-1',
    },
    indexSentenceCount: 12, readmitSentenceCount: 9,
  },
  indexAdmitAt: '2026-07-28T10:00:00+05:30',
  indexDischargeAt: '2026-08-01T10:00:00+05:30',
  // ⚠️ THE FIELD THAT MUST NOT SURVIVE THE FREEZE. run.ts:258 says it is never persisted.
  identity: { names: ['Real Name'], uhids: ['UH-000001'] },
} as never;

test('§17.8 decision 87: the finding read runs against a real table and finds the row it wrote', async () => {
  const db = await readmissionDb();
  await seedFinding(db);
  const rows = await db.query<Record<string, unknown>>(READMISSION_FINDING_SQL, ['RX-1|RX-2']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lane, 'tight_bounce');
  assert.equal(rows[0].finding_class, 'even_even');
  // ⚠️ `to_char` IS THE POINT OF COPYING production's SELECT. A raw timestamptz comes back as a
  // Date whose serialisation depends on the driver; the engine reads an ISO string with an offset.
  // ⚠️ THE OFFSET WIDTH IS THE FIXTURE'S, NOT THE STATEMENT'S. PGlite renders `OF` as `+05` where
  // production's Postgres renders `+0530`; what the statement guarantees, and what the engine
  // reads, is an ISO string with an offset rather than a driver-dependent Date.
  assert.match(String(rows[0].index_discharge_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}/);
  const v = await db.query<Record<string, unknown>>(READMISSION_VERDICT_SQL, ['RX-1|RX-2']);
  assert.equal(v[0].verdict, 'avoidable', 'the jsonb path reaches the stored verdict');
  assert.equal(v[0].audit_status, 'audited');
  assert.deepEqual(await db.query(READMISSION_FINDING_SQL, ['nope']), []);
});

// ─────────────────────────────────────────────────────────────────────────────────────
// The readmission freeze
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.8 decision 104: the frozen readmission case carries a member_key and no id column', async () => {
  const db = await readmissionDb();
  await seedFinding(db);
  const frozen = await freezeReadmissionFinding('RX-1|RX-2', {
    run: runner(db), assemble: (async () => ASSEMBLED) as never, salt: SALT,
  });

  // ⚠️ DECISION 99, WALKED. The whole frozen body, at every depth, against the same denylist
  // `freezeRequestCase` uses.
  assert.deepEqual(identifyingKeys(frozen.frozen), [], 'the frozen body carries no denylist key');
  assert.deepEqual(Object.keys(frozen.frozen.row).sort(), [...FROZEN_ROW_FIELDS].sort());
  for (const dropped of ['dedup_key', 'uhid', 'index_encounter_id', 'readmit_encounter_id', 'form_uid']) {
    assert.ok(!(dropped in frozen.frozen.row), `${dropped} must not survive the freeze`);
  }
  // Decision 100 permits clinician names — and they are dropped anyway, because nothing reads them.
  assert.ok(!('index_doctor' in frozen.frozen.row));
  // `identity` is DROPPED, not scrubbed: a scrub can miss.
  assert.ok(!('identity' in (frozen.frozen as Record<string, unknown>)));
  assert.ok(!JSON.stringify(frozen).includes('Real Name'));
  assert.ok(!JSON.stringify(frozen).includes('UH-000001'), 'the raw uhid is nowhere in the object');

  // The one durable link decision 99 permits: a salted hash, as a sibling of `frozen`, never in it.
  assert.match(frozen.member_key ?? '', /^[0-9a-f]{16,}$/);
  assert.ok(!('member_key' in (frozen.frozen as Record<string, unknown>)));
  // And the case key is a hash of the dedup_key, not the dedup_key.
  assert.match(frozen.case_key, /^readmit:[0-9a-f]{32}$/);
  assert.ok(!frozen.case_key.includes('RX-1'));
  assert.equal(frozen.source_versions.audit_status, 'audited');
});

test('§17.8: the freeze refuses a missing finding and a not-auditable one, by name', async () => {
  const db = await readmissionDb();
  await seedFinding(db);
  await assert.rejects(() => freezeReadmissionFinding('missing', { run: runner(db), salt: SALT }),
    (e: LabError) => e.code === 'CASE_NOT_FOUND');
  await assert.rejects(() => freezeReadmissionFinding('', { run: runner(db), salt: SALT }),
    (e: LabError) => e.code === 'INVALID_INPUT');
  // Tier 3 is a real answer about the finding and is not a case: there is nothing to reconcile.
  await assert.rejects(
    () => freezeReadmissionFinding('RX-1|RX-2', {
      run: runner(db), salt: SALT,
      assemble: (async () => ({ notAuditable: 'tier3: no index discharge-summary PDF', labTier: 'tier3' })) as never,
    }),
    (e: LabError) => e.code === 'CASE_NOT_FOUND' && /tier3/.test(e.message));
});

test('§17.8 decision 99: an upstream engine that stops de-identifying is REFUSED, not scrubbed', async () => {
  const db = await readmissionDb();
  await seedFinding(db);
  await assert.rejects(
    () => freezeReadmissionFinding('RX-1|RX-2', {
      run: runner(db), salt: SALT,
      // `assembleForRow` de-identifies its own inputs. This is what happens the day it stops.
      assemble: (async () => ({ ...(ASSEMBLED as Record<string, unknown>), inputs: { catalog: { member_id: 'M-1' } } })) as never,
    }),
    (e: LabError) => e.code === 'CLASSIFICATION_REQUIRED' && /member_id/.test(e.message) && /refused rather than scrubbed/.test(e.message));
  // ⚠️ AND A SCRUB WOULD HAVE HIDDEN IT. That is the whole reason this refuses.
  assert.throws(() => refuseIdentifying({ a: { uhid: 'x' } }, 'x'), (e: LabError) => e.code === 'CLASSIFICATION_REQUIRED');
  assert.doesNotThrow(() => refuseIdentifying({ case_key: 'x', tier: 'RED' }, 'x'));
});

// ─────────────────────────────────────────────────────────────────────────────────────
// The readmission adapter
// ─────────────────────────────────────────────────────────────────────────────────────

function ctxFor(frozen: Record<string, unknown>, reply: (stage: string) => string, arm: Record<string, unknown> = {}) {
  const stages: string[] = [];
  const events: { kind: string; body: Record<string, unknown> }[] = [];
  const ctx = {
    runId: 'r', itemId: 'i', caseKey: 'c', frozen, arm, repetition: 0,
    gateway: {
      call: async (stage: string) => {
        stages.push(stage);
        return { completion: { choices: [{ message: { content: reply(stage) } }] }, text: reply(stage), usage: {}, served: null };
      },
    },
    event: (kind: string, body: Record<string, unknown>) => { events.push({ kind, body }); },
    checkpoint: async <T,>(_n: string, _h: string, produce: () => Promise<T>) => produce(),
  } as unknown as AdapterContext;
  return { ctx, stages, events };
}

/** A claims reply the engine's own `parsePassClaims` accepts. */
const CLAIMS = JSON.stringify({
  planned: { verdict: 'unplanned', evidence: [] },
  same_condition: { verdict: 'same', evidence: [] },
  avoidable: { verdict: 'avoidable', evidence: [], rationale: 'index care incomplete' },
});

test('§17.8 item 6: the adapter runs the production recon sequence and reports the verdict', async () => {
  const db = await readmissionDb();
  await seedFinding(db);
  // Rule 1a / decision 114: FRESH, so this keeps testing the gateway and the stages an arm prices.
  const frozen = await freezeReadmissionFinding('RX-1|RX-2', {
    run: runner(db), assemble: (async () => ASSEMBLED) as never, salt: SALT, ...NO_STEPS,
  });
  const { ctx, stages, events } = ctxFor(frozen.frozen as unknown as Record<string, unknown>, () => CLAIMS);
  const out = await makeReadmissionAdapter().run(ctx);

  assert.equal(out.execution_status, 'succeeded');
  // ⚠️ THE LANE DECIDES THE LEGS, AND IT IS THE ENGINE'S DECISION, NOT THE ADAPTER'S.
  // `tight_bounce` is a full pair, so recon A then recon B — the labels an arm must have priced.
  assert.deepEqual(stages, ['readmit_recon_a', 'readmit_recon_b']);
  // ⚠️ THE FINDING'S VERDICT, NOT THE PASS'S. `reconcileFinding` produced `needs_adjudication`
  // here because passes A and B cite disjoint evidence — the two-pass money verdict working, and
  // the reason this adapter's vocabulary is `reconcile-core.ts:538` and not the prompt parser's.
  assert.equal(out.summary.avoidable_verdict, 'needs_adjudication');
  assert.ok((AVOIDABLE_VERDICTS as readonly string[]).includes(String(out.summary.avoidable_verdict)));
  assert.equal(out.assessment_status, 'assessed');
  assert.equal(out.summary.legs, 2);
  assert.equal(events.filter((e) => e.kind === 'readmit_leg').length, 2);
  // ⚠️ THE SUMMARY CARRIES NO IDENTIFIER. It is returned inline by run_result and copied into
  // every report, so decision 99 reaches it too.
  assert.deepEqual(identifyingKeys(out.summary), []);
  assert.ok(!JSON.stringify(out.summary).includes('RX-1'));
});

test('§17.8 item 6: an out-of-network finding takes ONE leg, and the arm must have priced it', async () => {
  const db = await readmissionDb();
  await seedFinding(db, { dedup_key: 'OON-1', finding_class: 'out_of_network', lane: 'out_of_network', readmit_encounter_id: null });
  const frozen = await freezeReadmissionFinding('OON-1', {
    run: runner(db), assemble: (async () => ASSEMBLED) as never, salt: SALT, ...NO_STEPS,
  });
  const { ctx, stages } = ctxFor(frozen.frozen as unknown as Record<string, unknown>, () => CLAIMS);
  const out = await makeReadmissionAdapter().run(ctx);
  assert.deepEqual(stages, ['readmit_oon'], 'decision 13: index side only');
  assert.equal(out.execution_status, 'succeeded');
});

test('§17.8 item 6: an unparseable leg is a FAILED execution, never an unassessable case', async () => {
  const db = await readmissionDb();
  await seedFinding(db);
  const frozen = await freezeReadmissionFinding('RX-1|RX-2', {
    run: runner(db), assemble: (async () => ASSEMBLED) as never, salt: SALT, ...NO_STEPS,
  });
  const { ctx } = ctxFor(frozen.frozen as unknown as Record<string, unknown>, () => 'not json at all');
  const out = await makeReadmissionAdapter().run(ctx);
  // ⚠️ THE TWO MUST NOT BE CONFUSED. `unassessable` means the engine answered "I cannot say";
  // this is nothing answering at all, which production treats as a retry.
  assert.equal(out.execution_status, 'failed');
  assert.equal(out.assessment_status, 'not_reached');
  assert.equal(out.summary.error, 'recon_failed');
});

test('§17.8 item 6: a bad frozen shape fails the item rather than throwing at the worker', async () => {
  const { ctx } = ctxFor({ engine: 'readmission' }, () => CLAIMS);
  const out = await makeReadmissionAdapter().run(ctx);
  assert.equal(out.execution_status, 'failed');
  assert.equal(out.summary.error, 'bad_frozen_inputs');
});

// ─────────────────────────────────────────────────────────────────────────────────────
// The preop freeze and adapter
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ DECISION 111 ITEM 3 — THE REAL ROW SHAPES, EVERY FIELD, ids replaced with the same shape.
 *
 * D1's fixture was a hand-made subset and that is exactly how `patientName` survived: the walk
 * asserted "no denylist key" over an object that never carried the dangerous one. These are
 * `PreopEpisodeRow` (`lib/preop/db13.ts:70`), `PreopLabRow` (`:298`), `PreopIcdRow` (`:347`),
 * `PacRow` (`:228`) and `PreopOpdComorbidityRow` (`:377`) in full.
 */
const EPISODE = {
  docId: 'SC-1', individualUid: 'IND-1', uhid: 'UH-9', patientName: 'A Real Patient',
  age: 64, sex: 'M', procedure: 'Total knee replacement', hospitalUid: 'H-1',
  surgeryDate: '2026-09-20', status: 'scheduled', urgency: 'elective', pacWorkflowStatus: 'complete',
};
const preopSources = (over: Record<string, unknown> = {}) => ({
  fetchUpcomingEpisodes: async () => ({ rows: [EPISODE], error: null }),
  fetchCreatinine: async () => ({ rows: [{ individualUid: 'IND-1', name: 'Creatinine', value: 1.4, unit: 'mg/dL', at: '2026-09-01' }], error: null }),
  fetchOpdIcd: async () => ({ rows: [{ individualUid: 'IND-1', codes: ['E11'], at: '2026-08-01', ref: 'ICD-DOC-1' }], error: null }),
  fetchPacReports: async () => ({ rows: [{ uid: 'PAC-DOC-1', uhid: 'UH-9', status: 'closed', createdAt: '2026-09-02', closingLine: 'Fit for surgery', templateName: 'PAC v3', componentJson: '{}' }], error: null }),
  fetchHospitalNames: async () => ({ rows: [{ uid: 'H-1', name: 'Even Hospital' }], error: null }),
  fetchOpdComorbidities: async () => ({ rows: [{ individualUid: 'IND-1', names: ['Diabetes'], at: '2026-08-01', ref: 'COM-DOC-1' }], error: null }),
  ...over,
}) as never;

test('§17.8 decision 99: the frozen preop case carries no denylist key and no real identifier', async () => {
  const frozen = await freezePreopEpisode('SC-1', { sources: preopSources(), salt: SALT });
  assert.deepEqual(identifyingKeys(frozen.frozen), [], 'the frozen body carries no denylist key');
  const text = JSON.stringify(frozen.frozen);
  for (const real of ['IND-1', 'UH-9', 'SC-1']) {
    assert.ok(!text.includes(real), `${real} must not survive the freeze`);
  }
  // ⚠️ PSEUDONYMISED, NOT DELETED — see the header of sources/preop.ts. The joins the sweep makes
  // need a CONSISTENT identifier, not a real one.
  const ep = (frozen.frozen.sources.fetchUpcomingEpisodes.rows[0] ?? {}) as Record<string, unknown>;
  for (const alias of Object.values(PSEUDONYM_KEYS)) assert.ok(alias in ep, `${alias} is present`);
  assert.match(String(ep.personRef), new RegExp(`^${PSEUDONYM_PREFIX}[0-9a-f]{24}$`));
  assert.equal(ep.procedure, 'Total knee replacement', 'the clinical values ARE the case and are untouched');
  assert.equal(ep.age, 64);
  assert.equal(ep.sex, 'M');
  // ⚠️ DECISION 111 — the patient's NAME is gone entirely, not renamed and not hashed.
  assert.ok(!('patientName' in ep), 'patientName is dropped: nothing in the output path reads it');
  assert.ok(!JSON.stringify(frozen.frozen).includes('A Real Patient'));
  // The facility keeps its real value under a name the denylist does not match — decision 100.
  assert.equal(ep.facilityRef, 'H-1', 'a facility is not a person');
  // Consistent within the case, which is all the joins need.
  const creat = (frozen.frozen.sources.fetchCreatinine.rows[0] ?? {}) as Record<string, unknown>;
  assert.equal(creat.personRef, ep.personRef, 'the surrogate joins the labs to the episode');
  assert.equal(pseudonym('IND-1', SALT), ep.personRef);
  assert.notEqual(pseudonym('IND-1', 'other-salt'), ep.personRef, 'and it is salted');
  // The hospital directory is NOT pseudonymised: it is not about a patient (decision 100's reasoning).
  assert.equal((frozen.frozen.sources.fetchHospitalNames.rows[0] as Record<string, unknown>).facilityRef, 'H-1',
    'and the directory joins to it under the SAME name, so run.ts:529 still lands');
  assert.equal((frozen.frozen.sources.fetchHospitalNames.rows[0] as Record<string, unknown>).label, 'Even Hospital');
  assert.match(frozen.member_key ?? '', /^[0-9a-f]{16,}$/);
  assert.match(frozen.case_key, /^preop:[0-9a-f]{32}$/);
});

test('§17.8: the preop freeze keeps a source FAULT, and refuses an episode it cannot see', async () => {
  // ⚠️ THE 26 AUGUST LESSON, PRESERVED. A source that faulted and a source that is empty produce
  // the same rows; a freeze that kept only rows would replay a 504 as "no ICD codes".
  const frozen = await freezePreopEpisode('SC-1', {
    salt: SALT,
    sources: preopSources({ fetchOpdIcd: async () => ({ rows: [], error: 'icd: HTTP 504' }) }),
  });
  assert.equal(frozen.frozen.sources.fetchOpdIcd.error, 'icd: HTTP 504');
  assert.deepEqual(frozen.source_versions.degraded, ['fetchOpdIcd']);

  await assert.rejects(() => freezePreopEpisode('NOT-THERE', { sources: preopSources(), salt: SALT }),
    (e: LabError) => e.code === 'CASE_NOT_FOUND');
  await assert.rejects(() => freezePreopEpisode('', { sources: preopSources(), salt: SALT }),
    (e: LabError) => e.code === 'INVALID_INPUT');
});

test('§17.8: pseudonymiseRows renames and replaces, at depth, and touches nothing else', () => {
  const out = pseudonymiseRows([{ individualUid: 'A', nested: { uhid: 'B', keep: 1 }, list: [{ docId: 'C' }] }], SALT) as Record<string, unknown>[];
  assert.ok('personRef' in out[0] && !('individualUid' in out[0]));
  const nested = out[0].nested as Record<string, unknown>;
  assert.ok('personAltRef' in nested && nested.keep === 1);
  assert.ok('episodeRef' in ((out[0].list as Record<string, unknown>[])[0]));
  assert.deepEqual(identifyingKeys(out), []);
  // And the adapter's inverse restores exactly what the engine reads.
  const back = restoreKeys(out, { personRef: 'individualUid', personAltRef: 'uhid', episodeRef: 'docId' }) as Record<string, unknown>[];
  assert.ok('individualUid' in back[0]);
  assert.equal((back[0].nested as Record<string, unknown>).uhid, pseudonym('B', SALT), 'the VALUE stays a surrogate');
});

test('§17.8 item 8: the adapter passes dryRun TRUE, only this episode, and both flags from the ARM', async () => {
  const frozen = await freezePreopEpisode('SC-1', { sources: preopSources(), salt: SALT });
  const { ctx } = ctxFor(frozen.frozen as unknown as Record<string, unknown>, () => '{}', { rails: { extraction: true, narrative: false } });
  const out = await makePreopAdapter().run(ctx);

  assert.equal(out.execution_status, 'succeeded');
  const sweep = out.result as { episodes: number; written: Record<string, number> };
  assert.equal(sweep.episodes, 1, 'onlyEpisodes narrowed the sweep to the frozen one');
  // ⚠️ ASSERTED, NOT ASSUMED. `written` is store.ts's own outcome tally and dryRun is the flag every
  // preop write hides behind; an empty tally is the proof that nothing was written.
  assert.deepEqual(Object.values(sweep.written ?? {}).filter((n) => n > 0), []);
  assert.deepEqual(out.summary.written, sweep.written);
  assert.deepEqual(out.summary.rails, { extraction: true, narrative: false }, 'from the arm, never from env');
  assert.equal(out.summary.tier_rule_version, 'preop-tier/0');
  assert.ok(typeof out.summary.tier === 'string' && String(out.summary.tier).length > 0);
  assert.equal(out.assessment_status, 'assessed');
  assert.deepEqual(identifyingKeys(out.summary), []);
});

test('§17.8 item 8: with both rails off the sweep still tiers the episode and makes NO model call', async () => {
  const frozen = await freezePreopEpisode('SC-1', { sources: preopSources(), salt: SALT });
  const { ctx, stages } = ctxFor(frozen.frozen as unknown as Record<string, unknown>, () => '{}', {});
  const out = await makePreopAdapter().run(ctx);
  assert.deepEqual(stages, [], 'the deterministic score is the engine; the two legs are additions to it');
  assert.equal(out.summary.suggest_legs, 0);
  assert.equal(out.summary.narrative_legs, 0);
  assert.equal(out.execution_status, 'succeeded');
});

test('§17.8 item 8: a bad frozen shape fails the item by name', async () => {
  const { ctx } = ctxFor({ engine: 'preop' }, () => '{}');
  const out = await makePreopAdapter().run(ctx);
  assert.equal(out.execution_status, 'failed');
  assert.equal(out.summary.error, 'bad_frozen_inputs');
});

// ═════════════════════════════════════════════════════════════════════════════════════
// ITEM 9 — the golden A/B
// ═════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ WHAT THIS PROVES AND WHAT IT DOES NOT.
 *
 * §17.8 item 9 asks for "five findings already audited by production, replayed through the adapter
 * at the same model, verdict equal on five of five". The builder has no production database, so the
 * five are fixtures — and a fixture whose expected verdict the builder TYPED would prove nothing at
 * all. The first draft did exactly that and this test caught it, naming three findings whose
 * verdicts I had guessed wrong.
 *
 * So the A/B is between the TWO DRIVERS, which is what item 9 is actually protecting:
 *   A — `runReconSequence` driven by the adapter, through the gateway;
 *   B — `runReconSequence` driven exactly as `runReadmissionAudit` (`run.ts:526`) drives it: a
 *       plain `pass` closure returning the same stored replies.
 * Same engine, same claims, same lane logic; the ONLY difference is the transport. If a verdict
 * moves between them, this adapter is driving the production sequence differently from the
 * production worker, which is the one thing that would make every readmission run in this platform
 * incomparable to the row it is supposed to reproduce.
 *
 * The stored-verdict READ is exercised too: side B's verdict is written into the fixture row and
 * `auditedVerdict` reads it back through the real statement, so the path the live verification uses
 * is covered even though the live row is not here.
 */
const GOLDEN: { dedup_key: string; lane: string; finding_class: string; claims: Record<string, unknown> }[] = [
  { dedup_key: 'G-1', lane: 'tight_bounce', finding_class: 'even_even',
    claims: { planned: { verdict: 'unplanned' }, same_condition: { verdict: 'same' }, avoidable: { verdict: 'avoidable', rationale: 'incomplete index care' } } },
  { dedup_key: 'G-2', lane: 'er_routed', finding_class: 'even_even',
    claims: { planned: { verdict: 'unplanned' }, same_condition: { verdict: 'different' }, avoidable: { verdict: 'justified', rationale: 'new unrelated diagnosis' } } },
  { dedup_key: 'G-3', lane: 'structural_30d', finding_class: 'even_even',
    claims: { planned: { verdict: 'unknown' }, same_condition: { verdict: 'unknown' }, avoidable: { verdict: 'uncertain', rationale: 'evidence thin on both sides' } } },
  { dedup_key: 'G-4', lane: 'out_of_network', finding_class: 'out_of_network',
    claims: { planned: { verdict: 'unplanned' }, same_condition: { verdict: 'unknown' }, avoidable: { verdict: 'uncertain', rationale: 'other hospital, index side only' } } },
  { dedup_key: 'G-5', lane: 'other', finding_class: 'even_even',
    claims: { planned: { verdict: 'planned' }, same_condition: { verdict: 'different' }, avoidable: { verdict: 'justified', rationale: 'planned staged procedure' } } },
];

test('§17.8 item 9: the readmission golden A/B — five of five, or the round fails and names the finding', async () => {
  const db = await readmissionDb();
  const rows: { finding: string; lane: string; production: string | null; replay: string | null; equal: boolean; execution: string; assessment: string }[] = [];

  for (const g of GOLDEN) {
    const frozenRow = {
      finding_class: g.finding_class, lane: g.lane, gap_days: 4,
      readmit_admit_at: '2026-08-05T09:00:00+05:30', index_discharge_at: '2026-08-01T10:00:00+05:30',
      form_is_planned: false, form_same_condition: true,
    };
    const reply = JSON.stringify(g.claims);

    // ── SIDE B: production's own driver shape — a plain closure, exactly as vertexPass is passed.
    let bVerdict: string | null = null;
    try {
      const seq = await runReconSequence({
        row: frozenRow as never,
        inputs: (ASSEMBLED as { inputs: unknown }).inputs as never,
        indexDischargeAt: frozenRow.index_discharge_at,
        pass: async () => parsePassClaims(reply),
      });
      bVerdict = seq.finding?.avoidable?.verdict ?? null;
    } catch { bVerdict = null; }

    // The row production would have written, so the real statement is exercised on the way back.
    await seedFinding(db, {
      dedup_key: g.dedup_key, lane: g.lane, finding_class: g.finding_class,
      readmit_encounter_id: g.finding_class === 'out_of_network' ? null : 'IPX-2',
      finding: JSON.stringify({ avoidable: bVerdict ? { verdict: bVerdict } : null }),
      audit_status: bVerdict ? 'audited' : 'failed',
    });
    const stored = await auditedVerdict(g.dedup_key, { run: runner(db) });

    // ── SIDE A: the adapter, through the gateway. Rule 1a / decision 114: the freeze is told to
    // record no steps, because "through the gateway" is what this comparison is OF; D2a's exact
    // path has its own golden A/B in `d2a-readmission-replay.test.ts`.
    const frozen = await freezeReadmissionFinding(g.dedup_key, {
      run: runner(db), assemble: (async () => ASSEMBLED) as never, salt: SALT, ...NO_STEPS,
    });
    const { ctx } = ctxFor(frozen.frozen as unknown as Record<string, unknown>, () => reply);
    const out = await makeReadmissionAdapter().run(ctx);
    const replay = out.summary.avoidable_verdict == null ? null : String(out.summary.avoidable_verdict);

    rows.push({
      finding: g.dedup_key, lane: g.lane, production: stored?.verdict ?? null, replay,
      equal: (stored?.verdict ?? null) === replay,
      execution: out.execution_status, assessment: out.assessment_status,
    });
  }

  const differed = rows.filter((r) => !r.equal);
  assert.deepEqual(differed.map((d) => `${d.finding} production=${d.production} replay=${d.replay}`), [],
    'the golden A/B must be five of five; the adapter drives runReconSequence differently from the worker');
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((r) => r.equal).length, 5);
  // ⚠️ AND NOT FIVE OF THE SAME. Three lanes and two verdict outcomes are exercised, so "five of
  // five" is a statement about the engine's paths and not about one of them repeated.
  assert.ok(new Set(rows.map((r) => r.lane)).size >= 4, 'four lanes, including out_of_network');
  assert.ok(new Set(rows.map((r) => r.replay)).size >= 2, 'more than one outcome');

  /**
   * ⚠️ TWO OF THE FIVE AGREE ON `null`, AND "EQUAL BECAUSE BOTH FAILED" WOULD BE WORTHLESS. So the
   * two nulls are proved to be the engine DECLINING for a documented reason rather than crashing:
   *   · G-4 `out_of_network` — decision 13, index side only, no avoidable verdict on the other
   *     hospital. The engine produces a finding and deliberately no money verdict.
   *   · G-5 lane `other` — decision 9, the condition pass alone, promoted to the full pair only on
   *     a `same` verdict. These claims say `different`, so it is not promoted and there is no
   *     avoidable verdict to give.
   * Both are `succeeded` executions and `unassessable` assessments, which is §9 working: the
   * engine ran, and it answered that the clinical question does not apply here.
   */
  for (const r of rows) {
    assert.equal(r.execution, 'succeeded', `${r.finding} must have RUN, whatever it concluded`);
    assert.equal(r.assessment, r.replay == null ? 'unassessable' : 'assessed', `${r.finding} statuses`);
  }
  assert.deepEqual(rows.filter((r) => r.replay == null).map((r) => r.lane).sort(), ['other', 'out_of_network']);
  // The verdicts every one of them produced, printed so the report can carry the table.
  console.log('GOLDEN A/B', JSON.stringify(rows));
});

// ═════════════════════════════════════════════════════════════════════════════════════
// SQL HONESTY — the decision 79 grep, extended to Slice D's tables
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.8: no file under lib/lab-v2/sources or adapters WRITES a production table', () => {
  const { readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const root = process.cwd();
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(root, 'lib/lab-v2/sources'));
  walk(join(root, 'lib/lab-v2/adapters'));
  assert.ok(files.length >= 12, `expected both trees to be walked, saw ${files.length}`);

  /**
   * ⚠️ THE SAME GREP DECISION 79 BUILT FOR `mksap_chunks`, WIDENED TO SLICE D's TABLES. The
   * argument is identical: a research platform that writes a production clinical row has stopped
   * being a research platform, and the only thing that keeps that true is a test that reads every
   * line rather than a convention everyone remembers.
   */
  const TABLES = /readmission_|preop_|discharge_|ipd_|trace_events/;
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // Comments stripped: these files EXPLAIN which production writers they avoid, and prose about
    // a write is not a write.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [i, line] of code.split('\n').entries()) {
      for (const verb of ['INSERT INTO', 'UPDATE ', 'DELETE FROM']) {
        if (!line.includes(verb)) continue;
        if (!TABLES.test(line)) continue;
        hits.push(`${f.slice(root.length + 1)}:${i + 1} — ${line.trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `a v2 write to a Slice D production table:\n${hits.join('\n')}`);
  // And prove the grep can see one, so a green result means something.
  const probe = `${'INSERT INTO '}readmission_findings (dedup_key) VALUES ($1)`;
  assert.ok(TABLES.test(probe) && probe.includes('INSERT INTO '), 'the pattern matches a real write');
});

test('§17.8: the readmission adapter never reaches the production audit wrapper or the store', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const src = readFileSync(join(process.cwd(), 'lib/lab-v2/adapters/readmission.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // ⚠️ IT CALLS THE SEQUENCE, NOT THE WRAPPER. `runReadmissionAudit` (run.ts:506) is what writes:
  // saveAuditResult, startTrace, servedReadmitCall and the narrative leg. The IPD adapter injects a
  // no-op writer; here the shorter path exists, so the store is not reached at all rather than
  // reached and neutered.
  assert.ok(code.includes('runReconSequence'), 'the production sequence, imported');
  assert.ok(!code.includes('runReadmissionAudit'), 'never the writing wrapper');
  for (const forbidden of ['saveAuditResult', 'recordAuditError', 'composeCaseArtefacts', 'startTrace']) {
    assert.ok(!code.includes(forbidden), `the adapter must not reach ${forbidden}`);
  }
  // And `vertexPass`'s region is untouched — readmission-r41-refresh.test.ts:201 pins its sha256.
  const run = readFileSync(join(process.cwd(), 'lib/readmission/run.ts'), 'utf8');
  const a = run.indexOf('async function vertexPass(');
  const b = run.indexOf('// ── Phase 1.5');
  assert.ok(a > 0 && b > a, 'the pinned region is where it was');
  assert.ok(!run.slice(a, b).includes('opts.sources'), 'and the D1 seam is nowhere inside it');
});

// ═════════════════════════════════════════════════════════════════════════════════════
// DECISION 111 ITEM 3 — the key inventory. A new key fails until someone classifies it.
// ═════════════════════════════════════════════════════════════════════════════════════

/** Every key in a body, at every depth, sorted and de-duplicated. */
function keyInventory(v: unknown, out = new Set<string>(), depth = 0): string[] {
  if (depth > 12 || v === null || typeof v !== 'object') return [...out].sort();
  if (Array.isArray(v)) { for (const x of v) keyInventory(x, out, depth + 1); return [...out].sort(); }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) { out.add(k); keyInventory(val, out, depth + 1); }
  return [...out].sort();
}

/**
 * ⚠️ THIS IS THE TEST DECISION 111 ACTUALLY ASKS FOR, AND IT IS NOT THE DENYLIST WALK.
 *
 * The walk asks "does this body carry a key I already know is dangerous". That question passed on
 * `indexDocumentId` for the whole of D1, because the pattern had never been told about it — an
 * allow-by-omission check cannot catch a key nobody classified.
 *
 * This asks the opposite question: "IS EVERY KEY IN THIS BODY ONE SOMEBODY LOOKED AT". A new field
 * in an upstream engine — a column added to `readmission_findings`, a field added to
 * `PreopEpisodeRow` — fails this test on the day it appears, and the fix is to put it in the list
 * having decided what it is. That is the difference between a denylist and an inventory, and it is
 * why both are here.
 */
test('§17.8 decision 111: the frozen READMISSION body carries exactly these keys, and no others', async () => {
  const db = await readmissionDb();
  await seedFinding(db);
  const frozen = await freezeReadmissionFinding('RX-1|RX-2', {
    run: runner(db), assemble: (async () => ASSEMBLED) as never, salt: SALT,
  });
  /**
   * ⚠️ RULE 1a / DECISION 114 — THE HASHES ARE EXCLUDED, AND THAT IS NOT A HOLE IN THE INVENTORY.
   * `frozen.steps` is keyed by `dependencyHash(params)`, so its keys are 64-hex digests that no
   * list can name in advance. They are asserted by SHAPE in the test below — exactly 64 hex, one
   * per leg the lane fires — and everything else in the body still has to be a key somebody
   * classified. A non-hash key appearing under `steps` fails here, which is the property.
   */
  const inventory = keyInventory(frozen.frozen).filter((k) => !/^[0-9a-f]{64}$/.test(k));
  assert.deepEqual(inventory, [
    // the body itself
    'engine', 'index_discharge_at', 'inputs', 'row', 'steps',
    // frozen.steps[*] — decision 114's recorded leg
    'request_hash', 'served', 'stage',
    // steps[*].served — the POST-fallback identity on the stored reply
    'model', 'provider',
    // frozen.row — the seven PendingRow columns runReconSequence reads
    'finding_class', 'form_is_planned', 'form_same_condition', 'gap_days', 'lane', 'readmit_admit_at',
    // frozen.inputs — ThreeSourceInputs
    'catalog', 'indexSentenceCount', 'labProfile', 'labSourceProvenance', 'labTier', 'readmitSentenceCount',
    // catalog is `{items: EvidenceItem[]}` — the wrapper key, then the item's own
    'items',
    // catalog.items — EvidenceItem
    'abnormal', 'analyte', 'at', 'id', 'side', 'source', 'text',
    // labSourceProvenance — WITHOUT the two document ids decision 111 drops
    'caseLabCount', 'extractionVersion', 'from', 'indexCase', 'readmitCase', 'structuredLabCount',
    'tier', 'to', 'window', 'windowStartInferred',
  ].sort());
  // ⚠️ THE TWO THAT REACHED PRODUCTION, ABSENT — asserted by name as well as by inventory.
  for (const k of DROPPED_PROVENANCE_KEYS) {
    assert.ok(!inventory.includes(k), `${k} must not survive the freeze`);
  }
  assert.ok(!JSON.stringify(frozen.frozen).includes('FIRESTORE-DOC-INDEX-1'));
  assert.ok(!JSON.stringify(frozen.frozen).includes('FIRESTORE-DOC-READMIT-1'));
  // And the rest of the provenance object is KEPT: it is evidence about the audit, not about a person.
  const prov = (frozen.frozen.inputs as { labSourceProvenance: Record<string, unknown> }).labSourceProvenance;
  assert.equal(prov.tier, 'tier1');
  assert.equal(prov.structuredLabCount, 3);
  assert.equal(prov.extractionVersion, 'doc-extract/0.4');
  assert.deepEqual(prov.window, { from: '2026-07-18', to: '2026-08-03' });
  // Every key in the inventory passes the denylist — the two checks agree.
  assert.deepEqual(inventory.filter(isIdentifyingKey), []);
});

/**
 * ⚠️ DECISION 114's KEYS ARE HASHES, so the inventory above cannot name them and this asserts their
 * SHAPE instead: 64 hex characters, one per leg the lane fires, and nothing else in the map.
 */
test('§17.9 decision 114: the frozen readmission body carries `steps` keyed by 64-hex, one per leg', async () => {
  const db = await readmissionDb();
  await seedFinding(db);
  const frozen = await freezeReadmissionFinding('RX-1|RX-2', {
    run: runner(db), assemble: (async () => ASSEMBLED) as never, salt: SALT,
  });
  const steps = frozen.frozen.steps;
  const keys = Object.keys(steps);
  // `tight_bounce` is a full pair: recon A then recon B.
  assert.equal(keys.length, 2);
  for (const k of keys) assert.match(k, /^[0-9a-f]{64}$/, 'a step key is a request hash');
  assert.deepEqual(Object.values(steps).map((v) => v.stage).sort(), ['readmit_recon_a', 'readmit_recon_b']);
  for (const v of Object.values(steps)) {
    assert.equal(v.request_hash, Object.entries(steps).find(([, x]) => x === v)![0], 'the key IS the hash');
    assert.equal(v.text, CLAIMS, 'the step carries production’s stored reply, whole');
    assert.deepEqual(v.served, { model: 'gemini-2.5-pro', provider: 'vertex' });
  }
  // The narrative leg shares the trace and is NOT a step.
  assert.ok(!Object.values(steps).some((v) => v.stage === 'readmit_narrative'));
  // Decision 99's walk covers the new keys, and the count rides on source_versions.
  assert.deepEqual(identifyingKeys(frozen.frozen), []);
  assert.equal(frozen.source_versions.recorded_steps, 2);
});

test('§17.8 decision 111: the frozen PREOP body carries exactly these keys, and no others', async () => {
  const frozen = await freezePreopEpisode('SC-1', { sources: preopSources(), salt: SALT });
  assert.deepEqual(keyInventory(frozen.frozen), [
    // the body itself
    'engine', 'horizon_days', 'now', 'sources',
    // the six source names
    'fetchCreatinine', 'fetchHospitalNames', 'fetchOpdComorbidities', 'fetchOpdIcd',
    'fetchPacReports', 'fetchUpcomingEpisodes',
    // every source's envelope
    'error', 'rows',
    // the episode row — patientName DROPPED, three ids surrogated, hospitalUid renamed
    'age', 'episodeRef', 'facilityRef', 'pacWorkflowStatus', 'personAltRef', 'personRef',
    'procedure', 'sex', 'status', 'surgeryDate', 'urgency',
    // labs, icd, comorbidities, pac, directory
    'at', 'closingLine', 'codes', 'componentJson', 'createdAt', 'label', 'names', 'recordRef',
    'templateName', 'unit', 'value',
  ].sort());
  // ⚠️ THE PATIENT'S NAME IS GONE, and the two document-id families are surrogates, not values.
  assert.ok(!keyInventory(frozen.frozen).includes('patientName'));
  assert.ok(!JSON.stringify(frozen.frozen).includes('A Real Patient'));
  for (const real of ['IND-1', 'UH-9', 'SC-1', 'PAC-DOC-1', 'ICD-DOC-1', 'COM-DOC-1']) {
    assert.ok(!JSON.stringify(frozen.frozen).includes(real), `${real} must not survive the freeze`);
  }
  // ⚠️ AND THE NOT-A-PERSON VALUES SURVIVE INTACT, which is the other half of getting this right.
  const text = JSON.stringify(frozen.frozen);
  for (const kept of ['Total knee replacement', 'Even Hospital', 'H-1', 'PAC v3', 'Fit for surgery', 'Diabetes']) {
    assert.ok(text.includes(kept), `${kept} is evidence and must be kept`);
  }
  assert.deepEqual(keyInventory(frozen.frozen).filter(isIdentifyingKey), []);
});

test('§17.8 decision 111: the adapter restores every alias the freeze created', async () => {
  const frozen = await freezePreopEpisode('SC-1', { sources: preopSources(), salt: SALT });
  const aliases = keyInventory(frozen.frozen).filter((k) => ALL_ALIASES.includes(k));
  // Each of the aliases the freeze actually produced is restorable by the adapter, per source.
  assert.deepEqual(aliases.sort(), ['episodeRef', 'facilityRef', 'label', 'personAltRef', 'personRef', 'recordRef']);
  const { ctx } = ctxFor(frozen.frozen as unknown as Record<string, unknown>, () => '{}', {});
  const out = await makePreopAdapter().run(ctx);
  // ⚠️ THE PROOF THAT THE RESTORE IS RIGHT IS THAT THE ENGINE STILL WORKS: the joins at run.ts:493,
  // :500 and :529 all land, so the episode is found, scored and tiered.
  assert.equal(out.execution_status, 'succeeded');
  assert.equal((out.result as { episodes: number }).episodes, 1);
  assert.ok(typeof out.summary.tier === 'string' && String(out.summary.tier).length > 0);
});
