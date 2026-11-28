# Markus HTTP API reference

> **Generated — do not edit.** Produced from `APIServer.buildRouteTable()` and
> `ROLE_RULES` by `scripts/gen-api-reference.mjs`. To change a line here, change
> the route declaration (or the comment above it) and run `pnpm api:docs`.
>
> Flow, trade-offs and "which of these do I want" live in `docs/api/guides/`,
> which is hand-written on purpose — the code cannot answer those questions.

Routes: **406** · with a description: **107** · groups: **41**

Base URL: `http://localhost:8056`. Authentication: JWT cookie `markus_token`, or `Authorization: Bearer <token>`.
`min role` is the lowest org role that may call the route (`member` < `admin` < `owner`).

## Contents

- [Auth](#auth) — 8
- [Avatars](#avatars) — 2
- [Uploads](#uploads) — 3
- [Agents](#agents) — 46
- [Sessions / Channels](#sessions-channels) — 5
- [Group Chats](#group-chats) — 7
- [Teams](#teams) — 15
- [Roles](#roles) — 2
- [Tasks](#tasks) — 38
- [Execution](#execution) — 1
- [Deliverables / Knowledge](#deliverables-knowledge) — 11
- [Reviews](#reviews) — 3
- [Requirements](#requirements) — 14
- [Projects](#projects) — 6
- [Milestones (里程碑)](#milestones-) — 5
- [Notifications](#notifications) — 4
- [Message search](#message-search) — 1
- [Activity feed](#activity-feed) — 1
- [Users](#users) — 6
- [API Keys](#api-keys) — 3
- [Orgs](#orgs) — 3
- [Message](#message) — 1
- [Skills](#skills) — 9
- [Model Catalog](#model-catalog) — 5
- [Settings](#settings) — 57
- [Integrations](#integrations) — 21
- [Approvals](#approvals) — 3
- [Usage](#usage) — 2
- [Audit](#audit) — 4
- [Plan](#plan) — 2
- [Reports](#reports) — 7
- [Gateway](#gateway) — 14
- [Builder](#builder) — 28
- [Hub](#hub) — 5
- [Templates](#templates) — 4
- [Team Templates](#team-templates) — 4
- [Governance / Workflows](#governance-workflows) — 12
- [System](#system) — 18
- [Files](#files) — 7
- [External Agents](#external-agents) — 3
- [Handled in route(), previously missing from this table](#handled-in-route-previously-missing-from-this-table) — 16

## Auth

| Method | Path | Min role | Description |
|---|---|---|---|
| POST | `/api/auth/login` | member | Login, returns JWT Cookie |
| POST | `/api/auth/hub-login` | member |  |
| POST | `/api/auth/logout` | member | Logout |
| GET | `/api/auth/me` | member | Get current user info |
| POST | `/api/auth/change-password` | member | Change password |
| POST | `/api/auth/setup` | member | Complete registration `{ token, password }` |
| GET | `/api/auth/invite-info` | member | Validate invite token — returns user info (name, email) |
| PUT | `/api/auth/profile` | member |  |

## Avatars

| Method | Path | Min role | Description |
|---|---|---|---|
| POST | `/api/avatars/upload` | member |  |
| GET | `/api/avatars/` | member |  |

## Uploads

| Method | Path | Min role | Description |
|---|---|---|---|
| POST | `/api/uploads` | member |  |
| GET | `/api/uploads/` | member |  |
| GET | `/api/attachments/` | member | 附件字节（内容寻址）。前端 <img src> 直接命中，需要登录态之外的可访问性。 |

## Agents

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/agents` | member | List all agents |
| POST | `/api/agents` | admin | List all agents |
| GET | `/api/agents/role-updates` | member |  |
| GET | `/api/agents/:id/sessions` | member | List an agent's conversation sessions |
| POST | `/api/agents/:id/sessions` | admin | List an agent's conversation sessions |
| GET | `/api/agents/:id/sessions/:id/stream` | member |  |
| GET | `/api/agents/:id/sessions/:id/stream/status` | member |  |
| PUT | `/api/sessions/:id/model-override` | member |  |
| PATCH | `/api/sessions/:id/title` | member |  |
| POST | `/api/agents/:id/start` | admin | Start agent |
| POST | `/api/agents/:id/stop` | admin | Start agent |
| POST | `/api/agents/:id/cancel-processing` | admin | Start agent |
| POST | `/api/agents/:id/daily-report` | admin | Start agent |
| POST | `/api/agents/:id/a2a` | admin | Start agent |
| POST | `/api/agents/:id/message` | admin | Start agent |
| POST | `/api/agents/:id/evolve-from-message` | admin | Start agent |
| GET | `/api/agents/:id` | member | Get agent details |
| DELETE | `/api/agents/:id` | admin | Get agent details |
| GET | `/api/agents/:id/mind` | member | Get agent mind state (attention, focus, mailbox, notebook) |
| GET | `/api/agents/:id/mailbox` | member |  |
| POST | `/api/agents/:id/mailbox/:id/drop` | admin |  |
| POST | `/api/agents/:id/mailbox/recover-stale` | admin |  |
| GET | `/api/agents/:id/decisions` | member |  |
| GET | `/api/agents/:id/metrics` | member |  |
| PATCH | `/api/agents/:id/config` | admin |  |
| GET | `/api/agents/:id/memory` | member |  |
| GET | `/api/agents/:id/memory/sessions/:id` | member |  |
| PUT | `/api/agents/:id/memory/daily` | admin |  |
| PUT | `/api/agents/:id/memory/longterm` | admin |  |
| GET | `/api/agents/:id/files` | member |  |
| PUT | `/api/agents/:id/files/:id` | admin |  |
| PUT | `/api/agents/:id/system-prompt` | admin |  |
| GET | `/api/agents/:id/role-status` | member |  |
| GET | `/api/agents/:id/role-diff` | member |  |
| POST | `/api/agents/:id/role-sync` | admin |  |
| POST | `/api/agents/:id/role-smart-sync` | admin |  |
| POST | `/api/agents/:id/skills` | admin |  |
| DELETE | `/api/agents/:id/skills/:id` | admin |  |
| POST | `/api/agents/:id/tools/:id/toggle` | admin |  |
| GET | `/api/agents/:id/activities` | member |  |
| GET | `/api/agents/:id/recent-activities` | member |  |
| GET | `/api/agents/:id/activity-logs` | member |  |
| GET | `/api/agents/:id/heartbeat` | member |  |
| POST | `/api/agents/:id/heartbeat/trigger` | admin |  |
| DELETE | `/api/agents/:id/wakeups/:id` | admin |  |
| POST | `/api/agents/:id/command` | admin | Dispatch slash command to agent |

## Sessions / Channels

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/sessions/:id/messages` | member | Get session message history |
| GET | `/api/sessions/:id/messages/:id` | member |  |
| DELETE | `/api/sessions/:id` | member |  |
| GET | `/api/channels/:id/messages` | member | Get channel history |
| POST | `/api/channels/:id/messages` | member | Get channel history |

## Group Chats

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/group-chats` | member | List group chats for current user |
| POST | `/api/group-chats` | member | List group chats for current user |
| GET | `/api/group-chats/:id` | member | Get group chat details (includes members) |
| PATCH | `/api/group-chats/:id` | member | Get group chat details (includes members) |
| DELETE | `/api/group-chats/:id` | member | Get group chat details (includes members) |
| POST | `/api/group-chats/:id/members` | member | Add member `{ userId, userType, userName }` |
| DELETE | `/api/group-chats/:id/members/:id` | member | Remove member |

## Teams

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/teams` | member | List teams |
| POST | `/api/teams` | admin | List teams |
| PATCH | `/api/teams/:id` | admin | Update team |
| DELETE | `/api/teams/:id` | admin | Update team |
| POST | `/api/teams/:id/members` | admin |  |
| DELETE | `/api/teams/:id/members/:id` | admin |  |
| POST | `/api/teams/:id/start` | admin |  |
| POST | `/api/teams/:id/stop` | admin |  |
| POST | `/api/teams/:id/pause` | admin |  |
| POST | `/api/teams/:id/resume` | admin |  |
| GET | `/api/teams/:id/status` | member |  |
| GET | `/api/teams/:id/files` | member |  |
| GET | `/api/teams/:id/files/:id` | member |  |
| PUT | `/api/teams/:id/files/:id` | admin |  |
| GET | `/api/teams/:id/export` | member |  |

## Roles

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/roles` | member | List available role templates |
| GET | `/api/roles/` | member | List available role templates |

## Tasks

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/tasks` | member | List tasks (supports `?status=`, `?assignedAgentId=` filters) |
| POST | `/api/tasks` | member | List tasks (supports `?status=`, `?assignedAgentId=` filters) |
| GET | `/api/tasks/scheduled` | member |  |
| GET | `/api/tasks/deliverables` | member |  |
| GET | `/api/tasks/dashboard` | member |  |
| GET | `/api/taskboard` | member | Get Kanban board data |
| GET | `/api/taskboard/summary` | member |  |
| GET | `/api/ops/dashboard` | member |  |
| GET | `/api/tasks/:id` | member | Update task (status, assignedAgentId, or task fields) |
| PUT | `/api/tasks/:id` | member | Update task (status, assignedAgentId, or task fields) |
| DELETE | `/api/tasks/:id` | member | Update task (status, assignedAgentId, or task fields) |
| POST | `/api/tasks/:id/approve` | member | Approve a pending task |
| POST | `/api/tasks/:id/reject` | member | Reject a pending task |
| POST | `/api/tasks/:id/cancel` | member | Cancel a task (body: `{ cascade?: boolean }`) |
| GET | `/api/tasks/:id/context` | member |  |
| GET | `/api/tasks/:id/dependents` | member | Count tasks blocked by this task |
| POST | `/api/tasks/:id/run` | member |  |
| GET | `/api/tasks/:id/subtasks` | member |  |
| POST | `/api/tasks/:id/subtasks` | member |  |
| DELETE | `/api/tasks/:id/subtasks/:id` | member |  |
| POST | `/api/tasks/:id/subtasks/:id/complete` | member |  |
| POST | `/api/tasks/:id/subtasks/:id/cancel` | member |  |
| GET | `/api/tasks/:id/comments` | member | Post a comment on a task. Body: `{ content, mentions?, authorId?, authorType?, replyTo? }`. `replyTo` is a comment ID for structural reply linking. |
| POST | `/api/tasks/:id/comments` | member | Post a comment on a task. Body: `{ content, mentions?, authorId?, authorType?, replyTo? }`. `replyTo` is a comment ID for structural reply linking. |
| GET | `/api/tasks/:id/history` | member |  |
| POST | `/api/tasks/:id/pause` | member |  |
| POST | `/api/tasks/:id/resume` | member |  |
| POST | `/api/tasks/:id/retry` | member |  |
| POST | `/api/tasks/:id/revision` | member | Request revision |
| POST | `/api/tasks/:id/accept` | member | Accept task delivery |
| POST | `/api/tasks/:id/archive` | member | Archive task |
| POST | `/api/tasks/:id/request-approval` | member |  |
| PUT | `/api/tasks/:id/schedule` | member | Update schedule configuration `{ every?, cron?, maxRuns?, timezone? }` |
| POST | `/api/tasks/:id/schedule/pause` | member | Pause a scheduled task's recurring schedule |
| POST | `/api/tasks/:id/schedule/resume` | member | Resume a paused scheduled task |
| POST | `/api/tasks/:id/schedule/run-now` | member | Trigger an immediate run of a scheduled task |
| GET | `/api/tasks/:id/logs` | member |  |
| GET | `/api/tasks/:id/logs/summary` | member |  |

## Execution

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/execution-logs` | member |  |

## Deliverables / Knowledge

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/deliverables` | member |  |
| POST | `/api/deliverables` | member |  |
| GET | `/api/deliverables/health` | member |  |
| GET | `/api/deliverables/:id` | member |  |
| PUT | `/api/deliverables/:id` | member |  |
| DELETE | `/api/deliverables/:id` | member |  |
| POST | `/api/knowledge` | member | Contribute knowledge |
| GET | `/api/knowledge/search` | member | Search knowledge base |
| DELETE | `/api/knowledge/:id` | member |  |
| POST | `/api/knowledge/:id/flag-outdated` | member |  |
| POST | `/api/knowledge/:id/verify` | member |  |

## Reviews

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/reviews` | member |  |
| POST | `/api/reviews` | member |  |
| GET | `/api/reviews/:id` | member |  |

## Requirements

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/requirements` | member |  |
| POST | `/api/requirements` | member |  |
| GET | `/api/requirements/:id` | member |  |
| PUT | `/api/requirements/:id` | member |  |
| DELETE | `/api/requirements/:id` | member |  |
| POST | `/api/requirements/:id/status` | member |  |
| POST | `/api/requirements/:id/approve` | member |  |
| POST | `/api/requirements/:id/tasks/approve-bulk` | member |  |
| POST | `/api/requirements/:id/reject` | member |  |
| POST | `/api/requirements/:id/cancel` | member |  |
| POST | `/api/requirements/:id/request-approval` | member |  |
| GET | `/api/requirements/:id/comments` | member | Post a comment on a requirement. Body: `{ content, mentions?, authorId?, authorType?, replyTo? }`. `replyTo` is a comment ID for structural reply linking. |
| POST | `/api/requirements/:id/comments` | member | Post a comment on a requirement. Body: `{ content, mentions?, authorId?, authorType?, replyTo? }`. `replyTo` is a comment ID for structural reply linking. |
| GET | `/api/requirements/:id/history` | member |  |

## Projects

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/projects` | member | List projects |
| POST | `/api/projects` | member | List projects |
| POST | `/api/projects/:id/knowledge/sync` | member |  |
| GET | `/api/projects/:id` | member | Get project |
| PUT | `/api/projects/:id` | member | Get project |
| DELETE | `/api/projects/:id` | member | Get project |

## Milestones (里程碑)

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/milestones` | member | List a project's milestones, each carrying progress derived from its requirements |
| POST | `/api/milestones` | member | List a project's milestones, each carrying progress derived from its requirements |
| GET | `/api/milestones/:id` | member | Get / update / delete one milestone; delete unlinks its requirements (never deletes them) |
| PUT | `/api/milestones/:id` | member | Get / update / delete one milestone; delete unlinks its requirements (never deletes them) |
| DELETE | `/api/milestones/:id` | member | Get / update / delete one milestone; delete unlinks its requirements (never deletes them) |

## Notifications

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/notifications` | member |  |
| POST | `/api/notifications` | member |  |
| POST | `/api/notifications/mark-all-read` | member | Mark all notifications as read |
| POST | `/api/notifications/` | member | List notifications for current user (supports `?unread=true&limit=N&offset=N&type=T`) |

## Message search

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/messages/search` | member |  |

## Activity feed

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/activity` | member |  |

## Users

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/users` | member | List human users (includes `hasJoined` flag) |
| POST | `/api/users` | admin | List human users (includes `hasJoined` flag) |
| PATCH | `/api/users/:id` | admin | Update user (name, role, email) |
| POST | `/api/users/:id/reset-password` | admin | Admin password reset |
| POST | `/api/users/:id/reinvite` | admin | Re-issue an invite token — returns `{ inviteToken }` |
| DELETE | `/api/users/` | admin | List human users (includes `hasJoined` flag) |

## API Keys

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/keys` | member |  |
| POST | `/api/keys` | member |  |
| DELETE | `/api/keys/` | member |  |

## Orgs

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/orgs` | member |  |
| POST | `/api/orgs` | member |  |
| POST | `/api/orgs/:id/cross-org-policy` | member |  |

## Message

| Method | Path | Min role | Description |
|---|---|---|---|
| POST | `/api/message` | member |  |

## Skills

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/skills` | member |  |
| GET | `/api/skills/builtin` | member |  |
| POST | `/api/skills/install` | member |  |
| GET | `/api/skills/registry` | member |  |
| GET | `/api/skills/registry/skillhub` | member |  |
| GET | `/api/skills/registry/skillssh` | member |  |
| GET | `/api/skills/:id` | member |  |
| GET | `/api/skills/:id/files` | member |  |
| DELETE | `/api/skills/installed/` | member |  |

## Model Catalog

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/models/catalog` | member |  |
| GET | `/api/models/catalog/:id` | member |  |
| POST | `/api/models/catalog/refresh` | owner |  |
| POST | `/api/models/validate-key` | member |  |
| GET | `/api/models/live/:id` | member |  |

## Settings

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/license` | owner |  |
| POST | `/api/license/refresh` | owner |  |
| POST | `/api/license/activate` | owner |  |
| POST | `/api/license/trial` | owner |  |
| POST | `/api/license/import` | owner |  |
| POST | `/api/license/deactivate` | owner |  |
| GET | `/api/settings/telemetry` | member |  |
| POST | `/api/settings/telemetry` | admin |  |
| GET | `/api/cu/status` | member |  |
| GET | `/api/settings/hub` | member |  |
| GET | `/api/settings/org` | member |  |
| PUT | `/api/settings/org` | admin |  |
| POST | `/api/settings/org` | admin |  |
| GET | `/api/settings/hub-token` | member |  |
| POST | `/api/settings/hub-token` | member |  |
| POST | `/api/settings/subscription-key` | owner |  |
| GET | `/api/settings/llm` | member |  |
| POST | `/api/settings/llm` | admin |  |
| GET | `/api/settings/llm/models` | member |  |
| POST | `/api/settings/llm/restore-recommended` | admin |  |
| POST | `/api/settings/llm/sync-openrouter` | admin |  |
| GET | `/api/settings/llm/routing` | member |  |
| GET | `/api/settings/agent` | member | Get agent runtime settings |
| POST | `/api/settings/agent` | admin | Get agent runtime settings |
| GET | `/api/settings/network` | member |  |
| POST | `/api/settings/network` | owner |  |
| GET | `/api/settings/browser` | member |  |
| POST | `/api/settings/browser` | admin |  |
| GET | `/api/settings/browser/check` | member |  |
| POST | `/api/settings/browser/test-auto-click` | admin |  |
| POST | `/api/settings/browser/test-concurrent` | admin |  |
| DELETE | `/api/settings/browser/test-concurrent` | admin |  |
| GET | `/api/settings/search` | member |  |
| POST | `/api/settings/search` | admin |  |
| POST | `/api/settings/search/test` | admin |  |
| GET | `/api/settings/env-models` | member |  |
| POST | `/api/settings/env-models` | owner |  |
| GET | `/api/settings/detect-ollama` | member |  |
| POST | `/api/settings/export` | owner |  |
| POST | `/api/settings/import` | owner |  |
| POST | `/api/settings/import/openclaw` | owner |  |
| PATCH | `/api/settings/llm/providers/:id` | owner |  |
| PUT | `/api/settings/llm/providers/:id` | owner |  |
| DELETE | `/api/settings/llm/providers/:id` | owner |  |
| POST | `/api/settings/llm/providers` | owner |  |
| POST | `/api/settings/llm/providers/:id/models` | owner |  |
| DELETE | `/api/settings/llm/providers/:id/models/:id` | owner |  |
| POST | `/api/settings/llm/providers/:id/model` | owner |  |
| POST | `/api/settings/llm/providers/:id/toggle` | owner |  |
| POST | `/api/settings/llm/providers/:id/test` | owner |  |
| GET | `/api/settings/oauth/providers` | member |  |
| GET | `/api/settings/oauth/profiles` | member |  |
| POST | `/api/settings/oauth/login` | admin |  |
| POST | `/api/settings/oauth/callback` | admin |  |
| GET | `/api/settings/oauth/status` | member |  |
| DELETE | `/api/settings/oauth/profiles/:id` | admin |  |
| POST | `/api/settings/oauth/setup-token` | admin |  |

## Integrations

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/settings/integrations` | member |  |
| GET | `/api/settings/integrations/:id` | member |  |
| POST | `/api/settings/integrations/:id` | admin |  |
| DELETE | `/api/settings/integrations/:id` | admin |  |
| POST | `/api/settings/integrations/:id/test` | admin |  |
| GET | `/api/settings/integrations/instances` | member | otherwise a wrong method falls through to 404 instead of 405. |
| POST | `/api/settings/integrations/instances` | admin | otherwise a wrong method falls through to 404 instead of 405. |
| GET | `/api/settings/integrations/instances/:id` | member |  |
| POST | `/api/settings/integrations/instances/:id` | admin |  |
| DELETE | `/api/settings/integrations/instances/:id` | admin |  |
| POST | `/api/settings/integrations/instances/:id/test` | admin |  |
| GET | `/api/settings/integrations/instances/:id/connection-test` | member |  |
| POST | `/api/settings/integrations/instances/:id/connection-test` | admin |  |
| GET | `/api/settings/integrations/instances/:id/channels` | member |  |
| PUT | `/api/settings/integrations/instances/:id/channels` | admin |  |
| GET | `/api/settings/integrations/feishu/notifications` | member |  |
| PUT | `/api/settings/integrations/feishu/notifications` | admin |  |
| GET | `/api/settings/integrations/feishu/chats` | member |  |
| POST | `/api/settings/integrations/feishu/test-message` | admin |  |
| POST | `/api/settings/integrations/feishu/register` | admin |  |
| GET | `/api/settings/integrations/feishu/register/status` | member |  |

## Approvals

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/approvals` | member |  |
| POST | `/api/approvals` | member |  |
| POST | `/api/approvals/` | member |  |

## Usage

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/usage` | member |  |
| GET | `/api/usage/agents` | member |  |

## Audit

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/audit` | member |  |
| GET | `/api/audit/summary` | member |  |
| GET | `/api/audit/tokens` | member |  |
| GET | `/api/facts` | member | Read facts — active rows plus their verification state |

## Plan

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/plan` | member |  |
| POST | `/api/plan` | member |  |

## Reports

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/reports` | member | List reports |
| POST | `/api/reports/generate` | member | Trigger report generation |
| GET | `/api/reports/:id` | member | Report details |
| POST | `/api/reports/:id/plan/approve` | member | Approve plan |
| POST | `/api/reports/:id/plan/reject` | member | Reject plan |
| GET | `/api/reports/:id/feedback` | member | Get report feedback |
| POST | `/api/reports/:id/feedback` | member | Get report feedback |

## Gateway

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/gateway/info` | member |  |
| POST | `/api/gateway/register` | member |  |
| POST | `/api/gateway/auth` | member |  |
| POST | `/api/gateway/message` | member |  |
| GET | `/api/gateway/status` | member |  |
| GET | `/api/gateway/manual` | member |  |
| GET | `/api/gateway/team` | member |  |
| GET | `/api/gateway/projects` | member |  |
| GET | `/api/gateway/requirements` | member |  |
| GET | `/api/gateway/deliverables` | member |  |
| POST | `/api/gateway/deliverables` | member |  |
| POST | `/api/gateway/sync` | member |  |
| PUT | `/api/gateway/deliverables/:id` | member |  |
| POST | `/api/gateway/tasks/(:id)/(accept|progress|complete|fail|delegate|subtasks)` | member |  |

## Builder

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/builder/artifacts` | admin |  |
| GET | `/api/builder/artifacts/installed` | admin |  |
| POST | `/api/builder/artifacts/save` | admin |  |
| POST | `/api/builder/artifacts/import` | admin |  |
| GET | `/api/builder/artifacts/agents?/(:id)` | admin |  |
| DELETE | `/api/builder/artifacts/agents?/(:id)` | admin |  |
| GET | `/api/builder/artifacts/teams?/(:id)` | admin |  |
| DELETE | `/api/builder/artifacts/teams?/(:id)` | admin |  |
| GET | `/api/builder/artifacts/skills?/(:id)` | admin |  |
| DELETE | `/api/builder/artifacts/skills?/(:id)` | admin |  |
| POST | `/api/builder/artifacts/agents?/(:id)/ensure-slug` | admin |  |
| POST | `/api/builder/artifacts/teams?/(:id)/ensure-slug` | admin |  |
| POST | `/api/builder/artifacts/skills?/(:id)/ensure-slug` | admin |  |
| POST | `/api/builder/artifacts/agents?/(:id)/install` | admin |  |
| POST | `/api/builder/artifacts/teams?/(:id)/install` | admin |  |
| POST | `/api/builder/artifacts/skills?/(:id)/install` | admin |  |
| POST | `/api/builder/artifacts/agents?/(:id)/uninstall` | admin |  |
| POST | `/api/builder/artifacts/teams?/(:id)/uninstall` | admin |  |
| POST | `/api/builder/artifacts/skills?/(:id)/uninstall` | admin |  |
| POST | `/api/builder/artifacts/agents?/(:id)/images` | admin |  |
| POST | `/api/builder/artifacts/teams?/(:id)/images` | admin |  |
| POST | `/api/builder/artifacts/skills?/(:id)/images` | admin |  |
| GET | `/api/builder/artifacts/agents?/(:id)/images/(:id)` | admin |  |
| DELETE | `/api/builder/artifacts/agents?/(:id)/images/(:id)` | admin |  |
| GET | `/api/builder/artifacts/teams?/(:id)/images/(:id)` | admin |  |
| DELETE | `/api/builder/artifacts/teams?/(:id)/images/(:id)` | admin |  |
| GET | `/api/builder/artifacts/skills?/(:id)/images/(:id)` | admin |  |
| DELETE | `/api/builder/artifacts/skills?/(:id)/images/(:id)` | admin |  |

## Hub

| Method | Path | Min role | Description |
|---|---|---|---|
| POST | `/api/hub/publish` | owner |  |
| GET | `/api/hub/` | member |  |
| POST | `/api/hub/` | member |  |
| PUT | `/api/hub/` | member |  |
| PATCH | `/api/hub/` | member |  |

## Templates

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/templates` | member |  |
| POST | `/api/templates/instantiate` | admin |  |
| GET | `/api/templates/teams` | member |  |
| GET | `/api/templates/:id` | member |  |

## Team Templates

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/team-templates` | member |  |
| POST | `/api/team-templates` | admin |  |
| GET | `/api/team-templates/` | member |  |
| DELETE | `/api/team-templates/` | admin |  |

## Governance / Workflows

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/governance/policy` | member | View governance policy |
| PUT | `/api/governance/policy` | member | View governance policy |
| GET | `/api/teams/:id/workflows` | member |  |
| POST | `/api/teams/:id/workflows` | admin |  |
| GET | `/api/teams/:id/workflows/:id` | member |  |
| PUT | `/api/teams/:id/workflows/:id` | admin |  |
| DELETE | `/api/teams/:id/workflows/:id` | admin |  |
| GET | `/api/teams/:id/workflows/:id/roles` | member |  |
| GET | `/api/teams/:id/workflows/:id/runs` | member |  |
| POST | `/api/teams/:id/workflows/:id/runs` | admin |  |
| GET | `/api/workflow-runs/:id` | member |  |
| DELETE | `/api/workflow-runs/:id` | member |  |

## System

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/health` | member | Health check (returns `{ status, version, agents }`) |
| POST | `/api/health` | member | Health check (returns `{ status, version, agents }`) |
| PUT | `/api/health` | member | Health check (returns `{ status, version, agents }`) |
| PATCH | `/api/health` | member | Health check (returns `{ status, version, agents }`) |
| DELETE | `/api/health` | member | Health check (returns `{ status, version, agents }`) |
| OPTIONS | `/api/health` | member | Health check (returns `{ status, version, agents }`) |
| GET | `/api/evolution/metrics` | member |  |
| POST | `/api/system/emergency-stop` | admin | Emergency stop |
| GET | `/api/system/status` | member | Global status (paused/emergency mode) |
| GET | `/api/browser/tab-ownership` | member |  |
| GET | `/api/terminal/session-ownership` | member |  |
| GET | `/api/system/storage` | member | Disk usage: org breakdown + per-agent buckets (see note) |
| GET | `/api/system/info` | member |  |
| GET | `/api/system/storage/orphans` | member | Detect orphaned agent/team directories |
| DELETE | `/api/system/storage/orphans` | owner | Detect orphaned agent/team directories |
| GET | `/api/system/announcements` | member | Get system announcements |
| POST | `/api/system/announcements` | admin | Get system announcements |
| POST | `/api/system/open-path` | owner |  |

## Files

| Method | Path | Min role | Description |
|---|---|---|---|
| POST | `/api/files/check` | member |  |
| GET | `/api/files/preview` | member |  |
| GET | `/api/files/stat` | member |  |
| GET | `/api/files/stream` | member |  |
| GET | `/api/files/image` | member |  |
| POST | `/api/files/reveal` | member |  |
| POST | `/api/files/write` | owner |  |

## External Agents

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/external-agents` | admin |  |
| POST | `/api/external-agents/register` | admin |  |
| DELETE | `/api/external-agents/:id` | admin |  |

## Handled in route(), previously missing from this table

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/auth/status` | member | of the 405 it deserves, which made the surface look smaller than it is. |
| POST | `/api/auth/init` | member |  |
| GET | `/api/unread` | member |  |
| POST | `/api/unread/` | member |  |
| GET | `/api/settings/remote` | owner |  |
| POST | `/api/settings/remote` | owner |  |
| GET | `/api/settings/coding-tools` | member |  |
| POST | `/api/settings/coding-tools` | admin |  |
| GET | `/api/settings/coding-tools/detect` | member |  |
| POST | `/api/settings/oauth/device-code` | admin |  |
| GET | `/api/models/live/` | member |  |
| GET | `/api/models/routing-candidates` | member |  |
| GET | `/api/models/suggested-assignments` | member |  |
| GET | `/api/llm/provider-catalog` | member |  |
| GET | `/api/sessions/has-any` | member |  |
| POST | `/api/sessions/stream/status` | member |  |
