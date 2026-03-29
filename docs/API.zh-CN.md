# Markus API 参考文档

基础 URL：`http://localhost:8056`

所有请求均需认证，支持以下方式之一：
- **JWT Cookie**：`markus_token`（登录后自动设置）
- **请求头**：`Authorization: Bearer <token>`

---

## 认证

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| POST | `/api/auth/login` | 登录，返回 JWT Cookie |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 获取当前用户信息 |
| POST | `/api/auth/change-password` | 修改密码 |

---

## Agent 管理

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/agents` | 列出所有 agent |
| POST | `/api/agents` | 雇佣新 agent `{ name, role, description }` |
| GET | `/api/agents/:id` | 获取 agent 详情 |
| DELETE | `/api/agents/:id` | 解雇 agent |
| POST | `/api/agents/:id/start` | 启动 agent |
| POST | `/api/agents/:id/stop` | 停止 agent |
| GET | `/api/agents/:id/profile` | 获取 agent 完整档案（记忆、工具等） |

---

## 消息与对话

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| POST | `/api/agents/:id/message` | 向 agent 发送消息（SSE 流式） |
| GET | `/api/sessions` | 列出对话会话 |
| GET | `/api/sessions/:id/messages` | 获取会话消息历史 |
| GET | `/api/channels/:channel/messages` | 获取频道历史 |
| POST | `/api/channels/:channel/messages` | 发送频道消息（支持 SSE 流式） |

---

## 任务

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/tasks` | 列出任务（支持 `?status=`、`?assignedAgentId=` 筛选） |
| POST | `/api/tasks` | 创建任务 |
| GET | `/api/taskboard` | 获取看板数据 |
| PATCH | `/api/tasks/:id` | 更新任务（状态、备注等） |

---

## 团队

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/teams` | 列出团队 |
| POST | `/api/teams` | 创建团队 |
| GET | `/api/teams/:id` | 获取团队详情 |
| PUT | `/api/teams/:id` | 更新团队 |
| DELETE | `/api/teams/:id` | 删除团队 |

---

## 治理与系统控制

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/system/status` | 全局状态（暂停/紧急模式） |
| POST | `/api/system/pause-all` | 暂停所有 agent |
| POST | `/api/system/resume-all` | 恢复所有 agent |
| POST | `/api/system/emergency-stop` | 紧急停止 |
| GET | `/api/system/announcements` | 获取系统公告 |
| POST | `/api/system/announcements` | 创建系统公告 |
| GET | `/api/governance/policy` | 查看治理策略 |
| PUT | `/api/governance/policy` | 更新治理策略 |

---

## 项目

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/projects` | 列出项目 |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects/:id` | 获取项目 |
| PUT | `/api/projects/:id` | 更新项目 |
| DELETE | `/api/projects/:id` | 删除项目 |

---

## 交付与评审

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| POST | `/api/tasks/:id/accept` | 验收任务交付 |
| POST | `/api/tasks/:id/revision` | 请求修订 |
| POST | `/api/tasks/:id/archive` | 归档任务 |

---

## 报告与知识库

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/reports` | 列出报告 |
| POST | `/api/reports/generate` | 触发报告生成 |
| GET | `/api/reports/:id` | 报告详情 |
| POST | `/api/reports/:id/plan/approve` | 批准计划 |
| POST | `/api/reports/:id/plan/reject` | 拒绝计划 |
| GET | `/api/reports/:id/feedback` | 获取报告反馈 |
| POST | `/api/reports/:id/feedback` | 创建报告反馈 |
| POST | `/api/knowledge` | 贡献知识 |
| GET | `/api/knowledge/search` | 搜索知识库 |

---

## 用户

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/users` | 列出人类用户 |
| POST | `/api/users` | 创建人类用户 |
| PUT | `/api/users/:id` | 更新用户信息 |
| DELETE | `/api/users/:id` | 删除用户 |

---

## 角色

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/roles` | 列出可用角色模板 |
| GET | `/api/roles/:name` | 获取角色模板详情 |

---

## 健康检查

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/health` | 健康检查（返回 `{ status, version, agents }`） |

---

## WebSocket

**连接**：`ws://localhost:8056`

| 事件 | 说明 |
|-------|-------------|
| `agent:update` | Agent 状态变更 |
| `task:update` | 任务状态更新 |
| `chat` | 频道内 Agent 消息 |
| `system:announcement` | 系统公告广播 |
| `system:pause-all` | 全局暂停事件 |
| `system:emergency-stop` | 紧急停止事件 |
