# Concept Naming Contract

> **Status: living contract.** This is the single place where "one fact, one name" is written
> down for the concepts below. If a name changes, this file changes **in the same commit**.

> Why this document exists: the same word used for two different things (or one thing spelled
> three ways) does not throw, does not fail typecheck, and stays green in tests. It only shows up
> as two people arguing about "the decision" while meaning different objects — or as a UI badge
> that lights up on rows where the question was never asked. A name is only real once the
> **mapping** and the **single conversion point** are written down.

**Applies to**: any change that touches the names below, or adds a name for an existing fact.
**Origin**: requirement `req_2c95956482f0db9137b1255f` (concept debt), issue A2 / B3.

---

## 1. A2 — "Decision" no longer names two things

| Concept | Question it answers | Type (single name) | Values | Single writer |
|---|---|---|---|---|
| Routing disposition (一次路由的处置) | **Which flow does this signal go into?** | `Disposition` — `packages/shared/src/types/thread.ts:145` | `accept` / `attach` / `dispatch` / `stop` / `ignore` / `defer` (the union's `action` field) | `ThreadService.route()` → `ThreadService.record()` (`packages/core/src/thread-service.ts`), one row in `thread_dispositions` |
| Attention arbitration action (注意力仲裁动作) | **Which mailbox item do I work on next?** | `AttentionAction` — `packages/shared/src/types/mailbox.ts:338` | `pick` / `continue` / `preempt` / `cancel` / `defer` / `merge` / `delegate` / `drop` / `complete` / `triage` | `AttentionController` → `recordDecision()` (in-memory + `mailbox_decisions`) |

**Rules**

1. The word "Decision" belongs to the **design vocabulary only** (the workflow decision that
   `Disposition` implements). It is not a TypeScript identifier any more — `DecisionType` must
   return **0 hits** across `packages/*/src` (`grep -rn "DecisionType" packages/*/src`).
2. `MailboxItem`'s persisted column keeps its published name `mailbox_decisions.decision_type`,
   and the mirror field stays `decisionType` (`AttentionDecision.decisionType:
   AttentionAction`). Renaming a published column is forbidden (contract H9); a **type name** and
   a **column name** are different layers. Do not "fix" the column to match the type.
3. Names that were considered and **rejected**, so nobody re-proposes them:
   - `RouteVerdict` — collides with the existing `GateVerdict` (`gateVerdict()` returns
     `duplicate | direct-through | dispatch | attach | ignore-ended | assess`). Gate input and
     route output would share one word root: a new synonym layer.
   - `MailboxPickKind` — most of its values are not "picking" (`delegate`, `triage`, `complete`),
     and `Kind` vs `Type` is a synonym, not a distinction.

**Concept count: decreased.** Before: one word ("Decision") for two concepts, plus two prefix
families (`Route*` / `Decision*`). After: two names, one concept each, no new names introduced.

---

## 2. B3 — would-accept: three marks, one mapping, one conversion point

### 2.1 The mapping table (this is the only copy in the repo)

| Layer | Spelling | Values | Meaning |
|---|---|---|---|
| **DB column** (SQLite snapshot name) | `would_accept` (snake_case, SQLite convention) | `1` / `0` / `NULL` | 1 = would accept · 0 = would not · NULL = **never asked** |
| **TS field** (API / repo view) | `wouldAccept` (camelCase) | `true` / `false` / `null` | same three states, same semantics |
| **Delivery verdict** (why nothing was delivered) | `record-only` (`DeliveryDecision`) | `deliver` / `record-only` / `drop` | `record-only` = the event was **recorded but not delivered** because the agent's autonomy is `observe` |

**Is `record-only` a third name for the same thing? No — and that is the point of this section.**
It answers a different question: `record-only` is *why the event was not delivered*; `wouldAccept`
is *what was judged*. The relation is one-directional and must not be shortened into a synonym:

- `delivery === 'record-only'` (autonomy `observe`) ⇒ the disposition written for that event has
  `wouldAccept = true` — "if you had let it through, I would have taken it".
- `wouldAccept === true` does **not** imply `record-only`: the `needs-assessment` path also writes
  `true` (there is no assessment engine yet, so the event is recorded with "would have accepted"
  for later replay).
- `wouldAccept === false` means "asked, and the answer was no" (`ignore-ended`: the flow already
  ended). `null` means "never asked" (`dispatch` / `attach` / `stop`).

### 2.2 The single conversion point

```
packages/storage/src/thread-store.ts:135   export const WouldAccept = { encode, decode }
packages/storage/src/thread-store.ts:154   toDisposition()   → WouldAccept.decode(row.would_accept)
packages/storage/src/thread-store.ts:295   record()          → WouldAccept.encode(d.wouldAccept)
```

`WouldAccept` is the **only** place where the boolean and its SQLite representation meet. Call
sites must not spell `? 1 : 0` or `=== 1` themselves — that was the previous defect (encode in
`record()`, decode in `toDisposition()`, two independent guesses about the missing value, which
collapsed `undefined` into `false`).

**Tri-state is not decoration.** Until 2026-11-03 the column was `INTEGER DEFAULT 0` and both
directions were lossy: `undefined` (never asked) became `0` and read back as `false`, so
`ActionCenter` / `AgentProfile` / `RouterDesk` painted "当时判定不该来" on rows where the question
had never been asked. `NULL` makes "not asked" structurally impossible to read as "rejected".
Legacy rows written before this change keep `0`; they are indistinguishable from `false` and that
history cannot be recovered — it is a bounded, documented loss, not an open question.

### 2.3 Tests that bite

| Test | What it pins |
|---|---|
| `packages/storage/test/thread-store.test.ts` → `wouldAccept 三态回环` | DB snapshot shows `1 / 0 / NULL`; repo read-back shows `true / false / null`. Reversing either direction turns it red. |
| `packages/org-manager/test/thread-e2e-autonomy.test.ts` → `B3 · would-accept 三态回环` | The same assertion through a **real route** on a real SQLite store: `observe` → `1/true`, `ignore-ended` → `0/false`, `dispatch` → `NULL/null`. |
| `packages/web-ui/src/lib/threadPresentation.test.ts` → `wouldAcceptVerdict` | UI maps the three states to `accept` / `reject` / `not-asked`; `null` must not read as `reject`. |

---

## 3. A3 — three "statuses", three sources, zero shared literals

| Concept | Question it answers | Type (single name) | Source — only writer | Stored |
|---|---|---|---|---|
| In whose court (在等谁) | Whose turn is it on this flow? | `ThreadStage` — `packages/shared/src/types/thread.ts:66` | `deriveStage()` — same file `:85`; only caller `org-manager/src/event-routes.ts` | No (derived; `threads` has no stage column) |
| Governance state (治理态) | How far through the governance flow? | `TaskStatus` (= `ItemStatus`) — `packages/shared/src/types/task.ts:3` / `:14` | `updateTaskStatus()` + `TASK_TRANSITIONS` (`:23`) | Yes (`tasks.status`) |
| Runtime attention (注意力) | What is the agent loop doing now? | `AttentionState` — `packages/shared/src/types/mailbox.ts:409` | `AttentionController.getState()` — `packages/core/src/attention.ts:1967` | No (in memory, resets on restart) |

**Value namespaces.** `ThreadStage` values are named after whose turn it is
(`person:*` / `system:*` / `agent:working` / `none:idle`). Before 2026-11-03 the two bare values
`idle` and `working` were spelled identically in `AttentionState`, so
`stageLabel(attentionState)` compiled and silently rendered another concept's word. Because the
stage values are now namespaced, `Extract<ThreadStage, AttentionState>` is `never` and
`thread.test.ts` asserts it at compile time.

**Words.** One table per concept; the literal used by one concept may never appear under another:

| Concept | Owner |
|---|---|
| in whose court | `STAGE_LABEL` / `THREAD_GROUP_LABEL` — `packages/web-ui/src/lib/threadPresentation.ts` |
| governance | `common:taskStatus.*` → `taskStatusLabel()` — `packages/web-ui/src/lib/stateVocabulary.ts` |
| attention | `agent:profilePage.mind.attention.*` → `attentionStateLabel()` — same file |
| process (not one of the three) | `common:processStatus.*` → `processStatusLabel()` — same file |

The invariant is executable: `crossVocabularyCollisions()` (`stateVocabulary.ts`) + its test across
zh-CN / en / es, including a self-test that feeds a deliberately colliding table. Deleted in this
change: the duplicate governance dictionary `agent:profilePage.taskStatus.*` (its `review` said
评审中 while `common:status.review` said 待审核), the ghost statuses `assigned` / `approved` /
`draft`, and the mixed `common:status` namespace (governance + process in one table).

Details and the R6 answer (which pairs legitimately disagree, and why): `state-machines.md` §16.

---

## 4. Adding a name later

1. If the new name denotes an existing fact → **do not add it**; extend the table in §1 or §2.
2. If it denotes a new fact → add a row here **and** name its single writer. Two writers is a
   design error, not a naming problem.
3. Never map a value in a call site. If a conversion is needed, it goes into one codec next to
   the storage that owns the column, and this file records its `file:line`.
