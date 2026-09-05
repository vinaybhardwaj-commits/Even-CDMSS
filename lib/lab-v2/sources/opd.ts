/**
 * lib/lab-v2/sources/opd.ts — the ONE production read a dataset freeze performs
 * (LAB-MCP-V2-PRD-v1.0 §8.1, §13).
 *
 * ⚠️ THIS FILE RUNS OUTSIDE ANY LAB EXECUTION CONTEXT, BY CONSTRUCTION. `dataset_create`
 * calls it before it ever enters `withLabExecution`, which is the only reason it can
 * touch `sql` and `metabaseQuery` at all — inside a context both throw LAB_IO_FORBIDDEN
 * (§7). If a future edit moves a call to `freezeOpdCase` inside a context, it will not
 * silently read the wrong thing: it will throw, loudly, which is the intent.
 *
 * FAIL-SAFE IS THE WHOLE POINT (kickoff, SQL/SCHEMA HONESTY (a)). Every path here
 * degrades to a typed CASE_NOT_FOUND or SOURCE_UNAVAILABLE. It never returns a partially
 * frozen case, because a dataset that silently froze `specialty: null` when the directory
 * was merely unreachable would produce a research result that differs from production for
 * a reason nobody could later reconstruct. Missing is fine; WRONG is not.
 *
 * PROVENANCE OF EVERY QUERY (reported verbatim to the orchestrator):
 *  · The note itself and the complexity bundle are read through the EXISTING, live,
 *    production-validated exports of lib/metabase.ts (`fetchOpdNoteByUid`,
 *    `fetchPatientHistoryBundle`). No new db13 SQL was written or guessed: the nightly
 *    OPD worker runs these same two functions against db13 today.
 *  · The production-Neon inputs (the LVC rule snapshot, the doctor's specialty, the active
 *    suppressions and the quieting config) are read by CALLING THE EXISTING READERS —
 *    `getLvcRules` and `doctorSpecialtyFor` exported from lib/opd-note-audit.ts, and
 *    `loadActiveSuppressions` / `loadQuietingConfig` already exported from
 *    lib/audit-suppression-store.ts. This file therefore writes NO SQL AT ALL. That is deliberate twice over: the frozen value is by construction the
 *    value the audit would have read, and the repository's single inventory of
 *    lvc_recommendations SQL (lib/__tests__/rule-governance-dormancy.test.ts, proof 3)
 *    stays a true inventory instead of gaining a second copy of the same query.
 */
import { loadActiveSuppressions, loadQuietingConfig } from '../../audit-suppression-store';
import { fetchOpdNoteByUid, fetchPatientHistoryBundle } from '../../metabase';
import { doctorSpecialtyFor, getLvcRules } from '../../opd-note-audit';
import { rowToOpdCase } from '../../opd-ingest-core';
import { bandFor } from '../../opd-complexity-core';
import { LabError, hash, type OpdFrozen } from '../contracts';

export interface FrozenCase {
  case_key: string;
  member_key: string | null;
  frozen: OpdFrozen;
  source_versions: Record<string, unknown>;
}

/**
 * Freeze one OPD note and the three inputs the engine would otherwise read live.
 *
 * @throws LabError CASE_NOT_FOUND     — db13 answered, and there is no such note.
 * @throws LabError SOURCE_UNAVAILABLE — a source could not be reached or read.
 */
export async function freezeOpdCase(caseKey: string): Promise<FrozenCase> {
  // ── 1. the note (db13, via the existing Metabase reader) ───────────────────────────
  let row: Record<string, unknown> | null;
  try {
    row = await fetchOpdNoteByUid(caseKey);
  } catch (e) {
    // Unreachable is NOT the same as absent: reporting "no such note" for a Metabase
    // outage would let a caller freeze an empty dataset and believe the note is gone.
    throw new LabError('SOURCE_UNAVAILABLE', `db13 unavailable while reading note ${caseKey}: ${(e as Error).message}`);
  }
  if (!row) throw new LabError('CASE_NOT_FOUND', `no OPD note with uid ${caseKey}`);

  const { keys } = rowToOpdCase(row);

  // ── 2. the doctor's specialty (production Neon `doctor_directory`) ─────────────────
  // A null specialty is a LEGITIMATE frozen value — most doctors in the directory have
  // none — so the engine's own fail-safe (null on any error) is the right semantic here
  // and is inherited rather than second-guessed.
  let specialty: string | null = null;
  try {
    specialty = await doctorSpecialtyFor(keys.doctorUid);
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `doctor_directory unavailable: ${(e as Error).message}`);
  }

  // ── 3. the LVC rule snapshot (production Neon `lvc_recommendations`) ───────────────
  let lvcRules: OpdFrozen['lvc_rules'];
  try {
    const rules = await getLvcRules();
    lvcRules = rules.map((r) => {
      const keywords = (r.keywords ?? []).map((k) => String(k));
      const category = r.category ?? null;
      // The per-rule hash is over the rule's MEANING (id + keywords + category), so
      // dataset_validate can report a rule that was EDITED IN PLACE, not merely one that
      // was added or removed.
      return { id: r.id, hash: hash({ id: r.id, keywords, category }), keywords, category };
    });
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `lvc_recommendations unavailable: ${(e as Error).message}`);
  }
  // getLvcRules' own fail-safe returns [] on a timeout or an error, which is right for the
  // audit (never block a note) and WRONG for a freeze: an empty snapshot recorded as fact
  // would silently produce a research result scored against no rules at all. Production
  // never has zero active rules, so an empty read here is treated as unavailability.
  if (lvcRules.length === 0) {
    throw new LabError('SOURCE_UNAVAILABLE', 'lvc_recommendations returned no active rules — refusing to freeze an empty rule snapshot');
  }

  // ── 4. case-mix complexity (db13, via the existing bundle reader) ──────────────────
  // The engine's own complexityFor() swallows every error into a null band. Here that
  // would be wrong: a null band frozen because db13 blinked is a DIFFERENT input from a
  // null band because the patient has no history, and the two must not be confusable in
  // a dataset that claims to be reproducible.
  let complexity: OpdFrozen['complexity'];
  try {
    const inputs = await fetchPatientHistoryBundle(caseKey, keys.noteDate ? String(keys.noteDate) : undefined);
    complexity = inputs
      ? { band: bandFor(inputs), inputs: inputs as unknown as Record<string, unknown> }
      : { band: null, inputs: null };
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `db13 patient-history bundle unavailable for ${caseKey}: ${(e as Error).message}`);
  }

  // ── 5. the active suppressions and the quieting config (production Neon) ──────────
  // Decision 18: an error here is SOURCE_UNAVAILABLE, NEVER a frozen default. The engine's
  // own getActiveSuppressions/getQuietingConfig swallow errors into [] and gen 0, which is
  // right for an audit that must never be blocked and wrong for a freeze — a dataset that
  // recorded "no suppressions" because the table blinked would produce a research result
  // scored against rules production was actually applying. So the RAW loaders are called
  // here (they propagate), not the engine's fail-safe wrappers.
  let suppressions: OpdFrozen['suppressions'];
  let quietingConfig: OpdFrozen['quieting_config'];
  try {
    suppressions = (await loadActiveSuppressions()) as unknown as OpdFrozen['suppressions'];
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `audit_suppression unavailable: ${(e as Error).message}`);
  }
  try {
    quietingConfig = (await loadQuietingConfig()) as unknown as OpdFrozen['quieting_config'];
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `quieting config unavailable: ${(e as Error).message}`);
  }
  // Unlike the LVC rule set, an EMPTY suppressions list is a legitimate production state
  // (nothing has been suppressed yet), and gen 0 is a legitimate quieting generation. Only
  // an error is unavailability here, which is why neither gets the emptiness check above.

  return {
    case_key: caseKey,
    // Member grouping is a Slice B concern (cohorts, member-grouped splits). A single-case
    // Slice A dataset has exactly one member, so there is nothing to group by yet.
    member_key: null,
    frozen: { note: row, specialty, complexity, lvc_rules: lvcRules, suppressions, quieting_config: quietingConfig },
    source_versions: {
      db13: 'metabase:individuals-prescriptions',
      lvc_rules_count: lvcRules.length,
      lvc_rules_hash: hash(lvcRules.map((r) => r.hash).sort()),
      suppressions_count: suppressions.length,
      quieting_gen: quietingConfig.gen,
      frozen_at: new Date().toISOString(),
    },
  };
}

/**
 * §8.1 `dataset_validate` — re-read the case now and report whether each frozen input
 * still matches. Never throws for a mismatch; a mismatch is the ANSWER, not an error.
 */
export async function validateFrozenCase(caseKey: string, frozen: OpdFrozen): Promise<{ field: string; matches: boolean }[]> {
  const checks: { field: string; matches: boolean }[] = [];
  let current: FrozenCase | null = null;
  try {
    current = await freezeOpdCase(caseKey);
  } catch {
    return [{ field: 'source', matches: false }];
  }
  checks.push({ field: 'note', matches: hash(current.frozen.note) === hash(frozen.note) });
  checks.push({ field: 'specialty', matches: current.frozen.specialty === frozen.specialty });
  checks.push({ field: 'complexity', matches: hash(current.frozen.complexity) === hash(frozen.complexity) });
  checks.push({
    field: 'lvc_rules',
    matches: hash(current.frozen.lvc_rules.map((r) => r.hash).sort()) === hash(frozen.lvc_rules.map((r) => r.hash).sort()),
  });
  checks.push({ field: 'suppressions', matches: hash(current.frozen.suppressions) === hash(frozen.suppressions) });
  checks.push({ field: 'quieting_config', matches: hash(current.frozen.quieting_config) === hash(frozen.quieting_config) });
  return checks;
}
