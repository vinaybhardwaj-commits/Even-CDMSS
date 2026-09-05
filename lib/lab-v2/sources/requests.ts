/**
 * lib/lab-v2/sources/requests.ts — freezing a request body as a case, and decision 34's gate
 * (LAB-MCP-V2-PRD-v1.0 §3.3, §17.3).
 *
 * ⚠️ THIS FILE PERFORMS NO READ. Round 1's `sources/opd.ts` had to reach db13 and Neon to freeze
 * an OPD note, because the case key was a uid and the inputs lived elsewhere. The five round-A3
 * engines take their whole case IN THE REQUEST BODY — a question, a scenario, an extracted case —
 * so freezing one is a validation and a hash, not a query. There is no new SQL in this round.
 *
 * ⚠️ DECISION 34 IS A GATE, NOT A LABEL. §3.3 says the research key can never mint an
 * `identifying` object. So `dataset_create` for these engines REFUSES a body carrying an
 * identifying field with `CLASSIFICATION_REQUIRED`, rather than storing it and marking it. The
 * field lists below were read out of the five route handlers on 05 Sep 2026, and every one of the
 * five survived: none of them reads a member id, an encounter id, a name, a phone number or any
 * other field that names or resolves to a person.
 *
 * ⚠️ AND THE GATE IS A DENYLIST OVER THE WHOLE BODY, not a check of the known fields. A caller
 * can put anything in a JSON body; checking only the fields the handler reads would let
 * `{question: "…", member_id: "M-1"}` through on the grounds that the handler ignores
 * `member_id`. It would still be stored, in a research object, forever. So every key in the body,
 * at every depth, is checked against the pattern below.
 */
import { createHash } from 'crypto';
import { LabError, type EngineId } from '../contracts';

/**
 * A key that names or resolves to a person. Deliberately broad and deliberately about the KEY,
 * not the value: a value-level PHI detector would be a guess, and decision 34 says do not guess
 * at de-identification. A body that legitimately needs one of these belongs in Slice D.
 */
const IDENTIFYING_KEY =
  /^(.*_)?(member|patient|person|subject|doctor|clinician|provider)_?(id|uid|uuid|key|no|number)$|^(uhid|mrn|nric|aadhaar|ssn)$|^(.*_)?(encounter|consult|visit|admission|episode|prescription)_?(id|uid|no)$|^(.*_)?(name|full_?name|first_?name|last_?name|surname)$|^(.*_)?(phone|mobile|msisdn|email|address|dob|date_?of_?birth)$/i;

/** Every key in a body, at every depth. Arrays are walked; their indices are not keys. */
export function allKeys(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.push(k);
    allKeys(v, out, depth + 1);
  }
  return out;
}

/** The identifying keys a body carries, in the order found. Empty means it may be frozen. */
export function identifyingKeys(body: unknown): string[] {
  return [...new Set(allKeys(body).filter((k) => IDENTIFYING_KEY.test(k)))];
}

/**
 * The request fields each handler READS, and whether each is identifying. This is the evidence
 * decision 34 asks the builder to produce, kept in the code so it is checked rather than
 * remembered: `engine_describe` reports it, and a test asserts every entry is non-identifying
 * for every supported engine.
 */
export interface RequestField { name: string; identifying: boolean; note?: string }

export const REQUEST_FIELDS: Partial<Record<EngineId, readonly RequestField[]>> = {
  ask: [
    { name: 'question', identifying: false, note: 'free clinical text, the query itself' },
    { name: 'investigations', identifying: false, note: 'free text, parsed by a governed stage' },
    { name: 'bookFilter', identifying: false },
    { name: 'multiQuery', identifying: false },
    { name: 'selfCritique', identifying: false },
    { name: 'useReranker', identifying: false },
    { name: 'useSourceWeights', identifying: false },
    { name: 'useEmbeddingV2', identifying: false },
    { name: 'includePlos', identifying: false },
    { name: 'providerOverride', identifying: false },
    { name: 'labModel', identifying: false, note: 'never set by the lab — routing is the arm\'s' },
  ],
  ddx: [
    { name: 'cc', identifying: false, note: 'chief complaint, free clinical text' },
    { name: 'age', identifying: false, note: 'demographic, not an identifier on its own' },
    { name: 'sex', identifying: false, note: 'demographic, not an identifier on its own' },
    { name: 'history', identifying: false },
    { name: 'exam', identifying: false },
    { name: 'vitals', identifying: false },
    { name: 'investigations', identifying: false },
    { name: 'engine', identifying: false },
    { name: 'multiQuery', identifying: false },
    { name: 'selfCritique', identifying: false },
    { name: 'includePlos', identifying: false },
    { name: 'providerOverride', identifying: false },
    { name: 'labModel', identifying: false, note: 'never set by the lab' },
  ],
  appropriateness: [
    { name: 'scenario', identifying: false, note: 'free clinical text' },
    { name: 'proposedActions', identifying: false },
    { name: 'patient.age', identifying: false },
    { name: 'patient.sex', identifying: false },
    { name: 'regionFilter', identifying: false },
    { name: 'preferRegion', identifying: false },
    { name: 'providerOverride', identifying: false },
  ],
  pathway: [
    { name: 'scenario', identifying: false, note: 'free clinical text' },
    { name: 'proposedActions', identifying: false },
    { name: 'patient.age', identifying: false },
    { name: 'patient.sex', identifying: false },
    { name: 'providerOverride', identifying: false },
  ],
  doc_audit: [
    { name: 'extracted.docType', identifying: false },
    { name: 'extracted.detectedDocType', identifying: false },
    { name: 'extracted.confidence', identifying: false },
    { name: 'extracted.patient.age', identifying: false },
    { name: 'extracted.patient.sex', identifying: false },
    { name: 'extracted.diagnosis', identifying: false },
    { name: 'extracted.indication', identifying: false },
    { name: 'extracted.procedure', identifying: false },
    { name: 'extracted.investigations', identifying: false },
    { name: 'extracted.treatments', identifying: false },
    { name: 'extracted.medications', identifying: false },
    { name: 'extracted.courseSummary', identifying: false },
    { name: 'extracted.disposition', identifying: false },
    { name: 'extracted.followUp', identifying: false },
    { name: 'extracted.rawNotes', identifying: false, note: 'the type documents it as de-identified: no name, no UHID' },
    { name: 'extracted.completeness', identifying: false, note: 'status-only; never carries a field value' },
    { name: 'extracted.adminFacts', identifying: false, note: 'lengthOfStayDays, admissionType, careSetting' },
    { name: 'extracted.riskFactors', identifying: false },
    { name: 'extracted.aftercare', identifying: false },
    { name: 'extracted.verbatimSections', identifying: false, note: 'copied clinical blocks, de-identified upstream' },
    { name: 'providerOverride', identifying: false },
  ],
};

export function requestFieldsFor(engine: EngineId): readonly RequestField[] {
  return REQUEST_FIELDS[engine] ?? [];
}

/** True when the engine cannot run at all without an identifying field (§34). None of the five. */
export function requiresIdentifyingInput(engine: EngineId): boolean {
  return requestFieldsFor(engine).some((f) => f.identifying);
}

export interface FrozenRequestCase {
  case_key: string;
  member_key: string | null;
  frozen: { engine: EngineId; body: Record<string, unknown> };
  source_versions: Record<string, unknown>;
}

/**
 * Freeze one request body as a case.
 *
 * @throws LabError CLASSIFICATION_REQUIRED when the body carries an identifying key.
 * @throws LabError INVALID_INPUT when the body is not a JSON object.
 */
export function freezeRequestCase(engine: EngineId, body: unknown): FrozenRequestCase {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new LabError('INVALID_INPUT', 'request body must be a JSON object');
  }
  const offending = identifyingKeys(body);
  if (offending.length) {
    throw new LabError(
      'CLASSIFICATION_REQUIRED',
      `the request body carries identifying field(s): ${offending.join(', ')}. Slice A stores only de-identified objects (§3.3).`,
    );
  }
  const clean = body as Record<string, unknown>;
  // The case key is the body's own hash: the same body is the same case, across datasets and
  // across principals, which is what makes two runs comparable without a shared uid.
  const case_key = `req:${createHash('sha256').update(JSON.stringify(clean)).digest('hex').slice(0, 32)}`;
  return {
    case_key,
    member_key: null,
    frozen: { engine, body: clean },
    source_versions: { origin: 'request_body', frozen_at: new Date().toISOString() },
  };
}
