/**
 * lib/charge-master.ts — EHRC Charge Master lookup (CW-VA cost grounding).
 *
 * Grounds the Value Analysis cost line in EHRC's REAL prices instead of an LLM estimate.
 * Two sources, both parsed from the EHRC Tariff 2025-26 PDFs:
 *   - data/charge-master-packages.json       (201 inpatient surgical/procedure packages)
 *   - data/charge-master-investigations.json (2,208 labs/imaging/etc.)
 * Matching logic is in lib/charge-master-core.ts (pure, unit-tested).
 */

import PACKAGES_DOC from '@/data/charge-master-packages.json';
import INVESTIGATIONS_DOC from '@/data/charge-master-investigations.json';
import { matchTariffIn, matchInvestigationIn, type TariffRow, type TariffMatch } from './charge-master-core';

type RawPkg = { code: string; dept?: string; item: string; general: number; private?: number; suite?: number };
type RawInv = { code: string; type?: string; item: string; opd?: number | null; general: number; private?: number | null; suite?: number | null };

const PACKAGE_ROWS: TariffRow[] = (((PACKAGES_DOC as { packages?: RawPkg[] }).packages) || [])
  .map((r) => ({ kind: 'package' as const, code: r.code, dept: r.dept, item: r.item, general: r.general, private: r.private ?? null, suite: r.suite ?? null }));

const INVESTIGATION_ROWS: TariffRow[] = (((INVESTIGATIONS_DOC as { investigations?: RawInv[] }).investigations) || [])
  .map((r) => ({ kind: 'investigation' as const, code: r.code, type: r.type, item: r.item, opd: r.opd ?? null, general: r.general, private: r.private ?? null, suite: r.suite ?? null }));

export function matchTariff(query: string): TariffMatch | null {
  return matchTariffIn(query, PACKAGE_ROWS);
}
export function matchInvestigation(query: string): TariffMatch | null {
  return matchInvestigationIn(query, INVESTIGATION_ROWS);
}

/** Match a list of proposed orders against packages first, then investigations. Dedup by code. */
export function matchAnyTariffs(queries: string[]): TariffMatch[] {
  const out: TariffMatch[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const m = matchTariff(q) || matchInvestigation(q);
    if (m && !seen.has(m.code)) { seen.add(m.code); out.push(m); }
  }
  return out;
}

export { matchTariffIn, matchInvestigationIn, normalizeTariffText, formatINR, formatTariffForPrompt } from './charge-master-core';
export type { TariffRow, TariffMatch, TariffKind } from './charge-master-core';
