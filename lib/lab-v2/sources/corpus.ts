/**
 * lib/lab-v2/sources/corpus.ts — read-only access to `mksap_chunks` (§17.2).
 *
 * WARNING: "ACTIVE" IS NOT A COLUMN. `mksap_chunks` has no `active` field — confirmed live
 * against production Neon on 05 Sep 2026 (23 columns; the flag is `visible boolean`).
 * Production's own definition of a chunk retrieval may serve is the clause list at
 * lib/retrieve.ts:167:
 *
 *     text IS NOT NULL · visible IS NOT FALSE · source NOT LIKE 'labq:%'
 *
 * That predicate is reproduced here verbatim rather than re-invented, because the `labq:` prefix
 * is the corpus quarantine (lib/lab.ts CORPUS_QUARANTINE_INSERT_SQL inserts `visible false` AND a
 * `labq:` source) and a lab tool that reported a quarantined chunk as active would misdescribe
 * the corpus the audits were actually run against.
 *
 * Every statement here is INFERRED and listed verbatim in the build report. Column names were
 * confirmed live before the file was written. Reads go through the v1 read-only guard.
 */
import { guardReadOnlySql } from '../../sql-guard-core';
import { sql } from '../../db';
import { LabError } from '../contracts';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const GUARD_MAX = 500;

/** Production's active predicate, from lib/retrieve.ts:167. */
export const ACTIVE_PREDICATE = `text IS NOT NULL AND visible IS NOT FALSE AND source NOT LIKE 'labq:%'`;

/** The projection every corpus read shares. `preview` is a bounded excerpt, never a whole chunk. */
const CHUNK_COLUMNS =
  `id, book, chapter, source, ` +
  `(text IS NOT NULL AND visible IS NOT FALSE AND source NOT LIKE 'labq:%') AS active, ` +
  `left(text, 400) AS preview`;

export interface ChunkRow {
  id: string | number; book: string | null; chapter: string | null; source: string | null;
  active: boolean; preview: string | null;
}

/**
 * Lexical search takes arbitrary clinical words, so this one CANNOT refuse on charset the way an
 * id filter does. Single quotes are doubled — the only escape a Postgres string literal needs —
 * a NUL is refused outright, and the result still passes the v1 guard before it runs.
 */
function litText(value: string, field: string): string {
  if (/\u0000/.test(value)) throw new LabError('INVALID_INPUT', `${field} must not contain a NUL character`);
  return `'${value.replace(/'/g, "''")}'`;
}

function litInts(ids: number[]): string {
  const clean = ids.map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n));
  if (!clean.length) throw new LabError('INVALID_INPUT', 'at least one citation id is required');
  return clean.join(', ');
}

async function guarded<T>(statement: string): Promise<T[]> {
  const g = guardReadOnlySql(statement, GUARD_MAX);
  if (!g.ok) throw new LabError('INVALID_INPUT', `generated statement refused by the read-only guard: ${g.error}`);
  try {
    return (await run(g.sql, [])) as T[];
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `mksap_chunks unavailable: ${(e as Error).message}`);
  }
}

export function buildChunksByIdSql(ids: number[]): string {
  return `SELECT ${CHUNK_COLUMNS} FROM mksap_chunks WHERE id IN (${litInts(ids)}) LIMIT 200`;
}

/** Resolve citation ids. Callers report ids that came back with no row as UNRESOLVED (§17.2). */
export async function chunksById(ids: number[]): Promise<ChunkRow[]> {
  if (!ids.length) return [];
  return guarded<ChunkRow>(buildChunksByIdSql(ids));
}

export interface CorpusSearchInput { text: string; book?: string; source?: string; active?: boolean; limit: number }

export function buildCorpusSearchSql(i: CorpusSearchInput): string {
  const w: string[] = [`text ILIKE ${litText(`%${i.text}%`, 'text')}`];
  if (i.book) w.push(`book = ${litText(i.book, 'book')}`);
  if (i.source) w.push(`source = ${litText(i.source, 'source')}`);
  if (i.active === true) w.push(`(${ACTIVE_PREDICATE})`);
  if (i.active === false) w.push(`NOT (${ACTIVE_PREDICATE})`);
  return `SELECT ${CHUNK_COLUMNS} FROM mksap_chunks WHERE ${w.join(' AND ')} ORDER BY id LIMIT ${Math.trunc(i.limit)}`;
}

export async function corpusSearch(i: CorpusSearchInput): Promise<ChunkRow[]> {
  return guarded<ChunkRow>(buildCorpusSearchSql(i));
}

/** The quarantine prefix carried on a `labq:` source, or null. Display only. */
export function quarantinePrefix(source: string | null): string | null {
  return source && source.startsWith('labq:') ? 'labq:' : null;
}
