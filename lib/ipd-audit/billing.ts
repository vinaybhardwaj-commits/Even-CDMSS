/**
 * lib/ipd-audit/billing.ts — the S7 billing envelope: db13 `kx_billing_records` → the ₹ envelope,
 * a COARSE (category-level) documented-vs-billed reconciliation, and a peer band.
 *
 * Reuses the ccb-funnel read pattern (metabaseQuery, patient_type='IP'). Billing is a READ-TIME
 * join on the access-controlled admin surface, exactly like the PHI header join — the only thing
 * that ever lands on the audit row is the scalar `billed_total`.
 *
 * PHI POSTURE: kx_billing_records CARRIES PHI (patient_name, uhid, age, gender, address_details,
 * telecom, primary_email_address …). Every query here selects the ENVELOPE ONLY — money, counts,
 * service/ward-class labels, item names. A test asserts no PHI column is ever named in this file.
 *
 * TWO SCHEMA FACTS THE COLUMN NAMES GET WRONG (measured 17-Jul-2026, 127,636 IP lines):
 *   • `billing_category` is NOT a service category — it is the BED/WARD CLASS (Private, Twin
 *     Sharing, ICU, Suite, General, Emergency, CCU). The service category is `service_type`
 *     (Pharmacy, Pathology, Surgery, Room Rent …). The envelope's line categories are
 *     service_type; the ward class is surfaced separately as the context it actually is.
 *   • Refund lines carry a NEGATIVE net_amt (status='Refund', n=8,221, sum -₹27.5L). So
 *     sum(net_amt) over Sale+Refund is already the true net envelope — no sign-flipping — and
 *     sale/refund are reported separately so a refunded bill can never read as a smaller one.
 * `_id` is unique per line (127,636/127,636), so aggregation needs no de-duplication.
 */

import { metabaseQuery } from '../metabase';
import { sql } from '../db';
import { IPD_ENGINE_VERSION } from './store';
import type { AuditReport, AuditFinding, FieldStatus } from '../doc-audit-core';

const esc = (s: string) => s.replace(/'/g, "''");
const isIpUid = (s: string) => /^[A-Za-z0-9/_-]{2,40}$/.test(s);
const num = (v: unknown) => (v == null ? 0 : Number(v));

/**
 * Which `service_type`s are CLINICAL — i.e. things a discharge summary is expected to account
 * for, so a billed-vs-documented gap is a real question. Everything else is facility/admin
 * overhead (a room-rent line is not a documentation failure), and is shown in the ₹ envelope but
 * deliberately EXCLUDED from the reconciliation.
 */
const CLINICAL_CATEGORY: Record<string, Evidence> = {
  Pharmacy: 'medications',
  Pathology: 'investigations',
  Radiology: 'investigations',
  Cardiology: 'investigations',
  Surgery: 'procedures',
  Procedure: 'procedures',
  'Blood Bank': 'treatments',
  Physiotherapy: 'treatments',
};

export const isClinicalCategory = (c: string) => Object.hasOwn(CLINICAL_CATEGORY, c);

export interface BillingCategory {
  category: string;        // service_type — the real service category
  net: number;             // ₹, net of refunds
  lines: number;
  clinical: boolean;       // reconcilable against the summary, vs facility/admin overhead
}

export interface BillingEnvelope {
  ipUid: string;
  netTotal: number;        // ₹ — sum(net_amt), refunds already netted out
  saleTotal: number;
  refundTotal: number;     // ≤ 0
  lineCount: number;
  billCount: number;
  categories: BillingCategory[];        // desc by net
  wardClasses: { label: string; net: number }[];   // billing_category — the bed class
  pharmacyItems: string[];              // distinct service_item_name (drug matching aid; not PHI)
  pharmacyClasses: string[];            // distinct item_category (drug CLASS) — only ~12% populated
}

/**
 * The billed envelope for ONE IP admission, or null when the admission has no billing record
 * (~8% of audited docs — an envelope-LESS doc is a normal state, never an error).
 */
export async function fetchBillingEnvelope(ipUid: string): Promise<BillingEnvelope | null> {
  if (!isIpUid(ipUid)) return null;
  const where = `patient_type='IP' AND visit_id_admission_id='${esc(ipUid)}'`;

  const [totals, cats, wards, items, classes] = await Promise.all([
    metabaseQuery(
      `SELECT sum(net_amt) AS net, count(*)::int AS lines, count(DISTINCT bill_no)::int AS bills,
              sum(CASE WHEN status='Refund' THEN net_amt ELSE 0 END) AS refund,
              sum(CASE WHEN status='Refund' THEN 0 ELSE net_amt END) AS sale
       FROM kx_billing_records WHERE ${where}`),
    metabaseQuery(
      `SELECT service_type AS c, sum(net_amt) AS net, count(*)::int AS lines
       FROM kx_billing_records WHERE ${where} GROUP BY 1 ORDER BY 2 DESC NULLS LAST`),
    metabaseQuery(
      `SELECT billing_category AS c, sum(net_amt) AS net
       FROM kx_billing_records WHERE ${where} GROUP BY 1 ORDER BY 2 DESC NULLS LAST`),
    metabaseQuery(
      `SELECT DISTINCT service_item_name AS n FROM kx_billing_records
       WHERE ${where} AND service_type='Pharmacy' AND service_item_name IS NOT NULL LIMIT 400`),
    metabaseQuery(
      `SELECT DISTINCT item_category AS c FROM kx_billing_records
       WHERE ${where} AND service_type='Pharmacy' AND item_category IS NOT NULL AND item_category <> '' LIMIT 100`),
  ]);

  const t = totals[0];
  if (!t || Number(t.lines ?? 0) === 0) return null;

  return {
    ipUid,
    netTotal: num(t.net),
    saleTotal: num(t.sale),
    refundTotal: num(t.refund),
    lineCount: Number(t.lines ?? 0),
    billCount: Number(t.bills ?? 0),
    categories: cats
      .filter((r) => r.c != null && String(r.c).trim() !== '')
      .map((r) => ({ category: String(r.c), net: num(r.net), lines: Number(r.lines ?? 0), clinical: isClinicalCategory(String(r.c)) })),
    wardClasses: wards
      .filter((r) => r.c != null && String(r.c).trim() !== '')
      .map((r) => ({ label: String(r.c), net: num(r.net) })),
    pharmacyItems: items.map((r) => String(r.n)),
    pharmacyClasses: classes.map((r) => String(r.c)),
  };
}

/** Just the ₹ scalar for the audit row (worker/batch write path) — cheap, no category breakdown. */
export async function fetchBilledTotal(ipUid: string): Promise<number | null> {
  if (!isIpUid(ipUid)) return null;
  const rows = await metabaseQuery(
    `SELECT sum(net_amt) AS net, count(*)::int AS lines FROM kx_billing_records
     WHERE patient_type='IP' AND visit_id_admission_id='${esc(ipUid)}'`);
  const r = rows[0];
  if (!r || Number(r.lines ?? 0) === 0) return null;
  return num(r.net);
}

// ── coarse reconciliation (pure) ─────────────────────────────────────────────────────────────────

/**
 * The reconciliation's DOCUMENTED side comes from the report's own NABH completeness items — not
 * from re-reading the PDF and not from the ExtractedCase (which the row never persists). That is
 * the better source on three counts: it is judged by the one pass that actually SAW the document,
 * it is already on every persisted row (so this works retrospectively over the whole corpus with
 * no re-extract), and it is status-only, so the reconciliation stays PHI-safe by construction.
 */
export type Evidence = 'medications' | 'investigations' | 'procedures' | 'treatments';

/** evidence → the NABH completeness key that records whether the summary documented it. */
const EVIDENCE_FIELD: Record<Evidence, string> = {
  medications: 'medications_administered',
  investigations: 'investigations',
  procedures: 'procedures_performed',
  treatments: 'treatment_given',
};

export type DocumentedEvidence = Partial<Record<Evidence, FieldStatus>>;

/** Read the documented side off the persisted report. Absent field ⇒ undefined ⇒ not asserted. */
export function documentedFrom(report: Pick<AuditReport, 'completeness'> | null | undefined): DocumentedEvidence {
  const items = report?.completeness?.items ?? [];
  const out: DocumentedEvidence = {};
  for (const [ev, key] of Object.entries(EVIDENCE_FIELD) as Array<[Evidence, string]>) {
    const hit = items.find((i) => i.key === key);
    if (hit) out[ev] = hit.status;
  }
  return out;
}

/** 'present'/'partial' count as documented; only an explicit 'missing' is a gap. 'na' excludes. */
const isDocumented = (s: FieldStatus | undefined) => s === 'present' || s === 'partial';
const isGap = (s: FieldStatus | undefined) => s === 'missing';

export interface ReconGap {
  category: string;
  net: number;
  lines: number;
  evidence: Evidence;
  partial?: boolean;
}
/**
 * A flagged finding matched to a billed pharmacy line — POSITIVE MATCHES ONLY, by deliberate
 * design. See `matchFlaggedToBill` for why the negative is not assertable.
 */
export interface ScriptNote {
  subject: string;              // the flagged low-value finding
  billed: boolean;              // TRUE = provably matched a billed line. FALSE = UNDETERMINED.
  via?: 'molecule' | 'class';   // what carried the match (evidence for the reader)
}
export interface Reconciliation {
  billedNotDocumented: ReconGap[];      // ₹ in a clinical category whose NABH field is 'missing'
  documentedNotBilled: Array<{ evidence: Evidence; categories: string[] }>;
  scriptNotes: ScriptNote[];            // low-value flags: billed line vs discharge script
  reconciledCategories: number;
  facilityNet: number;                  // ₹ in non-clinical categories (shown, not reconciled)
  packaged: boolean;                    // a bundled IP Package line covers this admission
}

/** A bundled package line — the whole stay billed as one item. */
const PACKAGE_CATEGORY = 'IP Package';

/** 'PIPERACILLIN+TAZOBACTAM-INJECTION-4MG+500MG-TAZACT 4.5GM INJ-1's' → 'piperacillin+tazobactam'.
 *  db13 pharmacy item names are MOLECULE-FORM-STRENGTH-BRAND-PACK; the molecule is segment 1. */
export function moleculeOf(itemName: string): string {
  return String(itemName).split('-')[0].trim().toLowerCase();
}

/** Collapse ALL punctuation to spaces: the bill writes 'PIPERACILLIN+TAZOBACTAM' where a finding
 *  writes 'Piperacillin-Tazobactam', so preserving either separator loses the match. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Coarse containment, either direction — a molecule named inside a longer subject phrase, or a
 *  subject that is itself the molecule. ≥4 chars so short tokens can't collide. */
function mentions(haystack: string[], needle: string): boolean {
  const n = norm(needle);
  if (n.length < 4) return false;
  return haystack.some((h) => {
    const hn = norm(h);
    return hn.length >= 4 && (hn.includes(n) || n.includes(hn));
  });
}

/**
 * CATEGORY-LEVEL reconciliation — v1 deliberately coarse. It answers "did the summary account for
 * the KIND of care that was billed", NOT "is this line item justified" (that is BILL-1, v2).
 *
 * A gap is a QUESTION, not a verdict: 'billed but not documented' means a clinical category has ₹
 * against it while the summary lists nothing of that kind — which may be an under-documented
 * summary OR a mis-categorised bill line. It is never asserted as a billing error.
 */
/**
 * Match flagged findings to billed pharmacy lines — POSITIVE ONLY, and that asymmetry is the
 * whole point.
 *
 * The S7 kickoff asked for a note saying whether a flagged item is a billed line or a discharge
 * SCRIPT (dispensed outside the admission, costing the episode nothing). Measured against the
 * real corpus (17-Jul-2026), the negative half of that claim is NOT computable here:
 *   • findings name CLASSES and THEMES — 480 distinct subjects across 532 flags, e.g.
 *     'Post-operative Antibiotic Course' — while the bill names MOLECULES
 *     ('amoxycillin+clavulanic acid'). No string matcher bridges that.
 *   • `item_category` (the drug CLASS that would bridge it) is populated on only ~12% of
 *     pharmacy lines; just 62/126 audited admissions have a single classed line.
 *   • many flags are not billable pharmacy items at ALL ('Length of Inpatient Stay', 'Care
 *     Setting', 'Discharge Polypharmacy') — "is it billed?" is a category error for them.
 * A naive matcher scored 479/497 flags as 'script?' — i.e. it asserted "no ₹" for drugs that were
 * plainly billed. That is an S4.1-grade matcher artifact dressed as a fact, so it is not shipped.
 *
 * What IS sound: a POSITIVE match is real evidence (that molecule/class is on the bill). Absence
 * of a match is evidence of nothing. So we assert only positives, and the panel reports the rest
 * as undetermined rather than as a saving. Making this reliable needs semantic matching — the
 * same fix S4.1 applied to themes — and belongs with BILL-1 (v2).
 */
export function matchFlaggedToBill(
  findings: AuditFinding[],
  pharmacyItems: string[],
  pharmacyClasses: string[] = [],
): ScriptNote[] {
  const molecules = pharmacyItems.map(moleculeOf).filter((m) => m.length >= 4);
  // class tokens: 'ANTIBIOTIC/CEPHALOSPORIN' → ['antibiotic','cephalosporin']; ≥6 chars so that
  // 'CNS'/'ENT'/'E.T' can't collide with ordinary words in a subject line.
  const classTokens = Array.from(new Set(
    pharmacyClasses.flatMap((c) => norm(c).split(' ')).filter((t) => t.length >= 6),
  ));
  const classPhrases = pharmacyClasses.map(norm).filter((c) => c.length >= 6);

  return findings
    .filter((f) => f.verdict === 'low-value' || f.verdict === 'context-dependent')
    .map((f) => {
      const subject = norm(f.subject);
      if (mentions(molecules, f.subject) || molecules.some((m) => subject.includes(m))) {
        return { subject: f.subject, billed: true, via: 'molecule' as const };
      }
      if (classPhrases.some((c) => subject.includes(c)) || classTokens.some((t) => subject.includes(t))) {
        return { subject: f.subject, billed: true, via: 'class' as const };
      }
      return { subject: f.subject, billed: false };   // UNDETERMINED — never "not billed"
    });
}

export function reconcile(
  categories: BillingCategory[],
  documented: DocumentedEvidence,
  findings: AuditFinding[] = [],
  pharmacyItems: string[] = [],
  pharmacyClasses: string[] = [],
): Reconciliation {
  const clinical = categories.filter((c) => c.clinical);
  const billedNotDocumented: ReconGap[] = [];
  for (const c of clinical) {
    const key = CLINICAL_CATEGORY[c.category];
    // Only an explicit 'missing' is a gap. An absent completeness field asserts nothing, and a
    // 'na' means the field does not apply — neither is evidence of an unaccounted-for bill.
    if (c.net > 0 && isGap(documented[key])) {
      billedNotDocumented.push({ category: c.category, net: c.net, lines: c.lines, evidence: key });
    }
  }

  // The other direction, at the same coarseness: the summary documents a kind of care that no
  // billed category stands behind.
  //
  // MEASURED CAVEAT (17-Jul-2026): 468/1,475 IP admissions (32%) are PACKAGE-billed — the stay is
  // bundled into one 'IP Package' line — and only 18 of those 468 also carry separate pathology
  // lines. On a packaged bill the absence of a category line is an artefact of bundling, not
  // evidence that documented care went unbilled, so this direction is SUPPRESSED there rather
  // than firing on ~96% of packaged admissions. The billed-not-documented direction is unaffected
  // (it turns on the summary's own missing NABH field, not on the bill's shape).
  const packaged = categories.some((c) => c.category === PACKAGE_CATEGORY && c.net > 0);
  const billedEvidence = new Set(clinical.filter((c) => c.net > 0).map((c) => CLINICAL_CATEGORY[c.category]));
  const documentedNotBilled: Reconciliation['documentedNotBilled'] = [];
  if (!packaged) {
    for (const key of ['medications', 'investigations', 'procedures'] as const) {
      if (isDocumented(documented[key]) && !billedEvidence.has(key)) {
        documentedNotBilled.push({
          evidence: key,
          categories: Object.entries(CLINICAL_CATEGORY).filter(([, v]) => v === key).map(([k]) => k),
        });
      }
    }
  }

  const scriptNotes = matchFlaggedToBill(findings, pharmacyItems, pharmacyClasses);

  return {
    billedNotDocumented,
    documentedNotBilled,
    scriptNotes,
    reconciledCategories: clinical.length,
    facilityNet: categories.filter((c) => !c.clinical).reduce((s, c) => s + c.net, 0),
    packaged,
  };
}

// ── peer band ────────────────────────────────────────────────────────────────────────────────────

export interface PeerBand {
  speciality: string;
  n: number;
  p25: number; median: number; p75: number;
  ready: boolean;          // false ⇒ too few peers; the panel shows the raw ₹ + "band building"
}

const MIN_PEERS = 5;

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/**
 * The peer band for a speciality, from the AUDITED corpus's own billed_totals (Neon — no db13
 * round-trip). Deliberately a simple quartile band over what we have actually audited, not a
 * population statistic: with n < 5 it reports ready:false rather than pretending to a band.
 */
export async function peerBandForSpeciality(speciality: string | null): Promise<PeerBand | null> {
  if (!speciality) return null;
  const rows = (await sql(
    `SELECT billed_total FROM ipd_discharge_audits
     WHERE engine_version = $1 AND speciality = $2 AND billed_total IS NOT NULL AND billed_total > 0`,
    [IPD_ENGINE_VERSION, speciality],
  )) as unknown as Array<{ billed_total: string | number }>;
  const vals = rows.map((r) => Number(r.billed_total)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!vals.length) return { speciality, n: 0, p25: 0, median: 0, p75: 0, ready: false };
  return {
    speciality,
    n: vals.length,
    p25: pct(vals, 0.25), median: pct(vals, 0.5), p75: pct(vals, 0.75),
    ready: vals.length >= MIN_PEERS,
  };
}
