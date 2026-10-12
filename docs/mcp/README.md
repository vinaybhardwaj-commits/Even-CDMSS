# CDMSS Lab MCP — paired OPD audit

`paired_audit_submit`, `paired_audit_status` and `paired_audit_results` re-audit a signed OPD prescription and an alternate prescription (for example an ETA-to-Freescript Rx) with the production OPD engine (`auditOpdNote`, Gemini 2.5 Pro via `vertex:gemini-2.5-pro`). Both arms run inside one experiment, on the engine version and prompt hash captured at submit.

The tools are on the lab v2 MCP (`/api/mcp/v2`), not on the v1 door. v1 `mini_analyze` text mode refuses cloud models and has no scope split, so it is not a launch path for this.

## Doors

| Tool | Scope | Who can call it |
| --- | --- | --- |
| `paired_audit_submit` | `research_write`, identifying on every call | Operator, and only when `LAB_V2_IDENTIFYING_PRINCIPALS` includes `operator` |
| `paired_audit_status` | `research_read` | Research, operator, reviewer |
| `paired_audit_results` | `research_read` | Research, operator, reviewer |

Research can see submit and is refused `CLASSIFICATION_REQUIRED`. A reviewer can read a run and cannot launch one. The release key sees none of the three. Nothing from these tables is read by doctors.evenos.app.

## Calling it

Submit returns immediately with a run id. The existing lab-v2 cron (`/api/admin/lab-v2/tick`) drains the queue.

```json
{
  "name": "paired_audit_submit",
  "arguments": {
    "experiment_label": "eta-freescript-2026-10",
    "idempotency_key": "eta-freescript-2026-10-batch-1",
    "arms": ["signed", "freescript"],
    "signed_repeats": 1,
    "max_llm_calls": 80,
    "pairs": [
      {
        "uid": "the-cdmss-note-uid",
        "external_ref": "the-eta-encounter-id",
        "override_text": "the alternate prescription text"
      }
    ]
  }
}
```

`paired_audit_status` takes `{ "run_id": "<uuid>" }` and returns counts plus calls and spend.

`paired_audit_results` takes `{ "run_id": "<uuid>", "limit": 50, "offset": 0 }` and returns, per item, the projected findings (subject, rationale, verdict, confidence, domain, signal type, rule ref, category, direction, severity) plus `diffs` (`only_a` signed, `only_b` override, `both`) and `signed_repeats` when the signed arm was repeated. The override text is not in this payload.

Noise floor: set `signed_repeats` to 2 or 3 and pass `noise_uids` listing the uids (they must be in `pairs`) whose signed arm should be repeated. Other uids get one signed arm. The override arm is never repeated. Each repeat is stored and returned.

A repeat submit with the same `idempotency_key` and owner returns the original run id and does not append pairs.

## What the eight conditions mean in this code

1. **Write isolation.** The tick runs each arm inside `enterOpdLabWriteFence`. `saveOpdAudit`, `updateOpdAudit`, longitudinal persist/replay, triage decisions, the Action-queue disposition, and governance signal mint/withdraw/response/ruling throw `OPD_LAB_WRITE_FORBIDDEN` before any SQL when that fence is active. The fence still throws after `exitLabExecution`, which is the door the repair adapter uses. Results are inserted only into `lab_v2.paired_audit_results`. The runner does not call `saveOpdAudit` or `makeOpdRepairAdapter`.

2. **Paired arms.** Each uid gets a signed item and one override item in the same run. The run stores one `engine_version`, one `prompt_hash` (sha256 of `OPD_AUDIT_SYSTEM`) and one model. The comparison in `diffs` is between those two arms, not against the production `opd_note_audits` row.

3. **Note body only.** The signed row is loaded once with `fetchOpdNotesByUids` (exact uid; more than one row is ambiguous). History, labs, specialty, LVC rules and suppressions are loaded once per uid (`loadSharedOpdContext`) and passed to both arms as `labDependencies`. Literature retrieval still runs per arm, because the query is built from the note. The override arm clears the prescription columns and sets `dpipe_pc` to the supplied text, which is the channel `rowToOpdCase` prefers for presenting complaints. Structured medications from the signed note are cleared, so they cannot leak into the override arm. There is no separate medication parser.

4. **Attribution.** The override arm label is whatever the caller sends beside `signed` (`freescript` is the expected one; the pattern is `^[a-z][a-z0-9_-]{0,31}$`). `clinician_uid` is stored only when `arm = 'signed'`. The table check rejects any other arm that carries a clinician uid. The raw `doctor_uid` stays on the row the engine reads, because suppression keys off it; it is not written as the author of the override result.

5. **Explicit join.** The caller supplies `(uid, override_text, external_ref)`. Zero rows is `uid_not_found`, more than one exact row is `uid_ambiguous`. Both skip the uid, count it, and do not call the model. A transport failure is `source_unavailable` and is a failure, not a not-found.

6. **Noise.** `signed_repeats` of 2 or 3 on `noise_uids` stores one result per repeat index. `paired_audit_results` returns `signed_repeats[].identical_flag_sets`.

7. **Cost.** Dedupe is the unique key `(uid, arm, engine_version, prompt_hash, repeat_idx)` on succeeded results. A later run links the existing row and does not call the model. Failed legs are not inserted, so a later submit can retry them. Batch cap is 40 pairs. `max_llm_calls` is required (1–400). `max_spend_microusd` is optional; a missing price stops the run when a spend cap is set. The only model retry is the engine's existing single retry, and each chat-edge call counts against `max_llm_calls`. There is no extra retry loop. A claim older than 20 minutes is requeued once; a live claim is not stolen by an overlapping cron.

8. **PHI.** Override text lives on `lab_v2.paired_audit_items.override_text` and is not selected by the results tool. Log lines are an allow-list of ids, arms, statuses, reasons, call counts and paths. The cron's paired-audit failure log is the error name only.

## Deploy

1. Apply the lab-v2 series, including `migrations/lab-v2/0003_paired_audit.sql`, with the existing migrate route against `LAB_V2_DATABASE_URL`: `POST /api/admin/lab-v2/migrate`. This does not touch the production database.
2. The cron entry for `/api/admin/lab-v2/tick` already exists. After deploy it drains paired runs (at most two uid groups and 180 seconds per tick) after the normal lab tick. No new cron.
3. Set `LAB_V2_IDENTIFYING_PRINCIPALS=operator` (or include `operator` if the variable already lists someone). Research cannot be on that list.
4. The operator key is the existing `LAB_API_KEY_OPERATOR`. The model is the existing Vertex Gemini 2.5 Pro configuration (`vertex:gemini-2.5-pro`). No new secret.

A deploy that has not applied `0003` yet keeps the normal tick healthy: the paired step logs `paired_audit_unavailable` and the route still returns 200.
