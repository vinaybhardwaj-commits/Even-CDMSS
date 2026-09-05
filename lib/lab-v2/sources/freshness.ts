/**
 * lib/lab-v2/sources/freshness.ts — `source_freshness` (§17.2).
 *
 * Five sources, five independent reads. §17.2 is explicit that each source is
 * `SOURCE_UNAVAILABLE` on its own and THE REST STILL RETURN — a freshness tool whose whole answer
 * disappears because one mirror is down is useless exactly when it is needed, so every probe here
 * is wrapped and reported per source.
 *
 * INFERRED. Every statement is listed verbatim in the build report. The Neon column names
 * (`opd_note_audits.audited_at`, `ipd_episode_audits.audited_at`, `mksap_chunks.created_at`) were
 * confirmed live on 05 Sep 2026 through the v1 `audit_query` connector. The db13 statement is the
 * one that could NOT be validated that way — `audit_query` fronts production Neon, not db13 — so
 * it is marked INFERRED-UNVALIDATED in the report. It reads the table `fetchOpdNoteByUid` reads.
 */
import { guardReadOnlySql } from '../../sql-guard-core';
import { sql } from '../../db';
import { metabaseQuery } from '../../metabase';
import type { Db } from '../db';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** db13, through the same Metabase reader the OPD worker uses. The table name needs the quotes. */
export const DB13_FRESHNESS_SQL =
  `SELECT max(ip.timestamp) AS newest, count(*) FILTER (WHERE ip.timestamp > now() - interval '24 hours') AS last_24h ` +
  `FROM "individuals-prescriptions" ip`;

export const OPD_AUDITS_FRESHNESS_SQL =
  `SELECT max(audited_at) AS newest, count(*) FILTER (WHERE audited_at > now() - interval '24 hours') AS last_24h FROM opd_note_audits`;

export const IPD_EPISODE_FRESHNESS_SQL =
  `SELECT max(audited_at) AS newest, count(*) FILTER (WHERE audited_at > now() - interval '24 hours') AS last_24h FROM ipd_episode_audits`;

export const MKSAP_FRESHNESS_SQL =
  `SELECT max(created_at) AS newest, count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS last_24h ` +
  `FROM mksap_chunks WHERE text IS NOT NULL AND visible IS NOT FALSE AND source NOT LIKE 'labq:%'`;

export const LAB_V2_CALLS_FRESHNESS_SQL =
  `SELECT max(settled_at) AS newest, count(*) FILTER (WHERE settled_at > now() - interval '24 hours') AS last_24h ` +
  `FROM lab_v2.calls WHERE state = 'settled'`;

export interface SourceFreshness {
  source: string;
  ok: boolean;
  newest: string | null;
  rows_last_24h: number | null;
  error: string | null;
}

/** One probe, never allowed to throw. A failure is this source's row, not the tool's. */
async function probe(name: string, fn: () => Promise<{ newest: unknown; last_24h: unknown }>): Promise<SourceFreshness> {
  try {
    const r = await fn();
    const newest = r.newest == null ? null : new Date(String(r.newest)).toISOString();
    return { source: name, ok: true, newest, rows_last_24h: Number(r.last_24h ?? 0), error: null };
  } catch (e) {
    return {
      source: name, ok: false, newest: null, rows_last_24h: null,
      error: `SOURCE_UNAVAILABLE: ${(e as Error).message}`.slice(0, 300),
    };
  }
}

async function neon(statement: string): Promise<{ newest: unknown; last_24h: unknown }> {
  const g = guardReadOnlySql(statement, 500);
  if (!g.ok) throw new Error(g.error);
  const rows = await run(g.sql, []);
  return (rows[0] ?? { newest: null, last_24h: 0 }) as { newest: unknown; last_24h: unknown };
}

/** All five sources. `lab_v2.calls` is read from the v2 store, not production Neon. */
export async function sourceFreshness(db: Db): Promise<SourceFreshness[]> {
  return Promise.all([
    probe('db13:individuals-prescriptions', async () => {
      const rows = await metabaseQuery(DB13_FRESHNESS_SQL);
      return (rows[0] ?? { newest: null, last_24h: 0 }) as { newest: unknown; last_24h: unknown };
    }),
    probe('neon:opd_note_audits', () => neon(OPD_AUDITS_FRESHNESS_SQL)),
    probe('neon:ipd_episode_audits', () => neon(IPD_EPISODE_FRESHNESS_SQL)),
    probe('neon:mksap_chunks', () => neon(MKSAP_FRESHNESS_SQL)),
    probe('lab_v2:calls', async () => {
      const rows = await db.query<{ newest: unknown; last_24h: unknown }>(LAB_V2_CALLS_FRESHNESS_SQL);
      return rows[0] ?? { newest: null, last_24h: 0 };
    }),
  ]);
}
