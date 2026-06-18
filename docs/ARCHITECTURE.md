# Markus -- Technical Architecture

> Last updated: 2026-04

---

## 1. Overview

Markus is an **AI Digital Workforce Platform** that lets organizations hire, manage, and coordinate multiple AI Agents that work proactively like real employees. The platform provides a full governance framework including project management, task approval, workspace isolation, formal delivery review, knowledge sharing, and periodic reporting.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web UI (React)                            │
│  Chat · Agents · Tasks · Team · Dashboard · Settings            │
│  Governance · Projects · Knowledge · Reports                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP + WebSocket
┌──────────────────────────▼──────────────────────────────────────┐
│                    API Server (Node.js)                           │
│  REST API · WebSocket · Auth (JWT) · Static file serve          │
└──┬──────────┬──────────┬──────────┬──────────┬─────────────────┘
   │          │          │          │          │
┌──▼────┐ ┌──▼─────┐ ┌──▼──────┐ ┌▼───────┐ ┌▼────────────────┐
│OrgSvc │ │TaskSvc │ │AgentMgr │ │Project │ │Governance Layer │
│Org    │ │Tasks   │ │Agent    │ │Service │ │Report·Deliver   │
│Mgmt   │ │+ Approve│ │Lifecycle│ │Reqs    │ │Trust·Archive    │
└──┬────┘ └──┬─────┘ └──┬──────┘ └┬───────┘ └┬────────────────┘
   │         │          │         │           │
┌──▼─────────▼──────────▼─────────▼───────────▼───────────────┐
│                Agent Runtime (@markus/core)                   │
│  Agent · Mailbox · AttentionController · ContextEngine        │
│  CognitivePreparation · LLMRouter · Memory                    │
│  HeartbeatScheduler · Tools · MCP Client · ReviewService      │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────▼──────────────┐
              │      SQLite (node:sqlite)  │
              │  tasks · projects · reqs   │
              │  deliverables · reports    │
              │  users · chat · audit_logs │
              └───────────────────────────┘
```

---

## 2. Package Structure

```
packages/
├── shared/       # Shared types, constants, utils (governance/project/knowledge types)
├── core/         # Agent runtime (core engine) + ReviewService
├── storage/      # SQLite persistence + Repository layer
├── org-manager/  # Org management + REST API + governance (Project/Report/Knowledge/Trust)
├── comms/        # Communication adapters (Feishu, etc.)
├── a2a/          # Agent-to-Agent protocol types + DelegationManager (A2ABus retired)
├── gui/          # GUI automation (VNC + OmniParser)
├── web-ui/       # Web admin UI (governance/project/knowledge/report pages)
└── cli/          # CLI entry point + service assembly
```

---

## 3. Core Concepts

### 3.1 Agent (Digital Employee)

Each Agent consists of:

| Component | Description |
|-----------|-------------|
| `ROLE.md` | Role definition and system prompt |
| `SHARED.md` | Shared behavior norms for all Agents (governance, knowledge, delivery, etc.) |
| `SKILLS.md` | Skill list (tool permissions) |
| `HEARTBEAT.md` | Scheduled proactive tasks (e.g. daily issue checks) |
| `POLICIES.md` | Behavior rules and boundaries |
| `MEMORY.md` | Long-term memory (Agent-maintained) |
| `CONTEXT.md` | Organization context (shared knowledge base) |

The runtime also supports **spawning lightweight LLM subagents** (`spawn_subagent` / `spawn_subagents`) for delegated subtasks. Subagent limits (parallelism, retry policy, preview truncation) are centralized in `packages/shared/src/limits.ts` rather than hardcoded. The parent agent has a **configurable tool-use iteration limit** (`AgentOptions.maxToolIterations`, system settings; default 200, range 1–10000) on chat-style harnesses — task execution and subagent loops remain uncapped by default.

**Agent role types:**
- `worker` -- Regular digital employee, executes tasks
- `manager` -- Org leader, handles task routing, team coordination, reporting

**Agent trust levels (Progressive Trust):**

| Level | Condition | Permissions |
|-------|-----------|-------------|
| `probation` | New Agent or score < 40 | All tasks require human approval |
| `standard` | score >= 40, >= 5 deliveries | Routine tasks auto-approved |
| `trusted` | score >= 60, >= 15 deliveries | Higher autonomy, can review others |
| `senior` | score >= 80, >= 25 deliveries | Highest autonomy, key reviewer |

### 3.2 Mailbox & Attention (Single-Threaded Cognition)

Each agent has a **single-threaded attention model** — it processes one item at a time. **Every LLM invocation** flows through a per-agent **Mailbox** (priority queue), and an **AttentionController** manages which item the agent focuses on.

Key components:
- **AgentMailbox** — Priority queue accepting 13 item types: `human_chat`, `a2a_message`, `task_status_update`, `task_comment`, `requirement_comment`, `mention`, `review_request`, `requirement_update`, `session_reply`, `daily_report`, `heartbeat`, `memory_consolidation`, `system_event`
- **AttentionController** — Event-driven focus loop; reacts to new mail with interrupt signals
- **Yield Points** — Safe checkpoints in the tool loop where the agent can pause to evaluate interrupts
- **Decision Engine** — Produces decisions: `continue`, `preempt`, `cancel`, `merge`, `defer`, `drop`. Heuristic rules handle clear cases (e.g., user chat always preempts); an **LLM interrupt judge** handles ambiguous cases with semantic understanding (e.g., "stop publishing" → cancel, "hold off for now" → preempt)
- **Preempt vs Cancel** — `preempt` pauses current work (item deferred, session preserved for later resumption); `cancel` permanently stops current work (item dropped, will NOT be resumed)
- **Deferred Item Auto-Resume** — Items deferred by preemption or explicit deferral are automatically resurfaced when the agent is idle (`resurfaceDue()`)
- **Triage with Read-Only Tools** — When multiple items compete for attention, the triage LLM can invoke a curated set of read-only tools (`task_list`, `task_get`, `requirement_list`, etc.) to gather context before deciding priority

Agents now have tools to actively manage their mailbox queue and working memory:

- `check_mailbox` (read-only inspection, all scenarios)
- `defer_mailbox_item` / `drop_mailbox_item` (queue management)
- `update_working_memory` / `clear_working_memory` (cognition management)

This shifts from system-driven to agent-driven cognition. The deliberation threshold is lowered to 2 items, making agent-driven triage the norm.

External callers use the mailbox API exclusively:
- `agent.sendMessage()` — Awaitable chat/notification
- `agent.sendMessageStream()` — Streaming chat (SSE)
- `agent.sendTaskExecution()` — Task execution via `task_status_update` (fire-and-forget)
- `agent.sendSessionReply()` — Post-task session reply
- `agent.enqueueToMailbox()` — Fire-and-forget notification

Internal processes (heartbeat, daily report, memory consolidation) also enqueue to the mailbox, ensuring **no LLM call bypasses the attention controller**. The mailbox timeline (items + decisions) forms the agent's **episodic memory ground truth**.

**Task status notifications** (`task_status_update` with `invokesLLM: false`) are **informational only** — the side-effect system in `updateTaskStatus()` handles all real actions automatically (execution start/cancel, reviewer notification, dependency unblocking). These notifications exist as episodic memory and triage decision context, not as work items requiring agent processing.

See [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) for the complete design.

### 3.2.1 Cognitive Preparation Pipeline

Before the main LLM call, agents run a multi-phase **Cognitive Preparation Pipeline** that curates context based on the agent's persona and current state. This is grounded in cognitive psychology (Kahneman's Dual Process Theory, Baddeley's Working Memory) and ensures that different agents in different states prepare different context for the same stimulus.

```
Stimulus → Triage (what to focus on)
         → Cognitive Preparation (how to prepare):
            Phase 1: Appraisal  — persona-aware LLM: "What context do I need?"
            Phase 2: Retrieval  — directed search against indexed stores
            Phase 3: Reflection — persona-aware LLM: "What does this mean for me?"
            Phase 4: Assembly   — merge stable + prepared context
         → Main LLM Call (with rich, curated context)
```

The **Appraisal** phase reads from the agent's explicit working memory (`workingMemory`), not only persona and transient runtime state.

Four cognitive depth levels control how much preparation happens:
- **D0 Reflexive**: No preparation (heartbeat OK, acks)
- **D1 Reactive**: Appraisal only (most chats, A2A)
- **D2 Deliberative**: Full preparation (task execution, complex questions)
- **D3 Meta-cognitive**: Full + post-response evaluation (high-stakes decisions)

Key components:
- **CognitivePreparation** (`packages/core/src/cognitive.ts`) — Orchestrates the 4-phase pipeline
- **AppraisalPromptBuilder** — Builds persona-aware prompts using role description + agent state
- **ReflectionPromptBuilder** — Builds prompts that interpret retrieved context from the agent's perspective

See [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md) for the full design with theoretical foundations.

### 3.3 Organization Structure

```
Organization (Org)
 ├── Teams -- Working groups of Agents and humans with shared goals
 │    ├── Manager -- Approves work, sets direction
 │    └── Members -- Agents and humans executing tasks
 ├── Projects -- Scopes with repos and governance rules
 │    ├── Requirements -- User-authorized work items
 │    │    └── Tasks -> Subtasks -- Atomic work units
 │    ├── Knowledge Base -- Shared knowledge (ADRs, conventions, gotchas, etc.)
 │    └── Governance Policy -- Approval rules, task caps
 └── Reports -- Periodic reports + plan approval + human feedback
```

**Relationship model:**
- A Team can participate in multiple Projects; a Project can be worked on by multiple Teams
- Each Task belongs to one Project and traces to a Requirement
- Each Project can link multiple code repositories

### 3.4 Memory and Knowledge System

**Agent memory (four layers, based on Tulving's classification plus explicit working memory):**

| Layer | Storage | Role |
|-------|---------|------|
| **Procedural** | `role/ROLE.md` + skills | How the agent operates. Identity, behavioral rules. |
| **Semantic** | `MEMORY.md` + `memories.json` | What the agent knows. Agent-organized knowledge. |
| **Episodic** | `sessions/*.json` (current) + SQLite `agent_activities` (past) | What happened. Current conversation + searchable activity history. |
| **Working Memory** | `workingMemory` Map | Volatile, agent-managed, keyed entries (update/clear via tools). Replaces the former system-only `currentCognition`. |

The agent retrieves past episodes via the `recall_activity` tool (keyword search on summary/keywords). Daily logs (`daily-logs/`) are a write-only audit trail for humans — never read back into prompts.

See [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md) for the complete architecture.

**Project knowledge base (three scopes):**

| Scope | Description | Tools |
|-------|-------------|-------|
| `personal` | Agent personal memory | `memory_save` / `memory_search` |
| `project` | Project-level shared knowledge | `knowledge_contribute` / `knowledge_search` |
| `org` | Org-level shared knowledge | `knowledge_search` (scope=org) |

Knowledge categories: `architecture`, `convention`, `api`, `decision`, `gotcha`, `troubleshooting`, `dependency`, `process`, `reference`

### 3.5 Tool System

**Built-in tools (all Agents have by default):**

| Tool | Description |
|------|-------------|
| `shell_execute` | Run shell commands (auto-injects Agent identity into git commit) |
| `file_read` / `file_write` / `file_edit` | File read/write/edit (writes blocked only to other agents' directories) |
| `file_list` | List directory contents |
| `web_fetch` / `web_search` | HTTP requests / web search |
| `spawn_subagent` / `spawn_subagents` | Spawn lightweight LLM subagents for focused subtasks (parallel support) |
| `code_search` | Code search (ripgrep) |
| `git_*` | Git operations |
| `agent_send_message` | Send message to another Agent (A2A via mailbox) |
| `notify_user` | Send proactive message to user (appears in chat + notification bell) |
| `request_user_approval` | Request user decision/approval (blocks until user responds; supports custom options + freeform) |
| `recall_activity` | Query own execution history (activities + tool call logs) |
| `task_create` / `task_list` / `task_update` / `task_get` / `task_assign` / `task_note` | Task board ops (constrained by governance policy) |
| `task_submit_review` | Submit delivery for review |
| `requirement_propose` / `requirement_list` | Requirement management |
| `deliverable_create` / `deliverable_search` / `deliverable_list` | Shared deliverables |

**Git commit metadata injection:** When an Agent runs `git commit`, `shell_execute` auto-injects `--author` and `--trailer` with Agent ID, name, Team, Org, Task ID, etc., so all commits are traceable.

### 3.6 Task System

See [Task & Requirement State Machines](./STATE-MACHINES.md) for the complete FSM specification.

Tasks and requirements share a **unified status vocabulary**: `pending`, `in_progress`, `blocked`, `review`, `completed`, `failed`, `rejected`, `cancelled`, `archived`. Not every status applies to both types, but the same name always means the same thing.

#### Standard Task State Flow

```
pending ──► in_progress ──► review ──► completed ──► archived
   │             │    ▲         │
   │             │    │         └── revision ──► in_progress
   │             ▼    │
   │          blocked ┘
   ▼             │
rejected       failed ──► (retry) ──► in_progress
```

- Workers submit via `task_submit_review`. The system notifies the reviewer.
- `rejected` = proposal denied before work. `cancelled` = stopped after work began.

#### Scheduled (Recurring) Task State Flow

```
pending → in_progress → review → completed → (scheduled rerun) → in_progress → ...
```

- After completion, scheduled tasks wait for `nextRunAt` then restart.
- Scheduled tasks go through the same review pipeline as standard tasks.

#### Requirement State Flow

```
pending ──► in_progress ──► completed
   │  ▲
   ▼  │
rejected ── resubmit ──┘     any ──► cancelled
```

- User-created requirements auto-approve to `in_progress`.
- Agent proposals start as `pending`, need human approval.
- Rejected requirements can be resubmitted by the agent (with optional updates), returning to `pending`.
- Completion is automatic when all linked tasks terminate.

#### Unified Status Reference

| Status | Label | Description |
|--------|-------|-------------|
| `pending` | Pending | Created, awaiting human approval |
| `in_progress` | In Progress | Approved, work is active |
| `blocked` | Blocked | On hold (dependencies, manual pause) |
| `review` | In Review | Execution done, awaiting reviewer |
| `completed` | Completed | Successfully finished |
| `failed` | Failed | Unrecoverable error |
| `rejected` | Rejected | Proposal not approved |
| `cancelled` | Cancelled | Deliberately stopped |
| `archived` | Archived | Historical record |

**Task governance policy:**

| Approval tier | Trigger | Approver |
|---------------|---------|----------|
| `auto` | Low-priority agent-created tasks | No approval (starts `in_progress`) |
| `manager` | Standard agent-created tasks | Team Manager Agent |
| `human` | High/urgent priority, shared-resource impact | Human (HITL) |

**Human-created tasks** always start as `pending` regardless of approval tier, with no HITL approval request or notification. The human user explicitly starts execution from the UI ("Start Execution" button). Agent trust level dynamically adjusts effective approval tier (e.g. senior Agent's manager-level tasks may auto-approve).

### 3.7 Context Engine (System Prompt Assembly)

Before each conversation, the ContextEngine dynamically builds the system prompt:

1. Role definition (ROLE.md — Identity store)
2. Shared behavior norms (SHARED.md: workflow, governance, knowledge sharing)
3. Identity and org awareness (colleague list, manager, human members)
4. **Current project context** (project name, repos, governance rules)
5. **Current workspace** (agent workspace path, shared workspace, users/ and team/ directories)
6. **Agent trust level** (current level and permission description)
7. **System announcements** (urgent/high-priority announcements)
8. **Human feedback** (annotations and instructions from report reviews)
9. **Project knowledge highlights** (high-importance verified knowledge entries)
10. **Your Knowledge** (MEMORY.md — Knowledge store, single unified section)
11. Cognitive/Retrieved Context + Reflection (when CPP active — from Experience + Knowledge stores)
12. Task board (currently assigned Tasks)
13. Current conversation identity (sender info)
14. Environment info (OS, toolchain, runtime)

See [PROMPT-ENGINEERING.md](./PROMPT-ENGINEERING.md) for the complete section ordering and [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md) for the cognitive preparation pipeline.

### 3.8 LLM Routing

```
LLMRouter
  ├── Primary Provider (OpenAI / Anthropic / DeepSeek)
  └── Fallback Provider (auto-switch, retry on failure)
```

- Supports streaming (SSE) and non-streaming modes
- Timeouts: chat 60s / stream 120s
- Auto-fallback to backup provider on failure

---

## 4. Governance Framework

### 4.1 Global Controls

| Function | Description |
|----------|-------------|
| `stopAllAgents(reason)` | Stop all Agents with reason. Cancels active LLM streams, stops attention loops, requeues in-flight items. |
| `startAllAgents()` | Start all stopped Agents. Attention loops restart, deferred items resurface. |
| `emergencyStop()` | Emergency stop: cancel all active streams and stop all Agents |
| `agent.stop(reason)` | Stop a single agent. Cancels active LLM stream, stops attention, sets status to `offline`. |
| System announcements | Broadcast to all Agents and UI, injected into Agent system prompt |

#### Stop State Persistence

Agent stopped state is persisted across process restarts. There is a single "not running" status: `offline`. The former `paused` status has been unified into `offline`.

- **Individual agent**: `agent.stop()` sets status to `offline`, which is written to the `agents.status` DB column via the `stateChangeHandler`. On restart, `startRestoredAgentsInBackground` skips agents whose DB status is `offline`, keeping them stopped.
- **Team-level stop**: `stopTeamAgents(teamId)` stops each member agent individually. Persistence is implicit — each member's `offline` status is stored in DB. On restart, stopped team members remain offline.
- **Global stop**: `stopAllAgents()` stops every agent individually. On startup, `isGlobalStopped()` dynamically checks whether all agents are offline.

#### Agent Management Tools

Agents can manage other agents' lifecycle through tools with role-based permissions:

- **Manager** (`agentRole: 'manager'`): gets `agent_stop` / `agent_start` tools, scoped to their own team members only.
- **Secretary** (worker with `secretary` role): gets `team_stop` / `team_start` tools for managing any team.

### 4.2 Workspace Isolation

Each agent has a dedicated workspace (`~/.markus/agents/<agentId>/workspace/`). The only hard enforcement is that agents **cannot write to other agents' directories** — this prevents cross-agent interference. All other file access (read and write) is unrestricted, allowing agents to respond to any user request. Prompt-based guidance encourages agents to work within their own workspace and use worktrees for project code.

- The platform enforces: cross-agent write isolation (deny writes to other agents' directories)
- The platform provides via prompt: workspace path, project context, best-practice guidance
- The agent decides: branching strategy, worktree layout, merge workflow
- Workflow details like branching conventions and review process are defined by **role templates and team norms**, not by the platform

**Git command governance** (three-tier model):

| Tier | Operations | Behavior |
|------|-----------|----------|
| **Allow** | `add`, `commit`, `fetch`, `log`, `diff`, `status`, `branch -a/-l`, `checkout -b`, `switch -c`, `worktree add/list/remove`, `push origin <task-branch>` | Execute immediately |
| **Approval** | `checkout <existing-branch>`, `switch <existing-branch>`, `push ... main/master`, `merge`, `rebase` | Pause execution, request HITL approval via `HITLService`; agent receives approval or rejection with reason |
| **Deny** | `push --force/-f` | Always blocked |

The approval tier integrates with the existing HITL approval pipeline (`HITLService.requestApprovalAndWait()`). Human reviewers can approve or reject with a comment; the agent receives the feedback and adjusts. This mechanism is extensible: new dangerous operations can be added via `SecurityPolicy.requireApproval` (config-driven) or new pattern arrays in `shell.ts` (code-driven).

### 4.3 Formal Delivery and Review

```
Agent completes work
  -> task_submit_review (summary, branch, test results)
  -> Quality gates (TypeScript build, ESLint, Vitest)
  -> Merge conflict pre-check (dry-run merge)
  -> Task state -> review
  -> Reviewer accept / request revision
  -> accept -> merge branch -> completed
  -> revision -> Agent reworks -> resubmit
```

### 4.4 Periodic Reports

| Report type | Frequency | Content |
|-------------|-----------|---------|
| Daily | Daily | Task done/in-progress/blocked, token usage |
| Weekly | Weekly | Progress, cost trends, next week plan (may include plan approval) |
| Monthly | Monthly | Monthly summary, cost analysis, quality metrics |

**Plan approval flow:** Weekly reports' work plans need human approval -> approved plans auto-create tasks -> Agents must not start before plan approval

**Human feedback:** Annotations, comments, and instructions on reports can:
- Be sent to specific Agents
- Be broadcast as system announcements
- Be saved to project knowledge base
- Auto-create new tasks

### 4.5 Archival and Lifecycle

- Completed tasks auto-archive after configurable days (`autoArchiveAfterDays`)
- Task logs and audit logs retained for configurable periods

### 4.6 Stall Detection

| Condition | Threshold | Action |
|-----------|------------|--------|
| Task `in_progress` too long | > 24h or 2x avg completion time | Warn Agent -> report to Manager |
| Task `review` unhandled | > 12h | Report to human |
| Task `assigned` not started | > 4h | Remind Agent -> reassign |

### 4.7 Agent Lifecycle & Sourcing

Agents can be sourced from three paths:

| Source | Tool | Flow |
|--------|------|------|
| **Local package** | `package_install` | `package_list` → choose agent/team/skill → `package_install` → onboard |
| **Markus Hub** | `hub_install` | `hub_search` → `hub_install` (download + install in one step) → onboard |

The **Secretary** agent is the sole default agent (builder agents have been removed). The Secretary holds all building skills (`agent-building`, `team-building`, `skill-building`). All agents have package tools (`package_list`, `package_install`) and hub tools (`hub_search`, `hub_install`).

The `BuilderService` (`packages/org-manager/src/builder-service.ts`) encapsulates artifact install/list logic, used by both the HTTP API and agent tools.

---

## 5. Database Schema

```sql
-- Users
users (id, org_id, name, email, role, password_hash, created_at, last_login_at)

-- Agent chat (each agent has one main session for activity log + optional conversation sessions)
chat_sessions (id, agent_id, user_id, title, is_main, created_at, last_message_at)
chat_messages (id, session_id, agent_id, role, content, metadata, tokens_used, created_at)

-- Channel messages (DM, group chat, team channels)
channel_messages (id, org_id, channel, sender_id, sender_type, sender_name, text, mentions, reply_to_id, created_at)

-- Group chats (custom groups with managed membership)
group_chats (id, org_id, name, channel_key, creator_id, creator_name, created_at, updated_at)
group_chat_members (id, group_chat_id, user_id, user_type, user_name, role, joined_at)

-- Task comments (threaded discussion on tasks)
task_comments (id, task_id, author_id, author_name, author_type, content, attachments, mentions, activity_id, reply_to_id, created_at)

-- Requirement comments (threaded discussion on requirements)
requirement_comments (id, requirement_id, author_id, author_name, author_type, content, attachments, mentions, activity_id, reply_to_id, created_at)

-- Tasks (extended)
tasks (id, org_id, title, description, status, priority, assigned_agent_id, subtasks,
       project_id, requirement_id, due_at, created_at, updated_at)

-- Projects
projects (id, org_id, name, description, status, repositories,
          team_ids, governance_policy, review_schedule, created_at, updated_at)

-- Requirements
requirements (id, org_id, project_id, title, description, priority, status,
              source, tags, created_at, updated_at)

-- Deliverables
deliverables (id, org_id, project_id, agent_id, task_id, type, title,
              summary, reference, tags, status, created_at, updated_at)

-- Project knowledge
project_knowledge (id, scope, scope_id, category, title, content, tags,
                   source, importance, status, verified_by, supersedes,
                   access_count, last_accessed_at, created_at, updated_at)

-- Reports
reports (id, type, scope, scope_id, period_start, period_end, status,
         metrics, task_summary, cost_summary, highlights, blockers, learnings,
         upcoming_plan, generated_at, generated_by, reviewed_by, reviewed_at)

-- Report feedback
report_feedback (id, report_id, author_id, author_name, type, anchor,
                 content, priority, disclosure, actions, created_at)

-- System announcements
system_announcements (id, type, title, content, priority, created_by,
                      target_scope, target_ids, acknowledged, created_at, expires_at)

-- Audit logs
audit_logs (id, org_id, agent_id, task_id, project_id, event_type,
            action, metadata, created_at)

-- User notifications (persistent mailbox for humans)
user_notifications (id, user_id, type, title, body, priority,
                    read, action_type, action_target, metadata, created_at)

-- Mailbox items (agent attention queue)
mailbox_items (id, agent_id, source_type, source_id, priority, summary, payload,
               status, received_at, processed_at, decision, decision_reason)

-- Agent decisions (attention decision log)
agent_decisions (id, agent_id, mailbox_item_id, decision, reason, context, decided_at)
```

---

## 6. Authentication & Multi-User System

- JWT Cookie (`markus_token`, 7-day validity)
- Initial account: `admin@markus.local` / `markus123` (onboarding wizard prompts user to set real name, email, and password)
- Roles: `owner` > `admin` > `member` > `guest`
- Only `owner` / `admin` can manage team members and Agents

### 6.1 User Management

| Operation | Access |
|-----------|--------|
| Create / invite user | `owner` / `admin` |
| Set role | `owner` / `admin` (cannot promote above own role) |
| Delete user | `owner` / `admin` (cannot delete self or higher roles) |
| Invite link | Generated per user; expires in 7 days; new user sets password via link |

**Invite flow:** Admin creates user (name, email, role) → system generates invite token → invite link displayed → new user opens link → sets password → joins the platform (`hasJoined` flag set).

### 6.2 Chat Session Isolation

Each human user has their own chat sessions with agents. Chat sessions are scoped by `user_id`:
- `chat_sessions.user_id` tracks which human owns the session
- `GET /api/agents/:agentId/sessions` filters by authenticated user
- Agent "Main Sessions" (activity logs) are shared (visible to all users)
- Historical sessions with `user_id = NULL` are auto-migrated to the first user on startup

### 6.3 User Context Files

Each human user has a profile file maintained by the Secretary agent:

| File | Path | Purpose |
|------|------|---------|
| `USER.md` | `~/.markus/users/{userId}/USER.md` | User preferences, communication style, context notes |
| `TEAM.md` | `~/.markus/teams/{teamId}/TEAM.md` | Team norms, conventions, shared practices |

These files are injected into agent context when interacting with the corresponding user, allowing agents to personalize their behavior.

---

## 7. WebSocket Events

Connection: `ws://localhost:8056`

| Event | Trigger |
|-------|---------|
| `agent:update` | Agent state change (idle/working/offline/error) |
| `agent:mailbox` | New item enqueued to an agent's mailbox |
| `agent:decision` | Agent attention decision (pick/defer/drop/triage) |
| `agent:attention` | Attention controller state change |
| `agent:focus` | Agent switches to a new mailbox item |
| `agent:triage` | Agent triage deliberation result (reasoning, process/defer/drop) |
| `agent:started` | Agent process started |
| `agent:stopped` | Agent process stopped |
| `task:update` | Task state update (including review/accepted/archived) |
| `task:create` | New task created |
| `requirement:created` | Requirement proposed |
| `requirement:approved` / `rejected` / `updated` / `completed` / `cancelled` | Requirement lifecycle |
| `notification` | User notification — targeted by userId (triggers NotificationBell refresh) |
| `chat:proactive_message` | Agent activity log or proactive message (main session) |
| `chat:message` | New channel/DM/group chat message (targeted to members) |
| `chat:group_created` | Group chat created |
| `chat:group_updated` | Group chat membership changed |
| `chat:group_deleted` | Group chat deleted |
| `chat` | Agent sends message in channel |
| `system:announcement` | System announcement broadcast |
| `system:pause-all` | Global pause event |
| `system:resume-all` | Global resume event |
| `system:emergency-stop` | Emergency stop event |

**EventBus Architecture**: Each `Agent` has a private `EventBus`; the `AgentManager` has a separate manager-level `EventBus`. Agent events are forwarded to the manager's bus via `forwardAgentEvents()` so that `start.ts` WS broadcast handlers receive them. See `docs/MAILBOX-SYSTEM.md` §19 for the full forwarding table.

---

## 8. Channel System

| Channel format | Purpose |
|----------------|---------|
| `#general` / `#dev` / `#support` | Team channels, @mention triggers Agent |
| `group:{teamId}` | Team group chat (all team members) |
| `group:custom:{id}` | Custom group chat (manually managed members) |
| `notes:{userId}` | Personal notes (not routed to any Agent) |
| `dm:{id1}:{id2}` | Direct message between two humans (not routed to any Agent) |

### 8.1 Multi-User Communication Model

Markus supports multiple human users and agents communicating through various channels. The communication model varies by context:

**Agent communication contexts and output visibility:**

| Context | Agent output visible to | How to reach humans | How to reach agents |
|---------|----------------------|--------------------|--------------------|
| **Chat** (human_chat) | Directly visible to the chatting human (real-time stream) | Speak naturally — output is streamed live | `agent_send_message` |
| **Task Execution** | Visible in task execution logs (Work page) | `notify_user` for critical updates | `agent_send_message` |
| **Heartbeat** | Not visible to anyone | `notify_user` (only way) | `agent_send_message` |
| **A2A** | Visible to the peer agent only | `notify_user` | Reply directly / `agent_send_message` for others |
| **Comment Response** | Not directly visible | `task_comment` / `requirement_comment` (comment thread) | `agent_send_message` |
| **Review** | Not directly visible | `task_update` + optionally `notify_user` | `agent_send_message` |
| **Memory Consolidation** | Not visible; purely internal | N/A (no communication) | N/A |

**Human-to-human communication:**

| Channel | Delivery mechanism | Notification |
|---------|-------------------|--------------|
| DM (`dm:{id1}:{id2}`) | WebSocket push to recipient + persisted to `channel_messages` | Bell notification (type `direct_message`) with click-to-navigate |
| Group chat (`group:*`) | WebSocket push to all human members + persisted | Bell notification (type `group_message`) with click-to-navigate |
| @mention in comments | Persisted in task/requirement comments | Bell notification with click-to-navigate to task/requirement |

**Key tools for agent communication:**

| Tool | Purpose | When to use |
|------|---------|-------------|
| `notify_user` | Proactive message to human (chat + bell) | Any non-chat context when human attention needed |
| `request_user_approval` | Block until human decides | Decisions, approvals, input needed |
| `agent_send_message` | Direct message to peer agent | Coordination, questions, context sharing |
| `task_comment` / `requirement_comment` | Post in comment thread | Responding to comments on tasks/requirements |

---

## 9. Heartbeat Tasks

After Agent startup, HeartbeatScheduler triggers periodic tasks at configured intervals:

- Each run executes checks with `[HEARTBEAT CHECK-IN]` prompt under the "Patrol, Don't Build" principle
- **Heartbeat includes task retrospective**: calls task_list to check active tasks and update stale states
- **Lightweight actions allowed**: check status, send messages, create tasks, retry failed tasks, quick reviews, save insights
- **Complex work goes into tasks**: if something needs heavy implementation, heartbeat creates a task and notifies the user
- Infinite loop protection via a configurable tool-iteration safety cap (default 200, `maxToolIterations`), not artificial per-heartbeat limits
- **Background process notifications**: finished `background_exec` sessions enqueue completions for injection into the agent’s session; heartbeat drains them so the model sees a `[BACKGROUND PROCESS COMPLETED]` notification on the next turn
- **Governance mode**: in_progress tasks are not auto-resumed on service start; requires manual trigger

---

## 10. Agent Awareness Model (Three Layers)

Agents understand the workflow and governance rules through three layers:

| Layer | File | Role |
|-------|------|------|
| **SHARED.md (static norms)** | `templates/roles/SHARED.md` | Shared behavior for all Agents: workflow map, task governance, workspace discipline, formal delivery, knowledge management, trust mechanism, Git commit norms, reports and feedback |
| **ContextEngine (dynamic injection)** | `packages/core/src/context-engine.ts` | Injected per interaction: current project context, workspace info, system announcements, human feedback, trust level, project knowledge highlights |
| **Tools (mechanical enforcement)** | `packages/core/src/tools/` | Enforcement: `task_create` blocks until approved, `task_submit_review` replaces direct completion, file writes blocked to other agents' directories, git commit auto-injects metadata |

**Design principles:**
- Things Agents need for **decisions** -> put in Context (project goals, governance rules, requirement context)
- Things Agents need to **act on** -> implement as Tools (submit review, manage deliverables, contribute knowledge)
- Things that must be **enforced** -> implement as transparent tool behavior (workspace limits, approval blocking, commit metadata injection)

---

## 11. Deployment

### Quick start (npm)

```bash
npm install -g @markus-global/cli
markus start
```

Open the dashboard at `http://localhost:8056`.

### Local development (from source)

```bash
pnpm install && pnpm build
cp markus.json.example ~/.markus/markus.json   # Add API keys
node packages/cli/dist/index.js start
```

Same dashboard URL: `http://localhost:8056`.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key (primary LLM) |
| `ANTHROPIC_API_KEY` | Anthropic API key (optional) |
| `DEEPSEEK_API_KEY` | DeepSeek API key (fallback) |
| `DATABASE_URL` | SQLite path override (default: `~/.markus/data.db`, format: `sqlite:/path/to/db`) |
| `JWT_SECRET` | JWT signing key (recommended for production) |
| `AUTH_ENABLED` | Enable login auth (default true) |
