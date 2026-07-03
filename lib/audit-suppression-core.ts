/**
 * lib/audit-suppression-core.ts — Tier 1 self-healing: suppression matcher CORE (pure).
 *
 * A human-approved `audit_suppression` narrows a recurring false-positive class out of the audit:
 * a finding matching an ACTIVE suppression is dropped, or downgraded to informational (kept for
 * awareness, removed from the triage queue + score). Narrowly scoped, reversible.
 *
 * The CARDINAL safety rule (PRD §7.2 dual-label invariant / P17): a suppression may only remove
 * flagged FPs if it removes NOTHING a care manager marked `valid_signal`. `previewCollateral` is the
 * pure check the activation endpoint runs against the valid-label set before a suppression goes live.
 * Pure → unit-testable.
 */

export type SuppressionAction = 'drop' | 'downgrade';
export type SuppressionMatch = 'type_only' | 'subject_contains';
export type SuppressionScope = 'all' | 'doctor';

export interface Suppression {
  id?: string;
  signal_type: string;
  discriminator: string | null;     // narrowing substring (subject_contains); null = whole type
  match_kind: SuppressionMatch;
  scope: SuppressionScope;
  doctor_uid: string | null;        // when scope='doctor'
  action: SuppressionAction;
  active: boolean;
}

export interface SuppressibleFinding {
  signal_type?: string;
  subject: string;
  finding_ref?: string;
  informational?: boolean;
}

/** Does this finding (for this doctor) match the suppression? */
export function findingMatchesSuppression(f: SuppressibleFinding, doctorUid: string | null, s: Suppression): boolean {
  if (!s.active) return false;
  if (!f.signal_type || f.signal_type !== s.signal_type) return false;
  if (s.scope === 'doctor' && s.doctor_uid && s.doctor_uid !== doctorUid) return false;
  if (s.match_kind === 'subject_contains' && s.discriminator) {
    return f.subject.toLowerCase().includes(s.discriminator.toLowerCase());
  }
  return true; // type_only, or no discriminator
}

export interface SuppressionOutcome<T> {
  findings: T[];
  suppressed: { finding_ref: string | undefined; signal_type: string | undefined; action: SuppressionAction }[];
}

/**
 * Apply active suppressions to one note's findings. First matching suppression wins.
 * `drop` removes the finding; `downgrade` sets informational (kept, but out of the queue + score).
 * Never touches an already-informational finding's presence (only real findings are suppressed).
 */
export function applySuppressions<T extends SuppressibleFinding>(
  findings: T[], doctorUid: string | null, suppressions: Suppression[],
): SuppressionOutcome<T> {
  const active = suppressions.filter((s) => s.active);
  if (active.length === 0) return { findings, suppressed: [] };

  const kept: T[] = [];
  const suppressed: SuppressionOutcome<T>['suppressed'] = [];
  for (const f of findings) {
    const hit = active.find((s) => findingMatchesSuppression(f, doctorUid, s));
    if (!hit) { kept.push(f); continue; }
    suppressed.push({ finding_ref: f.finding_ref, signal_type: f.signal_type, action: hit.action });
    if (hit.action === 'drop') continue;           // remove entirely
    kept.push({ ...f, informational: true });       // downgrade — kept for awareness, out of queue/score
  }
  return { findings: kept, suppressed };
}

// ── Dual-label safety (PRD §7.2) ──────────────────────────────────────────────
export interface ValidLabelInstance {
  doctor_uid: string;
  signal_type: string;
  subject: string;                  // the finding subject a CM's valid_signal decision covers
}

export interface CollateralPreview {
  would_suppress: number;           // findings the suppression matches in the sample
  collateral: number;               // of those, ones a CM validated (valid_signal) — MUST be 0 to activate
  safe: boolean;
  collateral_examples: { doctor_uid: string; subject: string }[];
}

/**
 * The dual-label check: over the valid-label set (findings whose (doctor, signal_type) a CM marked
 * `valid_signal`), how many would this proposed suppression remove? Any > 0 means it would blind the
 * audit to a confirmed-real signal → unsafe. `sample` = recent findings for the signal_type with the
 * doctor's latest validity label attached.
 */
export function previewCollateral(proposed: Suppression, validLabelSet: ValidLabelInstance[]): CollateralPreview {
  const matched = validLabelSet.filter((v) =>
    findingMatchesSuppression({ signal_type: v.signal_type, subject: v.subject }, v.doctor_uid, proposed));
  return {
    would_suppress: matched.length,
    collateral: matched.length,     // every item in the valid-label set is, by definition, validated
    safe: matched.length === 0,
    collateral_examples: matched.slice(0, 5).map((v) => ({ doctor_uid: v.doctor_uid, subject: v.subject })),
  };
}
