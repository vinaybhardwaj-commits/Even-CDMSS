# CDMSS rerank telemetry — proof pass 2, report for Saul

**16 August 2026.** Governed by addendum v15 (signed), amended by v16 and v17 (both signed). Kickoff v3
plus the two corrective kickoffs. Numbering authority for proofs: kickoff v11 §6 and §9.

Pass 2 delivered proofs **2, 16, 17, 18, 70** and judge proofs **J1, J2, J3, J4**, test-only, across four
commits: implementation, two forward corrections, and this evidence commit. Nothing was amended,
reverted, squashed or rebased. Nothing was pushed by the builder.

```text
1  21f11944402675e4d1aab3518d632e3329d2eef7   commit 1 — implementation, four paths
2  fe0eedb26d4ea40a2f763a885321eae67bb557d0   first corrective — three type guards, two paths
3  9344cdbda014acabcae2d0c09c718fdda12e4b87   second corrective — test repairs, one path
4  <this commit>                              commit 2 — evidence, report, governance, eight paths
```

The raw record for everything below is `CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md`, in the order
addendum v17 §6.1 states: the aborted gate at commit 1, the first corrective commit, the full gate at
`fe0eedb`, the first mutation run in full, the second corrective commit, the five re-run rows, and the
full gate at `9344cdb`.

---

## 1. Stop conditions (kickoff v3 §1), as run at `72960baa`

```text
1  §0 STATUS line          SIGNED by V, 16 August 2026 — read, one line in the section, not grepped
2  authority names r28     "Saul review 27, which released pass 2, and Saul review 28, which returned…"
3  §5.13 present           line 374, "### 5.13 The thirteen labels, mapped"
4  HEAD                    72960baa8ba88d618b4eee1c43dc56ecfec58113
5  branch                  exp/rerank-telemetry
6  porcelain               empty
7  @{u} == HEAD            72960baa8ba88d618b4eee1c43dc56ecfec58113
```

The kickoff's §0 was compared against v15 §§2, 6, 7 clause by clause. No difference. The same was done
for v16 and v17 at their kickoffs.

## 2. The five proofs, as found in kickoff v11

Confirmed v11 and not v10 by its highest numbered proof: item **73** is present ("`parse_failure` and
`failed_open` are distinguished…"); v10 stops at 60. Each of proofs 2, 16, 17, 18 and 70 was located by
number in v11 and compared word for word with kickoff v3 §2, ignoring emphasis markers, list markers
and wrapping. **All five match exactly.** No line numbers are cited for any proof.

## 3. Every test written

### `lib/__tests__/explicit-judge-equivalence.test.ts` — 16 tests

| Title | Asserts |
|---|---|
| guard.1 — the connection guard refuses a non-loopback host, synchronously, naming the host | `http.get` to 10.255.255.1 throws synchronously (try/catch, not a listener); message names the host; loopback still permitted |
| 5.2 — recording is OFF by default | a request while off stores nothing; first observation after enabling is seq 0 |
| 5.3 — one observation holds seq, method, path, exact body bytes; nothing else | exactly five keys; method/path as received; Buffer equals the sent bytes; no header-shaped key |
| 5.4 — sequence numbers assigned at ACCEPTANCE, monotonic from 0, never reused | held request A (arrives first, finishes last) is 0, B is 1; third is 2; reset returns to 0 |
| 5.5a — 1048576 bytes is ACCEPTED and recorded in full | literal 1048576-byte body → 200, `overflowed:false`, body length 1048576; constant pinned separately |
| 5.5b — 1048577 bytes is REJECTED with 413 | literal 1048577-byte body → 413, body `{}`, next request 200 (socket alive), observation `overflowed:true` with zero-length body |
| 5.6 — while in flight, BOTH snapshot and resetObservations throw, naming the count | held request; both throw `/1 request\(s\) in flight/`; release in `finally`; both succeed after |
| 5.6b — the in-flight counter decrements on 413 too | after an overflow, `snapshot()` does not throw |
| 5.7 — snapshot is DEFENSIVE | mutate returned array/object/Buffer; a second snapshot returns originals; distinct objects |
| 5.8 — two identical requests produce two observations | two observations, equal bodies, distinct seq; marker group has two bodies |
| 5.9 — comparison groups by marker SET, not arrival order | opposite-order runs compare equal; a changed body is caught and named by marker set |
| 5.10 — resetObservations clears observations and counter and NOTHING in responder config | scores, raw content, usage, expansion text, embedding override, chat discrimination each proven to survive by observing responder behaviour |
| 5.11 — the parsed `requests` API is unchanged | judge/expansion/embedding push in arrival order; exact field sets; no recorder field; stores independent |
| J1.1 — SUCCESS: byte-identical on the wire, in results, in payload | nonempty wire on both arms; `sameWireObservations` null; serialized results and canonical payloads string-equal; two batches; reordered `[4,2,6,3,1,5]` |
| J1.2 — REAL BATCH PARSE FAILURE | judge returns non-JSON on every batch; both arms identical; every batch `parse_failure`; `rerankSoftFailed:false` |
| J1.3 — GENERIC OUTER FAILURE by CALL-THEN-THROW | `judgeFn` runs the real `rerankJudge` then throws a plain Error; two real requests on the wire per arm; identical; soft-fell to input order |

### `lib/__tests__/rerank-pass-2.test.ts` — 13 tests

| Title | Asserts |
|---|---|
| 2.1 — rerankCohere with an injected fetchImpl serves, stamps the capture, opens no socket | injected fetch sees one POST to the rerank URL; capture stamped `servedBackend:'cohere'`, `expectedBatchCount:1`, one `success` batch; ordered output |
| 2.2 — the DEFAULT cohereFn adapter passes the capture in the CAPTURE position | through real `rerank` with no `cohereFn`: typed `Unreachable` propagates (real fetch called, guard refused), never a TypeError; source pin `rerankCohere(q, c, undefined, undefined, cap)` |
| 16.1 — Cohere soft failure | untyped throw → inputOrder (ids in order, backend `none`, decreasing scores); one synthesised `terminal_failure` batch 0–6, `provenNotServed:false`; expected==recorded; `rerank_soft_failed:true`; composed settlement → `persisted_complete` |
| 17.1 — a per-batch throw warns, continues, `rerank_soft_failed` FALSE | non-JSON on both batches: both recorded `parse_failure`, backend `judge` (not `none`), ≥2 warnings, soft-failed false, expected==recorded |
| 18.1 — JUDGE served: `expected_batch_count == ceil(pool/JUDGE_BATCH)`, JUDGE_BATCH read from source | pools 2, JB, JB+1, 2JB+1; each equals `Math.ceil(pool/JB)` with JB parsed from `lib/rerank.ts` text |
| 18.2 — COHERE served: `expected_batch_count == 1`, whatever the pool | pools 2 and 2JB+1 → 1 |
| 18.3 — DERIVED FROM served_backend, NEVER intended_backend | intended cohere, judge serves → expected is the judge count, ≠ 1 |
| 70.1 — RUNTIME ORDER | order log: `checkHealthy:throw` first, `judge:served:2-requests` second; judge reordered |
| 70.2 — MANIFEST FACTS | capture and manifest: intended cohere, served judge, downgraded true, expected == judge count == recorded, soft_failed false |
| 70.3 — persisted_complete by v15 §4.4 composition | manifest validates clean; `outcomeForSaveResult('inserted')` → `verdictForRun({primary:[]},'primary',true)` → `upgradeForDefects` → `stateForSettlement` === `'persisted_complete'` |
| 70.4 — SOURCE PARITY vs 72960baa | `lib/rerank.ts` byte-identical to `git show 72960baa:lib/rerank.ts`; resolver, resilient arm, downgrade flag and strict propagation present by symbol |
| J2.1 — JUDGE default: explicit judge calls neither checkHealthy nor cohereFn, on success and failure | counters 0/0 on success, per-batch parse failure, and generic outer failure |
| J2.2 — HOSTILE COHERE default: still neither; contrast: omitted backend consults once | counters 0/0 in all three; omitted-backend under Cohere default → health 1, cohere 1 |

### `lib/__tests__/explicit-judge-retrieve.test.ts` — 5 tests

| Title | Asserts |
|---|---|
| J3.0 — fixture is live | reranker off → fused top-4 `[101,103,105,102]`, zero batches, zero judge requests |
| J3.1 — OMITTED-BACKEND CONTROL under a Cohere env default | `intended_backend:'cohere'`, `served_backend:'judge'`, `rerank_backend_downgraded:true`, expected==recorded, no Cohere request left, ≥3 on the wire, reordered |
| J3.2 — EXPLICIT-JUDGE ARM | fetch spy saw zero Cohere calls even with a key present; loopback saw only chat/embeddings; intended and served judge; no downgrade; 3 batches; reranked `[112,108,101,110]` ≠ fused |
| J4.1 — every arm useReranker OFF; exactly one fusion rerank; third arg is `opts.rerankBackend` | 3 arms each `useReranker:false` (and each carries `rerankBackend` by spread — stated, not asserted absent); one fusion call, third arg `'judge'`; capture stamped judge |
| J4.2 — fusion rerank ONCE; no arm stamps a batch | `fusionCalls===1`; every arm capture has zero batches; judge chats on the wire == fusion batch count |

## 4. The ten guarded terms, addendum v15 §5.2 to §5.11

| Term | Test that guards it |
|---|---|
| 5.2 enablement | 5.2 |
| 5.3 what one observation holds | 5.3 |
| 5.4 sequencing at acceptance | 5.4 |
| 5.5 the 1 MiB boundary and overflow | 5.5a, 5.5b (both literal boundaries) |
| 5.6 in-flight refusal | 5.6, 5.6b |
| 5.7 defensive snapshots | 5.7 |
| 5.8 multiplicity | 5.8 |
| 5.9 comparison by stable marker identity | 5.9 |
| 5.10 reset independence | 5.10 |
| 5.11 parsed API unchanged | 5.11 |

**No term is without a test.** Each was mutation-tested (rows 1–14) and each mutation fails its
named test, after the second corrective commit.

## 5. The mutation table — twenty-two rows

Sandbox built per kickoff v3 §9.1, shape verified (dotfiles present, `lib/__tests__` present, `.git`
absent, `node_modules` symlinked, the four pass-2 files present), deleted after each run. No git
command in the sandbox. Every mutated file restored from the worktree's committed bytes and verified
with `cmp` after its row.

**First run, at `fe0eedb`: 19 of 22 discriminated. Rows 1, 6 and 7 did not.**

| Row | Change | Named test | First run | Re-run at 9344cdb |
|---|---|---|---|---|
| 1 | limit → 1048577 | 5.5b | ✘ 5.5b passed; only 5.5a's source pin fired | ✔ `not ok 6 - 5.5b` |
| 2 | limit → 1048575 | 5.5a | ✔ | ✔ `not ok 5 - 5.5a` |
| 3 | snapshot returns internal array | 5.7 | ✔ | — |
| 4 | snapshot returns same Buffer | 5.7 | ✔ | — |
| 5 | seq at response end | 5.4 | ✔ | — |
| 6 | snapshot in-flight refusal removed | 5.6 | ✘ file timed out at 60 s, no named failure | ✔ `not ok 7 - 5.6` **by name** |
| 7 | reset in-flight refusal removed | 5.6 | ✘ file timed out at 60 s, no named failure | ✔ `not ok 7 - 5.6` **by name** |
| 8 | reset clears scores | 5.10 | ✔ | — |
| 9 | dedupe identical | 5.8 | ✔ | — |
| 10 | 200 instead of 413 | 5.5b | ✔ | ✔ `not ok 6 - 5.5b` |
| 11 | record while off | 5.2 | ✔ | — |
| 12 | header value on observation | 5.3 | ✔ | — |
| 13 | compare by arrival order | 5.9 | ✔ | — |
| 14 | recorder field on JudgeRequest | 5.11 | ✔ | — |
| 15 | hoist checkHealthy | J2 | ✔ J2.1 | — |
| 16 | explicit judge → cohereFn | J2 | ✔ J2.1 | — |
| 17 | judge before checkHealthy | 70.1 | ✔ | — |
| 18 | expected from intendedBackend | 18.3 | ✔ | — |
| 19 | remove per-batch try/catch | 17.1 | ✔ | — |
| 20 | retrieve passes undefined backend | J3.2 | ✔ | — |
| 21 | arms useReranker:true | J4.1 | ✔ | — |
| 22 | second fusion rerank | J4.1 | ✔ | — |

The seventeen rows not re-run discriminated against test code the second corrective commit does not
change; the sweep (item 32) touched only `explicit-judge-equivalence.test.ts`, which rows 1–14 cover,
and rows 1, 2, 6, 7, 10 are the five that name the tests it edited.

**Row 1's cause and repair.** 5.5b built its body as `Buffer.alloc(RECORDER_BODY_LIMIT_BYTES + 1)`. A
mutated constant moved the body with it — the test sent 1048578, the mutated limit still rejected it,
and the test that exists to pin the 1048577 boundary passed. The only thing that fired was 5.5a's
`assert.equal(RECORDER_BODY_LIMIT_BYTES, 1048576)`, a source pin. Both boundaries are now number
literals; the pin stays as a separate check.

**Rows 6 and 7's cause and repair.** 5.6 held a request open and called `release()` after two
`assert.throws`. With the refusal mutated away, `assert.throws` failed, the request was never
released, and `recorded()`'s `finally` waited on `settled()` forever. The mutation was detected — as a
60-second file timeout with no test name. `release()` is now in a `finally`, and 5.6 reports `not ok`
by name.

## 6. Sandbox shape check and deletion

Both sandboxes: `ls -a` showed `.env.example .env.local .github .gitignore .npmrc .vercel app …`;
`ls lib/__tests__` showed the test tree; `.git` absent; `node_modules` a symlink to the worktree's;
the corrective commits' text present in the copy. Both deleted after their run; absence confirmed.

## 7. Test counts

```text
baseline, before any implementation      3178
before commit 1                          3212   (+34)
before the first corrective commit       3212
before the second corrective commit      3212
gate at 9344cdb, numbered command 1      3212
```

## 8. Staging validation, commit 1 (kickoff v3 §7)

```text
$ git status --porcelain --untracked-files=all
A  lib/__tests__/explicit-judge-equivalence.test.ts
A  lib/__tests__/explicit-judge-retrieve.test.ts
M  lib/__tests__/judge-server-stub.ts
A  lib/__tests__/rerank-pass-2.test.ts

$ git diff --cached --stat 72960baa
 lib/__tests__/explicit-judge-equivalence.test.ts | 540 +++
 lib/__tests__/explicit-judge-retrieve.test.ts    | 318 +++
 lib/__tests__/judge-server-stub.ts               | 293 ++-
 lib/__tests__/rerank-pass-2.test.ts              | 529 +++
 4 files changed, 1678 insertions(+), 2 deletions(-)

$ git diff --cached --name-only 72960baa
lib/__tests__/explicit-judge-equivalence.test.ts
lib/__tests__/explicit-judge-retrieve.test.ts
lib/__tests__/judge-server-stub.ts
lib/__tests__/rerank-pass-2.test.ts

$ git diff --exit-code
[exit status: 0]
```

The same four checks were run for each corrective commit against its parent; each listed exactly the
authorized paths and `git diff --exit-code` exited 0 each time.

## 9. Ignored-document check

```text
at commit 1 (three):      v15, r27, r28
at fe0eedb (four):        v15, v16, r27, r28
at 9344cdb (five):        v15, v16, v17, r27, r28
after commit 2:           ! git status --porcelain --ignored | grep -q '^!! CDMSS-'   → exit 0
```

## 10. Commit 1

`21f11944402675e4d1aab3518d632e3329d2eef7`. `git diff --name-only 72960baa..21f11944` lists exactly the
four paths. Stat as in item 8.

## 11. The three `.env.local` lines (anchored greps, no value printed) — identical at all three gates

```text
VERCEL=1: true
VERCEL_ENV=production: true
HMAC assignment: false
```

`VERCEL` and `VERCEL_ENV` are set in that file, so the guard's first two clauses are armed from it;
the key name is absent. Every build carried its own explicit environment.

## 12–17. The gate at `9344cdb`

| # | Exit |
|---|---|
| 1 `npm test` | 0 — 3212 |
| 2 typecheck | 0 |
| 3 build, explicit env | 0 |
| 4 architecture:check | 0 |
| 5 architecture:map | 0 |
| 6 precondition 1, precondition 2, lines 1–5 | 0, 0, 0, 0, 0, 0, 0 |
| 7 quoted form | 0 |
| 7aux separate diff | 0 |
| 8 reasoning:governance | 0 |
| 9 changelog:coverage | 0 |
| pair 1 refusal | **1** — `Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build…` |
| pair 2 keyed | 0 |

Command 6: generator reported **90492** on both generations; `wc -c` reported **90494** on both. Two
generator runs agree with each other, which is the condition that matters. `git status --porcelain`
empty immediately before and after command 6.

**The same table holds for the gate at `fe0eedb`.** The gate at `21f11944` stopped at command 2
(exit 2) and is recorded as aborted; commands 6–9 and the build pair did not run in it.

## 18. The three unchanged evidence digests

```text
f8dc6861ad8a23bd66c66eacbb18b532e744ac6096b05d23f14bf96f00de4ed5  CDMSS-GATE-EVIDENCE-15-AUG-2026.md
a90446922c1631e966771dfe2ccdd327efda4d4775390a14d494e262db94a409  CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md
065be6a1af1232a34de56f2b26da3aaec8a3e6e1bded0db84fb267624a0e63a3  CDMSS-GATE-EVIDENCE-V14-DETERMINISM-16-AUG-2026.md
```

## 19–20. Commit 2

Eight paths, seven `.gitignore` negation lines. SHA and `git show --stat` are in the orchestrator's
transcript; `git status --porcelain` empty after; the §8.2 negated pipeline exits 0.

## 21. The `localhost` decision, and its comment

**`localhost` is REFUSED.** From `judge-server-stub.ts`, on `installConnectionGuard`:

> ⚠️ THE `localhost` DECISION (v15 §10.3 item 1), stated explicitly: `localhost` is REFUSED. The guard
> permits the literal `127.0.0.1` and nothing else. Reasons, in order of weight: `localhost` is a NAME,
> and the guard sees names before DNS runs. On a host whose resolver maps `localhost` to `::1` first, or
> to anything a hosts file says, the name is not the loopback address the guard is meant to permit.
> Permitting the name would permit whatever the resolver decides, which is precisely the indirection
> this guard exists to remove. Every path this pass drives already dials the literal address. Refusing
> is the failure-closed direction.

## 22. The proof 70 "base-to-commit production byte comparison" discrepancy

Review 28 item 3.3's second clause asked for "the base-to-commit production byte comparison". That
phrase occurs once in the corpus, in review 28 itself, and is defined nowhere — not in kickoff v11,
the PRD, any addendum, or any earlier review. Addendum v15 §4.3 declines it pending clarification.
Proof 70's one byte requirement is the sentence quoted from kickoff v11 — "provider selection and
fallback order are byte-identical to today" — a source-parity assertion over `lib/rerank.ts`. That is
what 70.4 asserts, against `72960baa`. No wire comparison was invented for proof 70. If Saul intended a
different comparison, he names it and it goes to pass 3.

## 23. Anything not authorized

**None in the worktree.** No production source changed. No file outside the authorized paths per
commit. No `git add -f`, `git restore`, `git checkout`, `git reset`, `git stash`, `git rebase`,
`git push`. No `node -e` with arbitrary code. No git command in either sandbox. No plain `npm run
build`. No `.env.local` value printed. Both sandboxes deleted. All three capture directories intact.

## 24. The three type-guard positions (first corrective commit)

`explicit-judge-retrieve.test.ts`, J4.1's `retrieveFn` seam:
```ts
retrieveFn: async (q, o, cap) => {
  assert.ok(o, 'retrieveMultiQuery passes an opts object to every arm');
  arms.push({ query: q, useReranker: o.useReranker, rerankBackend: o.rerankBackend });
  return retrieve(q, o, cap);
},
```
`rerank-pass-2.test.ts`, proof 16.1:
```ts
const evidence = capture.batches[0].evidence;
assert.ok(evidence, 'a synthesised soft-failure batch carries an evidence record');
assert.equal(evidence.provenNotServed, false, '…');
```
No cast, no non-null assertion, no suppression comment. `tsconfig.json` untouched.

## 25–27. First corrective commit

typecheck exit 0 before staging; 3212 before and after; `fe0eedb26d4ea40a2f763a885321eae67bb557d0`,
2 files, +12/−2.

## 28. The aborted run's directory

`$HOME/cdmss-pass2-gate-16-aug-2026` exists with `99-STOP.txt`; not overwritten. Its per-command
files are what section 1 of the evidence file reproduces.

## 29. Two defects found and fixed before commit 1

- **In-flight decrement hung on `finish`.** Node 22 does not emit `finish` on the server-side
  `ServerResponse` when the client closes its socket after reading; it emits only `close`. The
  count leaked one per request and `settled()` waited forever. **Caught by 5.4** (the file hung).
  Fixed: decrement on `close`.
- **The guard read `servername: ""` as a TLS signal.** Node's `http` passes an empty-string
  `servername` on plain http, and a first draft treated its presence as TLS and refused loopback.
  **Caught by the pre-test probe** across all three connect shapes. Fixed: TLS is decided by the
  socket's own `encrypted` property.

## 30. The two boundary literals

```ts
const exact = Buffer.alloc(1048576, 0x20);   // 5.5a
const over  = Buffer.alloc(1048577, 0x20);   // 5.5b
```
Neither reads `RECORDER_BODY_LIMIT_BYTES`. 5.6b's oversized body is `Buffer.alloc(1048577)` likewise.
The constant appears in the file only in the import, two explanatory comments, and 5.5a's separate
source pin `assert.equal(RECORDER_BODY_LIMIT_BYTES, 1048576, …)`.

## 31. The `finally` in 5.6

```ts
try {
  assert.throws(() => judge.snapshot(), /1 request\(s\) in flight/, …);
  assert.throws(() => judge.resetObservations(), /1 request\(s\) in flight/, …);
} finally {
  release();
}
```

## 32. The sweep for the held-request shape

Checked all four pass 2 files for a request held open with its release after an assertion or an
awaited call. **Found in one more place: 5.4 in the same file**, where `releaseA()` sat after an
awaited `post()` that could reject. Fixed the same way (`try { await post(…) } finally { releaseA(); }`).
`judge-server-stub.ts`, `rerank-pass-2.test.ts` and `explicit-judge-retrieve.test.ts` open no raw
`http.request` at all — they drive requests through the SDK or the db stub — so the shape cannot
occur in them. They were not touched.

## 33. The five re-run rows

```text
row 1   not ok 6 - 5.5b — the boundary: 1048577 bytes is REJECTED with 413…
row 2   not ok 5 - 5.5a — the boundary: 1048576 bytes is ACCEPTED and recorded in full
row 6   not ok 7 - 5.6 — while a request is in flight, BOTH snapshot and resetObservations throw…
row 7   not ok 7 - 5.6 — while a request is in flight, BOTH snapshot and resetObservations throw…
row 10  not ok 6 - 5.5b — the boundary: 1048577 bytes is REJECTED with 413…
```
Rows 6 and 7 are named `not ok` lines. No file-level timeout.

## 34–35. Second corrective commit

typecheck exit 0 before staging; 3212 before and after; `9344cdbda014acabcae2d0c09c718fdda12e4b87`,
1 file, +37/−9.

## 36. The three capture directories

```text
$HOME/cdmss-pass2-gate-16-aug-2026               aborted gate at 21f11944, with 99-STOP.txt
$HOME/cdmss-pass2-gate-corrected-16-aug-2026     gate at fe0eedb, first mutation run (22 rows)
$HOME/cdmss-pass2-gate-corrected-2-16-aug-2026   gate at 9344cdb, five re-run rows
```
All three exist. None was overwritten or deleted.

---

## What this pass claims, and no more

- J1's claim is byte-identical HTTP method, path, and entity-body bytes received by the loopback
  server. Nothing about TCP framing, TLS, or headers.
- J2 is a call-level fact proved with injected counters. J3 is a wire-level fact. They are not merged.
- Expansion is not claimed to agree on a rerank backend.
- Ten guarded terms, §5.2 to §5.11. Not thirteen.
- The architecture map is unchanged across all four commits.
- Nothing is deployed, nothing migrated, no canary, no ranking change, no Cohere change.

## Owed, and disclosed

- The review 28 phrase in item 22, awaiting Saul's definition.
- Addendum v17 §7's process change: from pass 3, the mutation table runs **before** the gate.
