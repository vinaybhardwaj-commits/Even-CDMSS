/**
 * lib/opd-ingest-core.ts — map an `individuals-prescriptions` (db13) row into a
 * DE-IDENTIFIED OPD case for the note-quality audit. PURE (no db/llm), unit-testable.
 *
 * IMPORTANT (fixed 29 Jun): for medical consults the clinically-entered content lives in
 * the TYPE-SPECIFIC nested columns, NOT the top-level ones:
 *   - presenting complaints + HPI  → general_practitioner_prescription__presenting_complaints[].symptoms (HTML)
 *   - diagnoses / impressions      → …__presenting_complaints[].diagnoses[].{icd_code, diagnosis_or_impression, general_advice, treatment_plan}
 *   - advice / plan                → …__plan_of_management[].management_plan (HTML)  (+ top-level general_advice)
 *   - examination                  → …__examination (HTML)
 * The top-level presenting_complaints / relevant_medical_history / patient_details__allergies
 * columns are structurally empty for these notes — reading them produced false "(none documented)"
 * gaps. We now read the nested fields and fall back to top-level only when present.
 *
 * PHI posture: the de-identified case (clinical content only) is what the LLM sees. The
 * re-identification keys (uid/consult_uid/doctor_uid/kx_encounter_id) + the prescription PDF
 * url are returned SEPARATELY and never sent to the model.
 */

export interface OpdMed {
  generic?: string; brand?: string; strength?: string; dose?: string;
  frequency?: string; duration?: string; route?: string; instruction?: string;
  // Formulary enrichment (populated by the orchestrator from lib/formulary; optional so the
  // pure cores never import the formulary loader). resolvedGeneric is the molecule recovered
  // for a brand-only line; the rest is its EHRC formulary class / schedule / safety profile.
  resolvedGeneric?: string;
  therapeuticClass?: string;   // formulary Major Grouping
  subClass?: string;           // formulary Minor Grouping
  schedule?: string;           // D&C schedule: OTC | H | H1 | X | Biological
  highAlert?: boolean;         // ISMP high-alert medication
  lasa?: string[];             // look-alike/sound-alike confusables
  ved?: string;                // V | E | D
  restricted?: boolean;        // reserve/restricted antimicrobial
  formularyMatch?: 'source-generic' | 'brand-exact' | 'embedded-generic' | 'brand-token' | 'brand-prefix' | 'none';
  nonFormulary?: 'nutraceutical-cosmetic' | 'non-formulary';
}
export interface DeidOpdCase {
  consultType: string | null;
  reasonForConsult: string | null;
  presentingComplaints: string[];   // complaint + HPI (from nested symptoms)
  diagnosisCodes: string[];         // ICD-10
  impressionCodes: string[];        // ICD-10 (impression)
  impressions: string[];            // free-text impression / diagnosis names
  history: string[];
  comorbidities: string[];
  medications: OpdMed[];
  investigations: string[];         // ordered tests
  advice: string[];                 // CLINICIAN plan / management only (templated leaflets excluded)
  examination: string[];            // exam findings (often sparse)
  allergies: string | null;
  followUpType: string | null;
  followUpDateSet: boolean;
  // 0.6 — encounter context so the audit doesn't misread a teleconsult referral handoff as a
  // definitive in-person treatment episode. Optional so existing DeidOpdCase literals stay valid.
  patientEducation?: string[];      // auto-attached templated leaflets (self-care text, video links) — NOT clinician documentation
  isTeleconsult?: boolean;          // remote consult → no physical examination expected
  referrals?: string[];             // onward referrals, e.g. "In-Person Orthopedics (Even-recommended)"
  numReferrals?: number;
  isReferralHandoff?: boolean;      // triage/handoff (referred onward) — not definitive management
}
export interface OpdKeys {
  uid: string | null; consultUid: string | null; doctorUid: string | null;
  kxEncounterId: string | null; consultType: string | null; prescriptionType: string | null;
  noteDate: string | null;          // ISO date string of the note (source timestamp)
  prescriptionUrl: string | null;   // link to the actual prescription PDF (for hand-audit)
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
function uniq(a: string[]): string[] { return [...new Set(a.map((x) => x.trim()).filter(Boolean))]; }

// HTML (the symptoms/plan/exam fields are rich-text) → plain text lines.
function htmlToLines(html: unknown): string[] {
  const s = str(html);
  if (!s) return [];
  const text = s
    .replace(/<\/(li|p|div|h[1-6]|ul|ol|tr)>/gi, '\n')
    .replace(/<br\s*\/?>(?!\n)/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ');
  return text.split('\n').map((x) => x.trim().replace(/^[-•*]\s*/, '')).filter((x) => x && x !== '---');
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

// ── nested GP-structure readers (the canonical content for medical consults) ──
function gpComplaints(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; out.push(...htmlToLines(o.symptoms)); }
  return uniq(out);
}
function gpImpressions(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; for (const d of asArr(o.diagnoses)) { const dd = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>; const name = strOrNull(dd.diagnosis_or_impression); if (name) out.push(name); } }
  return uniq(out);
}
// The clinician's per-diagnosis treatment_plan (real documentation).
function gpDiagTreatment(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; for (const d of asArr(o.diagnoses)) { const dd = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>; out.push(...htmlToLines(dd.treatment_plan)); } }
  return out;
}
// The per-diagnosis general_advice — in this EMR this is an AUTO-ATTACHED templated patient leaflet
// (generic self-care text + video links), NOT clinician-authored. Kept OUT of clinician `advice` so
// the audit doesn't grade boilerplate as documentation quality. (0.6 bug fix — bit the Band-A lumbago
// referral note: plan was only "Medical management" but a full NHS back-pain leaflet was being graded.)
function gpDiagEducation(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; for (const d of asArr(o.diagnoses)) { const dd = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>; out.push(...htmlToLines(dd.general_advice)); } }
  return out;
}

// A line is templated patient-education if it carries a self-care video / external link.
const EDU_URL_RE = /(https?:\/\/|www\.|youtube\.com|youtu\.be)/i;

// Even's GP e-consults are teleconsults by default; in-person is the referral destination.
const GP_TELE_TYPES = new Set(['GENERAL_PRACTITIONER', 'HOSPITAL_GP', 'HOSPITAL_GP_INVESTIGATION_REFERRAL']);
export function isTeleconsultEncounter(prescriptionType: string | null, consultType: string | null): boolean {
  const ct = (consultType || '').toUpperCase();
  if (/IN[_\s-]?PERSON|PHYSICAL|WALK[_\s-]?IN/.test(ct)) return false;
  if (/TELE|VIDEO|AUDIO|CHAT|REMOTE|ONLINE/.test(ct)) return true;
  return GP_TELE_TYPES.has((prescriptionType || '').toUpperCase());
}

/** refer_to (jsonb array) → readable onward-referral labels, e.g. "In-Person Orthopedics (Even-recommended)". */
export function parseReferrals(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const st = (o.specialist_type && typeof o.specialist_type === 'object' ? o.specialist_type : {}) as Record<string, unknown>;
    const name = strOrNull(st.name) || strOrNull(o.name) || 'specialist';
    const inHouse = st.is_in_house === true || o.is_in_house === true;
    const mode = inHouse ? 'In-house' : 'In-Person';
    const even = o.recommended_by_even === true ? ' (Even-recommended)' : '';
    out.push(`${mode} ${name}${even}`);
  }
  return uniq(out);
}
function planAdvice(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; out.push(...htmlToLines(o.management_plan)); }
  return out;
}

// ── flattened pipeline (dpipe_prescription_pipeline) readers — clean PRIMARY content ─────
// presenting_complaint is plain text (complaint + HOPI narrative); diagnosis carries readable
// names + icd codes; plan_of_management is the advice. Used first, with the nested/top-level
// source fields as fallback (so the ~11% of notes the pipeline leaves empty don't regress).
function dpipeText(v: unknown): string[] { const s = str(v); return s ? [s] : []; }
function dpipeDx(v: unknown): { names: string[]; codes: string[] } {
  const names: string[] = []; const codes: string[] = [];
  for (const it of asArr(v)) {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const nm = strOrNull(o.diagnosis); if (nm) names.push(nm);
    const code = strOrNull(o.icd_code); if (code) codes.push(code);
  }
  return { names: uniq(names), codes: uniq(codes) };
}
function dpipePlan(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; out.push(...htmlToLines(o.management_plan)); }
  return out;
}
function dpipeInvestigations(v: unknown): string[] {
  return asArr(v).map((it) => { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; return strOrNull(o.name) || ''; }).filter(Boolean);
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
  const gpPc = row['general_practitioner_prescription__presenting_complaints'];
  const dpx = dpipeDx(row.dpipe_dx);

  const advObj = asObj(row.general_advice);
  const topAdvice: string[] = Array.isArray(advObj)
    ? advObj.map((x) => str(x)).filter(Boolean)
    : (advObj && typeof advObj === 'object' ? Object.values(advObj as Record<string, unknown>).map(str).filter(Boolean) : textsFrom(row.general_advice, ['text', 'advice']));

  // CONTENT: flattened pipeline (dpipe) primary → source nested → top-level fallback.
  // 0.6 — templated patient-education (per-dx general_advice leaflet + any line with a self-care
  // video/link) is separated OUT of the clinician plan so it isn't graded as documentation quality.
  const dPlan = dpipePlan(row.dpipe_pom);
  const clinicianAdviceRaw = uniq(dPlan.length ? dPlan : [...planAdvice(row['general_practitioner_prescription__plan_of_management']), ...gpDiagTreatment(gpPc), ...topAdvice]);
  const advice = clinicianAdviceRaw.filter((l) => !EDU_URL_RE.test(l));
  const patientEducation = uniq([...gpDiagEducation(gpPc), ...clinicianAdviceRaw.filter((l) => EDU_URL_RE.test(l))]);
  const referrals = parseReferrals(row.refer_to);
  const numReferrals = Number(row.num_referrals) || referrals.length;
  const followUpTypeVal = strOrNull(row.followup__followup_type) || strOrNull(row.follow_up_type);
  const isReferralHandoff = referrals.length > 0 || numReferrals > 0 || /referral/i.test(followUpTypeVal || '');
  const isTeleconsult = isTeleconsultEncounter(strOrNull(row.type_of_prescription), strOrNull(row.consult_type));

  const dComplaints = dpipeText(row.dpipe_pc);
  const nestedComplaints = gpComplaints(gpPc);
  const presentingComplaints = dComplaints.length ? dComplaints
    : (nestedComplaints.length ? nestedComplaints : textsFrom(row.presenting_complaints, ['complaint', 'name', 'text', 'value', 'title']));

  const dInv = dpipeInvestigations(row.dpipe_inv);
  const investigations = dInv.length ? dInv : investigationsFrom(row.further_investigation);

  const followUpDateSet = !!strOrNull(row.next_follow_up_date) || !!strOrNull(row.followup__followup_date) || !!strOrNull(row.expected_resolution_date);

  const oc: DeidOpdCase = {
    consultType: strOrNull(row.consult_type),
    reasonForConsult: strOrNull(row.reason_for_consultation),
    presentingComplaints,
    diagnosisCodes: uniq([...codesFrom(row.diagnosis_icd_codes), ...dpx.codes]),
    impressionCodes: codesFrom(row.impression_icd_codes),
    impressions: dpx.names.length ? dpx.names : gpImpressions(gpPc),
    history: textsFrom(row.relevant_medical_history, ['text', 'name', 'value', 'condition']),
    comorbidities: textsFrom(row.comorbidities, ['name', 'text', 'condition', 'value']),
    medications: medsFrom(row.medications),
    investigations,
    advice,
    examination: htmlToLines(row['general_practitioner_prescription__examination']),
    allergies: strOrNull(row.patient_details__allergies),
    followUpType: followUpTypeVal,
    followUpDateSet,
    patientEducation,
    isTeleconsult,
    referrals,
    numReferrals,
    isReferralHandoff,
  };

  const keys: OpdKeys = {
    uid: strOrNull(row.uid) || strOrNull(row._id),
    consultUid: strOrNull(row.consult_uid),
    doctorUid: strOrNull(row.doctor_uid),
    kxEncounterId: strOrNull(row.kx_encounter_id),
    consultType: strOrNull(row.consult_type),
    prescriptionType: strOrNull(row.type_of_prescription),
    noteDate: strOrNull(row.timestamp) || strOrNull(row._create_time) || strOrNull(row.uploaded_at),
    prescriptionUrl: strOrNull(row.prescription_url),
  };

  return { case: oc, keys };
}

/** One medication line for the LLM, with formulary enrichment when present. */
export function formatOpdMed(m: OpdMed): string {
  const primary = m.resolvedGeneric || m.generic || m.brand || '?';
  const hasGeneric = !!(m.resolvedGeneric || m.generic);
  const brandPart = m.brand && hasGeneric && m.brand.toLowerCase() !== primary.toLowerCase()
    ? ` (brand: ${m.brand})` : '';
  const dosing = [m.strength, m.dose, m.frequency, m.duration, m.route].filter(Boolean).join(', ');
  const tags: string[] = [];
  if (m.therapeuticClass) tags.push(m.therapeuticClass);
  if (m.schedule && m.schedule !== '—') tags.push(`Sch ${m.schedule}`);
  if (m.highAlert) tags.push('HIGH-ALERT (ISMP)');
  if (m.restricted) tags.push('reserve antimicrobial');
  if (m.formularyMatch === 'brand-prefix') tags.push('≈approx match');
  if (m.nonFormulary === 'nutraceutical-cosmetic') tags.push('nutraceutical/cosmetic — not a formulary drug');
  else if (m.nonFormulary === 'non-formulary') tags.push('not in hospital formulary');
  return `${primary}${brandPart}${dosing ? `, ${dosing}` : ''}${m.instruction ? ` (${m.instruction})` : ''}${tags.length ? ` [${tags.join('; ')}]` : ''}`;
}

/** Compact one-line-ish text summary of the de-identified case for the LLM prompt. */
export function opdCaseText(c: DeidOpdCase): string {
  const lines: string[] = [];
  if (c.consultType) lines.push(`Consult type: ${c.consultType}`);
  if (c.isTeleconsult) lines.push('Encounter modality: TELECONSULT (remote) — a physical examination is not expected; its absence is not a gap.');
  if (c.referrals && c.referrals.length) lines.push(`Referred onward to: ${c.referrals.join('; ')}`);
  if (c.isReferralHandoff) lines.push('Disposition: REFERRAL / HANDOFF encounter — the plan is the onward referral, not definitive treatment. The absence of medications, investigations or imaging is EXPECTED for a handoff and must NOT be read as a deliberate management decision or "avoidance".');
  if (c.reasonForConsult) lines.push(`Reason for consult: ${c.reasonForConsult}`);
  lines.push(`Presenting complaints / history: ${c.presentingComplaints.length ? c.presentingComplaints.join('; ') : '(none documented)'}`);
  lines.push(`Diagnosis (ICD-10): ${c.diagnosisCodes.length ? c.diagnosisCodes.join(', ') : '(none documented)'}`);
  if (c.impressions.length) lines.push(`Impression: ${c.impressions.join('; ')}`);
  if (c.impressionCodes.length) lines.push(`Impression (ICD-10): ${c.impressionCodes.join(', ')}`);
  if (c.examination.length) lines.push(`Examination: ${c.examination.join('; ')}`);
  if (c.history.length) lines.push(`Relevant history: ${c.history.join('; ')}`);
  if (c.comorbidities.length) lines.push(`Comorbidities: ${c.comorbidities.join('; ')}`);
  if (c.allergies) lines.push(`Allergies documented: ${c.allergies}`);
  lines.push(`Medications (${c.medications.length})  [drug class · D&C schedule · safety tags from the EHRC formulary; "brand:" = the note gave only a proprietary name]:`);
  for (const m of c.medications) {
    lines.push(`  - ${formatOpdMed(m)}`);
  }
  lines.push(`Investigations ordered: ${c.investigations.length ? c.investigations.join('; ') : '(none)'}`);
  lines.push(`Clinician advice / plan: ${c.advice.length ? c.advice.join('; ') : '(none documented)'}`);
  if (c.patientEducation && c.patientEducation.length) {
    lines.push(`Patient-education material attached: ${c.patientEducation.length} item(s) of AUTO-GENERATED templated self-care leaflet (generic exercises / video links). This is NOT clinician-authored documentation — do NOT count it toward note thoroughness, usefulness or synthesis.`);
  }
  lines.push(`Follow-up: ${c.followUpType || '(none)'}${c.followUpDateSet ? ' (date set)' : ' (no date)'}`);
  return lines.join('\n');
}
