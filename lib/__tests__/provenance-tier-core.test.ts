// Provenance tier classifier (PRD CDMSS-PROVENANCE-TIER-LEDGER §3/§8) — the resolvability
// predicate incl. the MANDATORY dead-generic-citation pin (the 44 society rules' shared URL),
// the six-tier precedence, rule 5's deliberate direction, and the L8/L9 grounding mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  citationResolves, urlResolves, classifyProvenanceTier, groundingKind, isJudgementSignalType,
  corpusCitationResolves, GROUNDING_PRESENTATION, PROVENANCE_TIERS, PROVENANCE_TIER_LABELS, type CorpusCitation,
} from '../provenance-tier-core';

// ── PHARMACY-ROUND1 §2/§8 — the clinician-signed tier ─────────────────────────
test('clinician-signed: derivation "clinician" → clinician_signed, NEVER internal_consensus / uncited_deterministic', () => {
  const sig = { citation: null, derivation: 'clinician' as const, signed_by: 'Dr Khatija, Chief Clinical Pharmacologist, Even', signed_on: '2026-07-25' };
  const tier = classifyProvenanceTier({ source: 'deterministic', signal_type: 'dose_ceiling_exceeded', verdict: 'low-value', provenance: sig });
  assert.equal(tier, 'clinician_signed');
  assert.notEqual(tier, 'internal_consensus');
  assert.notEqual(tier, 'uncited_deterministic');
  // the tier exists in the enum + label map, and ranks below deterministic and above internal_consensus
  assert.ok(PROVENANCE_TIERS.includes('clinician_signed'));
  assert.ok(PROVENANCE_TIER_LABELS.clinician_signed);
  assert.ok(PROVENANCE_TIERS.indexOf('clinician_signed') > PROVENANCE_TIERS.indexOf('deterministic'));
  assert.ok(PROVENANCE_TIERS.indexOf('clinician_signed') < PROVENANCE_TIERS.indexOf('internal_consensus'));
});
test('clinician-signed: existing external + llm derivations route exactly as before', () => {
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'dose_ceiling_exceeded', verdict: 'low-value', provenance: { citation: { source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'naproxen' }, derivation: 'external' } }), 'deterministic');
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'dose_ceiling_exceeded', verdict: 'low-value', provenance: { citation: null, derivation: 'llm' } }), 'internal_consensus');
  // an external entry that ALSO carries a signature still resolves to deterministic (citation is strictly best)
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'dose_ceiling_exceeded', verdict: 'low-value', provenance: { citation: { source: 'statpearls', book: 'StatPearls' }, derivation: 'external', signed_by: 'Dr Khatija' } }), 'deterministic');
});

// ── L7 — the resolvability predicate ─────────────────────────────────────────
test('MANDATORY PIN: the 44 society rules\' generic choosingwisely URL does NOT resolve', () => {
  assert.equal(urlResolves('https://www.choosingwisely.org/clinician-lists/'), false);
  assert.equal(citationResolves({ citation_url: 'https://www.choosingwisely.org/clinician-lists/' }), false);
  // variants of the same root
  assert.equal(urlResolves('http://choosingwisely.org/clinician-lists'), false);
  assert.equal(urlResolves('https://choosingwisely.org/'), false);
});

test('resolving citations: DOI, PMID, instance-specific URLs', () => {
  assert.equal(citationResolves({ citation_doi: '10.1016/j.jacc.2017.03.003' }), true);
  assert.equal(citationResolves({ citation_pmid: '28886926' }), true);
  assert.equal(urlResolves('https://www.choosingwisely.org/clinician-lists/aan-carotid-imaging-simple-syncope/'), true);
  assert.equal(urlResolves('https://pubmed.ncbi.nlm.nih.gov/28886926/'), true);
  assert.equal(urlResolves('https://doi.org/10.1016/j.jacc.2017.03.003'), true);
});

test('non-resolving: null/empty, bare domains, bare resolver roots — never a mere null-check', () => {
  assert.equal(citationResolves(null), false);
  assert.equal(citationResolves({ citation_url: null }), false);
  assert.equal(citationResolves({ citation_url: '  ' }), false);
  assert.equal(urlResolves('https://cdsco.gov.in'), false);
  assert.equal(urlResolves('https://www.pubmed.ncbi.nlm.nih.gov/'), false);
  assert.equal(urlResolves('https://doi.org'), false);
  assert.equal(urlResolves('example.org'), false);   // bare domain, no path
});

// ── §3 — the six-tier precedence ─────────────────────────────────────────────
const RESOLVING = { citation_pmid: '12345678' };
const GENERIC = { citation_url: 'https://www.choosingwisely.org/clinician-lists/' };

test('rule 1: rule_ref + resolving citation → deterministic; generic/none/missing row → internal_consensus', () => {
  assert.equal(classifyProvenanceTier({ rule_ref: 'cwus-x', verdict: 'low-value' }, RESOLVING), 'deterministic');
  assert.equal(classifyProvenanceTier({ rule_ref: 'cwus-x', verdict: 'low-value' }, GENERIC), 'internal_consensus');
  assert.equal(classifyProvenanceTier({ rule_ref: 'ehrc-x', verdict: 'low-value' }, {}), 'internal_consensus');
  assert.equal(classifyProvenanceTier({ rule_ref: 'ehrc-x', verdict: 'low-value' }, null), 'internal_consensus');  // row missing → no external credit
});

test('rule 2: deterministic source without rule_ref → uncited_deterministic (even at low-value)', () => {
  assert.equal(classifyProvenanceTier({ source: 'deterministic', verdict: 'low-value', signal_type: 'dose_ceiling_exceeded' }), 'uncited_deterministic');
  assert.equal(classifyProvenanceTier({ source: 'deterministic', verdict: 'context-dependent', signal_type: 'drug_interaction' }), 'uncited_deterministic');
  // rule 1 outranks rule 2: an attributed deterministic finding classifies by its rule
  assert.equal(classifyProvenanceTier({ source: 'deterministic', rule_ref: 'ehrc-x', verdict: 'low-value' }, {}), 'internal_consensus');
});

test('rule 3: low-value without rule_ref → unattributed_sourceable', () => {
  assert.equal(classifyProvenanceTier({ verdict: 'low-value', source: 'llm', signal_type: 'low_value_care' }), 'unattributed_sourceable');
});

test('rule 4: judgement family → inherent_judgment', () => {
  for (const t of ['appropriateness_review', 'appropriateness_high_value', 'appropriateness_general', 'prescribing_review', 'longitudinal_continuity']) {
    assert.equal(classifyProvenanceTier({ verdict: 'context-dependent', source: 'llm', signal_type: t }), 'inherent_judgment', t);
    assert.equal(isJudgementSignalType(t), true, t);
  }
});

test('rule 5 direction: unknowns default to SOURCEABLE, never to inherent (the bias runs against us)', () => {
  for (const t of ['prescribing_general', 'prescribing_high_value', 'antibiotic_stewardship', undefined]) {
    assert.equal(classifyProvenanceTier({ verdict: 'context-dependent', source: 'llm', signal_type: t }), 'unattributed_sourceable', String(t));
  }
  assert.equal(PROVENANCE_TIERS.length, 9);   // 6 original + deterministic_completeness + deterministic_logical (V1/V2) + clinician_signed (PHARMACY-ROUND1)
});

// ── L8/L9 — grounding presentation ───────────────────────────────────────────
test('grounding: precedence + V-approved labels verbatim; internal corpus is never elevated', () => {
  assert.equal(groundingKind({ source: 'deterministic', citation_ids: [1] }, true), 'deterministic_rule');
  assert.equal(groundingKind({ source: 'llm', citation_ids: [1] }, true), 'external_source');
  assert.equal(groundingKind({ source: 'llm', citation_ids: [1] }, false), 'internal_corpus');
  assert.equal(groundingKind({ source: 'llm', citation_ids: [] }, false), 'no_source');
  assert.deepEqual(GROUNDING_PRESENTATION.deterministic_rule, { label: 'Deterministic rule', elevated: true });
  assert.deepEqual(GROUNDING_PRESENTATION.external_source, { label: 'External source', elevated: true });
  assert.deepEqual(GROUNDING_PRESENTATION.internal_corpus, { label: 'Internal corpus reference', elevated: false });
  assert.deepEqual(GROUNDING_PRESENTATION.no_source, { label: 'Clinical reasoning — no source', elevated: false });
});

// ── Deterministic-Citations (PRD CDMSS-DETERMINISTIC-CITATIONS, Stage 3) ──────
test('corpusCitationResolves: OpenFDA null-page label resolves (§4); StatPearls/UpToDate/PubMed resolve', () => {
  assert.equal(corpusCitationResolves({ source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'ibuprofen', section: 'Dosage', page_start: null, page_end: null }), true);
  assert.equal(corpusCitationResolves({ source: 'statpearls', book: 'StatPearls', chapter: 'Caffeine' }), true);
  assert.equal(corpusCitationResolves({ source: 'uptodate', book: 'UpToDate', chapter: 'Phenylephrine' }), true);
  assert.equal(corpusCitationResolves({ source: 'pubmed', book: 'Lit-Diabetes-Care' }), true);
  assert.equal(corpusCitationResolves({ source: 'ismp', book: 'ISMP High-Alert Medications in Community/Ambulatory Care Settings (2021)' }), true);
});
test('corpusCitationResolves: self-reference / empty / no-locator does NOT resolve', () => {
  assert.equal(corpusCitationResolves(null), false);
  assert.equal(corpusCitationResolves({ source: 'deterministic' } as CorpusCitation), false);
  assert.equal(corpusCitationResolves({ source: 'labq:bookshelf', book: 'X' }), false);
  assert.equal(corpusCitationResolves({ source: 'openfda' }), false);   // no locator (book/chapter/section)
  assert.equal(corpusCitationResolves({ source: 'randomthing', book: 'X' }), false);   // unknown source
});

test('deterministic finding with a resolving corpus citation → deterministic', () => {
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'dose_ceiling_sos', verdict: 'context-dependent', provenance: { citation: { source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'naproxen' }, derivation: 'external' } }), 'deterministic');
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'drug_interaction', verdict: 'low-value', provenance: { citation: { source: 'statpearls', book: 'StatPearls' }, derivation: 'external' } }), 'deterministic');
});
test('deterministic finding marked llm → internal_consensus', () => {
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'dose_ceiling_exceeded', verdict: 'low-value', provenance: { citation: null, derivation: 'llm' } }), 'internal_consensus');
});
test('S1 (0.81.10): muscle_relaxant_indication → deterministic_completeness (documentation prompt, same class as incomplete_dosing)', () => {
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'muscle_relaxant_indication', verdict: 'context-dependent' }), 'deterministic_completeness');
});
test('0.81.14: vitamin_d_repletion_duration + pregnancy_risk_verify → deterministic_completeness (documentation prompts)', () => {
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'vitamin_d_repletion_duration', verdict: 'uncertain' }), 'deterministic_completeness');
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'pregnancy_risk_verify', verdict: 'uncertain' }), 'deterministic_completeness');
});
test('V1/V2: incomplete_dosing → deterministic_completeness; duplicate_* → deterministic_logical', () => {
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'incomplete_dosing', verdict: 'context-dependent' }), 'deterministic_completeness');
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'duplicate_molecule', verdict: 'uncertain' }), 'deterministic_logical');
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'duplicate_prescription', verdict: 'low-value' }), 'deterministic_logical');
});
test('§3.3 unreachability: an in-scope deterministic signal type that carries provenance is NEVER uncited_deterministic', () => {
  for (const st of ['drug_interaction', 'dose_ceiling_sos', 'dose_ceiling_exceeded']) {
    const ext = classifyProvenanceTier({ source: 'deterministic', signal_type: st, verdict: 'low-value', provenance: { citation: { source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'x' }, derivation: 'external' } });
    const llm = classifyProvenanceTier({ source: 'deterministic', signal_type: st, verdict: 'low-value', provenance: { citation: null, derivation: 'llm' } });
    assert.notEqual(ext, 'uncited_deterministic', `${st} external`);
    assert.notEqual(llm, 'uncited_deterministic', `${st} llm`);
    assert.equal(ext, 'deterministic', st);
    assert.equal(llm, 'internal_consensus', st);
  }
  // the residue is honest: a deterministic finding with NO provenance (lasa_pair, pending high-alert) STAYS uncited
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'lasa_pair', verdict: 'context-dependent' }), 'uncited_deterministic');
  assert.equal(PROVENANCE_TIERS.length, 9);   // +clinician_signed (PHARMACY-ROUND1 §2)
});
