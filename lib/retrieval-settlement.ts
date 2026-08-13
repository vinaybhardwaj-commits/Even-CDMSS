/**
 * lib/retrieval-settlement.ts — linking telemetry to what the audit persistence actually did.
 * On-path kickoff D9, D12. PRD v2.1 §4.5 steps 4 and 5.
 *
 * ⚠️ PER-RUN ISOLATION IS THE WHOLE POINT. If primary settles and normative fails, this returns one
 * `settled` and one `failed`, writes a `persistence_link` failure row for the failed run, and DOES
 * NOT THROW. `telemetry_link_failed` is deliberately not a settlement outcome: a telemetry problem
 * on one role must not restate the other role's real, known outcome as unknown.
 */

import {
  stateForSettlement, isAllowedTransition, reconcilerStateFor,
  type SettlementOutcome, type RetrievalPersistenceState,
} from './retrieval-telemetry-core';
import {
  applyTerminalState,
  type LifecycleHandle, type LifecycleRun, type PerRunSettlementResult,
} from './retrieval-telemetry-store';
import { failurePhasesForRun } from './retrieval-telemetry-failure-store';

export interface SettlementInput {
  outcome: SettlementOutcome;
  /** Linked ONLY after the actual persistence result is known (§4.5 step 4). Null is a real state:
   *  a losing race, a failed save, or a retrieval that never produced an audit row. §4.2 forbids
   *  creating a synthetic audit row to populate it. */
  auditId: string | null;
  settledAt: string;
}

/**
 * Settle every declared run of one handle.
 *
 * ⚠️ EXACTLY ONCE, AND ASSERTED DIRECTLY. The revision guard makes a second call a no-op, but a
 * no-op is not the same as never having been called: a double settlement means two owners believe
 * they own the same run, which is a wiring bug that an idempotent write would hide. The caller's
 * test asserts the call count, not just the final state.
 */
export async function settleRetrievalTelemetry(
  handle: LifecycleHandle,
  input: SettlementInput,
): Promise<PerRunSettlementResult[]> {
  const outcomeState: RetrievalPersistenceState = stateForSettlement(input.outcome);
  const results: PerRunSettlementResult[] = [];
  let current = handle;

  for (const run of handle.runs) {
    // ⚠️ A ROLE STILL AT REVISION 0 IS NOT LINKED. Revision 0 means its terminal write never
    // landed, so there is no manifest to attach an audit to; linking it would claim this run
    // produced the evidence the audit was built from, which it demonstrably did not.
    const linkable = run.expectedRevision > 0;
    const state = linkable ? outcomeState : await stateForUnwrittenRun(run, outcomeState);
    const r = await applyTerminalState(current, run, {
      state, auditId: linkable ? input.auditId : null, settledAt: input.settledAt,
    });
    current = r.handle;
    results.push(
      r.status === 'failed'
        ? { role: run.role, runId: run.runId, status: 'failed', errorClass: r.errorClass }
        : r.status === 'rejected'
          // ⚠️ NOT `settled`. The five rejection classes each mean the row is NOT in the state this
          // caller asked for, and every one of them used to be reported as success — which is how
          // a permanently `started` row and a completed audit could both be true at once.
          ? { role: run.role, runId: run.runId, status: 'rejected', rejection: r.rejection }
          // `noop` IS settled: identical content already landed, and a retry of a write that
          // succeeded is not a second event.
          : { role: run.role, runId: run.runId, status: 'settled' },
    );
  }
  return results;
}

/**
 * The state for a run that never wrote its terminal manifest — D9's "settled from the failure
 * evidence", which the previous version of this module did not do.
 *
 * Two cases, and they are genuinely different:
 *
 *   · THE OUTCOME IS ONE A RUN THAT NEVER RETRIEVED CAN HONESTLY CARRY. `retrieval_not_run` and
 *     `audit_generation_failed` are both legal from `started` (D12 keeps the second deliberately,
 *     because `auditOpdNote` can throw at steps 7, 8 or 9). The owner's own outcome is the truth
 *     and is applied unchanged — this is the D9 owner matrix's "throw before adoption" and "throw
 *     after adoption" rows, and nothing about them is unknown.
 *
 *   · THE OUTCOME IMPLIES A RETRIEVAL THAT COMPLETED. `persisted_complete` and its siblings are
 *     legal only from `retrieval_complete`. A revision-0 row is not there, so the outcome cannot be
 *     applied and D12's transition guard rejects it — which is precisely what left these rows
 *     `started` while the caller was told they had settled. The failure evidence decides instead,
 *     by exactly the mapping D13 gives the reconciler: `retrieval_terminal` evidence means the
 *     write was attempted and failed (`telemetry_persistence_failed`); no evidence means nothing
 *     was ever heard from it (`aborted`).
 *
 * ⚠️ DECIDED, AND D9 IS AMENDED TO SAY IT (addendum v1 item 2, 13 Aug 2026; decisions §2). D9 used
 * to read that `aborted`, `persistence_unknown` and `telemetry_persistence_failed` were reachable
 * only by the reconciler, while the same section required a revision-0 run to be "settled from the
 * failure evidence" — and that evidence has exactly one mapping, which produces two of the three.
 * The amended rule is that the three states are produced only through `reconcilerStateFor`, wherever
 * it is called; settlement may call it for a revision-0 run; and the settlement mapping table itself
 * never names them. That is the same rule, not a new one, and the call below is it.
 *
 * The code was not changed to obey the older literal reading. `RECONCILER_STALE_AFTER_SECONDS` is
 * `WORKER_MAX_DURATION_SECONDS + 1800`, so waiting for the reconciler would leave a row whose fate
 * is already known sitting non-terminal for about 43 minutes before it received the identical value
 * from the identical mapping.
 */
async function stateForUnwrittenRun(
  run: LifecycleRun,
  outcomeState: RetrievalPersistenceState,
): Promise<RetrievalPersistenceState> {
  if (isAllowedTransition('started', outcomeState)) return outcomeState;
  return reconcilerStateFor('started', await failurePhasesForRun(run.runId));
}

/**
 * THE OWNER'S ONE LINE (D9). Every path in the owner matrix ends in a call to this.
 *
 * ⚠️ NEVER THROWS, AND NEVER RETURNS A REASON TO STOP. Constraint 1: an audit is never failed
 * because its telemetry could not be settled. The per-run results are still available to a caller
 * that wants them — `settleRetrievalTelemetry` is exported — but no owner in D9's matrix branches
 * on them, and one that did would be making a clinical write depend on a telemetry write.
 *
 * A null handle, or a handle with no runs, settles nothing: that is the uninstrumented path, which
 * is most callers, and it must cost nothing at all.
 */
export async function settleOwned(
  handle: LifecycleHandle | null | undefined,
  outcome: SettlementOutcome,
  auditId: string | null = null,
): Promise<void> {
  if (!handle || handle.runs.length === 0) return;
  try {
    await settleRetrievalTelemetry(handle, { outcome, auditId, settledAt: new Date().toISOString() });
  } catch (e) {
    // settleRetrievalTelemetry isolates each run and does not throw; this is the belt for a
    // programming error inside it, not for a database fault, which is already handled below it.
    console.warn('[retrieval-telemetry] settlement threw, which it is not supposed to:', (e as Error).message);
  }
}

/**
 * The save result AND the manifest verdict together, because D17 needs both.
 *
 * `persisted_complete` requires `validateManifest` to have returned `[]`. A save that landed with a
 * dirty manifest is `persisted_partial` — the audit is real, and the record of how it was built is
 * incomplete. Only the clean branch can be upgraded: a losing race or a skip is not made partial by
 * a manifest defect, because neither of them persisted anything to be partial about.
 */
export function outcomeForOwnedSave(
  result: 'inserted' | 'updated' | 'exists' | 'skipped',
  manifestDefects: readonly string[] = [],
): SettlementOutcome {
  const base = outcomeForSaveResult(result);
  return base === 'persisted_clean' && manifestDefects.length > 0 ? 'persisted_dirty' : base;
}

/**
 * What `saveOpdAudit` returned, mapped to a settlement outcome (D9).
 *
 * ⚠️ ALL FOUR RETURN VALUES ARE COVERED, INCLUDING `skipped`. It is reachable — it is the no-uid
 * branch — and it means the audit was never keyed, which is a decision and not a failure. Mapping
 * it to anything else would report a deliberate skip as a lost write.
 */
export function outcomeForSaveResult(result: 'inserted' | 'updated' | 'exists' | 'skipped'): SettlementOutcome {
  switch (result) {
    case 'inserted':
    case 'updated':
      // The caller upgrades this to `persisted_dirty` when validateManifest returned anything.
      return 'persisted_clean';
    case 'exists':
      // ⚠️ A LOSING ON CONFLICT RACE IS NOT A FAILURE. D9 sends it to `completed_unpersisted`,
      // which is why the committed comment on `audit_persistence_failed` — "the audit write failed
      // or lost its ON CONFLICT race" — became false and was corrected.
      return 'losing_conflict';
    case 'skipped':
      return 'persistence_skipped';
  }
}
