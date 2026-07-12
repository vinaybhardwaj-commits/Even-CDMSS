import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unindicatedRespFindings, decongestantDurationFindings, dedupeRouteAware } from '@/lib/opd-note-audit';
import { opdCaseText, type DeidOpdCase, type OpdMed } from '@/lib/opd-ingest-core';
import type { OpdFinding } from '@/lib/opd-note-audit-core';

function mkCase(p: Partial<DeidOpdCase> = {}): DeidOpdCase {
  return {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [],
    impressionCodes: [], impressions: [], history: [], comorbidities: [], medications: [],
    investigations: [], advice: [], examination: [], allergies: null, followUpType: null, followUpDateSet: false, ...p,
  };
}
const det = (subject: string, source: 'deterministic' | 'llm' = 'deterministic'): OpdFinding =>
  ({ subject, verdict: 'low-value', confidence: 0.7, domain: 'prescribing_safety', rationale: '', evidence: [], estimates: [], citation_ids: [], source });

// ── bug 1 — unindicated bronchodilator / antihistamine+montelukast for an acute URTI ─────
test('bug 1: xanthine for an acute URTI fires (context-guarded)', () => {
  const c = mkCase({ presentingComplaints: ['common cold, sore throat'], medications: [{ generic: 'Acebrophylline' } as OpdMed] });
  const fs = unindicatedRespFindings(c);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].domain, 'appropriateness');
  assert.equal(fs[0].verdict, 'low-value');
});
test('bug 1: the SAME xanthine is NOT flagged for a chronic-airways patient (J40–J47 guard)', () => {
  const c = mkCase({ presentingComplaints: ['common cold'], diagnosisCodes: ['J44.9'], medications: [{ generic: 'Acebrophylline' } as OpdMed] });
  assert.equal(unindicatedRespFindings(c).length, 0);
  const c2 = mkCase({ presentingComplaints: ['cough'], impressions: ['Bronchial asthma'], medications: [{ generic: 'Doxophylline' } as OpdMed] });
  assert.equal(unindicatedRespFindings(c2).length, 0);
});
test('bug 1: antihistamine + montelukast for a viral URTI fires', () => {
  const c = mkCase({ presentingComplaints: ['viral URTI'], medications: [{ generic: 'Levocetirizine' } as OpdMed, { generic: 'Montelukast' } as OpdMed] });
  const fs = unindicatedRespFindings(c);
  assert.ok(fs.some((f) => /montelukast/i.test(f.subject)));
});
test('bug 1: no acute-URTI context → nothing fires', () => {
  const c = mkCase({ presentingComplaints: ['knee pain'], medications: [{ generic: 'Acebrophylline' } as OpdMed] });
  assert.equal(unindicatedRespFindings(c).length, 0);
});

// ── bug 3 — nasal decongestant >5 days ────────────────────────────────────────
test('bug 3: an imidazoline nasal decongestant for >5 days fires', () => {
  const fs = decongestantDurationFindings([{ generic: 'Oxymetazoline', route: 'nasal', duration: '7 days' } as OpdMed]);
  assert.equal(fs.length, 1);
  assert.match(fs[0].subject, /7 days/);
});
test('bug 3: 1 week (=7d) fires; 3 days does not; ingredient-level in an FDC', () => {
  assert.equal(decongestantDurationFindings([{ generic: 'Xylometazoline', duration: '1 week' } as OpdMed]).length, 1);
  assert.equal(decongestantDurationFindings([{ generic: 'Xylometazoline', duration: '3 days' } as OpdMed]).length, 0);
  assert.equal(decongestantDurationFindings([{ resolvedGeneric: 'Xylometazoline+Sodium chloride', duration: '10 days' } as OpdMed]).length, 1);
});

// ── bug 8 — route/formulation-aware duplication ───────────────────────────────
test('bug 8: BPO wash-off + leave-on is NOT a duplicate (finding dropped)', () => {
  const meds: OpdMed[] = [
    { resolvedGeneric: 'Benzoyl Peroxide', brand: 'Benzoyl Peroxide Face Wash', instruction: 'wash off' } as OpdMed,
    { resolvedGeneric: 'Benzoyl Peroxide', brand: 'Benzoyl Peroxide Gel', instruction: 'apply thin layer' } as OpdMed,
  ];
  const kept = dedupeRouteAware([det('Duplicate prescription: Benzoyl Peroxide')], meds);
  assert.equal(kept.length, 0);
});
test('bug 8: topical + systemic sharing a molecule is not a duplicate', () => {
  const meds: OpdMed[] = [
    { resolvedGeneric: 'Clindamycin', brand: 'Clindamycin Gel', instruction: 'apply' } as OpdMed,
    { resolvedGeneric: 'Clindamycin', brand: 'Clindamycin Cap', instruction: 'oral' } as OpdMed,
  ];
  assert.equal(dedupeRouteAware([det('Duplicate prescription: Clindamycin')], meds).length, 0);
});
test('bug 8: a genuine same-route duplicate is KEPT', () => {
  const meds: OpdMed[] = [
    { resolvedGeneric: 'Amoxicillin', brand: 'Amox 500 Cap', instruction: 'oral' } as OpdMed,
    { resolvedGeneric: 'Amoxicillin', brand: 'Amox 250 Cap', instruction: 'oral' } as OpdMed,
  ];
  assert.equal(dedupeRouteAware([det('Duplicate prescription: Amoxicillin')], meds).length, 1);
});
test('bug 8: an LLM finding (non-deterministic) is never touched by the route filter', () => {
  const meds: OpdMed[] = [{ resolvedGeneric: 'Benzoyl Peroxide', brand: 'Face Wash', instruction: 'wash' } as OpdMed];
  assert.equal(dedupeRouteAware([det('Duplicate prescription: Benzoyl Peroxide', 'llm')], meds).length, 1);
});

// ── bug 4 — consult date surfaced in opdCaseText (+ historical guard) ─────────
test('bug 4: opdCaseText surfaces the consult date exactly once with a historical guard', () => {
  const text = opdCaseText(mkCase({ noteDate: '2026-07-12T09:30:00Z', presentingComplaints: ['fever'] }));
  assert.match(text, /Consultation date \(the encounter being audited\): 2026-07-12/);
  assert.match(text, /HISTORICAL context that predates this consult/);
  assert.equal((text.match(/Consultation date \(the encounter being audited\)/g) || []).length, 1);
  // no noteDate → no line
  assert.doesNotMatch(opdCaseText(mkCase({ presentingComplaints: ['fever'] })), /Consultation date \(the encounter being audited\)/);
});
