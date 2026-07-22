// Provenance tier classifier (PRD CDMSS-PROVENANCE-TIER-LEDGER §3/§8) — the resolvability
// predicate incl. the MANDATORY dead-generic-citation pin (the 44 society rules' shared URL),
// the six-tier precedence, rule 5's deliberate direction, and the L8/L9 grounding mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  citationResolves, urlResolves, classifyProvenanceTier, groundingKind, isJudgementSignalType,
  corpusCitationResolves, GROUNDING_PRESENTATION, PROVENANCE_TIERS, type CorpusCitation,
} from '../provenance-tier-core';

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
  assert.equal(PROVENANCE_TIERS.length, 8);   // 6 original + deterministic_completeness + deterministic_logical (V1/V2)
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
  assert.equal(PROVENANCE_TIERS.length, 8);
});
