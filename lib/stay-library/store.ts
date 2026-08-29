/**
 * lib/stay-library/store.ts — the `clinical_states` library store
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P2 / O9; table created by
 * /api/admin/migrate-clinical-states, reference DDL in migrations/0047_clinical_states.sql).
 *
 * FAIL-SOFT WRITES (O9: "log and continue, same spirit as lib/readmission/ask-store.ts"). A library
 * row that fails to persist must not take down the audit that was reading the document — so every
 * function here returns an honest outcome and never throws. Before migration 0047 has run every call
 * soft-fails, `readStayLibrary` returns an empty library, and P3 (which does not exist yet) will read
 * that as "nothing built for this stay", which is exactly what is true.
 *
 * ONE DELIBERATE EXCEPTION TO FAIL-SOFT, and it is upstream of this file: `assertNoAdministered`
 * throws. A storage fault is a lost row; an `administered` claim is a false clinical fact, and the
 * right response to being about to write one is to stop, not to log and continue.
 *
 * WHAT THIS FILE CANNOT TOUCH. It names exactly one table, `clinical_states`. No audit table, no
 * feedback table, no MemberState table, no `episode_states` — P2 writes a library and nothing else
 * (the programme's MemberState write is P4, flag-gated, and is not reachable from here). A test
 * reads this source with comments stripped and asserts it.
 *
 * IDENTITY. `member_uid` is the Firestore member id that `ipd_discharge_audits.member_id` carries.
 * It is NOT an `individual_uid` and must never be treated as one — the hop is P4's job, at fold time
 * (O12), and no Even account number goes on Neon. This column exists so P4 has somewhere to start
 * the hop FROM, not so anything here can resolve a person.
 *
 * H1 (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026, H-D2) ADDS A SECOND TABLE, and exactly
 * one: `clinical_state_versions`, append-only. It is written ONLY as a CTE inside the statement
 * that overwrites a `clinical_states` row, never on its own, and nothing here ever UPDATEs or
 * DELETEs it. The reason that table exists is that this store's upsert overwrites in place: with
 * MEMBERSTATE_IPD_FOLD on, a library overwrite silently changes a member's snapshot, and before H1
 * there was nothing to diff the new snapshot against.
 *
 * ⚠️ INFERRED SQL throughout: this sandbox has no live Neon.
 */
import { sql } from '../db';
import { CLINICAL_STATE_VERSION, type ClinicalState } from '../clinical-state/schema';
import { DOC_KINDS, type DocKind, type StayDocStatus } from './core';

/** One stay never reads more than this many documents back. Above the substrate's own caps
 *  (20 OT + 5 PAC + 40 progress + 1 discharge = 66 at the ceiling). */
const LIBRARY_LIMIT = 200;

const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const isDocKind = (v: unknown): v is DocKind => typeof v === 'string' && (DOC_KINDS as readonly string[]).includes(v);

/**
 * H1 — the ONLY seam this module has, and it exists so the snapshot discipline is testable without
 * a database. Production always gets the real Neon client; a test passes a fake and can therefore
 * assert what SQL was executed, in what order, and what happens when the snapshot leg FAULTS.
 * A discipline that cannot be falsified in a test is a comment, not a discipline.
 */
export type SqlRunner = (query: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
const liveSql: SqlRunner = (query, params) => (sql as unknown as SqlRunner)(query, params);

/** H-D2 — the closed set of reasons a prior reading is kept. Two, and a test enumerates them. */
export const SNAPSHOT_REASONS = ['upsert_overwrite', 'superseded'] as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

/**
 * H1 (H-D2) — the CTE that keeps the row about to be replaced, for splicing in FRONT of the
 * statement that replaces it. Shared so H3's supersede write cannot drift from the upsert's.
 *
 * ONE STATEMENT = ONE TRANSACTION (Neon's HTTP driver has no interactive BEGIN/COMMIT), copied from
 * the R8.1 finding-versions discipline in lib/readmission/store.ts. The consequences are the whole
 * point:
 *   · a crash can never leave an overwrite with no snapshot behind it — both legs travel together;
 *   · a FAILED snapshot ABORTS the statement, so the overwrite does not happen and the caller gets
 *     the module's ordinary fail-soft 'skipped'. The snapshot is not best-effort. It is a gate.
 *   · `cur` reads inside the statement's own MVCC snapshot, so `state_json` is exactly the row
 *     being replaced rather than a re-read that raced it.
 *
 * `where` names the row in the CALLER's own parameter numbering, so the caller keeps its
 * placeholders and nothing has to be renumbered.
 */
function snapshotCte(where: string, reason: SnapshotReason): string {
  return `WITH cur AS (
             SELECT id, doc_kind, source_uid, schema_version, status, state_json
               FROM clinical_states
              WHERE ${where}
           ), snap AS (
             INSERT INTO clinical_state_versions
               (clinical_state_id, doc_kind, source_uid, schema_version, status, state_json, reason)
             SELECT c.id, c.doc_kind, c.source_uid, c.schema_version, c.status, c.state_json, '${reason}'
               FROM cur c
             RETURNING id
           )
           `;
}

export interface StoredClinicalState {
  id: string;
  docKind: DocKind;
  sourceUid: string;
  memberUid: string | null;
  encounterRef: string | null;
  schemaVersion: string;
  status: StayDocStatus;
  state: ClinicalState;
  createdAt: string | null;
}

export interface UpsertClinicalStateInput {
  docKind: DocKind;
  sourceUid: string;
  memberUid?: string | null;
  encounterRef?: string | null;
  status: StayDocStatus;
  state: ClinicalState;
  schemaVersion?: string;
}

export type UpsertOutcome = 'inserted' | 'updated' | 'skipped';

/**
 * Upsert ONE document's state. Idempotent on O9's unique key (doc_kind, source_uid,
 * schema_version): re-building the same document at the same schema version overwrites its own row
 * rather than growing the table, which is what makes a re-run of a stay safe — including a re-run
 * that now finds an OT note where the last one recorded an absence, because the absence row is keyed
 * on the stay (`absentSourceUid`) and is replaced in place.
 *
 * NEVER THROWS — 'skipped' on any fault (O9).
 *
 * H1 (H-D2). The DO UPDATE arm can no longer run without the prior row landing in
 * `clinical_state_versions` FIRST, in the same statement. The shape is lifted from R8.1's
 * `saveAuditResult`: read whether a row is already there, then choose the SQL. Two consequences
 * are deliberate and neither is an accident of the copy —
 *   · a FRESH INSERT never names the versions table at all, so a deploy that lands before the
 *     migration keeps building libraries for documents nobody has stored yet, rather than failing
 *     every write until an operator runs a route;
 *   · an OVERWRITE always names it, so before the migration an overwrite soft-fails. That is
 *     H-D2 working, not breaking: an overwrite that cannot be snapshotted must not happen.
 * Residual race, stated rather than hidden and identical to R8.1's: if another writer INSERTs
 * between the pre-read and the statement, the DO UPDATE arm fires with no snapshot. It is a
 * same-key concurrent rebuild of the same stay, the pre-read is one hop wide, and closing it would
 * need the versions table named on every path — which is the operational cost above.
 */
export async function upsertClinicalState(
  input: UpsertClinicalStateInput,
  run: SqlRunner = liveSql,
): Promise<UpsertOutcome> {
  if (!input || !isDocKind(input.docKind) || !input.sourceUid || !input.state) return 'skipped';
  const schemaVersion = input.schemaVersion || CLINICAL_STATE_VERSION;
  const key = `doc_kind = $1 AND source_uid = $2 AND schema_version = $5`;
  const upsertSql =
    `INSERT INTO clinical_states
         (doc_kind, source_uid, member_uid, encounter_ref, schema_version, status, state_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (doc_kind, source_uid, schema_version) DO UPDATE
         SET member_uid   = EXCLUDED.member_uid,
             encounter_ref = EXCLUDED.encounter_ref,
             status       = EXCLUDED.status,
             state_json   = EXCLUDED.state_json,
             created_at   = NOW()
       RETURNING (xmax = 0) AS inserted`;
  const params = [
    input.docKind, input.sourceUid, input.memberUid ?? null, input.encounterRef ?? null,
    schemaVersion, input.status === 'not_auditable' ? 'not_auditable' : 'ok',
    JSON.stringify(input.state),
  ];
  try {
    // Is there a prior reading to keep? A read fault answers "unknown", and unknown must mean
    // "assume yes": taking the snapshot path on a stay that turns out to be fresh costs an empty
    // CTE, while skipping it on a stay that turns out to have a row would overwrite unsnapshotted.
    let hasPrior = true;
    try {
      // Its own placeholder numbering, not the upsert's: an unreferenced $3 in a prepared
      // statement is a hard "could not determine data type of parameter" error, not a spare slot.
      const prior = await run(
        `SELECT id FROM clinical_states WHERE doc_kind = $1 AND source_uid = $2 AND schema_version = $3 LIMIT 1`,
        [input.docKind, input.sourceUid, schemaVersion]);
      hasPrior = prior.length > 0;
    } catch { /* unknown ⇒ snapshot path, per the comment above */ }

    const rows = (await run(
      hasPrior ? snapshotCte(key, 'upsert_overwrite') + upsertSql : upsertSql,
      params,
    )) as Array<{ inserted: boolean }>;
    return rows[0]?.inserted ? 'inserted' : 'updated';
  } catch {
    return 'skipped';
  }
}

/**
 * Every document this library holds for ONE stay, oldest first. Fail-safe: any DB error — including
 * the migration not having run — returns an empty library and an honest error line, never a throw.
 *
 * An empty library and a stay with no documents are DIFFERENT answers and the caller can tell them
 * apart: a built stay always has a row per class, including the `not_auditable` ones.
 */
export async function readStayLibrary(
  encounterRef: string,
  schemaVersion: string = CLINICAL_STATE_VERSION,
): Promise<{ documents: StoredClinicalState[]; error: string | null }> {
  if (!encounterRef) return { documents: [], error: 'encounter ref required' };
  try {
    const rows = (await sql(
      `SELECT id, doc_kind, source_uid, member_uid, encounter_ref, schema_version, status, state_json,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM clinical_states
        WHERE encounter_ref = $1 AND schema_version = $2
        ORDER BY created_at ASC
        LIMIT ${LIBRARY_LIMIT}`,
      [encounterRef, schemaVersion],
    )) as Array<Record<string, unknown>>;
    return { documents: rows.map(toStored).filter((r): r is StoredClinicalState => r != null), error: null };
  } catch (e) {
    return { documents: [], error: `stay library unavailable: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/** One document by its own key. Null on absent OR on fault — the caller rebuilds either way. */
export async function readClinicalState(
  docKind: DocKind,
  sourceUid: string,
  schemaVersion: string = CLINICAL_STATE_VERSION,
): Promise<StoredClinicalState | null> {
  if (!isDocKind(docKind) || !sourceUid) return null;
  try {
    const rows = (await sql(
      `SELECT id, doc_kind, source_uid, member_uid, encounter_ref, schema_version, status, state_json,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM clinical_states
        WHERE doc_kind = $1 AND source_uid = $2 AND schema_version = $3
        LIMIT 1`,
      [docKind, sourceUid, schemaVersion],
    )) as Array<Record<string, unknown>>;
    return toStored(rows[0]);
  } catch {
    return null;
  }
}

/** Coverage counts for the whole library, for the migrate route's report and an admin readout.
 *  Empty on any fault — a counting failure never blocks anything. */
export async function libraryCounts(
  schemaVersion: string = CLINICAL_STATE_VERSION,
): Promise<{ total: number; byKind: Record<string, { ok: number; not_auditable: number }> }> {
  try {
    const rows = (await sql(
      `SELECT doc_kind, status, count(*)::int AS n
         FROM clinical_states WHERE schema_version = $1
        GROUP BY doc_kind, status`,
      [schemaVersion],
    )) as Array<{ doc_kind: string; status: string; n: number }>;
    const byKind: Record<string, { ok: number; not_auditable: number }> = {};
    let total = 0;
    for (const r of rows) {
      const k = String(r.doc_kind);
      byKind[k] ??= { ok: 0, not_auditable: 0 };
      const n = Number(r.n ?? 0);
      if (String(r.status) === 'not_auditable') byKind[k].not_auditable += n; else byKind[k].ok += n;
      total += n;
    }
    return { total, byKind };
  } catch {
    return { total: 0, byKind: {} };
  }
}

function toStored(row: Record<string, unknown> | undefined): StoredClinicalState | null {
  if (!row || !isDocKind(row.doc_kind)) return null;
  const raw = row.state_json;
  let state: ClinicalState | null = null;
  try {
    state = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ClinicalState;
  } catch {
    return null;   // an unreadable state is not a state; the caller rebuilds
  }
  if (!state || typeof state !== 'object') return null;
  return {
    id: String(row.id ?? ''),
    docKind: row.doc_kind,
    sourceUid: String(row.source_uid ?? ''),
    memberUid: s(row.member_uid),
    encounterRef: s(row.encounter_ref),
    schemaVersion: String(row.schema_version ?? ''),
    status: String(row.status) === 'not_auditable' ? 'not_auditable' : 'ok',
    state,
    createdAt: s(row.created_at),
  };
}
