# Markus -- Technical Architecture

> Last updated: 2026-03

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
│Org    │ │Tasks   │ │Agent    │ │Service │ │Report·Knowledge │
│Mgmt   │ │+ Approve│ │Lifecycle│ │Iters   │ │Trust·Archive    │
└──┬────┘ └──┬─────┘ └──┬──────┘ └┬───────┘ └┬────────────────┘
   │         │          │         │           │
┌──▼─────────▼──────────▼─────────▼───────────▼───────────────┐
│                Agent Runtime (@markus/core)                    │
│  Agent · ContextEngine · LLMRouter · Memory · WorkspaceManager│
│  HeartbeatScheduler · Tools · MCP Client · ReviewService      │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────▼──────────────┐
              │      SQLite (better-sqlite3)     │
              │  tasks · projects · iters  │
              │  knowledge · reports       │
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
├── compute/      # Docker sandbox management (optional)
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

**Agent role types:**
- `worker` -- Regular digital employee, executes tasks
- `manager` -- Org leader, handles task routing, team coordination, reporting

**Agent trust levels (Progressive Trust):**

| Level | Condition | Permissions |
|-------|-----------|-------------|
| `probation` | New Agent or score < 40 | All tasks require human approval |
| `junior` | score >= 40, >= 3 deliveries | Standard tasks need Manager approval |
| `standard` | score >= 60, >= 10 deliveries | Routine tasks auto-approved |
| `senior` | score >= 80, >= 25 deliveries | High autonomy, can review others |

### 3.2 Organization Structure

```
Organization (Org)
 ├── Teams -- Working groups of Agents and humans with shared goals
 │    ├── Manager -- Approves work, sets direction
 │    └── Members -- Agents and humans executing tasks
 ├── Projects -- Scopes with repos, governance rules, iterations
 │    ├── Iterations (Sprint/Kanban) -- Task containers
 │    │    └── Tasks -> Subtasks -- Atomic work units
 │    ├── Knowledge Base -- Shared knowledge (ADRs, conventions, gotchas, etc.)
 │    └── Governance Policy -- Approval rules, task caps
 └── Reports -- Periodic reports + plan approval + human feedback
```

**Relationship model:**
- A Team can participate in multiple Projects; a Project can be worked on by multiple Teams
- Each Task belongs to one Project and one Iteration
- Each Project can link multiple code repositories

### 3.3 Memory and Knowledge System

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

### 3.4 Tool System

**Built-in tools (all Agents have by default):**

| Tool | Description |
|------|-------------|
| `shell_execute` | Run shell commands (auto-injects Agent identity into git commit) |
| `file_read` / `file_write` / `file_edit` | File read/write/edit (restricted to worktree path) |
| `file_list` | List directory contents |
| `web_fetch` / `web_search` | HTTP requests / web search |
| `code_search` | Code search (ripgrep) |
| `git_*` | Git operations |
| `agent_send_message` | Send message to another Agent (A2A) |
| `task_create` / `task_list` / `task_update` / `task_get` / `task_assign` / `task_note` | Task board ops (constrained by governance policy) |
| `task_submit_review` | Submit delivery for review |
| `project_info` / `iteration_status` | Query project and iteration info |
| `knowledge_contribute` / `knowledge_search` / `knowledge_browse` / `knowledge_flag_outdated` | Project knowledge base ops |

**Git commit metadata injection:** When an Agent runs `git commit`, `shell_execute` auto-injects `--author` and `--trailer` with Agent ID, name, Team, Org, Task ID, etc., so all commits are traceable.

### 3.5 Task System

See [Task & Requirement State Machines](./STATE-MACHINES.md) for the complete FSM specification.

#### Standard Task State Flow

```
pending -> pending_approval -> assigned -> in_progress -> review -> accepted -> completed -> archived
                                      \-> blocked              /-> revision (rework)
                                      \-> failed / cancelled
```

- `accepted → completed` is automatic (branch merged, then auto-completed).
- Workers submit via `task_submit_review` with a `reviewer_id`.
- The system notifies the reviewer; workers do NOT broadcast to all agents.

#### Scheduled (Recurring) Task State Flow

```
pending -> assigned -> in_progress -> review -> accepted -> pending (awaits next run)
                                            /-> revision -> in_progress (rework)
```

- After acceptance, scheduled tasks return to `pending` (not `completed`).
- The `ScheduledTaskRunner` fires the next run when `nextRunAt` arrives.
- Scheduled tasks go through the same review pipeline as standard tasks.

#### Requirement State Flow

```
draft -> pending_review -> approved -> in_progress -> completed
                       \-> rejected
                       \-> cancelled
```

| State | Description |
|-------|-------------|
| `pending` | Created, awaiting assignment |
| `pending_approval` | Awaiting human/manager approval |
| `assigned` | Assigned to Agent |
| `in_progress` | Agent is working |
| `review` | Agent submitted delivery, awaiting review |
| `revision` | Review requested rework |
| `accepted` | Review passed |
| `completed` | Task done (standard) / N/A for scheduled |
| `archived` | Archived |
| `blocked` | Blocked by dependencies |
| `failed` / `cancelled` | Failed / Cancelled |

**Task governance policy:**

| Approval tier | Trigger | Approver |
|---------------|---------|----------|
| `auto` | Low-priority tasks | No approval |
| `manager` | Standard tasks | Team Manager Agent |
| `human` | High/urgent priority, shared-resource impact | Human (HITL) |

Agent trust level dynamically adjusts effective approval tier (e.g. senior Agent's manager-level tasks may auto-approve).

### 3.6 Context Engine (System Prompt Assembly)

Before each conversation, the ContextEngine dynamically builds the system prompt:

1. Role definition (ROLE.md system prompt)
2. Shared behavior norms (SHARED.md: workflow overview, governance rules, knowledge sharing, etc.)
3. Identity and org awareness (colleague list, manager, human members)
4. **Current project context** (project name, iteration goals, repos, governance rules)
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

### 3.7 LLM Routing

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
| Iteration | End of iteration | Retrospective, carry-over items, next iteration plan |

**Plan approval flow:** Weekly/iteration reports' work plans need human approval -> approved plans auto-create tasks -> Agents must not start before plan approval

**Human feedback:** Annotations, comments, and instructions on reports can:
- Be sent to specific Agents
- Be broadcast as system announcements
- Be saved to project knowledge base
- Auto-create new tasks

### 4.5 Archival and Lifecycle

- Completed tasks auto-archive after configurable days
- Accepted tasks auto-clean worktree after merge
- Archived tasks delete branch after configurable days
- Iteration archives when all its tasks are archived

### 4.6 Stall Detection

| Condition | Threshold | Action |
|-----------|------------|--------|
| Task `in_progress` too long | > 24h or 2x avg completion time | Warn Agent -> report to Manager |
| Task `review` unhandled | > 12h | Report to human |
| Task `assigned` not started | > 4h | Remind Agent -> reassign |
| Iteration overdue and < 80% done | Due date + 1 day | Auto-generate retrospective |

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
       project_id, iteration_id, due_at, created_at, updated_at)

-- Projects
projects (id, org_id, name, description, status, iteration_model, repositories,
          team_ids, governance_policy, review_schedule, created_at, updated_at)

-- Iterations
iterations (id, project_id, name, status, goal, start_date, end_date,
            metrics, review_report, created_at, updated_at)

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

- Each run executes checks with `[HEARTBEAT TASK]` prompt
- **Heartbeat includes task retrospective**: calls task_list to check active tasks and update stale states
- Max 5 tool calls per heartbeat to avoid infinite loops
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
- Things Agents need for **decisions** -> put in Context (project goals, iteration timeline, governance rules)
- Things Agents need to **act on** -> implement as Tools (submit review, query project info, contribute knowledge)
- Things that must be **enforced** -> implement as transparent tool behavior (workspace limits, approval blocking, commit metadata injection)

---

## 11. Deployment

### Local Development

```bash
pnpm install && pnpm build
cp markus.json.example ~/.markus/markus.json   # Add API keys
node packages/cli/dist/index.js start
```

Visit: `http://localhost:8057` (Web UI) / `http://localhost:8056` (API)

### Docker Compose

```bash
cd deploy
docker compose up -d
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key (primary LLM) |
| `ANTHROPIC_API_KEY` | Anthropic API key (optional) |
| `DEEPSEEK_API_KEY` | DeepSeek API key (fallback) |
| `DATABASE_URL` | SQLite path override (default: `~/.markus/data.db`, format: `sqlite:/path/to/db`) |
| `JWT_SECRET` | JWT signing key (recommended for production) |
| `AUTH_ENABLED` | Enable login auth (default true) |
