---
sidebar_position: 6
---

# Mailbox System

The mailbox is a priority-based message queue at the heart of agent-to-agent communication. Every agent owns an inbox — messages are delivered asynchronously, and the agent processes them on its own schedule, driven by a heartbeat loop. For detailed design and implementation, see [`docs/MAILBOX-SYSTEM.md`](../../../docs/MAILBOX-SYSTEM.md).

## Priority Levels

Messages have 5 priority levels (P0–P4). Higher-priority messages are always dequeued first.

| Level | Types | Purpose |
|---|---|---|
| **P0** | `human_chat` | Direct human messages — immediate attention |
| **P1** | `agent_message`, `task_update`, `system_alert` | Agent coordination and critical notifications |
| **P2** | `comms_event`, `approval_request`, `review_request` | External events and workflow requests |
| **P3** | `tool_result`, `skill_result`, `heartbeat` | Background operation results |
| **P4** | `memory_consolidation`, `observation`, `log_dump` | Maintenance and bookkeeping |

## Attention Controller State Machine

The attention controller governs **when** an agent can be interrupted. It has four states:

```
IDLE → (incoming P0 msg) → INTERRUPTED → (user responds) → FOCUSED
  ↑                                                              |
  └────────────── (task completes / times out) ←─────────────────┘
```

- **IDLE** — agent is between tasks, accepting any priority.
- **FOCUSED** — agent is actively working; only P0 (human_chat) can interrupt.
- **INTERRUPTED** — agent paused its current work for a human chat; resumes on completion.
- **BLOCKED** — agent is waiting on external input; non-critical messages are deferred.

## Interruption Handling

When a P0 message arrives during FOCUSED work:

1. The current task is suspended with a `paused` status.
2. The human chat is processed immediately.
3. After the chat resolves, the original task is restored and resumes execution.
4. If the interruption times out (> 5 minutes idle), the human chat is demoted to P3 and queued.

Lower-priority messages never interrupt — they accumulate in the mailbox and are processed in priority order during the next heartbeat cycle.

## Mailbox Processing Loop

Every heartbeat cycle (default: 1s), the agent runtime:

1. Checks mailbox for pending messages.
2. Sorts by priority (P0 first), then by arrival time (FIFO within same priority).
3. Dispatches the highest-priority message to the agent's handler.
4. If the handler completes, dequeues the next message.
5. If the handler blocks (e.g., waiting for LLM), yields control until the next heartbeat.

This design ensures humans always get a response, while background work is processed efficiently without starvation.
