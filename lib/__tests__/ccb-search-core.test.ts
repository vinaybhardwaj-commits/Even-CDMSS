/**
 *   node --experimental-strip-types --test lib/__tests__/ccb-search-core.test.ts
 * Pure member-search core: query classification (Pulse-parity routing), injection-safe SQL
 * builders, and hit shaping. Pins the fix for the /care search that only accepted a presc uid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyQuery, planHasProbe, normPhone, sanitizeNameToken, computeAge, fullName,
  membersByMemberIdSql, individualsByMobilesSql, individualByUidSql, individualsByUhidSql,
  individualUidByPrescSql, individualsByNameSql, episodesByParentsSql, individualsByUidsSql,
  mapIndividualRow, buildHits,
  type IndividualIdentity,
} from '../ccb-search-core.ts';

const MEDICAL = ['GENERAL_PRACTITIONER', 'HOSPITAL_GP', 'HOSPITAL_PAEDIATRIC'];

// ── Classification (the real inputs Mohsin typed) ───────────────────────────────
test('member ID (12 digits) routes to member-id + phone probes, not name', () => {
  const p = classifyQuery('000000000001');
  assert.equal(p.memberId, '000000000001');
  assert.equal(p.nameTokens, null);
  assert.equal(planHasProbe(p), true);
});

test('individual UID (Firestore doc id) routes to a uid probe, not name/phone', () => {
  const p = classifyQuery('ExampleUid0000000001');
  assert.equal(p.uid, 'ExampleUid0000000001');
  assert.equal(p.nameTokens, null);
  assert.equal(p.phone, null);
});

test('10-digit phone and +91/spaced variants all normalize to +91XXXXXXXXXX', () => {
  assert.equal(normPhone('9000000001'), '+919000000001');
  assert.equal(normPhone('+91 90000 00001'), '+919000000001');
  assert.equal(normPhone('09000000001'), '+919000000001');
  assert.equal(normPhone('12345'), null);          // too short
  assert.equal(normPhone('1234567890'), null);     // not a 6–9 leading mobile
  assert.equal(classifyQuery('9000000001').phone, '+919000000001');
});

test('UHID routes to a uhid probe', () => {
  const p = classifyQuery('UHID-000000');
  assert.equal(p.uhid, 'UHID-000000');
});

test('a name phrase routes to name tokens (and not to a uid probe)', () => {
  const p = classifyQuery('Example Fernandes');
  assert.deepEqual(p.nameTokens, ['Example', 'Fernandes']);
  assert.equal(p.uid, null);
});

test('a single plain word is a name, not an id', () => {
  const p = classifyQuery('Fernandes');
  assert.deepEqual(p.nameTokens, ['Fernandes']);
  assert.equal(p.uid, null);
  assert.equal(p.uhid, null);
});

test('too-short / empty queries yield no probe', () => {
  assert.equal(planHasProbe(classifyQuery('')), false);
  assert.equal(planHasProbe(classifyQuery('a')), false);
});

// ── Injection safety ────────────────────────────────────────────────────────────
test('name builder can not break out of its string literal (quotes balanced, no statement break)', () => {
  const s = individualsByNameSql(["Rob'; DROP TABLE individuals;--"]);
  // Every single-quote is part of an escaped/opening/closing pair → the literal can't be closed early.
  assert.equal((s.match(/'/g) || []).length % 2, 0);
  assert.equal(s.includes("';"), false);   // no "close-quote then new statement"
  assert.match(s, /FROM individuals i WHERE/);
  // The dangerous ';' and the raw single-quote were neutralized (';'→space, '→'').
  assert.match(s, /ILIKE 'Rob''/);
});

test('sanitizeNameToken removes metacharacters but keeps real names', () => {
  assert.equal(sanitizeNameToken("O'Brien"), "O''Brien");   // '-escaped for SQL
  assert.equal(sanitizeNameToken('bob%_\\'), 'bob');
  assert.equal(sanitizeNameToken('Anne-Marie'), 'Anne-Marie');
});

test('id/phone builders reject junk and embed only validated values', () => {
  assert.throws(() => individualByUidSql("x'; --"));
  assert.throws(() => individualsByMobilesSql(['not-a-phone']));
  assert.throws(() => individualsByUhidSql("bad'quote"));
  assert.throws(() => individualUidByPrescSql('short'));
  const m = membersByMemberIdSql('000000000000');
  assert.match(m, /membership_id = '000000000000'/);
  assert.match(m, /ANY\(old_membership_ids\)/);
  const ph = individualsByMobilesSql(['+919000000001']);
  assert.match(ph, /mobiles && ARRAY\['\+919000000001'\]::text\[\]/);
});

test('individualsByUidsSql batches identity by uid and validates', () => {
  const s = individualsByUidsSql(['ExampleUid0000000001', 'bad uid', 'JLZLOuCHCDvmhcdcQj1O']);
  assert.match(s, /FROM individuals i WHERE i\.uid IN \('ExampleUid0000000001', 'JLZLOuCHCDvmhcdcQj1O'\)/);
  assert.throws(() => individualsByUidsSql(['bad uid']));
});

test('episodes builder targets prescriptions with validated uids + types', () => {
  const s = episodesByParentsSql(['ExampleUid0000000001'], MEDICAL);
  assert.match(s, /FROM "individuals-prescriptions"/);
  assert.match(s, /_parent_id IN \('ExampleUid0000000001'\)/);
  assert.match(s, /is_draft = false/);
  assert.match(s, /'GENERAL_PRACTITIONER'/);
  assert.throws(() => episodesByParentsSql(['bad uid'], MEDICAL));
  assert.throws(() => episodesByParentsSql(['ExampleUid0000000001'], ['nope; drop']));
});

// ── Hit shaping ─────────────────────────────────────────────────────────────────
test('computeAge / fullName behave', () => {
  const at = new Date(Date.UTC(2026, 6, 1)); // 2026-07-01
  assert.equal(computeAge('1995-11-09', at), 30);
  assert.equal(computeAge(null), null);
  assert.equal(computeAge('garbage'), null);
  assert.equal(fullName('Example', 'Fernandes', null), 'Example Fernandes');
  assert.equal(fullName(null, null, 'Display Name'), 'Display Name');
  assert.equal(fullName(null, null, null), 'Unknown member');
});

test('buildHits groups episodes, ranks has-episodes first, and picks the latest', () => {
  const ids: IndividualIdentity[] = [
    { uid: 'AAAAAA', firstName: 'No', lastName: 'Visits', displayName: null, gender: 'MALE', dob: '1990-01-01', uhid: null, mobiles: ['+911111111111'] },
    { uid: 'ExampleUid0000000001', firstName: 'Example', lastName: 'Fernandes', displayName: null, gender: 'FEMALE', dob: '1995-11-09', uhid: 'UHID-000000', mobiles: ['+919000000001'] },
    // duplicate of Example from a second probe — must dedupe
    { uid: 'ExampleUid0000000001', firstName: 'Example', lastName: 'Fernandes', displayName: null, gender: 'FEMALE', dob: '1995-11-09', uhid: 'UHID-000000', mobiles: ['+919000000001'] },
  ];
  const eps = [
    { uid: 'lFe7BzBrSyekYqYRRlZe', individual_uid: 'ExampleUid0000000001', type_of_prescription: 'GENERAL_PRACTITIONER', visit_date: '2026-03-17' },
    { uid: 'IOp6crZglsDPu8HimEIy', individual_uid: 'ExampleUid0000000001', type_of_prescription: 'GENERAL_PRACTITIONER', visit_date: '2024-11-27' },
  ];
  const hits = buildHits(ids, eps, { '+919000000001': '000000000001' }, { now: new Date(Date.UTC(2026, 6, 1)) });
  assert.equal(hits.length, 2);                              // deduped
  assert.equal(hits[0].individualUid, 'ExampleUid0000000001'); // has-episodes ranked first
  assert.equal(hits[0].latestEpisodeUid, 'lFe7BzBrSyekYqYRRlZe');
  assert.equal(hits[0].episodeCount, 2);
  assert.equal(hits[0].lastVisit, '2026-03-17');
  assert.equal(hits[0].membershipId, '000000000001');
  assert.equal(hits[0].age, 30);
  assert.equal(hits[1].latestEpisodeUid, null);              // the no-visits member, disabled in UI
});

test('mapIndividualRow validates the uid and coerces arrays', () => {
  assert.equal(mapIndividualRow({ uid: 'bad uid' }), null);
  const id = mapIndividualRow({ uid: 'ExampleUid0000000001', first_name: 'J', mobiles: ['+919000000001'] });
  assert.equal(id?.uid, 'ExampleUid0000000001');
  assert.deepEqual(id?.mobiles, ['+919000000001']);
});
