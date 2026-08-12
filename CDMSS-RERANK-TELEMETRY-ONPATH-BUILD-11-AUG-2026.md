# CDMSS Rerank Telemetry — on-path build report

**12 August 2026.** Against `CDMSS-RERANK-TELEMETRY-PRD-v2.1-11-AUG-2026.md` and
`CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md`.

---

## 0. THE HEADLINE, BEFORE ANYTHING ELSE

**This build is PARTIAL. It is green, it is coherent, and it is INERT — but it is not the whole
kickoff.** Steps 1 to 13 and 18 of the kickoff's twenty-two are built. Steps 14 to 17 — the
lifecycle writes at the callers, the worker declaration, the settlement wiring and the reconciler —
are **NOT built**, and neither are the ten C0 query texts, the overhead measurement, or roughly
forty of the seventy-three named tests. §12 of this report lists every omission by number.

**Two things follow, and V should read both before deciding anything else.**

1. **Nothing is activated.** Every instrumentation seam is opt-in on a trailing optional parameter
   or an optional input field, and **no caller passes one**. `auditOpdNote` declares nothing
   because no route sets `opts.telemetry`; `defaultRecall` captures nothing because no route sets
   `input.telemetry`. The retrieval path executes byte-identically to `fc28e0f`. This is a
   deliberate stopping point: I stopped at the opt-in boundary rather than half-wiring the
   lifecycle, because a wired declaration with no settlement and no reconciler would leave every
   row stranded at `retrieval_complete` forever, which is worse than no telemetry.

2. **⚠️ A PRODUCTION BUILD NOW FAILS WITHOUT `CDMSS_TELEMETRY_HMAC_KEY`.** This is the one change
   in the commit that is NOT inert. It is D8 as specified. See §11, which also reports a finding
   about that guard that the kickoff could not have known.

---

## 1. Commits, document hashes, and the two SHAs

| | |
|---|---|
| Preparatory (documentation + allowlist only) | `a2a8f4d1befce394b37c10a9b023aa6c742c30dd` |
| Build commit | *(recorded at commit time — see `git log` on `exp/rerank-telemetry`)* |
| Branch | `exp/rerank-telemetry`, **not pushed** |
| Base | `fc28e0fdce015e9e303944e4197b19534c31c383` |

```
850249857454f190e52c9f9687eda64d176e1911ec439025ed1af0ee70305d95  CDMSS-RERANK-TELEMETRY-PRD-v2.1-11-AUG-2026.md
281c8cde0a07e0feadd55bbf388d94092447e6264d46b88b4c29346ffb04560f  CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md
```

**HARNESS SHA vs SERVED SHA.** The harness SHA is the build commit above. **The served deployment
SHA is not recorded here and is not mine to record.** A clean local tree proves nothing about what
Vercel is serving; the served SHA is canary-era, and this build neither deployed nor targeted a
canary. Nothing here was run against the production database.

---

## 2. Gate — nine commands

| # | Command | Result |
|---|---|---|
| 1 | `npm test` | **GREEN — 2932/2932** (2887 at `fc28e0f` + 45 new; 0 fail, 0 skipped) |
| 2 | `npm run typecheck` | **GREEN** — clean |
| 3 | `npm run build` | **GREEN, with a caveat — see below** |
| 4 | `npm run architecture:check` | **GREEN** — 8 rules + coverage; 39 subsystems, 16 registered, 23 unregistered |
| 5 | `npm run architecture:map` | **GREEN** — wrote 88,840 bytes |
| 6 | map determinism (`git diff --exit-code`) | **GREEN** — regeneration is byte-identical |
| 7 | `npm run reasoning:registry` + `git diff --exit-code` | **GREEN — the registry file did NOT change** |
| 8 | `npm run reasoning:governance` | **GREEN** — 0 ungoverned model calls |
| 9 | `npm run changelog:coverage` | **GREEN** — 19 shipped engine versions documented |

**⚠️ COMMAND 3, EXACTLY AS RUN.** Plain `npm run build` **FAILS** on this machine, and it is not a
defect in the build — it is the D8 guard firing correctly against an environment the kickoff did
not anticipate. `vercel env pull` has written `VERCEL="1"` and `VERCEL_ENV="production"` into this
machine's `.env.local`, Next.js loads `.env.local` into `process.env` before evaluating
`next.config.mjs`, and D8's three clauses are therefore all true for a *local* build. The command
that was actually run, and that produced the GREEN above, is:

```bash
CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret npm run build
```

I did **not** change D8's predicate to make the plain command pass. See §11, finding 1.

New tests by file: `transport-failure-attribution` 21 · `retrieval-telemetry-core` 25 (rewritten,
was 17) · `migrate-retrieval-telemetry-parity` 12 · `telemetry-non-exposure` 4.

---

## 3. The two counts I verified for myself

The kickoff said not to carry these on its word.

```bash
ls -d app/api/admin/migrate-*/ | wc -l
grep -l "export async function POST\|export const POST\|export function POST" app/api/admin/migrate-*/route.ts | wc -l
```

**38 directories. 29 export a `POST`.** Both match the kickoff. There is no migration runner and no
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

This build modifies `chatWithFallback`, so none of the five is asserted without a test behind it.
All live in `lib/__tests__/transport-failure-attribution.test.ts` (21/21) and
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

Three edits, all required to compile: the return-type annotation, the initialiser, and the branch
chain. Without the fix, `not_served` and a null class would both have landed in the bare `else` and
been reported as unattributed — three different facts merged into one column, which §2 forbids.

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
predicate is V's to define and a source pin holds the two copies together. The consequences:
plain `npm run build` fails locally until a throwaway key is set, and `.env.example` now documents
that. V's options are to tighten the predicate (a non-empty `VERCEL_URL` would discriminate), to
have every developer set a local key, or to accept it.

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

---

## 12. NOT BUILT — every omission, by kickoff step and test number

**Kickoff steps 14, 15, 16 and 17 are not built.** Concretely:

| Not built | What it was |
|---|---|
| **Step 14** | The two worker declaration shapes (D10), the re-audit reshape, `TelemetryDeclarationError`'s 503 branch in all three worker modes, predeclared-run threading from the worker |
| **Step 15** (partial) | `writeRetrievalTerminal` and the D11 order **are** built inside `auditOpdNote`; what is missing is any caller that sets `opts.telemetry`, and the non-enumerable handle on the returned audit |
| **Step 16** | `onPersisted` at the seven `saveOpdAudit` expressions, and every owner in the D9 matrix. `settleRetrievalTelemetry` and `outcomeForSaveResult` exist and are unit-testable; **nothing calls them from a save site** |
| **Step 17** | The reconciler route, its cron entry, the two cron-count test updates (`provider-switch-unit-d.test.ts:270`, `ipd-worker-batch-and-model.test.ts:57` — both still read 16 and are green because `vercel.json` was not touched) |
| **Step 19** | The cost query text and all ten PRD §8 query texts |
| **Step 21** | **All five PRD §6.5 overhead numbers, and the three extra measurements.** Not measured, not estimated. V cannot set the guardrails from this report |

**Sites not instrumented:** `labRetrieve` in `lib/mcp-tools.ts` (both arms, so roles `lab_direct`
and `lab_multi_query` have no producer), `app/api/appropriateness/route.ts` (so `lvc_recall` has no
producer either), `lib/mcp-server.ts` and the two MCP routes, `lib/lab-batch.ts`,
`lib/opd-audit-store.ts`, and both scripts. `vercel.json` untouched.

**Tests not written** — of the kickoff's 73, these are absent: 1–2 (instrumentation-off proof for
all six functions), 10, 12, 14–29, 31–34, 39–44, 47–49, 51–60, 62, 64–65 (partly covered), 67,
70, 72–73. Written and green: 3–9, 11, 13, 30, 35–38, 45 (partial), 46, 50, 61, 63, 66, 68–69, 71.

**Two families are owed and are deliberately NOT stubbed:** §6.1 ranking invariance and §6.3
lifecycle/concurrency. A stub that passes against absent code is worse than a named gap, because it
reads as coverage.

**Consequently, three report items cannot be filled and are not filled:** item 11
(instrumentation-off proof), item 16 (ranking-invariance evidence), item 19 (the five overhead
numbers). Item 13 (the D9 owner matrix *as wired*) has nothing wired to report.

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

Four, all preserving the same invariant. Two more were *expected* to break and did not.

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
touched it**: `));` did not exist in 0035, so the slice ran to end-of-file and passed only because
nothing else in those bytes matched. There are now three such blocks, so anchoring on the name is
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

**Expected to break, did NOT:** `gemini-openrouter-bridge.test.ts:180`,
`provider-error-core.test.ts:182`, `openrouter-timeout.test.ts:233`,
`vertex-retry-parity.test.ts:330`. All four pin
`return attachTransportAttribution(await llm.chat.completions.create(params, reqOpts), {`.
D14 wraps that expression in a `try`/`catch` **without rewriting it**, so all four still pass
untouched. `reasoning-enforcement.test.ts` did not fire.

---

## 16. Instrumented files and diff summary

**28 files, +4,547 / −348** (excluding this report).

**Created (11):** `lib/retrieval-capture.ts`, `lib/retrieval-telemetry-store.ts`,
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
   and it is at least as large as what is here.
2. **Rule on the four flags in §11** — particularly flag 1, which affects every developer's local
   build, and flag 2, which changes what a canary would record on the Cohere path.
3. **Do not deploy this commit as-is without setting `CDMSS_TELEMETRY_HMAC_KEY` in Vercel
   Production.** The build will fail otherwise. That is D8 working, not a defect.
4. **Do not run the migration route yet.** The schema is ready and idempotent, but nothing writes to
   it, so applying it now buys nothing and starts a 90-day retention clock on empty tables.
5. **Nothing was pushed.** `exp/rerank-telemetry` and `park/lvc-arm-c-unshipped-11-aug-2026` are
   both local-only, for the same reason: a preview build is a second SHA on the same Flash quota,
   and the canary needs one.

No canary date is recommended. C0 was not started, and C0.5, C0.6, C1, C2, Q1 and F1 were not
built, prototyped or prepared for.
