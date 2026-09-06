/**
 * lib/lab-v2/releases/rollback.ts — `release_rollback` (§11, decisions 80 and 80a).
 *
 * ⚠️ A ROLLBACK IS A NEW ACTIVATION, NOT AN UNDO. §11 says so and the receipt says so on every
 * row: it returns the named chunks to quarantine and records the predecessor as the artifact in
 * force. It does NOT delete audits written while the release was live, does not rewrite a finding,
 * and does not revoke a human action taken on one. Anything produced under the rolled-back artifact
 * stands and carries its own engine version. A rollback that implied otherwise would be the most
 * dangerous receipt in this platform.
 *
 * ⚠️ IT FLIPS EXACTLY THE RECORDED SET — decision 80. Not the label, and not "everything under
 * `lab:<label>`": the ids come off the APPLY RECEIPT's `activated_chunk_ids`, which is what the
 * activation's own `RETURNING` produced. That matters most in the case nobody plans for: if the
 * apply drifted, the receipt recorded what actually moved, and the rollback undoes THAT rather than
 * what someone intended to move.
 *
 * ⚠️ AND IT USES THE ONE v2 WRITE. v1 has no deactivate — `corpusDelete` is a DELETE — so decision
 * 80a puts the inverse in `releases/corpus-writer.ts` as a single id-keyed UPDATE. This file calls
 * it and does no SQL of its own.
 */
import { LabError, ROLLBACK_CAVEAT } from '../contracts';
import {
  advanceTarget, getObject, getReceipt, getTarget, putReceipt, recordEvent,
} from '../store';
import { deactivateIds, type CorpusWriterDeps } from './corpus-writer';
import { receiptOut, type ReleaseArtifact } from './apply';
import type { Db } from '../db';

export interface RollbackDeps extends CorpusWriterDeps { now?: () => number }

export async function releaseRollback(
  db: Db, principal: string, args: { release_id: string }, deps: RollbackDeps = {},
) {
  const now = deps.now ?? Date.now;
  const release = await getObject(db, args.release_id);
  if (!release || release.kind !== 'release') throw new LabError('NOT_FOUND', `no release ${args.release_id}`);
  const artifact = (release.body ?? {}) as ReleaseArtifact;
  const target = String(artifact.target ?? '');
  const label = String(artifact.label ?? '');

  // Idempotent on (release_id, 'rollback'), exactly as apply is on (release_id, 'apply').
  const already = await getReceipt(db, release.id, 'rollback');
  if (already) return { ...receiptOut(already), replayed_receipt: true, caveat: ROLLBACK_CAVEAT };

  const applied = await getReceipt(db, release.id, 'apply');
  if (!applied) {
    throw new LabError('INVALID_INPUT', `release ${release.id} was never applied; there is nothing to roll back`);
  }
  const appliedBody = (applied.body ?? {}) as { activated_chunk_ids?: number[]; outcome?: string; predecessor_id?: string | null };
  const ids = (appliedBody.activated_chunk_ids ?? []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) {
    throw new LabError('INVALID_INPUT',
      `the apply receipt for ${release.id} records no activated chunk ids (outcome '${appliedBody.outcome ?? 'unknown'}'); there is nothing this rollback could flip`);
  }

  const t = await getTarget(db, target);
  if (!t) throw new LabError('STORE_UNAVAILABLE', `target '${target}' is missing; apply 0002_releases.sql`);
  // ⚠️ The compare-and-swap is against what is in force NOW, not against the release's own
  // expected revision: a rollback is a new activation and must lose the same race any other
  // release would lose. If something landed after this release, its revision is what is current
  // and this rollback advances from there.
  const revision = await advanceTarget(db, target, t.revision, {
    artifact_id: appliedBody.predecessor_id ?? artifact.predecessor_id ?? null,
    predecessor_id: release.id,
    release_id: release.id,
  });
  if (revision == null) {
    throw new LabError('REVISION_MISMATCH', `target '${target}' moved while this rollback was being prepared; read release_status and try again`);
  }

  const out = await deactivateIds(label, ids, deps);
  const flipped = out.ids.slice().sort((a, b) => a - b);
  const missed = ids.filter((id) => !flipped.includes(id));

  const body = {
    kind: 'rollback',
    // A partial flip is reported as itself. Retrying blindly on a half-rolled-back release is how
    // a second unexplained state gets created.
    outcome: missed.length ? 'partial' : 'rolled_back',
    release_id: release.id,
    of_receipt: applied.id,
    target,
    label,
    revision,
    previous_revision: t.revision,
    // Named, not restated — see the note in apply.ts.
    writer: 'lib/lab-v2/releases/corpus-writer.ts deactivateIds (decision 80a)',
    recorded_chunk_ids: ids,
    rolled_back_chunk_ids: flipped,
    not_flipped: missed,
    quarantined_source: out.source,
    artifact_now_in_force: appliedBody.predecessor_id ?? artifact.predecessor_id ?? null,
    rolled_back_at: new Date(now()).toISOString(),
    // §11, verbatim, on every rollback receipt.
    caveat: ROLLBACK_CAVEAT,
  };
  const receipt = await putReceipt(db, { release_id: release.id, target, revision, kind: 'rollback', body });
  await recordEvent(db, principal, release.id, 'release_rolled_back', {
    release_id: release.id, target, revision, chunks: flipped.length, not_flipped: missed.length,
  }).catch(() => {});

  return { ...receiptOut(receipt), replayed_receipt: false, caveat: ROLLBACK_CAVEAT };
}
