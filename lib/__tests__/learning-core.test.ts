/**
 *   node --experimental-strip-types --test lib/__tests__/learning-core.test.ts
 * Pure learning-loop miner: clustering + the volume/evidence gates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subjectSignature, mineRuleCandidates, mineHarvestGaps, DEFAULT_THRESHOLDS, DEFAULT_GAP_THRESHOLDS, parseCanonicalMap,
  type AuditRowLite, type AuditFindingLite,
} from '../learning-core.ts';

const SRC = [{ n: 1, book: 'StatPearls', item_number: 'NBK1', url: 'https://pubmed.ncbi.nlm.nih.gov/1/', preview: 'evidence' }];

function row(id: string, doctor: string, findings: AuditFindingLite[]): AuditRowLite {
  return { id, doctor_uid: doctor, consult_type: 'GENERAL_PRACTITIONER', findings, sources: SRC };
}
const lv = (subject: string, cited = true): AuditFindingLite => ({
  subject, verdict: 'low-value', domain: 'appropriateness', rationale: 'low yield', source: 'llm',
  citation_ids: cited ? [1] : [],
});

test('subjectSignature clusters near-verbatim subjects, ignores dose/case/parentheticals', () => {
  assert.equal(subjectSignature('Ordering a Complete Blood Profile (CBP)'), subjectSignature('ordering complete blood profile'));
  assert.equal(subjectSignature('Antibiotic for likely viral URTI'), subjectSignature('Antibiotic for viral URTI'));
});

test('mineRuleCandidates: passes the volume + evidence gates, excludes the rest', () => {
  const rows: AuditRowLite[] = [];
  // Cluster A: 16 occurrences across 4 doctors, cited → SHOULD pass
  for (let i = 0; i < 16; i++) rows.push(row(`a${i}`, `doc${i % 4}`, [lv('Antibiotic for likely viral URTI')]));
  // Cluster B: 20 occurrences but only 2 doctors → fails the doctor gate
  for (let i = 0; i < 20; i++) rows.push(row(`b${i}`, `doc${i % 2}`, [lv('Lumbar X-ray for acute low back pain')]));
  // Cluster C: 18 occurrences, 4 doctors, but NO citation → fails the evidence gate
  for (let i = 0; i < 18; i++) rows.push(row(`c${i}`, `doc${i % 4}`, [lv('Multivitamin for fatigue', false)]));
  // Noise: informational + high-value never mine
  rows.push(row('n1', 'docX', [{ subject: 'High-alert medication: Enoxaparin', verdict: 'uncertain', domain: 'prescribing_safety', informational: true, citation_ids: [] }]));
  rows.push(row('n2', 'docY', [{ subject: 'Appropriate antibiotic choice', verdict: 'high-value', domain: 'appropriateness', citation_ids: [1] }]));

  const cands = mineRuleCandidates(rows, DEFAULT_THRESHOLDS);
  assert.equal(cands.length, 1, 'only cluster A clears both gates');
  const c = cands[0];
  assert.ok(/viral|urti|antibiotic/i.test(c.clusterKey));
  assert.ok(c.payload.statement.startsWith('Avoid'));
  assert.equal(c.payload.provenance, 'EHRC-mined');
  assert.ok(c.evidence.length >= 1, 'carries cited evidence');
  assert.ok(c.provenance.nOccurrences >= 15 && c.provenance.nDoctors >= 3);
  assert.equal(c.suggestedReviewer, 'dept_lead'); // appropriateness, single consult-type → dept lead
});

test('parseCanonicalMap maps indices → labels, ignores out-of-range', () => {
  const subjects = ['Antibiotic for viral URTI', 'Cefpodoxime for acute pharyngitis', 'Lumbar X-ray for acute LBP'];
  const text = 'noise {"map":[{"i":1,"label":"Antibiotic for viral URI"},{"i":2,"label":"Antibiotic for viral URI"},{"i":3,"label":"Imaging for acute low back pain"},{"i":9,"label":"ignored"}]} trailing';
  const m = parseCanonicalMap(text, subjects);
  assert.equal(m[subjects[0]], 'Antibiotic for viral URI');
  assert.equal(m[subjects[1]], 'Antibiotic for viral URI'); // paraphrase merged to same label
  assert.equal(m[subjects[2]], 'Imaging for acute low back pain');
});

test('canonical label MERGES paraphrases that the deterministic signature would fragment', () => {
  // 16 genuinely distinct phrasings (different tokens) across 4 doctors → no signature cluster reaches 15.
  const SUBS = [
    'Antibiotic for sore throat', 'Cefpodoxime for pharyngitis', 'Azithromycin for common cold',
    'Amoxicillin for runny nose', 'Cefixime for nasal congestion', 'Levofloxacin for cough',
    'Cefuroxime for fever', 'Ofloxacin for rhinitis', 'Clarithromycin for sinus complaints',
    'Doxycycline for throat pain', 'Cephalexin for sneezing', 'Augmentin for tonsil irritation',
    'Cefdinir for upper airway symptoms', 'Roxithromycin for hoarseness', 'Faropenem for postnasal drip',
    'Moxifloxacin for laryngeal discomfort',
  ];
  const rows: AuditRowLite[] = SUBS.map((s, i) => row(`x${i}`, `doc${i % 4}`, [lv(s)]));
  const deterministic = mineRuleCandidates(rows, DEFAULT_THRESHOLDS);
  assert.equal(deterministic.length, 0, 'fragmented subjects clear no cluster without canonicalisation');

  const canon = mineRuleCandidates(rows, DEFAULT_THRESHOLDS, { canonicalLabel: () => 'Antibiotic for viral upper respiratory infection' });
  assert.equal(canon.length, 1, 'canonical label merges all 16 into one cluster');
  assert.equal(canon[0].title, 'Antibiotic for viral upper respiratory infection');
  assert.ok(canon[0].provenance.nOccurrences === 16 && canon[0].provenance.nDoctors === 4);
});

test('mineHarvestGaps: predominantly-UNCITED practices become harvest topics; well-cited/sparse do not', () => {
  const rows: AuditRowLite[] = [];
  // (1) Gap: 12 occurrences, none cited → 12 uncited, citedFrac 0
  for (let i = 0; i < 12; i++) rows.push(row(`g${i}`, `doc${i % 3}`, [lv('Serratiopeptidase for soft-tissue swelling', false)]));
  // (2) Gap: 18 occurrences, only the first 4 cited (citedFrac 0.22) across 4 doctors → 14 uncited
  for (let i = 0; i < 18; i++) rows.push(row(`m${i}`, `doc${i % 4}`, [lv('NSAID injection for non-specific low back pain', i < 4)]));
  // (3) NOT a gap: 12 uncited but 20 cited (citedFrac 0.625 > 0.5) → corpus already covers it
  for (let i = 0; i < 32; i++) rows.push(row(`w${i}`, `doc${i % 5}`, [lv('Antibiotic for likely viral URTI', i >= 12)]));
  // (4) NOT a gap: only 5 uncited → below the volume floor
  for (let i = 0; i < 5; i++) rows.push(row(`s${i}`, `doc${i % 3}`, [lv('Nebulisation for simple cough', false)]));

  const gaps = mineHarvestGaps(rows, DEFAULT_GAP_THRESHOLDS);
  const titles = gaps.map((g) => g.title.toLowerCase());
  assert.equal(gaps.length, 2, 'the two predominantly-uncited clusters are gaps');
  assert.ok(titles.some((t) => /serratiopeptidase|swelling/.test(t)));
  assert.ok(titles.some((t) => /nsaid|back pain/.test(t)));
  assert.ok(!titles.some((t) => /viral|urti/.test(t)), 'a well-cited practice is not a corpus gap');
  const g = gaps[0]; // sorted by nUncited desc → the NSAID cluster (14)
  assert.equal(g.type, 'harvest_topic');
  assert.ok(g.payload.query_terms.includes(' AND '), 'carries an AND-joined PubMed query');
  assert.ok(g.provenance.nUncited >= 10 && g.provenance.nDoctors >= 3);
  assert.equal(g.suggestedReviewer, 'owner');
});

test('mineRuleCandidates: context-dependent → limit; prescribing domain → pharmacy_ams', () => {
  const rows: AuditRowLite[] = [];
  for (let i = 0; i < 16; i++) {
    rows.push(row(`p${i}`, `doc${i % 5}`, [{
      subject: 'FDC Aceclofenac+Paracetamol+Serratiopeptidase', verdict: 'context-dependent',
      domain: 'prescribing_safety', rationale: 'irrational FDC', source: 'llm', citation_ids: [1],
    }]));
  }
  const cands = mineRuleCandidates(rows, DEFAULT_THRESHOLDS);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].payload.action_type, 'limit');
  assert.ok(cands[0].payload.statement.startsWith('Limit'));
  assert.equal(cands[0].suggestedReviewer, 'pharmacy_ams');
});

// ── Reviewer-driven mining (LEARNING-LOOP-V2 §2.3) ──
import {
  mineMissedFlags, mineFalseClusters, truncateCard,
  MISSED_FLAG_MIN, FALSE_CLUSTER_MIN, FALSE_CLUSTER_MIN_REVIEWERS,
  type MissedFlagLite, type FindingLabelLite,
} from '../learning-core.ts';

const mf = (audit_id: string, comment: string, author: string, category: string | null = 'prescribing_safety'): MissedFlagLite =>
  ({ audit_id, comment, author, category });

test('truncateCard: caps + ellipsis at the 140 boundary, collapses whitespace', () => {
  assert.equal(truncateCard('  a   b  '), 'a b');
  const long = 'x'.repeat(200);
  assert.equal(truncateCard(long).length, 140);
  assert.ok(truncateCard(long).endsWith('…'));
});

test('mineMissedFlags: ≥2 same-signature flags cluster; <2 excluded', () => {
  const flags = [
    mf('a1', 'Missed dual H1 antihistamine duplication', 'zaki'),
    mf('a2', 'missed the dual H1-antihistamine duplication', 'meera'),
    mf('a3', 'A totally unrelated one-off note', 'zaki'),
  ];
  const out = mineMissedFlags(flags); // no isCitable → all harvest
  assert.equal(out.length, 1);
  assert.equal(out[0].provenance.nFlags, 2);
  assert.deepEqual(out[0].provenance.reviewers.sort(), ['meera', 'zaki']);
});

test('mineMissedFlags: citable cluster → deterministic missed_rule draft', () => {
  const flags = [mf('a1', 'Missed dual antihistamine duplication', 'zaki'), mf('a2', 'missed dual antihistamine duplication', 'meera')];
  const out = mineMissedFlags(flags, { isCitable: () => true });
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.type, 'missed_rule');
  if (c.type !== 'missed_rule') return;
  assert.equal(c.payload.provenance, 'EHRC-mined');
  assert.equal(c.payload.action_type, 'avoid');
  assert.ok(c.payload.keywords.length > 0);
  assert.ok(c.payload.statement.length > 0);
  assert.equal(c.suggestedReviewer, 'pharmacy_ams'); // prescribing_safety → pharmacy_ams
  // cards truncate reviewer free-text to 140
  assert.ok(c.provenance.sampleComments.every((s) => s.length <= 140));
});

test('mineMissedFlags: uncitable → harvest_topic (evidence over frequency)', () => {
  const flags = [mf('a1', 'Missed some novel emerging thing', 'zaki', 'other'), mf('a2', 'missed some novel emerging thing', 'meera', 'other')];
  const out = mineMissedFlags(flags, { isCitable: () => false });
  assert.equal(out[0].type, 'harvest_topic');
  if (out[0].type !== 'harvest_topic') return;
  assert.equal(out[0].provenance.source, 'missed_flags');
  assert.equal(out[0].suggestedReviewer, 'owner');
});

const fl = (audit_id: string, subject: string, verdict: string, author: string, signal_type = 'low_value_care'): FindingLabelLite =>
  ({ audit_id, finding_ref: `${audit_id}:0`, subject, signal_type, verdict, author });

test('mineFalseClusters: ≥3 false/nitpick across ≥2 reviewers AND precision <0.5 → suppression', () => {
  const labels = [
    fl('a1', 'Vitamin D level in routine screen', 'false', 'zaki'),
    fl('a2', 'vitamin D level routine screen', 'nitpick', 'meera'),
    fl('a3', 'Vitamin-D level, routine screen', 'false', 'zaki'),
  ];
  const out = mineFalseClusters(labels);
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.type, 'suppression');
  assert.equal(c.payload.action, 'downgrade');
  assert.equal(c.payload.scope, 'all');
  assert.equal(c.payload.signal_type, 'low_value_care');
  assert.equal(c.provenance.nFalseNitpick, 3);
  assert.ok(c.provenance.precision < 0.5);
  assert.equal(c.provenance.reviewers.length, 2);
  assert.equal(c.suggestedReviewer, 'pharmacy_ams');
});

test('mineFalseClusters: precision ≥0.5 blocks the candidate even at volume', () => {
  const labels = [
    fl('a1', 'Same subject phrase here', 'false', 'zaki'),
    fl('a2', 'same subject phrase here', 'nitpick', 'meera'),
    fl('a3', 'same subject phrase here', 'false', 'zaki'),
    fl('a4', 'same subject phrase here', 'true_positive', 'meera'),
    fl('a5', 'same subject phrase here', 'true_positive', 'zaki'),
    fl('a6', 'same subject phrase here', 'true_positive', 'meera'),
  ]; // tp=3, fn=3 → precision 0.5, NOT <0.5
  assert.equal(mineFalseClusters(labels).length, 0);
});

test('mineFalseClusters: single-reviewer cluster blocked (needs ≥2)', () => {
  const labels = [
    fl('a1', 'Only zaki flagged this', 'false', 'zaki'),
    fl('a2', 'only zaki flagged this', 'nitpick', 'zaki'),
    fl('a3', 'only zaki flagged this', 'false', 'zaki'),
  ];
  assert.equal(mineFalseClusters(labels).length, 0);
});

test('gate constants pinned to §2.3 normative values', () => {
  assert.equal(MISSED_FLAG_MIN, 2);
  assert.equal(FALSE_CLUSTER_MIN, 3);
  assert.equal(FALSE_CLUSTER_MIN_REVIEWERS, 2);
});
