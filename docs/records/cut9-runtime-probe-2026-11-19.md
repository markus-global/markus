# C9 runtime probe — terminal hooks, derived board, independent verifier

Date: 2026-11-19 · Instance under test: `feat/refactor-plan` @ `617e9fda` (merge of #464),
packaged build, PID 90267 · Requirement: `req_dcbf7ddf997c6346e0ee1ba2` (C9)

Plan card: **C10-0D** in `docs/design/c10-external-adapters-plan-2026-11-19.md` (PR #466).
Code record this one closes: `docs/records/cut9-live-verification-2026-11-15.md`.

---

## 1. What was missing, and why it is a record and not a conversation

C9's code was verified on 2026-11-15 (`cut9-live-verification-2026-11-15.md`), but only
half was: **branch code does not run at review time**, and until 2026-11-19 14:09:30 the
serving instance predated C9-E. So the sentence "the terminal hook bites" had never been
executed against a running build — it was inferred from tests.

This record is the runtime half: steps 0–5 of the C9-E probe spec, executed against a
serving instance whose build actually contains C9-E, with every reading timestamped and
every command re-runnable.

Its predecessor's closing line is the standard being applied here: *a verification that
exists only in a conversation is not a verification, because the next reader cannot check
it.*

---

## 2. Step 0 — is the running build actually the C9 build?

Read `2026-11-19 19:17:05 CST`. Nothing was restarted to take these readings.

```bash
ps -p 90267 -o pid,lstart,etime,command
stat -f '%Sm %z bytes %N' -t '%Y-%m-%dT%H:%M:%S' \
  packages/desktop/dist-electron/mac-arm64/Markus.app/Contents/Resources/app.asar
curl -s http://127.0.0.1:8056/api/health
LC_ALL=C grep -a -o 'loop_'                      .../Resources/app.asar | wc -l
LC_ALL=C grep -a -o 'declarationDebt'            .../Resources/app.asar | wc -l
LC_ALL=C grep -a -o 'self_verification_forbidden' .../Resources/app.asar | wc -l
LC_ALL=C grep -a -o 'task.completion_evidence'   .../Resources/app.asar | wc -l
```

| Reading | Value |
|---|---|
| process | PID **90267**, started **2026-11-19 14:09:30 CST** |
| `app.asar` mtime | **2026-11-19 12:13:48**, 45,342,983 bytes |
| `/api/health` | `{"status":"ok","version":"0.12.3","agents":100,"bindHost":"0.0.0.0"}` |
| git HEAD | `617e9fda602492c652768fdf7fc37577262b9961` (merge PR #464, 2026-11-19 12:11:51) |
| symbol `loop_` (#464 work) | **19** |
| symbol `declarationDebt` | **3** |
| symbol `self_verification_forbidden` (C9-E) | **3** |
| symbol `task.completion_evidence` (C9-E) | **19** |

Plan §0.1 recorded `loop_` ×17 and `declarationDebt` ×2 at 14:1x. The counts here are
19 and 3 because this probe counts **occurrences** (`grep -o | wc -l`) rather than
matching lines; same build, same asar mtime, different counting. Recorded rather than
silently reconciled — a differing number with a stated cause is data, an unexplained
number is noise.

**Conclusion:** the serving process started *after* the asar was built and the asar
contains C9-E symbols. Every reading below therefore measures the C9 build.

---

## 3. Step 1 — tool reachability (registered ≠ callable)

Readings taken from this execution session against the serving instance.

| Call | Timestamp (CST) | Result |
|---|---|---|
| `fact_assert` (task `tsk_df3169…`, `work.defect_class`) | 19:20:20 | **`status: "asserted"`**, row `fact_51218253447b6d8020d25a47` |
| `task_submit_review` (no completion evidence) | 19:19:0x | **rejected** — see §4 for the ordering finding |

The `fact_assert` write carried identity end-to-end:

```
fact.id            = fact_51218253447b6d8020d25a47
workUnitRef        = task_tsk_df3169e699273f3d3ce31f31_r1
assertedBy         = agt_d7f911ea2163f2151277b90e
sourceRefs         = ["docs/architecture/facts.md:130",
                      "packages/core/src/agent-manager.ts:3768",
                      "tsk_df3169e699273f3d3ce31f31"]
```

Confirmed by direct read of `~/.markus/data.db` (read-only):

```
id                            | predicate        | asserted_by                   | work_unit_ref
fact_51218253447b6d8020d25a47 | work.defect_class | agt_d7f911ea2163f2151277b90e  | task_tsk_df3169e699273f3d3ce31f31_r1
```

The first `task_submit_review` attempt was refused **before** the facts gate could be
reached:

> `Cannot submit for review: 8 subtask(s) still pending. Complete them with
> subtask_complete, or cancel inapplicable ones with subtask_cancel. Pending: "步骤0…"…`

That is the documented order in `TaskService.submitForReview`
(`packages/org-manager/src/task-service.ts:5104`): status guard → **pending-subtask guard**
→ `assertCompletionEvidence` → persistence. It matters for replay: a probe taken on a card
with open subtasks measures the subtask gate, not the facts gate. The facts gate itself is
measured in §4.

---

## 4. Step 2 — negative A: no fact, submit, must be red

Executed on a **second instance** (independent port and data dir — see §7 for why), driving
the real `TaskService.submitForReview` of that process.

```
2026-11-19T11:26:47.336Z  created   tsk_bc526c294dd6158026550c8e  status=pending
2026-11-19T11:26:47.336Z  approved  status=in_progress
2026-11-19T11:26:47.337Z  submit_without_fact  RESULT=REJECTED
```

Exact error text (one line in the log, wrapped here):

```
Cannot submit for review: task tsk_bc526c294dd6158026550c8e has no active
"task.completion_evidence" fact. Submission must point at evidence, not only prose.
Assert it first:
  fact_assert({ subject_kind: "task", subject_id: "tsk_bc526c294dd6158026550c8e",
    predicate: "task.completion_evidence",
    value: { summary: "<what this work proved, 2-5 sentences>",
             evidence_refs: ["<deliverable/comment/branch id or absolute path>", ...] },
    source_refs: ["<the same ids>"] })
If a fact already exists but is out of date, use fact_supersede with a reason instead.
```

The rejection is **actionable**: it names the tool, the subject, the predicate, and the two
value fields, and it names the escape hatch (`fact_supersede`) for a stale fact. A gate
that only says "missing evidence" trains the model to hallucinate a different call.

### 4.1 A second finding from the same run: facts need a work-unit identity

The first attempt to satisfy the gate in-process was rejected again, by the writer:

```
{"status":"rejected","code":"missing_provenance",
 "message":"A fact needs identity: work_unit_ref (this turn is not bound to a WorkUnit),
            asserted_by, and at least one source_ref. Empty is an error, not a default."}
```

This is the C7/C8 identity chain holding on the C9 path: a probe process has no turn, so it
has no `work_unit_ref`, so it cannot write a fact. The repair is not to relax the writer —
it is to supply the real ref (`task_<taskId>_r<round>`), which the positive case in §5 does.

---

## 5. Step 3 — positive: assert per the error text, submit clean

Same instance, same task, same method:

```
2026-11-19T11:27:50.752Z  fact_assert  status=asserted
                          fact_10f62ba70b27b032294c6f63
                          workUnitRef=task_tsk_fcd5661acfeeb86faaa18bb2_r1
2026-11-19T11:27:50.754Z  submit_without_fact → (previous attempt) REJECTED
                          submit_after_fact    → ACCEPTED  status=review
```

Red → green on the same path, 2 ms apart, with nothing changed except the presence of the
fact. That is what "the gate bites" means operationally: the same call flips because the
evidence exists, not because anything was relaxed.

---

## 6. Step 4 — negative B: independent verifier (producer ≠ confirmer)

On the **serving instance**, the fact asserted in §3 was then verified by the same agent:

```
fact_verify({ fact_id: "fact_51218253447b6d8020d25a47", result: "pass", … })
→ {"status":"rejected","code":"self_verification_forbidden",
   "message":"Agent agt_d7f911ea2163f2151277b90e asserted this fact, so it cannot verify it.
              Verification must come from a different agent (producer != confirmer): the task
              reviewer, or an agent designated by the owning team manager for cross-team work."}
```

Enforced at write time (`packages/org-manager/src/fact-service.ts:240` / `:410`), not by
convention in a prompt. The fact therefore stays `in_verification` until the reviewer
(CTO, `agt_b56cd620…`) rules on it — which is the intended outcome, not a gap.

---

## 7. Step 5 — laziness: what "facts off" can still mean, measured

### 7.1 The premise in the card no longer exists

Plan §C10-0D step 5 and the card both say *"`FACTS_ENABLED=0` on a second instance"*.
Measured 2026-11-19 19:2x CST, HEAD `617e9fda`:

```bash
grep -rn "FACTS_ENABLED" --include=*.ts packages/*/src   # → 0 hits (no executable reader)
```

`packages/core/src/agent-manager.ts:3768` and `:3785` state that the switch was **deleted
on 2026-11-15** (Owner decision): *"事实层是核心能力，不再提供关掉整层的运行形态；不接线的
部署仍是合法的惰性状态"*. So `FACTS_ENABLED=0` cannot be executed — there is no reader left
to notice it.

The code names the surviving lazy form itself: **a deployment that never wires the facts
port**. That is what §7.2 measures. This substitution was reported to the CTO for a ruling
before being written up (see §10.2); no product code was changed to make the probe green.

### 7.2 Two second instances, same build, one wiring difference

Both launched from the same worktree, `HOME` redirected so `~/.markus` is a throwaway data
dir, each on its own port. **The serving instance was not touched** (§9).

| | wired (`:8066`) | unwired (`:8067`) |
|---|---|---|
| pid / data dir | 11314 · `/tmp/mpw5/.markus` | 11436 · `/tmp/mpw6/.markus` |
| read at (CST) | 19:27:50 | 19:28:48 |
| `storage.factService` present | **true** | **false** |
| agent tool count | **117** | **113** |
| `fact_*` tools registered | **`fact_assert`, `fact_supersede`, `fact_query`, `fact_verify`** | **`[]`** — all four absent |
| `submitForReview` with no fact | **REJECTED** (terminal hook active) | **ACCEPTED** → `status=review` |

The four-tool delta is exactly 117 − 113. The unwired instance keeps every other tool and
runs the identical `TaskService.submitForReview` code path — the only difference is that
`setFactService(null)` was called at assembly, which is the documented inert state.

### 7.3 How "unwired" was produced (and why this is not a product change)

`probe2-suite.mjs` replaces `APIServer.prototype.wireWorkUnits` for the probe process only,
dropping `storage.factService` immediately before the original runs. Both ports
(`api-server.ts:2099` for `AgentManager`, `:2101` for `TaskService`) therefore receive
`null` through the **real** call path — the same thing a deployment without a facts writer
would do. No file under `packages/` was modified.

---

## 8. Step 4 — disposable card: what actually happened

A disposable card was created under this requirement
(`tsk_fdf3828fbc7ebf40395e1092`, "【一次性探针卡·勿保留】C9 终态钩子真机探针"). It could not
be used, and the reason is a platform fact worth recording:

```
task_update(tsk_fdf…, status="in_progress")
→ Error: Task tsk_fdf… is pending approval. Use the approve or reject endpoint.
```

`approveTask` (`packages/org-manager/src/task-service.ts:3159`) only accepts a `pending`
task and is reached from the human-authenticated REST route
(`packages/org-manager/src/routes/tasks.ts:435`). An agent therefore **cannot start a card
it created itself** — the probe recipe "create a disposable card, submit it" has no
self-service execution path. The card was cancelled instead of being left on the board
asking a human for a decision nobody needed; the negative/positive probes ran on the second
instance (§4, §5) and on the serving instance's own tool path (§3, §6).

Board state after cleanup — read directly from `~/.markus/data.db`:

| object | status |
|---|---|
| `tsk_fdf3828fbc7ebf40395e1092` (disposable probe card) | **cancelled** |
| `tsk_df3169e699273f3d3ce31f31` (this card) | in_progress → review on submission |

Facts are append-only by design (`docs/architecture/facts.md`), so the probe facts stay in
`facts` as history. They are attached to a cancelled card and to this card, and none of
them pretends to be evidence for the requirement's acceptance.

---

## 9. The serving instance was never restarted

Two readings, bracketing the whole probe:

| reading | pid | started | elapsed |
|---|---|---|---|
| 19:17:05 CST | 90267 | 2026-11-19 14:09:30 | 05:07:35 |
| 19:29:5x CST | 90267 | 2026-11-19 14:09:30 | 05:20:15 |

Same pid, same start timestamp. All probe processes ran on `:8066` / `:8067` with their
own data dirs; nothing wrote to the serving `~/.markus/data.db` except the intended
`fact_assert` (through the platform) and the task lifecycle of this card.

---

## 10. Findings the probe produced (not all of them about C9)

### 10.1 `docs/architecture/facts.md` still documents a deleted switch

The architecture doc still presents `FACTS_ENABLED=0` as the rollback path
(`:130`, `:243`, `:354`), while the code says the switch was removed on 2026-11-15. Filed
as an R2 fact (`fact_51218253447b6d8020d25a47`) rather than fixed here — C10-0D is a probe,
and a doc fix rides with the doc owner.

### 10.2 Step-5 wording is stale in two places

Both the plan (#466) and this card specify a switch that no longer exists. The measured
substitute is §7; the CTO was asked for a ruling on the substitution before it was recorded.

### 10.4 A probe process cannot assert a fact

`fact_assert` from a non-turn process returns `missing_provenance` (§4.1). That is the
identity contract working: no turn → no `work_unit_ref` → no fact. Replay must therefore
supply `workUnitRef: task_<taskId>_r<round>`, as §5 does.

### 10.5 The `[FACTS:…]` prompt block stayed empty after a real assert (observation, not a claim)

Measured on the serving instance, 19:20–19:31 CST, inside the execution session whose
subject is this card:

| read | value |
|---|---|
| `fact_assert` on `tsk_df3169…` at 19:20:20 | `status: asserted`, row `fact_51218253447b6d8020d25a47` |
| `SELECT … FROM facts WHERE subject_id='tsk_df3169…'` | 1 row, `superseded_by = null` |
| `fact_query({subjectKind:'task', subjectId:'tsk_df3169…'})` at 19:31 | `count: 1` |
| the session's own `[FACTS:task_tsk_df3169…]` block, same turns | **`(no facts yet)`** |

So the subject was resolved (the header names this task) while its fact set rendered empty,
twelve minutes after the fact was committed, through eleven turns.

Two candidate causes, neither verified — this record does not pick one:

1. the block is rendered from a snapshot taken at **session start** and is not recomputed
   per turn;
2. the provider is not wired for this session type even though the header renders.

Not fixed here: C10-0D is a probe, and "why is the injection empty" is a different root
cause from "do the terminal hooks bite". Recorded because the consequence is real — during
a task round, a fact asserted mid-round is exactly the one the agent should see.

---

## 11. Reproduce

```bash
# 0. instance identity (read-only)
ps -p <pid> -o pid,lstart,etime,command
curl -s http://127.0.0.1:8056/api/health
LC_ALL=C grep -a -o 'self_verification_forbidden' \
  packages/desktop/dist-electron/mac-arm64/Markus.app/Contents/Resources/app.asar | wc -l

# 7. second instance, wired → the terminal hook must reject, then accept after the fact
mkdir -p /tmp/mpw-wired
HOME=/tmp/mpw-wired PROBE_PORT=8066 PROBE_FACTS=wired \
  node <workspace>/probe2-suite.mjs      # prints PROBE {...} JSON lines

# 7. second instance, unwired → no fact tools, hooks inert
mkdir -p /tmp/mpw-unwired
HOME=/tmp/mpw-unwired PROBE_PORT=8067 PROBE_FACTS=unwired \
  node <workspace>/probe2-suite.mjs

# 3/6. serving-instance reads (read-only)
node <workspace>/dbq.mjs \
  "SELECT id,predicate,asserted_by,work_unit_ref FROM facts WHERE subject_id='<taskId>'"
```

The probe scripts are `probe2-launch.mjs` (boot only) and `probe2-suite.mjs` (boot + drive)
in the executing agent's workspace; each run needs a **fresh** `HOME` because the second
instance self-initialises a database on first boot.

---

## 12. Conclusion — three-way, per the card discipline

**PASS on steps 0–5, with one substituted criterion (§7.1) and one platform limitation
(§8) named explicitly.**

- The running build is the C9 build (§2).
- The four fact tools are callable, not merely registered (§3).
- The terminal hook is red without evidence and green with it, on the same code path, 2 ms
  apart (§4, §5).
- The verifier refuses to confirm its own producer's claim (§6).
- With the facts port unwired, the four tools disappear and both hooks are inert; every
  other tool and code path is unchanged (§7).
- The serving instance was never restarted (§9).

### What is NOT residual

- The probe card staying `pending` → cancelled (§8): the approval gate is human-only by
  design; this is a recorded platform property, not unfinished work.
- Fact rows remaining in `facts` (§8): append-only is the design.
- `docs/architecture/facts.md` still naming `FACTS_ENABLED` (§10.1): filed as a fact for
  the doc owner; it does not affect this probe's conclusion.
- Requirement `req_dcbf7ddf997c6346e0ee1ba2` status: the reviewer closes it. The worker
  asserting acceptance would be self-verification wearing a different hat.
