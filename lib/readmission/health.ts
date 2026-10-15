/**
 * lib/readmission/health.ts — is the readmission agent alive? (READMIT-OBSERVABILITY, 13 Oct 2026)
 *
 * The narrative leg failed silently from 17 Sep because every signal shown (worker 200, MAX(audited_at))
 * kept looking fine. This module turns the stuck-work stamps and Bedrock liveness into one status.
 *
 * PURE rule, no I/O: `readmissionHealthStatus`. RED when work has waited more than 24 h (oldest narrative
 * pending, oldest detected), when Bedrock is not live, or when the health read itself failed. It is
 * NEVER red merely because the last audit or last narrative is old: audits are sparse (zero on some
 * days) and that would false-alarm.
 *
 * PHI: counts and timestamps only.
 */
import type { ReadmissionHealthCounts } from './store';

/** Work older than this is stuck. */
export const HEALTH_STALE_MS = 24 * 60 * 60 * 1000;

export interface BedrockLiveLike { ok: boolean; checkedAt: string; error: string | null }

export type BedrockCode = 'not_configured' | 'sts_denied' | 'timeout' | 'id_token_failed' | 'error';

/** PURE: map bedrockLive's masked error text to ONE code. null when ok. The text itself never leaves the server.
 *  Order matters: id-token failures are tested BEFORE sts (their text can mention the STS call), and an
 *  incomplete credential set is a plain 'error'. */
export function classifyBedrockError(live: { ok: boolean; error: string | null }): BedrockCode | null {
  if (live.ok) return null;
  const e = live.error ?? '';
  if (/not configured/i.test(e)) return 'not_configured';
  if (/^timeout after/i.test(e)) return 'timeout';
  if (/generateIdToken|iamcredentials|id[ _-]?token/i.test(e)) return 'id_token_failed';
  if (/incomplete credential set/i.test(e)) return 'error';
  if (/AccessDenied|not authorized|AssumeRoleWithWebIdentity/i.test(e)) return 'sts_denied';
  return 'error';
}

/** The closed set of codes the narrativeError stamp may carry (the stamp reaches clients; it holds a code, never text). */
export const NARRATIVE_ERROR_CODES = ['not_configured', 'sts_denied', 'timeout', 'id_token_failed', 'error', 'narrative_failed'] as const;
export type NarrativeErrorCode = (typeof NARRATIVE_ERROR_CODES)[number];

/** Anything outside the closed set becomes 'error'. */
export function normaliseNarrativeCode(code: unknown): NarrativeErrorCode {
  return (NARRATIVE_ERROR_CODES as readonly string[]).includes(code as string) ? (code as NarrativeErrorCode) : 'error';
}

/** PURE: a narrative-leg failure reason (text) to a code; non-Bedrock failures (parse, validation, store) are 'narrative_failed'. */
export function classifyNarrativeFailure(reason: string | null | undefined): NarrativeErrorCode {
  const c = classifyBedrockError({ ok: false, error: reason ?? '' });
  return c === null || c === 'error' ? 'narrative_failed' : c;
}

/** The closed set of codes the lastRefreshError stamp may carry (the stamp reaches clients; it holds a code, never text). */
export const REFRESH_ERROR_CODES = [
  'reassemble_failed', 'model_disagreement', 'write_failed', 'no_rows_landed',
  'not_configured', 'sts_denied', 'timeout', 'id_token_failed', 'error', 'refresh_failed',
] as const;
export type RefreshErrorCode = (typeof REFRESH_ERROR_CODES)[number];

/** Anything outside the closed set becomes 'refresh_failed'. */
export function normaliseRefreshCode(code: unknown): RefreshErrorCode {
  return (REFRESH_ERROR_CODES as readonly string[]).includes(code as string) ? (code as RefreshErrorCode) : 'refresh_failed';
}

export type RefreshFailureKind = 'reassemble' | 'disagreement' | 'write' | 'no_rows' | 'thrown';

/** PURE: a refresh failure (its kind plus free text) to ONE code. Only a 'thrown' failure reads the text, and only
 *  through classifyBedrockError; a non-Bedrock throw (parse, validation, store) is 'refresh_failed'. */
export function classifyRefreshFailure(kind: RefreshFailureKind, text?: string | null): RefreshErrorCode {
  switch (kind) {
    case 'reassemble': return 'reassemble_failed';
    case 'disagreement': return 'model_disagreement';
    case 'write': return 'write_failed';
    case 'no_rows': return 'no_rows_landed';
    case 'thrown': {
      const c = classifyBedrockError({ ok: false, error: text ?? '' });
      return c === null || c === 'error' ? 'refresh_failed' : c;
    }
    default: return 'refresh_failed';
  }
}

/** The closed set of codes a readmission worker may STORE (backfill_runs.last_error / status message,
 *  readmission_findings.last_error) or RETURN in its cron/admin JSON. A code, never exception text. */
export const WORKER_ERROR_CODES = [
  'not_configured', 'sts_denied', 'timeout', 'id_token_failed', 'error',
  'refresh_failed', 'narrative_failed', 'audit_failed', 'run_failed',
] as const;
export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number];

/** PURE: free text to a code in WORKER_ERROR_CODES. Bedrock classes come from classifyBedrockError; anything else
 *  (and the generic 'error') is the caller's fallback. The input is never echoed. */
export function classifyWorkerError(text: string | null | undefined, fallback: WorkerErrorCode): WorkerErrorCode {
  const f: WorkerErrorCode = (WORKER_ERROR_CODES as readonly string[]).includes(fallback) ? fallback : 'run_failed';
  const c = classifyBedrockError({ ok: false, error: typeof text === 'string' ? text : '' });
  return c === null || c === 'error' ? f : c;
}

/** A worker's catch block: log the raw message once (server log only), return the code that is stored and returned. */
export function workerCatchCode(e: unknown, fallback: WorkerErrorCode, tag: string): WorkerErrorCode {
  const raw = String((e as Error)?.message ?? e).slice(0, 500);
  console.warn(`${tag} ${raw}`);
  return classifyWorkerError(raw, fallback);
}

export interface PublicBedrock { ok: boolean; checkedAt: string; code: BedrockCode | null }

export function publicBedrock(live: BedrockLiveLike): PublicBedrock {
  return { ok: live.ok, checkedAt: live.checkedAt, code: classifyBedrockError(live) };
}

export interface HealthAges {
  lastAuditHours: number | null;
  lastNarrativeHours: number | null;
  oldestNarrativePendingHours: number | null;
  oldestDetectedHours: number | null;
}

export interface ReadmissionHealthStatus {
  status: 'green' | 'red';
  reasons: string[];
  ages: HealthAges;
}

function ageHours(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round(((nowMs - t) / 3_600_000) * 10) / 10;
}

export function readmissionHealthStatus(
  counts: ReadmissionHealthCounts, live: BedrockLiveLike, nowMs: number,
): ReadmissionHealthStatus {
  const ages: HealthAges = {
    lastAuditHours: ageHours(counts.lastAuditAt, nowMs),
    lastNarrativeHours: ageHours(counts.lastNarrativeAt, nowMs),
    oldestNarrativePendingHours: ageHours(counts.oldestNarrativePendingAt, nowMs),
    oldestDetectedHours: ageHours(counts.oldestDetectedAt, nowMs),
  };
  const limitH = HEALTH_STALE_MS / 3_600_000;
  const reasons: string[] = [];
  if (counts.readOk === false) reasons.push('health read failed');
  if (live.ok === false) reasons.push(`bedrock unreachable (${classifyBedrockError(live)})`);
  if (ages.oldestNarrativePendingHours !== null && ages.oldestNarrativePendingHours > limitH) {
    reasons.push(`narrative pending for ${ages.oldestNarrativePendingHours} h`);
  }
  if (ages.oldestDetectedHours !== null && ages.oldestDetectedHours > limitH) {
    reasons.push(`detected case unaudited for ${ages.oldestDetectedHours} h`);
  }
  return { status: reasons.length ? 'red' : 'green', reasons, ages };
}

export interface ReadmissionHealth extends ReadmissionHealthStatus {
  counts: ReadmissionHealthCounts;
  bedrock: PublicBedrock;
}

/** Server: the store read plus Bedrock liveness, through the pure rule. */
export async function readReadmissionHealth(engineVersion?: string): Promise<ReadmissionHealth> {
  const [{ readmissionHealthCounts }, { bedrockLive }] = await Promise.all([import('./store'), import('../bedrock')]);
  const [counts, bedrock] = await Promise.all([readmissionHealthCounts(engineVersion), bedrockLive()]);
  return { ...readmissionHealthStatus(counts, bedrock, Date.now()), counts, bedrock: publicBedrock(bedrock) };
}
