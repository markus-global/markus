# Thread stage (C9-C) — contract

Status: **implemented** (C9-C). Facts write path is C9-A (see `facts-layer.md`); the
inbox derivation is C9-D; the independent verifier is C9-E.

`ThreadStage` answers exactly one question: **who is this thread waiting for right now.**
It is not the governance state (`TaskStatus`, which is persisted) and not the runtime
attention state (`AttentionState`, which is in-memory). Three concepts, three
vocabularies, no shared literals — the front-end test asserts that mechanically.

## 1. The closed set

```
waiting_human | running | needs_evidence | in_verification | done | blocked_deps | failed
```

Declared once in `packages/core/src/facts/derive-stage.ts` (`THREAD_STAGES`) and mirrored
once for the UI in `packages/web-ui/src/lib/threadStage.ts`. The two lists are compared by
`scripts/architecture-guard.mjs` (`thread-stage-closed-set`), so a stage added on one side
and forgotten on the other is a CI failure, not a blank badge in production.

`saved` as free text is impossible by construction: the function's return type is the union,
and every boundary between the server and the UI passes through `isThreadStage()` /
`asThreadStage()`. A value the reader does not understand renders **nothing** — the UI never
invents a stage.

## 2. One derivation, one reader

```
packages/core/src/facts/derive-stage.ts        deriveStage({fsm, facts, approvals}) — pure
packages/org-manager/src/thread-stage.ts       the only place that turns rows into that input
packages/org-manager/src/routes/tasks.ts       GET /api/tasks/:id returns { threadStage, evidence }
packages/web-ui/src/components/ThreadStage.tsx renders the value, never re-derives it
```

Why the UI does not re-derive: the previous generation of this knowledge lived in four
components that each assembled "what is going on" from whatever they had loaded. Four
writers, one fact, four answers — and the most consequential one ("is it running?") was
derived from *whether a message existed*, which is why a stopped agent kept showing as busy
(C8-E). Re-deriving in the browser would bring that back; the page now renders a value.

## 3. Precedence (first match wins)

| # | Stage | Structural source |
|---|---|---|
| 1 | `failed` | FSM row `failed` / `rejected` |
| 2 | `waiting_human` | a pending approval/question row; FSM `pending` (awaiting approval); FSM `blocked` + `blocked_reason='hold'` |
| 3 | `blocked_deps` | an open dependency id (resolved by the caller); or FSM `blocked` when nobody resolved the graph |
| 4 | `running` | a `work_units` row in `running`; or FSM `in_progress` |
| 5 | `done` | FSM `cancelled` / `archived` — closed without claiming success |
| 6 | `needs_evidence` | no active `task.completion_evidence` fact |
| 7 | `in_verification` | evidence exists, no independent `pass` |
| 8 | `done` | evidence + independent `pass` |

Two rules carry the weight:

- **No branch reads traffic.** The input has no message/notice/timestamp channel at all, so
  "it must be running because things are happening" cannot be expressed.
- **Only an independent `pass` produces `done`** for a success terminal. `verification.result
  === 'fail'` and a self-verification both land in `in_verification` — a disproven claim is an
  unevidenced claim, and the reader must not be told otherwise.

Deliberate decisions worth reviewing:

- **`running` from the FSM row.** A WorkUnit count of zero proves nothing (a turn boundary is
  not a state change), so absence never demotes. `in_progress` is a structural row, not
  silence, and is a legitimate source under the C9 rule ("every cell traces to a fact or an
  FSM row").
- **`cancelled` / `archived` → `done`.** They are terminal but never claimed success, so there
  is no claim to verify. Mapping them to `failed` would label a deliberate cancellation as a
  failure. The invariant "`done` ⇒ pass" is therefore stated for the *success* terminals
  (`review`, `completed`) and tested as such.
- **A human-declared `hold` is `waiting_human`.** `blocked_reason` is already the single
  discriminator for "why is this blocked" (`web-ui/src/lib/blockedReason.ts`); reusing it is
  not a second writer, it is reading the existing one. Rendering a hold as `blocked_deps`
  would tell the reader to wait for an engine that will never move.
- **An explicit dependency resolution beats the coarse flag.** If the caller resolved the
  graph and found nothing open, a task still flagged `blocked` is an engine anomaly — saying
  "waiting on deps" would point at work that already finished.

## 4. Facts that do not participate

Superseded rows (`superseded_by` / `superseded_at` present) are ignored: history cannot keep
a thread `done`. Among current rows the newest `created_at` wins, ties broken by id, so two
calls on the same set always agree (no clock, no unstable sort).

## 5. UI surface (what a human is allowed to see)

| Human question | Derived from | Where |
|---|---|---|
| What do I need to do | `deriveInbox()` (C9-D) | Home |
| Where is this, who is it waiting for | `deriveStage()` | task/requirement detail badge |
| Why do we believe it is done | `facts.source_refs` | detail page evidence fold (collapsed by default) |

Asserting one fact may change exactly two things on screen: a stage label and an inbox item.
A "fact card" appearing in the UI means internal state leaked to the user.

The evidence fold never prints the fact's raw JSON. It shows `value.summary`, who asserted it,
the verification result, and clickable pointers: `dlv_…` opens the deliverable, comment ids
scroll to the activity section in place, anything else stays a labelled reference.

## 6. Verification

| Claim | Proof |
|---|---|
| zero IO / zero clock / zero randomness | `packages/core/test/derive-stage.test.ts` — no repo is mocked anywhere in the file, and two cases run with `Date.now`/`Math.random` replaced by throwing stubs |
| seven stages, positive and negative | same file, one `describe` per stage plus a totality matrix over 9 statuses × 5 reasons × 4 fact shapes × 2 human states × 2 WorkUnit counts × 2 dependency states |
| breaking the verification rule turns red | mutate `independentPass` to accept `fail`, the `in_verification` case goes red (verified while developing) |
| evidence → stage on the real writer | `packages/org-manager/test/thread-stage.test.ts` — real SQLite + `SqliteFactService`: assert → `in_verification`, add pass → `done`, supersede → back, self-verification rejected |
| the badge text follows the value | `packages/web-ui/src/components/ThreadStage.test.tsx` — DOM level: `needs_evidence → in_verification → done → in_verification` |
| no second vocabulary | `packages/web-ui/src/lib/threadStage.test.ts` — `crossVocabularyCollisions()` over stage / task-status / process labels in `en` and `zh-CN` |
