/**
 * lib/lab-v2/sources/ipd-discharge.ts — freeze ONE discharge document as a case
 * (LAB-MCP-V2-PRD-v1.0 §17.9 round D2b, decisions 118, 102, 99 and 87).
 *
 * ⚠️ THE IDENTIFIER IS USED AND NEVER STORED, as in D1. The caller sends a `documentId`, this
 * function READS with it, and what comes back carries a salted `member_key` and no id column at
 * all. There is no retention policy because nothing is retained.
 *
 * ⚠️⚠️ AND IT NEVER READS A PDF. DECISION 102, AND IT IS THE LOAD-BEARING SENTENCE OF THIS FILE.
 * `runIpdAudit` starts by fetching the discharge PDF over HTTP and handing it to
 * `generateFromDocument` (`lib/gemini-multimodal.ts:132`), which now throws `LAB_IO_FORBIDDEN`
 * inside a lab context. This freeze does not route around that: it requires a STORED extract at
 * the current `DOC_EXTRACT_VERSION` and refuses the document otherwise. A document whose extract
 * is missing is a document this platform declines to study, not a document it re-reads — because
 * re-reading it means pulling a named person's discharge summary through a multimodal model on a
 * research key, which is the exact thing decision 102 exists to stop.
 *
 * ⚠️ THE FREEZE RUNS OUTSIDE THE FENCE, deliberately, as D1's does. The extract store reads
 * `discharge_extracted_cases` through `sql` and the two envelopes read db13 through
 * `metabaseQuery`; both throw inside a lab execution context by design (§7). `dataset_create` runs
 * outside any context and `exitLabExecution` makes that a property of THIS function rather than an
 * assumption about its caller.
 *
 * ⚠️ WHAT IS DROPPED, AND WHY IT IS DROPPED RATHER THAN SCRUBBED. `IpdAdmissionHeader`
 * (`lib/ipd-audit/db13.ts:46-59`) carries `patientName`, `uhid` and `ageGender` — its own comment
 * calls two of them "PHI — render-only, never persisted". `BillingEnvelope` carries `ipUid`. The
 * run-level input carries `documentId`, `ipUid`, `memberId` and `pdfUrl`. NONE of them is copied
 * forward: this file names the four header scalars `run.ts:191-203` actually passes into
 * `buildIpdAuditRow` and the ten billing scalars, and constructs a body out of those. A frozen case
 * cannot leak a field it was never built from.
 */
import { createHash } from 'crypto';
import { exitLabExecution } from '../../lab-execution-context';
import { LabError } from '../contracts';
import { identifyingKeys } from './requests';
import { memberKeyOf, memberSalt } from './opd';
import { stripVerbatimSections } from './ipd';
import { sql } from '../../db';
import {
  DOC_EXTRACT_VERSION, readExtractedCaseAcrossVersions, type StoredExtractedCase,
} from '../../discharge-extract-store';
import { fetchIpdAdmissionHeader } from '../../ipd-audit/db13';
import { fetchBillingEnvelope, fetchBilledTotal } from '../../ipd-audit/billing';
import { IPD_ENGINE_VERSION } from '../../ipd-audit/store';
import type { ExtractedCase } from '../../doc-audit-core';

/**
 * ⚠️ THE VERSION PROBE. INFERRED (decision 87) — no live database was available to the builder —
 * and it exists for one sentence in decision 118: a refusal must NAME THE VERSION FOUND.
 *
 * `readExtractedCaseAcrossVersions` (`discharge-extract-store.ts:173`) is the read that matters,
 * and it is the store's own — this file does not restate it. But its `absent` outcome deliberately
 * carries no detail, and "no row at `doc-extract/2`" is a different fact from "no row at all": the
 * store's own comment records that 560 of 843 documents held only `doc-extract/1` on 29 Aug 2026
 * (`:158-163`), so the commonest refusal this platform will issue is "this document was extracted,
 * under an older version". An operator who is told only "unavailable" cannot tell those apart, and
 * the fix for one (run the re-extract backfill) is not the fix for the other.
 *
 * Bounded: one document, one column, and a `LIMIT` well above the two versions that exist.
 */
export const EXTRACT_VERSIONS_SQL = `SELECT extraction_version,
       to_char(extracted_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS extracted_at
  FROM discharge_extracted_cases
 WHERE document_id = $1
 ORDER BY extraction_version DESC
 LIMIT 20`;

/**
 * ⚠️ THE GOLDEN COMPARISON'S B SIDE. INFERRED (decision 87), and modelled on `store.ts:216`
 * (`fetchIpdAuditByDocument`), which is production's own selection for exactly this row.
 *
 * ⚠️ AND IT SELECTS SIX COLUMNS, NOT `*`. `ipd_discharge_audits` carries `ip_uid`, `member_id` and
 * the whole `report` jsonb; `SELECT *` would pull two identifiers and a de-identified but very
 * large body into this process to read two numbers. Only `engine_version` and `model` reach the
 * frozen case; `care_value_index`, `band` and `trace_id` are read for the round's golden table and
 * are returned to the caller, never stored (decision 118).
 */
export const IPD_AUDIT_ROW_SQL = `SELECT engine_version, care_value_index, band, model, provider, trace_id
  FROM ipd_discharge_audits
 WHERE document_id = $1 AND engine_version = $2
 LIMIT 1`;

/** The four `IpdAdmissionHeader` scalars `run.ts:191-203` passes into `buildIpdAuditRow`. */
export const ENVELOPE_FIELDS = ['speciality', 'dischargeType', 'losDays', 'dischargeDate'] as const;

/** Every `BillingEnvelope` scalar except `ipUid`, plus the ₹ total the row itself carries. */
export const BILLING_FIELDS = [
  'netTotal', 'saleTotal', 'refundTotal', 'lineCount', 'billCount',
  'categories', 'wardClasses', 'pharmacyItems', 'pharmacyClasses',
] as const;

/**
 * ⚠️ DECISION 118'S NEVER-STORED LIST, DECLARED SO A TEST CAN WALK IT BY NAME.
 * `documentId`, `ipUid`, `memberId` and `pdfUrl` are the run-level identifiers; `patientName`,
 * `uhid` and `ageGender` are db13's three PHI header fields; `trace_id` names one production audit
 * of one person and is read for the golden table and dropped.
 */
export const NEVER_STORED_KEYS = [
  'documentId', 'document_id', 'ipUid', 'ip_uid', 'memberId', 'member_id',
  'pdfUrl', 'pdf_url', 'patientName', 'uhid', 'ageGender', 'traceId', 'trace_id',
] as const;

export interface FrozenIpdDischargeEnvelope {
  speciality: string | null;
  dischargeType: string | null;
  losDays: number | null;
  dischargeDate: string | null;
}

export interface FrozenIpdDischargeBilling {
  netTotal: number | null;
  saleTotal: number | null;
  refundTotal: number | null;
  lineCount: number | null;
  billCount: number | null;
  categories: unknown[];
  wardClasses: unknown[];
  pharmacyItems: string[];
  pharmacyClasses: string[];
  /** `fetchBilledTotal`'s ₹ scalar — the one `buildIpdAuditRow` stores (`assemble.ts:72`). */
  billedTotal: number | null;
}

export interface FrozenIpdDischarge {
  engine: 'ipd_discharge';
  /** `ExtractedCase` with `verbatimSections` stripped (decision 50). */
  extracted: unknown;
  /** Which keys the strip removed, so the removal is visible rather than assumed. */
  stripped: string[];
  extraction_version: string;
  envelope: FrozenIpdDischargeEnvelope;
  billing: FrozenIpdDischargeBilling;
}

export interface FrozenIpdDischargeCase {
  case_key: string;
  member_key: string | null;
  frozen: FrozenIpdDischarge;
  source_versions: Record<string, unknown>;
  /**
   * The stored audit's headline, for the round's golden table. A SIBLING of `frozen`, returned to
   * the caller and never written into the case body — decision 118 keeps `trace_id` out of
   * `lab_v2` entirely and the two numbers are the comparison, not an input to the replay.
   */
  stored_audit: {
    engine_version: string | null; care_value_index: number | null;
    band: string | null; model: string | null; provider: string | null;
  } | null;
}

export interface IpdDischargeSourceDeps {
  run?: (statement: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
  readExtract?: typeof readExtractedCaseAcrossVersions;
  fetchHeader?: typeof fetchIpdAdmissionHeader;
  fetchBilling?: typeof fetchBillingEnvelope;
  fetchTotal?: typeof fetchBilledTotal;
  salt?: string;
  engineVersion?: string;
}

const liveRun = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Decision 99's gate, on what is about to be stored. A hit is a REFUSAL, never a scrub. */
export function refuseIdentifying(body: unknown, what: string): void {
  const hits = identifyingKeys(body);
  if (hits.length) {
    throw new LabError('CLASSIFICATION_REQUIRED',
      `${what} carries identifying key(s) ${hits.join(', ')} after de-identification. `
      + 'Decision 99: nothing identifying is written to lab_v2, so this case is refused rather than scrubbed — '
      + 'a scrub would hide a change in the upstream engine.');
  }
}

const num = (v: unknown): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * ⚠️ FAIL-SAFE, AND IT IS THE OPPOSITE OF THE STORE'S OWN POSTURE.
 *
 * `fetchExtractedCase` collapses "absent" and "the database faulted" into `null` because its
 * original caller's answer to both is "extract it myself" (`discharge-extract-store.ts:139-141`).
 * This platform CANNOT extract anything — decision 102 forbids it — so the two must stay apart:
 * an absence is a fact about the document and a fault is a fact about the deployment, and freezing
 * a case with a default in place of either would put an invented input into a research object.
 * Every path below therefore ends in `SOURCE_UNAVAILABLE` with the cause, and none ends in a case.
 */
async function readExtract(
  documentId: string,
  read: typeof readExtractedCaseAcrossVersions,
  run: (statement: string, params: unknown[]) => Promise<Record<string, unknown>[]>,
): Promise<StoredExtractedCase> {
  const outcome = await read(documentId, [DOC_EXTRACT_VERSION]);
  if (outcome.outcome === 'found') return outcome.stored;
  if (outcome.outcome === 'fetch_failed') {
    throw new LabError('SOURCE_UNAVAILABLE',
      `the discharge_extracted_cases read faulted, so this document's extract is unreachable rather than absent: ${outcome.error}`);
  }
  // Absent AT THIS VERSION. Say which versions the document does hold — see EXTRACT_VERSIONS_SQL.
  let found: string[] = [];
  try {
    const rows = await run(EXTRACT_VERSIONS_SQL, [documentId]);
    found = rows.map((r) => String(r.extraction_version ?? '')).filter(Boolean);
  } catch {
    // The probe is a courtesy, not the answer. A fault here still refuses, and says less.
    found = [];
  }
  throw new LabError('SOURCE_UNAVAILABLE',
    `no stored extract at ${DOC_EXTRACT_VERSION} for that document `
    + `(found: ${found.length ? found.join(', ') : 'no extract at any version'}). `
    + 'Decision 102: the lab never re-reads the discharge PDF, so a document must already have been '
    + 'extracted at the current version before it can be studied.');
}

export async function freezeIpdDischargeDocument(
  documentId: string, deps: IpdDischargeSourceDeps = {},
): Promise<FrozenIpdDischargeCase> {
  const key = String(documentId ?? '').trim();
  if (!key) throw new LabError('INVALID_INPUT', 'an ipd_discharge case is one document, named by its documentId');
  const run = deps.run ?? liveRun;
  const read = deps.readExtract ?? readExtractedCaseAcrossVersions;
  const header = deps.fetchHeader ?? fetchIpdAdmissionHeader;
  const billing = deps.fetchBilling ?? fetchBillingEnvelope;
  const total = deps.fetchTotal ?? fetchBilledTotal;
  const engineVersion = deps.engineVersion ?? IPD_ENGINE_VERSION;

  // ⚠️ OUTSIDE THE FENCE. See the header: every read below throws inside a lab context by design.
  return exitLabExecution(async () => {
    const stored = await readExtract(key, read, run);
    const ipUid = stored.ipUid ?? null;

    /**
     * ⚠️ THE TWO db13 JOINS DEGRADE, THE EXTRACT READ DOES NOT, and the asymmetry is production's
     * own. `run.ts:179-184` wraps both in `.catch(() => null)` and its comment says why: ~8% of
     * audited documents have no linked bill at all, so a null envelope is a normal value here. The
     * audit runs without them — `buildIpdAuditRow` falls back to the extract's own
     * `lengthOfStayDays` (`assemble.ts:70`) — so refusing the case would refuse documents
     * production audits every day. The extract is different: it IS the engine's input.
     */
    const [head, bill, billed] = ipUid
      ? await Promise.all([
        header(ipUid).catch(() => null),
        billing(ipUid).catch(() => null),
        total(ipUid).catch(() => null),
      ])
      : [null, null, null];

    /**
     * ⚠️ THE GOLDEN COMPARISON'S B SIDE, AND A MISSING ROW IS NOT A REFUSAL. A document may be
     * eligible (it has a current extract) and never yet audited at this engine version, which is
     * precisely the cohort a lab run is most interesting on. `null` says so.
     */
    let storedAudit: FrozenIpdDischargeCase['stored_audit'] = null;
    try {
      const rows = await run(IPD_AUDIT_ROW_SQL, [key, engineVersion]);
      const r = rows[0];
      if (r) {
        storedAudit = {
          engine_version: r.engine_version == null ? null : String(r.engine_version),
          care_value_index: num(r.care_value_index),
          band: r.band == null ? null : String(r.band),
          model: r.model == null ? null : String(r.model),
          provider: r.provider == null ? null : String(r.provider),
        };
      }
    } catch {
      // The golden side is evidence about the ROUND, not an input to the replay. A fault here
      // leaves it null and the case is still frozen — the opposite of the extract's posture, and
      // for the opposite reason: nothing in a run reads this.
      storedAudit = null;
    }

    // ⚠️ DECISION 50 — `verbatimSections` is raw discharge prose and is REMOVED, and the removal
    // is recorded. `sources/ipd.ts:227-240` is the same function, imported rather than restated.
    const { value: extracted, stripped } = stripVerbatimSections(stored.extracted as unknown as ExtractedCase);

    const frozen: FrozenIpdDischarge = {
      engine: 'ipd_discharge',
      extracted,
      stripped,
      extraction_version: stored.extractionVersion,
      // ⚠️ FOUR SCALARS, NAMED ONE BY ONE. Spreading the header would carry `patientName`, `uhid`,
      // `ageGender` and `ipUid` straight into the body; these are the four `run.ts:195-198` passes.
      envelope: {
        speciality: head?.speciality ?? null,
        dischargeType: head?.dischargeType ?? null,
        losDays: head?.losDays ?? null,
        dischargeDate: head?.dischargeDate ?? null,
      },
      // Ten scalars, named one by one for the same reason: `BillingEnvelope` carries `ipUid`.
      billing: {
        netTotal: bill ? bill.netTotal : null,
        saleTotal: bill ? bill.saleTotal : null,
        refundTotal: bill ? bill.refundTotal : null,
        lineCount: bill ? bill.lineCount : null,
        billCount: bill ? bill.billCount : null,
        categories: bill ? bill.categories : [],
        wardClasses: bill ? bill.wardClasses : [],
        pharmacyItems: bill ? bill.pharmacyItems : [],
        pharmacyClasses: bill ? bill.pharmacyClasses : [],
        billedTotal: billed ?? null,
      },
    };
    refuseIdentifying(frozen, 'the frozen ipd_discharge case');

    const salt = deps.salt ?? memberSalt();
    return {
      /**
       * ⚠️ A HASH OF THE documentId, NEVER THE documentId. A case key is stored on the dataset, on
       * every item and in every report; `documentId` resolves to a person (`requests.ts:218`).
       * Hashing keeps two runs of the same document comparable — which is all a case key is for.
       */
      case_key: `ipddoc:${createHash('sha256').update(`${salt}|${key}`).digest('hex').slice(0, 32)}`,
      member_key: stored.memberId ? memberKeyOf(String(stored.memberId), salt) : null,
      frozen,
      source_versions: {
        origin: 'discharge_extracted_cases + db13',
        extraction_version: stored.extractionVersion,
        engine_version: engineVersion,
        // Whether the golden side exists, WITHOUT the document it belongs to.
        stored_audit: storedAudit ? storedAudit.engine_version : null,
        stored_audit_model: storedAudit ? storedAudit.model : null,
        billing_present: bill != null,
        envelope_present: head != null,
        stripped,
        frozen_at: new Date().toISOString(),
      },
      stored_audit: storedAudit,
    };
  });
}
