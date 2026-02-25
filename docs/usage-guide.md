# Markus 使用指南

## 目录

- [环境要求](#环境要求)
- [快速开始 — 本地开发](#快速开始--本地开发)
- [Docker Compose 部署](#docker-compose-部署)
- [CLI 命令参考](#cli-命令参考)
- [REST API 参考](#rest-api-参考)
- [Web UI 使用](#web-ui-使用)
- [角色模板管理](#角色模板管理)
- [飞书集成](#飞书集成)
- [持久化存储配置](#持久化存储配置)
- [架构概览](#架构概览)

---

## 环境要求

| 依赖 | 最低版本 | 用途 |
|------|---------|------|
| Node.js | 20.0.0+ | 运行时 |
| pnpm | 9.0.0+ | 包管理 |
| Docker | 24.0+ | Agent 沙箱容器（可选） |
| PostgreSQL | 16+ | 持久化存储（可选，Docker Compose 自带） |
| Redis | 7+ | 消息队列/缓存（可选，Docker Compose 自带） |

## 快速开始 — 本地开发

### 1. 克隆并安装

```bash
git clone <repo-url> markus
cd markus
pnpm install
```

### 2. 构建所有包

```bash
pnpm build
```

成功后会看到 11 个 workspace 包依次编译完成。

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，至少填写一个 LLM API Key：

```bash
# 三选一即可（也可同时配多个）
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-xxx

# DeepSeek（OpenAI 兼容）
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

当没有 Anthropic Key 时，DeepSeek 会自动成为默认 LLM 提供商。

### 4. 启动服务

```bash
node packages/cli/dist/index.js start
```

输出示例：

```
Starting Markus server...
  Markus is running!
  API Server:  http://localhost:3001
  Web UI:      Open packages/web-ui in a browser
  WebUI Comm:  http://localhost:3002
```

### 5. 查看可用角色

```bash
node packages/cli/dist/index.js role:list
```

输出：

```
Available Role Templates:
────────────────────────────────────
  developer
  product-manager
  operations
```

### 6. 创建数字员工

```bash
node packages/cli/dist/index.js agent:create --name Alice --role developer
```

### 7. 与数字员工对话（CLI 模式）

```bash
node packages/cli/dist/index.js agent:chat --id agt_xxxx
```

---

## Docker Compose 部署

适用于 VPS / 服务器环境，一键启动 Markus + PostgreSQL + Redis。

### 1. 准备配置

```bash
cp .env.example .env
# 编辑 .env 填入 API Key 和其他配置
```

### 2. 启动全部服务

```bash
cd deploy
docker compose up -d
```

这会启动三个容器：

| 服务 | 端口 | 说明 |
|------|------|------|
| `markus-server` | 3001, 3002, 9000 | 主服务（API + WebUI Comm + Feishu Webhook） |
| `markus-postgres` | 5432 | PostgreSQL 数据库 |
| `markus-redis` | 6379 | Redis |

### 3. 数据库初始化（首次部署）

```bash
cd packages/storage
DATABASE_URL=postgresql://markus:markus@localhost:5432/markus npx drizzle-kit push
```

### 4. 查看日志

```bash
docker compose logs -f markus
```

### 5. 停止服务

```bash
docker compose down
```

数据默认持久化在 Docker volume 中，`down` 不会删除数据。若要清除数据：

```bash
docker compose down -v
```

---

## CLI 命令参考

```
markus <command> [options]
```

| 命令 | 说明 | 参数 |
|------|------|------|
| `start` | 启动 API 服务器 + 通信层 + WebSocket | `--port, -p` API 端口 |
| `agent:list` | 列出所有数字员工 | |
| `agent:create` | 创建数字员工 | `--name, -n` 名称; `--role, -r` 角色名 |
| `agent:chat` | 与数字员工交互式对话 | `--id` 员工 ID |
| `agent:status` | 查看数字员工详细状态 | `--id` 员工 ID |
| `role:list` | 列出可用角色模板 | |
| `skill:list` | 列出所有已注册 Skill | |
| `skill:init` | 创建新 Skill 脚手架项目 | `--name, -n` Skill 名; `--dir, -d` 输出目录 |
| `skill:test` | 验证 Skill manifest 和源码 | `--dir, -d` Skill 目录 |
| `team:list` | 列出可用团队模板 | |
| `team:deploy` | 一键部署团队模板（批量入职 Agent） | `--template, -t` 模板名 |
| `user:list` | 列出人类成员 | |
| `user:add` | 添加人类成员 | `--name, -n`; `--role, -r` (owner/admin/member/guest); `--email` |
| `approval:list` | 列出审批请求 | |
| `approval:respond` | 审批/拒绝 | `--id`; `--approved` (true/false) |
| `bounty:list` | 列出悬赏任务 | |
| `key:list` | 列出 API Key | |
| `key:create` | 创建 API Key | `--name, -n` Key 名称 |
| `usage` | 查看用量统计 | |
| `db:init` | 初始化数据库（推送 Schema） | |
| `version` | 显示版本 | |
| `help` | 显示帮助 | |

通用选项：
- `--config, -c` — 指定 `markus.json` 配置文件路径

---

## REST API 参考

默认监听 `http://localhost:3001`，所有接口前缀 `/api`。

### 健康检查

```
GET /api/health
→ { "status": "ok", "version": "0.1.0", "agents": 2 }
```

### 数字员工管理

```
GET    /api/agents                       列出所有员工
POST   /api/agents                       创建员工 { name, roleName, orgId?, teamId? }
POST   /api/agents/:id/start             启动员工
POST   /api/agents/:id/stop              停止员工
POST   /api/agents/:id/message           发送消息 { text, senderId? } → { reply }
DELETE /api/agents/:id                    删除员工
```

### 角色模板

```
GET    /api/roles                        列出所有角色
GET    /api/roles/:name                  获取角色详情
```

### 任务管理

```
GET    /api/tasks                        列出任务（可选 ?orgId=&status=）
POST   /api/tasks                        创建任务 { title, description, priority?,
                                           assignedAgentId?, autoAssign?, requiredSkills? }
PUT    /api/tasks/:id                    更新任务 { status } 或 { assignedAgentId }
GET    /api/taskboard                    看板视图（按状态分组）
```

**自动分配**：创建任务时传 `"autoAssign": true`，系统会根据 Agent 技能匹配自动分配给最佳空闲 Agent。

### WebSocket 实时通信

连接 `ws://localhost:3001/ws` 接收实时事件：

| 事件类型 | 说明 | Payload |
|---------|------|---------|
| `connected` | 连接成功 | `{ message }` |
| `agent:update` | Agent 状态变更 | `{ agentId, status }` |
| `task:update` | 任务状态变更 | `{ taskId, status, title, assignedAgentId? }` |
| `chat:message` | 聊天消息 | `{ agentId, message, sender }` |

### 组织管理

```
GET    /api/orgs                         列出组织
POST   /api/orgs                         创建组织 { name, ownerId }
```

---

## Web UI 使用

### 开发模式

```bash
cd packages/web-ui
pnpm dev
```

访问 `http://localhost:3000`，会自动代理 API 请求到 `localhost:3001`。

### 生产构建

```bash
cd packages/web-ui
pnpm build
```

产物在 `packages/web-ui/dist/`，可以用任何静态文件服务器托管。

### 页面说明

| 页面 | 功能 |
|------|------|
| **Dashboard** | 数据概览（员工数、角色数、任务数）、雇佣新员工、管理现有员工。支持 WebSocket 实时刷新 |
| **Agents** | 员工表格视图，点击查看详情面板，启动/停止/删除。状态实时更新（working 时有脉冲动画） |
| **Task Board** | 看板视图，支持创建任务（含自动分配选项），点击任务查看详情并更改状态 |
| **Chat** | 选择一个数字员工进行实时对话，基于 DeepSeek/OpenAI/Anthropic 进行 AI 对话 |

---

## 角色模板管理

角色模板存放在 `templates/roles/<role-name>/` 目录，每个角色包含以下文件：

| 文件 | 必须 | 说明 |
|------|------|------|
| `ROLE.md` | 是 | 系统提示词，定义角色身份、能力、沟通风格 |
| `SKILLS.md` | 否 | 该角色具备的技能列表 |
| `HEARTBEAT.md` | 否 | 心跳任务定义，Agent 定期主动执行 |
| `POLICIES.md` | 否 | 行为策略/规则 |

### 创建自定义角色示例

```bash
mkdir -p templates/roles/designer
```

创建 `templates/roles/designer/ROLE.md`：

```markdown
# UI/UX Designer

You are a UI/UX designer. You create beautiful, user-friendly interfaces.

## Core Competencies
- Interface design and prototyping
- User research and usability testing
- Design system management
```

创建后重启服务，该角色即可在 `role:list` 和 API 中使用。

---

## 飞书集成

### 1. 创建飞书应用

1. 前往 [飞书开放平台](https://open.feishu.cn) 创建企业应用
2. 开通以下权限：`im:message:send_as_bot`, `im:message:receive`
3. 记录 App ID 和 App Secret

### 2. 配置环境变量

```bash
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxx
```

### 3. 配置 Webhook

将飞书事件订阅回调地址设置为：

```
http://<your-server>:9000/webhook/feishu
```

### 4. 使用

- 在飞书群中 @机器人 发送消息，消息会路由到绑定的 Agent
- Agent 回复会通过飞书机器人发送
- 支持交互式消息卡片（状态卡、任务卡、进度卡）

---

## LLM 提供商配置

Markus 支持多种 LLM 提供商，通过环境变量或 `markus.json` 配置：

| 提供商 | 环境变量 | 模型示例 | 备注 |
|--------|---------|----------|------|
| Anthropic | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 | 默认首选 |
| OpenAI | `OPENAI_API_KEY` | gpt-4o | |
| DeepSeek | `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` | deepseek-chat | OpenAI 兼容 |

优先级：有 Anthropic Key 时默认用 Anthropic；无 Anthropic 但有 DeepSeek 时默认用 DeepSeek。

也可通过 `markus.json` 指定默认提供商：

```json
{
  "llm": {
    "defaultProvider": "deepseek",
    "providers": {
      "deepseek": {
        "apiKey": "sk-xxx",
        "baseUrl": "https://api.deepseek.com"
      }
    }
  }
}
```

任何 OpenAI 兼容的 API（如 Groq、Together AI 等）都可以作为自定义提供商注册。

---

## 持久化存储配置

### 数据库迁移

```bash
cd packages/storage

# 生成迁移文件
DATABASE_URL=postgresql://markus:markus@localhost:5432/markus npx drizzle-kit generate

# 推送 schema 到数据库（开发环境推荐）
DATABASE_URL=postgresql://markus:markus@localhost:5432/markus npx drizzle-kit push

# 运行迁移（生产环境推荐）
DATABASE_URL=postgresql://markus:markus@localhost:5432/markus npx drizzle-kit migrate
```

### 数据库表结构

| 表名 | 说明 |
|------|------|
| `organizations` | 组织信息 |
| `teams` | 团队 |
| `agents` | 数字员工配置和状态 |
| `tasks` | 任务 |
| `messages` | 消息记录（飞书、WebUI 等） |
| `memories` | Agent 长期记忆 |
| `agent_channel_bindings` | Agent 与通信频道的绑定关系 |

---

## 架构概览

```
markus/
├── packages/
│   ├── shared/          类型定义、工具函数、日志
│   ├── core/            Agent 运行时（LLM 路由、上下文引擎、记忆、心跳）
│   ├── compute/         Docker 沙箱管理
│   ├── comms/           通信层（飞书、WebUI、消息路由）
│   ├── org-manager/     组织/任务管理、REST API
│   ├── storage/         PostgreSQL 持久化（Drizzle ORM）
│   ├── gui/             GUI 自动化（VNC、截图、键鼠操作）
│   ├── a2a/             Agent-to-Agent 协议（任务委托、协作）
│   ├── web-ui/          React SPA 管理界面
│   └── cli/             命令行入口
├── templates/roles/     角色模板
├── deploy/              Docker Compose / K8s 部署配置
└── docs/                文档
```

### 核心数据流

```
用户消息 → 通信层(Feishu/WebUI) → MessageRouter → Agent
                                                    ↓
                                              ContextEngine（构建上下文）
                                                    ↓
                                              LLMRouter → Anthropic/OpenAI/DeepSeek
                                                    ↓
                                              Tool 执行（Shell/File/WebFetch/WebSearch/MCP/GUI）
                                                    ↓
                                              回复 → WebSocket 广播 → 通信层 → 用户
```

### 对话持久化

Agent 的对话 session 自动保存到 `.markus/agents/<id>/sessions/` 目录。Agent 重启后会自动恢复最近的对话上下文，保证对话连续性。

### 任务自动分配流程

```
创建任务(autoAssign=true)
        ↓
  TaskService.autoAssignAgent()
        ↓
  查找所有 idle 状态 Agent
        ↓
  按 requiredSkills 技能匹配打分
        ↓
  分配给得分最高的 Agent
        ↓
  WebSocket 广播 task:update
```

---

## Phase 4 新增功能

### 流式响应 (Streaming)

Agent 消息现在支持 SSE 流式响应，用户无需等待完整回复：

```bash
# 流式消息
curl -N -X POST http://localhost:3001/api/agents/{id}/message \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello","stream":true}'

# 返回格式（SSE）
data: {"type":"text_delta","text":"Hello"}
data: {"type":"text_delta","text":" world"}
data: {"type":"message_end","usage":{...},"finishReason":"end_turn"}
data: {"type":"done","content":"Hello world"}
```

Web UI Chat 页面已自动使用流式模式，逐字显示 Agent 回复。

### Agent 内置工具

API 创建的 Agent 现在自动获得以下内置工具：

| 工具 | 说明 |
|------|------|
| `shell_execute` | 执行 shell 命令（受安全策略保护） |
| `file_read` | 读取文件（支持分页：offset/limit） |
| `file_write` | 写入文件 |
| `file_edit` | 精确编辑文件（str_replace 模式） |
| `web_fetch` | HTTP 请求 |
| `web_search` | Web 搜索 |
| `todo_write` | 创建/更新任务列表（Agent 自我规划） |
| `todo_read` | 读取当前任务列表 |

### 安全模型

内置安全策略自动阻止危险操作：

- **命令黑名单**: `sudo`, `rm -rf /`, `mkfs`, `dd if=`, `curl|bash` 等
- **路径黑名单**: `/etc/passwd`, `/.ssh/`, `id_rsa` 等
- **可配置白名单**: 支持自定义允许的命令和路径范围
- **审批机制**: 支持标记需要人工审批的命令关键字

```javascript
// 自定义安全策略
const agent = await agentManager.createAgent({
  name: 'Alice',
  roleName: 'developer',
  securityPolicy: {
    shellDenyPatterns: [/docker\s+rm/],
    pathAllowlist: ['/workspace', '/tmp'],
    requireApproval: ['git push', 'npm publish'],
  },
});
```

### 三层记忆系统

借鉴 OpenClawd 的分层记忆架构：

| 层级 | 存储 | 生命周期 | 用途 |
|------|------|---------|------|
| 短期 | Session messages | 当前对话 | 对话上下文 |
| 中期 | Daily logs (.md) | 每日 | 对话摘要日志 |
| 长期 | MEMORY.md | 永久 | 关键知识和事实 |

- **自动压缩**: 当 session 估计 token 数超过 50K 时自动触发压缩
- **记忆 flush**: 压缩前先将对话摘要写入每日日志
- **上下文注入**: 系统提示自动包含长期记忆和最近日志

### MCP 集成

Agent 创建时可配置 MCP 服务器，工具自动注入：

```javascript
const agent = await agentManager.createAgent({
  name: 'Alice',
  roleName: 'developer',
  mcpServers: {
    'github': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    'filesystem': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'] },
  },
});
```

### Agent 状态查询

```bash
# GET /api/agents/{id}
curl http://localhost:3001/api/agents/{id}

# 返回
{
  "id": "agt_xxx",
  "name": "Alice",
  "role": "Software Developer",
  "agentRole": "worker",
  "state": { "status": "idle", "tokensUsedToday": 1234 },
  "skills": ["shell_execute", "file_read_write", ...]
}
```

---

## Phase 5 新增功能

### 1. 身份认知系统

#### 人类用户管理

```bash
# 列出人类成员
GET /api/users?orgId=default

# 添加人类用户
POST /api/users
{
  "name": "John",
  "role": "admin",    # owner | admin | member | guest
  "orgId": "default",
  "email": "john@example.com"
}

# 删除人类用户
DELETE /api/users/{id}
```

#### Agent 角色 (agentRole)

创建 Agent 时可以指定 `agentRole`：
- `manager` — 组织负责人，负责消息路由、团队管理、进度汇报
- `worker` — 普通员工（默认）

```bash
POST /api/agents
{
  "name": "Markus",
  "roleName": "org-manager",
  "agentRole": "manager"
}
```

Manager Agent 额外拥有的工具：
- `team_list` — 列出所有团队成员
- `team_status` — 获取团队详细状态
- `delegate_message` — 委派消息给指定 Agent
- `create_task` — 创建并分配任务

#### 身份感知对话

发送消息时附带 `senderId`，Agent 会根据人类身份自动调整行为：
- **Owner** — 最高优先级，主动汇报
- **Admin** — 积极配合
- **Member** — 正常协作
- **Guest** — 礼貌但不暴露内部信息

### 2. 智能消息路由

```bash
# 智能路由 — 系统自动选择合适的 Agent 处理
POST /api/message
{
  "text": "这个 bug 怎么修？",
  "senderId": "user_xxx",       # 可选：人类身份
  "targetAgentId": "agt_xxx",   # 可选：指定 Agent
  "stream": true,               # 可选：流式响应
  "orgId": "default"
}

# 返回
{
  "reply": "...",
  "agentId": "agt_xxx"   # 实际处理消息的 Agent
}
```

路由优先级：
1. 明确指定 `targetAgentId` → 直接发送
2. 有 Manager Agent → 由 Manager 判断路由
3. 回退到第一个可用 Agent

### 3. Skills 系统

Skills 是可安装的能力包，为 Agent 提供特定工具。

```bash
# 列出已注册的 Skills
GET /api/skills
```

**官方内置 Skills：**

| Skill | 版本 | 工具 | 说明 |
|-------|------|------|------|
| `git` | 1.0.0 | git_status, git_diff, git_log, git_branch | Git 版本控制 |
| `code-analysis` | 1.0.0 | code_search, project_structure, code_stats | 代码分析 |

Agent 创建时，系统会根据其配置的 `skills` 列表自动注入对应的 Skill 工具。

### 4. 日报生成

```bash
# 让 Agent 生成每日工作报告
POST /api/agents/{id}/daily-report

# 返回
{
  "agentId": "agt_xxx",
  "report": "## Daily Status Report\n..."
}
```

### 5. Web UI 更新

- **Team 页面** — 管理组织成员（人类 + AI），显示 Manager 和 Worker 的层级关系
- **Workspace 页面** — 支持两种聊天模式：
  - **Smart Route** — 自动路由到合适的 Agent
  - **Direct** — 直接与指定 Agent 对话
- **Speaking as** — 选择以哪个人类身份发送消息
- **Agent 角色标识** — Dashboard 和 Agent 列表显示 Manager 标识

### 6. Organization Manager 角色模板

新增 `org-manager` 角色模板，预置：
- 消息路由和分诊能力
- 团队管理和协调能力
- 汇报和沟通策略
- 信息安全和权限升级策略

---

## Phase 6 新增功能

### 1. Web UI 增强

#### 全局命令栏
底部全局命令栏，输入文字自动路由到 Manager Agent，快速获取回答。

#### Skill Store 页面
展示所有已注册 Skill，按分类筛选，查看 Skill 详情和包含的工具列表。

#### Settings 页面
系统状态、LLM 提供商配置、集成配置、安全策略等设置项。

#### 导航优化
侧边栏按 WORKSPACE / ORGANIZATION / TOOLS & SETTINGS 三个区域分组。

### 2. Skills CLI

```bash
# 列出所有已注册 Skill
markus skill:list

# 创建新 Skill 项目脚手架
markus skill:init --name my-skill

# 测试 Skill
markus skill:test --dir ./my-skill
```

### 3. 飞书深度集成

新增 `feishu` Skill（当配置了 FEISHU_APP_ID 和 FEISHU_APP_SECRET 时自动注册），提供：

| 工具 | 功能 |
|------|------|
| `feishu_send_message` | 发送文本消息 |
| `feishu_send_card` | 发送交互式卡片消息 |
| `feishu_search_docs` | 搜索飞书文档 |
| `feishu_read_doc` | 读取文档内容 |
| `feishu_create_approval` | 创建审批实例 |
| `feishu_approval_status` | 查询审批状态 |

### 4. 浏览器能力

新增 `browser` Skill，提供网页自动化能力：

| 工具 | 功能 |
|------|------|
| `browser_navigate` | 导航到 URL 并提取页面内容 |
| `browser_screenshot` | 截图（需 Puppeteer） |
| `browser_click` | 点击元素 |
| `browser_type` | 输入文本 |
| `browser_extract` | 提取页面元素 |
| `browser_evaluate` | 执行 JavaScript |

### 5. 人机协作 (HITL)

#### 审批系统

```bash
# 查看待审批列表
GET /api/approvals?status=pending

# 创建审批请求
POST /api/approvals
{
  "agentId": "agt_xxx",
  "agentName": "Dev Agent",
  "type": "action",
  "title": "Deploy to production",
  "description": "Need approval to deploy v2.0"
}

# 审批/拒绝
POST /api/approvals/{id}
{ "approved": true, "respondedBy": "user_xxx" }
```

#### 悬赏任务

```bash
# 查看悬赏列表
GET /api/bounties?status=open

# AI 发布悬赏
POST /api/bounties
{
  "agentId": "agt_xxx",
  "agentName": "Dev Agent",
  "title": "Review database schema",
  "description": "Need human expertise on schema design"
}

# 认领悬赏
POST /api/bounties/{id}
{ "action": "claim", "userId": "user_xxx" }

# 完成悬赏
POST /api/bounties/{id}
{ "action": "complete", "result": "Schema looks good..." }
```

#### 通知系统

```bash
# 获取通知列表
GET /api/notifications?userId=default&unread=true

# 标记已读
POST /api/notifications/{id}
```

### 6. 行业角色模板

新增角色模板：

| 角色 | 说明 |
|------|------|
| `marketing` | 营销专员 — SEO、内容策略、竞品分析 |
| `support` | 客户支持 — 工单处理、知识库、SLA |
| `finance` | 财务分析 — 预算、费用、报表 |
| `hr` | 人事专员 — 招聘、入职、制度 |

团队模板（`GET /api/templates/teams`）：
- **Development Team** — 技术主管 + 前后端 + QA + DevOps
- **Marketing Team** — 营销主管 + 内容 + SEO
- **Support Team** — 支持主管 + 客服
- **Startup All-in-One** — COO + 产品 + 开发 + 营销 + 运营

### 7. 商业化基础

#### 用量计量

```bash
# 查看当前月份用量
GET /api/usage?orgId=default

# 返回
{
  "usage": { "llmTokens": 0, "toolCalls": 0, "messages": 0, "storageBytes": 0 },
  "plan": { "tier": "free", "limits": { "maxAgents": 3, ... } }
}
```

#### 套餐管理

| 套餐 | Agent 数 | 月 Token | 日消息 |
|------|---------|---------|--------|
| free | 3 | 100K | 50 |
| pro | 20 | 5M | 2000 |
| enterprise | 无限 | 无限 | 无限 |

```bash
# 设置套餐
POST /api/plan
{ "orgId": "default", "tier": "pro" }
```

#### API Key 管理

```bash
# 创建 API Key
POST /api/keys
{ "name": "Production Key", "scopes": ["*"], "expiresInDays": 90 }

# 列出 Key（隐藏完整密钥）
GET /api/keys?orgId=default

# 吊销 Key
DELETE /api/keys/{id}
```

---

### Phase 7 能力增强 (v0.7.0)

#### 9.1 观测性和审计系统

每次 LLM 调用和工具执行都自动记录到审计日志，支持 token 消耗追踪。

```bash
# 查看审计日志
GET /api/audit?limit=20&agentId=xxx&type=llm_request

# 审计摘要（事件统计 + token 汇总）
GET /api/audit/summary?orgId=default

# Token 使用详情（按 agent 分组）
GET /api/audit/tokens?orgId=default

# CLI
markus audit:log --id <agent_id> --type llm_request
markus audit:summary
```

#### 9.2 Agent 间协作 (A2A 消息总线)

所有 Agent 默认拥有 `agent_send_message` 和 `agent_list_colleagues` 工具，可以直接给同事发消息。

```bash
# API: Agent A 给 Agent B 发消息
POST /api/agents/{targetId}/a2a
{ "fromAgentId": "agt_xxx", "message": "帮我检查一下代码" }

# CLI: 发送 A2A 消息
markus agent:message --id <from_agent> --target <to_agent> --text "message"
```

Agent 也可以在对话中自主决定使用 `agent_send_message` 工具向同事求助。

#### 9.3 自适应 LLM 选型

系统根据请求复杂度自动选择最经济的模型：
- **simple**（短对话，无工具）→ 经济模型（如 DeepSeek）
- **moderate**（中等上下文，少量工具）→ 经济模型
- **complex**（长上下文，多工具）→ 强模型（如 Claude/GPT-4o）

如果首选模型失败，自动 fallback 到备选模型。

#### 9.4 Agent 成长系统

每次工具调用自动记录到 Agent 的 proficiency 数据中：

```bash
# API: 查看 agent 详情（包含 proficiency）
GET /api/agents/{id}
# 返回 proficiency: { "git_status": { uses: 5, successes: 5, lastUsed: "..." } }

# CLI: 查看 agent 成长数据
markus agent:profile --id <agent_id>
```

#### 9.5 错误恢复和韧性

- **工具重试**：失败后自动重试最多 2 次，指数退避（500ms, 1s）
- **LLM Fallback**：主模型超时/失败时自动切换备选模型
- **人工兜底**：连续 3 次失败后自动发送通知给人类管理员
