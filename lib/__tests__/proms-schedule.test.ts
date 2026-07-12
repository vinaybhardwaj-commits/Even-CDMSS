import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFamily, archetypeFor, instrumentsDue, scoreInstrument,
  PROM_SCHED_VERSION, PROM_SCORING_VERSION, type SeriesInput,
} from '../proms/schedule-core';
import {
  FAMILY_PACKS, HOUSE_SETS, CORE, SHARED_SCALES, ARCHETYPE_WINDOWS, PREM_POINTS,
  instrumentById, FAMILY_REGEX, PROM_CATALOG_VERSION, HS_SETS_VERSION,
} from '../proms/catalog';

// ── versions ──
test('versions', () => {
  assert.equal(PROM_CATALOG_VERSION, 'prom-catalog/0.1');
  assert.equal(HS_SETS_VERSION, 'hs-sets/0.1');
  assert.equal(PROM_SCHED_VERSION, 'prom-sched/0.1');
  assert.equal(PROM_SCORING_VERSION, 'prom-scoring/0.1');
});

// ── classifyFamily: regex map v1, first-match-wins ──
test('classifyFamily: each regex family (order = first-match-wins)', () => {
  assert.equal(classifyFamily({ procedureName: 'ORIF of femur' }), 'ortho_spine');
  assert.equal(classifyFamily({ procedureName: 'rotator cuff repair' }), 'ortho_spine');
  assert.equal(classifyFamily({ procedureName: 'Total Thyroidectomy' }), 'thyroid');
  assert.equal(classifyFamily({ procedureName: 'LSCS' }), 'obstetric');
  assert.equal(classifyFamily({ procedureName: 'EVLT varicose veins' }), 'vascular');
  assert.equal(classifyFamily({ procedureName: 'liposuction' }), 'plastics');
  assert.equal(classifyFamily({ procedureName: 'sebaceous cyst excision' }), 'minor_excision_wound');
  assert.equal(classifyFamily({ procedureName: 'meatotomy' }), 'urology');   // v1.1: DJ-stent/holep now route to stones/bph — coarse urology still catches urethra/meatotomy
  assert.equal(classifyFamily({ procedureName: 'grommet insertion' }), 'ent');
  assert.equal(classifyFamily({ procedureName: 'mastectomy' }), 'breast');
  assert.equal(classifyFamily({ procedureName: 'liver transplant' }), 'rare_major');
});

test('classifyFamily: no regex match → unknown (core+PREM); NULLIF empties handled', () => {
  // v1.1: appendicectomy + cholecystectomy are now COVERED (asserted in the v1.1 block below); a
  // truly-unknown name still falls through to core+PREM.
  assert.equal(classifyFamily({ procedureName: 'excision of lump nos xyz' }), 'minor_excision_wound');
  assert.equal(classifyFamily({ procedureName: 'something with no keyword zzz' }), 'unknown');
  assert.equal(classifyFamily({ surgeryTypeUid: '', procedureName: '' }), 'unknown');
  assert.equal(classifyFamily({ surgeryTypeUid: '   ', procedureName: 'ORIF' }), 'ortho_spine');   // empty uid → regex
  assert.equal(classifyFamily({}), 'unknown');
});

// ── classifyFamily: v1.1 main-family coverage (prepended, specific-first) ──
test('classifyFamily v1.1: main surgical families reach their existing packs', () => {
  // proctology (real db names)
  assert.equal(classifyFamily({ procedureName: 'Laser Haemorrhoidectomy' }), 'proctology');
  assert.equal(classifyFamily({ procedureName: 'Fissure in Ano' }), 'proctology');
  assert.equal(classifyFamily({ procedureName: 'LASER ASSISTED FISTULA ABLATION' }), 'proctology');
  assert.equal(classifyFamily({ procedureName: 'EUA+ LASER HEMORRHOIDOPEXY' }), 'proctology');
  // cholecystectomy — the misroute is fixed (specific-first beats minor_excision_wound's `cyst`)
  assert.equal(classifyFamily({ procedureName: 'Cholecystectomy (Lap)' }), 'cholecystectomy');
  assert.notEqual(classifyFamily({ procedureName: 'Cholecystectomy (Lap)' }), 'minor_excision_wound');
  // hysterectomy / hernia / appendicectomy
  assert.equal(classifyFamily({ procedureName: 'Hysterectomy' }), 'hysterectomy');
  assert.equal(classifyFamily({ procedureName: 'Inguinal hernia' }), 'hernia');
  assert.equal(classifyFamily({ procedureName: 'Umbilical Hernia Mesh Repair' }), 'hernia');
  assert.equal(classifyFamily({ procedureName: 'appendicectomy' }), 'appendicectomy_emergency');
  // urology split: BPH/TURP + stones win before the coarse `urology` (stent/holep) pattern
  assert.equal(classifyFamily({ procedureName: 'TURP' }), 'bph_turp_laser');
  assert.equal(classifyFamily({ procedureName: 'PCNL for renal stone' }), 'urinary_stones');
  assert.equal(classifyFamily({ procedureName: 'DJ stent removal' }), 'urinary_stones');   // was 'urology' in v1 — now stones
  // ENT / eye / other
  assert.equal(classifyFamily({ procedureName: 'Tonsillectomy' }), 'tonsillectomy');
  assert.equal(classifyFamily({ procedureName: 'FESS' }), 'fess_sinus');
  assert.equal(classifyFamily({ procedureName: 'Phacoemulsification cataract surgery' }), 'cataract');
  assert.equal(classifyFamily({ procedureName: 'Hydrocele repair' }), 'scrotal');
  assert.equal(classifyFamily({ procedureName: 'Myomectomy' }), 'fibroids_myomectomy');
});

test('classifyFamily v1.1: existing coarse families unregressed', () => {
  assert.equal(classifyFamily({ procedureName: 'ORIF of femur' }), 'ortho_spine');
  assert.equal(classifyFamily({ procedureName: 'Total Thyroidectomy' }), 'thyroid');
  assert.equal(classifyFamily({ procedureName: 'something nonsense xyz' }), 'unknown');
});

test('classifyFamily v1.1: proctology routes to its house pack end-to-end', () => {
  const due = instrumentsDue('proctology', BASE, '2026-02-04');
  assert.ok(new Set(due.map((d) => d.instrumentId)).has('hs-procto'));
});

test('classifyFamily: the universal_core catch-all is never returned as a family', () => {
  assert.ok(!FAMILY_REGEX.slice(0, -1).some((r) => r.family === 'universal_core'));
  assert.equal(FAMILY_REGEX[FAMILY_REGEX.length - 1].family, 'universal_core');
  assert.equal(classifyFamily({ procedureName: 'something with no keyword xyz' }), 'unknown');
});

// ── archetypeFor ──
test('archetypeFor: direct pack, coarse-regex bridge, unknown→STANDARD', () => {
  assert.equal(archetypeFor('knee_arthroplasty'), 'LONG_ARC');
  assert.equal(archetypeFor('thyroid'), 'STANDARD');
  assert.equal(archetypeFor('ortho_spine'), 'LONG_ARC');       // via REGEX_FAMILY_PACK → lumbar_spine
  assert.equal(archetypeFor('minor_excision_wound'), 'DAYCARE');
  assert.equal(archetypeFor('unknown'), 'STANDARD');
});

// ── instrumentsDue window math ──
const BASE: SeriesInput = { anchorDate: '2026-01-01', plannedSurgeryDate: '2026-01-10', dischargeDate: '2026-02-01' };

test('instrumentsDue: cancelled → empty', () => {
  assert.deepEqual(instrumentsDue('thyroid', { ...BASE, cancelled: true }, '2026-02-04'), []);
});

test('instrumentsDue: no discharge → pre-op (baseline) only', () => {
  const due = instrumentsDue('thyroid', { anchorDate: '2026-01-01', plannedSurgeryDate: '2026-01-10', dischargeDate: null }, '2026-01-05');
  assert.ok(due.length > 0);
  assert.ok(due.every((d) => d.window === 'baseline'));
});

test('instrumentsDue: d72h window — out_of_window before, in_window at +3d, missed after close', () => {
  const at = (now: string) => instrumentsDue('thyroid', BASE, now).find((d) => d.window === 'd72h' && d.instrumentId === 'whodas12')!;
  assert.equal(at('2026-02-01').status, 'out_of_window');   // discharge day, before the 72h window opens (02-02)
  assert.equal(at('2026-02-04').status, 'in_window');       // +3d, within ±2
  assert.equal(at('2026-03-01').status, 'missed');          // long past close (02-06)
});

test('instrumentsDue: baseline — in_window before surgery, missed after', () => {
  const bl = (now: string) => instrumentsDue('thyroid', BASE, now).find((d) => d.window === 'baseline' && d.instrumentId === 'whodas12')!;
  assert.equal(bl('2026-01-05').status, 'in_window');       // between anchor 01-01 and surgery 01-10
  assert.equal(bl('2026-01-20').status, 'missed');          // after the planned surgery date
});

test('instrumentsDue: CORE + pack add-on + PREM scheduled (STANDARD)', () => {
  const due = instrumentsDue('thyroid', BASE, '2026-02-04');
  const ids = new Set(due.map((d) => d.instrumentId));
  assert.ok(ids.has('whodas12') && ids.has('pain_nrs') && ids.has('hs-return-to-function'));
  assert.ok(ids.has('hs-thyroid'));   // the thyroid pack add-on (house)
  assert.ok(ids.has('prem'));         // PREM module at PREM_POINTS
  assert.deepEqual(ARCHETYPE_WINDOWS.STANDARD, ['baseline', 'd72h', 'w2', 'w6', 'm3']);
});

test('instrumentsDue: a Pv pack with an unconfirmed sweep uses its house fallback', () => {
  // fess_sinus: primary snot22 (Pv), fallback hs-sinus → fallback selected pre-sweep.
  const due = instrumentsDue('fess_sinus', BASE, '2026-02-04');
  const ids = new Set(due.map((d) => d.instrumentId));
  assert.ok(ids.has('hs-sinus'));
  assert.ok(!ids.has('snot22'));
});

// ── scoring ──
test('scoreInstrument: house simple sum; complete set scored', () => {
  const r = scoreInstrument('hs-gi', [{ itemId: 'g1', value: 'sometimes' }, { itemId: 'g2', value: 'sometimes' }, { itemId: 'g3', value: 'sometimes' }]);
  assert.equal(r.score, 6);       // 3 × index(sometimes)=2
  assert.equal(r.scale, 'house');
  assert.equal(r.version, 'prom-scoring/0.1');
});

test('scoreInstrument: partial set → honest null', () => {
  const r = scoreInstrument('hs-gi', [{ itemId: 'g1', value: 'often' }, { itemId: 'g2', value: 'never' }]);
  assert.equal(r.score, null);
});

test('scoreInstrument: ⚠ items emit the escalation code', () => {
  assert.ok(scoreInstrument('hs-wound', [{ itemId: 'w1', value: 'no' }, { itemId: 'w2', value: 'no' }, { itemId: 'w3', value: 'no' }, { itemId: 'w4', value: 'yes' }]).escalations.includes('E5'));   // wound opened → always → E5
  assert.ok(scoreInstrument('hs-procto', [{ itemId: 'p1', value: 'often' }, { itemId: 'p2', value: '2' }, { itemId: 'p3', value: 'never' }, { itemId: 'p4', value: 'no' }]).escalations.includes('E4'));   // bleeding often → E4
  // wound E2 only when the wound item AND the fever item are positive
  assert.ok(scoreInstrument('hs-wound', [{ itemId: 'w1', value: 'yes' }, { itemId: 'w2', value: 'no' }, { itemId: 'w3', value: 'yes' }, { itemId: 'w4', value: 'no' }]).escalations.includes('E2'));
  assert.ok(!scoreInstrument('hs-wound', [{ itemId: 'w1', value: 'yes' }, { itemId: 'w2', value: 'no' }, { itemId: 'w3', value: 'no' }, { itemId: 'w4', value: 'no' }]).escalations.includes('E2'));
});

test('scoreInstrument: validated instrument → honest null (rule not encoded until 0.2a-2)', () => {
  const r = scoreInstrument('koos_jr', []);
  assert.equal(r.score, null);
  assert.equal(r.scale, 'validated');
});

// ── WHODAS-12 simple scoring (0.2a-2): sum of the 12 item scores (0..4 on None…Extreme) ──
const whodas = (values: string[]) => scoreInstrument('whodas12', values.map((v, i) => ({ itemId: `d${i + 1}`, value: v })));
test('scoreInstrument: WHODAS-12 simple sum — complete set of 12 → sum of option indices', () => {
  const allNone = whodas(Array(12).fill('none'));
  assert.equal(allNone.score, 0);
  assert.equal(allNone.scale, 'WHODAS-12 simple sum');
  assert.equal(allNone.version, 'prom-scoring/0.1');
  const allExtreme = whodas(Array(12).fill('extreme'));
  assert.equal(allExtreme.score, 48);   // 12 × 4
  const mixed = whodas(['none', 'mild', 'moderate', 'severe', 'extreme', 'none', 'mild', 'moderate', 'severe', 'extreme', 'mild', 'moderate']);
  assert.equal(mixed.score, 0 + 1 + 2 + 3 + 4 + 0 + 1 + 2 + 3 + 4 + 1 + 2);   // = 23
});

test('scoreInstrument: WHODAS-12 — incomplete (<12 mapped) → honest null; "extreme or cannot do" maps to 4', () => {
  assert.equal(whodas(Array(11).fill('none')).score, null);          // 11 items → incomplete
  assert.equal(whodas(Array(12).fill('unknownword')).score, null);   // none map → incomplete
  const cannot = whodas([...Array(11).fill('none'), 'extreme or cannot do']);
  assert.equal(cannot.score, 4);   // 11×0 + 4
});

// ── catalog integrity ──
test('integrity: every FamilyPack primary/fallback resolves to a known instrument', () => {
  for (const p of FAMILY_PACKS) {
    if (p.primary) assert.ok(instrumentById(p.primary), `${p.family} primary ${p.primary} unresolved`);
    if (p.fallback) assert.ok(instrumentById(p.fallback), `${p.family} fallback ${p.fallback} unresolved`);
  }
});

test('integrity: every HOUSE item uses a SHARED_SCALES scale', () => {
  const houseDefs = [...Object.values(HOUSE_SETS), ...CORE.filter((c) => c.kind === 'house')];
  for (const def of houseDefs) for (const it of def.items) assert.ok(it.scale in SHARED_SCALES, `${def.id}/${it.id} scale ${it.scale}`);
});

test('integrity: ARCHETYPE_WINDOWS + PREM_POINTS complete for all 5 archetypes', () => {
  for (const a of ['SCOPE', 'DAYCARE', 'STANDARD', 'LONG_ARC', 'ONCO_MAJOR'] as const) {
    assert.ok(ARCHETYPE_WINDOWS[a]?.length, `${a} windows`);
    assert.ok(ARCHETYPE_WINDOWS[a].includes('baseline'));
    assert.ok(PREM_POINTS[a]?.length, `${a} prem points`);
  }
});

test('integrity: every house item scale has response options; validated instruments have items:[]', () => {
  for (const def of Object.values(HOUSE_SETS)) { assert.equal(def.kind, 'house'); assert.ok(def.items.length > 0); }
  assert.equal(instrumentById('whodas12')!.items.length, 0);
  assert.equal(instrumentById('whodas12')!.itemCount, 12);
});

// ── determinism ──
test('determinism: classify / instrumentsDue / score twice → deep-equal', () => {
  assert.equal(classifyFamily({ procedureName: 'ORIF' }), classifyFamily({ procedureName: 'ORIF' }));
  assert.deepEqual(instrumentsDue('thyroid', BASE, '2026-02-04'), instrumentsDue('thyroid', BASE, '2026-02-04'));
  const rs = [{ itemId: 'g1', value: 'often' }, { itemId: 'g2', value: 'never' }, { itemId: 'g3', value: 'always' }];
  assert.deepEqual(scoreInstrument('hs-gi', rs), scoreInstrument('hs-gi', rs));
});
