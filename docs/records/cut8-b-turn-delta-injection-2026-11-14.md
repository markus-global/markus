# Cut 8 · C8-B — In-turn delta injection: a contradicting fact lands inside the turn that is already running

> Branch `task/c8-b-turn-delta-injection` → PR into `feat/refactor-plan`.
> Stacked on C8-A (`9908feec`), because C8-A is the card that decides *where* a
> same-entity fact goes; C8-B decides *what that fact looks like* once it goes
> in-turn. PR notes the stack explicitly.
> Design + test plan written before the first red run; §7 records what the
> implementation corrected.

---

## 1. Symptom

A turn is a long computation. While it runs, the outside world changes: a task
is cancelled, a requirement is rejected, a reviewer reverts a decision, a
colleague corrects a fact the turn is currently acting on. Today the turn does
not see any of it until it ends — the mailbox item is queued behind the running
turn.

The damage is not "late information". It is **irreversible work done on a
premise that was already false**: files written, commits pushed, messages sent,
reviews submitted — all after the cancel arrived.

The other direction is equally wrong: pouring the whole mailbox into the next
LLM call on every tool round breaks prompt caching, floods the context, and
makes the turn unreproducible.

## 2. Root cause

Two facts were conflated into one queue:

| fact | correct treatment |
|---|---|
| "something new happened **about this same piece of work**" | belongs to the running turn — it changes what the turn should do |
| "something new happened **elsewhere**" | belongs to the queue — it must not interrupt |

The queue answered both with "wait". Queueing is a *scheduling* statement
("you will get your turn"), and it silently became a *correctness* statement
("your premise is still true"). One mechanism, two meanings — R2.

The root-cause test: could this recur under a different name? Yes — any new
signal type (a new IM gateway, a webhook, a new review event) would queue behind
a running turn and be seen too late. So the fix cannot be a per-type special
case. It has to be a statement about the **entity** (same `work_unit_ref`) and
about **when** the turn looks (immediately before the next LLM call).

## 3. Contract (the five criteria, each one falsifiable)

1. **Effective in the current turn.** A contradicting fact produces a new
   `agent_decisions` row with `decision_type='cancel'` *before the turn's next
   LLM call*, not after the turn ends. No new table: `agent_decisions` already
   exists (`id, agent_id, decision_type, mailbox_item_id, context, reasoning,
   outcome, created_at`).
2. **Ordering.** Injection happens *before* the LLM call it is meant to inform.
   Proven with a recorder: a decision recorded during injection must appear
   before the next `chat`/`chatStream` call in one ordered trace.
3. **Empty injection must not break the cache — byte level, never `hitRate`.** Two
   requests whose *logical* delta input is "nothing" must share a byte-identical
   messages prefix (`sha256`), whatever produced that "nothing". The segment is
   **tail-appended**: earlier messages are never rewritten, so the prefix cannot
   move.
4. **Tail-variable, never head-variable.** Every variable value lives at the end
   of a stable template; the segment is emitted even when empty (`count: 0` +
   `none`). Omitting a段 when the count is 0 changes the template's byte shape
   and is forbidden.
5. **Single writer.** No second store of "pending facts for this turn" is
   introduced: the delta is a *read* over the one mailbox queue; the only write
   is the appended session message and the one decision row.

## 4. Design (as implemented)

### 4.1 One pure module: `packages/core/src/turn-delta.ts`

```
classifyTurnDelta(row) -> 'contradiction' | 'authoritative' | 'decision' | null
buildTurnDeltaSegment({ snapshotSeq, rows }) -> { text, items, omitted, decision }
```

* **Entity filter is upstream** (the query), so this module cannot decide "is it
  about the same thing" — it only classifies rows it is given.
* Classification is **structural**, in this order:
  1. `contradiction` — the envelope carries `invalidatesPremise` or a non-empty
     `supersedes` (a cancel / reject / revert / correction has to say so in a
     field, not in prose).
  2. `authoritative` — `isAuthoritativeIntent(envelope.intent)`
     (`trigger_execution` / `action_required`), the platform's existing single
     authority predicate.
  3. `decision` — `routeMailboxItem(row).strictState`: the formal state-machine
     item types (task/requirement/review/workflow status), i.e. a new decision
     about the same entity.
  4. everything else → `null` (queue only; never in-turn). This is where
     `heartbeat`, `daily_report`, `memory_consolidation`, `system_event` and
     unrelated notifications fall out, by data, not by a name list.
* `supersedes` / `invalidatesPremise` are **new optional envelope fields**
  (`DeliveryEnvelope`). They are additive: an envelope without them behaves
  exactly as today. A structured correction chain is the only way to satisfy
  "every entry carries `supersedes`" without parsing prose (R3).
* Rendering is a stable template with the variable part at the end:

```
[LIVE UPDATE @<seq=N>]
count: <n>
- <class>/<sourceType>: <label> (item <id>)[ supersedes: a,b]
...
```

  Empty: `count: 0` newline `none`. The header is emitted by a constant
  (`TURN_DELTA_HEADER_PREFIX`) so callers/tests cannot drift from the shape.
  At most **3** item lines and **600** characters total; anything beyond is
  summarised in one line `- (+N more — call check_mailbox)` and counted in
  `omitted`, so "10 facts" is provably not "10 lines".
* `decision` is `'cancel'` iff a contradiction is present, else `'continue'`.
  `defer` is deliberately **not** produced here: "belongs to something else" is
  already answered upstream by the entity filter (C8-A's destination
  decision). Two places answering "is this mine" would be the R1 this cut is
  removing.

### 4.2 `seq`: an insertion ordinal, never a clock

The delta query is `work_unit_ref = <this turn> AND seq > <snapshot taken at turn
start>`. `seq` is a monotonic **insertion ordinal** owned by `AgentMailbox`
(`itemSeq: Map<id, seq>` assigned at `insertSorted`, bumped when an item is
merged so a fact can never be lost by merging into an older row).

It is deliberately *not* `Date.now()` and *not* `queued_at`: same-second inserts
would tie, and a clock in a rendered header is exactly the "two byte sequences
for one logical input" defect criterion 3 forbids. The rendered `@seq=` value is
the **snapshot** of the turn, constant for the whole turn, so repeated renders
are byte-identical.

### 4.3 Where it runs

`Agent.turnDeltaInjection(sessionId)` is called at the one place that is both
"after tool results" and "before the next LLM call" — the yield point each tool
loop already has (`handleMessage`, `chatStream`, `executeTask`, `respondInSession`).
It:

1. reads `this.currentTurnWorkUnitRef` (in-memory, set by `onFocusChanged` — a
   *notification*, never a DB lookup: C7-B's ruled constraint);
2. returns `'continue'` immediately when the turn has no WorkUnit — **no entity,
   no claim of relevance**. It does not fall back to "the agent's latest item",
   which would be structure inferred from time;
3. queries the mailbox queue for same-`workUnitRef` rows above the snapshot;
4. appends one segment message to the session (tail append) — always, empty or
   not;
5. on `cancel`: records the decision through `AttentionController`
   (`recordTurnDeltaDecision` → the existing `recordDecision`), carrying the
   delta item's id and the side effects already performed in the turn, then
   tells the caller to abort.

`agent_decisions` therefore keeps **one writer** (`AttentionController`).

### 4.4 The switch

`turnDeltaInjection` is on by default and can be turned off
(`AgentOptions.turnDeltaInjection: false` / `setTurnDeltaInjection(false)`).
Off = the injection step is skipped entirely: no message appended, no decision
recorded, and the semantics are exactly C8-A's queue semantics. It is one flag
read at one point — not a second code path.

## 5. Test plan — every assertion observed red before implementation

`packages/core/test/turn-delta.test.ts` (pure module)
1. Empty input and "rows exist but none qualify" render byte-identically and both
   contain `count: 0` + `none` (criterion 3 and 4, both directions).
2. Rendering the same input twice is byte-identical (no clock, no counter).
3. The rendered segment is a **suffix**: for a base message array, the serialized
   prefix is byte-identical with and without injection (criterion 4).
4. Ten qualifying facts → 3 item lines + `+7 more`; `omitted === 7`
   (criterion 5).
5. An unrelated notification (`heartbeat`, `daily_report`,
   `memory_consolidation`) never appears and never raises the count
   (criterion 4 of the card / scope).
6. `supersedes` reaches the rendered line; `invalidatesPremise` yields
   `decision === 'cancel'`; an `action_required` item alone yields `'continue'`.
7. Total rendered length never exceeds 600 chars.

`packages/core/test/turn-delta-injection.test.ts` (real agent loop, fake LLM)
8. A tool enqueues an authoritative fact during the turn → the recorder trace is
   `tool → decision/inject → llm#2`, and `llm#2`'s messages contain
   `[LIVE UPDATE @` (criterion 2).
9. A tool enqueues a contradiction → exactly one `agent_decisions` row with
   `decision_type='cancel'`, its `mailbox_item_id` is the delta item, and the
   turn's next LLM call never happens (criterion 1).
10. Same as 9 but with the switch off → no decision row and the turn continues
    to `llm#2` (the off path is real, not dead code).
11. A fact about a *different* WorkUnit does not appear in the injected segment
    and does not record a decision.
12. **One fact is reported once per turn.** A two-tool-round turn in which the
    fact arrives in round 1: the fact label appears exactly once in the third
    call's messages, while the second segment is still emitted as `count: 0`
    (criterion 4) — i.e. the watermark advances, the template does not change
    shape. Proven red by disabling the advance (`expected 2 to be 1`, §7.6).

## 6. Verification

### 6.1 Gates (same order as CI, final source state)

| gate | result |
|---|---|
| `tsc -b` | clean |
| `tsc --noEmit -p packages/web-ui` | clean |
| `eslint` on the touched files | 0 errors (7 pre-existing warnings) |
| `node scripts/architecture-guard.mjs` | 34 hits, all whitelisted; contracts 18/18 |
| `node scripts/security-guard.mjs` | ok |
| `vitest run` (whole repo, serial) | **8554 passed / 1 failed / 13 skipped** |
| `vitest run --project web-ui` | 1476 passed / 3 skipped / 0 failed |

The single failure is the known pre-existing CLI one
(`packages/cli/test/commands-start-integration.test.ts > auto-runs quickInit when
config is missing`, 60 s timeout) — it also fails on the C8-A base `9908feec`
and this card touches neither the CLI nor `quickInit`. Test count went from
8536 (C8-A) to 8553: exactly the 17 new assertions of this card.

### 6.2 Red at base, green at head (behavioural, not module-resolution)

The test file was copied into a detached worktree at base `9908feec`
(installed + `tsc -b`), with the one constant inlined (otherwise the red would be
"module not found", which proves nothing about behaviour):

| assertion | base `9908feec` | head |
|---|---|---|
| authoritative fact is injected **before** `llm#2` (ordering recorder) | ✗ `expected '…' to contain '[LIVE UPDATE @seq='` | ✓ |
| contradicting fact → `agent_decisions(decision_type='cancel')` in the same turn | ✗ `expected [decision:pick, llm#1, …] to include 'decision:cancel'` | ✓ |
| a fact about a **different** WorkUnit injects nothing (control) | ✓ | ✓ |
| switch off ⇒ no segment, no decision row (control) | ✓ | ✓ |

The two controls stay green on both sides: "the same entity cancels" cannot be
explained by "every fact cancels", and the off switch is not dead code.

### 6.3 The four pieces of evidence the card asks for

All four produced by the shipped code (`packages/core/dist/*`), 2026-11-14
17:54 (+08:00).

**① The cancel ledger row, read back with SQL.** The decision was written by the
production writer (`AttentionController.recordDecision` →
`SqliteDecisionRepo.save`) into a real SQLite table created from the live
schema `agent_decisions`:

```json
{"id":"dec_cfea0892d6c2087b4a9fe9a6","agent_id":"probe-agent","decision_type":"cancel",
 "mailbox_item_id":"mbx_f5c2c89f596d602a44c947cb",
 "context":"{\"currentFocusType\":\"human_chat\",\"currentFocusLabel\":\"Please do it.\",\"currentFocusItemId\":\"mbx_2e8daf6d951e7003df4f12ce\",\"mailboxDepth\":1,\"queuedItemTypes\":[\"task_status_update\"]}",
 "reasoning":"[turn-delta] contradiction/task_status_update (mbx_f5c2c89f596d602a44c947cb) supersedes the premise this turn was executing",
 "outcome":"turn_aborted_before_next_llm_call","created_at":"2026-11-14T09:54:45.513Z"}
```

Live table for reference (read-only `~/.markus/data.db`, 17:54): 226 963 rows,
4 of them `cancel` — the table and its enum already existed; this card added no
schema.

**② No delta vs empty delta — prefix `sha256`, with byte lengths.**

```
no-delta    segment bytes: 35 | empty-delta segment bytes: 35
no-delta    segment sha256: 3d4c91e108a56c63678dff76f4bf57964a93e46315f53687e6dda90267b71817
empty-delta segment sha256: 3d4c91e108a56c63678dff76f4bf57964a93e46315f53687e6dda90267b71817
messages prefix (4 messages): 269 bytes
prefix sha256 without injection       : ad53864a9a3358cdf0cb8ff302425dfde0e3f7890e58c88a3821882dd27536ad
prefix sha256 after empty-delta inject: ad53864a9a3358cdf0cb8ff302425dfde0e3f7890e58c88a3821882dd27536ad
prefix sha256 after no-delta inject   : ad53864a9a3358cdf0cb8ff302425dfde0e3f7890e58c88a3821882dd27536ad
```

"Empty delta" here means *rows arrived but none qualified* (a heartbeat, a daily
report, a dream run); "no delta" means nothing arrived. Same bytes, `count: 0`,
`none` — and the 269-byte prefix never moves, because injection only appends.

**③ Ten facts truncated to three + "+7 more".**

```
[LIVE UPDATE @seq=30]
count: 10
- decision/task_comment: fact 0 (item mbx_0)
- decision/task_comment: fact 1 (item mbx_1)
- decision/task_comment: fact 2 (item mbx_2)
- (+7 more — call check_mailbox to list them)
```
212 characters, `omitted = 7`.

**④ `inject()` before `llm.complete()` — recorder trace.**

```
authoritative case: ["decision:pick","llm.complete#1","tool.result","decision:continue","llm.complete#2"]
                    tool.result index 2 < llm.complete#2 index 4
                    llm.complete#2 messages contain the segment: true
contradiction case: ["decision:pick","llm.complete#1","tool.result","decision:continue","decision:cancel"]
                    no llm.complete#2 at all — the turn was aborted, not finished
```

The injected segment as the model actually received it:

```
[LIVE UPDATE @seq=1]
count: 1
- authoritative/requirement_update: Scope changed — take action (item mbx_b72b0c937a819da9cf59240c)
```

## 7. Where the implementation corrected the plan

1. **`count` is the number of facts that arrived, not the number rendered.** My
   first test expectation was `count: 7` after truncation (i.e. the rendered
   count). That reads as "you are missing nothing" while hiding seven facts, so
   the implementation reports `count: 10` and the omitted count separately in
   `- (+7 more …)`; the expectation was corrected (recorded here rather than
   silently edited).
2. **`decisive` must be computed from all qualifying facts, not from the rendered
   three.** A cancel sitting at position 5 is still a cancel; deriving the
   decision from the rendered slice would have made "the 5th fact cancels the
   turn" depend on the character budget. Found while writing the renderer.
3. **`outcome` has to be passed *into* the single writer.** The first version
   assigned `decision.outcome` after `recordDecision()` — which had already
   persisted the row, so every cancel row read back `outcome: null`. The probe's
   SQL read-back is what exposed it (§6.3 ①); the fix routes `outcome` through
   `recordDecision(type, item, reasoning, outcome?)` so there is still exactly
   one write.
4. **Structural contradiction had to be a field, not a heuristic.** `task_status_update`
   payloads carry only `summary` / `content` / `taskId` — the status itself lives
   in prose. Inferring "was cancelled" from text is R3, so `DeliveryEnvelope`
   gained two optional fields (`supersedes`, `invalidatesPremise`), additive and
   defaulted: an envelope that does not set them behaves exactly as before.
   `payload.extra` was rejected for this: the registry already documents that
   routing must not read it, and a second "structure lives in extra" convention
   is how the previous cutter's R1s started.
5. **`defer` is not a delta decision.** The card's table lists it; at this layer
   it is unreachable by construction — "belongs to something else" is answered by
   the entity filter before the module runs. Producing a `defer` here would be a
   second place answering "is this mine".
6. **The watermark is turn state, not a per-call constant** (self-review, second
   round). The first version took `mailbox.currentSeq()` once per tool loop and
   passed it into `injectTurnDelta()` — a snapshot nothing ever advanced. A fact
   that arrived mid-turn was therefore re-injected at *every* later yield point in
   the same turn: two `[LIVE UPDATE]` segments carrying the same item, context
   growing with zero new information. The red test is behavioural (a two-tool-round
   turn with one fact; the fact label must appear exactly once) and it was proven
   red by temporarily disabling the advance (`expected 2 to be 1`). The fix puts
   the cursor next to the turn identity it belongs to (`turnDeltaCursor`, reset in
   `onFocusChanged` where `currentTurnWorkUnitRef` is set, advanced only inside
   `injectTurnDelta`), and the four call sites lose their private snapshots. This
   is the same R2 the card is about: a cursor that four call sites each own is a
   fact with four writers.
7. **Counting the header is not counting the fact.** The first version of the new
   test counted `[LIVE UPDATE @seq=` occurrences — but the *empty* segment carries
   the same header (`count: 0` + `none`, criterion 4), so the assertion was red
   against correct code. Counting the fact label instead makes the assertion mean
   what it says, and the empty segment is then asserted separately (`count: 0`).


## 8. Boundaries

- No new table, no migration: `agent_decisions` already exists.
- C8-A's territory (`TRIAGE_STALE_DROP_TYPES`, `resolveEntityKeys`,
  `a2a_message.affinity`) untouched.
- `mailbox_items.work_unit_ref` keeps its one writer (`linkMailboxItem`).
- The injected message is a plain session `user` message at the tail: nothing in
  the system prompt, nothing in existing message bytes.
- Envelope additions (`supersedes`, `invalidatesPremise`) are optional and
  additive; a producer that does not set them behaves exactly as before.
