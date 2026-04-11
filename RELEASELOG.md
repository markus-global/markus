# Release Log

## v0.4.14

前端全面 UI 优化：统一状态颜色体系、新增 Cyberpunk/Midnight 主题、通知着色、卡片视觉重设计；修复执行日志误显 Completed 问题；清理 CLI 与仓库垃圾文件。

### Enhancements

- **统一 agent 状态配色** — 全局 working=蓝色、idle=绿色、error=红色、paused=琥珀，涉及 Home / Work / Team / AgentProfile / TeamProfile / TeamModals / ChatTeamSidebar / Reports 共 12 个文件
- **新增 Cyberpunk & Midnight 主题** — `useTheme.ts` 扩展主题模式，`index.css` 新增 oklch 配色变量，Onboarding / Settings 同步更新
- **首页团队卡片优化** — 团队描述移至名称下方，flex-wrap 适配移动端
- **Work 页负责人状态着色** — assignee 名字颜色随 agent 状态动态变化
- **通知事件着色** — NotificationBell 按事件类型（completed/failed/alert/chat 等）显示不同颜色图标
- **Store 页图标清理** — 移除侧边栏和所有卡片中的装饰性图标，仅保留名称和副标题
- **卡片视觉升级** — agent/team 卡片增加悬浮阴影、顶部渐变线、hover 高亮等现代效果

### Bug Fixes

- 修复 Chat 页 working 状态显示为橘色（amber）而非蓝色
- 修复 CompactExecutionCard 在无明确完成状态时误显"✅ Completed"

### Removed

- Settings 页暂时移除 OAuth Authentication 区域
- 清理仓库垃圾文件：`concurrent-task-system-design.md`、`coverage-output.txt`、`test-heartbeat-issue.md`、`test-openclaw-config.md`、`temp-replace.ts`

### Stats

- 21 files changed, ~400 lines net

---

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
