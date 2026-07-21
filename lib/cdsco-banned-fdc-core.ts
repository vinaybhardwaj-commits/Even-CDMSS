/**
 * lib/cdsco-banned-fdc-core.ts — CDSCO banned fixed-dose-combination check (PURE).
 * PRD CDMSS-CDSCO-BANNED-FDC (C1–C9). No db / Next imports; loads under strip-types for tests.
 *
 * A prescription whose molecule set EXACTLY equals a combination prohibited under Section 26A of
 * the Drugs and Cosmetics Act 1940 (per the curated, pharmacist-reviewed gazette seed —
 * data/cdsco-banned-fdc.json, injected here) emits a deterministic prescribing_safety finding at
 * verdict 'low-value', confidence 1.0 (C1/C5/C6).
 *
 * MATCHING (C5): exact molecule-SET equality only. medMolecules() (the existing splitter — never a
 * second splitter) → lowercase, trim, drop empties, dedupe, SORT; compare against the entry's
 * `molecules` (canonicalised the same way defensively, though the seed is compiled lowercase+sorted).
 * A superset does NOT fire; a subset does NOT fire; no fuzzy or synonym matching, ever.
 *
 * FAIL-SAFE (PRD §7): every failure degrades to SILENCE. Malformed/empty table → []. A brand with
 * no resolvable generic has no molecule set → no finding (an accepted miss — an unresolvable brand
 * is never accused). Any exception → caught, [] returned; the audit proceeds. There is NO path
 * where this check asserts a prescription is illegal on incomplete evidence.
 */

import type { OpdMed } from './opd-ingest-core';
import { medMolecules, type OpdFinding } from './opd-note-audit-core';

// ── Injected seed table (shape of data/cdsco-banned-fdc.json, PRD §3) ─────────
export interface BannedFdcEntry {
  id: string;                       // e.g. cdsco-2026-06-11-004
  molecules: string[];              // lowercase, sorted, canonical (compile-time discipline)
  notification_date: string;        // YYYY-MM-DD gazette notification date
  gazette_ref: string;              // S.O. number
  citation_url?: string;
  statement?: string;
}
export interface BannedFdcTable {
  version: string;
  compiled_on?: string | null;
  reviewed_by?: string | null;      // C3 — pharmacist sign-off, populated before any entry ships
  entries: BannedFdcEntry[];
}

/** Canonical molecule set: lowercase, trim, drop empties, dedupe, sort. */
export function normalizeMoleculeSet(mols: string[]): string[] {
  return Array.from(new Set(mols.map((m) => String(m || '').toLowerCase().trim()).filter(Boolean))).sort();
}

/**
 * Deterministic banned-FDC findings for a prescription (C1). One finding per matched BAN ENTRY
 * (two products of the same banned combination → one finding). Emits the det() shape verbatim
 * (C6); the `Subject: detail` colon convention is load-bearing — the text before the colon is the
 * signal-type key (SIGNAL_TYPE_RULES → 'banned_fdc'), the text after feeds finding_ref.
 */
export function bannedFdcFindings(meds: OpdMed[], table: BannedFdcTable): OpdFinding[] {
  try {
    const entries = Array.isArray(table?.entries) ? table.entries : [];
    if (!entries.length || !Array.isArray(meds) || !meds.length) return [];

    // Pre-canonicalise entries; a malformed entry (no id / <2 molecules) can never fire.
    const canon = entries
      .map((e) => ({ e, key: normalizeMoleculeSet(Array.isArray(e?.molecules) ? e.molecules : []).join('|') }))
      .filter((x) => !!x.e?.id && x.key.includes('|'));   // ≥2 molecules — a single-molecule "combination" is a data error, not a ban we assert
    if (!canon.length) return [];

    const out: OpdFinding[] = [];
    const fired = new Set<string>();
    for (const m of meds) {
      const set = normalizeMoleculeSet(medMolecules(m));
      if (set.length < 2) continue;                       // single molecule can never equal a banned combination (C5)
      const key = set.join('|');
      for (const { e, key: entryKey } of canon) {
        if (key !== entryKey || fired.has(e.id)) continue;
        fired.add(e.id);
        const composition = entryKey.split('|').join(' + ');
        out.push({
          subject: `Banned fixed-dose combination: ${composition}`,
          verdict: 'low-value',                            // C6 — maximal penalty
          confidence: 1.0,                                 // C5 — exact match or nothing
          domain: 'prescribing_safety',
          rationale: `${composition} is prohibited for manufacture, sale and distribution in India under Section 26A of the Drugs and Cosmetics Act 1940 (gazette ${e.gazette_ref}, ${e.notification_date}).`,
          evidence: [], estimates: [], citation_ids: [],
          source: 'deterministic',
        });
      }
    }
    return out;
  } catch {
    return [];                                            // PRD §7 — never throw, never block an audit
  }
}
