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
 */
export async function upsertClinicalState(input: UpsertClinicalStateInput): Promise<UpsertOutcome> {
  if (!input || !isDocKind(input.docKind) || !input.sourceUid || !input.state) return 'skipped';
  const schemaVersion = input.schemaVersion || CLINICAL_STATE_VERSION;
  try {
    const rows = (await sql(
      `INSERT INTO clinical_states
         (doc_kind, source_uid, member_uid, encounter_ref, schema_version, status, state_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (doc_kind, source_uid, schema_version) DO UPDATE
         SET member_uid   = EXCLUDED.member_uid,
             encounter_ref = EXCLUDED.encounter_ref,
             status       = EXCLUDED.status,
             state_json   = EXCLUDED.state_json,
             created_at   = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [
        input.docKind, input.sourceUid, input.memberUid ?? null, input.encounterRef ?? null,
        schemaVersion, input.status === 'not_auditable' ? 'not_auditable' : 'ok',
        JSON.stringify(input.state),
      ],
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
