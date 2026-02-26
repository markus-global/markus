# Markus 使用指南

---

## 目录

- [环境要求](#环境要求)
- [本地开发启动](#本地开发启动)
- [Docker Compose 部署](#docker-compose-部署)
- [环境变量](#环境变量)
- [首次登录](#首次登录)
- [Web UI 使用](#web-ui-使用)
- [REST API 参考](#rest-api-参考)
- [角色模板](#角色模板)
- [常见问题](#常见问题)

---

## 环境要求

| 依赖 | 最低版本 | 用途 |
|------|---------|------|
| Node.js | 20.0.0+ | 运行时 |
| pnpm | 9.0.0+ | 包管理 |
| PostgreSQL | 16+ | 持久化存储（可选，Docker Compose 自带） |
| Docker | 24.0+ | Agent 沙箱容器（可选） |

---

## 本地开发启动

### 1. 安装依赖

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
# 编辑 .env，填入 LLM API Key
```

### 4. 启动后端服务

在**第一个终端**中运行：

```bash
node packages/cli/dist/index.js start
```

后端 API 启动后会显示 `API server listening on port 3001`。

### 5. 启动前端开发服务器

在**第二个终端**中运行：

```bash
pnpm --filter @markus/web-ui dev
```

默认端口：
- Web UI：`http://localhost:3000`（Vite 开发服务器，自动代理 `/api` 到后端）
- API Server：`http://localhost:3001`

> **注意**：前端 Vite 开发服务器是独立进程，必须单独启动。`node packages/cli/dist/index.js start` 仅启动后端 API 服务，不包含前端。

---

## Docker Compose 部署

```bash
cd deploy
cp ../.env.example .env
# 编辑 .env

docker compose up -d
```

会自动启动：PostgreSQL + Markus 服务。

---

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `OPENAI_API_KEY` | 建议 | OpenAI API Key（主 LLM） |
| `ANTHROPIC_API_KEY` | 可选 | Anthropic API Key |
| `DEEPSEEK_API_KEY` | 可选 | DeepSeek API Key（Fallback） |
| `DATABASE_URL` | 可选 | PostgreSQL 连接串（不设则内存模式，重启丢数据） |
| `JWT_SECRET` | 建议生产 | JWT 签名密钥 |
| `AUTH_ENABLED` | 可选 | 是否启用登录（默认 true） |
| `API_PORT` | 可选 | API 端口（默认 3001） |
| `WEB_PORT` | 可选 | Web UI 端口（默认 3000） |
| `LLM_DEFAULT_PROVIDER` | 可选 | 默认 LLM Provider（openai/anthropic/deepseek） |
| `LLM_DEFAULT_MODEL` | 可选 | 默认模型（如 gpt-4o-mini） |

---

## 首次登录

默认账号：
- 邮箱：`admin@markus.local`
- 密码：`markus123`

**首次登录后系统会强制要求修改密码。**

修改后，可在「Team」页面添加更多人类成员或雇佣 AI Agent。

---

## Web UI 使用

### Chat 页面

左侧边栏选择对话对象：
- **Smart Route** — 系统自动将消息路由到最合适的 Agent
- **#频道** — 发送到公共频道，可 @mention 特定 Agent
- **Agent 列表** — 直接和某个 Agent 对话
- **People（人类）** — My Notes（个人记事本）或 DM 其他人类用户

### Agents 页面

- 点击某个 Agent 行 → 右侧展示 Profile 面板
- Profile 中可查看角色、状态、记忆、工具列表
- Start / Stop 按钮根据状态自动切换（同一时刻只显示一个）

### Tasks 页面

- Kanban 视图，按状态分栏（pending / in_progress / completed 等）
- 点击任务卡片查看详情、进度备注、子任务
- 可手动创建任务，Agent 也会自动创建

### Team 页面

- 以卡片形式展示所有团队及其成员（人类 + AI Agent）
- 未归属任何团队的成员显示在「Ungrouped」区域
- Owner / Admin 可以：
  - 创建 / 删除团队
  - 在团队内雇佣新 AI Agent（指定角色和职位 Worker/Manager）
  - 添加新人类成员或将已有成员加入团队
  - 为团队设置 Manager（在成员的 `···` 菜单中操作）
  - 将成员从团队移出（成员保留在组织中）或从组织中彻底移除
  - 所有删除 / 移除操作均有确认弹窗，不会误操作

---

## REST API 参考

所有请求需携带 Cookie（登录后自动设置）或 `Authorization: Bearer <token>` 头。

### 认证

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/auth/login` | 登录，返回 JWT Cookie |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 获取当前用户信息 |
| POST | `/api/auth/change-password` | 修改密码 |

### Agent 管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/agents` | 列出所有 Agent |
| POST | `/api/agents` | 雇佣新 Agent `{ name, role, description }` |
| GET | `/api/agents/:id` | 获取 Agent 详情 |
| DELETE | `/api/agents/:id` | 解雇 Agent |
| POST | `/api/agents/:id/start` | 启动 Agent |
| POST | `/api/agents/:id/stop` | 停止 Agent |
| GET | `/api/agents/:id/profile` | 获取 Agent 完整 Profile（记忆、工具等） |

### 消息 & 对话

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/agents/:id/message` | 向 Agent 发送消息（SSE 流式） |
| GET | `/api/sessions` | 列出对话 session |
| GET | `/api/sessions/:id/messages` | 获取 session 消息历史 |
| GET | `/api/channels/:channel/messages` | 获取频道历史 |
| POST | `/api/channels/:channel/messages` | 发送频道消息（支持 SSE 流式） |

### 任务

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/tasks` | 列出任务（支持 `?status=`、`?assignedAgentId=` 过滤） |
| POST | `/api/tasks` | 创建任务 |
| GET | `/api/taskboard` | 获取 Kanban 看板数据 |
| PATCH | `/api/tasks/:id` | 更新任务（状态、备注等） |

### 用户管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/users` | 列出人类用户 |
| POST | `/api/users` | 创建人类用户 |
| DELETE | `/api/users/:id` | 删除用户 |
| PUT | `/api/users/:id` | 更新用户信息 |

### 角色模板

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/roles` | 列出可用角色模板 |
| GET | `/api/roles/:name` | 获取角色模板详情 |

---

## 角色模板

内置角色位于 `templates/roles/`：
- `manager` — 组织负责人，处理路由和协调
- `developer` — 软件开发工程师
- `product-manager` — 产品经理
- `operations` — 运维/ops

### 创建自定义角色

在 `templates/roles/` 下创建目录：

```
templates/roles/my-role/
├── ROLE.md         # 必须：角色定义和系统提示
├── SKILLS.md       # 可选：技能和工具权限
├── HEARTBEAT.md    # 可选：定时主动任务
└── POLICIES.md     # 可选：行为规则
```

`ROLE.md` 示例：

```markdown
# 法务顾问

你是一名法务助手，专注于中国企业合规和合同审查。

## 职责
- 审查合同条款，标注风险点
- 回答员工的法律合规问题
- 跟踪重要合规截止日期

## 原则
- 对不确定的法律问题，明确说明"建议咨询专业律师"
- 不对具体案件提供最终法律意见
```

创建后可通过 API 或 Web UI 的「Hire Agent」按钮雇佣该角色的 Agent。

---

## 常见问题

**Q: 重启服务后数据丢失？**  
A: 没有设置 `DATABASE_URL`，当前运行在内存模式。设置 PostgreSQL 连接串后数据会持久化。

**Q: Agent 没有响应？**  
A: 检查 LLM API Key 是否正确配置，以及 Agent 是否处于 `online` 状态（绿色 `●`）。

**Q: 能不能不登录直接用？**  
A: 可以在环境变量中设置 `AUTH_ENABLED=false` 关闭认证（仅适合内网可信环境）。

**Q: 如何查看 Agent 的工作日志？**  
A: 打开 Agents 页面 → 点击 Agent 行 → 右侧 Profile 面板中查看。也可以在 `#general` 频道中 @Agent 触发它汇报当前状态。

**Q: 如何让 Agent 执行定时任务？**  
A: 在 Agent 对应的角色目录下创建 `HEARTBEAT.md` 文件，描述 Agent 定时应该做什么。Heartbeat 间隔可在启动配置中设置。
