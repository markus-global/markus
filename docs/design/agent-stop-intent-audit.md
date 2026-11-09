# Agent lifecycle: stop means stop

Status: implemented on `feat/ui-optimize-1109` (merged from `fix/agent-stop-intent`).
Owner rule (2026-11-08): **after an agent is stopped, it must not start again on its own —
only a human can start it, or the agent's own pending approval/question being answered.**
Corollary from the same review: **only two verbs exist — start and stop** — at two
scopes only: one agent, or one whole team. There is no pause, freeze or resume.

---

## 1. The two-verb rule

| Scope | Actions | Meaning |
|---|---|---|
| One agent | start / stop | Stop is sticky: only a human start revives it. |
| Whole team | start / stop | Start = start **every** member, stop = stop every member. |

A human action may overturn the human's own earlier decision: "start team" starts
members that had been stopped individually. Only **agent-initiated** paths are blocked
by a stop. That distinction is the whole point of the design below.

There is no global "pause all / resume all". It existed as HTTP routes, client methods,
a sidebar menu entry, WebSocket events, `isGlobalStopped()`/`globalPaused` and i18n keys;
it was removed end to end, because a third pair of verbs describing a temporary
system-wide freeze is not something a user can see or reason about. "Stop" is stop;
its opposite is "start".

---

## 2. What was actually broken

Stopping an agent was implemented correctly: `Agent.stop()` clears the attention loop,
heartbeat, `schedule_wakeup` sweep, memory-consolidation timers and notebook timers, and
sets status to `offline`; `AgentManager.stopAgent()` then persists the human intent to
`agents.disabled`.

The defect was in **who reads that intent**. "Stopped by the human" had two writers:

* runtime `status === 'offline'` — which also covers *crashed* and *never started*;
* persisted `agents.disabled` — written only when a human presses stop.

Twelve code paths could start an agent; **eleven keyed off "is it offline"** and only the
boot path read `disabled`. So "the human turned it off" and "it never came up" were
indistinguishable in code, and three of those paths were reachable **by an agent**:

1. `agent_send_message` with `wake_recipient: true` → `wakeAgent` → `startAgent`
   (any agent could restart an agent the human had just stopped);
2. the `agent_start` tool (a manager agent could start a stopped team member);
3. bulk actions ("start team", the since-removed "resume all") restarted everything and
   then wrote `disabled = 0` — permanently erasing the human's decision, with no notice.

---

## 3. Root cause, stated once

Not "a few missing `if`s":

* **R1 — one fact, two writers.** "Is this agent stopped by the human?" was answerable
  from two places with different meanings.
* **R2 — no single enforcement point.** The invariant was expected to be remembered by
  twelve call sites; one of them remembered it.
* **R3 — an unarbitrated design conflict.** `wake_recipient` and `agent_start` exist
  deliberately, to avoid a message rotting in a stopped agent's mailbox. That goal is
  legitimate; achieving it by silently overriding the human is not.

---

## 4. The fix

### 4.1 One gate, with a named cause

`packages/core/src/agent-start-cause.ts` (new, pure, dependency-free):

```ts
export type StartCause =
  | 'human' | 'boot' | 'creation'      // a human, or the platform creating an agent
  | 'agent-a2a' | 'agent-tool'         // agent-initiated
  | 'unattributed';                    // caller declared nothing

export function decideStart(input: {
  cause: StartCause;
  stoppedByHuman: boolean;             // agents.disabled, NOT runtime liveness
  force?: boolean;
}): StartDecision;
```

`AgentManager.startAgent()` is the only enforcement point. It consults the human-stop
intent (not `offline`), and refusal throws `AgentStoppedByHumanError`, which carries
`code`, `agentId`, `cause` and an actionable hint (`ask the human with
request_user_input`). A bare failure would only invite the agent to retry the same
blocked path.

**Fail-closed by default.** A caller that declares no cause is treated as `unattributed`
and **cannot** start a human-stopped agent. A future start path therefore cannot
silently override the human even if its author forgets to think about it.

### 4.2 Contract

| Target state | `human` (incl. start-whole-team) | `boot` | `creation` | `agent-a2a` | `agent-tool` | `unattributed` |
|---|---|---|---|---|---|---|
| `disabled = 1` (stopped by a human) | ✅ | ⛔ | ✅ | ⛔ | ⛔ | ⛔ |
| `disabled = 0`, offline (crashed / never started) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Read it as one sentence: **an agent may resurrect a broken agent; it may not switch on
an agent the human switched off.** `boot` is deliberately *not* allowed to start a
human-stopped agent — the boot path filters by `disabled` itself, and if that filter is
ever removed the gate fails loudly instead of overriding the human quietly.

### 4.3 Kept capabilities, now gated

Per the owner's decision (option 1: gate, do not delete):

* `agent_send_message(wake_recipient: true)` still wakes a **crashed** agent; for a
  human-stopped one it returns `status: 'stopped_by_human'`, keeps the message queued and
  tells the sender to ask the human. The dead-letter problem is solved by *visibility*
  instead of by overriding the human.
* The `agent_start` tool behaves the same way and returns the same hint.

### 4.4 Human surfaces

* `stopAgent()` records the intent (memory set + `agents.disabled`) — this is what every
  gate reads.
* A human chat message addressed to a stopped agent is **not** silently queued: the
  endpoint returns `agentStopped: true` plus a notice, and the UI renders it.
* Stopping is confirmed as a one-way action in all three places it is reachable (team
  sidebar, team detail, agent profile), and the copy states what revives it: you, or
  answering its own approval/question.
* `startTeamAgents()` passes `cause: 'human'` — starting a team starts every member.

---

## 5. What was deleted

Removing a concept means removing all of it; a half-removed concept is worse than none.

| Removed | Where |
|---|---|
| `POST /api/system/pause-all`, `/api/system/resume-all` | `org-manager/src/api-server.ts` (+ route registry) |
| `governance.pauseAll` / `resumeAll`, `agents.pause` / `resume`, `teams.pauseAll` / `resumeAll` | `web-ui/src/api.ts` |
| sidebar "stop all / resume all" menu entry, its state, WS listeners | `ChatTeamSidebar.tsx` |
| `isGlobalStopped()`, `globalPaused` in `/api/system/status` | `core/src/agent-manager.ts`, `api-server.ts` |
| `system:pause-all` / `system:resume-all` WS forwarders | `cli/src/commands/start.ts` |
| i18n keys for pause/resume/freeze (zh-CN, en, es) | `locales/*/team.json`, `agent.json` |

`emergencyStop()` stays: it is a different thing (halt everything now, including
in-flight turns), it is not a pause, and it does not write the human-stop intent.

---

## 6. Tests

* `packages/core/test/agent-start-cause.test.ts` — table-driven over **all** causes ×
  {human-stopped, crashed}. Pins both directions: agent paths are denied for a
  human-stopped agent, and are still allowed for a crashed one (so the self-healing
  capability cannot be "over-corrected" away by a later refactor that only remembers the
  deny half). Also asserts the error carries an actionable hint.
* `agent-manager-core.test.ts` — bulk start starts every member, including one stopped
  individually, and clears the intent; `emergencyStop` leaves every agent offline.
* `api-server.test.ts` — 404 guards for the removed endpoints, and for
  `/api/agents/:id/pause` / `/resume`, so they cannot creep back.
* Locale parity keeps the three languages key-for-key identical after the removals.

Verification at merge time: core 3470 passed / 10 skipped, api-server 294 passed,
web-ui 1383 passed / 3 skipped, `tsc` clean for core + org-manager + web-ui.

---

## 7. Deliberate behaviour changes

1. **`pause-all` no longer persists a stop.** It was a system-level freeze with a
   resume-all inverse; both are gone. Emergency stop remains, and it is runtime-only.
2. **Starting a team starts every member**, including members stopped individually
   (the owner's explicit rule). Previously those were skipped.
3. **A per-agent stop is sticky against agents**, not against the human: no A2A wake,
   no `agent_start`, no background scheduler fire will revive it.

---

## 8. Notes for the next change

* Never answer "may I start this agent?" from `status === 'offline'`. `offline` merges
  crashed, never-started and human-stopped; use `decideStart` and pass a real `cause`.
* Never add a verb that is a synonym of an existing one. If a proposed feature needs
  "pause", check first whether it is just "stop" with a different name — the last such
  pair cost a route, a client method, a menu entry, a WS event and nine i18n keys.
