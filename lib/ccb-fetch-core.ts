/**
 * lib/ccb-fetch-core.ts — Care Conversation Brief: episode bundler CORE (pure).
 *
 * PURE, dependency-free (node --experimental-strip-types friendly). Types + validated
 * SQL builders + row mappers for assembling a member's same-day OPD "episode bundle"
 * from db13 (read via Metabase in the wired `ccb-fetch.ts`). No DB/LLM imports here.
 *
 * Data spine (verified live 30 Jun, see CCB build spec §2):
 *  • episode anchor  = one `individuals-prescriptions` row (presc uid; `_parent_id` = individual_uid).
 *  • bridge          = `individuals.kx_uhid` (maintained FK; 99.9% of recent OPD members).
 *  • order ledger    = `kx_lab_reports` + `kx_radiology_reports` by `uhid` (what was DONE; metadata only).
 *  • result bodies   = consumer report PDFs (the actual results), joined child→parent:
 *      radiology  → "individuals-radiology_reports-radiology_booking_reports".report_url
 *                   (c._parent_id = p._id ; p._parent_id = individual_uid)
 *      diagnostic → "individuals-diagnostic_reports-diagnostic_booking_reports".report_url (same shape)
 *      hcu        → "individuals-hcu_bookings".(consolidated_report_url|report_url)  [parent has the URL]
 *  Coverage: ~46% of episodes have ≥1 result PDF ("rich"); the rest are "order_only"
 *  (prescription + ledger) and the brief must still run — graceful degradation.
 *
 * SECURITY: every interpolated id/date is validated (isUid/isUhid/isDay) BEFORE it reaches
 * SQL — never interpolate an unvalidated value (mirrors lib/metabase.ts).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface EpisodeKeys {
  prescUid: string;
  individualUid: string;
  kxUhid: string | null;
  kxEncounterId: string | null;
  doctorUid: string | null;
  doctorSpeciality: string | null;
  noteDate: string;            // YYYY-MM-DD (IST calendar day of the note)
  consultType: string | null;
  prescriptionType: string | null;
}

export interface EpisodePrescription {
  url: string | null;
  meds: unknown;               // raw medications (array/json) — enriched downstream
  dxCodes: string[];
  impressionCodes: string[];
  furtherInvestigation: unknown;
  presentingComplaint: string | null;
  planOfManagement: string | null;
  specialistReferral: string[];   // specialist_type_uids ∪ in_house_specialist_type_uids
}

export interface OrderedItem {
  kind: 'lab' | 'radiology';
  serviceName: string | null;
  orderedBy: string | null;
  serviceDate: string | null;
  patientType: string | null;     // OP / IP / ER
}

export interface ReportDoc {
  kind: 'radiology' | 'diagnostic' | 'hcu';
  url: string;
  date: string | null;
}

export type Coverage = 'rich' | 'order_only';

export interface EpisodeBundle {
  keys: EpisodeKeys;
  prescription: EpisodePrescription;
  orders: OrderedItem[];
  reports: ReportDoc[];
  coverage: Coverage;
}

// ── Validators (injection-safe gates; throw on bad input) ──────────────────────

export const isUid = (u: unknown): u is string => typeof u === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(u);
// kx UHIDs are short alphanumerics (may include a few separators); keep the gate tight.
export const isUhid = (u: unknown): u is string => typeof u === 'string' && /^[A-Za-z0-9/_-]{3,40}$/.test(u);
export const isDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

function reqUid(u: unknown, label: string): string { if (!isUid(u)) throw new Error(`ccb: bad ${label}`); return u; }
function reqUhid(u: unknown, label: string): string { if (!isUhid(u)) throw new Error(`ccb: bad ${label}`); return u; }
function reqDay(d: unknown, label: string): string { if (!isDay(d)) throw new Error(`ccb: bad ${label}`); return d; }

// ── Date helpers (pure) ────────────────────────────────────────────────────────

/** First 10 chars of an ISO date/timestamp → YYYY-MM-DD (throws if not a valid day). */
export function dayOf(ts: unknown): string {
  const s = String(ts ?? '').slice(0, 10);
  return reqDay(s, 'noteDate');
}

function addDaysIso(day: string, delta: number): string {
  const d = new Date(`${reqDay(day, 'day')}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Window around the note day. Reports usually land AFTER the visit → asymmetric default. */
export function bundleWindow(noteDay: string, back = 2, fwd = 5): { d0: string; d1: string } {
  return { d0: addDaysIso(noteDay, -Math.abs(back)), d1: addDaysIso(noteDay, Math.abs(fwd)) };
}

// ── SQL builders (validated interpolation, lib/metabase.ts style) ──────────────

const PRESC_COLS = [
  'uid', '_parent_id AS individual_uid', 'kx_encounter_id', 'doctor_uid', 'doctor_name_with_speciality',
  'consult_uid', 'consult_type', 'type_of_prescription', 'timestamp::text AS ts', 'prescription_url',
  'medications', 'diagnosis_icd_codes', 'impression_icd_codes', 'further_investigation', 'general_advice',
  'specialist_type_uids', 'in_house_specialist_type_uids',
  'general_practitioner_prescription__presenting_complaints AS presenting_complaint',
  'general_practitioner_prescription__plan_of_management AS plan_of_management',
].join(', ');

export function prescriptionSql(prescUid: string): string {
  const u = reqUid(prescUid, 'prescUid');
  return `SELECT ${PRESC_COLS} FROM "individuals-prescriptions" WHERE uid = '${u}' LIMIT 1`;
}

export function bridgeSql(individualUid: string): string {
  const i = reqUid(individualUid, 'individualUid');
  return `SELECT kx_uhid FROM individuals WHERE uid = '${i}' LIMIT 1`;
}

/** kx order ledger (what was DONE) by uhid within the window. Metadata only — no result body. */
export function ordersSql(kxUhid: string, d0: string, d1: string): string {
  const u = reqUhid(kxUhid, 'kxUhid'); const a = reqDay(d0, 'd0'); const b = reqDay(d1, 'd1');
  return (
    `SELECT 'lab' AS kind, service_name, treating_ordering_doctor AS ord, service_date::text AS service_date, patient_type` +
    ` FROM kx_lab_reports WHERE uhid = '${u}' AND service_date::date BETWEEN '${a}' AND '${b}'` +
    ` UNION ALL ` +
    `SELECT 'radiology', service_name, treating_ordering_doctor, service_date::text, patient_type` +
    ` FROM kx_radiology_reports WHERE uhid = '${u}' AND service_date::date BETWEEN '${a}' AND '${b}'` +
    ` ORDER BY service_date NULLS LAST`
  );
}

/** Result PDFs (the actual bodies) for a member within the window. radiology+diagnostic join
 *  child→parent (c._parent_id = p._id); hcu's URL is on the parent. */
export function reportsSql(individualUid: string, d0: string, d1: string): string {
  const i = reqUid(individualUid, 'individualUid'); const a = reqDay(d0, 'd0'); const b = reqDay(d1, 'd1');
  return (
    `SELECT 'radiology' AS kind, c.report_url AS url, p._create_time::text AS dt` +
    ` FROM "individuals-radiology_reports" p` +
    ` JOIN "individuals-radiology_reports-radiology_booking_reports" c ON c._parent_id = p._id` +
    ` WHERE p._parent_id = '${i}' AND p._create_time::date BETWEEN '${a}' AND '${b}' AND c.report_url IS NOT NULL` +
    ` UNION ALL ` +
    `SELECT 'diagnostic', c.report_url, p._create_time::text` +
    ` FROM "individuals-diagnostic_reports" p` +
    ` JOIN "individuals-diagnostic_reports-diagnostic_booking_reports" c ON c._parent_id = p._id` +
    ` WHERE p._parent_id = '${i}' AND p._create_time::date BETWEEN '${a}' AND '${b}' AND c.report_url IS NOT NULL` +
    ` UNION ALL ` +
    `SELECT 'hcu', coalesce(consolidated_report_url, report_url), _create_time::text` +
    ` FROM "individuals-hcu_bookings"` +
    ` WHERE _parent_id = '${i}' AND _create_time::date BETWEEN '${a}' AND '${b}'` +
    ` AND coalesce(consolidated_report_url, report_url) IS NOT NULL` +
    ` ORDER BY dt`
  );
}

// ── Row mappers (pure) ─────────────────────────────────────────────────────────

function toStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    try { const j = JSON.parse(v); if (Array.isArray(j)) return j.map((x) => String(x)).filter(Boolean); } catch { /* not json */ }
    return [v.trim()];
  }
  return [];
}

function str(v: unknown): string | null { const s = v == null ? '' : String(v).trim(); return s || null; }

/** Parse a "Dr. X(Speciality)" label → trailing-parens speciality (staff data, not PHI). */
export function specialityFromLabel(label: unknown): string | null {
  const m = String(label ?? '').match(/\(([^)]*)\)\s*$/);
  return m ? m[1].trim() || null : null;
}

export function mapPrescription(row: Record<string, unknown>): { keys: EpisodeKeys; prescription: EpisodePrescription } {
  const prescUid = reqUid(row.uid, 'prescUid');
  const individualUid = reqUid(row.individual_uid, 'individualUid');
  const keys: EpisodeKeys = {
    prescUid,
    individualUid,
    kxUhid: null,
    kxEncounterId: str(row.kx_encounter_id),
    doctorUid: str(row.doctor_uid),
    doctorSpeciality: specialityFromLabel(row.doctor_name_with_speciality),
    noteDate: dayOf(row.ts),
    consultType: str(row.consult_type),
    prescriptionType: str(row.type_of_prescription),
  };
  const prescription: EpisodePrescription = {
    url: str(row.prescription_url),
    meds: row.medications ?? null,
    dxCodes: toStrArray(row.diagnosis_icd_codes),
    impressionCodes: toStrArray(row.impression_icd_codes),
    furtherInvestigation: row.further_investigation ?? null,
    presentingComplaint: str(row.presenting_complaint),
    planOfManagement: str(row.plan_of_management),
    specialistReferral: Array.from(new Set([
      ...toStrArray(row.specialist_type_uids),
      ...toStrArray(row.in_house_specialist_type_uids),
    ])),
  };
  return { keys, prescription };
}

export function mapOrders(rows: Record<string, unknown>[]): OrderedItem[] {
  return (rows || []).map((r) => ({
    kind: r.kind === 'radiology' ? 'radiology' : 'lab',
    serviceName: str(r.service_name),
    orderedBy: str(r.ord),
    serviceDate: str(r.service_date),
    patientType: str(r.patient_type),
  }));
}

export function mapReports(rows: Record<string, unknown>[]): ReportDoc[] {
  const out: ReportDoc[] = [];
  for (const r of rows || []) {
    const url = str(r.url);
    if (!url) continue;
    const kind = r.kind === 'radiology' || r.kind === 'diagnostic' || r.kind === 'hcu' ? r.kind : 'diagnostic';
    out.push({ kind: kind as ReportDoc['kind'], url, date: str(r.dt) });
  }
  return out;
}

export function episodeCoverage(reports: ReportDoc[]): Coverage {
  return reports.length > 0 ? 'rich' : 'order_only';
}

/** Pure assembler — the wired layer fetches the four parts and calls this. */
export function buildBundle(
  keys: EpisodeKeys,
  prescription: EpisodePrescription,
  orders: OrderedItem[],
  reports: ReportDoc[],
): EpisodeBundle {
  return { keys, prescription, orders, reports, coverage: episodeCoverage(reports) };
}
