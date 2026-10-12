# CDMSS Lab MCP — paired OPD audit

`paired_audit_submit`, `paired_audit_status`, `paired_audit_results` and `paired_audit_results_identifying` re-audit a signed OPD prescription and an alternate prescription (for example an ETA-to-Freescript Rx) with the production OPD engine (`auditOpdNote`, Gemini 2.5 Pro via `vertex:gemini-2.5-pro`). Both arms run inside one experiment, on the engine version, prompt hash and model captured at submit.

The tools are on the lab v2 MCP (`/api/mcp/v2`), not on the v1 door. v1 `mini_analyze` text mode refuses cloud models and has no scope split, so it is not a launch path for this.

## Doors

| Tool | Scope | Who can call it |
| --- | --- | --- |
| `paired_audit_submit` | `research_write`, identifying on every call | Operator, and only when `LAB_V2_IDENTIFYING_PRINCIPALS` includes `operator` |
| `paired_audit_status` | `research_read` | Research, operator, reviewer |
| `paired_audit_results` | `research_read` | Research, operator, reviewer. De-identified: `pair_key`, no uid, no external_ref, no clinician uid, no rationale |
| `paired_audit_results_identifying` | `research_write`, identifying on every call | Operator on the identifying list. Returns uid, external_ref, the signed arm's clinician uid, and rationale |

Research can see submit and the identifying results tool and is refused `CLASSIFICATION_REQUIRED` for both. A reviewer can read status and the de-identified results and cannot launch a run or read the identifying payload. The release key sees none of them. Nothing from these tables is read by doctors.evenos.app.

## Calling it

Submit returns immediately with a run id. The existing lab-v2 cron (`/api/admin/lab-v2/tick`) drains the queue.

Structured override JSON is the input. The caller that already has Freescript JSON should send `override`, not a rendered paragraph. `override_text` is the fallback: it is parsed into the same fields and the item records `input_path` `text` rather than `structured`.

```json
{
  "name": "paired_audit_submit",
  "arguments": {
    "experiment_label": "eta-freescript-2026-10",
    "idempotency_key": "eta-freescript-2026-10-batch-1",
    "arms": ["signed", "freescript"],
    "signed_repeats": 1,
    "override_repeats": 1,
    "max_llm_calls": 80,
    "pairs": [
      {
        "uid": "the-cdmss-note-uid",
        "external_ref": "the-eta-encounter-id",
        "override": {
          "medications": [
            { "name": "Paracetamol", "dose": "500 mg", "route": "oral", "frequency": "TDS", "duration": "3 days" }
          ],
          "diagnoses": [{ "name": "Viral fever", "icd_code": "B34.9" }],
          "investigations": ["CBC"],
          "procedures": ["nebulisation"],
          "advice": ["rest and fluids"],
          "plan": ["review if worse"],
          "exam": ["throat congested"],
          "follow_up": { "type": "OPD", "date": "2026-10-20" }
        }
      }
    ]
  }
}
```

`name` on a medication is stored as `generic_name` (the shape `medsFrom` reads). `generic_name` and `brand_name` are accepted directly. A reason or presenting complaint on `override` replaces only that field. When they are omitted, the signed row's reason, complaints, comorbidities, history, allergies and vitals stay.

`paired_audit_status` takes `{ "run_id": "<uuid>" }` and returns counts plus calls and spend. It does not return uids.

`paired_audit_results` takes `{ "run_id": "<uuid>", "limit": 50, "offset": 0 }`. Each item has `pair_key` (sha256 of run id and uid, truncated), `input_path`, and findings without rationale. `diffs` join the two arms on `pair_key`. `signed_repeats` and `override_repeats` include `identical_flag_sets` and `flag_agreement` (present_in / repeats per flag) when that arm was repeated. The override text and the structured override are not in this payload.

`paired_audit_results_identifying` takes the same arguments and returns `uid`, `external_ref`, `clinician_uid` on the signed arm, and finding rationales.

Noise floor: set `signed_repeats` and/or `override_repeats` to 2 or 3 and pass `noise_uids` listing the uids (they must be in `pairs`). Other uids get one of each arm.

A repeat submit with the same `idempotency_key` and owner returns the original run id and does not append pairs.

## What the eight conditions mean in this code

1. **Write isolation.** The tick runs each arm inside `enterOpdLabWriteFence`. `saveOpdAudit`, `updateOpdAudit`, longitudinal persist/replay, triage decisions, the Action-queue disposition, governance signal mint/withdraw/response/ruling, doctor-response claim/complete/release, the gov-signal and doctor-metrics `ensure*` writers, doctor-metrics refresh and roster upserts, and `saveMemberLink` throw `OPD_LAB_WRITE_FORBIDDEN` before any SQL when that fence is active. The fence still throws after `exitLabExecution`, which is the door the repair adapter uses. Results are inserted only into `lab_v2.paired_audit_results`. The runner does not call `saveOpdAudit` or `makeOpdRepairAdapter`.

2. **Paired arms, same engine, and a dedupe key that includes the prescription.** Each uid gets a signed item and one override item in the same run. The run stores one `engine_version`, one `prompt_hash` and one model. `prompt_hash` is sha256 of `OPD_AUDIT_SYSTEM` plus the source of `buildOpdAuditUser` and `opdCaseText`. A succeeded result is unique on `(uid, arm, engine_version, prompt_hash, model, override_hash, repeat_idx)`. `override_hash` is the signed case actually audited, the canonical structured override, or the raw override text, and `input_path` records which. A new model or a revised prescription does not reuse the old row. The comparison in `diffs` is between those two arms, not against the production `opd_note_audits` row.

3. **Prescription fields only.** The signed row is loaded once with `fetchOpdNotesByUids` (exact uid; more than one row is ambiguous). History, labs, specialty, LVC rules and suppressions are loaded once per uid (`loadSharedOpdContext`) and passed to both arms as `labDependencies`. The override arm clears medications, diagnoses, investigations, advice, plan, exam, follow-up and referrals, then fills those columns from the structured override (or from the text parser, which is the same mapper). Comorbidities, history, allergies, vitals, and the chief complaint stay unless the override supplies a complaint or a reason. A supplied medication list renders as `Medications (N)`, not `Medications (0): NONE prescribed`. Literature retrieval still runs per arm, because the query is built from the note, with query expansion off and the reranker off on both arms. That keeps the A/B fair. It is not the production retrieval path. The longitudinal / prior-visit pass is not run on either arm.

4. **Attribution.** The override arm label is whatever the caller sends beside `signed` (`freescript` is the expected one; the pattern is `^[a-z][a-z0-9_-]{0,31}$`). `clinician_uid` is stored only when `arm = 'signed'`. The table check rejects any other arm that carries a clinician uid. The raw `doctor_uid` stays on the row the engine reads, because suppression keys off it; it is not written as the author of the override result.

5. **Explicit join.** The caller supplies `(uid, external_ref)` plus `override` or `override_text`. Zero rows is `uid_not_found`, more than one exact row is `uid_ambiguous`. When the signed row has `kx_encounter_id` or `consult_uid`, `external_ref` must equal one of them or the uid is skipped as `external_ref_mismatch`. When both columns are empty the join is not failed. A transport failure is `source_unavailable` and is a failure, not a not-found. A run whose every item was skipped is `degraded`, not `succeeded`.

6. **Noise.** `signed_repeats` and `override_repeats` of 2 or 3 on `noise_uids` store one result per repeat index. Results return `identical_flag_sets` and `flag_agreement` for each arm that was repeated.

7. **Cost.** Each model call does `UPDATE paired_audit_runs SET calls_used = calls_used + 1 WHERE calls_used < max_llm_calls RETURNING` before `governedLabChat`. The count is not written back with an absolute SET. Failed legs are not inserted, so a later submit can retry them. Batch cap is 40 pairs. `max_llm_calls` is required (1–400). `max_spend_microusd` is optional; a missing price stops the run when a spend cap is set. The only model retry is the engine's existing single retry, and each chat-edge call counts against `max_llm_calls`. There is no extra retry loop. A claim increments `attempts`. A claim older than 20 minutes is requeued while `attempts` is still under 2, and marked `attempt_cap` after that. The paired slice's deadline is the route's remaining time (`maxDuration` 800s, 20s reserved, capped at 180s), not a clock that starts when the paired slice starts.

8. **PHI.** Override text and the structured override live on `lab_v2.paired_audit_items` and are not selected by either results tool. `paired_audit_results` replaces uid with `pair_key` and drops external_ref, clinician_uid and rationale. Those four are only on `paired_audit_results_identifying`, which is refused unless the principal is identifying. Log lines are an allow-list of ids, arms, statuses, reasons, call counts and paths. The cron's paired-audit failure log is the error name only.

## Deploy

1. Apply the lab-v2 series, including `migrations/lab-v2/0003_paired_audit.sql`, with the existing migrate route against `LAB_V2_DATABASE_URL`: `POST /api/admin/lab-v2/migrate`. This does not touch the production database. `0003` has not shipped, so this revision is the migration a fresh lab database applies. Do not apply it twice over an already-migrated copy of the previous draft.
2. The cron entry for `/api/admin/lab-v2/tick` already exists. After deploy it drains paired runs (at most two uid groups, and only while the route still has time) after the normal lab tick. No new cron.
3. Set `LAB_V2_IDENTIFYING_PRINCIPALS=operator` (or include `operator` if the variable already lists someone). Research cannot be on that list. Without it, submit and the identifying results tool both refuse.
4. The operator key is the existing `LAB_API_KEY_OPERATOR`. The model is the existing Vertex Gemini 2.5 Pro configuration (`vertex:gemini-2.5-pro`). No new secret.

A deploy that has not applied `0003` yet keeps the normal tick healthy: the paired step logs `paired_audit_unavailable` and the route still returns 200.
