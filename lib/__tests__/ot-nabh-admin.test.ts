/**
 * CAT admin OT Audit + ot-nabh/0.1 scorer.
 *
 *   node --test --import tsx lib/__tests__/ot-nabh-admin.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  OT_NABH_CRITERIA, OT_NABH_ENGINE_VERSION, scoreOtNabh,
} from '../triage/ot-nabh.ts';
import { OT_NABH_BACKFILL_UPDATE_SQL } from '../triage/ot-audit-store.ts';
import { buildOtAdminListSql } from '../triage/ot-admin-read.ts';
import {
  filterOtAdminList, meanPersistedNabhPct, pulseSurgeonLabel, readPersistedCriterion, readPersistedCriteria,
  type OtAdminListRow,
} from '../triage/ot-admin-present.ts';

const KEYS = [
  'procedure_named', 'surgeon_named', 'anaesthetist_named', 'nursing_ot_assistant', 'assistant_surgeon',
  'surgery_date', 'ot_start_end_time', 'laterality_side', 'patient_position', 'prep_scrub_drape',
  'incision_described', 'salient_operative_steps', 'key_intraop_findings', 'implants_devices',
  'specimens_collected', 'estimated_blood_loss', 'postoperative_diagnosis', 'patient_status_before_shift',
  'postop_iv_fluids', 'postop_medications', 'postop_wound_care', 'postop_nursing_monitoring',
  'postop_complications_watch', 'attributability_name_date_time',
] as const;

function comp(entries: Record<string, string>) {
  return Object.entries(entries).map(([name, valueString]) => ({ name, valueString }));
}

test('criterion keys match the contract, N/A only on implants and specimens', () => {
  assert.equal(OT_NABH_ENGINE_VERSION, 'ot-nabh/0.1');
  assert.deepEqual(OT_NABH_CRITERIA.map(([k]) => k), [...KEYS]);
  assert.equal(KEYS.length, 24);
});

test('empty note: implants and specimens are N/A and excluded from the max', () => {
  const score = scoreOtNabh({ note: '', component_json: [] });
  assert.equal(score.criteria.implants_devices.na, true);
  assert.equal(score.criteria.implants_devices.score, null);
  assert.equal(score.criteria.specimens_collected.na, true);
  assert.equal(score.criteria.specimens_collected.score, null);
  assert.equal(score.criteria.procedure_named.score, 0);
  assert.equal(score.score_sum, 0);
  assert.equal(score.score_max, 44);
  assert.equal(score.score_pct, 0);
  assert.equal(score.engine_version, 'ot-nabh/0.1');
});

test('procedure name alone is 2 points; pct is 100 × sum / max rounded to 2 decimals', () => {
  const score = scoreOtNabh({
    note: '',
    surgery_name: 'Lap cholecystectomy',
    component_json: comp({ 'surgery-name': 'Lap cholecystectomy' }),
  });
  assert.equal(score.criteria.procedure_named.score, 2);
  assert.equal(score.score_sum, 2);
  assert.equal(score.score_max, 44);
  assert.equal(score.score_pct, 4.55);
});

test('OT clock, date, implants, specimens, and post-op orders follow the pack branches', () => {
  const start = Date.parse('2026-09-01T04:30:00Z'); // 10:00 IST
  const end = Date.parse('2026-09-01T06:00:00Z');
  const score = scoreOtNabh({
    note: 'Patient stable. Shifted with vitals stable.',
    surgery_name: 'Left inguinal hernia repair',
    surgeon: 'DR MANOJ KUMAR S',
    created_at: '2026-09-01T10:05:00+05:30',
    finalized_by_username: 'DR MANOJ KUMAR S',
    component_json: comp({
      'surgery-name': 'Left inguinal hernia repair',
      surgeaon_ot_notes: 'DR MANOJ KUMAR S',
      ans: 'DR ANAESTHETIST RAO',
      ot_asst: 'Nurse Rekha',
      assist_notes: 'DR ASSIST RAO',
      date_ot_thearter: String(start),
      'ot-from': String(start),
      'ot-to': String(end),
      'right-left': 'on-left',
      ptnt_position: 'Supine',
      scrubbing: 'Betadine scrub',
      'pat-a-drap': 'Draped',
      'incision-plan': 'Groin crease incision',
      ot_no: 'A'.repeat(160),
      opfinf: 'Indirect sac identified and reduced completely today',
      'special-equpiments': 'prolene mesh implant',
      KSNC: 'yes',
      cksnc: '50 ml',
      JHBSC: 'Inj Augmentin. DNS @ 100 ml/hr. Sterile dressing. Monitor vitals. Inform SOS if bleeding.',
      CSJBCJS: 'Stable, shifted',
    }),
  });
  assert.equal(score.criteria.surgery_date.score, 2);
  assert.equal(score.criteria.ot_start_end_time.score, 2);
  assert.equal(score.criteria.laterality_side.score, 2);
  assert.equal(score.criteria.implants_devices.score, 2);
  assert.equal(score.criteria.implants_devices.na, undefined);
  assert.equal(score.criteria.specimens_collected.score, 2);
  assert.equal(score.criteria.estimated_blood_loss.score, 2);
  assert.equal(score.criteria.postop_medications.score, 2);
  assert.equal(score.criteria.postop_iv_fluids.score, 2);
  assert.equal(score.criteria.postop_wound_care.score, 2);
  assert.equal(score.criteria.postop_nursing_monitoring.score, 2);
  assert.equal(score.criteria.postop_complications_watch.score, 2);
  assert.equal(score.criteria.patient_status_before_shift.score, 2);
  assert.equal(score.criteria.attributability_name_date_time.score, 2);
  assert.ok(score.score_max >= 44 && score.score_max <= 48);
  assert.equal(score.score_pct, Math.round((100 * score.score_sum) / score.score_max * 100) / 100);
});

test('partial clocks, N/A specimens, and nil blood loss stay on the pack branches', () => {
  const onlyEnd = scoreOtNabh({
    component_json: comp({ 'ot-to': String(Date.parse('2026-09-01T06:00:00Z')) }),
    created_at: '2026-09-01T10:00:00+05:30',
  });
  assert.equal(onlyEnd.criteria.ot_start_end_time.score, 1);
  assert.equal(onlyEnd.criteria.surgery_date.score, 1);

  const none = scoreOtNabh({
    component_json: comp({ KSNC: 'no', 'special-equpiments': '1.', cksnc: 'nil' }),
  });
  assert.equal(none.criteria.specimens_collected.na, true);
  assert.equal(none.criteria.specimens_collected.score, null);
  assert.equal(none.criteria.implants_devices.na, true);
  assert.equal(none.criteria.estimated_blood_loss.score, 0);

  const sent = scoreOtNabh({
    note: 'Specimen sent for histopath.',
    component_json: [],
  });
  assert.equal(sent.criteria.specimens_collected.score, 2);
  assert.equal(sent.criteria.specimens_collected.na, undefined);
});

test('component_json string and stored-row field names score the same note', () => {
  const json = JSON.stringify(comp({ 'surgery-name': 'Appendicectomy' }));
  const fromString = scoreOtNabh({ component_json: json, surgery_name: 'Appendicectomy' });
  assert.equal(fromString.criteria.procedure_named.score, 2);
});

test('pulse hop never fabricates a doctor for unmapped or multi-surgeon rows', () => {
  assert.deepEqual(pulseSurgeonLabel({
    map_status: 'mapped', doctor_uid: 'DOC-1', pulseName: 'Dr Manoj Kumar S',
  }), { status: 'mapped', pulseName: 'Dr Manoj Kumar S' });
  assert.deepEqual(pulseSurgeonLabel({
    map_status: 'mapped', doctor_uid: 'DOC-1', pulseName: '  ',
  }), { status: 'mapped', pulseName: null });
  assert.deepEqual(pulseSurgeonLabel({
    map_status: 'unmapped', doctor_uid: 'DOC-LEAK', pulseName: 'Dr Someone',
  }), { status: 'unmapped', pulseName: null });
  assert.deepEqual(pulseSurgeonLabel({
    map_status: 'multi_surgeon_hold', doctor_uid: 'DOC-LEAK', pulseName: 'Dr Someone',
  }), { status: 'multi_surgeon_hold', pulseName: null });
  assert.deepEqual(pulseSurgeonLabel({
    map_status: 'mapped', doctor_uid: null, pulseName: 'Dr Someone',
  }), { status: 'unmapped', pulseName: null });
});

test('surgeon search uses the mapped Pulse name and ignores a name on an unmapped row', () => {
  const rows: OtAdminListRow[] = [
    row({ id: '1', surgeon_raw: 'DR MANOJ KUMAR S', map_status: 'mapped', doctor_uid: 'DOC-1', nabh_score_pct: 82 }),
    row({ id: '2', surgeon_raw: 'DR.NAVEEN KUMAR AG', map_status: 'unmapped', doctor_uid: 'DOC-2', nabh_score_pct: 40 }),
    row({ id: '3', surgeon_raw: 'DR HOLD', map_status: 'multi_surgeon_hold', doctor_uid: null, nabh_score_pct: 70 }),
  ];
  const names = { 'DOC-1': 'Dr Manoj Kumar S', 'DOC-2': 'Dr Naveen Should Not Match' };
  assert.deepEqual(filterOtAdminList(rows, { surgeon: 'manoj' }, names).map((r) => r.id), ['1']);
  assert.deepEqual(filterOtAdminList(rows, { surgeon: 'naveen' }, names).map((r) => r.id), ['2']);
  assert.deepEqual(filterOtAdminList(rows, { surgeon: 'should not match' }, names).map((r) => r.id), []);
  assert.deepEqual(filterOtAdminList(rows, { band: 'ge80' }, {}).map((r) => r.id), ['1']);
  assert.deepEqual(filterOtAdminList(rows, { band: 'mid' }, {}).map((r) => r.id), ['3']);
  assert.deepEqual(filterOtAdminList(rows, { band: 'lt60' }, {}).map((r) => r.id), ['2']);
  assert.deepEqual(filterOtAdminList(rows, { map: 'unmapped' }, {}).map((r) => r.id), ['2']);
  assert.equal(meanPersistedNabhPct([{ nabh_score_pct: null }, { nabh_score_pct: 80 }, { nabh_score_pct: 60 }]), 70);
  assert.equal(meanPersistedNabhPct([{ nabh_score_pct: null }]), null);
});

test('persisted criteria are not coerced; a missing score stays missing', () => {
  assert.equal(readPersistedCriterion(undefined), null);
  assert.equal(readPersistedCriterion({ evidence: '' }), null);
  assert.deepEqual(readPersistedCriterion({ score: null, na: true, evidence: 'none sent' }), {
    score: null, na: true, evidence: 'none sent',
  });
  assert.deepEqual(readPersistedCriterion({ score: '2', evidence: 'mesh' }), {
    score: 2, na: false, evidence: 'mesh',
  });
  const parsed = readPersistedCriteria({ procedure_named: { score: 0, evidence: 'absent' }, junk: { score: 9 } });
  assert.deepEqual(parsed.procedure_named, { score: 0, na: false, evidence: 'absent' });
  assert.equal(parsed.junk, undefined);
});

test('list SQL reads persisted NABH columns and does not re-list uid inside DISTINCT ON', () => {
  const sqlText = buildOtAdminListSql();
  assert.match(sqlText, /nabh_score_pct/);
  assert.match(sqlText, /ot-note-audit\/0\.1/);
  assert.match(sqlText, /SELECT DISTINCT ON \(uid\)/);
  const inner = sqlText.match(/SELECT DISTINCT ON \(uid\) (.+?)\s+FROM ot_note_audits/s)?.[1];
  assert.ok(inner);
  const uidHits = inner!.match(/\buid\b/g) || [];
  assert.equal(uidHits.length, 1, inner);
  assert.ok(!/surgery_cases/.test(sqlText));
  assert.ok(!/patient_name/.test(sqlText));
  assert.ok(!/patient_mobile/.test(sqlText));
});

test('migration and backfill add NABH columns without rewriting lander findings or the write mint', () => {
  const migration = readFileSync('migrations/0062_ot_nabh_scores.sql', 'utf8');
  for (const col of ['nabh_score_sum', 'nabh_score_max', 'nabh_score_pct', 'nabh_criteria', 'nabh_engine_version', 'nabh_scored_at']) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${col}`));
  }
  assert.match(migration, /Does not set TRIAGE_BOT_WRITE_CLASSES/);
  assert.ok(!/DROP COLUMN/i.test(migration));
  assert.ok(!/UPDATE ot_note_audits/i.test(migration));

  const setList = OT_NABH_BACKFILL_UPDATE_SQL.slice(0, OT_NABH_BACKFILL_UPDATE_SQL.indexOf('WHERE'));
  assert.match(setList, /nabh_criteria/);
  assert.ok(!/\bfindings\b/.test(setList));
  assert.ok(!/\bmap_status\b/.test(setList));
  assert.ok(!/\bdoctor_uid\b/.test(setList));

  const store = readFileSync('lib/triage/ot-audit-store.ts', 'utf8');
  assert.match(store, /ON CONFLICT \(uid, engine_version\) DO NOTHING/);
  assert.match(store, /nabh_engine_version/);
  assert.ok(!/surgery_cases/.test(store));
  assert.ok(!/TRIAGE_BOT_WRITE_CLASSES/.test(store));
});

test('admin routes, sidebar placement, and the page do not score or invent a Pulse doctor', () => {
  const shell = readFileSync('components/Shell.tsx', 'utf8');
  const ipd = shell.indexOf("label: 'IPD Discharge Audit'");
  const ot = shell.indexOf("label: 'OT Audit'");
  const scoring = shell.indexOf("label: 'Scoring policy'");
  assert.ok(ipd > 0 && ot > ipd && scoring > ot);
  const between = shell.slice(ipd + "label: 'IPD Discharge Audit'".length, ot);
  assert.ok(!between.includes('label:'), between);

  const list = readFileSync('app/admin/ot-audit/page.tsx', 'utf8');
  const detail = readFileSync('app/admin/ot-audit/[id]/page.tsx', 'utf8');
  const ui = readFileSync('app/admin/ot-audit/ui.tsx', 'utf8');
  for (const src of [list, detail, ui]) {
    assert.ok(!src.includes('scoreOtNabh'));
    assert.ok(!/surgery_cases/.test(src));
    assert.ok(!/current_treating_doctor/.test(src));
    assert.ok(!/fuzzy/i.test(src));
  }
  assert.match(list, /isAdminUnlocked/);
  assert.match(list, /istDateRange/);
  assert.match(list, /period=day\|week\|month|period === 'week'/);
  assert.match(ui, /action="\/api\/admin\/unlock"/);
  assert.match(ui, /name="next" value="\/admin\/ot-audit"/);
  assert.match(detail, /NABH completeness/);
  assert.match(detail, /Action-queue lander screen/);
  assert.match(detail, /Note body/);
  assert.ok(detail.indexOf('NABH completeness') < detail.indexOf('Action-queue lander screen'));
  assert.ok(detail.indexOf('Action-queue lander screen') < detail.indexOf('Note body'));
  assert.match(detail, /These are not the NABH rubric/);
  assert.match(list, /nabh_score_pct/);

  const worker = readFileSync('app/api/ot-audit/worker/route.ts', 'utf8');
  assert.match(worker, /backfillOtNabhScores/);
  assert.match(worker, /write_mint/);
  assert.match(worker, /blocked — ot absent from TRIAGE_BOT_WRITE_CLASSES/);
  assert.ok(!/TRIAGE_BOT_WRITE_CLASSES\s*=/.test(worker));
});

function row(partial: Partial<OtAdminListRow> & Pick<OtAdminListRow, 'id' | 'surgeon_raw' | 'map_status' | 'doctor_uid' | 'nabh_score_pct'>): OtAdminListRow {
  return {
    uid: partial.id,
    hospital_uid: 'H1',
    uhid: 'U1',
    surgery_name: 'Repair',
    note_day: '2026-09-01',
    n_findings: 1,
    engine_version: 'ot-note-audit/0.1',
    nabh_engine_version: 'ot-nabh/0.1',
    ...partial,
  };
}
