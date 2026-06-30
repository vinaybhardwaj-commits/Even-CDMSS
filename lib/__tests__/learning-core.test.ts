/**
 *   node --experimental-strip-types --test lib/__tests__/learning-core.test.ts
 * Pure learning-loop miner: clustering + the volume/evidence gates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subjectSignature, mineRuleCandidates, DEFAULT_THRESHOLDS, parseCanonicalMap,
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
