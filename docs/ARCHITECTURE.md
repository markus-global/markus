# Markus — 技术架构

> 最后更新：2026-02

---

## 一、总览

Markus 是一个 **AI 数字员工平台**，让组织可以雇佣、管理和协调多个 AI Agent，使其像真实员工一样主动工作。

```
┌──────────────────────────────────────────────────────────┐
│                      Web UI (React)                       │
│  Chat · Agents · Tasks · Team · Dashboard · Settings     │
└────────────────────────┬─────────────────────────────────┘
                         │ HTTP + WebSocket
┌────────────────────────▼─────────────────────────────────┐
│                  API Server (Node.js)                     │
│  REST API · WebSocket · Auth (JWT) · Static file serve   │
└──────┬────────────┬──────────────┬───────────────────────┘
       │            │              │
┌──────▼──────┐ ┌───▼──────┐ ┌───▼──────────┐
│ OrgService  │ │TaskService│ │ AgentManager │
│ 组织管理    │ │ 任务看板  │ │ Agent 生命周期│
└──────┬──────┘ └───┬──────┘ └───┬──────────┘
       │            │             │
┌──────▼─────────────▼─────────────▼──────────┐
│              Agent Runtime (@markus/core)     │
│  Agent · ContextEngine · LLMRouter · Memory   │
│  HeartbeatScheduler · Tools · MCP Client      │
└──────────────────────┬───────────────────────┘
                       │
          ┌────────────▼──────────────┐
          │   PostgreSQL (Drizzle ORM) │
          │  chat_sessions · messages  │
          │  tasks · users · channels  │
          └───────────────────────────┘
```

---

## 二、包结构

```
packages/
├── shared/       # 共享类型、常量、工具函数
├── core/         # Agent 运行时（核心引擎）
├── storage/      # 数据库 Schema + Repository 层
├── org-manager/  # 组织管理 + REST API Server
├── compute/      # Docker 沙箱管理（可选）
├── comms/        # 通信适配器（飞书等）
├── a2a/          # Agent-to-Agent 协议
├── gui/          # GUI 自动化（VNC + OmniParser）
├── web-ui/       # Web 管理界面
└── cli/          # 命令行入口 + 服务组装
```

---

## 三、核心概念

### 3.1 Agent（数字员工）

每个 Agent 由以下组成：

| 组件 | 描述 |
|------|------|
| `ROLE.md` | 角色定义和系统提示词 |
| `SKILLS.md` | 技能列表（工具权限） |
| `HEARTBEAT.md` | 定时主动任务（如每天检查 Issues） |
| `POLICIES.md` | 行为规则和边界 |
| `MEMORY.md` | 长期记忆（Agent 自动维护） |
| `CONTEXT.md` | 组织上下文（共享知识库） |

**Agent 角色类型：**
- `worker` — 普通数字员工，执行具体任务
- `manager` — 组织负责人，负责任务路由、团队协调、汇报

### 3.2 记忆系统（三层）

```
短期记忆 (session)        中期记忆 (daily log)       长期记忆 (MEMORY.md)
────────────────         ──────────────────          ────────────────────
· 当前对话 messages       · 每日工作摘要              · 项目关键信息
· 最近 40 条保留          · 滚动保留最近几天           · Agent 手动写入
· 超出后触发压缩           · 自动生成 & 持久化          · 永久保存
```

### 3.3 工具系统

内置工具（所有 Agent 默认具备）：

| 工具 | 描述 |
|------|------|
| `shell_execute` | 执行 Shell 命令 |
| `file_read` / `file_write` / `file_edit` | 文件读写编辑 |
| `file_list` | 列举目录文件 |
| `web_fetch` / `web_search` | HTTP 请求 / 网络搜索 |
| `code_search` | 代码搜索（ripgrep） |
| `git_*` | Git 操作 |
| `todo_write` / `todo_read` | Agent 自建任务列表 |
| `agent_send_message` | 发消息给其他 Agent (A2A) |
| `task_create` / `task_list` / `task_update` / `task_get` / `task_assign` / `task_note` | 任务看板操作 |

**Task 工具规则（强制）：** 每个 Agent 执行任何有意义的工作，必须先创建或关联一个 Task，完成后标记为 completed。

### 3.4 任务系统

```
Task 状态流：
pending → assigned → in_progress → completed
                  ↘ blocked
                  ↘ failed / cancelled
```

- 支持子任务（parentTaskId / subtaskIds）
- 支持进度备注（notes 字段，Agent 用 task_note 工具追加）
- 持久化到 PostgreSQL tasks 表
- 创建时可基于技能自动分配（autoAssign）

### 3.5 Context Engine（系统提示词构建）

每次对话前，ContextEngine 动态组装系统提示词：

1. 角色定义（ROLE.md 系统提示）
2. 身份与组织感知（同事列表、管理者、人类成员）
3. 组织上下文（CONTEXT.md）
4. 行为策略（POLICIES.md）
5. 长期记忆（MEMORY.md 摘要）
6. 相关记忆检索
7. 近期活动摘要（daily log）
8. 任务看板（当前分配的 Tasks）
9. 当前对话身份（发送者信息）

### 3.6 LLM 路由

```
LLMRouter
  ├── 主 Provider（OpenAI / Anthropic / DeepSeek）
  └── Fallback Provider（自动切换，失败重试）
```

- 支持流式（SSE）和非流式两种模式
- 请求超时：chat 60s / stream 120s
- 失败自动 fallback 到备用 Provider

---

## 四、数据库 Schema

```sql
-- 用户
users (id, org_id, name, email, role, password_hash, created_at, last_login_at)

-- Agent 对话
chat_sessions (id, agent_id, user_id, title, created_at, last_message_at)
chat_messages (id, session_id, agent_id, role, content, tokens_used, created_at)

-- 频道消息（#general / dm: / notes:）
channel_messages (id, org_id, channel, sender_id, sender_type, sender_name, text, mentions, created_at)

-- 任务
tasks (id, org_id, title, description, status, priority, assigned_agent_id, parent_task_id, due_at, created_at, updated_at)
```

---

## 五、认证

- JWT Cookie（`markus_token`，7 天有效期）
- 默认账号：`admin@markus.local` / `markus123`（首次登录强制修改密码）
- 权限：owner > admin > member > guest
- `owner` / `admin` 才能管理团队成员和 Agent

---

## 六、WebSocket 实时推送

连接地址：`ws://localhost:3001`

| 事件类型 | 触发时机 |
|---------|---------|
| `agent:update` | Agent 状态变更（idle/working/offline） |
| `task:update` | 任务状态更新 |
| `chat` | Agent 在频道中发送消息 |

---

## 七、频道系统

| 频道名格式 | 用途 |
|-----------|------|
| `#general` / `#dev` / `#support` | 团队频道，可 @mention 触发 Agent |
| `notes:{userId}` | 个人记事本（不路由给任何 Agent） |
| `dm:{id1}:{id2}` | 两人私信（不路由给任何 Agent） |

---

## 八、Heartbeat（心跳任务）

Agent 启动后，HeartbeatScheduler 按配置间隔触发定时任务：

- 每次触发时，Agent 以 `[HEARTBEAT TASK]` 为提示执行检查
- **心跳包含任务复盘**：调用 task_list 检查活跃任务状态、更新过时状态、为无任务工作创建新 Task
- 最多执行 5 次工具调用，避免无限循环

---

## 九、部署

### 本地开发

```bash
pnpm install && pnpm build
cp .env.example .env   # 填入 API key
node packages/cli/dist/index.js start
```

访问：`http://localhost:3000`（Web UI）/ `http://localhost:3001`（API）

### Docker Compose

```bash
cd deploy && cp ../.env.example .env
docker compose up -d
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI API Key（主 LLM） |
| `ANTHROPIC_API_KEY` | Anthropic API Key（可选） |
| `DEEPSEEK_API_KEY` | DeepSeek API Key（Fallback） |
| `DATABASE_URL` | PostgreSQL 连接串（可选，不设则内存模式） |
| `JWT_SECRET` | JWT 签名密钥（建议生产环境设置） |
| `AUTH_ENABLED` | 是否启用登录认证（默认 true） |
