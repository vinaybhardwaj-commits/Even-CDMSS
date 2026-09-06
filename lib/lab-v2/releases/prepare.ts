/**
 * lib/lab-v2/releases/prepare.ts — `release_prepare` (LAB-MCP-V2-PRD-v1.0 §11, §17.7).
 *
 * ⚠️ WHAT PREPARE PRODUCES IS AN IMMUTABLE, HASHED OBJECT, and everything downstream depends on
 * that. The artifact is written to `lab_v2.objects` (kind `release`), which is content-addressed
 * and never updated. A review binds to its HASH; if anyone changes anything about the release
 * afterwards they get a different hash and a different object, and `release_apply` refuses the old
 * approval with `APPROVAL_HASH_MISMATCH`. Storing the artifact in a mutable ledger row instead
 * would make decision 81 unenforceable — the bytes could move under an approval that still pointed
 * at them.
 *
 * ⚠️ IT RECORDS THE EXPECTED REVISION, NOT THE CURRENT ONE. `expected_revision` is what the
 * preparer SAW. `release_apply`'s compare-and-swap demands the target still be there. Two releases
 * prepared against revision 4 cannot both land: the second is told `REVISION_MISMATCH` and has to
 * be re-prepared against what is actually in force, which is the only honest thing to do — its
 * diff was computed against a corpus that no longer exists.
 *
 * ⚠️ AND IT RECORDS THE PREDECESSOR STATE BY ID. Decision 80: a release records the exact set it
 * changed, and rollback flips exactly that set. `predecessor_state` is the `(id, source, visible)`
 * of every staged chunk at prepare time — what they must return to — and `predecessor_visible_hash`
 * is its hash, so drift between prepare and apply is one comparison rather than a walk.
 */
import { LabError, RELEASE_TARGETS, hash, type ReleaseTarget } from '../contracts';
import { getObject, getTarget, putObject } from '../store';
import { CHUNK_STATE_SQL, readStagedIds } from '../tools/corpus';
import { boundedRead } from '../sources/read';
import type { Db } from '../db';

export interface PrepareDeps {
  read?: <T>(source: string, statement: string, params?: unknown[]) => Promise<T[]>;
  stagedIds?: (label: string) => Promise<number[]>;
}

const liveRead = <T>(source: string, statement: string, params: unknown[] = []) => boundedRead<T>(source, statement, params, 500);

export interface ChunkState { id: number; source: string | null; visible: boolean }

export async function releasePrepare(
  db: Db, principal: string,
  args: { target: string; staged_set_id: string; impact_ref?: string; notes?: string; idempotency_key: string },
  deps: PrepareDeps = {},
) {
  const target = String(args.target) as ReleaseTarget;
  if (!(RELEASE_TARGETS as readonly string[]).includes(target)) {
    throw new LabError('INVALID_INPUT', `'${target}' is not a release target; decision 77 names ${RELEASE_TARGETS.join(' and ')}`);
  }
  if (target !== 'corpus') {
    // C1 ships the corpus target. `rules` is C2, and refusing by name beats preparing an artifact
    // nothing can apply.
    throw new LabError('ENGINE_UNSUPPORTED', `the '${target}' target arrives in round C2; C1 releases the corpus`);
  }

  const staged = await getObject(db, args.staged_set_id);
  const stagedBody = (staged?.body ?? {}) as { kind?: string; label?: string; chunk_ids?: number[] };
  if (!staged || stagedBody.kind !== 'staged_set' || !stagedBody.label) {
    throw new LabError('NOT_FOUND', `no staged set ${args.staged_set_id}`);
  }
  const label = String(stagedBody.label);

  // ⚠️ RE-READ, NEVER TRUST THE STAGED OBJECT. The staged set was written at some earlier moment;
  // what matters is what is under the label NOW, because that is what an activation would move.
  const chunk_ids = await (deps.stagedIds ?? ((l: string) => readStagedIds(l)))(label);
  if (!chunk_ids.length) {
    throw new LabError('CASE_NOT_FOUND', `nothing is quarantined under labq:${label} any more`);
  }

  const read = deps.read ?? liveRead;
  const stateRows = await read<Record<string, unknown>>('mksap_chunks', CHUNK_STATE_SQL(chunk_ids));
  const predecessor_state: ChunkState[] = stateRows.map((r) => ({
    id: Number(r.id),
    source: r.source == null ? null : String(r.source),
    visible: r.visible === true,
  })).sort((a, b) => a.id - b.id);

  const already = predecessor_state.filter((c) => c.visible || !String(c.source ?? '').startsWith('labq:'));
  if (already.length) {
    throw new LabError('INVALID_INPUT',
      `${already.length} of ${predecessor_state.length} staged chunk(s) are already live; run corpus_validate — a release may not activate what is already activated`);
  }

  const t = await getTarget(db, target);
  if (!t) throw new LabError('STORE_UNAVAILABLE', `target '${target}' is missing; apply migrations/lab-v2/0002_releases.sql`);

  const artifact = {
    kind: 'release',
    target,
    label,
    staged_set_id: staged.id,
    chunk_ids,
    predecessor_visible_hash: hash(predecessor_state),
    predecessor_id: t.artifact_id,
    impact_ref: args.impact_ref ?? null,
    notes: args.notes ?? null,
    expected_revision: t.revision,
  };
  const { object, deduplicated } = await putObject(db, principal, 'release', artifact, 'deidentified', args.idempotency_key);

  return {
    release_id: object.id,
    artifact_hash: object.hash,
    deduplicated,
    target,
    label,
    chunk_ids,
    expected_revision: t.revision,
    predecessor_id: t.artifact_id,
    predecessor_visible_hash: artifact.predecessor_visible_hash,
    impact_ref: artifact.impact_ref,
    // What apply will do, in words, so a reviewer reads the consequence and not only the hash.
    will: `activate ${chunk_ids.length} chunk(s) under labq:${label} to lab:${label} via v1 corpusActivate, then bump corpus revision ${t.revision} to ${t.revision + 1}`,
    rollback: `return exactly those ${chunk_ids.length} id(s) to labq:${label} with visible = false`,
  };
}
