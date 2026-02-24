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
# 二选一即可
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-xxx
```

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
| `start` | 启动 API 服务器 + 通信层 | `--port, -p` API 端口 |
| `agent:list` | 列出所有数字员工 | |
| `agent:create` | 创建数字员工 | `--name, -n` 名称; `--role, -r` 角色名 |
| `agent:chat` | 与数字员工交互式对话 | `--id` 员工 ID |
| `role:list` | 列出可用角色模板 | |
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
POST   /api/tasks                        创建任务 { title, description, priority?, assignedAgentId? }
GET    /api/taskboard                    看板视图（按状态分组）
```

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
| **Dashboard** | 数据概览（员工数、角色数、任务数）、雇佣新员工、管理现有员工 |
| **Agents** | 员工表格视图，查看状态、启动/停止/删除 |
| **Task Board** | 看板视图，创建任务，按 Pending/Assigned/In Progress/Completed 分列 |
| **Chat** | 选择一个数字员工进行实时对话 |

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
                                              LLMRouter → Anthropic/OpenAI
                                                    ↓
                                              Tool 执行（Shell/File/MCP/GUI）
                                                    ↓
                                              回复 → 通信层 → 用户
```
