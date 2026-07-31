/**
 * lib/audit-canonical.ts — ONE ROW PER AUDITED THING (PRD §1.2 for IPD; §12.3 FIX 0 for OPD).
 *
 * PURE, dependency-free, strip-types testable.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RULE, settled 27 Jul 2026:
 *
 *   Every read surface shows ONE row per `document_id`: the one with the highest
 *   `engine_version`, ties broken by latest `audited_at`.
 *
 * Applied uniformly — list, calendar, doctor grouping, specialty counts, impact preview, and every
 * aggregate (mean, SD, band histogram, changing-band). Older re-audits remain STORED and reachable
 * from the report detail as history; they never contribute to a count, a mean or a histogram.
 *
 * THIS IS A READ FILTER. Nothing is updated, nothing is deleted.
 *
 * GENERALISED for Phase C. The rule is identical for both engines; only the IDENTITY COLUMN
 * differs — `document_id` for IPD discharge audits, `uid` for OPD note audits. `canonicalBy` takes
 * that key; `canonicalByDocument` and `canonicalByUid` are the two named bindings. There is exactly
 * one implementation, which is the entire point (see the note below).
 *
 * OPD is the worse case, MEASURED 27 Jul on live data: a 90-day window holds 25,128 audit rows over
 * 11,835 distinct notes — 52.9% duplicates. It bites hardest on the days an engine bump spans:
 * 2026-07-25 is 532 rows over 429 notes, and includes a `-mini` row.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY IT EXISTS. `ipd_discharge_audits` carries UNIQUE(document_id, engine_version) by design, so
 * one discharge summary can hold a 0.1 row AND a 0.2 row — and they disagree: IP-1253 is 95/C under
 * 0.1 and 88/D under 0.2. Counting both inflates every cohort statistic, and de-duplicating without
 * a stated rule silently picks one of two rows that contradict each other.
 *
 * ONE IMPLEMENTATION, DELIBERATELY. B-1 was two counts sitting side by side, each computed its own
 * way. The fix is not to make two implementations agree; it is to have one. Every surface calls
 * this function over rows it has already fetched — no surface writes its own DISTINCT ON.
 */

/** The minimum a row must carry to be ranked. Extra properties are preserved untouched. */
export interface CanonicalCandidate {
  /** IPD identity — one audit per discharge-summary document. */
  document_id?: unknown;
  /** OPD identity — one audit per db13 note uid. */
  uid?: unknown;
  engine_version?: unknown;
  audited_at?: unknown;
  id?: unknown;
}

/** Which column identifies "the same audited thing" for a given engine. */
export type IdentityKey = 'document_id' | 'uid';

/**
 * Mini/Qwen backfill rows share a document with the prod row, distinguished only by a `-mini`
 * engine-version suffix (lib/ipd-audit/store.ts IPD_MINI_ENGINE_VERSION). They are a different
 * MODEL of the same engine, not a newer version, and every prod read surface has always excluded
 * them. They must not win the ranking — note that lexicographically
 * `ipd-discharge-audit/0.2-mini` > `ipd-discharge-audit/0.2`, so a naive DESC sort would hand every
 * document to the backfill.
 */
export function isMiniEngine(engineVersion: unknown): boolean {
  return /-mini$/.test(String(engineVersion ?? ''));
}

/**
 * Compare two engine versions. Returns >0 when `a` is NEWER than `b`.
 *
 * The numeric tail (`ipd-discharge-audit/0.2` → [0, 2]) is compared component-wise when BOTH sides
 * parse, so a future `0.10` correctly beats `0.2` — the trap a plain lexicographic sort walks into.
 * Anything unparseable falls back to a string compare rather than throwing, so an unexpected tag
 * degrades to a defined order instead of taking a page down.
 */
export function compareEngineVersion(a: unknown, b: unknown): number {
  const sa = String(a ?? ''), sb = String(b ?? '');
  if (sa === sb) return 0;
  const parts = (s: string): number[] | null => {
    const tail = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
    if (!/^\d+(\.\d+)*$/.test(tail)) return null;
    return tail.split('.').map(Number);
  };
  const pa = parts(sa), pb = parts(sb);
  if (pa && pb) {
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  }
  return sa < sb ? -1 : 1;
}

function auditedAtMs(v: unknown): number {
  if (v == null) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

export interface CanonicalOptions {
  /** Default true — mini/Qwen backfill rows are dropped before ranking. */
  excludeMini?: boolean;
}

/**
 * Reduce a fetched row set to one row per identity, per THE RULE.
 *
 * · Input order does NOT affect the result (the comparator is total on the ranking keys).
 * · Rows with no identity value are PASSED THROUGH rather than dropped — losing a row because a
 *   column was null would be a silent data loss, and the caller asked for these rows.
 * · Relative order of the surviving rows is preserved, so an ORDER BY applied in SQL still holds.
 * · Never throws.
 */
export function canonicalBy<T extends CanonicalCandidate>(rows: T[], key: IdentityKey, opts: CanonicalOptions = {}): T[] {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return [];
  const excludeMini = opts.excludeMini !== false;

  const eligible = excludeMini ? list.filter((r) => !isMiniEngine(r.engine_version)) : list;
  // If excluding mini would empty the set, keep what we had: showing a backfill row is better than
  // showing nothing, and this can only happen on a document prod has never audited.
  const source = eligible.length ? eligible : list;

  const winner = new Map<string, T>();
  const passthrough: T[] = [];
  for (const r of source) {
    const raw = (r as Record<string, unknown>)[key];
    const identity = raw == null ? '' : String(raw);
    if (!identity) { passthrough.push(r); continue; }
    const cur = winner.get(identity);
    if (!cur) { winner.set(identity, r); continue; }
    const byEngine = compareEngineVersion(r.engine_version, cur.engine_version);
    if (byEngine > 0) { winner.set(identity, r); continue; }
    if (byEngine < 0) continue;
    // Tie on engine version → latest audited_at wins.
    if (auditedAtMs(r.audited_at) > auditedAtMs(cur.audited_at)) winner.set(identity, r);
  }

  const kept = new Set<T>([...winner.values(), ...passthrough]);
  return source.filter((r) => kept.has(r));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE SQL TWIN (31 Jul 2026, addendum C)
//
// "Every surface calls this function over rows it has already fetched" holds only for surfaces that
// FETCH rows. Four doctor aggregates compute their answer in SQL — count(*), avg(), GROUP BY — and
// never return the rows, so a TypeScript filter cannot deduplicate what was never sent. Those need
// the rule expressed in SQL.
//
// ONE RULE, TWO EXPRESSIONS, and the same reasoning as ONE IMPLEMENTATION above: they are declared
// adjacent, and a test feeds the SAME fixture to both and asserts they pick the same row. Editing
// one without the other fails that test rather than silently creating a sixth posture.
//
// TWO TRAPS THE ORDERING MUST HANDLE — both are the SQL form of what compareEngineVersion and
// isMiniEngine already handle above:
//
//   1. LEXICOGRAPHIC ORDERING IS WRONG. `ORDER BY engine_version DESC` ranks
//      `opd-note-audit/0.81.9` ABOVE `opd-note-audit/0.81.17`, because '9' > '1'. The numeric tail
//      must be compared component-wise, which `string_to_array(...)::int[]` does natively — int[]
//      comparison in Postgres is element-wise, exactly like compareEngineVersion's loop.
//
//   2. `-mini` SORTS ABOVE ITS BASE VERSION, and its tail does not cast to int[]
//      ('14-mini' is not an integer), so the cast would RAISE rather than mis-rank.
//      ⚠️ DEPENDENCY, DELIBERATE: on these surfaces trap 2 cannot fire, because every caller
//      already filters `engine_version = ANY(OPD_ENGINE_VERSIONS_CURRENT)` and none of that
//      family's fifteen entries (0.81.3 → 0.81.17) carries a `-mini` suffix — mini rows are
//      excluded BEFORE ranking and every surviving tail casts cleanly. So there is no guard here.
//      Adding a `-mini` entry to OPD_ENGINE_VERSIONS_CURRENT breaks this cast; the family filter is
//      what makes the bare cast safe, and the two must be changed together.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The ranking tail of THE RULE as SQL: highest engine version first, ties broken by latest
 * `audited_at`. Goes after `ORDER BY <identity>,` in a DISTINCT ON, or use `canonicalDistinctOnSql`.
 * Assumes mini rows are already excluded by the caller's engine filter — see trap 2 above.
 */
export const CANONICAL_RANK_SQL =
  `string_to_array(split_part(engine_version, '/', 2), '.')::int[] DESC, audited_at DESC`;

/**
 * A DISTINCT ON subquery selecting the canonical row per identity — the SQL twin of `canonicalBy`.
 * Wrap an aggregate around this so `count(*)`/`avg()` see one row per note, and so a LIMIT counts
 * canonical rows rather than duplicates.
 *
 * `table` and `where` are composed by the caller (this module stays table-agnostic and takes no
 * imports); `where` must already carry the engine-family filter that makes the cast safe.
 */
export function canonicalDistinctOnSql(
  opts: { table: string; identity: IdentityKey; cols: string; where: string },
): string {
  return `SELECT DISTINCT ON (${opts.identity}) ${opts.identity}, ${opts.cols}
          FROM ${opts.table}
          WHERE ${opts.where}
          ORDER BY ${opts.identity}, ${CANONICAL_RANK_SQL}`;
}

/** IPD: one row per discharge-summary document. */
export function canonicalByDocument<T extends CanonicalCandidate>(rows: T[], opts: CanonicalOptions = {}): T[] {
  return canonicalBy(rows, 'document_id', opts);
}

/** OPD: one row per db13 note uid. Same rule, same code — only the identity column differs. */
export function canonicalByUid<T extends CanonicalCandidate>(rows: T[], opts: CanonicalOptions = {}): T[] {
  return canonicalBy(rows, 'uid', opts);
}

/**
 * Count canonical rows per speciality — the source of the filter chips.
 *
 * Takes the SAME canonical rows the list renders, so the chip and the list cannot disagree by
 * construction. That structural guarantee is the whole point of B-1: two numbers on one screen must
 * not be computed two ways.
 *
 * `unassignedLabel` is the option that selects rows whose speciality is null/blank.
 */
export function specialityCounts<T extends CanonicalCandidate & { speciality?: unknown }>(
  rows: T[],
  unassignedLabel: string,
): { speciality: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const raw = r?.speciality == null ? '' : String(r.speciality).trim();
    const key = raw === '' ? unassignedLabel : raw;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([speciality, n]) => ({ speciality, n }))
    .sort((a, b) => b.n - a.n || a.speciality.localeCompare(b.speciality));
}

/** Apply the speciality filter to canonical rows, mirroring the chip's own bucketing exactly. */
export function filterBySpeciality<T extends CanonicalCandidate & { speciality?: unknown }>(
  rows: T[],
  speciality: string | null | undefined,
  unassignedLabel: string,
): T[] {
  const want = String(speciality ?? '').trim();
  if (!want || want === 'all') return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    const raw = r?.speciality == null ? '' : String(r.speciality).trim();
    return (raw === '' ? unassignedLabel : raw) === want;
  });
}
