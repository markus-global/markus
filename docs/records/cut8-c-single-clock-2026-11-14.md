# Cut 8-C — readings and evidence (2026-11-14)

Companion to `docs/records/cut8-c-single-clock-design-2026-11-14.md`.
Branch `task/c8-c-single-clock` → PR to `feat/refactor-plan`.

## 1. Criterion: no second periodic business clock in the agent

`grep -rn "setInterval" packages/core/src --include=*.ts` after the change, with the
disposition of every hit. The acceptance wording matters: **C8-C removes the second
*periodic business* clock — not "every `setInterval`"**. Provider/transport/terminal/UI
timers are per-operation lifecycles and stay.

| Location | Kind | Disposition |
|---|---|---|
| `packages/core/src/clock.ts:68` `AgentClock.tick` | the single periodic driver for time-driven transitions | **kept — this is the one** (design R-10.1) |
| `packages/core/src/heartbeat.ts:181` | the former second business clock | **removed from the default path**: the private `setInterval` now exists only inside the `legacy` branch, reachable solely via `MARKUS_HEARTBEAT_CLOCK=legacy`. Default (`clock`) arms **zero** timers — asserted by `vi.getTimerCount() === 0`. |
| `packages/core/src/attention.ts:498` watchdog / `:967` leaseRenew / `:997` backstop | per-item lifecycle timers (created when an item starts, cleared when it ends) | kept — not a cluster-periodic clock |
| `packages/core/src/agent.ts:6482`, `:7098`, `:10042` cancelPollTimer / wait loops | cancellation-poll / wait loops for one operation | kept — bounded by the operation |
| `packages/core/src/concurrent/task-executor.ts:199` | wait-for-completion poll | kept |
| `packages/core/src/tools/shell-session.ts:290` | command output poll | kept |
| `packages/core/src/llm/model-catalog.ts:97` | model catalogue cache refresh | kept |
| `packages/core/src/llm/oauth-manager.ts:491` | OAuth device-code poll | kept |

Readings:

* `heartbeat.ts` owns a timer **only** in `legacy` mode; `getMode()` reports which.
* In `clock` mode the heartbeat cadence is a `ClockSource` named `heartbeat`
  (`HEARTBEAT_CLOCK_SOURCE`), asserted by `heartbeat-single-clock.test.ts`
  (6 tests, incl. `vi.getTimerCount() === 0` after `start()`).
* `updateInterval()` re-registers the source instead of restarting a timer — asserted.
* `stop()` unregisters the source — asserted.

## 2. Criterion: heartbeat produces zero mailbox rows

`heartbeat-no-mailbox-row.test.ts` (3 tests):

| Mode | 3 triggers | Patrols | `heartbeat` rows |
|---|---|---|---|
| `clock` (default) | 3 | 3 | **0** |
| `legacy` (`MARKUS_HEARTBEAT_CLOCK=legacy`) | 1 | — | **1** (rollback channel intact) |

The old re-entrancy protection ("heartbeat folding" inside `Mailbox.enqueue`) was needed
only because the row path could start a second patrol right after the first finished
(7–12 s apart in production). With no row there is nothing to fold, so re-entrancy is
guarded at the single place that starts a patrol — `runHeartbeatPatrol` / `heartbeatInFlight`.
Asserted: a second trigger while a patrol is in flight is skipped, and a trigger after it
settles runs normally.

## 3. Criterion: dream triggers exactly once per schedule

`dream-single-trigger.test.ts` (4 tests):

| Tick | `dream:trigger` | `ran` | Dream LLM runs |
|---|---|---|---|
| due, window open | 1 | `true` | 1 |
| due again, same window | 1 | `false` | 0 |
| `memory_consolidation` row, `clock` mode | 0 | — | 0 (row acknowledged, no LLM turn) |
| `memory_consolidation` row, `dual` mode | 0 | — | 0 dream + 1 LLM turn (pre-C8-C behaviour) |

`ran: false` is a deliberate skip, not a miss — the event count stays 1:1 with the schedule.
The decision still has exactly one implementation (`shouldRunDreamCycle`, called only from
`consolidateMemory`), which now returns `{ ran, windowKey }` so the event reports the
decision instead of re-deriving it.

**Boundary (C8-A owns this line):** removing `memory_consolidation` from
`TRIAGE_STALE_DROP_TYPES` is *not* in this cut. That "type → disposition" table has one
writer, and the CTO assigned the removal to C8-A while it re-works the same layer. C8-C
ships the producer side only — no third opinion, no side channel that pretends the list
was changed.

## 4. Criterion: `rest(wakeOn)` wakes on the event, without polling

`trigger-subscription.test.ts` (12 tests):

* `matchesWakeCondition` — pure predicate; `mailbox-type` matches only its type,
  `mailbox-any` matches any mailbox item, non-mailbox events never match.
* `TriggerRegistry.dispatch` — synchronous match; one-shot by default; `once: false` keeps
  the subscription; another agent's events never fire it.
* **No timer per wait**: 25 live subscriptions ⇒ `vi.getTimerCount() === 0`.
* Expiry is swept, not swallowed: `sweepExpired()` returns what it dropped, and an expired
  wait can no longer match. On a live agent the sweep runs on the clock source
  `trigger-expiry` (60 s), so the process still has one periodic driver.
* Tool surface: `rest` registers exactly one subscription and answers
  `{ status: 'resting', subscriptionId, wakeOn, expiresAt, note }`; an unusable condition
  answers `{ status: 'error' }` and registers nothing; `list_waits` / `cancel_wait` are
  read/cancel paths.
* Waking: enqueueing a matching mailbox item emits `trigger:matched` exactly once; a
  non-matching item emits nothing. The listener is registered at **construction**, so a
  declared wait is never inert just because the attention loop has not started yet.

## 5. Test evidence (red → green)

Red was captured before the implementation on this branch:

* `heartbeat-single-clock.test.ts` — 5 of 6 red at the starting commit (`start()` armed a
  timer, `HEARTBEAT_CLOCK_SOURCE` did not exist).
* `heartbeat-no-mailbox-row.test.ts` — 3 of 4 red (each tick enqueued a row).
* `dream-single-trigger.test.ts` — no `dream:trigger` event existed; the row replayed.
* `trigger-subscription.test.ts` — module and tool did not exist.

Green now, together: 25/25. Related families re-run unchanged:
`heartbeat.test.ts` (14), `heartbeat-liveness.test.ts` (9),
`heartbeat-dedup-and-session-rollover.test.ts` (16), `dream-guard-durable.test.ts` (10),
`agent-clock.test.ts` (6) — 55/55.

## 6. Rollback (independent, per channel)

| Channel | Switch | Effect |
|---|---|---|
| Heartbeat clock | `MARKUS_HEARTBEAT_CLOCK=legacy` | private `setInterval` returns, heartbeat returns to the mailbox-row path |
| Dream trigger | `MARKUS_DREAM_PATH=dual` | `memory_consolidation` rows replay the dream again |

Both are read at construction/decision time and are independent: flipping one never changes
the other's behaviour, so either can be reverted alone.
