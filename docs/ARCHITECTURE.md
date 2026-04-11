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
│  LLMRouter · Memory · WorkspaceManager · HeartbeatScheduler   │
│  Tools · MCP Client · ReviewService                           │
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
├── core/         # Agent runtime (core engine) + WorkspaceManager + ReviewService
├── storage/      # Database schema + Repository layer
├── org-manager/  # Org management + REST API + governance (Project/Report/Knowledge/Trust)
├── comms/        # Communication adapters (Feishu, etc.)
├── a2a/          # Agent-to-Agent protocol
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

The runtime also supports **spawning lightweight LLM subagents** (`spawn_subagent` / `spawn_subagents`) for delegated subtasks, and a **configurable tool-use iteration limit** (`AgentOptions.maxToolIterations`, system settings; default 200, range 1–10000) on chat-style harnesses — task execution remains uncapped.

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
- **AgentMailbox** — Priority queue accepting 13 item types: `human_chat`, `a2a_message`, `task_assignment`, `task_comment`, `task_status_update`, `mention`, `review_request`, `requirement_update`, `session_reply`, `daily_report`, `heartbeat`, `memory_consolidation`, `system_event`
- **AttentionController** — Event-driven focus loop; reacts to new mail with interrupt signals
- **Yield Points** — Safe checkpoints in the tool loop where the agent can pause to evaluate interrupts
- **Decision Engine** — Produces decisions: `continue`, `preempt`, `merge`, `defer`, `drop`

External callers use the mailbox API exclusively:
- `agent.sendMessage()` — Awaitable chat/notification
- `agent.sendMessageStream()` — Streaming chat (SSE)
- `agent.sendTaskExecution()` — Task execution (fire-and-forget)
- `agent.sendSessionReply()` — Post-task session reply
- `agent.enqueueToMailbox()` — Fire-and-forget notification

Internal processes (heartbeat, daily report, memory consolidation) also enqueue to the mailbox, ensuring **no LLM call bypasses the attention controller**. The mailbox timeline (items + decisions) forms the agent's **episodic memory ground truth**.

See [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) for the complete design.

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

**Agent memory (three layers):**

```
Short-term (session)       Mid-term (daily log)       Long-term (MEMORY.md)
────────────────────      ─────────────────────      ────────────────────
· Current chat messages    · Daily work summaries     · Key project info
· Last 40 messages kept    · Rolling last few days    · Agent writes manually
· Compression when full    · Auto-generated & stored   · Permanent storage
```

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
| `file_read` / `file_write` / `file_edit` | File read/write/edit (restricted to worktree path) |
| `file_list` | List directory contents |
| `web_fetch` / `web_search` | HTTP requests / web search |
| `spawn_subagent` / `spawn_subagents` | Spawn lightweight LLM subagents for focused subtasks (parallel support) |
| `code_search` | Code search (ripgrep) |
| `git_*` | Git operations |
| `agent_send_message` | Send message to another Agent (A2A) |
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
| `auto` | Low-priority tasks | No approval |
| `manager` | Standard tasks | Team Manager Agent |
| `human` | High/urgent priority, shared-resource impact | Human (HITL) |

Agent trust level dynamically adjusts effective approval tier (e.g. senior Agent's manager-level tasks may auto-approve).

### 3.7 Context Engine (System Prompt Assembly)

Before each conversation, the ContextEngine dynamically builds the system prompt:

1. Role definition (ROLE.md system prompt)
2. Shared behavior norms (SHARED.md: workflow overview, governance rules, knowledge sharing, etc.)
3. Identity and org awareness (colleague list, manager, human members)
4. **Current project context** (project name, repos, governance rules)
5. **Current workspace** (branch name, worktree path, base branch)
6. **Agent trust level** (current level and permission description)
7. **System announcements** (urgent/high-priority announcements)
8. **Human feedback** (annotations and instructions from report reviews)
9. **Project knowledge highlights** (high-importance verified knowledge entries)
10. Long-term memory (MEMORY.md summary)
11. Relevant memory retrieval
12. Recent activity summary (daily log)
13. Task board (currently assigned Tasks)
14. Current conversation identity (sender info)
15. Environment info (OS, toolchain, runtime)

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
| `pauseAllAgents(reason)` | Pause all Agents with reason |
| `resumeAllAgents()` | Resume all Agents |
| `emergencyStop()` | Emergency stop: cancel all active tasks and stop all Agents |
| System announcements | Broadcast to all Agents and UI, injected into Agent system prompt |

### 4.2 Workspace Isolation

Each task gets a dedicated Git worktree in the project repo:

```
project-repo/
├── .worktrees/
│   ├── task-abc123/    <- Agent A workspace
│   └── task-def456/    <- Agent B workspace
├── src/                <- Main branch (no direct edits)
└── ...
```

- Branch naming: `task/<taskId>`
- Agent shell/file tools are restricted to worktree path
- Worktree cleaned after merge on approval

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

- Completed tasks auto-archive after configurable days
- Accepted tasks auto-clean worktree after merge
- Archived tasks delete branch after configurable days

### 4.6 Stall Detection

| Condition | Threshold | Action |
|-----------|------------|--------|
| Task `in_progress` too long | > 24h or 2x avg completion time | Warn Agent -> report to Manager |
| Task `review` unhandled | > 12h | Report to human |
| Task `assigned` not started | > 4h | Remind Agent -> reassign |

---

## 5. Database Schema

```sql
-- Users
users (id, org_id, name, email, role, password_hash, created_at, last_login_at)

-- Agent chat
chat_sessions (id, agent_id, user_id, title, created_at, last_message_at)
chat_messages (id, session_id, agent_id, role, content, tokens_used, created_at)

-- Channel messages
channel_messages (id, org_id, channel, sender_id, sender_type, sender_name, text, mentions, created_at)

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
```

---

## 6. Authentication

- JWT Cookie (`markus_token`, 7-day validity)
- Default account: `admin@markus.local` / `markus123` (must change password on first login)
- Roles: owner > admin > member > guest
- Only `owner` / `admin` can manage team members and Agents

---

## 7. WebSocket Events

Connection: `ws://localhost:8056`

| Event | Trigger |
|-------|---------|
| `agent:update` | Agent state change (idle/working/offline/paused) |
| `task:update` | Task state update (including review/accepted/archived) |
| `chat` | Agent sends message in channel |
| `system:announcement` | System announcement broadcast |
| `system:pause-all` | Global pause event |
| `system:emergency-stop` | Emergency stop event |

---

## 8. Channel System

| Channel format | Purpose |
|----------------|---------|
| `#general` / `#dev` / `#support` | Team channels, @mention triggers Agent |
| `notes:{userId}` | Personal notes (not routed to any Agent) |
| `dm:{id1}:{id2}` | Direct message (not routed to any Agent) |

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
| **Tools (mechanical enforcement)** | `packages/core/src/tools/` | Enforcement: `task_create` blocks until approved, `task_submit_review` replaces direct completion, shell/file tools restricted to worktree, git commit auto-injects metadata |

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
