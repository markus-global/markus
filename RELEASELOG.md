# Release Log

## v0.4.13

### Highlights

全新邮箱系统（Mailbox）取代旧的 A2A Bus，统一 agent 间通信与用户通知；新增 CLI 管理命令（model / channel / auth / doctor），大幅提升开箱体验；启动流程加入动画进度展示。

### New Features

- **Mailbox 系统** — 退役 A2ABus，所有 agent 间消息路由统一走 mailbox，新增集中式类型注册和统一 Mind Tab 展示
- **用户通知体系** — 新增 `notify_user` + `request_user_chat` 双模式 agent-用户通信，持久化通知存储（SQLite），支持 actionable deep-link 通知
- **CLI 命令扩展** — 新增 `markus model`、`markus models`、`markus channel`、`markus auth`、`markus doctor` 命令，用于管理 LLM 提供商和通道
- **启动动画进度** — TTY 感知的动画渲染启动进度条，启动后自动打开浏览器
- **评论上下文协议** — agent 回复 task/requirement 评论前，强制先拉取完整状态和历史评论，避免无上下文的空泛回复
- **通知深度链接** — 点击通知可直接跳转到对应的 task、requirement 或 chat session

### Refactoring

- **移除 ephemeral session** — 统一所有 LLM 调用为持久化 session，消除 ~30 个 `isEphemeral` 分支判断，简化核心代码路径
- **统一导航配置** — 集中路由配置到 `routes.ts`，页面重命名（Dashboard → Home, Projects → Work, Chat → Team），修复 UI 问题

### Enhancements

- Slack / 飞书 / WhatsApp adapter 富消息支持增强
- 用户交互（human_chat / task_comment）提升为优先级 0（critical），始终抢占非用户任务
- LLM judge prompt 展示完整 mailbox 队列，供智能决策
- 新增共享模型定义 MODEL_CATALOG

### Bug Fixes

- 修复通知点击导航 — 支持 task、requirement、chat session 的 deep-link
- 修复启动时空行问题：`write()` 丢弃渲染内容 & logger 在动画进度期间未抑制控制台输出
- 修正 ASCII banner 拼写（MARKUS）

### Stats

- 77 files changed, +8,433 / −1,672 lines

---

## v0.4.12

- Minor fixes and updates

## v0.4.11

- Minor fixes and updates

## v0.4.10

- Minor fixes and updates

## v0.4.9

- Update package dependencies

## v0.4.8

- feat: use node sqlite

## v0.4.7

- Update release notes and install script
