/**
 * lib/lvc-ratify-surface-core.ts — LVC RULEBOOK REPAIR PRD v1.1 §3.5 (D-17 to D-21), 25 Aug 2026.
 *
 * THE LOGIC BEHIND THE RATIFICATION SITTING. Record-set loading, progress derivation, the
 * previous-values payload the ledger carries, and the two write paths — accept and reject.
 *
 * ⚠️ THE ACCEPT WRITES PRODUCTION DATA AND THERE IS NO UNDO (D-20). No snapshot table exists and a
 * code revert will not restore a rule. Three things make that survivable and they are all here:
 *   · every UPDATE is guarded IS DISTINCT FROM, so a second press is inert (§6.8);
 *   · every accept appends the survivor's PREVIOUS statement, precondition, keywords and category
 *     to the append-only ledger, which is what makes a correction WRITABLE — a recovery path, not
 *     an undo button;
 *   · stored findings are never rewritten (D-4), so no audit already delivered to a doctor changes.
 *
 * NO SESSION STATE (D-21 / §6.13). Progress is a PURE function of the live rulebook plus the
 * ledger. There is no sitting object, no localStorage and no server-side cursor. Closing the
 * browser and reopening it resumes exactly, because there was never anywhere else for the state
 * to live.
 *
 * ⚠️ EVERY SQL STRING HERE IS INFERRED and is reproduced verbatim in the build report. The column
 * names and the ledger's constraints were confirmed read-only against the live schema; no statement
 * below was executed.
 *
 * ⚠️ FLAGGED DEVIATION — THE LEDGER ANCHOR. PRD §3.5 says an accept appends one `lvc_ratifications`
 * row. That table's `proposal_id` is `uuid NOT NULL REFERENCES lvc_recommendation_proposals(id)`
 * (migrations/0023, confirmed live), so a ledger row CANNOT exist without a proposal row to point
 * at — and the file contract forbids 0041 from carrying anything but the merged_into column, so the
 * constraint cannot be relaxed here. Each accept therefore writes ONE anchor row into
 * `lvc_recommendation_proposals` immediately before the ledger row, carrying the accepted values,
 * `supersedes_id = <survivor id>` and `status = 'ratified'`. This is not a staging table in the
 * D-18 sense: the rulebook is already written by the time the anchor exists, and no later step
 * promotes anything. It reuses lvc_ratify's own ledger shape rather than inventing a second
 * ratification convention, which is what the kickoff requires. See the build report.
 */

import {
  MERGE_RECORD_SET, MERGE_READBACK_SQL, RETIRED_STATUS,
  applyRuleMerge, keywordError, categoryError, ratifierError, validateRecords,
  readRuleRows, sameKeywords, recordSetIds,
  type MergedRule, type RuleRecordSet, type SqlRunner, type CurrentRuleRow, type MergeResult,
} from './lvc-rule-merge';

export { keywordError, categoryError, ratifierError, MERGE_RECORD_SET };

/** The record sets this one screen can load (D-21). Phase 2 and Phase 3 add entries here and
 *  change nothing else — the page reads whatever this map returns. */
const RECORD_SETS: Record<string, RuleRecordSet> = {
  [MERGE_RECORD_SET.key]: MERGE_RECORD_SET,
};

export function listRecordSets(): Array<{ key: string; title: string; count: number }> {
  return Object.values(RECORD_SETS).map((s) => ({ key: s.key, title: s.title, count: s.records.length }));
}

/** Fail-safe: an unknown key falls back to the Phase 1 set rather than rendering an empty screen. */
export function getRecordSet(key?: string | null): RuleRecordSet {
  const k = String(key ?? '').trim();
  return (k && RECORD_SETS[k]) || MERGE_RECORD_SET;
}

// ── progress (§3.5 "Resumability", §6.13) ──────────────────────────────────────────────────────

export type RuleProgress = 'pending' | 'accepted' | 'partially_applied' | 'rejected' | 'missing';

export interface AbsorbedView {
  id: string;
  /** the variant's VERBATIM statement — this is the evidence that N statements are one idea */
  statement: string | null;
  status: string | null;
  merged_into: string | null;
  /** lifetime findings that carry this rule_ref; null when the count could not be read */
  fires: number | null;
  applied: boolean;
}

export interface LedgerEntry {
  decision: string;
  ratified_by: string;
  rationale: string;
  reason: string | null;
  created_at: string;
  survivor_id: string;
}

export interface RuleView {
  section: string;
  id: string;
  /** the DRAFT values — what the screen shows before any edit */
  draft: MergedRule;
  /** the rule as it stands in the live rulebook right now */
  current: {
    statement: string | null;
    precondition: string | null;
    keywords: string[];
    category: string | null;
    citation_url: string | null;
    status: string | null;
    ratified_by: string | null;
    ratified_at: string | null;
    fires: number | null;
  } | null;
  absorbs: AbsorbedView[];
  progress: RuleProgress;
  /** the most recent ledger decision touching this survivor, if any */
  last_decision: LedgerEntry | null;
}

export interface SurfaceState {
  record_set: { key: string; title: string; blurb: string };
  rules: RuleView[];
  counts: { total: number; accepted: number; partially_applied: number; rejected: number; pending: number; missing: number };
  /** false when the rulebook could not be read — the screen must then refuse to offer an accept */
  rulebook_available: boolean;
  /** false when lifetime finding counts could not be read; the screen shows "—", never a zero */
  fires_available: boolean;
  ledger_available: boolean;
  /** true once migration 0041 has been applied */
  merged_into_present: boolean;
  notes: string[];
}

/** Content equality between the live survivor row and the record — ratifier-independent, because
 *  progress must not depend on WHO is looking at the screen. */
export function survivorContentMatches(cur: CurrentRuleRow | undefined, r: MergedRule): boolean {
  if (!cur) return false;
  return cur.statement === r.statement
    && cur.precondition === r.precondition
    && sameKeywords(cur.keywords, r.keywords)
    && cur.category === r.category
    && cur.citationUrl === r.citation_url;
}

export function absorbedApplied(cur: CurrentRuleRow | undefined, survivorId: string): boolean {
  return !!cur && cur.status === RETIRED_STATUS && cur.mergedInto === survivorId;
}

/**
 * PURE (test 18): the same rulebook rows + the same ledger always give the same progress. Nothing
 * here reads a clock, a session or a cursor.
 *
 * A rule is `accepted` only when the survivor holds the record's content AND every absorbed variant
 * is retired pointing at it. Anything in between is `partially_applied` and says so — §6.10 is
 * explicit that a half-applied merge must never render as accepted.
 */
export function deriveProgress(
  record: MergedRule,
  rows: Map<string, CurrentRuleRow>,
  ledger: LedgerEntry[],
): RuleProgress {
  const cur = rows.get(record.id);
  if (!cur) return 'missing';
  const survivorDone = survivorContentMatches(cur, record);
  const absorbedDone = record.absorbs.map((id) => absorbedApplied(rows.get(id), record.id));
  const allDone = survivorDone && absorbedDone.every(Boolean);
  if (allDone) return 'accepted';
  const anyDone = survivorDone || absorbedDone.some(Boolean);
  if (anyDone) return 'partially_applied';
  const last = ledger.find((l) => l.survivor_id === record.id);
  if (last && last.decision === 'rejected') return 'rejected';
  return 'pending';
}

/** D-20 — what the ledger must carry so a mistake is CORRECTABLE: the values that were there
 *  before this accept overwrote them. Read off the live row, never off the draft. */
export function previousValues(cur: CurrentRuleRow | undefined): {
  statement: string | null; precondition: string | null; keywords: string[]; category: string | null; citation_url: string | null;
} {
  return {
    statement: cur?.statement ?? null,
    precondition: cur?.precondition ?? null,
    keywords: cur?.keywords ?? [],
    category: cur?.category ?? null,
    citation_url: cur?.citationUrl ?? null,
  };
}

/** The self-describing payload stored in the anchor row's `evidence_note`. */
export function ledgerPayload(record: MergedRule, cur: CurrentRuleRow | undefined, recordSetKey: string): string {
  return JSON.stringify({
    kind: 'lvc-rule-merge',
    record_set: recordSetKey,
    section: record.section,
    survivor_id: record.id,
    absorbs: record.absorbs,
    previous: previousValues(cur),
    accepted: {
      statement: record.statement,
      precondition: record.precondition,
      keywords: record.keywords,
      category: record.category,
      citation_url: record.citation_url,
    },
  });
}

// ── INFERRED SQL — reads ───────────────────────────────────────────────────────────────────────

/** Lifetime findings per rule id. Expensive-ish (a jsonb unnest over the audit table) and therefore
 *  fail-safe: an error yields no counts and the screen shows "—", never a misleading 0. */
export const FIRE_COUNTS_SQL = `WITH f AS (
    SELECT jsonb_array_elements(a.findings) AS fi
      FROM opd_note_audits a
     WHERE a.findings IS NOT NULL
  )
  SELECT fi->>'rule_ref' AS rule_ref, count(*)::int AS fires
    FROM f
   WHERE fi->>'rule_ref' = ANY($1)
   GROUP BY 1`;

/** The ledger for these survivors, newest first. Joined through the anchor row's supersedes_id,
 *  which is how a merge ratification is addressable at all (see the flagged deviation above). */
export const LEDGER_READ_SQL = `SELECT r.decision, r.ratified_by, r.rationale, r.reason,
       r.created_at, p.supersedes_id AS survivor_id
  FROM lvc_ratifications r
  JOIN lvc_recommendation_proposals p ON p.id = r.proposal_id
 WHERE p.supersedes_id = ANY($1)
 ORDER BY r.created_at DESC`;

/** Has migration 0041 been applied? Cheap, and it is what tells the screen whether an accept can
 *  complete — without merged_into, a retirement write would fail on every absorbed row. */
export const MERGED_INTO_PRESENT_SQL = `SELECT 1 AS ok
  FROM information_schema.columns
 WHERE table_name = 'lvc_recommendations' AND column_name = 'merged_into'`;

// ── INFERRED SQL — the ledger writes ───────────────────────────────────────────────────────────

/** ⚠️ THE ANCHOR (see the header). `keywords` here is JSONB — the proposals table's type — and is
 *  deliberately NOT the text[] the rulebook uses. Mixing the two is exactly the round-trip fault
 *  PRD §2.1 warns about. `status` is constrained to proposed|ratified|rejected by 0023. */
export const LEDGER_ANCHOR_INSERT_SQL = `INSERT INTO lvc_recommendation_proposals
    (statement, rationale, evidence_note, source, category, keywords, provenance,
     status, proposed_by, supersedes_id, rejected_reason, promoted_id)
  VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
  RETURNING id::text AS id`;

/** The append-only ledger row itself — lvc_ratify's exact INSERT shape, one convention not two. */
export const LEDGER_INSERT_SQL = `INSERT INTO lvc_ratifications
    (proposal_id, decision, ratified_by, rationale, reason, promoted_id)
  VALUES ($1::uuid,$2,$3,$4,$5,$6)
  RETURNING id::text AS id`;

/** Where an accept's writes are declared to have landed. Never a bare 500 (§6.10). */
export type LedgerOutcome = 'written' | 'skipped_unchanged' | 'failed' | 'not_attempted';

export interface AcceptResult {
  ok: boolean;
  section: string;
  survivor_id: string;
  /** exactly which rows landed — the §6.10 requirement */
  merge: MergeResult;
  ledger: LedgerOutcome;
  ledger_detail?: string;
  /** what the screen must now show for this rule */
  progress: RuleProgress;
  error?: string;
}

/**
 * ACCEPT ONE RULE. This is the write (D-18). There is no bulk path and none is exported.
 *
 * ORDER, exactly:
 *   1. validate the ratifier and the edited record — refuses before touching the database;
 *   2. applyRuleMerge for THIS ONE RECORD, which is itself readback-first:
 *        readback(survivor + absorbed) → survivor UPDATE → one UPDATE per absorbed id → readback;
 *   3. if step 2 changed nothing, the ledger is SKIPPED — a second press must be genuinely inert,
 *      and an append-only ledger filling with identical rows is not inert;
 *   4. INSERT the anchor proposal row (the FK the ledger requires);
 *   5. INSERT the lvc_ratifications row carrying the ratifier, the rationale and the survivor's
 *      PREVIOUS statement, precondition, keywords and category (D-20).
 *
 * A failure at 4 or 5 does NOT roll back 2 — there are no transactions. It is reported as
 * `ledger: 'failed'` with ok:false, so the row that landed and the row that did not are both
 * visible. A success never hides a half-applied merge.
 */
export async function acceptRuleMerge(
  run: SqlRunner,
  opts: { record: MergedRule; ratifiedBy: string; rationale: string; recordSetKey?: string; dryRun?: boolean },
): Promise<AcceptResult> {
  const { record } = opts;
  const ratifiedBy = String(opts.ratifiedBy ?? '').trim();
  const rationale = String(opts.rationale ?? '').trim();
  const dryRun = opts.dryRun === true;
  const empty: MergeResult = {
    ok: false, dryRun, ratifiedBy, sections: [record?.section ?? '?'],
    changed: 0, unchanged: 0, missing: 0, verified: false, rows: [],
  };
  const fail = (error: string): AcceptResult => ({
    ok: false, section: record?.section ?? '?', survivor_id: record?.id ?? '',
    merge: { ...empty, error }, ledger: 'not_attempted', progress: 'pending', error,
  });

  // 1) Refuse before any write.
  const whoErr = ratifierError(ratifiedBy);
  if (whoErr) return fail(whoErr);
  if (!rationale) return fail('a rationale is required — the ledger row records why this was accepted');
  const recErrors = validateRecords([record]);
  if (recErrors.length) return fail(`rule rejected, nothing written: ${recErrors.join(' | ').slice(0, 600)}`);

  // Read the PREVIOUS values before the merge overwrites them (D-20). A failure here is fatal on
  // purpose: without the previous values the accept has no recovery path, so it must not proceed.
  let before: Map<string, CurrentRuleRow>;
  try {
    before = readRuleRows(await run(MERGE_READBACK_SQL, [recordSetIds([record])]));
  } catch (e) {
    return fail(`readback failed, nothing written: ${String((e as Error).message).slice(0, 300)}`);
  }
  const cur = before.get(record.id);
  if (!cur) return fail(`survivor ${record.id} does not exist in lvc_recommendations — nothing written`);

  // 2) The rulebook writes.
  const merge = await applyRuleMerge(run, { records: [record], ratifiedBy, dryRun });

  if (dryRun) {
    return { ok: merge.ok, section: record.section, survivor_id: record.id, merge, ledger: 'not_attempted', progress: deriveProgress(record, before, []) };
  }

  // 3) Nothing changed ⇒ this is a repeat press. Inert, and the ledger stays clean.
  if (merge.ok && merge.changed === 0) {
    return { ok: true, section: record.section, survivor_id: record.id, merge, ledger: 'skipped_unchanged', progress: 'accepted' };
  }

  // 4 + 5) The ledger. Attempted even when the merge partially failed, so the attempt is on record.
  let ledger: LedgerOutcome = 'failed';
  let ledgerDetail: string | undefined;
  try {
    const anchor = await run(LEDGER_ANCHOR_INSERT_SQL, [
      record.statement,
      rationale,
      ledgerPayload(record, cur, opts.recordSetKey ?? MERGE_RECORD_SET.key),
      'lvc-ratify-surface',
      record.category,
      JSON.stringify(record.keywords),
      'EHRC-mined',
      'ratified',
      ratifiedBy,
      record.id,
      null,
      record.id,
    ]);
    const anchorId = anchor[0]?.id == null ? null : String(anchor[0].id);
    if (!anchorId) throw new Error('anchor proposal row returned no id');
    await run(LEDGER_INSERT_SQL, [anchorId, 'ratified', ratifiedBy, rationale, null, record.id]);
    ledger = 'written';
  } catch (e) {
    ledgerDetail = String((e as Error).message).slice(0, 300);
  }

  // What the screen must show now — recomputed from the post-write readback the merge already did.
  const after = new Map<string, CurrentRuleRow>();
  for (const row of merge.rows) {
    const src = row.action === 'survivor'
      ? { statement: record.statement, precondition: record.precondition, keywords: record.keywords, category: record.category, citationUrl: record.citation_url, status: cur.status, mergedInto: null }
      : { statement: null, precondition: null, keywords: [], category: null, citationUrl: null, status: RETIRED_STATUS, mergedInto: record.id };
    if (row.verified) after.set(row.id, { id: row.id, ratifiedBy, ratifiedAt: null, ...src });
    else { const prev = before.get(row.id); if (prev) after.set(row.id, prev); }
  }
  const progress = deriveProgress(record, after, []);

  const ok = merge.ok && ledger === 'written';
  return {
    ok, section: record.section, survivor_id: record.id, merge, ledger,
    ...(ledgerDetail ? { ledger_detail: ledgerDetail } : {}),
    progress,
    ...(ok ? {} : {
      error: merge.ok
        ? `the rulebook writes landed but the ledger row did not (${ledgerDetail ?? 'unknown'}) — the merge is applied and UNRECORDED; re-press accept to append the ledger row`
        : (merge.error ?? 'the merge did not complete; see merge.rows for exactly which rows landed'),
    }),
  };
}

export interface RejectResult {
  ok: boolean;
  section: string;
  survivor_id: string;
  ledger: LedgerOutcome;
  error?: string;
}

/**
 * REJECT ONE RULE. Writes NOTHING to `lvc_recommendations` — the cluster stays exactly as it is —
 * and appends a rejection to the ledger with a required reason (§3.5). Rejection is first-class,
 * the same way lvc_ratify treats it: it is evidence about the rulebook, never a delete.
 */
export async function rejectRule(
  run: SqlRunner,
  opts: { record: MergedRule; ratifiedBy: string; rationale: string; reason: string; recordSetKey?: string },
): Promise<RejectResult> {
  const { record } = opts;
  const ratifiedBy = String(opts.ratifiedBy ?? '').trim();
  const rationale = String(opts.rationale ?? '').trim();
  const reason = String(opts.reason ?? '').trim();
  const fail = (error: string): RejectResult => ({ ok: false, section: record?.section ?? '?', survivor_id: record?.id ?? '', ledger: 'not_attempted', error });

  const whoErr = ratifierError(ratifiedBy);
  if (whoErr) return fail(whoErr);
  if (!reason) return fail('a reason is required when a rule is rejected');

  // Best-effort read of the current row so the ledger records what was left standing. A failure
  // here is NOT fatal: a rejection writes no rulebook row, so there is nothing to recover.
  let cur: CurrentRuleRow | undefined;
  try { cur = readRuleRows(await run(MERGE_READBACK_SQL, [[record.id]])).get(record.id); } catch { cur = undefined; }

  try {
    const anchor = await run(LEDGER_ANCHOR_INSERT_SQL, [
      record.statement,
      rationale || reason,
      ledgerPayload(record, cur, opts.recordSetKey ?? MERGE_RECORD_SET.key),
      'lvc-ratify-surface',
      record.category,
      JSON.stringify(record.keywords),
      'EHRC-mined',
      'rejected',
      ratifiedBy,
      record.id,
      reason,
      null,
    ]);
    const anchorId = anchor[0]?.id == null ? null : String(anchor[0].id);
    if (!anchorId) throw new Error('anchor proposal row returned no id');
    await run(LEDGER_INSERT_SQL, [anchorId, 'rejected', ratifiedBy, rationale || reason, reason, null]);
    return { ok: true, section: record.section, survivor_id: record.id, ledger: 'written' };
  } catch (e) {
    return { ...fail(`rejection not recorded: ${String((e as Error).message).slice(0, 300)}`), ledger: 'failed' };
  }
}

// ── assembling what the screen renders ─────────────────────────────────────────────────────────

/**
 * PURE. Given the rulebook rows, the fire counts and the ledger, produce the whole screen state.
 * Separated from the reads so that progress derivation is testable without a database and so the
 * fail-safe behaviour lives in exactly one place — the loader below.
 */
export function assembleSurfaceState(
  set: RuleRecordSet,
  rows: Map<string, CurrentRuleRow>,
  fires: Map<string, number>,
  ledger: LedgerEntry[],
  flags: { rulebookAvailable: boolean; firesAvailable: boolean; ledgerAvailable: boolean; mergedIntoPresent: boolean },
): SurfaceState {
  const rules: RuleView[] = set.records.map((record) => {
    const cur = rows.get(record.id);
    const progress = flags.rulebookAvailable ? deriveProgress(record, rows, ledger) : 'pending';
    return {
      section: record.section,
      id: record.id,
      draft: record,
      current: cur
        ? {
            statement: cur.statement, precondition: cur.precondition, keywords: cur.keywords,
            category: cur.category, citation_url: cur.citationUrl, status: cur.status,
            ratified_by: cur.ratifiedBy, ratified_at: cur.ratifiedAt,
            fires: flags.firesAvailable ? (fires.get(record.id) ?? 0) : null,
          }
        : null,
      absorbs: record.absorbs.map((id) => {
        const a = rows.get(id);
        return {
          id,
          statement: a?.statement ?? null,
          status: a?.status ?? null,
          merged_into: a?.mergedInto ?? null,
          fires: flags.firesAvailable ? (fires.get(id) ?? 0) : null,
          applied: absorbedApplied(a, record.id),
        };
      }),
      progress,
      last_decision: ledger.find((l) => l.survivor_id === record.id) ?? null,
    };
  });

  const tally = (p: RuleProgress) => rules.filter((r) => r.progress === p).length;
  const notes: string[] = [];
  if (!flags.rulebookAvailable) notes.push('The rulebook could not be read. Progress is not derivable and accepting is disabled until it can be.');
  if (!flags.mergedIntoPresent) notes.push('Migration 0041 has not been applied: lvc_recommendations.merged_into is absent, so retiring an absorbed variant would fail. Run POST /api/admin/migrate-lvc-merge first.');
  if (!flags.firesAvailable) notes.push('Lifetime finding counts are unavailable, shown as "—". This does not affect the accept.');
  if (!flags.ledgerAvailable) notes.push('The ratification ledger could not be read, so a previously rejected rule shows as pending.');

  return {
    record_set: { key: set.key, title: set.title, blurb: set.blurb },
    rules,
    counts: {
      total: rules.length,
      accepted: tally('accepted'),
      partially_applied: tally('partially_applied'),
      rejected: tally('rejected'),
      pending: tally('pending'),
      missing: tally('missing'),
    },
    rulebook_available: flags.rulebookAvailable,
    fires_available: flags.firesAvailable,
    ledger_available: flags.ledgerAvailable,
    merged_into_present: flags.mergedIntoPresent,
    notes,
  };
}

/**
 * Read everything the screen needs. EVERY read degrades independently: an unreadable ledger or an
 * unreadable fire count leaves the rest of the screen working and says so in `notes`. Only the
 * rulebook read is load-bearing, and even that returns a rendered screen with accepting disabled
 * rather than a 500 (§6.1's discipline, applied to the surface).
 */
export async function loadSurfaceState(run: SqlRunner, key?: string | null): Promise<SurfaceState> {
  const set = getRecordSet(key);
  const ids = recordSetIds(set.records);

  let rows = new Map<string, CurrentRuleRow>();
  let rulebookAvailable = true;
  try { rows = readRuleRows(await run(MERGE_READBACK_SQL, [ids])); }
  catch { rulebookAvailable = false; }

  // Before 0041 is applied the readback naming merged_into fails whole, which would report the
  // rulebook as unreadable. Retry without that column so the screen still renders and can TELL the
  // reviewer to run the migration — the far more useful failure.
  let mergedIntoPresent = true;
  if (!rulebookAvailable) {
    mergedIntoPresent = false;
    try {
      rows = readRuleRows(await run(MERGE_READBACK_SQL.replace('merged_into,', 'NULL AS merged_into,'), [ids]));
      rulebookAvailable = true;
    } catch { /* genuinely unreadable */ }
  } else {
    try { mergedIntoPresent = (await run(MERGED_INTO_PRESENT_SQL, [])).length > 0; } catch { mergedIntoPresent = true; }
  }

  let fires = new Map<string, number>();
  let firesAvailable = true;
  try {
    for (const r of await run(FIRE_COUNTS_SQL, [ids])) {
      const id = String(r.rule_ref ?? '');
      if (id) fires.set(id, Number(r.fires ?? 0));
    }
  } catch { firesAvailable = false; fires = new Map(); }

  let ledger: LedgerEntry[] = [];
  let ledgerAvailable = true;
  try {
    ledger = (await run(LEDGER_READ_SQL, [set.records.map((r) => r.id)])).map((r) => ({
      decision: String(r.decision ?? ''),
      ratified_by: String(r.ratified_by ?? ''),
      rationale: String(r.rationale ?? ''),
      reason: r.reason == null ? null : String(r.reason),
      created_at: String(r.created_at ?? ''),
      survivor_id: String(r.survivor_id ?? ''),
    }));
  } catch { ledgerAvailable = false; ledger = []; }

  return assembleSurfaceState(set, rows, fires, ledger, { rulebookAvailable, firesAvailable, ledgerAvailable, mergedIntoPresent });
}
