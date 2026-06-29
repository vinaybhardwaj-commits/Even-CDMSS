/**
 * lib/formulary.ts — EHRC Pharmacy Formulary 2026 lookup (loads the bundled JSON,
 * builds the resolver once). Matching logic is in lib/formulary-match-core.ts (pure,
 * unit-tested). Used by the OPD note-quality audit to recover the molecule + class +
 * schedule + ISMP high-alert + LASA + VED behind a brand-only prescription.
 *
 * Same formulary the pharmacist Medication-Audit surface seeds into Neon `formulary`;
 * here we read it in-process (no DB round-trip per audited note).
 */

import FORMULARY from '@/data/formulary-2026.json';
import {
  buildFormularyMatcher, classifyUnmatched, normalizeDrugName,
  type FormularyRow, type FormularyMatch, type NonFormularyTag,
} from './formulary-match-core';
import type { OpdMed } from './opd-ingest-core';

type RawFormularyRow = {
  brand?: string; generic?: string; generic_canon?: string; major?: string; minor?: string;
  schedule_dc?: string; high_risk?: boolean; lasa?: string; ved?: string; restricted?: boolean;
};

const ROWS: FormularyRow[] = ((FORMULARY as unknown as RawFormularyRow[]) || []).map((r) => ({
  brand: r.brand || '',
  generic: r.generic || '',
  generic_canon: r.generic_canon || r.generic || '',
  major: r.major || undefined,
  minor: r.minor || undefined,
  schedule_dc: r.schedule_dc || undefined,
  high_risk: !!r.high_risk,
  lasa: r.lasa || undefined,
  ved: r.ved || undefined,
  restricted: !!r.restricted,
}));

const MATCHER = buildFormularyMatcher(ROWS);

/** Resolve one medication ({brand, generic}) against the formulary. null = no signal at all. */
export function resolveMed(med: { brand?: string | null; generic?: string | null }): FormularyMatch | null {
  return MATCHER.resolve(med);
}

/** Enrich OPD meds IN PLACE with the formulary molecule + class + schedule + safety profile.
 *  Shared by the audit orchestrator and the case-view note panel so both show the same. */
export function enrichOpdMeds(meds: OpdMed[]): void {
  for (const m of meds) {
    const match = MATCHER.resolve({ brand: m.brand, generic: m.generic });
    if (match) {
      m.resolvedGeneric = match.generic;
      m.therapeuticClass = match.major;
      m.subClass = match.minor;
      m.schedule = match.schedule;
      m.highAlert = match.highAlert;
      m.lasa = match.lasa.length ? match.lasa : undefined;
      m.ved = match.ved;
      m.restricted = match.restricted;
      m.formularyMatch = match.matchType;
    } else {
      m.formularyMatch = 'none';
      if (m.brand || m.generic) m.nonFormulary = classifyUnmatched(m.brand || m.generic || '');
    }
  }
}

export { classifyUnmatched, normalizeDrugName };
export type { FormularyMatch, NonFormularyTag };
export const FORMULARY_SIZE = ROWS.length;
