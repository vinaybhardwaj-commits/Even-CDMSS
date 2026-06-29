/**
 * lib/metabase.ts — read db13 (`individuals-prescriptions`) THROUGH the Metabase API.
 *
 * Server-only. Uses METABASE_URL + METABASE_API_KEY (header `x-api-key`) against Metabase's
 * /api/dataset native-query endpoint — no `pg` driver, no new DB credential, no firewall
 * change. Powers the M2 OPD note-quality daily worker. Read-only by construction (we only
 * ever SELECT); identifiers stay in db13 and on the audit row, never in the LLM payload.
 */

const DB13 = 13;
const TABLE = '"individuals-prescriptions"';

// Consult types where the NABH OPD completeness checklist (complaint / history / allergy /
// dosing / advice / follow-up) genuinely applies. Allied-health types (DIETARY / PHYSIO /
// nutrition) are deferred until their checklists are made type-aware (PRD §11).
export const OPD_MEDICAL_TYPES = [
  'GENERAL_PRACTITIONER', 'HOSPITAL_GP', 'HOSPITAL_GYNAECOLOGY_ASSESSMENT',
  'HOSPITAL_PAEDIATRIC', 'HOSPITAL_GYNAECOLOGY_OBSTETRICS', 'HOSPITAL_GP_INVESTIGATION_REFERRAL',
];

// Exactly the columns the ingest adapter (rowToOpdCase) reads. All exist on db13 (verified).
const ENGINE_COLUMNS = [
  'uid', 'consult_uid', 'doctor_uid', 'kx_encounter_id', 'type_of_prescription', 'consult_type',
  'timestamp', '_create_time',
  'presenting_complaints', 'diagnosis_icd_codes', 'impression_icd_codes', 'medications',
  'further_investigation', 'general_advice', 'patient_details__allergies',
  'followup__followup_type', 'followup__followup_date', 'follow_up_type', 'next_follow_up_date',
  'expected_resolution_date', 'relevant_medical_history', 'comorbidities', 'reason_for_consultation',
];

function base(): string {
  const u = process.env.METABASE_URL;
  if (!u) throw new Error('METABASE_URL is not set');
  return u.replace(/\/+$/, '');
}
function apiKey(): string {
  const k = process.env.METABASE_API_KEY;
  if (!k) throw new Error('METABASE_API_KEY is not set');
  return k;
}

/** Run a native SQL query against db13 via Metabase /api/dataset. Returns rows as objects. */
export async function metabaseQuery(query: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${base()}/api/dataset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey() },
    body: JSON.stringify({ database: DB13, type: 'native', native: { query } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Metabase HTTP ${res.status}: ${text.slice(0, 400)}`);
  let j: { status?: string; error?: unknown; data?: { rows?: unknown[][]; cols?: { name: string }[] } };
  try { j = JSON.parse(text); } catch { throw new Error('Metabase: non-JSON response'); }
  if (j?.status === 'failed' || j?.error) throw new Error(`Metabase query failed: ${String(j.error ?? '').slice(0, 300)}`);
  const cols = (j?.data?.cols ?? []).map((c) => c.name);
  const rows = j?.data?.rows ?? [];
  return rows.map((r) => { const o: Record<string, unknown> = {}; cols.forEach((c, i) => { o[c] = r[i]; }); return o; });
}

const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const quotedTypes = () => OPD_MEDICAL_TYPES.map((t) => `'${t}'`).join(', ');
// Encounters are timestamped in IST; a "day" is an Asia/Kolkata calendar day.
const dayPredicate = (day: string) => `(timestamp AT TIME ZONE 'Asia/Kolkata')::date = '${day}'`;
const baseWhere = (day: string) =>
  `is_draft = false AND type_of_prescription IN (${quotedTypes()}) AND ${dayPredicate(day)}`;

/** Count non-draft medical notes for an IST calendar day. */
export async function countOpdNotesForDay(day: string): Promise<number> {
  if (!isDay(day)) throw new Error('bad day (YYYY-MM-DD)');
  const rows = await metabaseQuery(`SELECT count(*)::int AS n FROM ${TABLE} WHERE ${baseWhere(day)}`);
  return Number(rows[0]?.n ?? 0);
}

/** Next page of non-draft medical notes for the day, excluding already-audited uids. */
export async function fetchOpdNotesForDay(day: string, excludeUids: string[], limit: number): Promise<Record<string, unknown>[]> {
  if (!isDay(day)) throw new Error('bad day (YYYY-MM-DD)');
  const ex = (excludeUids || []).filter(isUid);
  const notIn = ex.length ? ` AND uid NOT IN (${ex.map((u) => `'${u}'`).join(', ')})` : '';
  const lim = Math.max(1, Math.min(50, Math.floor(limit)));
  return metabaseQuery(
    `SELECT ${ENGINE_COLUMNS.join(', ')} FROM ${TABLE} WHERE ${baseWhere(day)}${notIn} ORDER BY timestamp ASC LIMIT ${lim}`,
  );
}

/** Fetch a single note by uid (for spot-check / ?uid= self-fetch). */
export async function fetchOpdNoteByUid(uid: string): Promise<Record<string, unknown> | null> {
  if (!isUid(uid)) throw new Error('bad uid');
  const rows = await metabaseQuery(`SELECT ${ENGINE_COLUMNS.join(', ')} FROM ${TABLE} WHERE uid = '${uid}' LIMIT 1`);
  return rows[0] ?? null;
}

/** Bulk fetch notes by uid (for the no-LLM completeness backfill). */
export async function fetchOpdNotesByUids(uids: string[]): Promise<Record<string, unknown>[]> {
  const ex = Array.from(new Set((uids || []).filter(isUid)));
  if (!ex.length) return [];
  const inList = ex.map((u) => `'${u}'`).join(', ');
  return metabaseQuery(`SELECT ${ENGINE_COLUMNS.join(', ')} FROM ${TABLE} WHERE uid IN (${inList})`);
}

/** Map doctor_uid → display name (db13 `doctors.name_with_prefix`). Names are staff data,
 *  not PHI; used to label the OPD Audit per-doctor view. Best-effort; missing uids omitted. */
export async function fetchDoctorNames(uids: string[]): Promise<Record<string, string>> {
  const ex = Array.from(new Set((uids || []).filter(isUid)));
  if (!ex.length) return {};
  const inList = ex.map((u) => `'${u}'`).join(', ');
  const rows = await metabaseQuery(
    `SELECT uid, name_with_prefix FROM doctors WHERE uid IN (${inList})`,
  );
  const map: Record<string, string> = {};
  for (const r of rows) {
    const u = String(r.uid || '');
    const nm = r.name_with_prefix ? String(r.name_with_prefix).trim() : '';
    if (u && nm) map[u] = nm;
  }
  return map;
}

/** YYYY-MM-DD for the IST calendar day before `now` (the default daily-audit target). */
export function istYesterday(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}
/** YYYY-MM-DD for the current IST calendar day. */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
