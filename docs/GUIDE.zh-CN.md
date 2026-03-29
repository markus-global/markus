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
- [远程访问](#远程访问)
- [常见问题](#常见问题)

---

## 环境要求

| 依赖 | 最低版本 | 用途 |
|------|---------|------|
| Node.js | 20.0.0+ | 运行时 |
| pnpm | 9.0.0+ | 包管理 |
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

### 3. 配置

```bash
cp markus.json.example ~/.markus/markus.json
# 编辑 ~/.markus/markus.json，填入 LLM API Key
```

### 4. 启动后端服务

在**第一个终端**中运行：

```bash
node packages/cli/dist/index.js start
```

后端 API 启动后会显示 `API server listening on port 8056`。

### 5. 启动前端开发服务器

在**第二个终端**中运行：

```bash
pnpm --filter @markus/web-ui dev
```

默认端口：
- Web UI：`http://localhost:8057`（Vite 开发服务器，自动代理 `/api` 到后端）
- API Server：`http://localhost:8056`

> **注意**：前端 Vite 开发服务器是独立进程，必须单独启动。`node packages/cli/dist/index.js start` 仅启动后端 API 服务，不包含前端。

---

## Docker Compose 部署

```bash
cd deploy
docker compose up -d
```

会自动启动 Markus 服务。

---

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `OPENAI_API_KEY` | 建议 | OpenAI API Key（主 LLM） |
| `ANTHROPIC_API_KEY` | 可选 | Anthropic API Key |
| `DEEPSEEK_API_KEY` | 可选 | DeepSeek API Key（Fallback） |
| `DATABASE_URL` | 可选 | SQLite 路径覆盖（默认 `~/.markus/data.db`，格式：`sqlite:/path/to/db`） |
| `JWT_SECRET` | 建议生产 | JWT 签名密钥 |
| `AUTH_ENABLED` | 可选 | 是否启用登录（默认 true） |
| `API_PORT` | 可选 | API 端口（默认 8056） |
| `WEB_PORT` | 可选 | Web UI 端口（默认 8057） |
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

- Kanban 视图，按状态分栏（pending / assigned / in_progress / review / revision / accepted / completed / archived 等）
- 点击任务卡片查看详情、进度备注、子任务
- 任务详情中可执行治理操作：Submit for Review、Accept、Request Revision、Archive
- 可手动创建任务，Agent 也会自动创建（受治理策略审批约束）

### Governance 页面

- **系统状态**：查看当前是否处于暂停/紧急停止模式
- **全局控制**：一键暂停所有 Agent、恢复、紧急停止
- **治理策略**：配置默认审批层级、最大并发任务数、审批规则
- **系统公告**：创建和查看系统级广播消息

### Projects 页面

- 左侧面板列出所有项目，右侧显示选中项目的详情
- 创建新项目（名称、描述、仓库地址）
- 查看项目状态、需求、关联的 Team

### Knowledge 页面

- 浏览和搜索项目知识库
- 按作用域过滤（org / project / personal）
- 查看知识条目详情（Markdown 渲染）
- 创建新知识条目（标题、内容、分类、标签、作用域）

### Reports 页面

- 查看已生成的报告列表（日报/周报/月报）
- 手动触发报告生成（选择类型和范围）
- 查看报告详情：指标、任务摘要、成本汇总
- 审批工作计划（approve / reject）
- 对报告添加反馈（评论、指令、批注）

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

### 治理与系统控制

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/system/status` | 全局状态（暂停/紧急模式） |
| POST | `/api/system/pause-all` | 暂停所有 Agent |
| POST | `/api/system/resume-all` | 恢复所有 Agent |
| POST | `/api/system/emergency-stop` | 紧急停止 |
| GET/POST | `/api/system/announcements` | 系统公告 CRUD |
| GET/PUT | `/api/governance/policy` | 治理策略查看/更新 |

### 项目

| 方法 | 路径 | 描述 |
|------|------|------|
| GET/POST | `/api/projects` | 项目列表/创建 |
| GET/PUT/DELETE | `/api/projects/:id` | 项目详情/更新/删除 |

### 交付与评审

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/tasks/:id/accept` | 接受任务交付 |
| POST | `/api/tasks/:id/revision` | 请求修订 |
| POST | `/api/tasks/:id/archive` | 归档任务 |

### 报告与知识

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/reports` | 报告列表 |
| POST | `/api/reports/generate` | 触发报告生成 |
| GET | `/api/reports/:id` | 报告详情 |
| POST | `/api/reports/:id/plan/approve` | 审批计划 |
| POST | `/api/reports/:id/plan/reject` | 拒绝计划 |
| GET/POST | `/api/reports/:id/feedback` | 报告反馈 CRUD |
| POST | `/api/knowledge` | 贡献知识 |
| GET | `/api/knowledge/search` | 搜索知识库 |

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

## 远程访问

如需从外网访问 Markus（远程团队协作、外部 Agent 接入、移动端访问），请参阅 **[远程访问指南](./REMOTE-ACCESS.zh-CN.md)**，涵盖 Cloudflare Tunnel、Tailscale、FRP、ngrok 及安全最佳实践。

---

## 常见问题

**Q: 重启服务后数据丢失？**  
A: 数据默认存储在 SQLite（`~/.markus/data.db`）。如果该目录不存在或不可写，系统可能回退到内存模式。

**Q: Agent 没有响应？**  
A: 检查 LLM API Key 是否正确配置，以及 Agent 是否处于 `online` 状态（绿色 `●`）。

**Q: 能不能不登录直接用？**  
A: 可以在环境变量中设置 `AUTH_ENABLED=false` 关闭认证（仅适合内网可信环境）。

**Q: 如何查看 Agent 的工作日志？**  
A: 打开 Agents 页面 → 点击 Agent 行 → 右侧 Profile 面板中查看。也可以在 `#general` 频道中 @Agent 触发它汇报当前状态。

**Q: 如何让 Agent 执行定时任务？**  
A: 在 Agent 对应的角色目录下创建 `HEARTBEAT.md` 文件，描述 Agent 定时应该做什么。Heartbeat 间隔可在启动配置中设置。

**Q: 如何暂停所有 Agent？**  
A: 在 Governance 页面点击「Pause All Agents」，或调用 `POST /api/system/pause-all`。紧急情况使用「Emergency Stop」。

**Q: Agent 创建的任务需要审批吗？**  
A: 取决于治理策略（Governance Policy）。默认配置下，标准任务需要 Manager Agent 审批，高优先级任务需要人工审批。可在 Governance 页面配置。

**Q: Agent 如何共享知识？**  
A: Agent 通过 `knowledge_contribute` 工具向项目知识库贡献知识，其他 Agent 通过 `knowledge_search` 搜索。人类也可以在 Knowledge 页面查看和管理知识条目。

**Q: 如何让 Agent 在不同项目上工作？**  
A: 在 Projects 页面创建项目并关联 Team。Agent 被分配到项目内的迭代任务时，会自动获得项目上下文和隔离的工作区。
