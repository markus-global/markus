# Markus Architecture Fragility Root-Cause Analysis

> 2026-09-11 · Origin: after fixing "later requests in the same session can't see history", the boss raised
> a more fundamental question — why does this system always have fragile bugs? Is it an architecture problem?
> Why are we always patching, always depending on manual test feedback?

---

## 0. Conclusion in one sentence

**It is not that "some bug wasn't fixed properly"; it is that three classes of hard constraint are missing:
the state ownership contract, failure visibility, and invariant tests.**

Every fix on its own was correct; but the **implicit premises** those fixes rest on were neither written into
the docs nor guarded by tests. So the next structural change (for example a change in the right direction such
as "push state down into per-worker workspaces") breaks those premises **without anyone noticing**. Today's bug
is a **necessary window** produced by three individually-reasonable decisions stacking up — not a random failure.

Another brutal fact: before and after this fix, the core package's **2568 tests were all green** — test count
does not equal invariant coverage. The real gap is not "too few tests", it is that **we're testing the wrong
things**: the vast majority of cases assert implementation snapshots, while very few assert properties the
system must always satisfy.

---

## 1. Evidence list (all from today's actual findings, not gut feeling)

| # | Fact | Problem exposed |
|---|---|---|
| 1 | The same fix was delivered **twice**: `2bbdc7d7` (this branch) and `4454b4f3` (another branch), equivalent in content, sitting on two branches | Missing delivery de-duplication; unclear branch semantics |
| 2 | That fix internally **copy-pasted the `isResume` 400 guard twice** | Copy-paste patching; missing pre-commit static checks |
| 3 | In `packages/core/src/agent.ts`, **12** `console.error('[HM]/[PMC]/[CAS]')` debug prints were left in production code, spitting the sessionId to stderr on every message | Missing pre-commit gate (no-console) |
| 4 | 1200 lines of legacy dead code lingered for months, justified by "the file tool that contains `<thinking>` can't be deleted" — **it actually can be deleted when you test it** | A wrong conclusion inherited as fact; nobody reproduced it |
| 5 | `MemoryStore.getRecentMessages` **silently returns `[]`** for an unknown id, and doesn't check disk | Silent degradation: an error disguised as "no history" |
| 6 | Session context is written to `rootWorkspace` only on the HTTP thread, while messages are processed by a worker in its own workspace | No state ownership contract; scope changed behind our backs |
| 7 | Two concurrency gates contradict each other (worker gate = 3 / task gate = 1); 3 workers grab 3 tasks while 2 of them wait for nothing | The same semantics implemented twice; no single source of truth |
| 8 | Two id spaces, DB session id (`cs_*`) and in-memory session id (`sess_*`), kept consistent via `dbSessionMap` + metadata binding | Dual storage held together by convention, with no invariant checking |
| 9 | Across the whole repo there is **not a single** test for "two consecutive messages in the same session must see history" | Zero coverage of a critical invariant → only users can discover it |
| 10 | When `OPENAI_API_KEY` is present on the machine, tests really call the embedding API, hanging for ~10s per run | Test environment not isolated; CI noise masks real problems |

---

## 2. Five classes of structural root cause

### R1 Implicit shared mutable state + silent scope change ← **today's main culprit**
State such as `currentSessionId`, `activeScenario`, `turnModelOverride` was pushed down from "agent-level
singleton" to "per-worker workspace" (`workspace() = ALS ?? rootWorkspace`). This is the right direction, but it
**changes the meaning of every existing read site**: the HTTP thread always reads the root workspace, a worker
always reads its own. Any "written by an external thread, read by a worker" pattern silently breaks — and that is
exactly what happened today.

**Signature**: the change itself is legitimate, the code compiles, existing tests stay green, but the semantics
have already changed.

### R2 Silent degradation: failures disguised as normal
- `getRecentMessages(unknown id)` → `[]`
- `persistUserMessage` failure → returns `null` (the client carries on with a placeholder id)
- `getSession(not found)` → straight to `createSession` creating a new one
- `catch {}` / exceptions swallowed at `debug` level only
- fire-and-forget refresh with no de-duplication, results possibly overwriting each other out of order

**Harm**: errors stop producing noise and only show up on the user's side as "something feels off". **This is the
primary reason bugs stay latent for so long**.

### R3 Dual storage / dual id spaces held together by convention
`chatSessionRepo(cs_*)` and `MemoryStore(sess_*)` are two sources of truth, kept consistent by a "binding table +
metadata", but with no single SSOT, no startup self-check, and no consistency alerting. Once a binding write is
missed (common under concurrency), the system "falls back to a thin rebuild" (history is left with only
user/assistant rows; tool calls and results are all lost — measured 57 → 3 entries).

### R4 Multiple implementations of the same semantics
- Two message-processing pipelines, stream and non-stream (discovered today: **only the non-streaming one honors an explicit session id**)
- Two frontend implementations, legacy and hook, coexisting for a long time
- Two concurrency gates, each independent
- Two id namespaces, each resolved separately

**Consequence**: fix one path and the other becomes a hidden trap; "fixed" holds only on one path.

### R5 Missing invariant tests and commit gates, verification depends on humans
- Critical invariants (same-session history continuity, cross-worker session consistency, restart recoverability, no id-space mixing) have **zero coverage**
- Debug prints, dead code, empty `catch`, duplicate fixes all make it into the repo
- Structural changes have no "writer-reader" checklist; everything relies on memory

**Result**: the boss became the only integration test environment.

---

## 3. Why "refactoring" actually amplifies fragility (mechanism)

It is not that the refactoring direction was wrong; it is that **the way the refactoring was verified was wrong**:

1. **Structural changes legitimately change implicit premises.** Pushing state from agent level down to per-worker
   workspaces is an architectural upgrade; but at the same time it turns the **implicit assumption** spread across
   the whole repo — "reading `currentSessionId` gives you this request's session" — into something false.
2. **There is no "writer-reader matrix".** So every unaudited read site becomes a time bomb — rather than failing
   to compile like a syntax error, they **silently return a default value** (an empty session), showing up
   eventually as "the agent has amnesia".
3. **Concurrency being on by default amplifies the hit probability.** With a single worker, "the shared pointer" and
   "the request's session" happen to be equivalent, so the problem is masked; once 3 workers are the default, any
   shared pointer may belong to a different session.
4. **Conclusion**: the risk of a refactor lies not in what it does, but in **the dependency inventory it failed to
   update at the same time**. No inventory exists → you can only hit the problems by stepping on them in production.

> To judge whether a refactor is safe, don't look at "are the tests all green", look at "can you articulate where
> the semantics changed".

---

## 4. Countermeasures (ordered by leverage, all actionable)

### C1 Write down and enforce the "state ownership contract" (1 day, immediately)
- Add the **writer-reader matrix** that accompanies this document: each row = a state × who writes × who reads ×
  which thread/workspace × whether implicit reads are allowed.
- Code-level enforcement: per-worker state must not be read implicitly across threads. Remove from the signatures
  any entry point where "the HTTP thread decides the turn's session" — **pass values explicitly, don't rely on
  shared pointers**.
- The template already landed in this round: `sendMessageStream` explicitly carries the request session id;
  `handleMessageStream` resolves by "DB-id-bound in-memory session > workspace pointer > create new", and
  "has a DB id but no binding" must warn.

### C2 Eliminate silent degradation (this week, best value for effort)
Rule: any "not found → return empty / create new / swallow the exception" must distinguish three states —
`found | missing | notLoaded` — and the latter two must `log.warn` + emit metrics.
- Already landed in this round: `getRecentMessages` **lazily loads a non-resident session from disk by id first**,
  and warns on an unknown/empty id; a failed session-history load is no longer disguised as a "new session"
  (`null` = explicitly a new conversation, `undefined` = unknown identity → keep the original session).
- TODO: a lint gate banning `catch {}` and `console.*` (always go through the logger, with context).

### C3 Single source of truth / eliminate split-brain (this week)
- The one external identity = the DB session (`cs_*`); the in-memory session (`sess_*`) is an internal cache, and
  the binding **may only be written in one place** (this round already changed it to write the binding in "the
  workspace that actually handles the message").
- Run a cheap consistency self-check at startup / each round: bindings consistent in both directions, no orphaned
  in-memory sessions, disk session count reconciled.

### C4 Converge multiple paths (2 weeks)
- stream and non-stream converge onto the same `resolveTurnSession()` + the same message-processing kernel.
- Delete the coexisting legacy/hook dual implementation (this round already removed 1232 lines of dead code).

### C5 "Session invariants" test suite (**highest leverage**, kicked off in this round)
This round added `packages/core/test/conversation-session-invariants.test.ts` (6 invariants), and proved it
effective with **mutation validation**: revert the fix → 6/6 go red. The properties it guards:
1. the second message in the same session (even if handled by another worker) must see the history of the first;
2. a DB id is never used as an in-memory session key (no split-brain);
3. a non-resident session must be lazily loadable from disk (history is not lost after restart/eviction);
4. an unknown/empty id must warn, and must not silently return empty history;
5. sessions do not cross wires under concurrency;
6. behaviour must be observable when the binding is missing (warn), and must not be disguised as an "empty conversation".

**Extension direction**: any session/concurrency-related change must first add an invariant, then change the code.

### C6 Real end-to-end smoke gate (this week)
Spin up a real server + real SSE + two consecutive messages in the same session (3 workers), finish in under
10 seconds, must pass in CI.
Rationale: however complete the unit tests are, they cannot cover cross-thread semantics like "the HTTP thread
writes, the worker reads".

### C7 Structural changes must ship with a "writer-reader matrix" + canary rollout
Changing state scope = you must first produce the matrix and reconcile it cell by cell; "changing scope on the
side" is forbidden.
The focus of review for such changes is not code style, but **whether the matrix has blank cells**.

### C8 Delivery hygiene (this week)
- Must pass in CI: lint (no-console / no-empty-catch / no-unused) + `pnpm quality` + dead-code detection.
- Check for duplicate fixes before merging: the same problem appearing in multiple equivalent commits (today we
  found that `2bbdc7d7` and `4454b4f3` were duplicate deliveries).
- Test environment isolation: we found today that when `OPENAI_API_KEY` is present on the machine, tests really hit
  the embedding API and hang for ~10s per run — CI noise masks real failures, so isolation is mandatory.

---

## 5. Three things to do right now (suggested order)

1. **Complete C5+C6**: extend the invariant suite to "restart recovery / attachments / a2a / group_chat", and get
   the smoke case into CI. This is the foundation for **never again depending on manual feedback**.
2. **C2 silent-degradation cleanup + lint gates**: turn "invisible failures" into visible warnings and metrics.
3. **C1 state ownership doc + explicit sessionId**: eliminate implicit dependencies at the signature level.

> This round's fix already incidentally completed the core channel of C1, the two key points of C2, the first
> version of C5, and the debug-residue cleanup in delivery hygiene. What remains is not "fix one more bug", but
> turning these three classes of constraint into something **machine-enforceable**.
