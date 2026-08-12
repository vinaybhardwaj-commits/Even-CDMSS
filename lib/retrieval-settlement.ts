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
  stateForSettlement,
  type SettlementOutcome, type RetrievalPersistenceState,
} from './retrieval-telemetry-core';
import {
  applyTerminalState,
  type LifecycleHandle, type PerRunSettlementResult,
} from './retrieval-telemetry-store';

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
  const state: RetrievalPersistenceState = stateForSettlement(input.outcome);
  const results: PerRunSettlementResult[] = [];
  let current = handle;

  for (const run of handle.runs) {
    // ⚠️ A ROLE STILL AT REVISION 0 IS NOT LINKED. Revision 0 means its terminal write never
    // landed, so there is no manifest to attach an audit to; linking it would claim this run
    // produced the evidence the audit was built from, which it demonstrably did not. It is settled
    // from the failure evidence instead — with a null audit id.
    const linkable = run.expectedRevision > 0;
    const r = await applyTerminalState(current, run, {
      state, auditId: linkable ? input.auditId : null, settledAt: input.settledAt,
    });
    current = r.handle;
    results.push(
      r.status === 'failed'
        ? { role: run.role, runId: run.runId, status: 'failed', errorClass: r.errorClass }
        // `noop` and `rejected` are both "this run is already where it should be, or somewhere
        // newer" — neither is a telemetry failure, and neither is reported as one.
        : { role: run.role, runId: run.runId, status: 'settled' },
    );
  }
  return results;
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
