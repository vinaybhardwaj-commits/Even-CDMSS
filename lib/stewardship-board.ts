/**
 * lib/stewardship-board.ts — the internal MS board's reads: the named-clinician rows, the department
 * roll-up, and the danger queue (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, S2; spec §4).
 *
 * The aggregate SQL is the board page's own, moved here unchanged in meaning and composed from the
 * one fragment in lib/stewardship-canonical.ts — spec §12.1 asks that any extraction come from that
 * page and lib/opd-audit-doctor.ts, and this is that extraction. The page renders; this file reads.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ THE ONE THING WORTH ARGUING WITH, STATED PLAINLY: the escalation leg of the danger queue is
 * found by a SQL PREFILTER and decided by `tierFor`.
 *
 * Tier 1 is a regex over a finding's own text (lib/severity-tier-core.ts, the ratified table §3).
 * SQL cannot run it, and duplicating it in SQL would create the second severity authority this repo
 * has spent months removing everywhere else. So the query narrows and TypeScript decides:
 *
 *   · ESCALATION_PREFILTER below is a deliberate SUPERSET of the ratified escalation patterns —
 *     every phrase E-1 can match, plus the two lead words E-2 requires. It is allowed to return
 *     findings that are not tier 1. It is NOT allowed to miss one.
 *   · `tierFor` then decides every candidate. Nothing is promoted, demoted or counted on the
 *     strength of the ILIKE.
 *
 * THE RISK THIS CARRIES, and the tripwire against it: if a future E-3 entry is added to the ratified
 * table with vocabulary the prefilter does not cover, the queue would silently stop finding it.
 * lib/__tests__/stewardship-board.test.ts pins the set of escalation matchers declared in
 * severity-tier-core.ts, so adding one fails this branch's suite and forces the prefilter to be
 * revisited in the same change. Flagged in the S2 slice report.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ INFERRED SQL THROUGHOUT: this sandbox has no live Neon. Every query is exported verbatim in
 * BOARD_INFERRED_SQL and listed in the slice report. Every read is fail-safe — a fault degrades that
 * section to empty with a visible note on the page, never a 500 and never a guessed number.
 */
import { sql } from '@/lib/db';
import { dedupeTwins } from '@/lib/severity-tier-core';
import {
  opdDangerVerdict, ipdDangerVerdict, sortBoardRows,
  type DangerPillState, type DangerVerdict,
} from '@/lib/stewardship-danger-core';
import {
  IPD_DEPT_UNASSIGNED, OPD_DEPT_LABEL_SQL, OPD_DEPT_UNSPECIFIED,
  STEWARDSHIP_APP, STEWARDSHIP_WINDOW_DAYS, ipdCanonParams, ipdCanonical90d,
  opdCanonParams, opdCanonical90d,
} from '@/lib/stewardship-canonical';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const num = (v: unknown): number => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (v == null ? '' : String(v));

/** How many prefilter candidates and how many queue rows one page load will look at. Both are
 *  reported honestly on the surface when they bite, because a silently truncated danger queue is a
 *  danger queue that has stopped being one. */
const CANDIDATE_CAP = 4_000;
const QUEUE_CAP = 500;

// ── the aggregate rows (the board's existing 90-day recipe) ───────────────────────────────

const AGG_SELECT = `
  count(*)::int AS n_notes,
  round(avg(t.note_quality_index))::int AS avg_nqi,
  round(100.0 * avg(CASE WHEN t.band IN ('A','B') THEN 1 ELSE 0 END))::int AS pct_ab,
  round(avg(t.score_appropriateness))::int AS avg_appr,
  round(avg(t.score_prescribing_safety))::int AS avg_presc,
  round(avg(t.completeness_pct))::int AS avg_complete,
  round(100.0 * avg(CASE WHEN t.n_low_value > 0 THEN 1 ELSE 0 END))::int AS pct_low,
  sum(t.n_low_value)::int AS sum_low,
  sum(t.n_interaction_alerts)::int AS sum_interactions`;

const AGG_COLS = `doctor_uid, note_quality_index, band,
    score_appropriateness, score_prescribing_safety, score_documentation,
    completeness_pct, n_low_value, n_interaction_alerts`;

const DOCTOR_SQL = `
  SELECT t.doctor_uid AS doctor_uid,
         COALESCE(NULLIF(dd.doctor_name, ''), '(unknown)') AS doctor_name,
         ${OPD_DEPT_LABEL_SQL} AS speciality, ${AGG_SELECT}
  FROM ( ${opdCanonical90d(AGG_COLS)} ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  GROUP BY t.doctor_uid, dd.doctor_name, dd.speciality
  ORDER BY n_notes DESC, doctor_name
  LIMIT 400`;

const DEPT_SQL = `
  SELECT ${OPD_DEPT_LABEL_SQL} AS dept,
         count(DISTINCT t.doctor_uid)::int AS n_doctors, ${AGG_SELECT}
  FROM ( ${opdCanonical90d(AGG_COLS)} ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  GROUP BY 1`;

const TOTAL_SQL = `
  SELECT count(*)::int AS n_notes,
         round(avg(t.note_quality_index))::int AS avg_nqi,
         round(100.0 * avg(CASE WHEN t.band IN ('A','B') THEN 1 ELSE 0 END))::int AS pct_ab,
         round(100.0 * avg(CASE WHEN t.n_low_value > 0 THEN 1 ELSE 0 END))::int AS pct_low,
         sum(t.n_low_value)::int AS sum_low,
         sum(t.n_interaction_alerts)::int AS sum_interactions
  FROM ( ${opdCanonical90d('note_quality_index, band, n_low_value, n_interaction_alerts')} ) t`;

// ── the danger queue's three reads ────────────────────────────────────────────────────────

/**
 * A SUPERSET of the ratified escalation patterns (severity-tier-core §3). Read the file header
 * before changing a line of this array.
 *
 *   E-1 matches: acute coronary syndrome · ACS · unstable angina · myocardial infarction ·
 *                exertional chest pain / heaviness          → the first six patterns
 *   E-2 requires: "persistent" or "unexplained" somewhere in the text, before any of its other
 *                 conditions can hold                       → the last two patterns
 *
 * Every pattern is wider than the regex it stands in for. That is the direction the error must run.
 */
const ESCALATION_PREFILTER = [
  '%acute coronary%', '%acs%', '%unstable angina%', '%myocardial infarction%',
  '%chest pain%', '%chest heaviness%',
  '%persistent%', '%unexplained%',
];

const FINDING_LATERAL = (col: string) =>
  `jsonb_array_elements(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;

const NOTE_DAY = `to_char((t.note_date AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD')`;

/** D1 — the escalation candidates, with each finding's CURRENT pill. $1 app · $2 days · $3 prefilter
 *  · $4 study (NULL = production rows only; §8's always-present predicate). */
const DANGER_ESCALATION_SQL = `
  SELECT t.id AS audit_id, t.doctor_uid,
         COALESCE(NULLIF(dd.doctor_name, ''), '(unknown)') AS doctor_name,
         ${OPD_DEPT_LABEL_SQL} AS dept,
         ${NOTE_DAY} AS note_day,
         f->>'subject' AS subject,
         COALESCE(f->>'signal_type', '') AS signal_type,
         COALESCE(f->>'rationale', '') AS rationale,
         COALESCE(f->>'verdict', '') AS verdict,
         COALESCE(f->>'domain', '') AS domain,
         COALESCE(f->>'finding_ref', '') AS finding_ref,
         COALESCE((f->>'informational')::boolean, false) AS informational,
         fb.verdict AS pill
  FROM ( ${opdCanonical90d('id, doctor_uid, note_date, findings')} ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  CROSS JOIN LATERAL ${FINDING_LATERAL('t.findings')} f
  LEFT JOIN LATERAL (
    SELECT v.verdict
      FROM opd_audit_feedback v
     WHERE v.audit_id = t.id AND v.scope = 'finding' AND v.finding_ref = f->>'finding_ref'
       AND v.app_source = $1 AND v.study IS NOT DISTINCT FROM $4
     ORDER BY v.created_at DESC
     LIMIT 1
  ) fb ON true
  WHERE COALESCE(f->>'subject', '') <> ''
    AND (COALESCE(f->>'subject', '') || ' ' || COALESCE(f->>'rationale', '')) ILIKE ANY ($3::text[])
  ORDER BY t.note_date DESC
  LIMIT ${CANDIDATE_CAP}`;

/** D2 — every finding whose CURRENT pill is `contested`, whatever its tier. The inner query settles
 *  "current" (latest row per audit + finding_ref); the outer one keeps only the disputes, so a
 *  finding contested and then confirmed does not appear. $1 app · $2 days · $3 study. */
const DANGER_CONTESTED_SQL = `
  SELECT * FROM (
    SELECT DISTINCT ON (fb.audit_id, fb.finding_ref)
           t.id AS audit_id, t.doctor_uid,
           COALESCE(NULLIF(dd.doctor_name, ''), '(unknown)') AS doctor_name,
           ${OPD_DEPT_LABEL_SQL} AS dept,
           ${NOTE_DAY} AS note_day,
           fb.finding_ref, fb.verdict AS pill,
           COALESCE(fj.f->>'subject', '') AS subject,
           COALESCE(fj.f->>'signal_type', '') AS signal_type,
           COALESCE(fj.f->>'rationale', '') AS rationale,
           COALESCE(fj.f->>'verdict', '') AS verdict,
           COALESCE(fj.f->>'domain', '') AS domain
    FROM opd_audit_feedback fb
    JOIN ( ${opdCanonical90d('id, doctor_uid, note_date, findings')} ) t ON t.id = fb.audit_id
    LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
    LEFT JOIN LATERAL (
      SELECT x AS f FROM ${FINDING_LATERAL('t.findings')} x
       WHERE x->>'finding_ref' = fb.finding_ref
       LIMIT 1
    ) fj ON true
    WHERE fb.scope = 'finding' AND fb.finding_ref IS NOT NULL
      AND fb.app_source = $1 AND fb.study IS NOT DISTINCT FROM $3
    ORDER BY fb.audit_id, fb.finding_ref, fb.created_at DESC
  ) q
  WHERE q.pill = 'contested'
  ORDER BY q.note_day DESC
  LIMIT ${QUEUE_CAP}`;

/** D3 — the inpatient leg: safety-domain findings and contested ones, on A6's canonical stays.
 *  $1 engine · $2 app. No clinician is attributed: the hop is S3's and the queue says so. */
const DANGER_IPD_SQL = `
  SELECT * FROM (
    SELECT t.id AS audit_id, t.ip_uid,
           COALESCE(NULLIF(t.speciality, ''), '${IPD_DEPT_UNASSIGNED}') AS dept,
           f->>'subject' AS subject,
           COALESCE(f->>'domain', '') AS domain,
           COALESCE(f->>'verdict', '') AS verdict,
           fb.verdict AS pill
    FROM ( ${ipdCanonical90d('id, speciality, findings')} ) t
    CROSS JOIN LATERAL ${FINDING_LATERAL('t.findings')} f
    LEFT JOIN LATERAL (
      SELECT v.verdict
        FROM ipd_audit_feedback v
       WHERE v.audit_id = t.id AND v.finding_ref = f->>'subject' AND v.app_source = $2
       ORDER BY v.created_at DESC
       LIMIT 1
    ) fb ON true
    WHERE COALESCE(f->>'subject', '') <> ''
  ) q
  WHERE q.domain = 'safety' OR q.pill = 'contested'
  ORDER BY q.audit_id, q.subject
  LIMIT ${QUEUE_CAP}`;

// ── shapes ────────────────────────────────────────────────────────────────────────────────

export interface BoardMetrics {
  nNotes: number; avgNqi: number; pctAb: number;
  avgAppr: number; avgPresc: number; avgComplete: number;
  pctLow: number; sumLow: number; sumInteractions: number;
}
export interface BoardDoctorRow extends BoardMetrics {
  doctorUid: string; doctorName: string; speciality: string;
  openDangerous: number; confirmedDangerous: number;
  /** A1 — null until the practitioner-id hop lands (S3). Never a zero, never a guess. */
  ipdCvi: number | null; ipdStays: number;
}
export interface BoardDeptRow extends BoardMetrics {
  dept: string; nDoctors: number;
  openDangerous: number; confirmedDangerous: number;
  ipdCvi: number | null; ipdStays: number;
}
export interface DangerRow {
  surface: 'opd' | 'ipd';
  auditId: string;
  subject: string;
  signalType: string;
  domain: string;
  doctorUid: string | null;
  doctorName: string;
  dept: string;
  day: string;
  occurrences: number;
  state: DangerPillState;
  open: boolean;
  leg: DangerVerdict['leg'];
  escalatedBy?: 'E-1' | 'E-2';
  reason: string;
  href: string;
}
export interface DangerQueue {
  rows: DangerRow[];
  /** doctor_uid → counts, for the board column. Only the OPD leg can key a clinician today. */
  byDoctor: Record<string, { open: number; confirmed: number }>;
  /** department label → counts. The OPD and inpatient vocabularies are kept apart by surface. */
  byOpdDept: Record<string, { open: number; confirmed: number }>;
  /** True when a cap bit, so the surface can say the queue is partial rather than imply it is whole. */
  capped: boolean;
  /** True when a read failed: the section degrades to empty WITH a note (§6a). */
  unavailable: boolean;
}

const metricsOf = (r: Record<string, unknown>): BoardMetrics => ({
  nNotes: num(r.n_notes), avgNqi: num(r.avg_nqi), pctAb: num(r.pct_ab),
  avgAppr: num(r.avg_appr), avgPresc: num(r.avg_presc), avgComplete: num(r.avg_complete),
  pctLow: num(r.pct_low), sumLow: num(r.sum_low), sumInteractions: num(r.sum_interactions),
});

// ── the reads ─────────────────────────────────────────────────────────────────────────────

/**
 * THE DANGER QUEUE. Three reads, one merge, `tierFor` deciding the OPD severity leg and A5 deciding
 * every pill. Fail-safe: any read that throws contributes nothing and sets `unavailable`, and the
 * board then shows an empty queue with a visible note instead of a 500 or a false zero.
 */
export async function fetchDangerQueue(): Promise<DangerQueue> {
  const p = opdCanonParams();
  const ipdP = ipdCanonParams();
  let unavailable = false;
  const guard = async (text: string, params: unknown[]): Promise<Record<string, unknown>[]> => {
    try { return await run(text, params); } catch { unavailable = true; return []; }
  };

  const [escRows, conRows, ipdRows] = await Promise.all([
    guard(DANGER_ESCALATION_SQL, [...p, ESCALATION_PREFILTER, null]),
    guard(DANGER_CONTESTED_SQL, [...p, null]),
    guard(DANGER_IPD_SQL, [...ipdP, STEWARDSHIP_APP]),
  ]);

  const capped = escRows.length >= CANDIDATE_CAP || conRows.length >= QUEUE_CAP || ipdRows.length >= QUEUE_CAP;

  // ── OPD. The two legs can name the same finding (an escalated finding that was also contested),
  // so they are merged on (audit_id, finding_ref | subject) before anything is counted.
  const opd = new Map<string, DangerRow & { _twinRef: string | null }>();
  const addOpd = (r: Record<string, unknown>) => {
    const subject = str(r.subject);
    if (!subject) return;
    const findingRef = str(r.finding_ref);
    const v = opdDangerVerdict({
      signal_type: str(r.signal_type), verdict: str(r.verdict), domain: str(r.domain),
      subject, rationale: str(r.rationale),
      informational: r.informational === true,
    }, r.pill);
    if (!v.included) return;
    const auditId = str(r.audit_id);
    const key = `${auditId}|${findingRef || subject}`;
    const prev = opd.get(key);
    if (prev) {
      // Both legs found it. Keep the richer reason and the strongest leg.
      prev.leg = prev.leg === v.leg ? prev.leg : 'both';
      return;
    }
    opd.set(key, {
      surface: 'opd', auditId, subject,
      signalType: str(r.signal_type), domain: str(r.domain),
      doctorUid: str(r.doctor_uid) || null, doctorName: str(r.doctor_name) || '(unknown)',
      dept: str(r.dept) || OPD_DEPT_UNSPECIFIED, day: str(r.note_day),
      occurrences: 1, state: v.state, open: v.open, leg: v.leg,
      ...(v.escalatedBy ? { escalatedBy: v.escalatedBy } : {}),
      reason: v.reason,
      href: `/admin/opd-audit/${auditId}`,
      _twinRef: findingRef || null,
    });
  };
  for (const r of escRows) addOpd(r);
  for (const r of conRows) addOpd(r);

  // §1.4 — TWINS: the same finding written for one clinician twice on one day is ONE decision, and
  // the queue is a list of decisions. `dedupeTwins` is the canonical helper for exactly this, and
  // this is the first surface to render cross-note finding rows; the reporting unit is stated on
  // the surface (DANGER_QUEUE_UNIT).
  const deduped = dedupeTwins([...opd.values()].map((f) => ({
    finding: f, findingRef: f._twinRef, doctorUid: f.doctorUid, noteDate: f.day,
  })));
  const opdRows: DangerRow[] = deduped.map(({ finding, occurrences }) => {
    const { _twinRef: _drop, ...row } = finding;
    return { ...row, occurrences };
  });

  // ── IPD. No clinician key exists on this spine (A1), so these rows carry a department and no
  // person. They never enter the per-doctor column.
  const ipd: DangerRow[] = [];
  for (const r of ipdRows) {
    const subject = str(r.subject);
    if (!subject) continue;
    const v = ipdDangerVerdict({ subject, domain: str(r.domain), verdict: str(r.verdict) }, r.pill);
    if (!v.included) continue;
    const auditId = str(r.audit_id);
    ipd.push({
      surface: 'ipd', auditId, subject, signalType: '', domain: str(r.domain),
      doctorUid: null, doctorName: '', dept: str(r.dept) || IPD_DEPT_UNASSIGNED, day: '',
      occurrences: 1, state: v.state, open: v.open, leg: v.leg, reason: v.reason,
      href: `/admin/ipd-audit/${auditId}`,
    });
  }

  const byDoctor: Record<string, { open: number; confirmed: number }> = {};
  const byOpdDept: Record<string, { open: number; confirmed: number }> = {};
  for (const r of opdRows) {
    if (r.state === 'dropped') continue;
    const bump = (m: Record<string, { open: number; confirmed: number }>, k: string) => {
      const cell = m[k] ?? (m[k] = { open: 0, confirmed: 0 });
      if (r.open) cell.open += r.occurrences; else if (r.state === 'confirmed') cell.confirmed += r.occurrences;
    };
    if (r.doctorUid) bump(byDoctor, r.doctorUid);
    bump(byOpdDept, r.dept);
  }

  // Open first, then the confirmed ones, then the rest; newest day first inside each group.
  const rank = (r: DangerRow) => (r.open ? 0 : r.state === 'confirmed' ? 1 : 2);
  const rows = [...opdRows, ...ipd].sort((a, b) =>
    rank(a) - rank(b) || b.day.localeCompare(a.day) || a.subject.localeCompare(b.subject));

  return { rows, byDoctor, byOpdDept, capped, unavailable };
}

/** The named-clinician board rows, already sorted by the D-no-composite rule. */
export async function fetchDoctorBoard(queue: DangerQueue): Promise<BoardDoctorRow[]> {
  const rows = await run(DOCTOR_SQL, opdCanonParams()).catch(() => []);
  const built: BoardDoctorRow[] = rows.map((r) => {
    const uid = str(r.doctor_uid);
    const d = queue.byDoctor[uid] ?? { open: 0, confirmed: 0 };
    return {
      ...metricsOf(r),
      doctorUid: uid,
      doctorName: str(r.doctor_name) || '(unknown)',
      speciality: str(r.speciality) || OPD_DEPT_UNSPECIFIED,
      openDangerous: d.open, confirmedDangerous: d.confirmed,
      // A1 — the inpatient column has no key to resolve yet. `null` renders as the split banner's
      // cell; it is not a zero and it does not sort as one.
      ipdCvi: null, ipdStays: 0,
    };
  });
  return sortBoardRows(built.map((r) => ({ ...r, avgNqi: r.avgNqi, label: r.doctorName })))
    .map(({ label: _drop, ...r }) => r);
}

/** The department roll-up, same three columns, OPD vocabulary. */
export async function fetchDeptBoard(queue: DangerQueue): Promise<BoardDeptRow[]> {
  const rows = await run(DEPT_SQL, opdCanonParams()).catch(() => []);
  const built: BoardDeptRow[] = rows.map((r) => {
    const dept = str(r.dept) || OPD_DEPT_UNSPECIFIED;
    const d = queue.byOpdDept[dept] ?? { open: 0, confirmed: 0 };
    return {
      ...metricsOf(r), dept, nDoctors: num(r.n_doctors),
      openDangerous: d.open, confirmedDangerous: d.confirmed,
      ipdCvi: null, ipdStays: 0,
    };
  });
  return sortBoardRows(built.map((r) => ({ ...r, label: r.dept })))
    .map(({ label: _drop, ...r }) => r);
}

/** The window's totals, for the headline tiles. Fail-safe → zeros. */
export async function fetchBoardTotals(): Promise<BoardMetrics> {
  const rows = await run(TOTAL_SQL, opdCanonParams()).catch(() => []);
  return metricsOf(rows[0] ?? {});
}

/** Every INFERRED query this file runs, for the slice report and a live-validation pass. */
export const BOARD_INFERRED_SQL: Readonly<Record<string, string>> = Object.freeze({
  board_doctor: DOCTOR_SQL,
  board_dept: DEPT_SQL,
  board_totals: TOTAL_SQL,
  danger_escalation: DANGER_ESCALATION_SQL,
  danger_contested: DANGER_CONTESTED_SQL,
  danger_ipd: DANGER_IPD_SQL,
});

/** The prefilter, exported so the test can prove it is a superset of the ratified patterns. */
export const BOARD_ESCALATION_PREFILTER: readonly string[] = ESCALATION_PREFILTER;
export const BOARD_WINDOW_DAYS = STEWARDSHIP_WINDOW_DAYS;
