/**
 * lib/opd-ingest-core.ts — map an `individuals-prescriptions` (db13) row into a
 * DE-IDENTIFIED OPD case for the note-quality audit. PURE (no db/llm), unit-testable.
 *
 * PHI posture: the de-identified case (clinical content only — complaints, ICD,
 * medications, advice, follow-up) is what the LLM sees. The re-identification keys
 * (uid/consult_uid/doctor_uid/kx_encounter_id) are returned SEPARATELY and never sent
 * to the model — they live only in the audit row so an admin can join back to source.
 *
 * Firestore→Postgres rows arrive with JSONB either already parsed (objects/arrays) or
 * as JSON strings, so every accessor here tolerates both.
 */

export interface OpdMed {
  generic?: string; brand?: string; strength?: string; dose?: string;
  frequency?: string; duration?: string; route?: string; instruction?: string;
}
export interface DeidOpdCase {
  consultType: string | null;
  reasonForConsult: string | null;
  presentingComplaints: string[];
  diagnosisCodes: string[];      // ICD-10
  impressionCodes: string[];
  history: string[];
  comorbidities: string[];
  medications: OpdMed[];
  investigations: string[];      // ordered tests
  advice: string[];
  allergies: string | null;      // documented? (text or null)
  followUpType: string | null;
  followUpDateSet: boolean;
}
export interface OpdKeys {
  uid: string | null; consultUid: string | null; doctorUid: string | null;
  kxEncounterId: string | null; consultType: string | null; prescriptionType: string | null;
  noteDate: string | null;       // ISO date string of the note (source timestamp)
}

// ── coercers tolerant of parsed-or-stringified JSONB ─────────────────────────
function asObj(v: unknown): Record<string, unknown> | unknown[] | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as Record<string, unknown> | unknown[];
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === 'null') return null;
    try { return JSON.parse(s); } catch { return null; }
  }
  return null;
}
function asArr(v: unknown): unknown[] {
  const o = asObj(v);
  if (Array.isArray(o)) return o;
  // pg text[] arrives as a real JS array already; some drivers give "{a,b}" — handle lightly
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
    return v.slice(1, -1).split(',').map((x) => x.replace(/^"|"$/g, '').trim()).filter(Boolean);
  }
  return o && typeof o === 'object' ? [] : [];
}
function str(v: unknown): string { return v == null ? '' : String(v).trim(); }
function strOrNull(v: unknown): string | null { const s = str(v); return s ? s : null; }
function firstKey(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) { const s = str(o[k]); if (s) return s; }
  return '';
}

/** Pull short strings out of an array of {…} complaint/history objects or plain strings. */
function textsFrom(v: unknown, keys: string[]): string[] {
  return asArr(v).map((it) => {
    if (it == null) return '';
    if (typeof it === 'string') return it.trim();
    if (typeof it === 'object') return firstKey(it as Record<string, unknown>, keys);
    return '';
  }).filter(Boolean);
}

function medsFrom(v: unknown): OpdMed[] {
  return asArr(v).map((it) => {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const m: OpdMed = {
      generic: strOrNull(o.generic_name) || undefined,
      brand: strOrNull(o.brand_name) || undefined,
      strength: strOrNull(o.strength) || undefined,
      dose: strOrNull(o.dosage) || undefined,
      frequency: strOrNull(o.frequency) || undefined,
      duration: strOrNull(o.duration) || undefined,
      route: strOrNull(o.route_of_administration) || undefined,
      instruction: strOrNull(o.instruction_to_patient) || undefined,
    };
    return m;
  }).filter((m) => m.generic || m.brand);
}

function investigationsFrom(v: unknown): string[] {
  return asArr(v).map((it) => {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const inv = o.investigation;
    if (inv && typeof inv === 'object') return firstKey(inv as Record<string, unknown>, ['name', 'display_name']);
    return firstKey(o, ['name', 'investigation', 'display_name']);
  }).filter(Boolean);
}

function codesFrom(v: unknown): string[] {
  return asArr(v).map((x) => str(x)).filter(Boolean);
}

/** Map a raw prescriptions row → { case (de-identified), keys (for join-back) }. */
export function rowToOpdCase(row: Record<string, unknown>): { case: DeidOpdCase; keys: OpdKeys } {
  const advObj = asObj(row.general_advice);
  const advice: string[] = Array.isArray(advObj)
    ? advObj.map((x) => str(x)).filter(Boolean)
    : (advObj && typeof advObj === 'object' ? Object.values(advObj as Record<string, unknown>).map(str).filter(Boolean) : textsFrom(row.general_advice, ['text', 'advice']));

  const followUpDateSet = !!strOrNull(row.next_follow_up_date) || !!strOrNull(row.followup__followup_date) || !!strOrNull(row.expected_resolution_date);

  const oc: DeidOpdCase = {
    consultType: strOrNull(row.consult_type),
    reasonForConsult: strOrNull(row.reason_for_consultation),
    presentingComplaints: textsFrom(row.presenting_complaints, ['complaint', 'name', 'text', 'value', 'title']),
    diagnosisCodes: codesFrom(row.diagnosis_icd_codes),
    impressionCodes: codesFrom(row.impression_icd_codes),
    history: textsFrom(row.relevant_medical_history, ['text', 'name', 'value', 'condition']),
    comorbidities: textsFrom(row.comorbidities, ['name', 'text', 'condition', 'value']),
    medications: medsFrom(row.medications),
    investigations: investigationsFrom(row.further_investigation),
    advice,
    allergies: strOrNull(row.patient_details__allergies),
    followUpType: strOrNull(row.followup__followup_type) || strOrNull(row.follow_up_type),
    followUpDateSet,
  };

  const keys: OpdKeys = {
    uid: strOrNull(row.uid) || strOrNull(row._id),
    consultUid: strOrNull(row.consult_uid),
    doctorUid: strOrNull(row.doctor_uid),
    kxEncounterId: strOrNull(row.kx_encounter_id),
    consultType: strOrNull(row.consult_type),
    prescriptionType: strOrNull(row.type_of_prescription),
    noteDate: strOrNull(row.timestamp) || strOrNull(row._create_time) || strOrNull(row.uploaded_at),
  };

  return { case: oc, keys };
}

/** Compact one-line-ish text summary of the de-identified case for the LLM prompt. */
export function opdCaseText(c: DeidOpdCase): string {
  const lines: string[] = [];
  if (c.consultType) lines.push(`Consult type: ${c.consultType}`);
  if (c.reasonForConsult) lines.push(`Reason for consult: ${c.reasonForConsult}`);
  lines.push(`Presenting complaints: ${c.presentingComplaints.length ? c.presentingComplaints.join('; ') : '(none documented)'}`);
  lines.push(`Diagnosis (ICD-10): ${c.diagnosisCodes.length ? c.diagnosisCodes.join(', ') : '(none documented)'}`);
  if (c.impressionCodes.length) lines.push(`Impression (ICD-10): ${c.impressionCodes.join(', ')}`);
  if (c.history.length) lines.push(`Relevant history: ${c.history.join('; ')}`);
  if (c.comorbidities.length) lines.push(`Comorbidities: ${c.comorbidities.join('; ')}`);
  lines.push(`Allergies documented: ${c.allergies ? c.allergies : '(not documented)'}`);
  lines.push(`Medications (${c.medications.length}):`);
  for (const m of c.medications) {
    lines.push(`  - ${m.generic || m.brand || '?'}${m.strength ? ` ${m.strength}` : ''}${m.dose ? `, ${m.dose}` : ''}${m.frequency ? `, ${m.frequency}` : ''}${m.duration ? `, ${m.duration}` : ''}${m.route ? `, ${m.route}` : ''}${m.instruction ? ` (${m.instruction})` : ''}`);
  }
  lines.push(`Investigations ordered: ${c.investigations.length ? c.investigations.join('; ') : '(none)'}`);
  lines.push(`Advice: ${c.advice.length ? c.advice.join('; ') : '(none documented)'}`);
  lines.push(`Follow-up: ${c.followUpType || '(none)'}${c.followUpDateSet ? ' (date set)' : ' (no date)'}`);
  return lines.join('\n');
}
