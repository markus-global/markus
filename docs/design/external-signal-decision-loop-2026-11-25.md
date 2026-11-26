# Unclaimed addresses: one decision per address

Date 2026-11-25 · CTO · scope: inbound external signals, address lifecycle, decision loop

Owner directive: an external signal with no route must enter the decision loop; the loop
establishes the route; later signals route directly; if it still cannot route, it enters the
loop again. The loop must be told, in the system prompt, how to handle external events.

## 1. What the code does today

| Mechanism | Where | Behaviour |
|---|---|---|
| Source registration gate | `org-manager/src/external-source-service.ts:159-165` | `registerSource` refuses unless the address is actively bound **to the caller** (`address_not_bound_to_you`). A source cannot be created without a route. |
| Address revocation | `storage/src/sqlite-storage.ts:6637-6650` | `revoke()` writes `channel_bindings.revoked_at` and records one transition. It does **not** touch `external_sources`, so an enabled source keeps polling an address that no longer has an owner. |
| Delivery resolution | `shared/src/mail.ts` resolver + `core/src/mailbox.ts:1196-1240` | Reads only the envelope. No active binding ⇒ `bounced(no_active_target)` → `catch_all`, with `bounceTarget = catchAllTargetOf(agentId)` (`shared/src/mail.ts:262`). The signal keeps its `work_unit_ref`. |
| Catch-all semantics | `core/src/mailbox.ts:351-352` | `catch_all` means «collected into the overview, **waiting to be claimed**»; the transition `catch_all → queued` exists. Only a human exercises it — the attention loop dequeues `queued` rows only, so a catch-all row is never worked on. |
| Decision loop | `core/src/session-target.ts:11` (`LOOP_SESSION_PREFIX`), `#464` | Every agent already has one persistent decision loop, `loop_<agentId>`. |
| External-signal turn bootstrap | `core/src/agent.ts:3839` | Logs `Turn has NO session identity … sourceType=external_signal` and keeps whatever session the agent last used. |
| System prompt | `core/src/context-engine.ts#buildSystemPrompt` | No segment describes external events or address ownership. |
| Self-binding tool | `core/src/tools/address-tools.ts:55` `bind_address` | Already available to agents; binding is per-address and idempotent. |

Measured on the live instance (`:8056`, 2026-11-25 13:17–13:20Z): a signal delivered to a running
agent produced a mailbox row that reached `completed`, while its `work_units` row stayed `idle`
(`claimed_by=NULL`, `used=0`), `facts` did not change, and no `agent_activities` row was written.
A stopped recipient accumulated 27 `queued` external signals with no expiry and no drop path.

## 2. Root cause of the measured failure

The probe's readings all follow from one line of static configuration:

```
shared/src/types/mailbox.ts:273
  external_signal: { signalClass: 'record', policy: { invokesLLM: false, … } }
shared/src/types/mailbox.ts:366-383  routeMailboxItem()
  invokesLLM: p.invokesLLM      ← a per-sourceType constant; intent and state are not read
core/src/attention.ts:58  detectAbnormalCompletion()
  if (!routeMailboxItem(item).invokesLLM) return undefined   ← silent completion is exempted
```

An external signal is registered as a **record** (「留痕类」), so the platform states it does not
owe an LLM turn, and the abnormal-completion detector explicitly declines to judge it. Every
reading follows: `execution_stream_logs` = 0 and `agent_activities` = 0 for the recipient in
13:17–13:21Z (no model call happened), `agent_decisions` holds only `pick` with `outcome=NULL`,
the `work_units` row stays `idle`, and the mailbox row reaches `completed` within a millisecond.

This contradicts the master plan §4.2, which places external signals in the A class
(「欠一个 LLM 回合」). The plan's intent-driven routing was never applied to this axis: whether a
signal owes a turn is still a constant keyed by `sourceType`.

**Nothing else can compensate for it.** Moving a row to `queued`, claiming a work unit, or adding
a prompt segment all sit downstream of a table that says «no turn». The classification is the
gate, so it is fixed first.

### 2.1 Why the cut looked complete — plan-level root cause (asked by Owner 2026-11-25 23:15)

Measured, not recalled. Four findings, in decreasing order of blame:

**F1 — the premise «requirement and tasks are all complete» is false.**
`req_17cbe3184017dd8646e8752b` (C10 second half) is `in_progress`. Of its seven cards, five are
completed (0G, A, B, B2, C), one is in review (0G replacement), and the card that covers exactly
this gap — «无人认领的地址：一次决策（按地址）+ 源不得比路由活得久» — is **rejected**. The board was
honest; «five plumbing cards green» was read as «the cut is green».

**F2 — the master plan did NOT omit the scope.** `c10-external-adapters-plan-2026-11-19.md:337`
names L5 the cut's final gate, and L5 explicitly includes «receives the first real signal **and
proposes the next step**». The decision loop was always in scope.

**F3 — the final gate has no enforcement point (a real plan defect).** §3.1 defines two
verification layers, seven commands: typecheck, lint, architecture-guard, identity-audit
`--self-test`, test:json, test:web-ui, test:skipped-audit. **All static or unit-level; L5 is not
among them.** The card summary adds: «Cut-level acceptance and the final integration PR are the
reviewer's job, **not a separate card**.» So no card owned L5 and no command enforced it. A gate
that exists only as prose is the same defect class as the ceiling in B1: contract declared,
enforcement point absent.

**F4 — the acceptance criterion is written at the outcome layer, not the structural layer.**
L5 says «proposes the next step» but never states the structural precondition «the signal must
owe an LLM turn». When the outcome fails to appear, that wording permits attributing it to the
environment. And that is what happened: `docs/records/c10-l5-live-verification-2026-11-25.md`
records 4/5 proven and attributes the 5th to «the owner having stopped every content agent,
**not by the code**». That attribution was incomplete — B1 proves every external signal was
forced to `intent='deliver'` / `invokesLLM=false`, so **no turn would have happened even with a
running agent**. Two independent blockers existed; only the one pointing away from the code was
recorded. This violates our own rule: treat an anomalous reading as a bug first, not as an
environment/test-expiry problem.

**F5 — one genuine planning blind spot: B and C reasoned about L5 in a circle.** The plan says
«B2/C strengthen it». But C10-C's doc states «external_signal records are already demand-capped
by B; capping patrol on them again would break the L5 observe→propose flow. They do NOT feed C's
ceiling.» B capped the signal, so C declined to cap it — and neither card verified the signal
could still reach a decision. The assumption «B2/C strengthen L5» was never tested; B broke it.

**Scope consequence (changes what «finishing» means).** L5's scenario is «give a content agent a
resource it has never owned», where the agent **binds the address itself** — so the address IS
claimed. M2/M4 precondition on «resolvable address, **no active binding**», i.e. they address a
different scenario (unclaimed addresses) and are **not** what L5 needs. L5's 5th condition needs
A (landed) plus one running agent. M3 (turn claims its work unit) and M5 (resident prompt segment)
are correctness/legibility mechanisms that serve both scenarios.

### 2.2 Live verification after the rebuild — the turn has no body (2026-11-25 23:2x)

Three independent probes on the rebuilt instance (pid 13242, `app.asar` 23:25, symbols
`unverifiedExternal` ×7 / `deliverAsOperator` ×2). Bound a fresh address, registered a webhook
source, posted real signals through the **public** external entry.

**A is proven live.** The log shows `Trigger matched — waking for the real event` with the
signal's itemId, and the row persists `intent=action_required`. Under the pre-A build
`external_signal` was `invokesLLM=false` and could never wake an agent. The L5 precondition now
holds on the real instance.

**But the chain fails 3/3, including the probe delivered while the agent was idle** — so agent
occupancy is ruled out. Every probe runs the same chain inside 1–2 ms (no LLM call happens):

```
Turn has NO session identity (warning only)
Abnormal completion: empty reply from LLM-invoking item   retry 1, retry 2
Abnormal completion persisted after max retries — marking dropped
bounced → catch_all, drop_reason=stale_signal, reason=unspecified
```

**ROOT CAUSE (corrected 23:4x — an earlier reading named the wrong function).**
`grep external_signal packages/core/src/agent.ts` returns **zero hits**. There are TWO switches
on `item.sourceType`, and their defaults are opposite:

| site | span | default | effect for `external_signal` |
|---|---|---|---|
| `processMailboxItemCore` — the real dispatcher | 2828–3617, switch 2930–3590 | **none** | falls through, returns `undefined` — no LLM call, no decision, no fact |
| `buildActivityOutcome` — activity-log label only | 3621+ | `return 'processed'` | injects a **success-looking** label into the session |

That is the whole contradiction resolved: the dispatcher produces NOTHING (`undefined` ⇒
`detectAbnormalCompletion` ⇒ «empty reply» ⇒ retries ⇒ drop), while the `finally` block calls
`buildActivityOutcome`, whose default fabricates `'processed'` — which is exactly the
`→ processed` ×3 in the agent's own activity feed. **The agent's narrative said it succeeded;
the code did nothing.** No «two consumers racing» hypothesis is needed; that earlier guess is
withdrawn.

**The first-principles defect: one fact, three declarations, and the totality is asymmetric.**
«This signal owes a turn» and «what that turn does» live in different places:

| declaration | type | total? |
|---|---|---|
| `MAILBOX_TYPE_REGISTRY` (routing policy) | `Record<MailboxItemType, …>` | **total** — every type must declare |
| `MAILBOX_TYPE_SCENARIO` (turn shape) | **`Partial`**`<Record<…>>` | partial — omission allowed |
| dispatcher `switch` (turn body) | hand-written, no default | partial — omission allowed |

The routing side is total; the execution side is partial. A made routing total for external
signals (they now owe a turn) while execution stayed partial — so the owed turn has no body.

**The existing guard is one-directional.** `mailbox-scenario.ts` states «every entry must be
justified by the dispatch case that consumes it», and `mailbox-scenario.test.ts` pins table→case.
It never checks the reverse: **every type that owes a turn must have a body**. So «declared but
not implemented» is guarded, while «owes a turn but not implemented» — the actual defect — is not.

**Three further defects confirmed on the live readings:**

1. **Retry has no backoff.** Three attempts burn inside 2 ms. Whatever made the reply empty is
   still true 1 ms later, so this retry cannot structurally succeed — it only converts a failure
   into a fast drop.
2. **The default reason bucket hides the real cause.** The row records
   `drop_reason=stale_signal` / `reason=unspecified`; the real cause is «empty reply, retries
   exhausted». `mailbox.ts`'s own comment says «默认值不是万能桶». Cost paid: three rounds of
   investigating TTL and triage purges before the log revealed the truth.
3. **The bounce event mislabels the type**: `type:"system_event"` while the item is
   `external_signal` (the preceding log line has it right).

**Open, not yet proven:** the delegate returns `'processed'` (Cognitive Context shows
`→ processed` ×3), yet attention judged the reply empty, and the drop found the row «not in
queue, fromStatus=processing». That points at two consumers racing on one item under concurrency
(5 workers), with attention seeing `undefined`. Labelled hypothesis — the double-consumption
mechanism is not yet traced.

**Consequence for the plan:** M3/M5 are not optional polish — a turn body for `external_signal`
is a **precondition** for this chain to work at all. And it must be built before M2/M4, otherwise
the decision machinery would be built on a turn that produces nothing.

### 2.3 First-principles solution (Owner asked 2026-11-25 23:40)

The governing rule: **one fact, one writer; one invariant, one enforcement point.** Today
«this signal owes a turn» is declared in three places with asymmetric totality (§2.2). Asking
«does this mechanism need to exist?» — three declarations of one fact do not. The fix is to
collapse them, not to add a fourth guard.

**RESOLVED WITH ONE CHANGE (Owner rejected the six-step plan below as over-engineered —
2026-11-25 23:50, «第一性原理 + 奥卡姆剃刀»). The six steps are kept below only as the record of
what was cut and why; the shipped fix is §2.4.**

**S1 · Dispatcher exit invariant (immediate, small).** A type that owes a turn must have a body.
Add a `default` to the dispatch switch: if `routeMailboxItem(item).invokesLLM` is true and we
reached it, that is a producer bug — throw a structured error, never return `undefined`.
Types that owe no turn keep today's behaviour. Effect: this defect class turns from «silent
no-op + fake success» into immediate, attributable noise.

**S2 · The activity log must not fabricate success (immediate, small).**
`buildActivityOutcome`'s `default` returns `'processed'`. It must return `undefined` (no outcome)
for a type it does not know. The agent's own narrative is a decision surface; a fabricated
`processed` is worse than silence — it is what made this bug invisible for three probes.

**S3 · Make the existing guard bidirectional (immediate, small).** `mailbox-scenario.test.ts`
pins table→case only. Add the reverse: **every registry type whose policy can yield
`invokesLLM=true` must have a dispatch case.** That is the assertion that would have caught this.

**S4 · One source for shape and body (the structural fix).** Move `scenario` into the registry
descriptor and delete the `Partial` shape table; dispatch through a total
`Record<MailboxItemType, Handler>`. Adding a source type without a handler then fails at compile
time. This subsumes S1/S3 — the omission becomes inexpressible rather than merely detected.
Larger blast radius (15 cases), so it is its own step, not bundled with the bleeding stop.

**S5 · Failure classification and honest reasons (immediate, small).**
- Structural failure (no handler) must **not** be retried — retrying cannot fix a missing
  implementation. Transient failure (transport timeout) retries **with backoff**. Today three
  attempts burn in 2 ms, which is neither.
- Every terminal state carries its real cause. `stale_signal` is for staleness only; «empty reply,
  retries exhausted» needs its own reason. Remove the default-bucket path for LLM-invoking items.
- Fix the bounce event's `type` field (it reports `system_event` for an `external_signal`).

**S6 · The turn's body — M3 and M5 are one thing, not two.** From first principles an external
signal is «a fact about the world arrived»; the turn must answer «does this change what I should
do?». That is the agent's **existing loop turn**, not a sixteenth bespoke shape. So:
route `external_signal` into the loop session, claim its work unit (M3), and let one resident
prompt segment state the signal's semantics and the sender's authority boundary (M5).
Reusing the loop turn means no new scenario, no new tool pack, and no new session namespace.

**Sequence:** S1+S2+S3+S5 together (make failure visible and honest) → S6 (give the turn a body,
which is what makes the chain actually work) → S4 (structural closeout, own card).
M2/M4 come after S6 — decision machinery on a turn that produces nothing would be wasted.

### 2.4 The shipped fix — ONE default case (2026-11-25 23:55)

**The question that collapsed six steps into one:** does «what shape is this turn?» need to be
answered per source type at all? It does not. `buildHandleOpts` already derives it from **session
identity** — `if (isLoopSession(opts.sessionId)) opts.scenario = 'loop'`. And `targetSessionId()`
already falls back to `loopSessionId(agentId)` for an unowned signal.

So «a signal with no bespoke path» means exactly «judge, in the agent's own loop session, whether
this fact about the world changes what I should do». That is the **existing** loop turn. No new
scenario, no new tool pack, no new session namespace.

The change (`agent.ts`, dispatcher `default`):

```
default: {
  if (!needsTurnCompletion) return undefined;        // record-only: unchanged
  const sigOpts = buildHandleOpts({ scenario: 'loop', sessionId: targetSessionId(item, this.id, ts) });
  let reply = await this.handleMessage(sigContent, undefined, undefined, sigOpts);
  reply = this.acceptTurnReply(await this.ensureTurnCompleted(reply, …), item);
  resolveResponse(reply); return reply;
}
```

**Why this is a class fix, not an instance fix:** every future source type that owes a turn lands
here and gets a real body. A missing `case` can no longer mean a silent no-op.

**What the razor cut, and why each became unnecessary:**

| cut | why it is no longer needed |
|---|---|
| S1 exit invariant (throw on missing body) | nothing can lack a body any more |
| S2 activity log must not fabricate `processed` | the turn now really runs, so `processed` is **true** |
| S3 bidirectional scenario guard | guards an omission that is now harmless |
| S4 `Partial` → total `Record` refactor (15 cases) | totality of the shape table no longer carries the invariant |
| S5 retry classification / new drop reason | the structural empty reply it classified no longer occurs |
| S6 separate M3 + M5 mechanisms | the loop session **is** the identity — but see the correction below: this row was **wrong** about M3 |

**CORRECTION (2026-11-26 00:10, live evidence overturned the row above).** I claimed one default
delivered both M3 (work-unit identity) and M5 (semantics). It did not. Probe `razor-verify-0006`
ran a real turn — 7 `llm_request` rows, 7 `tool_start`/`tool_end` pairs, all attributed to its
`work_unit_ref` — while `work_units` stayed **`idle`** with `claimed_by` empty. So `work_status`
reported «nobody is working» for a turn that was actively producing output. **The ledger lied.**
`grep claim packages/core/src/agent.ts` returns zero: the dispatch path never claimed anything.

That is the *same defect class* as the missing body — a fact declared without an enforcement
point — and the razor cut it by mistake. Fixed in `4ea1b2be`, again at **one** enforcement point:

`claimItem` (`sqlite-storage.ts`) is the unique writer of «this turn started» — it writes
`status='processing'` / `started_at` / `claimed_by` / `lease_until` in one conditional update.
Winning that claim **is** the turn starting, so the ledger belongs in the same step. This covers
**every** mailbox source type, not a special case for `external_signal`. It reuses
`SqliteWorkUnitRepo` (the sole writer of `work_units`) rather than a second `UPDATE`, and follows
the chat path's existing rule: `ensure()` is a no-op on an existing row, so an `idle` row left by a
retry or re-entry must be pulled back explicitly.

`units.transition(ref,'running')` had only ever been called by the chat path
(`api-server#prepareChatTurnWorkUnit`) and the task path (`task-service`) — never by mailbox
dispatch. Record-only signals have no work unit and are untouched.

**Evidence.** New behaviour test `packages/core/test/mailbox-turn-body.test.ts` — red before the
change (`× runs a real LLM turn for an external_signal`, 10009 ms spinning to empty), green after
(`✓ 338 ms`, asserts `router.chat` was actually called, not merely that a string came back).
`npx tsc -b packages/core` clean. Regression 45/45 across mailbox routing, scenario, overhaul,
identity-guard and attention. The pre-existing `TS5097` in `packages/desktop/src/chromium-proxy.test.ts`
is untouched by this change (last modified by `6fa51374`).

**Fixture lesson worth keeping:** the first draft of the test asserted `invokesLLM === true` for a
bare `external_signal` and failed — because owing a turn is **conditional**:
`p.invokesLLM || isAuthoritativeIntent(envelope.intent)`. A fixture without an authoritative intent
tests a record-only item and proves nothing. The red was the fixture lying, not the code.

### 2.5 Live verification and two withdrawn claims (2026-11-26 10:35)

Both fixes are in the running build (asar 00:15, process started 00:17:26; symbol probes
`sigOpts`×3 and `markTurnRunning`×2 in the asar itself).

| read | before | after |
|---|---|---|
| `work_units.status` for the signal's ref | `idle` while the turn ran | **`running`** (probe `ledger-verify-0007`) |
| same row, after the turn finished | — | `idle`, `stop_reason = reconciled_terminal_mailbox` |
| mailbox row | completed in ~1 ms, no turn | `completed`, `retry_count = 0`, no `drop_reason` |

**Withdrawn claim 1 — the «7 llm_request rows prove it» evidence.** I counted rows in
`execution_stream_logs` filtered by `work_unit_ref`. That column is **not** a turn-identity key:
two *different* `activity_id`s were stamped with the same ref in the same millisecond, one of them
carrying `Started: Human Chat`. So the count could include a concurrent worker's or my own chat
turn's calls. The authoritative turn↔item key is `agent_activities.mailbox_item_id`. What still
stands for fix 1: the unit test asserts `router.chat` was actually called (no attribution layer
involved), and signal-specific reasoning text exists in the log.

**Withdrawn claim 2 — «the activity finalisation layer has no writer».** False; I read the wrong
layer. `agent_activities` is **append-only by design** (`sqlite-storage.ts:1146-1151`, C10-0E) with
a `BEFORE UPDATE` trigger that raises `ABORT`. The comment states corrections are new
`activity_end` events in `agent_activity_logs` and **the read side derives current state**. So
`ended_at` empty and `total_tokens`/`total_tools` zero in that base table are *by design*, not a
missing writer — the authoritative layer holds 226 `activity_end` rows. Likewise «stuck at
`running`» is not a defect: the reconciler settles it.

**The reusable lesson (fourth false-defect source):** before declaring «this table has no writer»,
grep the table for triggers / append-only comments and confirm it is the *final-state read surface*
at all. An append-only base table read as if it were final state manufactures a defect out of a
design decision — the mirror image of a false green.

### 2.6 The third fix — turn identity was a shared field (`81fc7cce`, 2026-11-26 10:40)

§2.5 withdrew the *use* of `work_unit_ref` as evidence but did not ask **why it was mis-stamped**.
That question has a real answer, and it is a defect: all four observability tables index
`work_unit_ref` (`idx_*_wu`), so it is *meant* to be an attribution key.

**Root cause — the same bug recurring under a different symbol.** `turnWorkUnitRef()` read ALS for
**task** turns (the 2026-11-15 P0 fix) but fell back to the shared instance field
`currentTurnWorkUnitRef` for chat / a2a / external_signal turns. That field's only writer was the
mailbox focus chain `onFocusChanged`. With five concurrent workers, a later turn overwrote an
earlier one, so turn A's observability rows carried turn B's ref. The 2026-11-15 fix moved only the
task path into ALS — the mailbox path kept the shared mutable carrier.

This is why the earlier «count rows by ref» evidence was unusable: the count silently included
another worker's calls. **A broken attribution layer poisons evidence collection, not just the UI.**

**Fix (structural, not another guard).** Mailbox turns now carry their identity in their own ALS
(`mailboxTurnContext`), established at the *same single entry* that already mounts the session
workspace — `processMailboxItemInternal`. The shared instance field **and** its write in
`onFocusChanged` are deleted, so the cross-stamping carrier no longer exists. Missing identity is
honestly `null` rather than borrowed from whoever wrote last.

**Evidence.** `turn-work-unit-identity.test.ts` runs two genuinely overlapping turns (a barrier
holds both inside `handleMessage`) against a poisoned shared field, and asserts each turn sees its
**own** ref — red before (`received 'external:src_x:SOMEONE-ELSE'`), green after. The fixture
self-checks that both turns really reached `handleMessage`, so an unreached stub cannot fake a pass
(the first draft did exactly that, and the id discriminator was wrong too — both caught before the
fix was written). `tsc -b packages/core` clean; **48/48** regression including both concurrency e2e
suites.

### 2.7 The fourth fix — the whole class closed: delta cursor was the last shared turn field (`6b0463da`, 2026-11-26 11:20)

§2.6 recorded `turnDeltaCursor` as a «known neighbouring risk». That is a promise nobody guards, so
it was closed in the same round rather than left standing.

**Same root cause, third symbol.** `turnDeltaCursor` was the last Agent instance field carrying
per-turn state. Five concurrent workers shared one number: turn A advances its watermark after
injecting deltas, so turn B's next `deltaSince` starts from **A's** watermark and B **silently skips
facts it never read**. Missing a fact is worse than repeating one — repetition is visible, omission
is not.

**Fix.** The carrier is now `SessionWorkspace.turnDeltaCursor` — the *existing* per-worker ALS, not a
new mechanism; the instance field is deleted. The reset point moved from the shared focus chain
`onFocusChanged` to the top of `processMailboxItemCore`: focus is the shared «current attention», so
B taking focus would wipe the cursor A is still using.

**Evidence.** A second case in `turn-work-unit-identity.test.ts` runs two genuinely overlapping
turns, each in its own worker workspace (the shape production uses via `getWorkerWorkspace`); A
advances by 500 and B must still read its own value. Falsified by stashing the fix: B read **501**;
with the fix, **1**. Full `packages/core` suite: **318 files / 3852 passed**; `tsc -b packages/core`
clean.

**A correction to this round's own premise.** `humanFacing` and `processingMailboxItemId` were
*already* per-turn accessors over `workspace()` — not shared fields. A draft of this change gave
them a second store inside `mailboxTurnContext`; that was reverted before commit, because one fact
may only have one writer. The lesson generalises: **before «fixing» a shared-field defect, read the
field's declaration** — an accessor and a field look identical at every call site.

## 3. Mechanism changes

### M0 · Whether a signal owes a turn is decided by its intent, not its source type

`shared/src/types/mailbox.ts#routeMailboxItem` — `invokesLLM` stops being a per-type constant and
is derived from the signal's structural `intent`, which is what master plan §4.2 already
prescribes. The registry keeps a default per type; `intent='action_required'` owes a turn
regardless of type, `intent='deliver'` does not.

Applied to this path:

- the **address decision** is a platform-generated item carrying `intent='action_required'`
  ⇒ owes a turn. The external trust ceiling does not apply to it: the ceiling caps what an
  *external sender* may demand, and this item is authored by the platform's own routing decision;
- an **echo** of an already-decided address keeps `intent='deliver'` ⇒ stays a record, no turn.

`detectAbnormalCompletion` then judges the decision item like any other turn-owning item: an
empty reply is an abnormal completion, not a silent success.

### M1 · `revoke()` cascades to the sources on that address

`storage/src/sqlite-storage.ts#revoke` — after the binding row is revoked, disable every
`external_sources` row whose `address` matches, and record the reason on each. One enforcement
point, because revoke is the only operation that can break the invariant.

Invariant afterwards: **an enabled source always has an active route.** «Registered source,
no route» becomes structurally inexpressible, so no runtime path has to handle it.

### Blocking findings during implementation (2026-11-25 23:0x)

**B1 — the ceiling conflates two different questions, and it is what actually silences the path.**
`external-source-service.ts:96` is the sole consumer of `mayExternalSignalDemandAction`:

```
const intent = mayExternalSignalDemandAction(fromVerified) ? requested : 'deliver';
```

`fromVerified` is hard-coded `false` until C10-D, so **every** external signal is forced to
`intent='deliver'`. M0 makes an action-demanding intent owe a turn, but no external signal can
ever carry one — the ceiling erases it first. Two questions are being answered by one field:

| Question | Owner of the answer |
|---|---|
| Does this event deserve a turn? | the platform (it is a fact about the event) |
| What authority does the sender have? | the sender's verified identity (`fromVerified`, plus C10-C's agent-level `maySelfInitiate`) |

Encoding authority in `intent` means «unverified» is read as «not worth looking at». The predicate's
own doc comment states the cap is deliberate, so separating them changes a documented C10-B
decision and needs an owner ruling — it is not an implementation detail.

**B2 — the unclaimed-address state has no ingress today.** `external_signal` has exactly one
enqueue point (`external-source-service.ts:113`); webhook and RSS both require a registered source,
and registration requires an active binding. With M1 landed, revoking a binding disables its
sources, so no current ingress can deliver to an address nobody claimed. Only email (C10-D) can
address an arbitrary address. **M2/M4 as written would be machinery with no input** until either
email lands or a deliberate «deliver to any address» entry point is added.

**Owner rulings (2026-11-25): B1 → option A; B2 → add the ingress now.**

B1 resolved by A (landed, commit `612e8788`). The two questions now have two owners:

| Question | Answered by | Enforcement point |
|---|---|---|
| Does this event deserve a turn? | the platform | ingest sets `intent='action_required'`; `routeMailboxItem` upgrades `invokesLLM` (M0, upgrade-only) |
| What authority does the sender have? | `fromVerified` | `Agent.selfInitiationCeiling` → port → `maySelfInitiate` (caps self-initiation); escalation to `trigger_execution` requires verified |

An unverified external origin has no agent row and no org, so it reaches the port as its own
structural flag (`unverifiedExternal`) — never as an id in `senderAgentIds`, where `findById`
would resolve it to nothing and silently grant it more trust than a known cross-org peer.

Guards re-expressed rather than deleted: identity-audit criterion 14 now bites
`trigger_execution` only (under A `action_required` means «the platform judged this worth a
turn», not «the sender may demand action» — same field, different meaning). T6 split into
T6a/T6b/T6c so the platform-origin invariant and the new external ceiling each bite alone.
Both sides falsified by reverting the source file (2 red each).

B2 resolved by option B (landed, commit `943d532f`): an **authenticated operator ingress**.
The registration gate is untouched — it guards self-service squatting, and that guard stays.
The operator delivers through a source they already own (ownership decided in the service) and
additionally names a target address. No source row is created and no address is claimed, so the
ref stays a real entity `external:<realSourceId>:<msgId>`: no pseudo source id, criterion 15 and
the single constructor both untouched.

`ingest` gains `targetAddress`, reachable **only** from the authenticated path — `receiveWebhook`
never passes it, so an external party structurally cannot redirect (rather than reading a payload
field and validating it, which would infer structure from the payload). Routing keeps one rule:
follow the destination address's binding, fall back to the source owner.

**Finding recorded rather than papered over:** delivering to an unclaimed address today yields
`no_active_target`, and the signal lands in the source owner's mailbox in `catch_all` (bounce-echo)
state with intent still `action_required`. The ingress now exists — that is B's delivery. Turning
that echo into a decision is **M2's** job; B does not quietly alter routing semantics. This is the
exact seam M2 must change, and the test asserts the current shape so M2 cannot land silently.

Consequence: M0/M1/A/B are landed and verified. M3/M5 are meaningful (a turn IS owed).
M2/M4 now have an input path and are the next mechanism to build.

### M2 · The first unclaimed signal for an address becomes a decision; the rest stay echoes

`core/src/mailbox.ts` bounce path — when the bounce reason is *unclaimed address* (resolvable
address, no active binding), the platform additionally:

1. `WorkUnit.ensure('address:<address>')` — an **entity-keyed** work unit, distinct from the
   signal's own `external:<sourceId>:<messageId>`;
2. if that work unit has **no settled decision**, transition this row `catch_all → queued`
   (the existing transition) so the attention loop picks it up;
3. otherwise leave the row in `catch_all` as an echo carrying the recorded decision reason.

No new item type, no new state, no new queue: `catch_all` already means «waiting to be claimed»,
and the claim transition already exists. What is added is the actor and the key.

Because the key is the address, N signals to one unclaimed address yield **one** decision and
N echoes. Idempotency comes from identity, not from a counter or a coalescing rule.

### M3 · The decision turn claims its work unit and runs in the existing loop

`core/src/agent.ts` turn bootstrap — an external-signal decision turn takes
`sessionKey = loop_<agentId>` (the loop that already exists) instead of falling through with no
session identity, and **claims** the `address:<address>` work unit for the duration of the turn.

A mailbox row may only reach `completed` if its work unit left `idle`. A `completed` row whose
work unit is still `idle` is a defect, and the guard asserts it.

### M4 · A decision is sticky

The address work unit's terminal state carries the outcome:

- **claimed** — the agent called `bind_address`; later signals resolve through the existing
  resolver and are delivered directly, with no decision turn;
- **declined** — terminal with a written reason; later signals bounce carrying that reason and
  start **no** turn;
- **reopened** — only by explicit human action or superseding evidence does the address become
  undecided again, which is what re-enters the loop.

Re-entry is therefore driven by new evidence, never by a timer and never once per message.

### M5 · One resident prompt segment

`core/src/context-engine.ts#buildSystemPrompt` — a segment stating authority and boundary:
an unclaimed address is a decision the agent may take; claiming means `bind_address` to itself;
an address belonging to another organisation may not be claimed; declining must leave a reason.

The segment always renders. Its header is fixed and only a trailing line varies
(`unclaimed_pending: <n>`), so the prompt prefix stays byte-identical across agents and turns.

## 4. Invariants and guards

| Invariant | Single enforcement point | Guard |
|---|---|---|
| A signal that owes a turn gets one | `routeMailboxItem` derives `invokesLLM` from `intent` (M0) | an `action_required` item with an empty reply is an abnormal completion; restore the per-type constant ⇒ red |
| An enabled source has an active route | `revoke()` cascade (M1) | revoke → source disabled; remove the cascade ⇒ red |
| «Is this address routed» has one reader | the existing resolver (`findActive`) | no read path may consult anything else to decide delivery |
| One decision per address | `WorkUnit.ensure('address:<address>')` (M2) | N signals ⇒ 1 decision work unit; key it by messageId ⇒ red |
| A completed signal was actually worked | turn claims the work unit (M3) | construct «completed row, idle work unit» ⇒ red |
| Prompt prefix is stable | fixed segment + trailing variable (M5) | two renderings share a byte-identical prefix |

## 5. Acceptance

1. An `external_signal` carrying `intent='action_required'` yields `invokesLLM=true`, and an empty
   reply from it is reported as an abnormal completion; the same type with `intent='deliver'`
   yields `invokesLLM=false`. Restoring the per-type constant turns this red.
2. Bind an address, register a source on it, revoke the address ⇒ the source is disabled with a
   reason. Removing the cascade turns this red.
3. A signal to a resolvable-but-unclaimed address produces a catch-all row that an agent turn
   actually claims (`catch_all → queued`), running in `loop_<agentId>`.
4. Twenty signals to the same unclaimed address produce exactly one `address:<address>` work
   unit, while all twenty keep their own per-message refs.
5. After a declined decision the next signal bounces with the recorded reason and starts no
   turn; after a claimed decision the next signal is delivered directly.
6. The prompt segment renders for agents with and without unclaimed mail; the stable prefix is
   byte-identical between the two renderings.
7. Live probe on a fresh build, both paths: (a) routed — real webhook to a bound address ⇒ a turn
   with `execution_stream_logs > 0`, an `agent_activities` row, and a work unit that left `idle`
   and reached a terminal state with a recorded outcome; (b) unclaimed — real webhook → decision
   turn → `bind_address` → second event delivered directly. Readings as «≥N + read time».

What the mechanism guarantees is that a turn runs, with its own session identity, on a claimed
work unit that reaches a terminal state carrying an outcome. Whether the model then writes a
`fact` is model behaviour, not a mechanism guarantee — so the gate is the recorded outcome, and
a missing fact is a prompt-quality finding rather than a broken invariant.

Each item is written red before it is made green, and falsified by removing the mechanism.

## 6. Out of scope

No schema change and no new table (owner ruling: no data migration, no table drops). No change
to the trust ceiling — an unverified external signal still cannot demand action. No email/DNS
work. No `main` merge without owner approval.

Recorded but not fixed here: `external_sources.agent_id` and `channel_bindings.agent_id` are two
writers of «who owns this». Deriving ownership from the binding and dropping the column would
remove the soil M1 guards, but it is a migration and needs its own ruling.
