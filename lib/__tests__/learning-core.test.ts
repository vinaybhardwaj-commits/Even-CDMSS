/**
 *   node --experimental-strip-types --test lib/__tests__/learning-core.test.ts
 * Pure learning-loop miner: clustering + the volume/evidence gates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subjectSignature, mineRuleCandidates, DEFAULT_THRESHOLDS,
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
