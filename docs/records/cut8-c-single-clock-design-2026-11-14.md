# Cut 8-C — Single clock: heartbeat as a liveness tick, one dream trigger, minimal Trigger/Subscription

Status: implementation note (Living for this cut). Branch `task/c8-c-single-clock`, target `feat/refactor-plan`.

## 1. Observed behaviour (before this cut)

| # | Symptom | Reading |
|---|---|---|
| 1 | An agent runs **two periodic timers**: `HeartbeatScheduler` owns its own `setInterval`, `AgentClock` owns another | `packages/core/src/heartbeat.ts:133` (`setInterval`), `packages/core/src/clock.ts:68` |
| 2 | Heartbeat is a **queue producer**: every tick becomes a `heartbeat` mailbox row, which is then processed, completed and retained | `packages/core/src/agent.ts:1135` `mailbox.enqueue('heartbeat', …)`; `heartbeat` rows dominate the completed population (~70% of `mailbox_items`, ≥165k rows) |
| 3 | Time-driven and signal-driven work share one queue, so "queueing = ageing" and queue noise are structural | same |
| 4 | The dream has **two entry links** — a clock source (`memory-consolidation`) and a mailbox item type (`memory_consolidation`) — and the mailbox type is in the age-based drop list, so the cleaning task can be silently discarded | `packages/core/src/agent.ts:1393`, `:2916`; `packages/shared/src/limits.ts:556` |
| 5 | Waiting for an external event has no primitive: an agent either polls (heartbeat) or blocks on the queue with no declared condition | no `rest(wakeOn)`, no subscription registry |

## 2. Root cause

**R2 — one invariant, two execution points.** "How much time has passed and what is due" is one
invariant. It currently has two executors (`HeartbeatScheduler.timer` and `AgentClock.timer`),
each with its own cadence arithmetic, jitter and stop semantics. Anything that wants "run every
N minutes" has to pick one of them, and picking the wrong one silently changes when the agent
wakes.

**R1 — one fact, two writers.** "Should the dream run now?" is decided in `shouldRunDreamCycle`
(one decision function, good) but *reached* through two links: the clock source and the
`memory_consolidation` mailbox row. The row link is additionally subject to age-based dropping,
so the same fact can be (a) decided twice or (b) dropped because the queue was busy.

The heartbeat row is R2 as well: a **tick** (a liveness beat, no content) is expressed as a
**message** (content plus a lifecycle row). That is a modelling error — ticks are not messages,
and giving them a row gives them retention, triage and drop semantics they never needed.

## 3. Design

### 3.1 One clock (heartbeat channel)

`AgentClock` stays the only owner of `setInterval` for time-driven transitions.
`HeartbeatScheduler` keeps its *policy* (interval, active hours, deep-sleep interval growth,
status reporting) and loses its *timer*: it becomes a clock source named `heartbeat` registered
by `Agent.start()`.

```
Agent.start()
  └─ clock.register({ name: 'heartbeat', everyMs: interval, initialDelayMs: jitter, fn: () => heartbeat.tick() })
  └─ clock.register({ name: 'memory-consolidation', … })   // dream (single trigger)
  └─ clock.register({ name: 'mailbox-maintenance', … })
  └─ clock.register({ name: 'wakeup-sweep', … })
  └─ clock.register({ name: 'trigger-expiry', … })          // subscriptions, lazy-free
```

`HeartbeatScheduler.tick()` emits one observable event and nothing else:

```
heartbeat:trigger { agentId, triggeredAt, mode: 'clock'|'legacy', producedMailboxItem: boolean }
```

Deep-sleep (`updateInterval`) re-registers the source instead of restarting a private timer, so
cadence changes still take effect immediately and still keep one timer in the process.

### 3.2 Heartbeat produces no mailbox rows

In `clock` mode the `heartbeat:trigger` listener runs the patrol **directly**
(`handleHeartbeat`) instead of `mailbox.enqueue('heartbeat')`:

* no row ⇒ no `mailbox_items` growth, no triage, no retention, no drop list membership;
* the patrol function is unchanged, so `shouldDeferHeartbeatForHumanChat`, the state
  fingerprint skip, deep-sleep and `recordHeartbeatSkip` (the liveness timestamp writer)
  keep their current semantics;
* re-entrancy is guarded by a single in-flight flag — this replaces the previous
  "heartbeat folding" in `Mailbox.enqueue`, whose only job was to stop back-to-back patrols
  that the row path could create. One guard, not two mechanisms;
* failures are contained by `AgentClock` (a throwing source is logged, never wedges the clock).

### 3.3 One dream trigger

* The named clock source `memory-consolidation` is the **only** producer of a dream. It emits
  `dream:trigger { agentId, windowKey, ran: boolean }` exactly once per due tick, so the
  event count is 1:1 with the schedule (and `ran` distinguishes "due but deduped").
* `memory_consolidation` being **removed from `TRIAGE_STALE_DROP_TYPES`** is owned by
  **C8-A**, not this cut: that "type → disposition" table has exactly one writer, and two
  people editing it would be the very `R2` this cut is fixing. C8-A implements the removal
  while it re-works the same layer (recorded on the C8-A card by the CTO). This cut
  therefore ships **only the producer side** and does not touch the list, nor adds a
  side-channel that pretends it was done.
* The `memory_consolidation` mailbox case is kept as a **drain** for rows already persisted
  before this cut, but in `clock` mode it no longer replays a dream; it acknowledges the row
  with a typed result. In `dual` mode it behaves exactly as today.

### 3.4 `Trigger / Subscription / rest(wakeOn)`

Minimal, event-driven, zero polling (`packages/core/src/trigger.ts`):

```ts
type WakeCondition =
  | { kind: 'mailbox-type'; sourceType: MailboxItemType }
  | { kind: 'mailbox-any' };

interface TriggerEvent { type: 'mailbox:new-item'; agentId: string; sourceType: MailboxItemType; itemId: string; }

matchesWakeCondition(cond, event): boolean          // pure
class TriggerRegistry {
  subscribe({ agentId, wakeOn, note, timeoutMs, once }): Subscription
  dispatch(event: TriggerEvent): Subscription[]     // pure match, no timers
  list(agentId): Subscription[]
  consume(id) / clearAgent(agentId)
  sweepExpired(now)                                 // called by the clock source, not a timer
}
```

The `rest(wakeOn)` tool registers one subscription and returns immediately; the agent ends its
turn. When a matching event arrives (`mailbox:new-item` on the agent's own bus), the registry
fires the subscription, logs `trigger:matched`, and the agent is woken through the normal
attention path. No polling loop, no timer per subscription: expiry is swept by the existing
clock source `trigger-expiry`, so the number of timers stays one.

## 4. Per-channel switches (independent rollback)

| Channel | Flag | Default | Rollback effect |
|---|---|---|---|
| Heartbeat clock | `MARKUS_HEARTBEAT_CLOCK=legacy` | `clock` | `HeartbeatScheduler` uses its old private `setInterval` and heartbeat returns to the mailbox-row path |
| Dream trigger | `MARKUS_DREAM_PATH=dual` | `clock` | `memory_consolidation` mailbox rows replay the dream again (old double link) |

The two flags are read independently; flipping one never changes the other's behaviour, so a
single channel can be reverted alone.

## 5. Test plan (red first)

| Test file | Assertion | Must be red before the change |
|---|---|---|
| `packages/core/test/heartbeat-single-clock.test.ts` | clock mode: `HeartbeatScheduler.start()` creates **no** timer (`vi.getTimerCount() === 0`), advancing fake time fires nothing, `AgentClock.tick()` fires exactly one trigger; legacy mode still arms its own timer | yes — today `start()` arms a `setInterval` |
| `packages/core/test/heartbeat-no-mailbox-row.test.ts` | N heartbeat ticks ⇒ **0** `heartbeat` mailbox enqueues, N patrols; legacy mode ⇒ N rows | yes — today each tick enqueues a row |
| `packages/core/test/dream-single-trigger.test.ts` | one due clock tick ⇒ one `dream:trigger`; a second tick in the same window ⇒ `ran: false`; a `memory_consolidation` row in clock mode does not run a second dream, and in `dual` mode it still does | yes — today there is no event and the row replays |
| `packages/core/test/trigger-subscription.test.ts` | subscription matches only its condition; dispatch fires the callback synchronously; no timer is created per subscription (timer count unchanged); expiry swept by the clock source; `rest` tool registers exactly one subscription and returns a machine-readable acknowledgement | yes — there is no such module/tool today |

Gate re-runs: every `heartbeat-*`, `dream-*`, `scheduled-*` file in the repo, plus the full
suite.

## 6. Readings to capture (evidence, §4 of the card)

1. `mailbox_items` new `heartbeat` rows in a 10-minute window after restart = **0**.
2. `grep -rn setInterval packages/*/src` whitelist — the only per-agent periodic driver is
   `packages/core/src/clock.ts`; every other hit is provider/transport/terminal/UI-scoped and
   must justify itself in the record.
3. `dream:trigger` event count vs. schedule count = 1:1.
4. `rest(wakeOn)` wake without polling — subscription callback hit, log line quoted.

Readings are recorded in `docs/records/cut8-c-single-clock-2026-11-14.md`.
