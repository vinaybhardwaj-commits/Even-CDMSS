/**
 * lib/opd-governance-core.ts — pure governance-signal engine over PDQI-9 aggregates.
 *
 * Turns a window's per-attribute means (+ prior-window baseline + per-doctor means)
 * into ranked, scope-aware CLINICAL-GOVERNANCE signals: what to do with / say to the
 * OPD doctors — huddle briefings, documentation norms, supportive 1:1s. This is the
 * governance-team counterpart of the (removed) EMR-design "raise it" cues; EMR capture
 * affordances live in the standalone design report, not here.
 *
 * Pure + deterministic: no imports, no I/O. Unit-tested. Consumed by
 * /api/governance/opd-signals (API-first — the view ships in the governance app later).
 */

export type GovAttrStat = { attr: string; mean: number; n: number };
export type GovDoctorStat = { uid: string; name?: string; attrs: Record<string, { mean: number; n: number }> };

export type GovThresholds = {
  signalBelow: number;      // fire a signal when the window mean is below this (default 3.5)
  actNowBelow: number;      // 'act_now' severity below this (default 2.5)
  trendDelta: number;       // |delta| vs prior window to call improving/worsening (default 0.3)
  doctorMinNotes: number;   // a doctor needs ≥ this many assessed notes to count (default 3)
  doctorLowBelow: number;   // a doctor is 'affected' when their attr mean is below this (default 3.0)
  systemicShare: number;    // affected share ≥ this ⇒ systemic (default 0.5)
  concentratedMax: number;  // affected count ≤ this (and share < systemicShare) ⇒ concentrated (default 5)
  minEligibleDoctors: number; // need ≥ this many eligible doctors to judge scope (default 3)
};
export const GOV_DEFAULT_THRESHOLDS: GovThresholds = {
  signalBelow: 3.5, actNowBelow: 2.5, trendDelta: 0.3,
  doctorMinNotes: 3, doctorLowBelow: 3.0, systemicShare: 0.5, concentratedMax: 5, minEligibleDoctors: 3,
};

export type GovScope = 'systemic' | 'concentrated' | 'mixed' | 'insufficient_data';
export type GovSignal = {
  attr: string; label: string; definition: string;
  mean: number; n: number;
  severity: 'act_now' | 'watch';
  trend: 'improving' | 'worsening' | 'flat' | 'no_baseline';
  delta: number | null;
  scope: GovScope;
  eligible_doctors: number;
  affected_share: number | null;       // affected / eligible (null when insufficient data)
  affected: { uid: string; name?: string; mean: number; n: number }[]; // worst first, capped at concentratedMax
  action: string;                       // the governance action, scope-appropriate
};
export type GovReport = {
  signals: GovSignal[];                 // act_now first, then mean ascending
  healthy: { attr: string; label: string; mean: number; n: number }[];
  thresholds: GovThresholds;
};

// ── PDQI-9 attribute meta: label + auditor definition + governance actions ──────
// `systemic` = whole-OPD action (huddle briefing / documentation norm / spot-audit).
// `concentrated` = targeted supportive action; '{doctors}' is replaced with the named list.
// Wording approved by V (2 Jul 2026) — clinical-governance voice, not EMR-design voice.
export const PDQI9_GOV: Record<string, { label: string; def: string; systemic: string; concentrated: string }> = {
  up_to_date: {
    label: 'Up-to-date',
    def: 'Reflects the current picture — today’s medications, latest results and status — not stale content carried forward from a past visit.',
    systemic: 'Huddle brief: reconcile current medications and latest results at every visit; call out copied-forward content as this week’s audit focus and re-measure in a week.',
    concentrated: 'Supportive 1:1s with {doctors} — review two of their own notes showing carried-forward content; agree a reconcile-at-visit habit; re-check in 2 weeks.',
  },
  accurate: {
    label: 'Accurate',
    def: 'Factually correct — values, medications and history match reality, with no contradictions or copy-paste errors.',
    systemic: 'Spot-audit transcription accuracy (vitals/labs vs source) on a sample of notes; brief verify-before-sign in huddle; escalate only if mismatches confirm.',
    concentrated: 'Verify-before-sign conversation with {doctors}, using mismatch examples from their own notes; re-audit their next week of notes.',
  },
  thorough: {
    label: 'Thorough',
    def: 'Covers what’s relevant — the complaint, pertinent history, comorbidities and key positive/negative findings — not just the headline issue.',
    systemic: 'Make pertinent negatives + comorbidities this week’s huddle teaching point; circulate a one-page exemplar HPI from a high-scoring doctor and re-measure next week.',
    concentrated: 'Targeted feedback with {doctors} — walk through one thin HPI of theirs against the exemplar; agree the minimum history set for their common presentations.',
  },
  useful: {
    label: 'Useful',
    def: 'Gives the next clinician what they need to act — a clear plan and the reasoning behind it.',
    systemic: 'Set a minimum actionable-plan norm: working diagnosis, plan and safety-net advice on every note; announce in huddle and audit compliance next week.',
    concentrated: 'Ask {doctors} the next-clinician test on two of their own notes — “could a colleague act on this tomorrow?” — and agree the missing plan elements.',
  },
  organized: {
    label: 'Organized',
    def: 'Logical, consistent structure — information sits where you expect it and the note is easy to scan.',
    systemic: 'Agree a SOAP-style section order as the OPD documentation norm; show a before/after pair in huddle.',
    concentrated: 'Share a well-organised exemplar with {doctors} and agree a consistent section order for their notes.',
  },
  comprehensible: {
    label: 'Comprehensible',
    def: 'Clear and readable to another clinician — minimal ambiguous shorthand or unexplained abbreviations.',
    systemic: 'Publish the top ambiguous abbreviations found in this window’s audits and brief doctors to spell them out.',
    concentrated: 'Show {doctors} their own ambiguous shorthand examples and agree replacements.',
  },
  succinct: {
    label: 'Succinct',
    def: 'Concise — the clinical signal isn’t buried under boilerplate or repetition.',
    systemic: 'Identify boilerplate/template walls-of-text and trim at source; brief in huddle that signal beats volume.',
    concentrated: 'Show {doctors} one of their notes against a succinct exemplar; agree what boilerplate to drop.',
  },
  synthesized: {
    label: 'Synthesized',
    def: 'Pulls the data together into the clinician’s reasoning — a coherent assessment/impression, not just a list of findings.',
    systemic: 'Set a documentation norm: every note carries a one-line assessment linking findings → diagnosis → plan; teach with two examples in huddle and audit next week.',
    concentrated: '1:1 coaching with {doctors} on documenting clinical reasoning — findings → diagnosis → plan in one line, practised on their own recent notes.',
  },
  internally_consistent: {
    label: 'Internally consistent',
    def: 'No internal contradictions — the diagnosis, medications and plan all line up with each other.',
    systemic: 'Brief a final read-through before signing — does diagnosis ↔ drugs ↔ plan line up; audit alignment on a sample of this week’s notes.',
    concentrated: 'Review mismatched examples with {doctors}; check whether it is a template artefact before treating it as a practice gap.',
  },
};
export const PDQI9_GOV_ORDER = [
  'up_to_date', 'accurate', 'thorough', 'useful', 'organized',
  'comprehensible', 'succinct', 'synthesized', 'internally_consistent',
];

const round1 = (x: number) => Math.round(x * 10) / 10;

function fmtDoctors(list: { name?: string; uid: string; mean: number; n: number }[]): string {
  return list.map((d) => `${d.name || 'Dr · ' + d.uid.slice(0, 6)} (${round1(d.mean)}, ${d.n} notes)`).join(', ');
}

/**
 * Compute ranked governance signals for one window.
 * - severity: mean < actNowBelow ⇒ act_now; < signalBelow ⇒ watch; else healthy (no signal).
 * - trend: vs prior-window mean, ±trendDelta.
 * - scope: among doctors with ≥ doctorMinNotes assessed notes, share with attr mean < doctorLowBelow.
 *   ≥ systemicShare ⇒ systemic · (share < systemicShare AND count ≤ concentratedMax) ⇒ concentrated ·
 *   otherwise mixed · fewer than minEligibleDoctors eligible ⇒ insufficient_data (systemic wording).
 */
export function computeGovernanceSignals(input: {
  current: GovAttrStat[];
  prior?: Record<string, number>;
  doctors?: GovDoctorStat[];
  thresholds?: Partial<GovThresholds>;
}): GovReport {
  const t: GovThresholds = { ...GOV_DEFAULT_THRESHOLDS, ...(input.thresholds || {}) };
  const prior = input.prior || {};
  const doctors = input.doctors || [];
  const signals: GovSignal[] = [];
  const healthy: GovReport['healthy'] = [];

  for (const attr of PDQI9_GOV_ORDER) {
    const stat = input.current.find((s) => s.attr === attr);
    if (!stat || stat.n === 0) continue;
    const meta = PDQI9_GOV[attr];
    const mean = round1(stat.mean);

    if (mean >= t.signalBelow) { healthy.push({ attr, label: meta.label, mean, n: stat.n }); continue; }

    const severity: GovSignal['severity'] = mean < t.actNowBelow ? 'act_now' : 'watch';

    const base = prior[attr];
    let trend: GovSignal['trend'] = 'no_baseline';
    let delta: number | null = null;
    if (Number.isFinite(base)) {
      delta = round1(mean - (base as number));
      trend = delta <= -t.trendDelta ? 'worsening' : delta >= t.trendDelta ? 'improving' : 'flat';
    }

    const eligible = doctors.filter((d) => (d.attrs[attr]?.n ?? 0) >= t.doctorMinNotes);
    const affectedAll = eligible
      .filter((d) => d.attrs[attr].mean < t.doctorLowBelow)
      .map((d) => ({ uid: d.uid, name: d.name, mean: round1(d.attrs[attr].mean), n: d.attrs[attr].n }))
      .sort((a, b) => a.mean - b.mean);

    let scope: GovScope;
    let share: number | null = null;
    if (eligible.length < t.minEligibleDoctors) {
      scope = 'insufficient_data';
    } else {
      share = Math.round((affectedAll.length / eligible.length) * 100) / 100;
      scope = share >= t.systemicShare ? 'systemic'
        : affectedAll.length > 0 && affectedAll.length <= t.concentratedMax ? 'concentrated'
          : 'mixed';
    }
    const affected = affectedAll.slice(0, t.concentratedMax);

    const action = scope === 'concentrated'
      ? meta.concentrated.replace('{doctors}', fmtDoctors(affected))
      : scope === 'mixed'
        ? `${meta.systemic} Start with the lowest-scoring doctors: ${fmtDoctors(affected.slice(0, 3))}.`
        : meta.systemic; // systemic + insufficient_data both get the hospital-level action

    signals.push({
      attr, label: meta.label, definition: meta.def, mean, n: stat.n,
      severity, trend, delta, scope,
      eligible_doctors: eligible.length, affected_share: share, affected, action,
    });
  }

  signals.sort((a, b) => (a.severity === b.severity ? a.mean - b.mean : a.severity === 'act_now' ? -1 : 1));
  healthy.sort((a, b) => b.mean - a.mean);
  return { signals, healthy, thresholds: t };
}
