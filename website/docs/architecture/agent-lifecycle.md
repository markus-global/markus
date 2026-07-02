---
sidebar_position: 3
---

# Agent Lifecycle

Every agent in the Markus system follows a deterministic lifecycle that governs when and how it executes work. This document provides a high-level overview; see [Mailbox System](/docs/MAILBOX-SYSTEM.md) and [State Machines](/docs/STATE-MACHINES.md) for detailed specifications.

## Status Lifecycle

An agent cycles through four primary states:

```
idle → focused → deciding → idle
```

- **idle** — The agent is available but not processing. It periodically checks its mailbox for new items.
- **focused** — The agent enters deep work on a single task. During this state, external interruptions are suppressed.
- **deciding** — After completing a work unit (or encountering a decision point), the agent steps back to evaluate its next action using the decision system.
- **idle** (return) — If no actionable items remain, the agent returns to idle and waits for new input.

## Mailbox System and Attention Control

Each agent has a **mailbox** — a prioritized queue that holds incoming messages, task assignments, notifications, and system events. The mailbox is the sole entry point for all work directed at an agent. Agents process mailbox items in priority order during the **deciding** phase. High-priority items (e.g., human chat, critical alerts) preempt lower-priority work automatically. The mailbox also supports **conversation grouping** so multi-turn exchanges stay coherent.

## Eight Decision Types

During the **deciding** state, the agent selects one action from eight possible decision types:

| Decision | Purpose |
|---|---|
| **pick** | Select the highest-priority item from the mailbox and begin work. |
| **continue** | Resume work on an in-progress task that has been paused. |
| **preempt** | Interrupt current work for a higher-priority item. |
| **cancel** | Abandon a task that is no longer relevant or viable. |
| **merge** | Combine two or more related items into a single work unit. |
| **defer** | Delay a mailbox item for later processing (e.g., wait for dependencies). |
| **delegate** | Forward a task to another agent better suited to handle it. |
| **drop** | Discard a stale or redundant item without processing. |

## Heartbeat Mechanism

Every agent runs a periodic **heartbeat** cycle. The heartbeat serves three purposes:

1. **Mailbox check** — Polls for new items and re-evaluates priorities.
2. **Status broadcast** — Informs the team of the agent's availability and current work.
3. **Watchdog** — Detects stalled or orphaned tasks and triggers recovery workflows.

The heartbeat frequency is configurable per agent, typically every 30–60 seconds during idle state.

## Progressive Trust System

Agents earn capabilities through a graduated trust model:

- **Probation** — Newly onboarded agents. Limited to low-risk, well-scoped tasks under close review.
- **Standard** — Default level after completing probation. Full task execution, can use all decision types.
- **Trusted** — Agents that have demonstrated consistent reliability. Can self-review certain deliverables and make autonomous delegation decisions.
- **Senior** — Highest trust tier. Eligible for mentoring, escalation handling, and cross-team coordination.

Trust level is evaluated automatically based on task completion rate, quality scores, and review outcomes.

## Further Reading

- [Mailbox System](/docs/MAILBOX-SYSTEM.md) — Detailed mailbox architecture, priority rules, and conversation grouping.
- [State Machines](/docs/STATE-MACHINES.md) — Formal state machine definitions, transition guards, and error handling.
