// lib/proms/catalog.ts — Care-Call 0.2 PROMs/PREMs FROZEN catalog as typed DATA (prom-catalog/0.1 +
// hs-sets/0.1). PURE data + trivial lookups; no logic (the compiler selects/schedules, never writes
// item text). HOUSE items are VERBATIM from CDMSS-PROMS-HOUSE-ITEM-SETS-v0 (hs-sets/0.1). VALIDATED
// instruments (WHODAS-12, KOOS-JR, …) are METADATA rows only (id · label · item count · response
// scale · scoring rule · licence) — their verbatim item text is entered at 0.2a-2 from the official
// source, NEVER paraphrased here. Windows/packs/regex-map/escalation/PREM are from the frozen docs.
//
// ⚠ FLAGGED DOC AMBIGUITIES (see build report): (1) the house-sets doc declares 5 "shared scales"
// but ~8 of its own items carry bespoke inline option lists — those option sets are encoded VERBATIM
// as extra Scale members (rather than guess a mapping to one of the 5). (2) PREM item text is
// "unchanged from v0" and NOT present in the provided frozen docs → PREM_MODULE items text=null.
// (3) validated item counts / scoring rules are not in the frozen docs (except WHODAS-12=12) → null.
// (4) the coarse regex-family → catalog-pack/archetype bridge is not given by the docs → REGEX_FAMILY_PACK.

export const PROM_CATALOG_VERSION = 'prom-catalog/0.1' as const;
export const HS_SETS_VERSION = 'hs-sets/0.1' as const;

// The 5 ratified shared scales + the bespoke house option-sets (flagged) needed to encode items verbatim.
export type Scale =
  | 'S5-SEV' | 'S5-FRQ' | 'S5-CMP' | 'NRS-11' | 'YN'
  | 'FUNC4' | 'NOCT5' | 'DIET4' | 'SUPPORT3' | 'WALK5' | 'SIT4' | 'ACT3'
  | 'WHODAS5' | 'EXP4';   // 0.2a-2 content encoding: WHODAS-12 response scale + house-PREM experience scale
export type Archetype = 'SCOPE' | 'DAYCARE' | 'STANDARD' | 'LONG_ARC' | 'ONCO_MAJOR';
export type Window = 'baseline' | 'd72h' | 'w2' | 'w6' | 'm3' | 'm6' | 'm12';

// §catalog 3 — archetype instrument windows (verbatim). PREM points are separate (PREM_POINTS).
export const ARCHETYPE_WINDOWS: Record<Archetype, Window[]> = {
  SCOPE: ['baseline', 'd72h'],                                  // baseline-lite + PREM@72h
  DAYCARE: ['baseline', 'd72h', 'w2', 'w6'],
  STANDARD: ['baseline', 'd72h', 'w2', 'w6', 'm3'],
  LONG_ARC: ['baseline', 'w6', 'm3', 'm6', 'm12'],             // PREM 72h+3m (explicit)
  ONCO_MAJOR: ['baseline', 'w2', 'w6', 'm3', 'm6', 'm12'],
};
// PREM points (§5 "PREM-1 @72h, PREM-2 @close"; LONG_ARC overrides to 72h+3m; SCOPE = @72h only).
// FLAGGED: @close derived as the archetype's last window where the docs don't state it explicitly.
export const PREM_POINTS: Record<Archetype, Window[]> = {
  SCOPE: ['d72h'],
  DAYCARE: ['d72h', 'w6'],
  STANDARD: ['d72h', 'm3'],
  LONG_ARC: ['d72h', 'm3'],
  ONCO_MAJOR: ['d72h', 'm12'],
};

export interface Item { id: string; text: string | null; scale: Scale; escalation?: string | null }
export interface InstrumentDef {
  id: string;
  label: string; kind: 'validated' | 'house';
  scale: 'house' | string;          // scoring family / response-scale descriptor
  items: Item[];                    // HOUSE: verbatim; VALIDATED: [] (metadata only)
  itemCount?: number | null;        // VALIDATED metadata (docs give only WHODAS-12=12); house = items.length
  scoring: { method: 'sum' | 'ref'; range?: [number, number]; note?: string };
  licence: 'F' | 'Pv' | 'house';
}

// Response options per scale (the 5 ratified + the bespoke house sets, all verbatim).
export const SHARED_SCALES: Record<Scale, string[]> = {
  'S5-SEV': ['none', 'mild', 'moderate', 'severe', 'very severe'],
  'S5-FRQ': ['never', 'rarely', 'sometimes', 'often', 'always'],
  'S5-CMP': ['much better', 'better', 'same', 'worse', 'much worse'],
  'NRS-11': ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
  'YN': ['yes', 'no'],
  // bespoke house option-sets (verbatim from the items; flagged extension):
  'FUNC4': ['fully', 'mostly', 'partly', 'not yet'],
  'NOCT5': ['0', '1', '2', '3', '4+'],
  'DIET4': ['fully', 'soft diet only', 'liquids only', 'barely'],
  'SUPPORT3': ['yes', 'some difficulty', 'struggling'],
  'WALK5': ['unlimited', '~1km', '~500m', '~100m', 'room-only'],
  'SIT4': ['>1h', '~30min', '~10min', 'barely'],
  'ACT3': ['fully', 'avoiding heavy', 'avoiding all'],
  // 0.2a-2 content encoding (verbatim from the two source files):
  'WHODAS5': ['None', 'Mild', 'Moderate', 'Severe', 'Extreme or cannot do'],   // WHODAS-12 recode None=0…Extreme=4
  'EXP4': ['no', 'partly', 'mostly', 'yes, fully'],                            // house PREM experience, 0–3, higher = better
};

const houseItem = (id: string, text: string, scale: Scale, escalation: string | null = null): Item => ({ id, text, scale, escalation });
const houseSet = (id: string, label: string, items: Item[]): InstrumentDef => ({ id, label, kind: 'house', scale: 'house', items, itemCount: items.length, scoring: { method: 'sum', note: 'house simple sum; within-patient trends only; never benchmarked' }, licence: 'house' });

// ── Universal CORE stack (§catalog 2) ──
const RETURN_TO_FUNCTION = houseItem('rtf', 'Compared with before surgery, your ability to do daily activities is:', 'S5-CMP');
// WHODAS 2.0 © World Health Organization. Used with attribution; unmodified. 12-item interviewer-
// administered version. Item text below is VERBATIM from the official WHO PDF (encoded 0.2a-2). Stem
// (read once): "In the past 30 days, how much difficulty did you have in:" — every item on WHODAS5.
const WHODAS12_ITEMS: Item[] = [
  { id: 'whodas_s1', text: 'Standing for long periods such as 30 minutes?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s2', text: 'Taking care of your household responsibilities?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s3', text: 'Learning a new task, for example, learning how to get to a new place?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s4', text: 'How much of a problem did you have joining in community activities (for example, festivities, religious or other activities) in the same way as anyone else can?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s5', text: 'How much have you been emotionally affected by your health problems?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s6', text: 'Concentrating on doing something for ten minutes?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s7', text: 'Walking a long distance such as a kilometre [or equivalent]?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s8', text: 'Washing your whole body?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s9', text: 'Getting dressed?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s10', text: 'Dealing with people you do not know?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s11', text: 'Maintaining a friendship?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s12', text: 'Your day-to-day work/school?', scale: 'WHODAS5', escalation: null },
];
export const CORE: InstrumentDef[] = [
  { id: 'whodas12', label: 'WHODAS 2.0 (12-item)', kind: 'validated', scale: 'WHODAS5', items: WHODAS12_ITEMS, itemCount: 12, scoring: { method: 'ref', note: 'WHODAS 2.0 © WHO; used with attribution, unmodified; 12-item interviewer version. Simple score = sum(0..4)→0–48.' }, licence: 'F' },
  { id: 'pain_nrs', label: 'Pain NRS', kind: 'validated', scale: 'NRS-11', items: [], itemCount: 1, scoring: { method: 'ref', range: [0, 10], note: 'public domain' }, licence: 'F' },
  houseSet('hs-return-to-function', 'Return-to-function (house)', [RETURN_TO_FUNCTION]),
];

// ── House sets — VERBATIM from hs-sets/0.1 (item text + shared scale + ⚠ escalation) ──
export const HOUSE_SETS: Record<string, InstrumentDef> = {
  'hs-wound': houseSet('hs-wound', 'HS-WOUND — universal wound check', [
    houseItem('w1', 'Is the wound area more red, swollen, or painful than the day before?', 'YN', 'E2-with-item-3'),
    houseItem('w2', 'Any discharge or bad smell from the wound?', 'YN', 'E2-with-item-3'),
    houseItem('w3', 'Fever since discharge?', 'YN'),
    houseItem('w4', 'Has the wound opened anywhere?', 'YN', 'always'),
  ]),
  'hs-recovery': houseSet('hs-recovery', 'HS-RECOVERY — generic day-care recovery', [
    houseItem('r1', 'Have you returned to your usual daily activities?', 'FUNC4'),
    houseItem('r2', 'Pain at the operation site today', 'NRS-11'),
    houseItem('r3', "Any problem after the procedure you didn't expect?", 'YN'),
  ]),
  'hs-procto': houseSet('hs-procto', 'HS-PROCTO — proctology symptom resolution', [
    houseItem('p1', 'Bleeding with motions', 'S5-FRQ', 'E4'),
    houseItem('p2', 'Pain during or after passing motion', 'NRS-11'),
    houseItem('p3', 'Swelling or something coming down while straining', 'S5-FRQ'),
    houseItem('p4', 'Any difficulty holding motion or wind since surgery?', 'YN', 'E5'),
  ]),
  'hs-gi': houseSet('hs-gi', 'HS-GI — post-cholecystectomy', [
    houseItem('g1', 'Pain after fatty meals', 'S5-FRQ'),
    houseItem('g2', 'Bloating or fullness after eating', 'S5-FRQ'),
    houseItem('g3', 'Loose motions since surgery', 'S5-FRQ'),
  ]),
  'hs-luts': houseSet('hs-luts', 'HS-LUTS — LUTS fallback', [
    houseItem('l1', 'How often do you have a weak urine stream?', 'S5-FRQ'),
    houseItem('l2', 'How many times do you get up at night to pass urine?', 'NOCT5'),
    houseItem('l3', 'How often do you have a sudden strong urge to pass urine?', 'S5-FRQ'),
    houseItem('l4', 'Burning while passing urine', 'S5-FRQ'),
  ]),
  'hs-stone': houseSet('hs-stone', 'HS-STONE — urinary stones', [
    houseItem('s1', 'Flank or lower-abdomen pain', 'NRS-11'),
    houseItem('s2', 'Blood in urine', 'S5-FRQ', 'E5'),
    houseItem('s3', '(If stented) stent discomfort interfering with daily activities', 'S5-SEV'),
  ]),
  'hs-gyn': houseSet('hs-gyn', 'HS-GYN — gynae symptom resolution', [
    houseItem('gy1', 'Bleeding compared with before surgery', 'S5-CMP', 'E4'),
    houseItem('gy2', 'Lower-abdomen or pelvic pain', 'NRS-11'),
    houseItem('gy3', 'The symptom that led to surgery — how is it now?', 'S5-CMP'),
  ]),
  'hs-sinus': houseSet('hs-sinus', 'HS-SINUS — sinus fallback', [
    houseItem('si1', 'Nose blockage', 'S5-SEV'),
    houseItem('si2', 'Discharge/post-nasal drip', 'S5-FRQ'),
    houseItem('si3', 'Sense of smell', 'S5-CMP'),
    houseItem('si4', 'Facial pressure or headache', 'S5-SEV'),
  ]),
  'hs-tonsil': houseSet('hs-tonsil', 'HS-TONSIL — tonsillectomy recovery', [
    houseItem('t1', 'Throat pain today', 'NRS-11'),
    houseItem('t2', 'Able to eat and drink normally?', 'DIET4', 'E5'),
    houseItem('t3', 'Any bleeding from the throat?', 'YN', 'always'),
  ]),
  'hs-thyroid': houseSet('hs-thyroid', 'HS-THYROID — thyroid surgery', [
    houseItem('th1', 'Voice change compared with before surgery', 'S5-CMP', 'E5'),
    houseItem('th2', 'Difficulty swallowing', 'S5-SEV'),
    houseItem('th3', 'Tingling around lips or fingertips?', 'YN', 'always'),
    houseItem('th4', 'Neck wound tightness or swelling', 'S5-SEV'),
  ]),
  'hs-csection': houseSet('hs-csection', 'HS-CSECTION — C-section recovery', [
    houseItem('cs1', 'Wound pain', 'NRS-11'),
    houseItem('cs2', 'Able to move about, climb stairs, care for the baby?', 'FUNC4'),
    houseItem('cs3', 'Bleeding heavier than a normal period?', 'YN', 'E4'),
    houseItem('cs4', 'Feeding going okay, and do you have help at home?', 'SUPPORT3', 'E5'),
  ]),
  'hs-visual': houseSet('hs-visual', 'HS-VISUAL — cataract fallback', [
    houseItem('v1', 'Distance vision (recognising faces across a room)', 'S5-CMP'),
    houseItem('v2', 'Glare or halos around lights at night', 'S5-SEV'),
    houseItem('v3', 'Reading or phone use', 'S5-CMP'),
    houseItem('v4', 'Eye pain or sudden drop in vision?', 'YN', 'always'),
  ]),
  'hs-shoulder': houseSet('hs-shoulder', 'HS-SHOULDER — shoulder fallback', [
    houseItem('sh1', 'Night pain lying on that side', 'S5-FRQ'),
    houseItem('sh2', 'Reaching overhead (shelf)', 'S5-SEV'),
    houseItem('sh3', 'Dressing yourself', 'S5-SEV'),
  ]),
  'hs-lumbar': houseSet('hs-lumbar', 'HS-LUMBAR — lumbar fallback', [
    houseItem('lu1', 'Back pain', 'NRS-11'),
    houseItem('lu2', 'Leg pain', 'NRS-11'),
    houseItem('lu3', 'Walking distance before stopping', 'WALK5'),
    houseItem('lu4', 'Sitting tolerance', 'SIT4'),
  ]),
  'hs-hernia': houseSet('hs-hernia', 'HS-HERNIA — hernia fallback', [
    houseItem('he1', 'Pain at repair site at rest / on coughing or lifting', 'NRS-11'),
    houseItem('he2', 'Any bulge reappeared?', 'YN', 'E5'),
    houseItem('he3', 'Back to lifting normal weights?', 'ACT3'),
  ]),
};

// ── Validated instruments referenced by the packs — METADATA rows only (text at 0.2a-2). ──
const validated = (id: string, label: string, licence: 'F' | 'Pv', itemCount: number | null = null): InstrumentDef =>
  ({ id, label, kind: 'validated', scale: 'validated', items: [], itemCount, scoring: { method: 'ref', note: 'item text + scoring rule from the official source at 0.2a-2' }, licence });
export const VALIDATED_INSTRUMENTS: Record<string, InstrumentDef> = {
  koos_jr: validated('koos_jr', 'KOOS-JR', 'F'),
  hoos_jr: validated('hoos_jr', 'HOOS-JR', 'F'),
  koos: validated('koos', 'KOOS', 'F'),
  tegner: validated('tegner', 'Tegner', 'F'),
  spadi: validated('spadi', 'SPADI', 'F'),
  prwe: validated('prwe', 'PRWE', 'Pv'),
  faam: validated('faam', 'FAAM', 'F'),
  rmdq: validated('rmdq', 'RMDQ', 'F'),
  odi: validated('odi', 'ODI', 'Pv'),
  ndi: validated('ndi', 'NDI', 'Pv'),
  wexner: validated('wexner', 'Wexner', 'F'),
  eurahs: validated('eurahs', 'EuraHS-QoL', 'Pv'),
  ipss: validated('ipss', 'IPSS', 'F'),
  ufsqol: validated('ufsqol', 'UFS-QoL', 'Pv'),
  ehp5: validated('ehp5', 'EHP-5', 'Pv'),
  pfdi20: validated('pfdi20', 'PFDI-20', 'Pv'),
  nose: validated('nose', 'NOSE', 'F'),
  snot22: validated('snot22', 'SNOT-22', 'Pv'),
  catquest9sf: validated('catquest9sf', 'Catquest-9SF', 'Pv'),
  avvq: validated('avvq', 'AVVQ', 'Pv'),
  nyha: validated('nyha', 'NYHA (clinician-reported)', 'F'),
  ohip14: validated('ohip14', 'OHIP-14', 'F', 14),
  whodas_proxy: validated('whodas_proxy', 'WHODAS-proxy', 'Pv'),
};

/** Resolve an instrument id to its def (CORE ∪ HOUSE_SETS ∪ VALIDATED ∪ the PREM module). null if unknown. */
export function instrumentById(id: string): InstrumentDef | null {
  return CORE.find((i) => i.id === id) ?? HOUSE_SETS[id] ?? VALIDATED_INSTRUMENTS[id] ?? (id === PREM_MODULE.id ? PREM_MODULE : null);
}

export interface FamilyPack { family: string; archetype: Archetype; primary: string | null; fallback: string | null; lic: 'F' | 'Pv' | 'house' | null }
// §catalog 4.1–4.3 — packs (primary/fallback as instrument IDs).
export const FAMILY_PACKS: FamilyPack[] = [
  // 4.1 Orthopaedics & spine
  { family: 'knee_arthroplasty', archetype: 'LONG_ARC', primary: 'koos_jr', fallback: null, lic: 'F' },
  { family: 'hip_arthroplasty', archetype: 'LONG_ARC', primary: 'hoos_jr', fallback: null, lic: 'F' },
  { family: 'knee_arthroscopy_acl', archetype: 'LONG_ARC', primary: 'koos', fallback: null, lic: 'F' },
  { family: 'shoulder', archetype: 'LONG_ARC', primary: 'spadi', fallback: 'hs-shoulder', lic: 'F' },
  { family: 'hand_wrist', archetype: 'STANDARD', primary: 'prwe', fallback: null, lic: 'Pv' },
  { family: 'foot_ankle', archetype: 'STANDARD', primary: 'faam', fallback: null, lic: 'F' },
  { family: 'fracture_trauma', archetype: 'STANDARD', primary: null, fallback: null, lic: null },
  { family: 'lumbar_spine', archetype: 'LONG_ARC', primary: 'rmdq', fallback: 'hs-lumbar', lic: 'F' },
  { family: 'cervical_spine', archetype: 'LONG_ARC', primary: 'ndi', fallback: null, lic: 'Pv' },
  // 4.2 High-volume observed families
  { family: 'proctology', archetype: 'DAYCARE', primary: 'hs-procto', fallback: 'wexner', lic: 'F' },
  { family: 'cholecystectomy', archetype: 'STANDARD', primary: 'hs-gi', fallback: null, lic: 'house' },
  { family: 'hernia', archetype: 'STANDARD', primary: 'eurahs', fallback: 'hs-hernia', lic: 'Pv' },
  { family: 'appendicectomy_emergency', archetype: 'STANDARD', primary: null, fallback: null, lic: null },
  { family: 'minor_excisions', archetype: 'DAYCARE', primary: null, fallback: null, lic: null },
  { family: 'circumcision_adult', archetype: 'DAYCARE', primary: 'hs-recovery', fallback: null, lic: 'house' },
  { family: 'bph_turp_laser', archetype: 'STANDARD', primary: 'ipss', fallback: 'hs-luts', lic: 'F' },
  { family: 'urinary_stones', archetype: 'STANDARD', primary: 'hs-stone', fallback: null, lic: 'house' },
  { family: 'scrotal', archetype: 'DAYCARE', primary: null, fallback: null, lic: null },
  { family: 'hysterectomy', archetype: 'STANDARD', primary: 'hs-gyn', fallback: null, lic: 'house' },
  { family: 'fibroids_myomectomy', archetype: 'STANDARD', primary: 'ufsqol', fallback: null, lic: 'Pv' },
  { family: 'endometriosis', archetype: 'STANDARD', primary: 'ehp5', fallback: null, lic: 'Pv' },
  { family: 'hysteroscopy_mirena', archetype: 'SCOPE', primary: null, fallback: null, lic: null },
  { family: 'prolapse', archetype: 'STANDARD', primary: 'pfdi20', fallback: null, lic: 'Pv' },
  { family: 'septoplasty_turbinoplasty', archetype: 'STANDARD', primary: 'nose', fallback: null, lic: 'F' },
  { family: 'fess_sinus', archetype: 'STANDARD', primary: 'snot22', fallback: 'hs-sinus', lic: 'Pv' },
  { family: 'tonsillectomy', archetype: 'DAYCARE', primary: 'hs-tonsil', fallback: null, lic: 'house' },
  // facial/ENT (UID-map rider 1, 12 Jul) — nasal-fracture & kin; no pack yet → CORE+PREM safe floor.
  { family: 'facial_ent', archetype: 'STANDARD', primary: null, fallback: null, lic: null },
  { family: 'diagnostic_endoscopy', archetype: 'SCOPE', primary: null, fallback: null, lic: null },
  // 4.3 Anticipated / dormant
  { family: 'cataract', archetype: 'DAYCARE', primary: 'catquest9sf', fallback: 'hs-visual', lic: 'Pv' },
  { family: 'breast', archetype: 'STANDARD', primary: null, fallback: null, lic: null },
  { family: 'thyroid', archetype: 'STANDARD', primary: 'hs-thyroid', fallback: null, lic: 'house' },
  { family: 'bariatric', archetype: 'LONG_ARC', primary: null, fallback: null, lic: null },
  { family: 'varicose_veins', archetype: 'STANDARD', primary: 'avvq', fallback: null, lic: 'Pv' },
  { family: 'cardiac', archetype: 'LONG_ARC', primary: 'nyha', fallback: null, lic: null },
  { family: 'thoracic', archetype: 'ONCO_MAJOR', primary: null, fallback: null, lic: null },
  { family: 'cranial_neuro', archetype: 'LONG_ARC', primary: null, fallback: null, lic: null },
  { family: 'paediatric_surgery', archetype: 'STANDARD', primary: 'whodas_proxy', fallback: null, lic: 'Pv' },
  { family: 'obstetric_csection', archetype: 'STANDARD', primary: 'hs-csection', fallback: null, lic: 'house' },
  { family: 'dental_maxillofacial', archetype: 'DAYCARE', primary: 'ohip14', fallback: null, lic: 'F' },
  { family: 'plastics_scars', archetype: 'STANDARD', primary: null, fallback: null, lic: null },
  { family: 'onco_resections', archetype: 'ONCO_MAJOR', primary: null, fallback: null, lic: null },
];

// feasibility §4b — family regex map. ORDER = first-match-wins (as listed). Coarse keys.
// v1.1 coverage extension (12 Jul): the specific-first block below is PREPENDED so the main
// surgical families reach their EXISTING FAMILY_PACKS packs (no measurement change, no bridge).
// It also fixes the cholecystectomy misroute (cholecyst wins before minor_excision_wound's `cyst`)
// and puts bph_turp_laser + urinary_stones before the coarse `urology` pattern.
export const FAMILY_REGEX: { family: string; re: RegExp }[] = [
  // ── regex-map v1.1 — main-family coverage (prepended; specific-first) ──
  { family: 'cholecystectomy',           re: /cholecyst|gall.?bladder/i },                                   // BEFORE minor_excision_wound (cyst)
  { family: 'proctology',                re: /h(a)?emorrhoid|\bpile|fissure|fistula|sphincterotomy|hemorrhoidopexy/i },
  { family: 'hernia',                    re: /hernia|hernioplasty|herniorrhaph/i },
  { family: 'appendicectomy_emergency',  re: /appendic|appendectomy/i },
  { family: 'hysterectomy',              re: /hysterectomy/i },
  { family: 'fibroids_myomectomy',       re: /myomectomy|fibroid/i },
  { family: 'tonsillectomy',             re: /tonsil|adenoid/i },
  { family: 'bph_turp_laser',            re: /\bturp\b|prostatectomy|\bbph\b|holep|thulep|greenlight/i },      // BEFORE urology
  { family: 'urinary_stones',            re: /ureteroscop|\burs\b|pcnl|lithotrip|renal stone|ureteric stone|urolith|dj stent/i }, // BEFORE urology
  { family: 'septoplasty_turbinoplasty', re: /septoplasty|turbinoplast/i },
  { family: 'fess_sinus',                re: /\bfess\b|functional endoscopic|sinus|nasal polyp/i },
  { family: 'cataract',                  re: /cataract|phaco/i },
  { family: 'circumcision_adult',        re: /circumcision/i },
  { family: 'scrotal',                   re: /varicocele|hydrocele|orchidopexy|orchidectomy|scrotal/i },
  // ── existing coarse "168 other" tail (v1) — unchanged, universal_core last ──
  { family: 'ortho_spine', re: /laminectomy|orif|open reduction|implant removal|mua|syndesmosis|rotat(or|er) cuff|megaprosthesis/i },
  { family: 'thyroid', re: /thyroidectomy|thyroid/i },
  { family: 'obstetric', re: /lscs|caesar|c-section|delivery|mtp|tubectomy/i },
  { family: 'vascular', re: /varicose|evlt|perforator|sclerotherapy|gsv|avulsion/i },
  { family: 'plastics', re: /liposuction|scar revision|reconstruction|abdominoplasty/i },
  { family: 'minor_excision_wound', re: /excision|cyst|mole|wart|ganglion|nail|debridement|suturing|cauteris|biopsy/i },
  { family: 'urology', re: /stent|holep|urethra|meatotomy/i },
  { family: 'ent', re: /grommet|myringotomy|tongue tie|frenulo/i },
  { family: 'breast', re: /mammary|breast|mastect/i },
  { family: 'rare_major', re: /transplant|pci|bypass|craniotomy/i },
  { family: 'universal_core', re: /.*/i },   // (fallback) — always matches last
];

// Coarse regex-family → catalog pack/archetype bridge (NOT given by the frozen docs — FLAGGED).
// Maps a regex-classified coarse family to a representative pack family (for archetype + primary/fallback).
export const REGEX_FAMILY_PACK: Record<string, string> = {
  ortho_spine: 'lumbar_spine',           // ortho super-family → LONG_ARC representative
  thyroid: 'thyroid',
  obstetric: 'obstetric_csection',
  vascular: 'varicose_veins',
  plastics: 'plastics_scars',
  minor_excision_wound: 'minor_excisions',
  urology: 'urinary_stones',
  ent: 'fess_sinus',
  breast: 'breast',
  rare_major: 'onco_resections',
  universal_core: 'unknown',
};

// §5 House PREM module — 8 items, PREM-1@72h/PREM-2@close. ⚠ item text is "unchanged from v0" and NOT
// present in the provided frozen docs → text=null (entered verbatim at 0.2a-2, like validated items).
// House PREM module (8 items) — VERBATIM from the ratified draft (CDMSS-PROMS-HOUSE-PREM-MODULE-DRAFT-v1,
// approved 12 Jul). Items 1–7 on EXP4 (0–3, higher = better); item 8 overall NRS-11. House measure —
// within-hospital trend only, never externally benchmarked. Experience score = sum(prem1..prem7)→0–21.
export const PREM_MODULE: InstrumentDef = {
  id: 'prem', label: 'House PREM module', kind: 'house', scale: 'house',
  items: [
    { id: 'prem1', text: 'Before your surgery, did the team explain clearly what would happen and what to expect?', scale: 'EXP4', escalation: null },
    { id: 'prem2', text: 'During your care, did the doctors and nurses listen to you and answer your questions?', scale: 'EXP4', escalation: null },
    { id: 'prem3', text: 'Were you treated with respect and dignity by the care team?', scale: 'EXP4', escalation: null },
    { id: 'prem4', text: 'Were you as involved as you wanted to be in decisions about your care?', scale: 'EXP4', escalation: null },
    { id: 'prem5', text: 'Was your pain and discomfort managed as well as you expected?', scale: 'EXP4', escalation: null },
    { id: 'prem6', text: 'When you left, did you clearly understand how to look after yourself at home — medicines, wound care, warning signs, and follow-up?', scale: 'EXP4', escalation: null },
    { id: 'prem7', text: 'Since your surgery, when you needed help or had a question, could you reach the care team easily?', scale: 'EXP4', escalation: null },
    { id: 'prem8', text: 'Overall, how would you rate your surgical care experience? (0 = very poor, 10 = excellent)', scale: 'NRS-11', escalation: null },
  ],
  itemCount: 8, scoring: { method: 'sum', note: 'PREM-1@72h, PREM-2@close; experience sum(prem1..prem7)→0–21 (higher=better); prem8 overall NRS surfaced separately' }, licence: 'house',
};

// Service-recovery soft flag (NOT a clinical E-code) — the wired layer routes it to the care-team
// feedback list, never the clinical daily list. Ratified as drafted (12 Jul). Data only.
export const PREM_SERVICE_FLAG = { rule: 'overall (prem8) ≤ 3 OR any of prem1..prem7 = "no"', kind: 'service_recovery' } as const;

// house-sets §escalation-map — E1–E5 (verbatim).
export const ESCALATION: { code: string; rule: string }[] = [
  { code: 'E1', rule: 'pain NRS ≥ 8 after post-op day 3' },
  { code: 'E2', rule: 'any wound YN-positive with fever' },
  { code: 'E3', rule: 'function worse/much worse at ≥6w' },
  { code: 'E4', rule: 'bleeding severe+ any time' },
  { code: 'E5', rule: 'set-specific triggers marked ⚠' },
];
