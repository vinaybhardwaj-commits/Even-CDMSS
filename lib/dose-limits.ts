/**
 * lib/dose-limits.ts — loads the bundled per-molecule daily-dose ceilings (data/dose-limits.json)
 * once, and exposes the pure aggregation findings from lib/dose-aggregation-core.ts pre-bound to
 * that table. Kept out of the pure core so the core stays loadable under `--experimental-strip-types`.
 */

import LIMITS from '@/data/dose-limits.json';
import { doseAggregationFindings, type DoseLimitsTable } from './dose-aggregation-core';
import type { OpdMed } from './opd-ingest-core';
import type { OpdFinding } from './opd-note-audit-core';

const TABLE = LIMITS as unknown as DoseLimitsTable;

/** Molecule-level daily-dose aggregation findings for a prescription. */
export function doseFindings(meds: OpdMed[]): OpdFinding[] {
  return doseAggregationFindings(meds, TABLE);
}

export const DOSE_LIMITS_VERSION = TABLE.version;
