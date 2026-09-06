/**
 * lib/lab-v2/sources/readmission.ts — freeze ONE readmission finding as a case
 * (LAB-MCP-V2-PRD-v1.0 §17.8 round D1, decisions 99, 101 and 104).
 *
 * ⚠️ THE IDENTIFIER IS USED AND NEVER STORED, and that sentence is the whole file.
 *
 * Decision 99: Lab v2 never retains identifying data. A readmission finding is keyed by
 * `dedup_key`, which names an index/readmit encounter pair and therefore one member — so the
 * caller sends it, this function READS with it, and what comes back carries a salted hash and no
 * id column at all. There is no retention policy because nothing is retained.
 *
 * ⚠️ THE FREEZE RUNS OUTSIDE THE FENCE, DELIBERATELY AND EXPLICITLY. `assembleForRow`
 * (`lib/readmission/run.ts:314`) reads `discharge_extracted_cases` through `sql` and db13 through
 * `metabaseQuery`, and both throw `LAB_IO_FORBIDDEN` inside a lab execution context. That is §7
 * working, not an obstacle: `dataset_create` runs outside any context, and `exitLabExecution`
 * makes that a property of THIS function rather than an assumption about its caller — exactly as
 * B1 froze retrieval. A run then executes against the frozen bytes and reads nothing live.
 *
 * ⚠️ AND `identity` IS DROPPED, NOT SCRUBBED. `AssembledPair.identity` carries the names and UHIDs
 * the de-identification scrub matched on; `run.ts:258` says in as many words that it is never
 * persisted. The narrative leg is the only consumer and decision 104 puts it out of scope for D1,
 * so this file does not carry it forward at all. Dropping beats scrubbing: a scrub can miss.
 */
import { createHash } from 'crypto';
import { exitLabExecution } from '../../lab-execution-context';
import { LabError } from '../contracts';
import { identifyingKeys } from './requests';
import { memberKeyOf, memberSalt } from './opd';
import { sql } from '../../db';
import { assembleForRow } from '../../readmission/run';
import type { PendingRow } from '../../readmission/store';

/**
 * THE ONE READ. INFERRED — no live database was available to the builder — and modelled column
 * for column on `pendingFindings` (`lib/readmission/store.ts:315`), which is production's own
 * selection for exactly these rows. The differences from it are deliberate and are only these:
 * one `dedup_key` instead of a lane/day window, and no `audit_status` filter, because a lab run
 * replays findings production has ALREADY audited (the golden A/B) as well as pending ones.
 */
export const READMISSION_FINDING_SQL = `SELECT dedup_key, finding_class, index_encounter_id, readmit_encounter_id,
       form_uid, uhid, lane, gap_days, index_department, readmit_department, index_doctor, readmit_doctor,
       to_char(index_discharge_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS index_discharge_at,
       to_char(readmit_admit_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS readmit_admit_at,
       cm_note, form_is_planned, form_same_condition, audit_status, engine_version
  FROM readmission_findings
 WHERE dedup_key = $1
 LIMIT 1`;

/**
 * The audited verdict production already recorded, for the golden A/B (item 9). A READ, and the
 * only thing this platform ever wants out of the audited half of the table.
 */
export const READMISSION_VERDICT_SQL = `SELECT dedup_key, audit_status, engine_version,
       finding->'avoidable'->>'verdict' AS verdict, model, provider
  FROM readmission_findings
 WHERE dedup_key = $1
 LIMIT 1`;

/**
 * The columns of `PendingRow` that `runReconSequence` actually reads, measured at
 * `lib/readmission/run.ts:442-500`: `finding_class`, `lane`, `gap_days`, `readmit_admit_at`,
 * `form_is_planned`, `form_same_condition`. `index_discharge_at` rides beside them because the
 * sequence takes it as its own argument.
 *
 * ⚠️ EVERYTHING ELSE IS DROPPED, INCLUDING THE THINGS DECISION 100 WOULD HAVE ALLOWED.
 * `index_doctor` and `readmit_doctor` are clinician names, which decision 100 rules are not
 * identifying — and they are dropped anyway, because the engine does not read them. A frozen case
 * carrying a field nothing consumes is a field that can only ever leak.
 */
export const FROZEN_ROW_FIELDS = [
  'finding_class', 'lane', 'gap_days', 'readmit_admit_at', 'index_discharge_at',
  'form_is_planned', 'form_same_condition',
] as const;

export interface FrozenReadmissionCase {
  case_key: string;
  member_key: string | null;
  frozen: {
    engine: 'readmission';
    /** The `PendingRow` subset above, and nothing else. */
    row: Record<string, unknown>;
    /** `ThreeSourceInputs`, de-identified upstream by `assembleForRow`. */
    inputs: unknown;
    index_discharge_at: string | null;
  };
  source_versions: Record<string, unknown>;
}

export interface ReadmissionSourceDeps {
  run?: (statement: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
  assemble?: typeof assembleForRow;
  salt?: string;
}

const liveRun = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * ⚠️ THE LAST GATE, AND IT RUNS ON WHAT IS ABOUT TO BE STORED RATHER THAN ON WHAT WAS PLANNED.
 * `assembleForRow` de-identifies its own inputs, and this asserts that it did. Decision 99's test
 * walks the stored object; this refuses to create one, which is a round earlier and cheaper.
 * A hit is a REFUSAL, never a scrub: silently removing a key would hide a change in an upstream
 * engine that this platform would then be the last to notice.
 */
export function refuseIdentifying(body: unknown, what: string): void {
  const hits = identifyingKeys(body);
  if (hits.length) {
    throw new LabError('CLASSIFICATION_REQUIRED',
      `${what} carries identifying key(s) ${hits.join(', ')} after de-identification. `
      + 'Decision 99: nothing identifying is written to lab_v2, so this case is refused rather than scrubbed — '
      + 'a scrub would hide a change in the upstream engine.');
  }
}

export async function freezeReadmissionFinding(
  dedupKey: string, deps: ReadmissionSourceDeps = {},
): Promise<FrozenReadmissionCase> {
  const key = String(dedupKey ?? '').trim();
  if (!key) throw new LabError('INVALID_INPUT', 'a readmission case is one finding, named by its dedup_key');
  const run = deps.run ?? liveRun;
  const assemble = deps.assemble ?? assembleForRow;

  // ⚠️ OUTSIDE THE FENCE. See the header: both reads below throw inside a lab context by design.
  return exitLabExecution(async () => {
    const rows = await run(READMISSION_FINDING_SQL, [key]);
    const row = rows[0] as PendingRow | undefined;
    if (!row) throw new LabError('CASE_NOT_FOUND', `no readmission_findings row for that dedup_key`);

    const assembled = await assemble(row);
    if ('notAuditable' in assembled) {
      // Tier 3 and its siblings are a real answer about the finding, not a failure to read it —
      // but they are not a CASE, because there is nothing for the recon legs to reconcile.
      throw new LabError('CASE_NOT_FOUND',
        `that finding is not auditable: ${String(assembled.notAuditable)}. Production would write not_auditable and stop, and so does this.`);
    }

    const frozenRow: Record<string, unknown> = {};
    for (const f of FROZEN_ROW_FIELDS) frozenRow[f] = (row as Record<string, unknown>)[f] ?? null;

    const frozen = {
      engine: 'readmission' as const,
      row: frozenRow,
      // `identity` is NOT carried forward — see the header.
      inputs: assembled.inputs,
      index_discharge_at: assembled.indexDischargeAt ?? null,
    };
    refuseIdentifying(frozen, 'the frozen readmission case');

    const salt = deps.salt ?? memberSalt();
    return {
      /**
       * ⚠️ THE CASE KEY IS A HASH OF THE dedup_key, NEVER THE dedup_key. Decision 101 makes
       * `dedup_key` an identifying field, and a case key is stored on the dataset, on every item
       * and in every report. Hashing it keeps two runs of the same finding comparable — which is
       * all a case key is for — without the platform holding the pair.
       */
      case_key: `readmit:${createHash('sha256').update(`${salt}|${key}`).digest('hex').slice(0, 32)}`,
      // Decision 104. `uhid` is the member identifier on this row; absent it, no key rather than a
      // hash of the empty string, which would collide across every member that lacks one.
      member_key: row.uhid ? memberKeyOf(String(row.uhid), salt) : null,
      frozen,
      source_versions: {
        origin: 'readmission_findings',
        audit_status: row.audit_status ?? null,
        engine_version: row.engine_version ?? null,
        frozen_at: new Date().toISOString(),
      },
    };
  });
}

/** The verdict production recorded for this finding — the golden A/B's B side. */
export async function auditedVerdict(
  dedupKey: string, deps: ReadmissionSourceDeps = {},
): Promise<{ verdict: string | null; audit_status: string | null; engine_version: string | null; model: string | null } | null> {
  const run = deps.run ?? liveRun;
  return exitLabExecution(async () => {
    const rows = await run(READMISSION_VERDICT_SQL, [String(dedupKey)]);
    const r = rows[0];
    if (!r) return null;
    return {
      verdict: r.verdict == null ? null : String(r.verdict),
      audit_status: r.audit_status == null ? null : String(r.audit_status),
      engine_version: r.engine_version == null ? null : String(r.engine_version),
      model: r.model == null ? null : String(r.model),
    };
  });
}
