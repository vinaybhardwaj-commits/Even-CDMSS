/**
 * lib/charge-master.ts — EHRC Charge Master (package tariff) lookup (CW-VA cost grounding).
 *
 * Grounds the Value Analysis upfront-cost line in EHRC's REAL package prices instead of an LLM
 * estimate. Data = data/charge-master-packages.json (201 inpatient packages, parsed from the EHRC
 * Tariff 2025-26 "Package Tariff" PDF), prices by room tier (general/private/suite). Matching logic
 * is in lib/charge-master-core.ts (pure, unit-tested).
 */

import PACKAGES_DOC from '@/data/charge-master-packages.json';
import { matchTariffIn, type TariffRow, type TariffMatch } from './charge-master-core';

const ROWS: TariffRow[] = ((PACKAGES_DOC as { packages?: TariffRow[] }).packages) || [];

export function matchTariff(query: string): TariffMatch | null {
  return matchTariffIn(query, ROWS);
}

/** Match a list of proposed orders → dedup tariff matches (one per package code). */
export function matchTariffs(queries: string[]): TariffMatch[] {
  const out: TariffMatch[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const m = matchTariff(q);
    if (m && !seen.has(m.code)) { seen.add(m.code); out.push(m); }
  }
  return out;
}

export { matchTariffIn, normalizeTariffText, formatINR, formatTariffForPrompt } from './charge-master-core';
export type { TariffRow, TariffMatch } from './charge-master-core';
