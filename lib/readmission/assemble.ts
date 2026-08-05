/**
 * lib/readmission/assemble.ts — the SINGLE de-identification choke point (PRD §8b,
 * decision 15) + model-input assembly for the readmission agent.
 *
 * HARD REQUIREMENT: PHI flows to Vertex under the BAA + Tokyo residency, but the
 * model sees only DE-IDENTIFIED content. Patient name and UHID are stripped HERE,
 * before anything reaches a prompt builder. The UHID/encounter id stays on the
 * finding ROW (Phase-2 surface join-back) but is never in the evidence catalog.
 * Doctor names are staff data and may be retained.
 *
 * Everything in this file is pure string/structure work (no DB, no model) so the
 * PHI scrub is inspectable; run.ts wires the fetches around it.
 */

import type { EvidenceCatalog, EvidenceItem, LabTimingProfile } from '../readmission-reconcile-core';
import { labTimingProfile } from '../readmission-reconcile-core';
import type { SummaryRecord, LabRow } from './db13';

// ── de-identification ───────────────────────────────────────────────────────────

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Scrub every known identity token (patient full name, its parts ≥3 chars, UHIDs)
 * from a text. Case-insensitive. Never touches doctor names (staff data, §8b).
 */
export function deidText(text: string, identity: { names?: Array<string | null | undefined>; uhids?: Array<string | null | undefined> }): string {
  let out = text;
  const nameTokens = new Set<string>();
  for (const n of identity.names ?? []) {
    if (!n) continue;
    const full = n.trim();
    if (full.length >= 3) nameTokens.add(full);
    for (const part of full.split(/\s+/)) if (part.length >= 3) nameTokens.add(part);
  }
  // Longest first so the full name is replaced before its parts fragment it.
  for (const t of Array.from(nameTokens).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRe(t), 'gi'), '[PATIENT]');
  }
  for (const u of identity.uhids ?? []) {
    if (u && u.trim().length >= 3) out = out.replace(new RegExp(escapeRe(u.trim()), 'gi'), '[UHID]');
  }
  return out;
}

// ── summary-text assembly (tolerant of the unvalidated column shape) ────────────

/** Keys that must NEVER contribute text to a prompt — identity/contact fields. */
const PHI_KEY_RE = /(patient_name|^name$|uhid|mobile|phone|contact|address|email|dob|date_of_birth|birth|aadhaar|aadhar|pan_|passport|mrn|guardian|relative|kin)/i;

/** Preferred clinical-content columns, tried FIRST (all INFERRED — see build report). */
const SUMMARY_TEXT_CANDIDATES = [
  'discharge_summary', 'summary', 'clinical_summary', 'summary_text', 'discharge_summary_text',
  'course_in_hospital', 'hospital_course', 'diagnosis', 'final_diagnosis', 'chief_complaints',
  'history_of_present_illness', 'investigations', 'treatment_given', 'condition_at_discharge',
  'discharge_advice', 'discharge_medications', 'follow_up_advice', 'procedure_details',
];

const stripHtml = (t: string) => t.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Build the de-identified summary text from a SELECT * row. Preferred columns are
 * concatenated when present; otherwise any long text field whose KEY is not
 * identity-shaped contributes (labelled), so a wrongly-guessed column name costs
 * nothing. Returns null when no clinical text is found → the pair is NOT AUDITED.
 */
export function buildSummaryText(rec: SummaryRecord, identity: { names: Array<string | null | undefined>; uhids: Array<string | null | undefined> }): string | null {
  const parts: string[] = [];
  const used = new Set<string>();
  for (const key of SUMMARY_TEXT_CANDIDATES) {
    const v = rec.raw[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      parts.push(`${key.replace(/_/g, ' ')}: ${stripHtml(v)}`);
      used.add(key);
    }
  }
  if (!parts.length) {
    for (const [key, v] of Object.entries(rec.raw)) {
      if (used.has(key) || PHI_KEY_RE.test(key)) continue;
      if (typeof v === 'string' && stripHtml(v).length >= 80) {
        parts.push(`${key.replace(/_/g, ' ')}: ${stripHtml(v)}`);
      }
    }
  }
  if (!parts.length) return null;
  return deidText(parts.join('\n'), identity);
}

/** Split a de-identified summary into citable sentences (caps keep prompts bounded). */
export function splitSentences(text: string, maxSentences = 120, maxLen = 400): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9(])/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 8)
    .slice(0, maxSentences)
    .map((x) => (x.length > maxLen ? `${x.slice(0, maxLen)}…` : x));
}

// ── evidence-catalog assembly ───────────────────────────────────────────────────

export interface AssembledInputs {
  catalog: EvidenceCatalog;
  labProfile: LabTimingProfile;
  indexSentenceCount: number;
  readmitSentenceCount: number;
}

const H = 3_600_000;
const parseTs = (x: string | null | undefined): number | null => {
  if (!x) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(x) ? x.replace(' ', 'T') : x);
  return Number.isFinite(t) ? t : null;
};

function labItems(labs: LabRow[], side: 'index' | 'readmit', prefix: string, filter: (t: number | null) => boolean): EvidenceItem[] {
  return labs
    .filter((l) => filter(parseTs(l.at)))
    .slice(0, 80)
    .map((l, i) => ({
      id: `${prefix}${i + 1}`,
      source: 'lab' as const,
      side,
      at: l.at,
      analyte: l.analyte,
      abnormal: l.abnormal,
      text: `${l.testName}: ${l.valueText ?? l.value ?? '?'}${l.unit ? ` ${l.unit}` : ''}${l.refRange ? ` (ref ${l.refRange})` : ''}${l.at ? ` @ ${l.at}` : ''}`,
    }));
}

/**
 * Assemble the de-identified evidence catalog for one pair (or one out-of-network
 * index side, where readmit inputs are absent). Inputs per PRD §5: index trailing
 * labs = final 48h before discharge, readmit early labs = first 24h after admit;
 * labs outside those windows still inform the timing profile and bundle signal, so
 * they are kept, timing-marked, rather than silently dropped.
 */
export function assembleInputs(args: {
  indexSummaryText: string;
  readmitSummaryText?: string | null;
  indexLabs: LabRow[];
  readmitLabs?: LabRow[];
  indexAdmitAt: string | null;
  indexDischargeAt: string | null;
  readmitAdmitAt?: string | null;
  cmNote?: string | null;
  structuredFacts?: string[];
  identity: { names: Array<string | null | undefined>; uhids: Array<string | null | undefined> };
}): AssembledInputs {
  const items: EvidenceItem[] = [];

  const idxSentences = splitSentences(args.indexSummaryText);
  idxSentences.forEach((t, i) => items.push({ id: `S${i + 1}`, source: 'index_summary', side: 'index', text: t }));

  const rdSentences = args.readmitSummaryText ? splitSentences(args.readmitSummaryText) : [];
  rdSentences.forEach((t, i) => items.push({ id: `R${i + 1}`, source: 'readmit_summary', side: 'readmit', text: t }));

  const disch = parseTs(args.indexDischargeAt);
  const rdAdmit = parseTs(args.readmitAdmitAt);
  // Index labs: prefer the trailing 48h; keep the rest (timing profile needs them all).
  items.push(...labItems(args.indexLabs, 'index', 'L',
    (t) => disch == null || t == null || (t <= disch && t >= disch - 48 * H)));
  const trailingIds = new Set(items.filter((i) => i.source === 'lab' && i.side === 'index').map((i) => i.id));
  if (trailingIds.size < Math.min(args.indexLabs.length, 80)) {
    items.push(...labItems(args.indexLabs, 'index', 'LX',
      (t) => !(disch == null || t == null || (t <= disch && t >= disch - 48 * H))));
  }
  if (args.readmitLabs?.length) {
    items.push(...labItems(args.readmitLabs, 'readmit', 'M',
      (t) => rdAdmit == null || t == null || (t >= rdAdmit && t <= rdAdmit + 24 * H)));
  }

  (args.structuredFacts ?? []).forEach((t, i) => items.push({ id: `T${i + 1}`, source: 'adt', text: t }));

  if (args.cmNote && args.cmNote.trim()) {
    items.push({ id: 'F1', source: 'cm_form', text: deidText(args.cmNote.trim().slice(0, 1200), args.identity) });
  }

  const labProfile = labTimingProfile(args.indexLabs, args.indexAdmitAt, args.indexDischargeAt);
  return { catalog: { items }, labProfile, indexSentenceCount: idxSentences.length, readmitSentenceCount: rdSentences.length };
}
