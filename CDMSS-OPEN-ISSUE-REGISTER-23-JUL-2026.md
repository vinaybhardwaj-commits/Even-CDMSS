# CDMSS — Open Issue Register (opened 23 July 2026)

**Purpose:** one tracked list of every defect and open question found, so nothing expires silently. This is the canonical status list; individual evidence docs are cited per row and hold the detail.
**Convention:** `R-` retrieval/RAG · `C-` citation integrity · `A-` audit engine / matcher · `D-` data & provenance · `T-` tooling.
**Severity:** **S1** wrong output reaching a clinician · **S2** silently degraded quality, no wrong assertion · **S3** correctness-adjacent, no user impact · **S4** hygiene.

**Prod:** `9f6a64a` (verified READY 25 Jul, deployed 24 Jul 12:35 UTC), engine `opd-note-audit/0.81.12`. **Opened at** `b1fcd38`.
> Hygiene note (25 Jul): the Summary counts below were last reconciled 23 Jul and do not yet reflect R-10 (closed 24 Jul) or A-8 (added 25 Jul). Recount owed.
**Owed follow-up from `4c00a66`:** six now-obsolete `@ts-expect-error` directives in `app/api/ask/route.ts` (175/177/179) and `app/api/ddx/route.ts` (338/340) — one-line-each cleanup, needs authorisation to touch `app/api`.

---

## Summary

| Open | S1 | S2 | S3 | S4 |
|---|---:|---:|---:|---:|
| 14 open · 6 closed · 1 parked | 0 | 3 | 6 | 5 |

> **These counts are stale as of 30 Jul.** The table was written on 23 Jul against 21 entries. The register now holds **35**: the 25 Jul additions (A-9 through A-14) and the 30 Jul additions (T-3, T-4) were never counted in. Recount before quoting this row. Left in place rather than re-derived, because "open" here spans several distinct states — PHARMACY-GATED, DIAGNOSED, FIX IDENTIFIED, ESCALATED — and collapsing them needs your call, not mine.

**No S1.** Nothing found today puts a wrong assertion in front of a clinician. The S2 cluster is real and concentrated in retrieval.

---

## R — Retrieval / RAG

### R-1 · Multi-query fusion discards rerank and source weighting · **S2** · **CLOSED `4c00a66`** (RRF fusion + single rerank over the union; verified live)
`lib/multi-query.ts:108` re-sorts the deduped union by **raw cosine similarity**, throwing away the `rerank_score` and `source_quality_weight` each variant's `retrieve()` computed.
**Blast radius — four call sites, three surfaces:** `app/api/ask/route.ts:159` · `app/api/ddx/route.ts:248` (explicitly passes `useReranker: true, useSourceWeights: true` — both discarded) · `app/api/coach/start/route.ts:28` · `app/api/coach/respond/route.ts:48`.
**Consequence:** two deliberately-built ranking stages do not run on the default path of the most-used surfaces. The 0.95 guideline / 0.80 unknown-journal weighting never reaches the served set.
**Evidence:** `CDMSS-GUIDELINES-BASELINE-SERVED-K-EVIDENCE-23-JUL-2026.md` REV 3.
**Action:** PRD `CDMSS-RETRIEVAL-FUSION-PRD` (this sprint).

### R-2 · BM25 leg inert for sentence-shaped queries · **S3 (downgraded from S2)** · **PARKED — measured, no viable+beneficial fix**
`retrieve.ts:99-101` uses `plainto_tsquery('english', $1)` (ANDs every term); a ~25-word question → `bm25_pool: 0`. Real defect, not in dispute.
**Stage B measurement (`CDMSS-BM25-STAGE-B-MEASUREMENT-23-JUL-2026.md`) reached a DON'T-BUILD verdict:**
- The naive OR-rewrite (the `bm25-diag` route's proposal) **times out >180 s** — non-viable.
- `websearch_to_tsquery` still ANDs — dead candidate (confirmed live).
- The failure blamed on R-2 was **R-8's**, fixed at `e68f3aa`.
- The two cases most favourable to a lexical leg — the montelukast question and a bare drug brand (`Zerodol-SP`) — are **both fully served by vector+expansion with `bm25_pool: 0`**. Query expansion resolves brand→molecule semantically; the exact tokens BM25 would need are ones this English-literature corpus does not contain.
**Tripwire to re-open:** a query where vector+expansion fails AND the content exists in the corpus AND it is lexically exact-matchable. None found.
**Cheap hygiene (not the scoring build):** `hybrid: true` and the "fused from 3 queries" telemetry claim a BM25 leg that returns nothing — log `bm25_pool` or relabel. Fold into the owed `app/api` cleanup.

### R-3 · Cross-variant dedup compares non-comparable cosines · **S3** · **CLOSED `4c00a66`** (RRF is rank-based; the cosine comparison is gone)
`multi-query.ts:98-107` dedupes keeping **max similarity** across variants. Each variant has its own query embedding, so the cosines are measured against different vectors and are not strictly comparable; the max systematically favours whichever variant yields higher-magnitude similarities.
**Action:** same PRD (falls out of the R-1 fix if fusion moves to a single rerank over the union).

### R-4 · `lab_retrieve` cannot reproduce the served condition · **S3** · **CLOSED `4c00a66`** (`multiQuery` + `skipExpand` shipped; both exercised live — they are what isolated R-8)
No `multiQuery` option, so it measures single-query `retrieve()` while Ask/DDx/Coach run multi-query. No `skipExpand`, so A/B arms get different non-deterministic expansions and are confounded.
**Origin:** gap in `CDMSS-LAB-RETRIEVE-SEAM-PRD-v1_0` §3.3 — mine.
**Action:** same PRD (tooling section).

### R-5 · `lab_retrieve` diagnostics tied to the wrong flag · **S4** · **CLOSED `4c00a66`** (verified live: `vector_rank`/`rrf_score` populate without `includeQuarantined`)
Per-stage ranks populate only when `includeQuarantined` is set (PRD §3.2, implemented faithfully), so the control arm of an A/B reports nulls on exactly the dimension the seam exists to expose. Should be tied to the lab entry point.
**Origin:** my spec error. **Action:** same PRD.

### R-6 · `embedding_v2` flip would silently degrade to BM25-only · **S3 (latent)** · **CLOSED `4c00a66`** (named `EmbeddingV2ColumnMissingError` replaces the silent empty leg)
`USE_EMBEDDING_V2 = false` is hardcoded (`llm.ts:184`, May hotfix) and **no `embedding_v2` column exists**. If flipped, the vector SQL references a missing column, throws, and is swallowed by `.catch(() => [])` at `retrieve.ts:111` — vector leg returns empty, no error, no alert.
**Not live.** Correctly off. But the failure mode is invisible by construction.
**Action:** add a guard or a startup assertion. Candidate for the same PRD.

### R-7 · Corpus read paths that skip the quarantine filter · **S4** · OPEN
`app/api/health/route.ts:17` and `app/api/admin/bm25-diag/route.ts` read `mksap_chunks` without the `labq:` guard. Counts and diagnostics only — no clinical serving — so low risk. Mitigated as of `b1fcd38` by `visible = false` on quarantined rows (D5).
**Action:** confirm on any new read path; no build.

### R-8 · Multi-query structurally disables query expansion — **the actual cause of the montelukast failure** · **S2** · **CLOSED `e68f3aa`** (expansion restored; before/after verified live — see below)
`lib/multi-query.ts:139` (was `:91` pre-Stage-A) calls each variant with `{ ...opts, topK: perVariantK, skipExpand: true }`. `opts` is spread **first**, so `skipExpand` is forced true and **cannot be overridden by any caller**. Ask, DDx and Coach all default to multi-query, so **production never runs `expandQuery`**.

**Isolated empirically, 23 Jul, three runs on the same question at `4c00a66`:**

| Arm | Expansion | Served content |
|---|---|---|
| single-query, expansion ON | yes | **montelukast** RCT, UpToDate, FDA label, StatPearls — on topic |
| single-query, `skipExpand: true` | no | **influenza/antiviral** — oseltamivir, ribavirin, NAIs, COVID lopinavir |
| multi-query (production condition) | no (forced) | **identical influenza/antiviral set** |

The raw question embeds toward *"viral upper respiratory tract infection"* and retrieves antiviral literature. `expandQuery` adds a paragraph naming montelukast, leukotriene receptor antagonists and antihistamines, which pulls the embedding onto the actual drugs. **Expansion is the single most effective retrieval mechanism in the stack, and the default path switches it off.**

**The two LLM variants do not compensate.** `variant_ranks` on the multi-query run were `[n, null, null]` for 7 of 8 hits — only one hit came from any variant. Production pays for an LLM call plus three retrievals and gets ~1 hit of benefit, having discarded the mechanism that works.

**This is what produced the rev-1 baseline narration** (*"HIV, vaccines, herpes, abacavir, influenza"*). The model reported its excerpts accurately; retrieval genuinely served antiviral content for a montelukast question.

**Not a Stage A regression** — pre-existing at `b1fcd38:91`, unchanged by `4c00a66`, out of that PRD's scope.
**Fixed `e68f3aa`** (PRD `CDMSS-QUERY-EXPANSION-PRD-v1_0`): expand once on the original, read `skipExpand` explicitly so it is caller-overridable; original arm retrieves on the expanded text, variants stay raw. **Variants kept, not dropped — measurement (§1.2 of the PRD) refuted the register's first instinct.**
**Before/after verified live at `e68f3aa` through `lab_retrieve multiQuery: true`:**
- Q1 (montelukast, the failing case): **0 → 7 of 8** hits now montelukast/LTRA content. RECOVERED.
- Q2 (low back pain, the regression guard): AAFP Choosing Wisely held **rank 1**, and a second CW chunk (ACR) was **pulled into rank 4** — improved, not degraded.
- Fusion confirmed working: cross-variant hits carry `variant_ranks` like `[3,1,3]` with the top RRF scores.
Note R-2 (BM25 inert) still stands — the expanded text does no lexical work until Stage B.

### R-10 · Production reranker is a non-deterministic, batch-relative LLM judge · **S3** · **SHIPPED + VERIFIED 24 Jul**
**CLOSED 24 Jul (`368fd18`).** Both halves done and verified live: (1) **Reranker** — Cohere `rerank-v3.5` adopted as production default via a frozen 6-query bake-off (`CDMSS-R10-BAKEOFF-RESULT-REV3-24-JUL-2026.md`): byte-identical across repeats, all known-good orderings preserved, the judge's ties + off-topic top-ranks eliminated. Shipped with a `cohere → judge → input-order` fallback chain (the 403-day proved the need) + rerank cost sink; `RERANK_BACKEND=cohere` flipped in Vercel and **confirmed live** (fresh Cohere calls in OpenRouter from a real `/ask` query). (2) **Pool** — the dominant churn source: `expandQuery` + variant generation are now `temperature:0` + fixed `seed:42` (`RETRIEVAL_LLM_SEED`, in `lib/expand.ts`/`lib/multi-query.ts`); **verified 24 Jul** — production condition (multiQuery + expansion on, Cohere held constant), 2 queries × 2 repeats, **byte-identical served-8 + identical expansion text** (was 50% churn on 23 Jul). Full production retrieval path is now reproducible. **Distinct still-open determinism issue (NEW row A-8):** the audit's *grading* LLM run-to-run variance (±5 index, ~25% band churn per the R-11 eval floor) — separate from retrieval, tracked below.
_Original finding (retained):_
`lib/rerank.ts:27` — `RERANK_BACKEND` defaults to **`'judge'`** = `llama3.1:8b` scoring passages 0-10, **batched in groups of 5** (`JUDGE_BATCH`). A chunk's `rerank_score` therefore depends on which 4 others share its batch, so the **same chunk, same query, scores differently across runs** when the candidate pool differs. Observed live (23 Jul, BM25 A/B calibration): chunk `3253026` scored **0.4** in one arm and **0.8** in the other on the identical query.
**Consequence:** the cross-encoder rerank — the final arbiter of served-8 ordering on Ask/DDx/Coach — is **not reproducible**. This does not make R-1's fusion fix wrong (RRF + single-rerank structure is correct regardless of backend), but it means any A/B that reads `rerank_score` as a stable per-chunk quantity is measuring partial noise. It surfaced because the BM25 Stage-2 metric depends on the reranker as arbiter.
**A deterministic backend exists:** `bge-reranker-v2-m3` (`RERANK_BACKEND=bge`), a real cross-encoder giving a stable query+passage logit — but it needs an `ollama pull` on the Mac Mini and is not the production default.
**Action:** (a) the BM25 A/B needs `bge` as its ruler (kickoff `CDMSS-BM25-RERANK-BACKEND-KICKOFF`). (b) Separately worth deciding whether production should move off the LLM judge to `bge` for reproducibility — its own question, not gated on BM25.

---

### R-11 · Normative statements unreachable in the full-corpus vector pool · **S2** · **Stage 1 (non-scoring) STANDS · Stage 2 (scoring path) PARKED — PROVEN HARMFUL on the production-class model · original HuggingFace premise CLOSED (no data exists)**
A terse normative statement (Choosing-Wisely, guideline) is outranked by dense literature in the 2.2 M-chunk vector pool and never reaches served-k — even queried in its own register (MTHFR: absent; REV 4). The 0.95 source weight is applied *after* the pool cut, so it can't rescue a chunk that fell out.
**Measured fix (REV 5, `restrictSources` lab enabler `78ceec6`):** a retrieval leg restricted to the ~70 normative chunks surfaces the on-topic guideline at **rank 1** (MTHFR: CMA guideline; sinusitis: NICE rank 2) — and ranks 2–5 come from the **55 production-visible `choosing-wisely` chunks alone**, so the fix pays off today with no guideline-activation dependency.
**Build:** `CDMSS-NORMATIVE-LEG-PRD-v1_0` — a third retrieval leg, `source = ANY(normative)`, unioned pre-rerank. Stage 1 = non-scoring surfaces only (score-invariant); Stage 2 (audit citation path) is a separate score-affecting PRD. **This is the corrected answer to the original "can datasets fatten the thin value-care corpus" question: retrieval leg first, ingest second.**
**Stage 1 VERIFIED LIVE 23 Jul (`eab474c`, gate 1355), §4 deterministic probes (`useNormativeLeg:true, skipExpand:true, useReranker:false`):**
- **MTHFR — leg ON:** 4 of 8 served hits are `choosing-wisely` normative chunks (`normative_rank` 1–4, `normative_pool` 5), incl. the ASCLS/ASCP MTHFR-testing statement at **final_rank 2**. **Leg OFF:** zero normative chunks — all 8 are pubmed genetics literature. The leg is the sole cause of the rescue.
- **Sinusitis — leg ON:** AAFP Choosing-Wisely statements at **final_rank 1 and 2**, above UpToDate/Cochrane/StatPearls.
- **Negative control (antibiotics-for-URI):** served-8 **byte-identical ON vs OFF** (same 8 ids, same order) — the corpus already surfaces the AAFP chunk via the ordinary vector leg (vector_rank 9), so the normative leg is a correct no-op where it isn't needed. **No degradation.**
- **Score-invariance:** OFF-path meta carries no `normative_pool`/`normative_sources` (leg emits no query); `opd-note-audit.ts` sets `useNormativeLeg` nowhere and does not import `lvc-value` — the `note_quality_index` path is provably untouched. Enable-sites confined to Appropriateness (`lvc-value.ts:60`, private `defaultRetrieveHits`), Ask, DDx, Coach.

**Stage 2 dormant build VERIFIED `5ede320` (gate 1359):** `useNormativeLeg` wired into the audit retrieve (`opd-note-audit.ts:309`, `opdRetrieveOpts`) behind `OPD_NORMATIVE_LEG_ENABLED` (default off, mini-path excluded). Flag-off opts byte-identical; flag set in no environment; no engine bump. PRD `CDMSS-NORMATIVE-LEG-STAGE-2-PRD-v1_0`.

**Phase 0 blast-radius COMPLETE (`CDMSS-NORMATIVE-LEG-STAGE-2-PHASE-0-EVIDENCE-23-JUL-2026.md`) → Phase 2 GREENLIT.** 18 topic-representative queries (proxied from real de-identified `findings[].subject`; exact audit query is PHI, unreconstructable), both retrieval conditions, 3 cases ×3 for stability. **Under the production condition (`useReranker:true` — what the audit path runs), the leg is a precision-gated injection:** on CW-canon topics with a loaded statement it fires and the reranker keeps it (benzo→AGS Beers rank 1, low-back→ACP, URI→AAFP); on documentation findings, India rational-Rx without a CW match, and clinical controls it is a **byte-clean no-op (0 CW in served-8)**. The off-topic floor-injection seen under pure RRF (PPI→ICMR-AMR, DKA→MTHFR) is **fully removed by the reranker** — 0 of 14 reranked probes leaked an off-topic CW chunk; stability 3×3 byte-identical. **Guard for the Phase-3 flip:** assert `useNormativeLeg ⇒ useReranker` (the no-op story depends on the reranker; audit path hardcodes it today). Optional hardening: a `NORMATIVE_MIN_SIM` floor. **Blast radius bounded to CW-matching notes ⇒ Phase 2 migration expected modest/concentrated/directionally-correct.**

**Phase 2 scored dry-run OUTCOME — the leg is HARMFUL on the scoring path. STAGE 2 PARKED.** Eval harness built lab-only (`b216d86` OpenRouter backend + concurrent-drain `18944aa`; additive-channel `bfe6916`); all lab-only, `lab_analyses`-only, `opd_note_audits` never written, production byte-identical, verified. Ran the real audit on **240 stratified notes** (`lab_batch_start`, evalModel via OpenRouter), paired leg-off vs leg-on, two model tiers:
- **flash-lite (`google/gemini-3.1-flash-lite`, ~\$2):** leg effect indistinguishable from noise. A leg-off **replicate** established the floor — same note re-scored ±5 index, ~25% band churn, citation rate ±5–12pp, with **no input change** (this quantifies **R-10**, the audit's own run-to-run nondeterminism). The leg's movement sat inside that floor.
- **gemini-3.1-pro-preview (~\$18, production-class, deterministic — S3 control moved 0.00):** turning the leg on **suppressed ~90% of low-value findings (S1: 67→7) and inflated `note_quality_index` +15 (up to +40/note).** Concrete: one note went from 3 grounded low-value findings (index 62/band C) to **zero findings, index 100/band A**. The audit stops flagging low-value care. **Mechanism = framing, not displacement:** the **additive-channel** fix (`bfe6916` — 8 literature excerpts byte-identical, CW appended as separate citable `[9+]` block, verified) produced the **identical** collapse (66→7, +15, 0 CW citations). ⇒ **Any** method that puts CW text in the audit LLM's context suppresses findings. Do not revive.

**Original HuggingFace premise — CLOSED with evidence.** Probed the HF datasets API directly (23 Jul): every low-value-care term returns **empty** — "choosing wisely", "low-value care", "rational prescribing", "deprescribing", "medication appropriateness", "beers criteria", "STOPP START", "overprescribing" — while control terms ("drug", "clinical guidelines") return plenty, so the empties are real. The only hits are national *treatment* guidelines (Nigeria/Uganda protocols, not LVC rules, not India) and synthetic polypharmacy-toxicity ML sets. **No usable citable LVC/rational-prescribing rule dataset exists on HuggingFace.** The corpus is thin (CW = 55 statements; covers antibiotic/imaging/investigation, **zero** for supplement_polypharmacy — the biggest bucket at 1,071 notes; see `CDMSS-CW-CATEGORY-MAP-23-JUL-2026.md`), and HF cannot fatten it.

**ONLY remaining idea (UNTESTED, not endorsed):** deterministic post-hoc grounding — the unchanged audit LLM tags findings with `lvc_category`; a deterministic pass attaches the matching CW statement as a citation **after** generation (LLM never sees CW ⇒ structurally cannot suppress; citations don't feed `computeOpdScore` ⇒ score-invariant). Only grounds the 3 CW-covered categories (~1,850 notes). The supplement/FDC gap needs **hand-curated Indian primary sources** (CDSCO banned-FDC gazette, ICMR STGs, NLEM) — documents, not a dataset — which is real curation work, not scoped here. **Nothing is built for this; it is an idea, not a plan.**

**Net state:** Stage 1 leg live on non-scoring surfaces (Ask/DDx/Coach/Appropriateness) — fine, leave it. `OPD_NORMATIVE_LEG_ENABLED` off everywhere — **keep off, marked harmful.** No production scoring change shipped this session. Lab experiments retained in `lab_analyses`: `r11p2_flite_legoff|legon|legoff_rep`, `r11p2_pro_legoff|legon`, `r11p2_pro_channel` (stopped at 89/240).

---

### R-9 · File contract omitted `map.generated.ts` twice · **S4** · PROCESS
Both `CDMSS-LAB-RETRIEVE-SEAM-PRD` §5 and `CDMSS-RETRIEVAL-FUSION-PRD` §2.4 failed to name `lib/architecture/map.generated.ts` as gate-mandated-and-expected, forcing the builder to breach the contract and flag it — twice, the second time after I had explicitly written it up as a lesson. **Every future file contract touching `lib/` must name it.**

---

## C — Citation integrity

### C-1 · Fabricated citation indices are unvalidated end-to-end · **S3** · **DIAGNOSED 25 Jul, fix specced**
Baseline probe 2 returned `n_sources: 8` with `citation_ids: [1,2,3,4,5,6,7,8,11]`. **[11] is out of range**, `n_plos` was 0, attached to the answer's most authoritative claim (the ASA recommendation). `uncited: false`.
**The two readings are now distinguished — (b) is correct.** *Telemetry undercount REFUTED:* PLOS uses a separate namespace (`lib/plos.ts:128-130` emits `[P{n}]`, and `extractCitationIds` correctly ignores it), and `n_plos` was 0; and `sourceBlock` is built ONCE at `app/api/ask/route.ts:230` and reused verbatim across draft/critique/revise (`:245/:279/:334`), so numbering cannot drift between passes. The model was shown exactly `[1]`–`[8]` and emitted `[11]`. **It fabricated an index.**
**The check never existed.** `uncited: answer.length > 40 && citation_ids.length === 0` (`lab-clinical-core.ts:149`) is a cite-or-label canary — it asks only whether there are ZERO citations. No range validation exists in production `/ask`, in `/ddx`, or in the lab reducer; the self-critique pass audits clinical content, not citation validity. `[P{n}]` markers are equally unvalidated.
**Why it outranks its band:** the UI renders `[11]` while the sources panel lists 8 — a dangling reference on the answer's most authoritative claim, and a cited-looking claim reads as *better* sourced than an uncited one. Fabricated provenance is more persuasive than absent provenance. For a system whose thesis is provenance preservation this is the register's nearest approach to S1; it stays S3 only because the underlying clinical assertion may be correct — what is fabricated is its attribution.
**Prevalence unmeasurable today** (only 8 lab runs carry both fields; production answer text is in PHI-blocked `trace_events` — see C-2). **So ship the validator warn-only and it becomes its own instrument.**
**Fix (small, deterministic, fail-safe):** promote `extractCitationIds` to a shared pure helper; after generation compare `max([n])` against `hits.length` and `[P{n}]` against `plosHits.length`; emit a `citation_integrity` event with the offending indices; **never block or truncate an answer**. Phase 2 (strip / render-unresolved / regenerate) waits on Phase-1 prevalence + V sign-off. Not in scope: prompt, critic, retrieval.
**Evidence:** `CDMSS-C1-CITATION-RANGE-INTEGRITY-EVIDENCE-25-JUL-2026.md`.

### C-2 · Served source list not readable for audit · **S4** · OPEN
`lab_analyses.output` stores `n_sources` and `citation_ids` but no `sources[]`. `/api/ask` **does** log full hits to `trace_events` (`route.ts:167-183`), but `trace_events` is PHI-blocked from `audit_query`.
**Action:** a de-identified retrieval view (audit's C5 proposal) would close this. Not urgent now that `lab_retrieve` exists.

---

## A — Audit engine / matcher

### A-1 · `high_risk` is a class-level acute-care flag, mis-classing outpatient products · **S2** · PHARMACY-GATED
Not molecule-level. Applied by formulary `major` class, so **FOLLIHAIR NEW** (hair multivitamin tablet) and **MAXOZA** (amino-acid sachet) sit in `Fluids` with TPN bags, and **LACHILO RH** (joint supplement) sits in `Electrolyte`. Magnesium sulphate **injection**, **oral tablet** and **topical paste** all carry the same flag.
**Volume:** 138 findings — 57% correct, **21% plainly wrong**, 22% unadjudicated. Informational, so zero scoring impact.
**Evidence:** `CDMSS-HIGH-ALERT-DEFECT-ANALYSIS-23-JUL-2026.md`. **Action:** pharmacy request item #5 — 3 re-classifications remove 19 of 29 wrong findings with no build.

### A-2 · `drug_interaction` treats topical gel as a systemic NSAID · **S2** · PHARMACY-GATED
**223 findings — 65% of the entire interaction surface** — are an oral NSAID co-prescribed with a topical diclofenac rub, scored under "two NSAIDs — additive GI and renal toxicity."
**Evidence:** `CDMSS-APPENDIX-C-INTERACTION-PAIRS-23-JUL-2026.md` Q1. **Action:** pharmacy answers, then a form-scoping change (now possible — form plumbed in 0.81.11).

### A-3 · Aspirin tagged as an NSAID, dose-blind · **S3** · PHARMACY-GATED
`ddi-tags.ts` puts `aspirin` in both `antiplatelet` and `nsaid`, so 75 mg cardioprotective aspirin trips NSAID rules. 3 clear false fires (aspirin + telmisartan as "triple whammy") and 1 guideline-mandated DAPT (ticagrelor + aspirin) flagged. 8 findings total.
**Evidence:** Appendix C Q3. **Action:** pharmacy question already filed.

### A-4 · Curated DDI list is inpatient-scoped · **S4** · PHARMACY-GATED
13 of 14 curated pairs fire zero times in OPD (vancomycin, amikacin, colistin, enoxaparin, propofol). Two keys are stored truncated (`colist`, `thiopent`) and matched by substring.
**Action:** Appendix C Q4 — retain for inpatient extension, or retire.

### A-5 · `dose` — `medMolecules` multi-word tokenisation · **S3** · OPEN, UNWORKED
Ranked minor in the matcher audit (107 findings). The only ranked matcher defect not yet investigated.
**Action:** sample before speccing, per the pattern that killed the `drug_interaction` build.

### A-6 · `schedule_x` zero findings · **RESOLVED 23 Jul**
Neither dead code nor a data gap. Formulary carries 11 `schedule_dc = 'X'` rows; the check fired correctly on a buprenorphine patch (29 Jun) but under engine 0.4/0.5, which predate `signal_type` stamping — so it carried a null type and was invisible to every count grouped by signal type. **The control works; the measurement was blind.**
**Residual question (open):** does an OPD buprenorphine prescription also require narcotic-register/NDPS documentation? Filed as pharmacy request item #8.

### A-7 · `kb_topics` is orphaned · **S4** · OPEN
475 curated topics with embeddings, `coverage` jsonb, `canonical_chunk_ids` — **zero references anywhere in the repo**. Either scaffolding for something unbuilt or dead weight. Its embedding-space offset from `mksap_chunks` (validity audit §1) is therefore not a production defect.
**Action:** decide — build on it or drop it.

### A-8 · Audit grading LLM is non-reproducible run-to-run · **S3** · **SHIPPED WITH RESIDUAL 25 Jul** (`ad15184` + `9f6a64a`)
Re-scoring the same note gave different findings/PDQI, so index and band wobbled: the grading call ran `temperature 0.2` with no seed. Phase 1 (`ad15184`, lab-only) and Phase 2 (`9f6a64a`, production Vertex + Kimi grader) applied `temperature 0` + `seed AUDIT_LLM_SEED` + `top_p 1` + pinned thinking budget.
**Phase 1 — full success on OpenRouter:** 100/100 byte-identical index+band, against a no-seed baseline of median ±5 / 29% band-flip.
**Phase 2 — live Vertex proof FAILED (25 Jul):** 10 notes × 2 re-audits on the prod Vertex path (read-only, no writes) → **3/10 byte-identical, 1 band flip, median |Δindex| 1.5, max 10**. Vertex's OpenAI-compat endpoint accepts `seed` and ignores it; the thinking budget was verified as genuinely pinned, so unpinned thinking is excluded as the cause. `sources` hashed identical **10/10** — retrieval is fully reproducible and the variance is entirely in the grader (R-10 unaffected).
**Retained anyway:** Phase 2 cut band flips 29% → 10% and median index range 5 → 1.5, and the golden-A/B quality check passed (window-matched vs three prior nights: findings 2.06 vs 1.83–2.09, no coverage loss). Forward-only and revertible; no history rewritten.
**Accepted residual (V, 25 Jul):** a re-score can move a note ~1.5 index points and flip its band in ~1 case in 10. Inert in normal operation — notes are scored once and stored.
**⚠ Linked open item:** the point-of-care **Contest button** (backend ready, UI deferred) re-scores on demand, so a doctor contesting a score could see it move for no clinical reason. Contest UI must show the stored score, or frame a re-score as a second opinion rather than a correction.
**✅ RESOLVED 25 Jul — thinking budget confirmed pinned.** Vercel env searched: **neither `LLM_THINKING_BUDGET` nor `AUDIT_EVAL_THINKING_BUDGET` exists.** So `geminiThinkingBudget()` returns undefined, the overwrite line in `lib/trace.ts` never fires, and the audit's own `google.thinking_config.thinking_budget` reaches Vertex at the code default **4096**. No dead code, no silent override. **This upgrades A-8's key exclusion from INFERRED to VERIFIED:** "unpinned thinking" was ruled out by code reading, but that argument depended on this flag being unset — now confirmed. The residual variance is genuinely Vertex ignoring `seed`, and the accepted-residual ruling rests on verified ground.
**Evidence:** `CDMSS-A8-VERTEX-SEED-DETERMINISM-EVIDENCE-25-JUL-2026.md` · PRD `CDMSS-AUDIT-SCORE-DETERMINISM-PRD-24-JUL-2026.md`.
**Not closed outright:** true determinism remains available via the provider-pinned OpenRouter path (measured 100/100) if determinism is ever promoted to a requirement.

### A-9 · Gynae-assessment template discards LMP and menstrual history · **S2** · OPEN (found 25 Jul)
`HOSPITAL_GYNAECOLOGY_ASSESSMENT` (1,118 notes) does **not** repeat the obstetric false-zero bug — it scores healthily (88.1% mean completeness, NQI 78.7, 1.0% D/E, zero notes at 0%), better than HOSPITAL_GP. The narrative lives in `general_practitioner_prescription__*` and is read correctly.
**But the gynae-specific columns are invisible to the audit:** LMP populated on **49.6%** of notes, menstrual notes 14.1%, gynae history 17.5% — none read. Root cause is a gate, not a missing capability: `lib/opd-ingest-core.ts:459` restricts the (already working) LMP read at `:361/373/385` to `OBSTETRIC_TYPE` only. **The obstetric bug's sibling, one template over** — silent blindness instead of loud false zeros, which is why no score-based scan caught it.
**MEASURED exposure:** 124 notes carry a drug whose safety depends on pregnancy status; **89 of those have an LMP the audit discards** — NSAID 41, azole antifungal 30, tetracycline 13, category-D/X (methotrexate/misoprostol/valproate/carbamazepine) 4. Not 89 unsafe prescriptions — 89 notes where a safety judgement is *structurally impossible* despite the data existing.
**Compounding:** there is **no pregnancy-safety rule anywhere in the audit** (no teratogen, contraindication or lactation logic — `pregnan` appears only in `ddx-constraints.ts` and eval scenarios). Feeding LMP in makes the context visible to the LLM grader; it does not create a deterministic check.
**Two separable actions — do NOT bundle:** (a) extend the LMP/menstrual read to this template, **credited-not-required** (`lmp_edd` is mandatory on the obstetric path at `opd-note-audit-core.ts:454-455`; applying that here would fabricate false "missing mandatory" penalties on the 50.4% with no LMP — mirrors obstetric decision 3-bis). Score-affecting, needs a golden A/B. (b) A pregnancy-safety rule — a clinical-authority question for **pharmacy round 2**: which drug classes, what LMP-to-visit interval implies possible pregnancy, what reproductive age band, advisory or scoring.
**Evidence:** `CDMSS-GYNAE-ASSESSMENT-LMP-BLINDSPOT-EVIDENCE-25-JUL-2026.md`.

### A-10 · Audit coverage gap — live controls with no eligible input · **S2** · OPEN (found 25 Jul)
**Current coverage is healthy; historical coverage is not, and the consequence is a class of defect that no test can catch.**

**MEASURED, 3–22 Jul** (db13 vs `opd_note_audits`, by template): GENERAL_PRACTITIONER 5,485/7,486 = **73.3%** · HOSPITAL_GP 1,942/2,232 = **87.0%** · GYNAECOLOGY_ASSESSMENT 364/409 = **89.0%** · HOSPITAL_PAEDIATRIC 207/245 = **84.5%** · GYNAECOLOGY_OBSTETRICS 56/56 = **100%**. Overall ≈77%. The GP app is the weakest current surface — roughly 2,000 notes unaudited in 20 days on the highest-volume template.

**MEASURED, June 2026: ≈10%.** GENERAL_PRACTITIONER 1,106/11,764 (9.4%) · HOSPITAL_GP 328/2,397 (13.7%) · GYNAECOLOGY_ASSESSMENT 53/302 · HOSPITAL_PAEDIATRIC 42/349. Mechanism, not bug: `opd_gemini_forward_from = 2026-07-02` makes the Gemini worker forward-only, so everything before 2 Jul depends on the mini backfill, whose throughput is ~1,166 notes/24h (June alone ≈ 13 days of continuous running) and which is **deliberately disabled during build sessions** (V, 25 Jul — it competes for the Mac-mini worker).

**The defect this produces — Schedule X.** Even's OPD does prescribe Schedule X drugs: 3 buprenorphine 5 mcg patches in 90 days (10, 13, 29 Jun, all HOSPITAL_GP). **Two have no audit row at all; the third was audited only at engines 0.4 and 0.5** (`signal_type` null — which is what register row A-6 correctly explained). No Schedule X finding exists at any 0.81.x engine. **The control is not broken — it has never been exercised on a real prescription at a modern engine**, because every eligible note predates the Gemini cutoff and the backfill has not reached them.

**Why this is register-worthy in its own right:** "a live control with no eligible input" passes every unit test, shows a clean zero in every dashboard, and is indistinguishable from "we correctly found nothing." A-6 closed the *measurement* question ("the control works"); it did not ask whether the control was ever reaching data. Any check whose eligible population sits in the un-backfilled period is in the same state.

**Caveats on the measurement:** the two sides filter on different date fields (`_update_time` vs `note_date`); DIETARY/PHYSIO/nutrition types are deliberately out of audit scope (`lib/metabase.ts:16`); house-account doctor_uids are excluded by design (`SEED_INTAKE_EXCLUSIONS`). These explain part but not the bulk of the June gap.

**Reassurance for everything decided today:** all rulings in `CDMSS-CLINICAL-RULINGS-25-JUL-2026.md` rest on 7–30 day windows, i.e. inside the 77–100% covered period. They are not distorted by this.

**Action — an ops decision, not a build.** (a) Decide backfill throughput/priority — at current rate the pre-July corpus will not close on its own. (b) Consider an explicit "eligible-but-unaudited" counter per check, so a control with no input is visibly distinct from a control finding nothing. (c) V flagged backfill slowness as worth revisiting.

### A-11 · CDSCO banned-FDC seed compiled — and three structural limits it exposed · **S3** · SEED LANDED 25 Jul, check goes LIVE
V supplied the authoritative CDSCO Section 26A compilation (444 entries, latest S.O. 1851–1855(E) dated 08.06.2017). `data/cdsco-banned-fdc.json` moves 0.0 → **1.0**, signed "V, under delegated authority from Dr Khatija". All 444 are carried; only 5 fire.

**⚠ THE CATCH THAT NEARLY SHIPPED — route qualifiers.** S.O. 1852(E) bans *"FDCs of Ofloxacin + Ornidazole **Injection**"*. `BannedFdcEntry` has **no route field** and the matcher is exact-molecule-set only. Encoding it as `{ofloxacin, ornidazole}` would have fired on the **158 ORAL ofloxacin+ornidazole prescriptions in 90 days** — 158 false accusations of prescribing a banned drug, in a *legal* register. Withheld to `withheld_route_specific` with its reason. **General lesson: a gazette entry's route/form qualifier lives in prose the schema cannot see. Any future promotion must re-check for it.** This is the topical-NSAID defect (A-2) recurring in a different subsystem — third occurrence of "route matters and the schema can't express it".

**Four cohorts in the file:** `entries` 5 (fire) · `withheld_route_specific` 1 · `pending_2018_renotification` **328** · `not_representable` 112.

**Most of the list cannot help yet.** 341 entries are S.O. 705–1048(E) dated 10.03.2016 — **quashed by the Delhi High Court 01.12.2016 per this document's own footnote**, and re-prohibited by the 07.09.2018 notification which this document predates. The ~450 monthly cough/cold FDC prescriptions measured on 25 Jul sit in that block. **The 2018 gazette remains the blocker; this file makes them one flag away from active.**

**112 prohibitions are not expressible at all** — single-molecule bans (Nialamide, Practolol, Methaqualone; the matcher requires ≥2 molecules) and descriptive classes ("FDCs of corticosteroids with any other drug for internal use"). These need check types we do not have: a single-molecule prohibition check, and a class/pattern matcher. **Neither is scoped.**

**Consequence:** the check is no longer dormant, so it now falls under standing hazard 3 and needs the golden A/B. MEASURED at compile time: zero of the 5 active entries match current Even prescribing, so expected score movement is nil.

### A-12 · LVC candidate generation dead since ~24 Jul — delisted model, failing silently · **S2** · FIX IDENTIFIED 25 Jul
**Symptom:** the *Generate candidates* button on `/care/lvc` shows a red **"status 200"** and produces nothing. Pending ratification 0.
**✅ CAUSE FOUND (Vercel runtime log, 03:41:55 UTC) — every "404" was FALSE:**
```
[chatWithFallback] openrouter google/gemini-2.5-pro failed → ollama fallback:
400 Reasoning is mandatory for this endpoint and cannot be disabled.
```
`tracedChat`'s OpenRouter branch injects `...(('reasoning' in rest) ? {} : { reasoning: { enabled: false } })` — a default written for the citation critic (Qwen3 otherwise spends its budget on reasoning and returns no content). **LVC passes no `reasoning`, inherits `enabled:false`, and every modern reasoning model rejects it with a 400.** OpenRouter's error is then caught, the call falls back to local Ollama with `params.model` still holding the OpenRouter slug, Ollama has no such model, and **its 404 is what surfaced.** `buildOpenRouterBody` (eval path) already passes `reasoning: { max_tokens: … }`, which is why the 24 Jul seed A/B worked on the same account and model.
**The model was never the problem.** `LVC_GEN_MODEL` may be set to whatever is clinically preferred.
**⚠ TWO EARLIER DIAGNOSES IN THIS ROW WERE WRONG — recorded so nobody re-chases them:** (a) that `moonshotai/kimi-k3` had been *delisted* — it had not; three unrelated models failed identically. (b) That `LLM_PIPELINE=mini` was set, disabling OpenRouter — **it is not present in the project**; `GEMINI_ALL=1` is set, `onGemini` is true, and **A-8's Phase-2 conclusions stand unaffected.** Both wrong theories were produced by trusting the surfaced error instead of the runtime log.
**Fix specced:** `CDMSS-LVC-REASONING-FIX-ADDENDUM-25-JUL-2026.md` — one param at `even-lvc.ts:155`, plus three observability fixes (error composition on both-failed fallback; a traceId for `lvc-generate`; UI to render `result.status`/`reason` rather than the HTTP status). Folded into held commit `cb76eec`.
**Two defects, not one.**
1. *Dead slug.* Fix is env-only — `LVC_GEN_MODEL` overrides the default (`even-lvc.ts:37`), so no code change and no deploy conflict with the held 0.81.14 commit.
2. *Silent failure.* `app/api/care/lvc/generate/route.ts` **always returns HTTP 200** by design ("NEVER a 500 from a generation failure"), carrying the real outcome in `result.status ∈ ok|error|skipped`. The UI renders the HTTP status instead, so a hard failure is indistinguishable from success — which is why this ran dead for a day with no alert. **Fix the UI to surface `result.status` + `reason`.** Belongs in the next build.
**A guard that worked:** `even-lvc.ts:165` refuses candidates when the served model ≠ intended (`modelsAgree`), so the system declined to silently substitute a local Ollama model rather than generating clinical assertions from the wrong brain.
**Replacement chosen (V, 25 Jul): `openai/gpt-oss-120b`.** MEASURED from OpenRouter's live catalogue: **no Moonshot/Kimi model supports `seed` at all** — there is no in-family option; MiniMax likewise absent; DeepSeek has one. gpt-oss-120b carries `seed`+`temperature`+`top_p`, $0.039/$0.18 per M, 131k ctx, Apache-2.0. **Chosen for id stability over price** — `kimi-k3` died because it was a version-stamped slug, and date-suffixed alternatives (`qwen3-235b-a22b-2507`) queue up the same failure.
**⚠ Do NOT use `openai/gpt-oss-120b:free`** — the free variant omits `top_p` from `supported_parameters`, and the call sends `top_p`, so `require_parameters: true` would reject it.
**Owed:** the 31 assertions in the active library are Kimi-generated; the library becomes mixed-provenance from here (the model is stored per candidate, so provenance is preserved). Review the first gpt-oss batch harder than usual — a new generator changes the character of assertions V ratifies under his own name.

### A-13 · Local antibiogram shows our highest-volume antibiotics have ~30% activity · **S2** · ESCALATED 25 Jul (governance, not an audit rule)
Even's provisional cumulative antibiogram (Sep 2025–May 2026) was supplied 25 Jul. **Local E. coli (N=33, the only organism reaching the 30-isolate threshold): ceftriaxone 12.1%S · ciprofloxacin 30.3%S · amoxicillin-clavulanate 33.3%S.** Against measured OPD prescribing of amox-clav **46/wk (our highest-volume antibiotic)**, 3rd-gen cephalosporins ~51/wk, ciprofloxacin 10/wk.
**AWaRe profile:** ACCESS ~82/wk, WATCH ~114/wk, **RESERVE zero** — ~58% Watch against WHO's ≥60% Access target.
**Ruled (Ruling 20): advisory only, never scoring.** The workbook itself states *"PROVISIONAL — microbiology/LIS validation required before … empirical-therapy use"*, and — decisively — *"does not distinguish inpatient/outpatient … infection/colonization or community/hospital onset."* 40% pus / 35% urine from a hospital lab skews to complicated, referred, previously-treated patients; CDMSS audits community OPD. Scoring on it would systematically penalise correct empirical practice. Also: nitrofurantoin and fosfomycin (guideline first-line for uncomplicated community UTI) are **absent from the panel**, and 53 of 94 isolates had AST columns remapped by inference, unvalidated against the LIS.
**Why this is registered anyway:** a highest-volume empirical antibiotic at ~33% local activity is a **clinical governance** finding of larger consequence than any documentation defect in this register. Probably inflated by case-mix, **not explained away by it**.
**Action — the highest-value next step is making the antibiogram OPD-separable:** capture specimen source and inpatient/outpatient at collection so a community-stratified susceptibility figure exists. No empirical-therapy guidance should change on this dataset alone. Owner: Dr Khatija + microbiology/LIS.

### A-14 · Paediatric overdose is undetectable — adult ceilings cannot fire for children · **S2** · OPEN, prerequisite named (25 Jul)
**MEASURED:** 357 `HOSPITAL_PAEDIATRIC` notes / 30 days · **zero dose-ceiling findings on paediatric notes in 60 days.** Not a clean result — children receive far smaller doses, so a paediatric prescription never approaches a 4 g adult paracetamol ceiling. The check is structurally incapable of firing for them.
**Hazard:** a 15 kg child on 2 g/day paracetamol (~133 mg/kg, dangerous) fires **nothing**. Adult ceilings catch only grossly adult-magnitude doses — i.e. no protection across the range where paediatric overdose actually happens.
**Why nothing was built (Ruling 21):** paediatric dosing is mg/kg and **weight is absent from the prescription record** — 0% of paediatric notes carry vitals on either weight field, though **99.7% carry `patient_details__last_updated_at_hwr`**, so weight exists on a table the ingest does not read. Same missing join as the age gate (Ruling 7). A ceiling written without weight would be a guess.
**No interim prompt either** — flagging every paediatric note containing paracetamol = ~357/month of correct prescribing, the over-firing pattern retired four times on 25 Jul.
**Stated limitation for governance (binding):** *"Adult dose ceilings do not protect paediatric patients; paediatric overdose is currently undetectable by CDMSS."* Materially different from a silent zero that reads as clean.
**PREREQUISITE: plumb patient weight into the audit ingest.** Unlocks paediatric ceilings, mg/kg dosing checks, and any weight-dependent rule. Until then, no paediatric ceiling. Related: A-10 (live controls with no eligible input) — same defect class.

---

## D — Data & provenance

### D-1 · 522 unresolved brands, 70 of which are not drugs · **S3** · PHARMACY-GATED
1,481 findings. **70 brands (13%) are cosmetics, orthoses, nutrition products, and one free-text string** (`"CONTINUE SAME MEDICATIONS AS ADVISED."`) parsed as a brand. Ours to scope out, not pharmacy's to map. A further 34 are duplicate spellings of another entry.
**Evidence:** `CDMSS-APPENDIX-E-UNRESOLVED-BRANDS-23-JUL-2026.md`. **Action:** exclude non-drugs from the resolution check; normalise duplicates; pharmacy maps the remaining 452.

### D-2 · Two quarantined chunks carry a publisher copyright notice · **S3** · OPEN
Cancer Care Ontario content in the HF dataset embeds *"may not be reproduced without the express written permission of Cancer Care Ontario"* in the chunk text. **2 of the 15** in `labq:guidelines-lvc-22jul` are CCO (PET melanoma, PET colorectal). The other 13 (NICE, CMA/CTS, RSNA/ACR) are unaffected.
**Not a programme-level gate** — the datasets are public and free to obtain, and nothing blocks ingest, quarantine or measurement. A two-chunk question at activation only; simplest answer may be to drop them.

### D-3 · Two dose ceilings have no source · **S3** · PHARMACY-GATED
Aceclofenac (200 mg/day) and mefenamic acid (1500 mg/day) are `derivation: llm`, no citation. Aceclofenac matters disproportionately — 25 of 27 live dose-ceiling findings. Etoricoxib's 120 mg is flagged low-confidence, inferred from an ambiguous dosing-table cell.
**Evidence:** `CDMSS-APPENDIX-A-DOSE-CEILINGS-23-JUL-2026.md`. **Action:** pharmacy request item #2.

### D-4 · Dose-ceiling coverage gap · **S3** · PHARMACY-GATED
Ten molecules total, all NSAIDs/analgesics/decongestants. **No ceiling for any antidiabetic, anticoagulant, antibiotic, psychotropic, steroid or thyroid agent.** Overdosing outside those ten is invisible to the audit — a silent absence, not a wrong answer.

---

## T — Tooling / process

### T-1 · Documentation corrections issued today · CLOSED
Three claims of mine were withdrawn or corrected after measurement: the scout's *"rank 34 would not make a top-10 cut"* (pool is 40); this session's *"retrieval returns HIV/herpes content"* (it returns on-topic material); and the *"1.19× guideline weight advantage"* (discarded by multi-query fusion on the default path). All recorded in the relevant docs rather than silently edited.

### T-2 · Pharmacy sourcing pack · **READY TO SEND**
Request + Appendices A–E complete, every headline re-derived on a single declared frame and validated. Three figures in the request body corrected (item #1 85→125 pairs, item #4 70 subjects→3 rules, item #5 42→43 subjects). **Not blocked by anything in this register.**

### T-3 · Progress tracker reports an authored architecture, not observed state · **S3** · OPEN (found 30 Jul)
The Right Care progress panel states causes it cannot see. On a stalled run it emits: *"No progress for 53s. Mac Mini Ollama may be queuing — this can take up to 90s per stage. The Vercel function will time out at 300s total."* Every factual claim there is hardcoded rather than measured. It names one backend, attributes the stall to that backend, and quotes a fixed timeout. The 300s figure was already wrong when observed — the OPD worker moved to 800s the same morning (`59a1dd2`) — and the Ollama attribution goes wrong the moment `aiplatform` is reachable again. "No progress for 53s" is an inference from silence; a heartbeat reports the stage it is in, not the absence of one. Filed S3 rather than S4 because this is diagnostic-grade text that misleads diagnosis: it was read as evidence during the 30 Jul Gemini investigation, and the platform logs later contradicted it. **Located by CC:** `components/TracePanel.tsx:424` hardcodes the 300s string, now wrong on all five routes. One-line fix, deliberately left out of hotfix `9d4a015` because the kickoff scoped it to the box raise. Note the deeper problem the same day proved: the panel cannot name the served backend because nothing downstream records it — see **T-5**.

### T-4 · Rejected upload does not stop the progress panel · **S4** · OPEN (found 30 Jul, rescoped 30 Jul)
Observed on `/appropriateness` → Record audit with `synthetic-discharge.txt`. The banner *"unsupported file type — upload a PDF, PNG, or JPEG"* rendered while the progress panel below it kept running to 1:35 elapsed. **Rescoped after CC verification:** the `.txt` rejection is intended behaviour (PDF/PNG/JPEG only), not a regression, so the defect is narrower than first filed — the panel does not clear when the upload is refused. Downgraded S3 → S4. The stall I originally attributed to this is unrelated and is now **T-6**: CC re-ran with a valid PDF and Case audit still hung.

### T-5 · `llm_request` logs intent, so the system misreports which provider served a clinical audit · **S2** · OPEN (found 30 Jul)
The `llm_request` envelope is written **before** the call and records the model the code meant to use. When Vertex 403s and `chatWithFallback` silently drops to the Mac mini, the envelope still reads `gemini/gemini-2.5-pro`; only the paired `provider_fallback` event shows what actually answered. `opd_note_audits.model` compounds it — `worker/route.ts:78` writes the literal string `'gemini-2.5-pro'` regardless of what served. **CLAIMED, RETRACTED, THEN CONFIRMED — full history kept deliberately (30 Jul).** This entry first stated that Gemini was unavailable and that Right Care was served by fallback. I then **withdrew** it when V pointed out the system serves with the Mac mini powered off. The two-model probe proves the original claim was **correct**, and the retraction wrong.

**Root cause, from the probe body:** `aiplatform.googleapis.com` is **disabled** on `clinical-infra`. Calls A (`google/gemini-2.5-pro`) and B (`google/gemini-2.5-flash`) returned byte-equivalent 403s: `"status": "PERMISSION_DENIED"`, `reason: "SERVICE_DISABLED"`, `consumer: "projects/clinical-infra"`. Not the model, not IAM, not quota, not the request body. §3 row 3 fired.

**Dated from served-provider evidence:** the last Gemini-served response in production was **2026-07-26T12:50:34Z**. Zero since. From 27 Jul the served providers are exclusively ollama and openrouter, at 400–728 ollama-served per day. The disable landed around midday 26 Jul, which is exactly when the first nightly 403 burst appears.

**Three of my "established" facts were wrong, and the same root error produced all of them.**
1. *"The 403 carries no body."* False. The body was always complete. The chat endpoint wraps the error in a JSON **array**, the OpenAI SDK cannot parse that into its error object, and it reports "403 status code (no body)". A direct fetch recovers everything.
2. *"Flash fails, Pro works."* A logging artifact. Pro fails identically. The 29 Jul dump skews Flash only because `chatWithFallback` had a console line before `1ab509c`, and Flash utility calls dominate that path.
3. *"Pro evidently serves from that project."* Stale, not false — true before 26 Jul, not after. V's mini-off observation either predates the disable or exercised an OpenRouter-served surface. It should have been **dated**, not treated as current.

**What this entry is actually for, and it stands at S2.** `opd_note_audits.model` is a hardcoded literal (`worker/route.ts:78`) and `llm_request` records intent before the call. Both misreport. The served provider *was* recorded all along in `llm_response` / `llm_stream_usage`, so the data existed and the surfaces people read did not expose it. That gap cost a full day of investigation and produced three wrong conclusions from one analyst. Fix: derive `opd_note_audits.model` from the served provider, and surface it in the trace views.

**Blast radius, bounded.** 26 Jul 12:50 UTC onward, not back to 16 Jun. Revisit on re-enable: the 30 Jul Right Care latencies (344s / 192s) are mini latencies and not Pro; the Ollama-exit and embedding-bakeoff evidence windows should restart from the re-enable date.

**§6 of the probe kickoff is resolved.** The console reading was right the whole time. Vertex is absent from the 33 enabled APIs *because it is disabled*. The misread observation was the other one.

### T-6 · Multimodal document read stalls before opening a trace, with no fallback · **S2** · OPEN (found 30 Jul)
Case audit hangs at "Reading document" and never completes — CC measured 399s with no progress for 357s, and **zero `doc_audit` traces**, so the stall happens before any LLM call opens a trace. It is therefore invisible to every trace-based dashboard. `generateFromDocument` has no Ollama fallback, which is why it hangs rather than degrading like the text paths. The `maxDuration` raise to 800s made this **worse for the operator**: a stalled call now burns 800s instead of dying at 300s. CC's §8 residual risk is the same point — an 800s box does not bound a hung call, the SDK default 10-minute timeout exceeds it, and `maxRetries: 2` can triple wall time. **Only an explicit per-call timeout closes this.** Live proof: Case audit was still hanging when CC wrote up.

### T-7 · CCB retired as a surface, preserved as the Patient Summary engine · **S4** · OPEN — DORMANCY DOCUMENTED (30 Jul)
Care Conversation Briefs was retired as a care-manager product on 30 Jul — **non-use, not malfunction**. The nav card and its per-page-load `ccb_briefs` PHI count query are removed from `/care`; the batch cron is paused (`fdf8fa3`); `/care/briefs` **stays reachable by direct URL** (V's decision — 404-ing it was recommended and overruled).

**Why this is a register entry rather than a deletion.** The CCB mechanics are the best working example of ClinicalState, MemberState and the longitudinal spine in the system, and they are now **LIVE** behind `/api/v1/patient-summary`, which feeds the physician's pre-encounter Patient Summary in Pulse (the OPD HIS). The code is therefore invisible, unused-looking and untraced — the exact profile a tech-debt sweep deletes.

**Preserved inventory** (each carries a `RETIRED — DO NOT DELETE` header naming the PRD, the kickoff and this entry): `lib/ccb-brief.ts` · `lib/ccb-brief-core.ts` · `lib/ccb-fetch.ts` · `lib/ccb-fetch-core.ts` · `lib/ccb-extract-cache.ts` · `lib/ccb-store.ts` · `lib/ccb-detect.ts` · `lib/ccb-dossier-cache.ts` · `app/api/ccb/**` (7 routes). Also load-bearing for the API and NOT headered because they are not CCB-owned: `lib/ccb-resolve.ts` (UHID → presc_uid), `lib/member-state/**`, `lib/clinical-state/**`.

**⚠️ HAZARD — `CCB_ENABLED` IS NOT A CCB FLAG.** It gates **all eight** `/care` pages: `/care`, `/care/briefs`, `/care/m/[uid]`, `/care/[uid]`, `/care/triage`, `/care/review`, `/care/lvc`, `/care/concepts`. Setting it to `0` does **not** disable CCB — it 404s the entire care-manager surface and takes down **OPD Audit Triage, LVC adjudication, Concept Coder and Review Mode** with it. The flag keeps its name by decision; the header blocks and this entry are the mitigation.

**Regression baseline:** presc uid `l3B9gY6LrX9W9BhTd5vG` (coverage `rich`) — a round-trip through `/api/v1/patient-summary` returning a populated `state.clinical_state` and `state.member_state` is the test that the preserved mechanics still work. Thin-path baseline: `W0Zn3rkr5IhycCEuDRVt` (`order_only`).

**Owed:** the shared `CRON_SECRET` auth on the API is V1/pilot-scoped and must be split into a per-consumer key before Pulse serves live clinical traffic. Phase 3 (per-analyte trend) is deferred and blocked on EHRC lab QC data for `CVa`.

---

## Sequencing

1. **R-1 + R-2 + R-3 (+ R-4/R-5 tooling)** — one PRD, this sprint. Highest engineering value; R-1 nullifies two ranking stages on three surfaces.
2. **Send the pharmacy pack (T-2)** — unblocks A-1, A-2, A-3, A-4, D-1, D-3, D-4 in one round trip. Waiting on V, not on engineering.
3. **C-1** — one focused trace; bears on citation integrity generally.
4. **A-5** — the last unworked matcher defect. Sample before speccing.
5. **A-7, D-2** — decisions, not builds.
