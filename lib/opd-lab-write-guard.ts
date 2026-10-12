/**
 * lib/opd-lab-write-guard.ts — hard stop for production audit writers during a paired
 * override run.
 *
 * The lab execution fence (lib/lab-execution-context.ts) already makes `sql` throw inside
 * `withLabExecution`. That is not this guard. The repair adapter leaves that fence on
 * purpose (`exitLabExecution`) and then calls `saveOpdAudit`. A paired audit of an
 * alternate prescription must not be able to take that door, or any other door that
 * stamps `opd_note_audits`, the Action queue, governance signals, findings, or triage.
 *
 * The flag is an AsyncLocalStorage bit, inherited by every frame under the paired runner.
 * Production callers never enter it, so each writer pays one lookup and continues.
 * Inside it, the writer throws before any SQL, any table ensure, or any side effect.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const fence = new AsyncLocalStorage<true>();

export class OpdLabWriteForbidden extends Error {
  readonly code = 'OPD_LAB_WRITE_FORBIDDEN' as const;
  readonly writer: string;
  constructor(writer: string) {
    super(`production writer ${writer} refused in paired-audit override/lab mode`);
    this.name = 'OpdLabWriteForbidden';
    this.writer = writer;
  }
}

export function opdLabWriteFenceActive(): boolean {
  return fence.getStore() === true;
}

/** Run `fn` with production audit writers sealed. Nested fences stay sealed. */
export function enterOpdLabWriteFence<T>(fn: () => Promise<T>): Promise<T> {
  return fence.run(true, fn);
}

/**
 * First line of every production writer the paired run must not reach.
 * `writer` is a stable id (`opd_note_audits.saveOpdAudit`, …), never note text.
 */
export function assertOpdProductionWrite(writer: string): void {
  if (fence.getStore() === true) throw new OpdLabWriteForbidden(writer);
}
