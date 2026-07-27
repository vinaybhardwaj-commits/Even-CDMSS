/**
 * lib/ipd-audit/canonical.ts — ONE ROW PER DOCUMENT (PRD §1.2, resolution to B-1/B-2).
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
  document_id?: unknown;
  engine_version?: unknown;
  audited_at?: unknown;
  id?: unknown;
}

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
 * Reduce a fetched row set to one row per `document_id`, per THE RULE.
 *
 * · Input order does NOT affect the result (the comparator is total on the ranking keys).
 * · Rows with no `document_id` are PASSED THROUGH rather than dropped — losing a row because a
 *   column was null would be a silent data loss, and the caller asked for these rows.
 * · Relative order of the surviving rows is preserved, so an ORDER BY applied in SQL still holds.
 * · Never throws.
 */
export function canonicalByDocument<T extends CanonicalCandidate>(rows: T[], opts: CanonicalOptions = {}): T[] {
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
    const doc = r.document_id == null ? '' : String(r.document_id);
    if (!doc) { passthrough.push(r); continue; }
    const cur = winner.get(doc);
    if (!cur) { winner.set(doc, r); continue; }
    const byEngine = compareEngineVersion(r.engine_version, cur.engine_version);
    if (byEngine > 0) { winner.set(doc, r); continue; }
    if (byEngine < 0) continue;
    // Tie on engine version → latest audited_at wins.
    if (auditedAtMs(r.audited_at) > auditedAtMs(cur.audited_at)) winner.set(doc, r);
  }

  const kept = new Set<T>([...winner.values(), ...passthrough]);
  return source.filter((r) => kept.has(r));
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
