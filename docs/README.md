# Markus Documentation — Single Source of Truth (SSOT)

> **目的**：本文件是 Markus 文档体系的唯一入口。所有文档从此处索引。
>
> **原则**：每个主题只有一个权威来源。遇到冲突时，以本索引指向的文件为准。

---

## 快速导航

| 需要了解... | 看这个文档 |
|-------------|-----------|
| 产品愿景与定位 | [PRODUCT.md](./PRODUCT.md) |
| 技术架构 | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| 本地开发 / 部署指南 | [GUIDE.md](./GUIDE.md) |
| 产品路线图与开发计划 | [product-strategy-and-roadmap-202603.md](./product-strategy-and-roadmap-202603.md) |
| 产品待办列表 | [PRODUCT_BACKLOG.md](./PRODUCT_BACKLOG.md) |
| OpenClaw 集成 | [OPENCLAW-INTEGRATION.md](./OPENCLAW-INTEGRATION.md) |
| GUI 自动化 | [GUI-AUTOMATION-INTEGRATION.md](./GUI-AUTOMATION-INTEGRATION.md) |
| A2A 协议设计 | [../packages/a2a/docs/structured-message-design.md](../packages/a2a/docs/structured-message-design.md) |

---

## 文档分类

### 1. 产品与战略

| 文档 | 说明 | 维护者 |
|------|------|--------|
| [PRODUCT.md](./PRODUCT.md) | 产品愿景、第一性原理、核心概念 | 产品 |
| [product-strategy-and-roadmap-202603.md](./product-strategy-and-roadmap-202603.md) | 路线图、阶段目标、技术设计 | 架构 |
| [PRODUCT_BACKLOG.md](./PRODUCT_BACKLOG.md) | 具体待办事项 | 产品 |

### 2. 技术架构与集成

| 文档 | 说明 | 维护者 |
|------|------|--------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统架构、包结构、数据流 | 架构 |
| [OPENCLAW-INTEGRATION.md](./OPENCLAW-INTEGRATION.md) | OpenClaw 配置、角色模板映射 | 架构 |
| [GUI-AUTOMATION-INTEGRATION.md](./GUI-AUTOMATION-INTEGRATION.md) | GUI 自动化集成设计 | 开发 |
| [gui-automation-tutorial.md](./gui-automation-tutorial.md) | GUI 自动化使用教程 | 开发 |

### 3. 开发流程（权威来源）

| 主题 | 权威文档 | 已废弃/合并的文档 |
|------|---------|------------------|
| 新成员入职 | [agent-development-process/guides/onboarding-guide.md](./agent-development-process/guides/onboarding-guide.md) | — |
| 开发环境搭建 | [GUIDE.md](./GUIDE.md) | ~~agent-development-process/development-environment-setup.md~~, ~~guides/development-environment-setup.md~~ |
| Code Review | [agent-development-process/guides/code-review-checklist.md](./agent-development-process/guides/code-review-checklist.md) | ~~agent-development-process/code-review-checklist.md~~ |
| Commit 规范 | [agent-development-process/guides/commit-message-guidelines.md](./agent-development-process/guides/commit-message-guidelines.md) | — |
| 测试规范 | [agent-development-process/guides/test-writing-guidelines.md](./agent-development-process/guides/test-writing-guidelines.md) | — |
| Git Worktree | [agent-development-process/guides/git-worktree-guide.md](./agent-development-process/guides/git-worktree-guide.md) | — |
| 团队培训 | [agent-development-process/guides/team-training.md](./agent-development-process/guides/team-training.md) | ~~agent-development-process/team-training-material.md~~ |
| Agent 开发工作流 | [agent-development-process/agent-development-workflow.md](./agent-development-process/agent-development-workflow.md) | — |
| 系统设计 | [agent-development-process/design.md](./agent-development-process/design.md) | — |

### 4. API 参考

API 端点定义在 `packages/org-manager/src/api-server.ts`，当前端点列表：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/agents` | GET/POST | Agent 列表 / 创建 |
| `/api/agents/:id` | GET/DELETE | Agent 详情 / 删除 |
| `/api/agents/:id/metrics` | GET | Agent 可观测性指标 |
| `/api/tasks` | GET/POST | 任务列表 / 创建 |
| `/api/tasks/:id` | GET/PUT/DELETE | 任务详情 / 更新 / 删除 |
| `/api/tasks/dashboard` | GET | 任务 Dashboard |
| `/api/ops/dashboard` | GET | 综合运营 Dashboard |
| `/api/gateway/register` | POST | 外部 Agent 注册 |
| `/api/gateway/auth` | POST | 外部 Agent 认证 |
| `/api/gateway/message` | POST | 外部 Agent 消息路由 |
| `/api/gateway/status` | GET | 外部 Agent 状态 |
| `/api/reviews` | POST/GET | 代码审查 / 审查列表 |
| `/api/reviews/:id` | GET | 审查详情 |

---

## 重复文档处理

以下文档存在重复定义，已在上方标记权威来源：

| 废弃文档 | 权威替代 | 原因 |
|---------|---------|------|
| `agent-development-process/development-environment-setup.md` | `GUIDE.md` | 内容重叠 |
| `agent-development-process/guides/development-environment-setup.md` | `GUIDE.md` | 内容重叠 |
| `agent-development-process/code-review-checklist.md` | `guides/code-review-checklist.md` | 路径层级重复 |
| `agent-development-process/team-training-material.md` | `guides/team-training.md` | 路径层级重复 |

> **注意**：废弃文档暂不删除，以防有外部引用。在下次大版本时可清理。

---

## 包结构一览

```
packages/
├── shared/     — 共享类型与工具函数
├── core/       — Agent 运行时、记忆、LLM、工具
├── storage/    — PostgreSQL 持久层 (Drizzle ORM)
├── org-manager/— 组织管理、API 服务器、任务系统
├── a2a/        — Agent-to-Agent 协议
└── web/        — React Web UI
```

## 质量标准

- **TypeScript**: strict mode 全开 (`tsconfig.base.json`)
- **测试**: Vitest, 覆盖率阈值 statements ≥ 30%
- **Lint**: ESLint + TypeScript ESLint (`eslint.config.js`)
- **提交**: 遵循 [Commit 规范](./agent-development-process/guides/commit-message-guidelines.md)
