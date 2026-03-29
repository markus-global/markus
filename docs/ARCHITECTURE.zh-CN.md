# Markus — 技术架构

> 最后更新：2026-03

---

## 一、总览

Markus 是一个 **AI 数字员工平台**，让组织可以雇佣、管理和协调多个 AI Agent，使其像真实员工一样主动工作。平台提供完整的治理框架，包括项目管理、任务审批、工作区隔离、正式交付评审、知识共享和周期性报告。

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
│组织    │ │任务     │ │Agent    │ │Service │ │Report·Deliver   │
│管理    │ │+ 审批   │ │生命周期 │ │需求管理│ │Trust·Archive    │
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
              │  tasks · projects · reqs   │
              │  deliverables · reports    │
              │  users · chat · audit_logs │
              └───────────────────────────┘
```

---

## 二、包结构

```
packages/
├── shared/       # 共享类型、常量、工具函数（含治理/项目/知识库类型）
├── core/         # Agent 运行时（核心引擎）+ WorkspaceManager + ReviewService
├── storage/      # 数据库 Schema + Repository 层
├── org-manager/  # 组织管理 + REST API + 治理服务（Project/Report/Knowledge/Trust）
├── compute/      # Docker 沙箱管理（可选）
├── comms/        # 通信适配器（飞书等）
├── a2a/          # Agent-to-Agent 协议
├── gui/          # GUI 自动化（VNC + OmniParser）
├── web-ui/       # Web 管理界面（含治理/项目/知识库/报告页面）
└── cli/          # 命令行入口 + 服务组装
```

---

## 三、核心概念

### 3.1 Agent（数字员工）

每个 Agent 由以下组成：

| 组件 | 描述 |
|------|------|
| `ROLE.md` | 角色定义和系统提示词 |
| `SHARED.md` | 所有 Agent 共享的行为规范（治理、知识、交付等） |
| `SKILLS.md` | 技能列表（工具权限） |
| `HEARTBEAT.md` | 定时主动任务（如每天检查 Issues） |
| `POLICIES.md` | 行为规则和边界 |
| `MEMORY.md` | 长期记忆（Agent 自动维护） |
| `CONTEXT.md` | 组织上下文（共享知识库） |

**Agent 角色类型：**
- `worker` — 普通数字员工，执行具体任务
- `manager` — 组织负责人，负责任务路由、团队协调、汇报

**Agent 信任等级（Progressive Trust）：**

| 等级 | 条件 | 权限 |
|------|------|------|
| `probation` | 新 Agent 或 score < 40 | 所有任务需人工审批 |
| `standard` | score ≥ 40, 交付 ≥ 5 次 | 常规任务可自动审批 |
| `trusted` | score ≥ 60, 交付 ≥ 15 次 | 更高自治权，可评审他人 |
| `senior` | score ≥ 80, 交付 ≥ 25 次 | 最高自治权，关键评审者 |

### 3.2 组织结构

```
Organization (Org)
 ├── Teams — 共同目标的 Agent 和人类的工作组
 │    ├── Manager — 审批工作、设定方向
 │    └── Members — 执行任务的 Agent 和人类
 ├── Projects — 有仓库和治理规则的工作范围
 │    ├── Requirements — 用户授权的工作项
 │    │    └── Tasks → Subtasks — 原子工作单元
 │    ├── Knowledge Base — 共享知识（架构决策、约定、陷阱等）
 │    └── Governance Policy — 审批规则、任务上限
 └── Reports — 定期汇报 + 计划审批 + 人类反馈
```

**关系模型：**
- 一个 Team 可以参与多个 Project；一个 Project 可以由多个 Team 协作
- 每个 Task 归属于一个 Project，并关联到一个 Requirement
- 每个 Project 可以关联多个代码仓库

### 3.3 记忆与知识系统

**Agent 记忆（三层）：**

```
短期记忆 (session)        中期记忆 (daily log)       长期记忆 (MEMORY.md)
────────────────         ──────────────────          ────────────────────
· 当前对话 messages       · 每日工作摘要              · 项目关键信息
· 最近 40 条保留          · 滚动保留最近几天           · Agent 手动写入
· 超出后触发压缩           · 自动生成 & 持久化          · 永久保存
```

**项目知识库（三层作用域）：**

| 作用域 | 说明 | 工具 |
|--------|------|------|
| `personal` | Agent 个人记忆 | `memory_save` / `memory_search` |
| `project` | 项目级共享知识 | `knowledge_contribute` / `knowledge_search` |
| `org` | 组织级共享知识 | `knowledge_search` (scope=org) |

知识分类：`architecture`、`convention`、`api`、`decision`、`gotcha`、`troubleshooting`、`dependency`、`process`、`reference`

### 3.4 工具系统

**内置工具（所有 Agent 默认具备）：**

| 工具 | 描述 |
|------|------|
| `shell_execute` | 执行 Shell 命令（自动注入 Agent 身份到 git commit） |
| `file_read` / `file_write` / `file_edit` | 文件读写编辑（限定在 worktree 路径内） |
| `file_list` | 列举目录文件 |
| `web_fetch` / `web_search` | HTTP 请求 / 网络搜索 |
| `code_search` | 代码搜索（ripgrep） |
| `git_*` | Git 操作 |
| `agent_send_message` | 发消息给其他 Agent (A2A) |
| `task_create` / `task_list` / `task_update` / `task_get` / `task_assign` / `task_note` | 任务看板操作（受治理策略约束） |
| `task_submit_review` | 提交工作交付物进入评审 |
| `requirement_propose` / `requirement_list` | 需求管理 |
| `deliverable_create` / `deliverable_search` / `deliverable_list` | 共享交付物 |

**Git Commit 元数据注入：** Agent 执行 `git commit` 时，`shell_execute` 自动注入 `--author` 和 `--trailer`，包含 Agent ID、名称、Team、Org、Task ID 等信息，确保所有提交可追溯。

### 3.5 任务系统

完整的状态机规范请参见 [Task & Requirement State Machines](./STATE-MACHINES.md)。

#### 普通任务状态流

```

pending → assigned → in_progress → review → accepted → completed → archived
                   ↘ blocked                ↗ revision (返工)
                   ↘ failed / cancelled
```

| 状态 | 说明 |
|------|------|
| `pending` | 已创建，等待分配 |
| `pending_approval` | 等待人工/管理者审批 |
| `assigned` | 已分配给 Agent |
| `in_progress` | Agent 正在工作 |
| `review` | Agent 提交了交付物，等待评审 |
| `revision` | 评审要求返工 |
| `accepted` | 评审通过 |
| `completed` | 任务完成（仅普通任务）/ 定时任务不适用 |
| `archived` | 已归档 |
| `blocked` | 被依赖阻塞 |
| `failed` / `cancelled` | 失败 / 取消 |

- `accepted` 后：普通任务自动进入 `completed`；定时任务回到 `pending` 等待下次调度。
- Worker 通过 `task_submit_review` 提交评审，必须指定 `reviewer_id`。
- 系统自动通知评审者；Worker 不需要广播给所有人。

#### 定时（循环）任务状态流

```
pending → assigned → in_progress → review → accepted → pending（等待下次调度）
                                         ↗ revision → in_progress（返工）
```

- 评审通过后，定时任务回到 `pending`（而不是 `completed`）。
- `ScheduledTaskRunner` 在 `nextRunAt` 到达时触发下一次执行。
- 定时任务与普通任务走相同的评审流程。

#### 需求（Requirement）状态流

```
draft → pending_review → approved → in_progress → completed
                      ↘ rejected
                      ↘ cancelled
```

- 用户创建的需求自动 approved。
- Agent 提出的需求从 `draft` 开始，需要用户审批。
- 需求关联的所有任务完成后，需求自动标为 `completed`。

**任务治理策略（Task Governance）：**

| 审批层级 | 触发条件 | 审批人 |
|---------|---------|--------|
| `auto` | 低优先级子任务 | 无需审批 |
| `manager` | 标准任务 | Team Manager Agent |
| `human` | 高/紧急优先级、影响共享资源 | 人工审批 (HITL) |

Agent 的信任等级会动态调整实际审批层级（如 senior Agent 的 manager 级任务可自动审批）。

### 3.6 Context Engine（系统提示词构建）

每次对话前，ContextEngine 动态组装系统提示词：

1. 角色定义（ROLE.md 系统提示）
2. 共享行为规范（SHARED.md：工作流概览、治理规则、知识共享等）
3. 身份与组织感知（同事列表、管理者、人类成员）
4. **当前项目上下文**（项目名称、迭代目标、代码仓库、治理规则）
5. **当前工作区**（分支名、worktree 路径、基础分支）
6. **Agent 信任等级**（当前等级和权限说明）
7. **系统公告**（紧急/高优先级公告）
8. **人类反馈**（来自报告评审的批注和指令）
9. **项目知识库精选**（高重要度的已验证知识条目）
10. 长期记忆（MEMORY.md 摘要）
11. 相关记忆检索
12. 近期活动摘要（daily log）
13. 任务看板（当前分配的 Tasks）
14. 当前对话身份（发送者信息）
15. 环境信息（OS、工具链、运行时）

### 3.7 LLM 路由

```
LLMRouter
  ├── 主 Provider（OpenAI / Anthropic / DeepSeek）
  └── Fallback Provider（自动切换，失败重试）
```

- 支持流式（SSE）和非流式两种模式
- 请求超时：chat 60s / stream 120s
- 失败自动 fallback 到备用 Provider

---

## 四、治理框架（Governance Framework）

### 4.1 全局控制

| 功能 | 说明 |
|------|------|
| `pauseAllAgents(reason)` | 暂停所有 Agent，附带原因 |
| `resumeAllAgents()` | 恢复所有 Agent |
| `emergencyStop()` | 紧急停止：取消所有活跃任务并停止所有 Agent |
| 系统公告 | 广播消息到所有 Agent 和 UI，注入 Agent 的系统提示词 |

### 4.2 工作区隔离（Workspace Isolation）

每个任务在项目仓库中自动创建独立的 Git Worktree：

```
项目仓库/
├── .worktrees/
│   ├── task-abc123/    ← Agent A 的工作目录
│   └── task-def456/    ← Agent B 的工作目录
├── src/                ← 主分支代码（不直接修改）
└── ...
```

- 分支命名：`task/<taskId>`
- Agent 的 shell/file 工具自动限定在 worktree 路径内
- 评审通过后合并回主分支，清理 worktree

### 4.3 正式交付与评审

```
Agent 完成工作
  → task_submit_review（提交摘要、分支、测试结果）
  → 质量门禁自动检查（TypeScript 编译、ESLint、Vitest 测试）
  → 合并冲突预检查（dry-run merge）
  → Task 状态 → review
  → 评审人 accept / request revision
  → accept → 合并分支 → completed
  → revision → Agent 返工 → 重新提交
```

### 4.4 周期性报告

| 报告类型 | 频率 | 内容 |
|---------|------|------|
| 日报 | 每日 | 任务完成/进行/阻塞，Token 消耗 |
| 周报 | 每周 | 周进展、成本趋势、下周计划（可含计划审批） |
| 月报 | 每月 | 月度汇总、成本分析、质量指标 |

**计划审批流程：** 周报中的工作计划需人工审批 → 审批通过后自动创建任务 → Agent 不得在计划审批前开始工作

**人类反馈机制：** 人类对报告的批注、评论、指令可以：
- 定向发送给特定 Agent
- 广播为系统公告
- 保存到项目知识库
- 自动生成新任务

### 4.5 归档与生命周期

- 完成的任务在可配置的天数后自动归档
- 接受的任务在合并后自动清理 worktree
- 归档的任务在可配置的天数后删除分支

### 4.6 停滞检测

| 检测条件 | 阈值 | 动作 |
|---------|------|------|
| 任务 `in_progress` 过久 | > 24h 或 2x 平均完成时间 | 警告 Agent → 上报 Manager |
| 任务 `review` 无人处理 | > 12h | 上报人工 |
| 任务 `assigned` 未开始 | > 4h | 提醒 Agent → 重新分配 |

---

## 五、数据库 Schema

```sql
-- 用户
users (id, org_id, name, email, role, password_hash, created_at, last_login_at)

-- Agent 对话
chat_sessions (id, agent_id, user_id, title, created_at, last_message_at)
chat_messages (id, session_id, agent_id, role, content, tokens_used, created_at)

-- 频道消息
channel_messages (id, org_id, channel, sender_id, sender_type, sender_name, text, mentions, created_at)

-- 任务（扩展）
tasks (id, org_id, title, description, status, priority, assigned_agent_id, subtasks,
       project_id, requirement_id, due_at, created_at, updated_at)

-- 项目
projects (id, org_id, name, description, status, repositories,
          team_ids, governance_policy, review_schedule, created_at, updated_at)

-- 需求
requirements (id, org_id, project_id, title, description, priority, status,
              source, tags, created_at, updated_at)

-- 交付物
deliverables (id, org_id, project_id, agent_id, task_id, type, title,
              summary, reference, tags, status, created_at, updated_at)

-- 项目知识库
project_knowledge (id, scope, scope_id, category, title, content, tags,
                   source, importance, status, verified_by, supersedes,
                   access_count, last_accessed_at, created_at, updated_at)

-- 报告
reports (id, type, scope, scope_id, period_start, period_end, status,
         metrics, task_summary, cost_summary, highlights, blockers, learnings,
         upcoming_plan, generated_at, generated_by, reviewed_by, reviewed_at)

-- 报告反馈
report_feedback (id, report_id, author_id, author_name, type, anchor,
                 content, priority, disclosure, actions, created_at)

-- 系统公告
system_announcements (id, type, title, content, priority, created_by,
                      target_scope, target_ids, acknowledged, created_at, expires_at)

-- 审计日志
audit_logs (id, org_id, agent_id, task_id, project_id, event_type,
            action, metadata, created_at)
```

---

## 六、认证

- JWT Cookie（`markus_token`，7 天有效期）
- 默认账号：`admin@markus.local` / `markus123`（首次登录强制修改密码）
- 权限：owner > admin > member > guest
- `owner` / `admin` 才能管理团队成员和 Agent

---

## 七、WebSocket 实时推送

连接地址：`ws://localhost:8056`

| 事件类型 | 触发时机 |
|---------|---------|
| `agent:update` | Agent 状态变更（idle/working/offline/paused） |
| `task:update` | 任务状态更新（含 review/accepted/archived） |
| `chat` | Agent 在频道中发送消息 |
| `system:announcement` | 系统公告广播 |
| `system:pause-all` | 全局暂停事件 |
| `system:emergency-stop` | 紧急停止事件 |

---

## 八、频道系统

| 频道名格式 | 用途 |
|-----------|------|
| `#general` / `#dev` / `#support` | 团队频道，可 @mention 触发 Agent |
| `notes:{userId}` | 个人记事本（不路由给任何 Agent） |
| `dm:{id1}:{id2}` | 两人私信（不路由给任何 Agent） |

---

## 九、Heartbeat（心跳任务）

Agent 启动后，HeartbeatScheduler 按配置间隔触发定时任务：

- 每次触发时，Agent 以 `[HEARTBEAT TASK]` 为提示执行检查
- **心跳包含任务复盘**：调用 task_list 检查活跃任务状态、更新过时状态
- 最多执行 5 次工具调用，避免无限循环
- **治理模式下**：服务启动时不自动恢复 in_progress 任务，需人工触发

---

## 十、Agent 感知策略（三层模型）

Agent 通过三个层次了解整个工作流和治理规则：

| 层级 | 文件 | 作用 |
|------|------|------|
| **SHARED.md（静态规范）** | `templates/roles/SHARED.md` | 所有 Agent 共享的行为规范：工作流全景图、任务治理、工作区纪律、正式交付、知识管理、信任机制、Git 提交规范、报告与反馈 |
| **ContextEngine（动态注入）** | `packages/core/src/context-engine.ts` | 每次交互动态注入：当前项目上下文、工作区信息、系统公告、人类反馈、信任等级、项目知识精选 |
| **Tools（机械执行）** | `packages/core/src/tools/` | 强制执行层：`task_create` 阻塞等待审批、`task_submit_review` 替代直接完成、shell/file 工具自动限制在 worktree 路径、git commit 自动注入元数据 |

**设计原则：**
- Agent 需要**决策**依据的 → 放入 Context（项目目标、治理规则、需求上下文）
- Agent 需要**主动操作**的 → 做成 Tool（提交评审、管理交付物、贡献知识）
- 必须**强制执行**的 → 做成透明工具行为（工作区限制、审批阻塞、提交元数据注入）

---

## 十一、部署

### 本地开发

```bash
pnpm install && pnpm build
cp markus.json.example ~/.markus/markus.json   # 填入 API key
node packages/cli/dist/index.js start
```

访问：`http://localhost:8057`（Web UI）/ `http://localhost:8056`（API）

### Docker Compose

```bash
cd deploy
docker compose up -d
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI API Key（主 LLM） |
| `ANTHROPIC_API_KEY` | Anthropic API Key（可选） |
| `DEEPSEEK_API_KEY` | DeepSeek API Key（Fallback） |
| `DATABASE_URL` | SQLite 路径覆盖（默认 `~/.markus/data.db`，格式：`sqlite:/path/to/db`） |
| `JWT_SECRET` | JWT 签名密钥（建议生产环境设置） |
| `AUTH_ENABLED` | 是否启用登录认证（默认 true） |
