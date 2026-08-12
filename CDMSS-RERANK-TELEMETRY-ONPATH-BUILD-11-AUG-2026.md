# CDMSS Rerank Telemetry — on-path build report

**Second issue, 12 August 2026**, correcting the issue committed in `90d8db1`. Against
`CDMSS-RERANK-TELEMETRY-PRD-v2.1-11-AUG-2026.md` and
`CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md`, and following
`CDMSS-RERANK-TELEMETRY-BUILD-VERDICT-12-AUG-2026.md`.

**Every number below was re-measured for this issue, and the command that produced it is printed
beside it.** The first issue's numbers were written from memory; nine of its claims were false and
six of those were counts. Where a correction changes a number, the new number carries its command.
Where a command was run against a specific commit, the commit is named — several of the first
issue's figures were true of the baseline and were attached to the wrong tree.

---

## 0A. WHAT THIS ISSUE WITHDRAWS

The first issue of this report is in git history at `90d8db1` and is not rewritten there. These are
the claims it made that this issue withdraws, and where each is now answered.

| # | Withdrawn claim | Where it stood | Corrected in |
|---|---|---|---|
| 1 | "The retrieval path executes byte-identically to `fc28e0f`" | §0 | §0, §9 |
| 2 | "no caller passes one" | §0 | §0 |
| 3 | "a source pin holds the two copies together" (also compiled into `next.config.mjs:8`) | §11 flag 1 | §11 flag 1, §15 pin 5 |
| 4 | Test 63 listed as written and green | §12 | §12, §18 flag |
| 5 | "38 directories. 29 export a `POST`." | §3 | §3 |
| 6 | "Four [pins changed], all preserving the same invariant" | §15 | §15 |
| 7 | "All four [unbroken pins] pin `return attachTransportAttribution(...)`" | §15 | §15 |
| 8 | "roughly forty of the seventy-three named tests" | §0 | §0, §12 |
| 9 | "Three edits" to `batchCounters()` | §10.1 | §10.1 |
| 10 | The architecture map "wrote 88,840 bytes" | §2 | §2 |
| 11 | The CHECK-slice pin "passed on nothing" | **not in the report** — see note | §15 pin 3 |
| 12 | Steps 9, 11 and 13 claimed built; step 14 claimed not built | §0, §12 | §12 |

**A note on row 11.** The verdict places "sliced to end-of-file and passed on nothing" in §9. That
sentence is not in the report file at either issue — `grep -n "passed on nothing"` returns nothing
against `90d8db1`. It was said in the covering message that accompanied the commit, which is not a
record anyone reads later but was wrong all the same. §15's wording was the accurate one and is
kept; it is now backed by a measurement rather than by an impression (§15 pin 3).

Two of those — 1 and 3 — would have changed a decision. Claim 3 was also a false sentence in
shipped code; the code change that makes it true is in this pass (§15 pin 5).

---

## 0. THE HEADLINE, BEFORE ANYTHING ELSE

**This build is PARTIAL. It is green, it is coherent, and its scoring behaviour is unchanged — but
it is not the whole kickoff.** Steps 1 to 13 and 18 of the kickoff's twenty-two are built, three of
them only partly (§12). Steps 14 to 17 — the lifecycle writes at the callers, the worker
declaration, the settlement wiring and the reconciler — are **NOT built**, and neither are the ten
C0 query texts, the overhead measurement, nor **50 of the 73 named tests**. §12 lists every
omission by number, and the 50 is that list counted, not an estimate:

```bash
node -e '
const r=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
const W=[...r(3,9),11,13,30,...r(35,38),45,46,50,57,61,66,68,69,71];   // §12, written and green
const A=r(1,73).filter(n=>!W.includes(n));
console.log("written",W.length,"absent",A.length,"total",W.length+A.length,"dups",W.length-new Set(W).size);'
# written 23 absent 50 total 73 dups 0
```

A clean partition of 1..73, no overlap and no gap. The first issue said "roughly forty"; its own
§12 list said 50, and §12 was the right one.

**Three things follow, and V should read all three before deciding anything else.**

1. **No top-level caller supplies telemetry, and ranking is unchanged — but the tree is not
   byte-identical to `fc28e0f`.** The first issue said "the retrieval path executes byte-identically
   to `fc28e0f`" and "no caller passes one". Both are withdrawn. What is true:

   - **Ranking, scores and the retrieved set are unchanged.** Nothing in this commit reads a
     capture to decide an order, a threshold or a slice.
   - **No route sets `opts.telemetry` or `input.telemetry`**, so `auditOpdNote` declares nothing
     and `defaultRecall` captures nothing. That is the sense in which the lifecycle is inert.
   - **Thirteen in-tree call sites do pass the new trailing argument**, and every one of them
     evaluates to `undefined` today, because the two constructors are conditioned on a field no
     route sets (`lib/opd-note-audit.ts:1501-1502`, `lib/lvc.ts:205`, each `tele ? … : undefined`):

     ```bash
     grep -rn "capture)\|Capture)" lib/retrieve.ts lib/multi-query.ts lib/lvc.ts \
       lib/opd-note-audit.ts lib/rerank.ts | grep -v "if (" | grep -v "capture?:"
     # 13 lines
     ```

     `lib/retrieve.ts:408`, `:589` · `lib/multi-query.ts:231`, `:328` · `lib/lvc.ts:284` ·
     `lib/opd-note-audit.ts:647`, `:692`, `:1550`, `:1554` · `lib/rerank.ts:321`, `:332`, `:352`,
     `:354`. The verdict counted six; thirteen is what the tree holds under the definition "a call
     site that passes a capture in the new trailing position". The conclusion is the verdict's,
     unchanged: the value is `undefined` at every one of them.

   - **`lib/llm.ts` is changed unconditionally, behind no optional parameter**, and the retrieval
     path reaches it — the rerank judge through `governedChat` at `lib/rerank.ts:450`, `expandQuery`
     at `lib/expand.ts:25`. Three changes, none of them a seam: `attempts: []` becomes
     `[...attempts, localAttemptSuccess()]` on the intended-local arm, `[...attempts]` becomes
     `[...attempts, localAttemptSuccess()]` on the substitution arm, and a new
     `attachTransportFailureAttribution(lastErr, …)` statement runs before the three terminal
     dispositions. The attribution object the retrieval path returns is therefore different, and a
     thrown error now carries an added non-enumerable property. `git diff fc28e0f HEAD -- lib/llm.ts`
     is the whole of it; §9 states the same change as an achievement, and the two sections now agree.

   The stopping point itself was deliberate: the opt-in boundary rather than a half-wired lifecycle,
   because a declaration with no settlement and no reconciler leaves every row stranded at
   `retrieval_complete` forever, which is worse than no telemetry.

2. **⚠️ A PRODUCTION BUILD NOW FAILS WITHOUT `CDMSS_TELEMETRY_HMAC_KEY`.** This is the one change
   in the commit that is NOT inert. It is D8 as specified. See §11, which also reports a finding
   about that guard that the kickoff could not have known.

3. **"2940 green" does not cover the manifest path.** Six of the seven new modules — everything
   that builds a manifest and writes it — are imported by no test at all. §12.1 states this
   plainly, with the command.

---

## 1. Commits, document hashes, and the two SHAs

| | |
|---|---|
| Preparatory (documentation + allowlist only) | `a2a8f4d1befce394b37c10a9b023aa6c742c30dd` |
| Build commit (first issue of this report) | `90d8db1befc17e1fd6a3aa7d5e5b8612f590ed4f` |
| Correction commit (this issue) | *on top of `90d8db1`, not an amend — see `git log` on `exp/rerank-telemetry`* |
| Branch | `exp/rerank-telemetry`, **not pushed** |
| Base | `fc28e0fdce015e9e303944e4197b19534c31c383` |

`90d8db1` is **not amended.** The first issue of this report stays in history exactly as it was
written, and this correction sits on top of it, so the record shows what was withdrawn rather than
quietly replacing it.

```
850249857454f190e52c9f9687eda64d176e1911ec439025ed1af0ee70305d95  CDMSS-RERANK-TELEMETRY-PRD-v2.1-11-AUG-2026.md
281c8cde0a07e0feadd55bbf388d94092447e6264d46b88b4c29346ffb04560f  CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md
```

**HARNESS SHA vs SERVED SHA.** The harness SHA is the build commit above. **The served deployment
SHA is not recorded here and is not mine to record.** A clean local tree proves nothing about what
Vercel is serving; the served SHA is canary-era, and this build neither deployed nor targeted a
canary. Nothing here was run against the production database.

---

## 2. Gate — nine commands, re-run in full for this issue

| # | Command | Result |
|---|---|---|
| 1 | `npm test` | **GREEN — 2940/2940** (2887 at `fc28e0f` + 45 at `90d8db1` + 8 in this pass; 0 fail, 0 skipped) |
| 2 | `npm run typecheck` | **GREEN** — `tsc --noEmit`, exit 0, no diagnostics |
| 3 | `npm run build` | **exit 1 plain, exit 0 with the key — see below** |
| 4 | `npm run architecture:check` | **GREEN** — 8 rules + coverage; 39 subsystems, 16 registered, 23 unregistered |
| 5 | `npm run architecture:map` | **GREEN** — `wc -c lib/architecture/map.generated.ts` → **88,842** |
| 6 | map determinism (`git diff --exit-code`) | **GREEN** — regeneration is byte-identical |
| 7 | `npm run reasoning:registry` + `git diff --exit-code` | **GREEN — the registry file did NOT change** (88,737 bytes; 30 prompts · 7 rubrics · 36 builders · 19 features) |
| 8 | `npm run reasoning:governance` | **GREEN** — 0 ungoverned model calls; parallel stores folded |
| 9 | `npm run changelog:coverage` | **GREEN** — all 19 shipped engine versions documented (30 versioned entries) |

**⚠️ COMMAND 3, EXACTLY AS RUN, WITH BOTH EXIT CODES.** Eight of the nine gates pass as the kickoff
writes them. The ninth does not, and that is the D8 guard firing correctly against an environment
the kickoff did not anticipate — not a defect in the build. `vercel env pull` has written
`VERCEL="1"` and `VERCEL_ENV="production"` into this machine's `.env.local`, Next.js loads
`.env.local` into `process.env` before evaluating `next.config.mjs`, and D8's three clauses are
therefore all true for a *local* build.

```bash
$ npm run build >/dev/null 2>&1; echo $?
1
# Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. …
#     at <unknown> (next.config.mjs:14:9)

$ CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret npm run build >/dev/null 2>&1; echo $?
0
```

I did **not** change D8's predicate to make the plain command pass. See §11, finding 1.

**The map byte count.** The script's own completion message says 88,840. The file is 88,842 bytes;
the script under-reports by two. The table quotes `wc -c`, which is the file.

New tests by file: `transport-failure-attribution` 21 · `retrieval-telemetry-core` 25 (rewritten,
was 17) · `migrate-retrieval-telemetry-parity` 12 · `telemetry-non-exposure` 4 ·
`telemetry-key-guard` 8 (this pass). **Two units are in play and they are not the same number.**
"2940 tests" counts **test cases** executed by `node --test`. "23 of 73 written" counts the
kickoff's **named test requirements** in §6. One named requirement can be several cases — test 57
alone is eight.

---

## 3. The two counts I verified for myself

The kickoff said not to carry these on its word. **Both figures are commit-sensitive, and the first
issue attached the baseline's figures to the tree that changes them.** This commit adds the 39th
directory and the 30th `POST`, which is what §5.1 describes.

```bash
# at fc28e0f — the baseline the kickoff was written against
git ls-tree -d --name-only fc28e0f app/api/admin/ | grep -c "migrate-"          # 38
git grep -lE "export (async )?function POST" fc28e0f -- 'app/api/admin/migrate-*/route.ts' | wc -l  # 29

# at 90d8db1 — the tree this report describes
ls -d app/api/admin/migrate-*/ | wc -l                                          # 39
grep -l "export async function POST\|export function POST" app/api/admin/migrate-*/route.ts | wc -l # 30
```

**38 directories and 29 `POST`s at `fc28e0f`, matching the kickoff. 39 and 30 at `90d8db1`, because
this build adds `app/api/admin/migrate-retrieval-telemetry/`.** There is no migration runner and no
ledger; nothing reads `migrations/*.sql`, which is why migration 0035 has never been applied and
cannot be.

---

## 4. Entry-point and route taxonomy (PRD §5 step 1)

`RETRIEVAL_ROUTES` (10) and the role set (5) are declared in `lib/retrieval-telemetry-core.ts`.

| Route | Class | Entry point |
|---|---|---|
| `opd_audit_worker` | worker | `/api/opd-audit/worker` — the nightly cron |
| `opd_audit_run` | manual | `/api/opd-audit/run` |
| `opd_audit_mini_backfill` | backfill | `/api/admin/opd-audit-mini-backfill` |
| `opd_dosing_backfill` | backfill | `/api/admin/opd-dosing-backfill` |
| `opd_rescore_direction` | backfill | `/api/admin/opd-rescore-direction` |
| `lab_batch` | lab | `lib/lab-batch.ts` |
| `mcp_tools` | lab | `lib/mcp-tools.ts` |
| `lvc_judge_aa` | lab | `/api/admin/lvc-judge-aa` |
| `script` | manual | `scripts/*.mjs` |
| `unknown_route` | unknown | anything unnamed — **never** the nearest match |
| `reconciler` | reconciler | **invocation table only** — a separate `InvocationRoute` type, so a reconciler row can never appear on a retrieval row |

**Roles** — `primary`, `normative_channel`, `lvc_recall`, `lab_direct`, `lab_multi_query`.

**Confirmed by reading, as instructed:** the two admin routes `opd-dosing-backfill` and
`opd-rescore-direction` build `reuse` **unconditionally**, so they return at the reuse guard and
never retrieve. They are out of scope **by construction**, not by omission. Neither can reach a
fresh audit, so no stop-and-report was triggered.

---

## 5. The schema

### 5.1 What runs, and what is documentation

`app/api/admin/migrate-retrieval-telemetry/route.ts` is what runs. It is `runtime = 'nodejs'`,
gated by `requireAdmin` with the `isAdminUnlocked` fallback, and returns a `steps` record.
`migrations/0035_opd_audit_retrieval_telemetry.sql` is **documentation** and says so in its first
five lines.

**Every CHECK value list is GENERATED** from the exported constants — `RETRIEVAL_PERSISTENCE_STATES`,
`RETRIEVAL_ROLES`, `OUTCOME_REQUIRED_STATES`, `OUTCOME_EITHER_STATES`, `INVOCATION_KINDS`,
`INVOCATION_CLOSURE_STATES`, `TELEMETRY_FAILURE_PHASES`, `RUN_SCOPED_FAILURE_PHASES`,
`NON_TERMINAL_PERSISTENCE_STATES`. Nothing is hand-typed in the route. A test asserts the route's
source does **not** contain the state names.

The statements live in `retrievalTelemetryDdl()` in `lib/retrieval-telemetry-core.ts` rather than
inline in the route, because a generated statement cannot be verified by reading the route's
source — the values are not in it. That is what lets the parity test compare **real output**
against the mirror instead of comparing two pieces of prose. This is not what §4.2 forbids: the
`.sql` file is still hand-typed and is never generated.

### 5.2 Parity pin output

`lib/__tests__/migrate-retrieval-telemetry-parity.test.ts` — **12/12 green**. It asserts, in both
directions, that every statement the route runs is in the `.sql` and vice versa; that the statement
counts match; that the CHECK value sets are identical and equal the constants; that neither side
can pass on an empty slice; and that all three `COMMENT ON TABLE` bodies survive their own embedded
semicolons.

**The splitter respects single-quoted strings, and that is not a nicety.** A naive `;` split would
have torn each `COMMENT ON TABLE` body in two at *"Retention 90 days from started_at; the purge
is…"* and compared two half-statements that match nothing on either side — passing by accident.

### 5.3 The one permitted difference

```
ALTER TABLE opd_audit_retrieval_telemetry ALTER COLUMN retrieval_role SET NOT NULL
```

Applied by the route **only when the table is empty**, reporting `applied, table empty` or
`skipped, table not empty` in `steps`. An explicit step, not a `DO` block, so the decision is
visible in the response. The `.sql` cannot branch, so it states the rule in prose. This is the only
statement the two artefacts do not share, and it is named in the parity test's allowed-difference
list and nowhere else.

### 5.4 The stop rule

The route's first action is `to_regclass`, then a row count. **If the table exists with rows it
changes nothing**, returns **409** with `halted: 'table_not_empty'`, the row count and a
`persistence_state` histogram, and waits for a signed legacy-data policy. The halt precedes every
schema statement, and a test asserts that ordering rather than merely that the halt exists.

This matters concretely: the state vocabulary goes from the eight values the original 0035 declared
to fourteen and **drops `not_eligible`**, so a pre-existing row carrying that state would make the
`ADD CONSTRAINT` fail. The honest response to that is a decision by V, not a migration that quietly
rewrites history.

### 5.5 The DDL, as implemented

Verbatim in both artefacts. Reproduced here in outline; the byte-exact text is
`migrations/0035_opd_audit_retrieval_telemetry.sql`, held to the route by the parity test.

**`opd_audit_retrieval_telemetry`** — the 30 columns 0035 declared, unchanged, **plus** the 17
D2 additions (`retrieval_role`, `retrieval_outcome`, `retrieval_error_class`,
`persistence_settled_at`, `row_revision`, `expansion_served_model`, `expansion_attempts`,
`rerank_not_served_batches`, `rerank_soft_failed`, `served_backend`, `rerank_backend_downgraded`,
`fused_candidate_count`, `hydrated_candidate_count`, `index_version`, `active_backfill_run_id`,
`active_backfill_target`, `active_backfill_state`) and `ALTER COLUMN app_source SET DEFAULT
'standalone'`.

`trace_id` is **0035's existing `trace_id TEXT NULL`**. No column was added and no naming question
was opened.

**One deviation from the kickoff's literal DDL, stated:** the `CREATE TABLE` carries **no inline
`persistence_state` CHECK**. The original 0035 declared one inline with the eight old values.
Keeping it would put the state vocabulary in two places in one migration — the inline copy and the
named constraint D2 requires be DROPped and re-ADDed — and a reader would have to check the two
agree. There is one home for it: the named constraint. On a fresh table the DROP is a no-op and the
ADD installs it; on an existing table the pair replaces whatever was there. Both paths end
identically, and the parity test covers both artefacts.

**Three CHECKs**, each DROP-then-ADD so a second run cannot error: `…_persistence_state_chk` (14
values), `…_role_chk` (5 values, unconditional — a NULL role passes a CHECK by SQL's own rules,
which is exactly why the NOT NULL is a separate conditional step), and `…_outcome_chk` (the
`started`/required/either partition).

**14 indexes** — 8 on the retrieval table, 3 on `opd_retrieval_invocations`, 3 on
`opd_retrieval_telemetry_failures`. Every one `IF NOT EXISTS`.

**`opd_retrieval_invocations`** and **`opd_retrieval_telemetry_failures`** exactly as D2 specifies,
including `opd_rtf_run_chk`, which requires a run id and role on the three run-scoped phases and
permits their absence on `invocation_start` and `closure`.

### 5.6 The three table comments

They differ, and each says what its own table holds. Only `opd_audit_retrieval_telemetry` names
`uid`; the other two say **NO PATIENT IDENTIFIER**. Retention anchors differ — `started_at` on the
first two, `observed_at` on the failure table, **which has no `started_at`**. All three state that
the purge is operator-scheduled and NOT implemented here. A test asserts all of this, including
that the failure table's comment does not contain the string `from started_at`.

---

## 6. Retention, access and deletion — the §4.2 statement

- **Retention.** 90 days, declared per table in `COMMENT ON TABLE` with the correct anchor column
  named in each.
- **Deletion.** Operator-scheduled purge. **Owed and unimplemented, and named as such in the route
  header and all three comments.** Not a trigger. Automating a delete against a table that may hold
  the only evidence of an unreconciled incident is a decision, not a default. A patient erasure that
  removes an `opd_note_audits` row must remove the rows here carrying the same `uid`; the FK is
  `ON DELETE SET NULL` so losing the audit does not destroy the reconciliation record, and `uid` is
  what the erasure must target, deliberately and by name.
- **Access. The control that applies is the admin gate — the same control `opd_note_audits`
  itself carries.** §4.2 requires controls *no weaker than* `opd_note_audits`, and that is what
  this is.

**`lib/sql-guard-core.ts` was NOT edited.** Its `BLOCKED_RELATIONS` literal is byte-identical, and
the two committed assertions on it — `provider-switch-unit-d.test.ts:257` (in the test titled
*"lib/sql-guard-core.ts was NOT edited by this build"*) and `prognosis-outcomes-core.test.ts:341` —
are untouched and green. Adding the telemetry tables to that list would be **stronger** than §4.2
requires, since `opd_note_audits` is not on it either. If the blocklist is the right long-term home
for these tables, that is V's ruling on the defect list (§13, item 1), not this build's to take.

**Non-exposure** (`lib/__tests__/telemetry-non-exposure.test.ts`, 4/4): a scan of every `.ts`/`.tsx`
under `app/` and `lib/` finds no `FROM`/`JOIN` against the three tables outside an exact-path
allow-list. It also asserts that **no non-admin route under `app/` mentions a telemetry table at
all**, and it proves its own matcher on synthetic text first, so its silence means something.
**Stated limit:** a source-text search cannot see a dynamically composed table name. It proves the
tables are absent from every *literal* query in `app/` and `lib/`, and no more. It does not cover
`.mjs` scripts, Metabase, or the Lab connector's tool description. It asserts nothing about
`lib/sql-guard-core.ts`.

---

## 7. The atomicity declaration (§4.5, required as a declaration)

**The audit write and the final telemetry link are NOT transactional, and cannot be here.**

The precise reason: `lib/db.ts` exports `sql` as a `Proxy` with only an `apply` trap over a bare
function target, so the driver's own `transaction` method is not reachable — and even if it were,
it could not span the application logic between the audit insert and the telemetry link.

**What replaces atomicity:** idempotent updates, an explicit `row_revision` guard, per-role
isolation, and a reconciler. Every mismatch is reported rather than smoothed over.
`lib/retrieval-telemetry-store.ts` states this in its header and nothing in this build claims
atomicity anywhere. **The reconciler that completes this story is NOT built (§12).**

---

## 8. Update precedence, transitions, canonicalization, column classification

**Precedence, exactly as D12 orders it**, in `applyTerminalState`:

1. identical-content no-op — **does not** increment `row_revision`
2. expected-revision check — rejected and logged, **never retried blindly**
3. transition check — terminal states never transition
4. apply, and increment

The order matters: checking the revision first would burn a revision on a write that changed
nothing, and the next caller would then see a conflict that was really a no-op.

**Transitions** (`ALLOWED_TRANSITIONS`) are exactly D12's table. Two placements are easy to get
backwards and are commented at the declaration:

- **`retrieval_complete -> aborted` is deliberately ABSENT.** A run that wrote its terminal manifest
  did not abort; what is unknown is the audit's fate, and that is `persistence_unknown`.
- **`started -> audit_generation_failed` is deliberately PRESENT.** D11 puts the primary terminal
  write at step 12 and `auditOpdNote` can throw at steps 7, 8 or 9, so a row that never reached its
  terminal write is still `started` when the audit fails. Forbidding this would leave the only
  honest settlement unreachable. Its `retrieval_outcome` is null on that path, which is why the
  outcome CHECK permits either for that state.

**Canonicalization** — one function, `canonicalJson`. Keys sorted recursively at every depth, array
order preserved, `undefined` omitted in objects and **rejected** in arrays, non-finite numbers
rejected. Rejected rather than dropped or nulled because dropping changes the length and nulling
changes the value — either way two manifests that differ would compare equal, which is the one
thing the no-op check must never do.

**Column classification** — `COLUMN_CLASSIFICATION` in the core, four groups
(`immutable_insert`, `mutable_terminal`, `revision_metadata`, `derived`), derived from the final
DDL. The equality projection is `mutable_terminal`. Manifest operational timestamps are excluded: a
retry reuses the originally stamped manifest, so comparing `completed_at` would make every retry
look like new content.

---

## 9. Attribution — the five §4.4 conditions, each with its test

**This build modifies `chatWithFallback` unconditionally, on every call, with or without a
capture.** That is the same fact §0 now states, and the two sections agree; the first issue asserted
it here as an achievement and denied it there. The change is not behind an optional parameter and
is not a seam. `git diff fc28e0f HEAD -- lib/llm.ts` is the whole of it: two `try` blocks added
around the two local `create` calls (the calls themselves not rewritten), one
`attachTransportFailureAttribution(lastErr, …)` statement added before the terminal dispositions,
and `attempts` gaining a `localAttemptSuccess()` entry on both local arms.

None of the five §4.4 conditions is asserted without a test behind it. All live in
`lib/__tests__/transport-failure-attribution.test.ts` (21/21) and
`lib/__tests__/transport-attribution-traceless.test.ts`.

| § | Condition | Test |
|---|---|---|
| 1 | Request parameters byte-equivalent | *nothing in the failure path touches the outbound request object* — `attachTransportFailureAttribution(params` absent; the Vertex strip/`baseMax`/`+8192` construction pinned unchanged |
| 2 | Provider selection and fallback order unchanged | *the two terminal throws are BYTE-IDENTICAL* — both `throw lastErr;` literals intact; `throw attachTransportFailureAttribution(lastErr` asserted **absent** |
| 3 | Retry behaviour unchanged | *retry policy is unchanged* — `timeoutMs: tierCeilingMs(...)` ×2, `maxTries,` ×2, capture rides the existing `onAttemptFailure`, which `createWithRetry` already wraps |
| 4 | Existing callers behaviourally compatible | *failure evidence is a SEPARATE property* — the failure shape has neither `dispatched_provider` nor `dispatched_model`, so `resolveJudgeAttribution` in `lib/lvc.ts` cannot reach it even by accident; the untouched `lvc-judge-attribution.test.ts` is green |
| 5 | No parent trace ID introduced | *the traceless route stays traceless* — `governedChat(undefined, 'rerank_judge'` pinned; `chatWithFallback` must not `startTrace` |

**The design choice that made condition 2 free.** The failure evidence attaches **once, before the
three dispositions**, rather than at each of them. That keeps both `throw lastErr;` statements
byte-identical, so the committed guards that pin them still assert the terminal behaviour did not
move — instead of being rewritten to accommodate this build. The phase is selected from the *same
two conditions those throws test*, and a test pins the selector against the throws so they cannot
drift.

**D14 as built.** New `CdmssTransportFailureAttribution` on its own property
(`cdmss_transport_failure_attribution`), with its own **immutable** helper (`writable: false,
configurable: false`, in a try/catch — first writer wins, because the frame closest to the failure
knows most about it) and its own reader. `TransportAttempt.tier` gains `'ollama'` and its comment
now says it names the **provider attempted**, not a ladder position. `lib/trace.ts` gained new
re-exports and nothing else.

**Both holes closed.** The intended-local arm reported `attempts: []` **while making a real
request**; it now records the local call as the attempt it is. A thrown dispatch carried no
evidence at all; it now carries the full ladder history, so a call that exhausted a cloud ladder
and then failed locally is distinguishable from a call that was never made.

**`tracedChat` is untouched**, asserted by test. D14 scopes failure attribution to the traceless
arm, and the retrieval path never reaches the traced one — `rerank_judge` and `expandQuery` both
dispatch with an undefined trace id. That `tracedChat` attaches no attempts is a real defect and is
on the defect list (§13, item 2) rather than fixed here.

---

## 10. The stage mapping, the counters, and the downgrade

### 10.1 `batchCounters()` — before and after

**Before** (`lib/retrieval-telemetry-core.ts` at `fc28e0f`):

```ts
if (b.served_route_class === 'vertex') c.vertex += 1;
else if (b.served_route_class === 'openrouter') c.openrouter += 1;
else if (b.served_route_class === 'local') c.local += 1;
else c.unattributed += 1;                      // ← the bare else
```

**After:**

```ts
if (b.served_route_class === 'vertex') c.vertex += 1;
else if (b.served_route_class === 'openrouter') c.openrouter += 1;
else if (b.served_route_class === 'local') c.local += 1;
else if (b.served_route_class === 'not_served') c.not_served += 1;
else if (b.served_route_class === 'unattributed') c.unattributed += 1;
// a null or absent class increments NOTHING
```

**Four edits, all required to compile** — the first issue said three and missed the parameter type:

```bash
git diff fc28e0f 90d8db1 -- lib/retrieval-telemetry-core.ts | grep -E "^[-+].*batchCounters|^[-+].*const c = \{|^[-+].*not_served: number"
```

| # | What changed | Old | New |
|---|---|---|---|
| 1 | parameter type | `m: RetrievalManifest` | `m: Pick<RetrievalPayload, 'batches'>` |
| 2 | return-type annotation | six fields | seven — `not_served: number` added |
| 3 | initialiser | `{ vertex: 0, openrouter: 0, local: 0, failed: 0, unattributed: 0, retries_429: 0 }` | the same with `not_served: 0` |
| 4 | branch chain | bare `else` | two explicit arms, no `else` |

Without the fix, `not_served` and a null class would both have landed in the bare `else` and been
reported as unattributed — three different facts merged into one column, which §2 forbids.

**The two orphan columns finally have a writer**, plus the third: `rerank_429_attempts` ←
`retries_429`, `rerank_unattributed_batches` ← `unattributed`, `rerank_not_served_batches` ←
`not_served`, wired through `counterColumns()` in `lib/retrieval-capture.ts`. Both existing columns
would otherwise have stayed at zero forever.

**The apparent contradiction, stated so nobody reads the counter as permission.** The type permits
`served_route_class: null` on a batch defensively, `batchCounters` counts a null as **nothing**, and
`validateManifest` **rejects** a null on any batch it sees. Those are not in conflict: the type is
defensive, the validator is the contract (A6). A batch record exists only where a request was
planned, so a null there is a defect. The explicit null belongs at **stage** level only.

### 10.2 The Cohere-to-judge downgrade (A10)

Built as required. On the env-default path an unhealthy Cohere raises `RerankBackendError` and
`lib/rerank.ts` falls through to the judge. `capture.rerankBackendDowngraded = true` is set at the
fall-through; `rerankJudge` then stamps `servedBackend = 'judge'` and
`expectedBatchCount = ceil(n / JUDGE_BATCH)`, **overwriting** the intended count of 1.

That overwrite is the whole point: under §7's never-waived reconciliation, every row on this path
would have been `persisted_partial` **by construction**, and since §2 records that we do not know
whether `RERANK_BACKEND` is set for Preview, this is exactly a canary-era path.
`expected_batch_count` is derived from `served_backend`, never from `intended_backend`.

**`JUDGE_BATCH` was not exported and is not imported by any test** (D16). `judgeBatchBoundaries()`
is a module-private helper so the soft-failure synthesis can account for planned requests without a
second reference to the constant.

**⚠️ The end-to-end downgrade test (kickoff test 70) is NOT written** — see §12.

### 10.3 The stage mapping as implemented

`servedClassOf()` in `lib/retrieval-capture.ts` is the single home for D16's rule. Provider success
→ that provider's class. Proven non-delivery → `not_served`, **and only with proof**. Otherwise
`unattributed`. A skipped stage → the explicit stage-level null. A Bedrock completion →
`unattributed` (it cannot serve the judge; if one appears, telemetry is wrong about the world and
it is never quietly mapped to a plausible class).

`parse_failure` **preserves** provider, model, attempts and token usage at both sites that can
produce one — the rerank batch and variant generation — because a completion arrived and cost
tokens. `isPriceableClass()` encodes §4.6: `local` and `not_served` are unpriced; `unattributed`
and parse failures are priced from their preserved usage.

---

## 11. Flagged, not decided

**1. D8's guard predicate is true for a LOCAL build on this machine.** `vercel env pull` writes
`VERCEL="1"` and `VERCEL_ENV="production"` into `.env.local`, and Next.js loads that file into
`process.env` before evaluating `next.config.mjs`. So the three clauses D8 specifies cannot
distinguish a real Vercel production build from a local `next build` on a machine that has pulled.
**I kept D8's condition exactly as specified** and did not add a fourth clause, because the
predicate is V's to define. The consequences: plain `npm run build` fails locally until a throwaway
key is set, and `.env.example` now documents that. V's options are to tighten the predicate (a
non-empty `VERCEL_URL` would discriminate), to have every developer set a local key, or to accept
it. **The flag itself stands unchanged — this is still V's ruling.**

**⚠️ The first issue justified leaving it alone with "a source pin holds the two copies together."
That pin did not exist.** Two copies of a deploy-blocking predicate, one inlined in
`next.config.mjs` and one typed in `lib/telemetry-key-guard.ts`, with nothing holding them
together — and a comment in each file telling the next reader that something did. The comment at
`next.config.mjs:8` shipped. It was the one false sentence in this build that was compiled into
running code.

```bash
git grep -n "telemetryKeyMissingInProduction" 90d8db1 -- '*.ts' '*.mjs'
# 90d8db1:lib/telemetry-key-guard.ts:23:export function telemetryKeyMissingInProduction(...)
# 90d8db1:next.config.mjs:8:// `telemetryKeyMissingInProduction` in lib/telemetry-key-guard.ts, and a source pin asserts...
```

One definition and one comment about it. Nothing imported the module.

**The pin exists as of this pass**, written as kickoff test 57 in
`lib/__tests__/telemetry-key-guard.test.ts` (8/8). It extracts both conditions by balanced-paren
scan, normalizes `process.env.X` and `env.X` to one spelling and nothing else, and asserts they are
equal — so a change to either copy alone fails. It also asserts each is the same three clauses and
has no fourth, and that the inlined copy still throws. Both comments are true now, and neither was
deleted to make them true. §15 pin 5 carries the mutation check that proves the pin is not vacuous.

**2. D16's `not_served` mapping for the Cohere soft-failure conflicts with its own proof rule, and
the conflicting case is the only reachable one.** D16's table assigns `not_served` to "Cohere
entered and soft-failed"; the same decision says `not_served` requires failure attribution as
proof. Cohere is a raw `fetch` and never reaches `chatWithFallback`, so it can *never* carry that
attribution. Every **declared** Cohere failure throws a typed `RerankBackendError`, which
propagates (explicit path) or downgrades to the judge (env-default path) — neither reaches the
soft-fall. The only path that arrives there is a **generic** throw, where non-delivery is not
strictly proven. **I implemented the table as written** (`provenNotServed: true` on the synthesised
evidence) and flagged the tension rather than substituting my own rule. The alternative — typed
errors → `not_served`, generic → `unattributed` — satisfies both statements and is available if V
prefers it.

**3. `active_backfill_target` has no matching field on `BackfillRun`.** D2 names the column;
`lib/backfill-runs-core.ts:21` declares `id`, `worker`, `model`, `day_from`, `day_to`, `cursor`,
`n_per_tick`, `status`, `source`, counters, `last_error`, `updated_at` — and no `target`. I mapped
it to `run.model`, on the reading that what a backfill *targets* is the `bedrock:<id>` /
`vertex:<id>` string it grades against, which is also what an overlap analysis needs. Named as an
inference at the call site, not presented as a schema field.

**4. `lib/architecture/manifests.ts` needed no edit.** It is on the file contract's edit list, but
none of the seven new `lib/*.ts` modules exports a `*_VERSION` const, so none became a
coverage-bearing subsystem, and `retrieval-telemetry-core` was already in `UNREGISTERED`.
`architecture:check` is green without touching it. One fewer deviation, reported so its absence
from the diff is not read as an omission.

**5. Kickoff test 63 — write it now, or leave it absent?** Test 63 asks for **this build's own**
assertion that `lib/multi-query.ts` still contains the fail-open literal, so that a later refactor
sees two failures rather than one puzzling pin in a determinism file. This pass did **not** write
it. What it did instead was restore the pin that already exists: the first issue's doc comment at
`lib/multi-query.ts:124` quoted the literal in prose, which satisfied
`retrieval-llm-determinism.test.ts:34` on its own and made that pin vacuous. The comment is
rewritten and no longer quotes it; §15 pin 6 carries both halves of the mutation check.

So the guard is real again, but it is still **one** pin in a file about determinism, which is
exactly the fragility test 63 exists to remove. **V's call:** write 63 now as a second, independent
assertion, or leave it on the absent list. It stays on the absent list until then.

---

## 12. NOT BUILT — every omission, by kickoff step and test number

**Kickoff steps 14, 15, 16 and 17 are not built, and three steps claimed built are partial.** The
first issue's step accounting was wrong in both directions; this is the corrected table.

| Step | Status | What holds |
|---|---|---|
| **Step 9** | **PARTIAL** — claimed built | Five of six placeholder call sites exist. `lib/mcp-tools.ts` is untouched (`git diff --quiet fc28e0f 90d8db1 -- lib/mcp-tools.ts` → clean), so the sixth is missing |
| **Step 11** | **PARTIAL** — claimed built | The retrieval-outcome recording is built where the files were edited. `labRetrieve`'s two catch arms in `lib/mcp-tools.ts` are **not** instrumented, same untouched file |
| **Step 13** | **PARTIAL** — claimed built | The `lvc.ts` seam (D7) is built. The route wiring is **absent**: `app/api/appropriateness/route.ts` is untouched, so nothing constructs the `telemetry` input the seam reads |
| **Step 14** | **PARTIAL** — claimed not built | The invocation store, the failure store, `TelemetryDeclarationError` and predeclared-run threading into `auditOpdNote` all **exist**. Missing: the two worker declaration shapes (D10), the re-audit reshape, and the 503 branch in all three worker modes |
| **Step 15** | **PARTIAL** | `writeRetrievalTerminal` and the D11 order **are** built inside `auditOpdNote`. Missing: any caller that sets `opts.telemetry`, and the non-enumerable handle on the returned audit |
| **Step 16** | **NOT BUILT** | `onPersisted` at the seven `saveOpdAudit` expressions, and every owner in the D9 matrix. `settleRetrievalTelemetry` and `outcomeForSaveResult` exist; **nothing calls them from a save site** |
| **Step 17** | **NOT BUILT** | The reconciler route, its cron entry, the two cron-count test updates (`provider-switch-unit-d.test.ts:270`, `ipd-worker-batch-and-model.test.ts:57` — both still read 16 and are green because `vercel.json` was not touched) |
| **Step 19** | **NOT BUILT** | The cost query text and all ten PRD §8 query texts |
| **Step 21** | **NOT BUILT** | **All five PRD §6.5 overhead numbers, and the three extra measurements.** Not measured, not estimated. V cannot set the guardrails from this report |
| **Step 18** | vacuously satisfied | No new module exports a version constant, so none became coverage-bearing (§11 flag 4) |

```bash
for f in lib/mcp-tools.ts app/api/appropriateness/route.ts lib/mcp-server.ts \
         lib/lab-batch.ts lib/opd-audit-store.ts vercel.json lib/sql-guard-core.ts; do
  git diff --quiet fc28e0f 90d8db1 -- $f && echo "UNTOUCHED  $f" || echo "CHANGED    $f"; done
# UNTOUCHED for all seven
```

**Sites not instrumented:** `labRetrieve` in `lib/mcp-tools.ts` (both arms, so roles `lab_direct`
and `lab_multi_query` have no producer), `app/api/appropriateness/route.ts` (so `lvc_recall` has no
producer either), `lib/mcp-server.ts` and the two MCP routes, `lib/lab-batch.ts`,
`lib/opd-audit-store.ts`, and both scripts. `vercel.json` untouched.

**Tests, recounted as a partition of 1..73** (the command is in §0). Two moves since the first
issue: **63 leaves the written list** — no test in this build ever asserted it, and the only pin on
that literal predates the build — and **57 joins it**, written in this pass.

- **Absent, 50:** 1–2 (instrumentation-off proof for all six functions), 10, 12, 14–29, 31–34,
  39–44, 47–49, 51–56, 58–60, 62–65, 67, 70, 72–73.
- **Written and green, 23:** 3–9, 11, 13, 30, 35–38, 45 (partial), 46, 50, **57**, 61, 66, 68–69, 71.

**Two families are owed and are deliberately NOT stubbed:** §6.1 ranking invariance and §6.3
lifecycle/concurrency. A stub that passes against absent code is worse than a named gap, because it
reads as coverage.

**Consequently, three report items cannot be filled and are not filled:** item 11
(instrumentation-off proof), item 16 (ranking-invariance evidence), item 19 (the five overhead
numbers). Item 13 (the D9 owner matrix *as wired*) has nothing wired to report.

### 12.1 What "2940 green" covers, and what it does not

**Everything that builds a manifest and writes it is imported by no test.** Six of the seven new
modules — 1,018 of their 1,047 lines — have zero test importers. The seventh, `telemetry-key-guard`,
gained one in this pass and is the whole of the change.

```bash
for m in retrieval-capture retrieval-telemetry-store retrieval-invocation-store \
         retrieval-telemetry-failure-store retrieval-settlement opd-audit-runtime-config \
         telemetry-key-guard; do
  printf "%-36s tests=%s  anywhere=%s\n" "$m" \
    "$(grep -rlE "from '\.\./${m}(\.ts)?'" lib/__tests__ | wc -l | tr -d ' ')" \
    "$(grep -rlE "from '\.{1,2}/${m}(\.ts)?'" lib app scripts | wc -l | tr -d ' ')"; done
```

| module | test importers at `90d8db1` | after this pass | importers anywhere | lines |
|---|---|---|---|---|
| `retrieval-capture` | 0 | 0 | 8 | 358 |
| `retrieval-telemetry-store` | 0 | 0 | 3 | 344 |
| `retrieval-invocation-store` | 0 | 0 | 3 | 106 |
| `retrieval-telemetry-failure-store` | 0 | 0 | 2 | 80 |
| `retrieval-settlement` | 0 | 0 | 1 | 87 |
| `opd-audit-runtime-config` | 0 | 0 | **0** | 43 |
| `telemetry-key-guard` | 0 | **1** | **0 → 1** | 29 |

Nineteen exported symbols have no executing test: `createTelemetryCapture`, `buildRetrievalPayload`,
`servedClassOf`, `counterColumns`, `evidenceFromCompletion`, `evidenceFromError`, `errorClassOf`,
`declareRetrievals`, `writeRetrievalTerminal`, `applyTerminalState`, `addDeclaredRetrievals`,
`bumpTelemetryWriteFailure`, `closeInvocation`, `startInvocation`, `recordTelemetryFailure`,
`failurePhasesForRun`, `settleRetrievalTelemetry`, `outcomeForSaveResult`, `EQUALITY_PROJECTION`.

**The apparent coverage is source-text reads and path strings**, not execution: a test that greps
`lib/retrieval-capture.ts` for a symbol name proves the name is present, not that the function
works. §8 of this report describes update precedence, state transitions and canonicalization as
settled behaviour. They are **written**. They are **not demonstrated**. The 45 new test cases at
`90d8db1` cover transport attribution, the migration route's parity with its documentation mirror,
and non-exposure — three things that are all checkable without running the manifest path, which is
why they were checkable at all before the lifecycle was wired.

This is the true reading of the gate. It is not a defect in the code; it is the size of what §12's
50 absent tests were going to cover.

---

## 13. Defects found and left alone

1. **`lib/sql-guard-core.ts`'s blocked-relation list may be the right long-term home for the three
   telemetry tables.** Not acted on — A8 and D3 forbid editing that file, and two committed tests
   assert its literal. V's ruling.
2. **`tracedChat` attaches attribution with no attempt list.** Real, and out of scope: D14 scopes
   failure attribution to the traceless arm, and widening the traced arm is a transport change on a
   path this workstream has no measurement for.
3. **`bedrockOnlyChat` attaches no attempts either.** Same class, same reason.
4. **The four in-scope swallowing sites are load-bearing and remain so.** `defaultRetrieve` and
   `normativeChannelRetrieve` now record `retrieval_failure` before returning `[]`, but they still
   return `[]` — an audit still scores a note as if the corpus had nothing to say. That behaviour is
   unchanged by design (constraint 1); it is now merely *visible*.
5. **The `907,045 ms`-class invocation** the worker route header records is still unexplained. Not
   touched, not inferred from.

---

## 14. Statement on PRD §2 — the six prohibited inferences

**This report asserts none of the following six**, and neither does any code, comment or test name
in this commit:

1. That all 21 local fallbacks came from reranking.
2. That 24 calls recovered.
3. That all 537 stored audits came from the worker.
4. That no batch-failure marker means every score was present and numeric.
5. That a provider-backfill cron tick performed retrieval work.
6. That process-local `inFlightAtError` measures project-wide concurrency.

On (5) specifically: `active_backfill_state` exists precisely so a tick can never be counted as a
workload, and it is recorded as `'idle'` — a measurement — rather than left absent.

No number in this report is compared to the single night of console logs from 10–11 August.

---

## 15. Pins changed — old and new, side by side

**The first issue said "four". Four is the number of pins I could account for as *narratives*; it is
not the number of assertions that changed.** The count below is derived mechanically instead of
recalled. Definition: an **assertion line** is any line in the three edited test files containing
`assert.`, with leading and trailing whitespace stripped and nothing else normalized — interior
whitespace is significant, because one of these pins asserts a column's alignment inside the
migration SQL and collapsing runs of spaces hides that change. Lines are compared as a multiset, so
a pure move is not counted and a duplicate that vanished is.

```js
// The whole of it. Run against each of the three files, BASE=fc28e0f HEAD=90d8db1.
const lines = (src) => src.split('\n').filter((l) => l.includes('assert.')).map((l) => l.trim());
const a = lines(gitShow(BASE, f)), b = lines(gitShow(HEAD, f));
// multiset difference both ways: removed = a \ b, added = b \ a, counting duplicates
```

```text
=== lib/__tests__/retrieval-telemetry-core.test.ts
    assertion lines: 59 at fc28e0f -> 110 at 90d8db1 ;  removed 21, added 72
=== lib/__tests__/transport-attribution-traceless.test.ts
    assertion lines: 57 at fc28e0f -> 58 at 90d8db1  ;  removed  1, added  2
=== lib/__tests__/rerank-backend.test.ts
    assertion lines: 77 at fc28e0f -> 79 at 90d8db1  ;  removed  1, added  3
=== TOTAL: 193 assertion lines at fc28e0f -> 247 at 90d8db1; removed 23, added 77
```

**23 assertion lines removed, 77 added.** The full removed and added sets are printed in §15.1 —
every one, not a sample. Seven of the removals are re-pointed pins with a named successor and are
narrated below as 1 to 7; **three of those seven appear in this report for the first time** (5, 6
and 7 — the first issue omitted them entirely). The remaining sixteen removals are the state
vocabulary and validator assertions that the rewrite from 8 states to 14 replaced wholesale; they
are in §15.1, not narrated, because their successor is the whole rewritten file.

Pins **8 and 9 are new in this pass** and did not exist at `90d8db1`.

**1. `transport-attribution-traceless.test.ts:220`**

```js
// OLD
assert.equal((body.match(/attempts: \[\.\.\.attempts\]/g) || []).length, 3);
// NEW
assert.equal((body.match(/attempts: attempts\b/g) || []).length, 0,
  'the live array is never handed to an attribution');
assert.equal((body.match(/attempts: \[\.\.\.attempts/g) || []).length, 7, ...);
```

*Invariant:* every attribution takes a **copy**, so a later push cannot rewrite a returned record.
The old count enumerated one exact spelling; D14 adds two sites that copy as
`[...attempts, localAttemptSuccess()]`. The new form asserts the invariant **directly and more
strongly** — no attribution anywhere receives the live array.

**2. `rerank-backend.test.ts:332`**

```js
// OLD
assert.ok(audit.includes('defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend)'));
// NEW
assert.ok(/defaultRetrieve\(query, mini, opts\.evalNormativeLeg, opts\.rerankBackend[,)]/.test(audit));
assert.ok(/defaultRetrieve\(query, mini, opts\.evalNormativeLeg, opts\.rerankBackend, primaryCapture\)/.test(audit));
assert.ok(/rerank\(query, hits\.map\([\s\S]{0,200}?\)\), opts\.rerankBackend, undefined, capture\)/.test(retrieveSrc));
```

*Invariant:* `opts.rerankBackend` reaches retrieval and cannot be silently dropped by a refactor.
**Strengthened:** it now pins the backend's **position** (4th in `defaultRetrieve`, 3rd in
`rerank`) and that the capture is strictly trailing, so a capture can never displace it.

**3. `retrieval-telemetry-core.test.ts:52` (the CHECK slice)**

```js
// OLD — sliced from the first `persistence_state IN (` to the next `));`
const block = sql.slice(sql.indexOf('persistence_state IN ('), sql.indexOf('));', ...));
// NEW — anchored on the constraint NAME, bounded by `;`, asserted non-empty
const body = constraintBody(read(MIGRATION), 'opd_audit_retrieval_telemetry_persistence_state_chk');
```

*Invariant:* the runtime list and the constraint are one fact. **This one was broken before I
touched it**, and here is the measurement rather than the impression:

```bash
# replay the fc28e0f pin against the fc28e0f migration, verbatim
git show fc28e0f:migrations/0035_opd_audit_retrieval_telemetry.sql | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const a=s.indexOf("persistence_state IN ("), b=s.indexOf("));",a), block=s.slice(a,b);
  console.log("file",s.length,"start",a,"delim",b,"slice",block.length,
              "states",[...block.matchAll(/'"'"'([a-z_]+)'"'"'/g)].map(m=>m[1]).length);});'
# file 8333 start 6331 delim -1 slice 2001 states 8
```

`delim -1` is the whole finding: `));` is absent, so `slice(6331, -1)` runs to the last byte and the
2,001-byte slice matched all eight expected states, in order —
`started`, `completed_unpersisted`, `persisted_complete`, `persisted_partial`,
`telemetry_persistence_failed`, `audit_persistence_failed`, `aborted`, `not_eligible`.

So the pin was **unbounded, not empty**. It was doing real work over an accidental region — which
is worse than a dead pin, because it looks alive: every assertion in it passed, on bytes nobody
chose. There are now three such blocks, so anchoring on the constraint name is
also necessary. A second test pins the outcome CHECK's two blocks the same way, and
`constraintBody` asserts non-empty — neither can pass vacuously.

**4. `retrieval-telemetry-core.test.ts:155` (the privacy pin)**

```js
// OLD — one slice, `RetrievalManifest` … `/** Structural validation`, no emptiness guard
// NEW — declarationBody() per declaration, asserted non-empty and >200 chars, over BOTH
//       RetrievalPayload and OperationalTelemetry; plus a proof the matcher can fire;
//       plus TelemetryCapture absent from the core; plus the intersection shape assertion
```

*Invariant:* no manifest field can hold clinical text. **Strengthened four ways.** It cannot pass
on an empty slice; it covers both field-bearing declarations; a companion test proves the ban loop
*can* detect a banned field; and `StampedRetrievalManifest` — a one-line alias with no field list —
is asserted to be exactly the intersection, rather than given a third ban loop that would pass
vacuously forever.

**5. `retrieval-telemetry-core.test.ts` — the `telemetry_schema_version` whitespace re-point**
*(absent from the first issue entirely)*

```js
// OLD
assert.ok(read(MIGRATION).includes('telemetry_schema_version     INTEGER NOT NULL'));
// NEW
assert.ok(read(MIGRATION).includes('telemetry_schema_version INTEGER NOT NULL'));
```

*Invariant:* the column exists and is `NOT NULL`. What changed is five spaces — the rewritten 0035
aligns its column list differently. This is the pin that made me change how §15 is counted: a
whitespace-normalizing diff reports it as unchanged, and it is exactly the kind of edit that a
recalled list of "four pins" never contains. **The re-point weakens the pin slightly** (it no longer
notices a column-alignment change) and that is honest: alignment was never the fact it stood for.

**6. The `CREATE INDEX IF NOT EXISTS` count — deleted here, re-created at 14 elsewhere**
*(absent from the first issue entirely)*

```js
// OLD — retrieval-telemetry-core.test.ts
assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 6, 'every index is guarded');
// NEW — migrate-retrieval-telemetry-parity.test.ts:171, and it now counts BOTH sides
const inFile  = (read(SQL_FILE).match(/CREATE INDEX IF NOT EXISTS/g) || []).length;
const inRoute = routeStatements().filter((s) => s.startsWith('CREATE INDEX')).length;
assert.equal(inFile, 14, '8 on the retrieval table, 3 on invocations, 3 on failures');
assert.equal(inRoute, 14);
```

*Invariant:* every index is `IF NOT EXISTS`, so the migration is re-runnable. **Strengthened:** the
number moved 6 → 14 because the build adds two indexes to the retrieval table and six across the
two new tables, and the successor counts the executed route and the documentation mirror
*separately*, so the mirror cannot quietly drop one. It also moved file, which is why a
per-file reading of the diff loses it.

**7. `retrieval-telemetry-core.test.ts:152` → `:263` — the whole-object `batchCounters` `deepEqual`**
*(absent from the first issue entirely)*

```js
// OLD — line 152, six fields
assert.deepEqual(c, { vertex: 1, openrouter: 0, local: 1, failed: 1, unattributed: 1, retries_429: 3 });
// NEW — line 263, seven fields, called on the manifest rather than a pre-built object
assert.deepEqual(batchCounters(m), {
  vertex: 1, openrouter: 0, local: 1, not_served: 0, failed: 1, unattributed: 1, retries_429: 3,
});
```

*Invariant:* the counter object is exactly these fields with exactly these values — a whole-object
`deepEqual`, so a new counter cannot be added silently. The kickoff predicted this one by line
number. It is the assertion the `not_served` column breaks, and it broke.

**8. NEW IN THIS PASS — `telemetry-key-guard.test.ts`, the D8 source pin (kickoff test 57)**

```js
// OLD — did not exist. Two comments claimed it did.
// NEW — both conditions extracted by balanced-paren scan, normalized to one spelling, compared
assert.equal(normalize(inlinedCondition()), normalize(typedCondition()),
  'the D8 predicate is written twice and the copies have drifted — change both or neither');
assert.equal((c.match(/&&/g) || []).length, 2, `${where}: three clauses, no fourth`);
```

*Invariant:* the two copies of a deploy-blocking predicate cannot drift. **Mutation-checked**, so
this one is not taken on trust either — dropping `.trim()` from the inlined copy alone:

```text
$ # next.config.mjs: `!String(process.env.CDMSS_TELEMETRY_HMAC_KEY ?? '').trim()`
$ #              ->  `!process.env.CDMSS_TELEMETRY_HMAC_KEY`
$ npx tsx --test lib/__tests__/telemetry-key-guard.test.ts
not ok 6 - 57 pin — next.config.mjs and telemetry-key-guard.ts express the SAME condition
not ok 7 - 57 pin — both copies are the SAME THREE CLAUSES, and there is no fourth
# pass 6 / fail 2                                     (mutation reverted; tree clean)
```

**9. NEW IN THIS PASS — `lib/multi-query.ts:124`, the comment that made an existing pin vacuous**

The pin itself is untouched and predates this build: `retrieval-llm-determinism.test.ts:34` asserts
`mqSrc.includes('return [];')`. The first issue's doc comment **quoted that literal in prose**, so
the file contained it twice and the assertion matched the comment. The comment is rewritten to say
what the statement does without quoting it; the statement at line 133 is unchanged, and so is the
test. Both halves measured:

```text
$ grep -c 'return \[\];' lib/multi-query.ts        # 2 at 90d8db1  ->  1 now

# at 90d8db1, with the STATEMENT deleted and the comment left in place:
$ npx tsx --test lib/__tests__/retrieval-llm-determinism.test.ts
# pass 3 / fail 0        <-- the pin passed over a file with no fail-open statement in it

# after this pass, same deletion:
not ok 3 - multi-query generateQueryVariants: … prompt + fail-open untouched
  error: 'fail-open (→ []) preserved'
# pass 2 / fail 1        <-- the pin is load-bearing again        (mutation reverted; tree clean)
```

*Invariant:* the fail-open behaviour survives a refactor. It was not being guarded at `90d8db1`;
it is now. Kickoff test 63 asked for a **second** pin on the same literal in this build's own tests
and is still absent — see §11 flag 5, which is V's.

**Expected to break, did NOT — four pins, and the report was wrong about what two of them assert.**

| Pin | What it actually asserts |
|---|---|
| `gemini-openrouter-bridge.test.ts:180` | count **2** of `return attachTransportAttribution\(await llm\.chat\.completions\.create\(params, reqOpts\), \{` |
| `provider-error-core.test.ts:182` | the same regex, count **2** |
| `openrouter-timeout.test.ts:233` | `src.includes('await llm.chat.completions.create(params, reqOpts)')` — a **shorter** string; plus a count of 2 at `:239` |
| `vertex-retry-parity.test.ts:336` | `LLM.includes('await llm.chat.completions.create(params, reqOpts)')` — the same shorter string; plus a count of 2 at `:339` |

Only two pin the long literal. The first issue said all four did, and cited
`vertex-retry-parity.test.ts:330`, which is a `trace.ts` assertion, not this one. **The conclusion
is unchanged and still holds:** D14 wraps that expression in a `try`/`catch` *without rewriting it*,
so all four pass untouched, and `git diff --quiet fc28e0f 90d8db1` reports all four files
UNTOUCHED. The reason was wrong for half the set.

**And the kickoff did not expect these four to break.** It names exactly one of the four files —
`gemini-openrouter-bridge.test.ts` — and names it for a *different* assertion: "counts
`dispatched_provider: 'ollama'` occurrences in `lib/llm.ts`" (kickoff line 1064). That count is
still 2 and that assertion also passes. The other three files appear nowhere in the kickoff. They
were at risk because they read `lib/llm.ts`, not because anyone predicted them.

`reasoning-enforcement.test.ts` did not fire.

### 15.1 The full assertion diff

Every removed and added assertion line across the three edited test files, `fc28e0f` → `90d8db1`.
Not a sample.

```diff
=== lib/__tests__/retrieval-telemetry-core.test.ts   (59 -> 110; removed 21, added 72)
- assert.equal(RETRIEVAL_PERSISTENCE_STATES.length, 8);
- assert.equal(isTerminalState('started'), false);
- assert.equal(TERMINAL_PERSISTENCE_STATES.length, RETRIEVAL_PERSISTENCE_STATES.length - 1);
- assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 6, 'every index is guarded');
- assert.equal(/CREATE INDEX (?!IF NOT EXISTS)/.test(sql), false);
- assert.deepEqual(validateManifest(manifest([batch(0), batch(1)])), []);
- assert.ok(validateManifest({ ...manifest([batch(0)]), manifest_schema_version: 99 }).includes('manifest_version_unrecognized'));
- assert.ok(validateManifest({ ...manifest([batch(0), batch(1)]), expected_batch_count: 7 }).includes('batch_count_mismatch'));
- assert.ok(validateManifest(manifest([batch(0), batch(0)])).includes('duplicate_batch_index'));
- assert.ok(validateManifest(manifest([batch(0, { candidate_end: 0 })])).includes('bad_candidate_boundaries'));
- assert.ok(validateManifest(manifest([batch(0, { finite_score_keys: 9 })])).includes('score_keys_exceed_expected'));
- assert.ok(validateManifest(bad).includes('unattributed_with_model'));
- assert.deepEqual(validateManifest(good), []);
- assert.equal(counters.vertex, 3, 'and the counters are order-independent');
- assert.deepEqual(c, { vertex: 1, openrouter: 0, local: 1, failed: 1, unattributed: 1, retries_429: 3 });
- assert.equal(new RegExp(`^\\s*${banned}\\??:`, 'm').test(iface), false, `${banned} must not be a manifest field`);
- assert.equal(vertex.prompt_tokens, 100);
- assert.equal(TELEMETRY_SCHEMA_VERSION, 1);
- assert.equal(MANIFEST_SCHEMA_VERSION, 1);
- assert.equal(HMAC_KEY_VERSION, 'k1');
- assert.ok(read(MIGRATION).includes('telemetry_schema_version     INTEGER NOT NULL'));
+ assert.notEqual(start, -1, `${constraintName} must be present in the migration`);
+ assert.notEqual(end, -1, `${constraintName} must be terminated — a slice to EOF is not a slice`);
+ assert.ok(body.trim().length > 0, `${constraintName} sliced to nothing — this test may not pass vacuously`);
+ assert.equal(inSql.includes('not_eligible'), false,
+ assert.equal(RETRIEVAL_PERSISTENCE_STATES.length, 14);
+ assert.equal(blocks.length, 2, 'the required set and the either set');
+ for (const b of blocks) assert.ok(b.trim().length > 0, 'neither block may be empty');
+ assert.deepEqual(required, [...OUTCOME_REQUIRED_STATES]);
+ assert.deepEqual(either, [...OUTCOME_EITHER_STATES]);
+ assert.ok(/persistence_state = 'started' AND retrieval_outcome IS NULL/.test(body),
+ for (const s of a) assert.equal(b.has(s), false, `${s} is in both halves of ${label}`);
+ assert.equal(union.size, all.size, 'the three sets cover exactly the fourteen');
+ for (const s of all) assert.ok(union.has(s), `${s} is in no set — the CHECK would reject every row carrying it`);
+ assert.ok(either.has('audit_generation_failed'),
+ assert.equal(required.has('audit_generation_failed'), false);
+ assert.deepEqual([...NON_TERMINAL_PERSISTENCE_STATES], ['started', 'retrieval_complete']);
+ for (const s of NON_TERMINAL_PERSISTENCE_STATES) assert.equal(isTerminalState(s), false);
+ assert.equal(TERMINAL_PERSISTENCE_STATES.length, RETRIEVAL_PERSISTENCE_STATES.length - 2);
+ assert.equal(TERMINAL_PERSISTENCE_STATES.length, 12);
+ assert.equal(isTerminalState('not_eligible'), false, 'the removed state is terminal for nothing');
+ assert.equal(/CREATE INDEX (?!IF NOT EXISTS)/.test(sql), false, 'every index is guarded');
+ assert.throws(() => telemetryHmac('   ', 'x'), /secret is required/);
+ assert.throws(() => telemetryHmac('\t\n ', 'x'), /secret is required/);
+ assert.ok(telemetryHmac(' s ', 'x'), 'a key with real content is still usable, trimmed or not');
+ assert.equal(one('vertex').vertex, 1);
+ assert.equal(one('openrouter').openrouter, 1);
+ assert.equal(one('local').local, 1);
+ assert.equal(one('not_served').not_served, 1);
+ assert.equal(one('unattributed').unattributed, 1);
+ assert.equal(one('not_served').unattributed, 0, 'a proven non-delivery is NOT an attribution gap');
+ assert.equal(one('unattributed').not_served, 0, 'and an attribution gap is not proof of non-delivery');
+ assert.equal(nulled[k], 0, `a null class must not increment ${k}`);
+ assert.equal(all.vertex + all.openrouter + all.local + all.not_served + all.unattributed, 5);
+ assert.deepEqual(
+ assert.deepEqual(batchCounters(m), {
+ assert.equal(batchCounters(m).retries_429, 2, 'the number this workstream exists to produce');
+ assert.equal(batchCounters({ batches: [] }).retries_429, 0);
+ assert.equal(batchCounters(inCompletionOrder).vertex, 3, 'and the counters are order-independent');
+ assert.notEqual(start, -1, `${decl} must exist — this pin may not pass because the name moved`);
+ assert.notEqual(end, -1, `${decl} must be a braced declaration`);
+ assert.ok(body.trim().length > 0, `${decl} sliced to nothing`);
+ assert.ok(body.length > 200, `${decl} is suspiciously short — did the slice find the real body?`);
+ assert.equal(new RegExp(`^\\s*${banned}\\??:`, 'm').test(body), false,
+ assert.equal(/^\s*query\??:/m.test(body), true, 'a banned field IS detectable by this matcher');
+ assert.equal(src.includes('TelemetryCapture'), false,
+ assert.ok(read('lib/retrieval-capture.ts').includes('TelemetryCapture'), 'it lives in the capture module');
+ assert.ok(keys.has('operational'));
+ assert.ok(new RegExp(`^\\s*${k}\\??:`, 'm').test(body), `${k} must be declared in RetrievalPayload, not grafted on`);
+ assert.ok(new RegExp(`^\\s*${k}\\??:`, 'm').test(opBody), `${k} must be declared in OperationalTelemetry`);
+ assert.ok(/export type StampedRetrievalManifest = RetrievalPayload & \{ operational: OperationalTelemetry \};/
+ assert.ok(RETRIEVAL_ROUTES.includes('unknown_route'));
+ assert.equal((RETRIEVAL_ROUTES as readonly string[]).includes('reconciler'), false,
+ assert.ok((INVOCATION_ROUTES as readonly string[]).includes('reconciler'));
+ assert.equal(INVOCATION_ROUTES.length, RETRIEVAL_ROUTES.length + 1);
+ assert.equal(routeClassOf('reconciler'), 'reconciler');
+ assert.deepEqual([...RETRIEVAL_ROLES],
+ assert.ok(RETRIEVAL_ROUTES.includes('lvc_judge_aa'));
+ assert.equal(buckets.find((b) => b.provider === 'vertex')!.prompt_tokens, 100);
+ assert.equal(isPriceableClass('vertex'), true);
+ assert.equal(isPriceableClass('openrouter'), true);
+ assert.equal(isPriceableClass('unattributed'), true, 'a completion may have arrived and been billed');
+ assert.equal(isPriceableClass('local'), false);
+ assert.equal(isPriceableClass('not_served'), false, 'proven non-delivery cannot have cost money');
+ assert.equal(isPriceableClass(null), false);
+ assert.equal(buckets.find((b) => b.provider === 'not_served')!.priceable, false);
+ assert.equal(unattributed.priceable, true);
+ assert.equal(unattributed.prompt_tokens, 80, 'a parse failure keeps the usage it really spent');
+ assert.equal(TELEMETRY_SCHEMA_VERSION, 2, 'the on-path build changes columns');
+ assert.equal(MANIFEST_SCHEMA_VERSION, 2, 'and manifest fields');
+ assert.equal(HMAC_KEY_VERSION, 'k1', 'the key did not rotate');
+ assert.ok(read(MIGRATION).includes('telemetry_schema_version INTEGER NOT NULL'));

=== lib/__tests__/transport-attribution-traceless.test.ts   (57 -> 58; removed 1, added 2)
- assert.equal((body.match(/attempts: \[\.\.\.attempts\]/g) || []).length, 3);
+ assert.equal((body.match(/attempts: attempts\b/g) || []).length, 0,
+ assert.equal((body.match(/attempts: \[\.\.\.attempts/g) || []).length, 7,

=== lib/__tests__/rerank-backend.test.ts   (77 -> 79; removed 1, added 3)
- assert.ok(audit.includes('defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend)'),
+ assert.ok(/defaultRetrieve\(query, mini, opts\.evalNormativeLeg, opts\.rerankBackend[,)]/.test(audit),
+ assert.ok(/defaultRetrieve\(query, mini, opts\.evalNormativeLeg, opts\.rerankBackend, primaryCapture\)/.test(audit),
+ assert.ok(/rerank\(query, hits\.map\([\s\S]{0,200}?\)\), opts\.rerankBackend, undefined, capture\)/.test(retrieveSrc),
```

**The unit is a line, not a statement**, and several entries above are the first line of a
multi-line assertion whose message ran onto the next one — `assert.deepEqual(` on its own is the
clearest case. A statement-level count would be smaller. I did not make one, so I am not quoting
one: 23 and 77 are line counts under the definition at the top of this section, and that is all
they are.

---

## 16. Instrumented files and diff summary

**Two commits now. Both stats below are from `git show --stat`, not from memory.**

**Build commit `90d8db1`** — `git show --stat 90d8db1 | tail -1`:

```text
29 files changed, 5199 insertions(+), 348 deletions(-)
```

**28 files, +4,547 / −348 excluding this report**, which is the figure the first issue quoted and
the one figure in its §16 that was right: 29 − 1 = 28 files, 5,199 − 652 = 4,547 insertions.

**Correction commit (this pass)** — three files, and only two of them are code:

| File | Change |
|---|---|
| `lib/__tests__/telemetry-key-guard.test.ts` | **created**, 167 lines (`wc -l`) — kickoff test 57, 8 cases |
| `lib/multi-query.ts` | **6 insertions, 5 deletions** — the doc comment at `:124` only; line 133 untouched |
| `CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md` | this rewrite |

The report's own line delta is self-referential — it cannot be printed inside the file it counts.
`git show --stat HEAD` on `exp/rerank-telemetry` is the authority for it, and the two code figures
above are exact and were read from `git diff --stat` before the commit was made.

**Created at `90d8db1` (11):** `lib/retrieval-capture.ts`, `lib/retrieval-telemetry-store.ts`,
`lib/retrieval-invocation-store.ts`, `lib/retrieval-telemetry-failure-store.ts`,
`lib/retrieval-settlement.ts`, `lib/opd-audit-runtime-config.ts`, `lib/telemetry-key-guard.ts`,
`app/api/admin/migrate-retrieval-telemetry/route.ts`, and three test files.

**Edited (17):** `lib/retrieval-telemetry-core.ts`, `lib/transport-attribution-core.ts`,
`lib/llm.ts`, `lib/trace.ts`, `lib/retrieve.ts`, `lib/rerank.ts`, `lib/expand.ts`,
`lib/multi-query.ts`, `lib/opd-note-audit.ts`, `lib/lvc.ts` (the D7 seam and `defaultRecall` only),
`migrations/0035_…sql`, `next.config.mjs`, `.env.example`, `lib/architecture/map.generated.ts`, and
three tests.

**Every file is on the section 4 authorized list.** `lib/opd-audit-changelog.ts` and the two
low-value-care test files were not edited. `lib/sql-guard-core.ts` was not edited. `vercel.json`
was not edited. No engine bump, no scoring changelog entry.

**The preregistered grace: `WORKER_MAX_DURATION_SECONDS + RECONCILER_GRACE_SECONDS = 800 + 1800 =
2,600 seconds`,** fixed in `lib/opd-audit-runtime-config.ts` and recorded **here, now, before any
canary opens.** It cannot be tuned afterwards to make a gate pass; changing it restarts the window.
It is **conservative for most rows and deliberately so**: 800 is the highest `maxDuration` among the
instrumented routes, so a row from one of the 300-second routes waits 2,600 seconds before
reconciliation when its own route could not have run for more than 300. One grace for every row is
the choice, because a per-route grace is a tuning surface and this value must not be one.

---

## 17. What V does next

1. **Decide whether to continue this build.** It is a partial delivery. §12 is the remaining work,
   and it is at least as large as what is here. §12.1 is why the green gate does not shrink it:
   the manifest path has no executing test, so "continue" means writing the 50 absent tests as much
   as it means writing steps 14 to 17.
2. **Rule on the five flags in §11** — flag 1, which affects every developer's local build; flag 2,
   which changes what a canary would record on the Cohere path; and flag 5, whether kickoff test 63
   is written now or stays absent.
3. **Do not deploy this commit as-is without setting `CDMSS_TELEMETRY_HMAC_KEY` in Vercel
   Production.** The build will fail otherwise. That is D8 working, not a defect.
4. **Do not run the migration route yet.** The schema is ready and idempotent, but nothing writes to
   it, so applying it now buys nothing and starts a 90-day retention clock on empty tables.
5. **Nothing was pushed.** `exp/rerank-telemetry` and `park/lvc-arm-c-unshipped-11-aug-2026` are
   both local-only, for the same reason: a preview build is a second SHA on the same Flash quota,
   and the canary needs one.

No canary date is recommended. C0 was not started, and C0.5, C0.6, C1, C2, Q1 and F1 were not
built, prototyped or prepared for.
