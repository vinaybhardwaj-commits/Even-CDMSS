/**
 *   node --experimental-strip-types --test lib/__tests__/doctor-directory-core.test.ts
 * Pure core: canonical doctor-roster recipe (normalize name, drop generics, dedupe by mobile).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDoctorName, mobileLast4, isGenericDoctorRow, buildRoster, type RosterInput } from '../doctor-directory-core.ts';

test('normalizeDoctorName: order-independent, Dr/punct stripped', () => {
  assert.equal(normalizeDoctorName('Dr. K N Srikanth'), 'k n srikanth');
  assert.equal(normalizeDoctorName('Srikanth K N'), 'k n srikanth');           // same key regardless of order
  assert.equal(normalizeDoctorName('Dr Reshma'), 'reshma');
  assert.equal(normalizeDoctorName('DR. DARSHANA  R.'), 'darshana r');
  assert.equal(normalizeDoctorName(''), '');
});

test('mobileLast4', () => {
  assert.equal(mobileLast4('+91 63621 91675'), '1675');
  assert.equal(mobileLast4('9876543210'), '3210');
  assert.equal(mobileLast4('12'), null);
  assert.equal(mobileLast4(null), null);
});

test('isGenericDoctorRow: system/placeholder rows dropped', () => {
  assert.equal(isGenericDoctorRow({ name: 'Even Health' }), true);
  assert.equal(isGenericDoctorRow({ name: 'Dr Test Doctor' }), true);
  assert.equal(isGenericDoctorRow({ name: 'Dr Reshma', email: 'hello@even.in' }), true);
  assert.equal(isGenericDoctorRow({ name: 'Dr Reshma', mobile: '+919999999999' }), true);
  assert.equal(isGenericDoctorRow({ name: '' }), true);
  assert.equal(isGenericDoctorRow({ name: 'Dr Reshma', email: 'reshma@even.in', mobile: '9876543210' }), false);
});

test('buildRoster: drops generics, dedupes same-person by mobile, folds activity', () => {
  const inputs: RosterInput[] = [
    // same person, two uids sharing a mobile: one audit-active, one operational-active
    { doctor_uid: 'uidA', name: 'Dr Darshana R', email: 'd@even.in', mobile: '9000000001', audit_active: true, operational_active: false },
    { doctor_uid: 'uidB', name: 'Darshana R', email: null, mobile: '90000 00001', audit_active: false, operational_active: true },
    // a distinct doctor, no mobile
    { doctor_uid: 'uidC', name: 'Dr Srikanth K N', email: 's@even.in', mobile: null, audit_active: true, operational_active: false },
    // a generic row → dropped
    { doctor_uid: 'uidZ', name: 'Even Health', email: 'hello@even.in', mobile: '919999999999', audit_active: false, operational_active: false },
  ];
  const roster = buildRoster(inputs);
  assert.equal(roster.length, 2);                                // generic dropped, duplicate folded to one
  const darshana = roster.find((r) => r.name_normalized === 'darshana r')!;
  assert.ok(darshana);
  assert.equal(darshana.audit_active, true);                     // folded across the cluster
  assert.equal(darshana.operational_active, true);
  assert.equal(darshana.mobile_last4, '0001');
  // canonical uid = the active/lexicographically-first of the cluster (uidA: audit-active)
  assert.equal(darshana.doctor_uid, 'uidA');
  const srikanth = roster.find((r) => r.doctor_uid === 'uidC')!;
  assert.equal(srikanth.name_normalized, 'k n srikanth');
  assert.equal(srikanth.mobile_last4, null);
  assert.equal(srikanth.has_email, true);
});

test('buildRoster: no-mobile rows are never merged with each other', () => {
  const inputs: RosterInput[] = [
    { doctor_uid: 'u1', name: 'Dr A One', mobile: null, audit_active: true, operational_active: false },
    { doctor_uid: 'u2', name: 'Dr B Two', mobile: null, audit_active: true, operational_active: false },
  ];
  assert.equal(buildRoster(inputs).length, 2);
});
