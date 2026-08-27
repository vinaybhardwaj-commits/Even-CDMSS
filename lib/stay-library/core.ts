/**
 * lib/stay-library/core.ts — the PURE half of the per-stay ClinicalState library
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P2 / §4, O9 / O10).
 *
 * WHAT THIS IS. The IPD audit reads one document: the discharge-summary PDF. Meanwhile the OT note,
 * the pre-anaesthetic check and the ward progress notes already sit on db13, already fetched by the
 * readmission agent as its source 4. P2 turns each of those documents into ONE ClinicalState with
 * source spans, so P3 can audit a STAY rather than a summary and P4 has something with provenance to
 * promote from.
 *
 * THE RULE THAT MATTERS MOST, and the reason half this file is about absence: **silence is unknown**
 * (D13). A stay with no OT row is a stay whose theatre record we have not seen — it is NOT a stay
 * with no operation. The distinction is carried all the way into storage: every document class that
 * yields nothing still writes a row, with `status: 'not_auditable'` and a REASON that separates
 * "we looked and the row is not there" (`absent`) from "the look itself faulted" (`unavailable`)
 * from "the row exists and its text is empty" (`empty`). `lib/readmission/db13.ts` already draws
 * that line for its coverage chips — a faulted hop is `unknown`, never `absent` — and this library
 * would be lying if it collapsed them.
 *
 * WHAT THIS FILE WILL NOT DO:
 *   · never invent a procedure from a missing OT note (D13, §4);
 *   · never emit `administered` on a medication — there is no MAR in the substrate, so a discharge
 *     list is `prescribed` and nothing else, enforced by `assertNoAdministered` and a test (§8 #7);
 *   · never fork lib/clinical-state/schema.ts. The stay-specific facts ride in `surfaceExtras`,
 *     which is exactly the passthrough the core defines for fields it deliberately doesn't model.
 *     `CLINICAL_STATE_VERSION` stays 'clinical-state/1.2' (§7).
 *
 * PURE: no DB, no model, no clock, no I/O. The de-identifier is a REQUIRED ARGUMENT rather than an
 * optional step, so no caller can build a state out of raw template text by forgetting to scrub it.
 */
import {
  emptyClinicalState, mkFindingId, CLINICAL_STATE_VERSION,
  type ClinicalState, type ClinicalFinding, type MedicationAssertion, type Provenance,
} from '../clinical-state/schema';
import { extractedCaseToState } from '../clinical-state/to-audit-family';
import type { ExtractedCase } from '../doc-audit-core';

/** The library's own version. Not an engine version and not a schema version: it names the
 *  BUILDER, so a later change to how a document becomes a state is visible without touching
 *  `clinical-state/1.2`, which this ship leaves exactly where it is. */
export const STAY_LIBRARY_VERSION = 'stay-library/1';

/** O10 — the four document classes in scope, and the whole of it. CM / POST_IPD notes are OUT this
 *  ship; MAR / nursing / handover are out of the promote path entirely. */
export const DOC_KINDS = ['discharge', 'ot', 'pac', 'progress'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** O9's two-valued status column. The nuance lives in `reason`, below, because O9 fixes this enum. */
export type StayDocStatus = 'ok' | 'not_auditable';

/**
 * WHY a document class is not auditable. Stored inside `state_json`, not in the status column,
 * because O9 fixes `status` to two values — and because the difference is the whole point:
 *   absent      — the look ran and the row is not there. The document was not filed.
 *   unavailable — the look itself FAULTED. We know nothing; this must never read as `absent`.
 *   empty       — the row exists and carries no usable text (151/811 progress notes on the
 *                 17 Aug measure). The document was filed blank.
 *   no_document — for the discharge class only: no stored extract for this stay's document.
 */
export type NotAuditableReason = 'absent' | 'unavailable' | 'empty' | 'no_document';

export const NOT_AUDITABLE_COPY: Readonly<Record<NotAuditableReason, string>> = Object.freeze({
  absent: 'looked for this document and it is not filed for this stay',
  unavailable: 'the look for this document failed — this is not evidence the document is missing',
  empty: 'the document is filed but carries no usable text',
  no_document: 'no stored extract exists for this stay’s discharge summary',
});

/** Plain-words label per class — used in the honest "looked for and not found" line. */
export const DOC_KIND_LABEL: Readonly<Record<DocKind, string>> = Object.freeze({
  discharge: 'discharge summary',
  ot: 'operative note',
  pac: 'pre-anaesthetic check',
  progress: 'progress note',
});

/** Where each class is read from, named so the stored row says it rather than a build report. */
export const DOC_KIND_SOURCE: Readonly<Record<DocKind, string>> = Object.freeze({
  discharge: 'discharge_extracted_cases.extracted_json',
  ot: 'kx_clinical_template_ot_notes',
  pac: 'kx_clinical_template_pac_reports',
  progress: 'kx_clinical_template_progress_reports',
});

// ── what rides in surfaceExtras ──────────────────────────────────────────────────────────

/** The library's own header on every state. Read by P3 to know what it is holding, and by the
 *  admin surface to render an honest coverage line. */
export interface StayDocMeta {
  libraryVersion: typeof STAY_LIBRARY_VERSION;
  docKind: DocKind;
  /** The document's own id — a template row `uid`, or the discharge document id. For an absent
   *  class it is the sentinel from `absentSourceUid` (see there for why a row still exists). */
  sourceUid: string;
  encounterRef: string | null;
  status: StayDocStatus;
  reason?: NotAuditableReason;
  /** What was looked for and where, in plain words. Present on ok rows too. */
  lookedFor: string;
  /** The document's own timestamp, as the source carried it. */
  at: string | null;
  templateName?: string | null;
}

/**
 * A procedure the stay actually evidences, with the provenance P4's trust gate needs (§6.2/§6.3).
 * This is the ONLY shape P4 may read a procedure from — the core's `procedures: string[]` carries
 * no provenance and must never be promoted on its own.
 */
export interface StayProcedureFact {
  conceptRaw: string;
  /** ONLY from the OT row's own `right-left` fact. Never guessed from a surgery title (§6.2). */
  laterality: string | null;
  setting: 'ot' | 'ward' | 'unknown';
  provenance: Provenance;
  /**
   * Did `provenance.rawText` verify as a verbatim substring of the named source field?
   * `true` for a structured column (it IS the field). For an LLM-extracted discharge procedure this
   * is a REAL check against the extract's own de-identified narrative, and it is often false —
   * the extractor keeps no span into the PDF. P4's gate must read this and refuse on false;
   * recording it as anything other than measured would make that gate vacuous.
   */
  spanVerified: boolean;
}

export interface StaySurfaceExtras extends Record<string, unknown> {
  stayDoc: StayDocMeta;
  procedureFacts?: StayProcedureFact[];
  /** The allowlisted OT facts, verbatim, for P3's reader. */
  otFacts?: Array<{ name: string; label: string; value: string }>;
}

// ── ids ──────────────────────────────────────────────────────────────────────────────────

/**
 * The sentinel `source_uid` for a document class that produced no row.
 *
 * A missing OT note has no uid to key on, and O9's unique key is (doc_kind, source_uid,
 * schema_version) — so a row recording the absence needs an id. Deriving it from the stay makes the
 * absence itself idempotent: re-running the build for the same stay overwrites the same row instead
 * of appending a second "still missing". Never collides with a real KX uid because of the prefix.
 */
export function absentSourceUid(docKind: DocKind, encounterRef: string | null): string {
  return `absent:${docKind}:${encounterRef && encounterRef.trim() ? encounterRef.trim() : 'unknown-stay'}`;
}

/** True when a source_uid is one of the sentinels above — i.e. this row records an absence. */
export function isAbsentSourceUid(uid: string | null | undefined): boolean {
  return typeof uid === 'string' && uid.startsWith('absent:');
}

// ── the de-identifier is an argument, not a step ─────────────────────────────────────────

/** Every string that becomes stored state passes through one of these. Production hands the same
 *  choke point the readmission catalog uses (`deidText` bound to this stay's identity). */
export type Deidentifier = (text: string) => string;

/** Trim, scrub, collapse whitespace, cap. `null` for anything that ends up empty. */
function clean(deid: Deidentifier, raw: unknown, cap: number): string | null {
  const t = raw == null ? '' : String(raw);
  if (!t.trim()) return null;
  const out = deid(t).replace(/\s+/g, ' ').trim();
  return out ? out.slice(0, cap) : null;
}

// ── not_auditable ────────────────────────────────────────────────────────────────────────

/**
 * The honest empty state for a document class that yielded nothing. It is a REAL stored row, not a
 * gap in the table, because "we looked and it is not there" is a finding and a gap is not — a reader
 * of this library must be able to tell a stay nobody built from a stay whose OT note does not exist.
 *
 * It carries no positives, no procedures and no medications. That is the entire point: there is
 * nothing here to read, and a downstream that reads it as "clean" is reading it wrong, which is why
 * `missingCriticalData` names the class outright.
 */
export function notAuditableState(a: {
  docKind: DocKind;
  reason: NotAuditableReason;
  encounterRef: string | null;
  sourceUid?: string;
}): ClinicalState {
  const state = emptyClinicalState('doc_audit');
  const lookedFor = `${DOC_KIND_LABEL[a.docKind]} in ${DOC_KIND_SOURCE[a.docKind]}`;
  state.missingCriticalData = [`${DOC_KIND_LABEL[a.docKind]}: ${NOT_AUDITABLE_COPY[a.reason]}`];
  const meta: StayDocMeta = {
    libraryVersion: STAY_LIBRARY_VERSION,
    docKind: a.docKind,
    sourceUid: a.sourceUid ?? absentSourceUid(a.docKind, a.encounterRef),
    encounterRef: a.encounterRef,
    status: 'not_auditable',
    reason: a.reason,
    lookedFor,
    at: null,
  };
  state.surfaceExtras = { stayDoc: meta } satisfies StaySurfaceExtras;
  return state;
}

// ── discharge ────────────────────────────────────────────────────────────────────────────

/**
 * The discharge summary, from the STORED de-identified `ExtractedCase` the IPD audit already wrote
 * (`discharge_extracted_cases`, doc-extract/1) — mapped by the existing `extractedCaseToState`
 * adapter, exactly as §4 requires ("`surface: 'doc_audit'` via the existing to-audit-family.ts
 * path"). Reading the stored extract rather than re-running the PDF costs no model call and cannot
 * disagree with the audit that produced it.
 *
 * Two things are added on top of the adapter's output, both typed and both for P4:
 *   · `procedureFacts` — `ExtractedCase.procedure` with its provenance AND a real span check
 *     against the extract's own de-identified narrative. Precedence rank 2 (§6.2), so its setting is
 *     `'unknown'`: a procedure named in a discharge summary is not evidence it happened in theatre.
 *   · `medicationAssertions` — the discharge list as `prescribed`. NEVER `administered`: there is no
 *     MAR row anywhere in this substrate, and §6.2's guard is that `administered` requires one.
 */
export function dischargeState(a: {
  extracted: ExtractedCase;
  documentId: string;
  encounterRef: string | null;
  deid: Deidentifier;
  at?: string | null;
}): ClinicalState {
  const state = extractedCaseToState(a.extracted);
  const adapterExtras = state.surfaceExtras ?? {};

  // The extract is already de-identified by construction (doc-audit strips identity before it
  // stores anything). Scrubbing again costs nothing and means the guarantee does not rest on that.
  state.medications = state.medications.map((m) => clean(a.deid, m, 300)).filter((m): m is string => !!m);
  state.procedures = (state.procedures ?? []).map((p) => clean(a.deid, p, 300)).filter((p): p is string => !!p);

  const procedureFacts: StayProcedureFact[] = [];
  const procedure = state.procedures[0] ?? null;
  if (procedure) {
    // The "named source field" for the span check is the extract's own narrative — the only source
    // text that survives extraction. A span into the PDF does not exist to check against, and
    // saying so is the point: P4 reads `spanVerified` and refuses what it cannot verify.
    const haystack = `${a.extracted.rawNotes ?? ''}\n${a.extracted.courseSummary ?? ''}`;
    const span = findSpan(haystack, procedure);
    procedureFacts.push({
      conceptRaw: procedure,
      laterality: null,                 // §6.2 — laterality comes only from an OT row's right-left
      setting: 'unknown',               // a named procedure is not evidence of a theatre episode
      spanVerified: span != null,
      provenance: {
        sourceField: 'discharge_extract.procedure',
        rawText: procedure,
        ...(span ? { startOffset: span.start, endOffset: span.end } : {}),
        extractionMethod: 'llm',
        confidence: typeof a.extracted.confidence === 'number' ? a.extracted.confidence : 0.5,
        reporter: 'clinician',
        trust: 'clinician_documented',
      },
    });
  }

  state.medicationAssertions = state.medications.map((m, i) => prescribedAssertion(m, i, 'discharge_extract.medications'));
  assertNoAdministered(state);

  const meta: StayDocMeta = {
    libraryVersion: STAY_LIBRARY_VERSION,
    docKind: 'discharge',
    sourceUid: a.documentId,
    encounterRef: a.encounterRef,
    status: 'ok',
    lookedFor: `${DOC_KIND_LABEL.discharge} in ${DOC_KIND_SOURCE.discharge}`,
    at: a.at ?? null,
  };
  state.surfaceExtras = { ...adapterExtras, stayDoc: meta, ...(procedureFacts.length ? { procedureFacts } : {}) };
  return state;
}

// ── OT ───────────────────────────────────────────────────────────────────────────────────

/** One allowlisted OT fact as the template carried it. Shaped by the caller from
 *  `allowlistedOtFacts` so this file stays free of the readmission template module. */
export interface OtFactInput { name: string; label: string; value: string }

/**
 * The operative note. DETERMINISTIC FIELDS FIRST (§4): the structured `surgery_name` column is the
 * procedure, at trust `structured_db`, and it is the top of P4's precedence list. Laterality comes
 * from the row's own `right-left` fact and from nowhere else — a title that says "left inguinal
 * hernia" is a title, not a side, and §6.2 forbids reading one as the other.
 *
 * The narrative (`note`) and the allowlisted facts are kept de-identified for P3 to read. No LLM
 * runs here: everything above is a column or an allowlisted key/value.
 */
export function otState(a: {
  sourceUid: string;
  encounterRef: string | null;
  surgeryName: string | null;
  facts: readonly OtFactInput[];
  narrative: string | null;
  templateName: string | null;
  at: string | null;
  deid: Deidentifier;
}): ClinicalState {
  const state = emptyClinicalState('doc_audit');
  const facts = a.facts
    .map((f) => ({ name: f.name, label: f.label, value: clean(a.deid, f.value, 1_000) }))
    .filter((f): f is OtFactInput => !!f.value);

  const surgery = clean(a.deid, a.surgeryName, 300) ?? facts.find((f) => f.name === 'surgery-name')?.value ?? null;
  const laterality = facts.find((f) => f.name === 'right-left')?.value ?? null;
  const procedureFacts: StayProcedureFact[] = [];

  if (surgery) {
    state.procedures = [surgery];
    procedureFacts.push({
      conceptRaw: surgery,
      laterality,
      setting: 'ot',
      spanVerified: true,   // a structured column IS the named source field
      provenance: {
        sourceField: `${DOC_KIND_SOURCE.ot}.surgery_name`,
        rawText: surgery,
        extractionMethod: 'deterministic',
        confidence: 1,
        reporter: 'clinician',
        trust: 'structured_db',
      },
    });
    state.positives.push({
      id: mkFindingId(surgery, `${DOC_KIND_SOURCE.ot}.surgery_name`, 'present'),
      concept: surgery,
      status: 'present',
      ...(laterality ? { value: laterality } : {}),
      provenance: procedureFacts[0].provenance,
    } satisfies ClinicalFinding);
  }

  // Operative findings (`opfinf`) are clinical content, so they become a finding with the fact's own
  // key as the source field — a real span, because the value IS the field.
  const opfinf = facts.find((f) => f.name === 'opfinf')?.value ?? null;
  if (opfinf) {
    state.positives.push({
      id: mkFindingId(opfinf, `${DOC_KIND_SOURCE.ot}.component_json.opfinf`, 'present'),
      concept: opfinf,
      status: 'present',
      provenance: {
        sourceField: `${DOC_KIND_SOURCE.ot}.component_json.opfinf`,
        rawText: opfinf,
        extractionMethod: 'deterministic',
        confidence: 1,
        reporter: 'clinician',
        trust: 'clinician_documented',
      },
    });
  }

  const narrative = clean(a.deid, a.narrative, 2_000);
  // Silence is unknown: an OT row with a surgery name but no narrative is still an OT row. But a row
  // with NEITHER carries nothing, and the caller turns that into `empty` rather than an `ok` blank.
  if (!surgery) state.missingCriticalData.push('operative note carries no structured surgery name');

  const meta: StayDocMeta = {
    libraryVersion: STAY_LIBRARY_VERSION,
    docKind: 'ot',
    sourceUid: a.sourceUid,
    encounterRef: a.encounterRef,
    status: 'ok',
    lookedFor: `${DOC_KIND_LABEL.ot} in ${DOC_KIND_SOURCE.ot}`,
    at: a.at,
    templateName: clean(a.deid, a.templateName, 200),
  };
  state.surfaceExtras = {
    stayDoc: meta,
    ...(procedureFacts.length ? { procedureFacts } : {}),
    ...(facts.length ? { otFacts: facts } : {}),
    ...(narrative ? { narrative } : {}),
  };
  assertNoAdministered(state);
  return state;
}

// ── PAC and progress ─────────────────────────────────────────────────────────────────────

/**
 * A pre-anaesthetic check or a ward progress note. Both are narrative-only in this substrate: the
 * templates PRD measured that PAC and progress contribute `note` and nothing structured, so there is
 * no deterministic field to lead with and nothing is invented in its place. The note is scrubbed,
 * capped and kept as narrative for P3.
 *
 * NO PROCEDURE IS EVER READ FROM EITHER (§6.2 — precedence is OT column, then a named discharge
 * procedure, and billing corroborates only). A PAC listing a planned operation is a plan.
 */
export function narrativeDocState(a: {
  docKind: 'pac' | 'progress';
  sourceUid: string;
  encounterRef: string | null;
  narrative: string | null;
  templateName: string | null;
  at: string | null;
  deid: Deidentifier;
}): ClinicalState {
  const state = emptyClinicalState('doc_audit');
  const narrative = clean(a.deid, a.narrative, a.docKind === 'pac' ? 2_000 : 800);
  const meta: StayDocMeta = {
    libraryVersion: STAY_LIBRARY_VERSION,
    docKind: a.docKind,
    sourceUid: a.sourceUid,
    encounterRef: a.encounterRef,
    status: 'ok',
    lookedFor: `${DOC_KIND_LABEL[a.docKind]} in ${DOC_KIND_SOURCE[a.docKind]}`,
    at: a.at,
    templateName: clean(a.deid, a.templateName, 200),
  };
  state.surfaceExtras = { stayDoc: meta, ...(narrative ? { narrative } : {}) };
  assertNoAdministered(state);
  return state;
}

// ── guards ───────────────────────────────────────────────────────────────────────────────

/** A discharge-list medication, typed. `prescribed` is the only status this library can produce. */
function prescribedAssertion(raw: string, i: number, sourceField: string): MedicationAssertion {
  return {
    id: `ma-${i}-${mkFindingId(raw, sourceField, 'present')}`,
    medicationConcept: { raw },
    status: 'prescribed',
    provenance: {
      sourceField,
      rawText: raw,
      extractionMethod: 'llm',
      confidence: 0.7,
      reporter: 'clinician',
      trust: 'clinician_documented',
    },
  };
}

/**
 * §8 #7 — NO MAR INVENTION, enforced rather than reviewed. There is no medication-administration
 * record anywhere in this substrate, so no document this library reads can evidence that a drug was
 * GIVEN. A prescription is not an administration; a discharge list is a plan. If this ever throws,
 * a builder learned to claim something the substrate cannot support and the build must stop.
 */
export function assertNoAdministered(state: ClinicalState): void {
  const bad = state.medicationAssertions.find((m) => m.status === 'administered');
  if (bad) {
    throw new Error(
      `stay-library: refusing to store an 'administered' medication (${bad.medicationConcept.raw}) — ` +
      'no MAR exists in this substrate, so administration cannot be evidenced',
    );
  }
}

/** Read the library header off a stored state. Null when the state did not come from this library. */
export function stayDocMetaOf(state: ClinicalState | null | undefined): StayDocMeta | null {
  const m = (state?.surfaceExtras as StaySurfaceExtras | undefined)?.stayDoc;
  return m && typeof m === 'object' && typeof m.docKind === 'string' ? m : null;
}

/** Every procedure fact on a state, or []. The ONLY door P4 may read a procedure through. */
export function procedureFactsOf(state: ClinicalState | null | undefined): StayProcedureFact[] {
  const p = (state?.surfaceExtras as StaySurfaceExtras | undefined)?.procedureFacts;
  return Array.isArray(p) ? p : [];
}

/** Whitespace-insensitive verbatim span search. Returns offsets into the ORIGINAL haystack, or null.
 *  Case-insensitive because an extractor routinely re-cases a title it copied. */
function findSpan(haystack: string, needle: string): { start: number; end: number } | null {
  const h = (haystack ?? '').toLowerCase();
  const n = (needle ?? '').trim().toLowerCase();
  if (!n) return null;
  const direct = h.indexOf(n);
  if (direct >= 0) return { start: direct, end: direct + n.length };
  // Collapse runs of whitespace on BOTH sides and retry; report the span in collapsed coordinates
  // only when it is a real match, never a guess.
  const hc = h.replace(/\s+/g, ' ');
  const nc = n.replace(/\s+/g, ' ');
  const collapsed = hc.indexOf(nc);
  return collapsed >= 0 ? { start: collapsed, end: collapsed + nc.length } : null;
}

export { CLINICAL_STATE_VERSION };
