# Release Log

## v0.4.16

WorkspaceManager 完全移除，API Server 状态检查增强，deny-only 跨代理隔离策略替代白名单模式。

### Refactoring

- **WorkspaceManager 完全移除** — 删除 `packages/core/src/workspace-manager.ts`，相关代码迁移至 agent 端本地管理，`TaskWorkspace` 替换为 `TaskProjectContext`，支持多仓库场景
- **deny-only 跨代理隔离策略** — 白名单工作区策略重构为拒绝式隔离，agents 默认可以访问所有工作区，除非明确禁止，降低配置复杂度

### Bug Fixes

- **API Server 执行端点简化** — `/run`、`/resume`、`/retry` 端点移除冗余的状态前置检查，统一由 `runTask` 内部处理状态验证，简化调用链路

### Breaking Changes

- `TaskWorkspace` 接口已移除，请使用 `TaskProjectContext`：
  ```typescript
  // Before (已移除)
  interface TaskWorkspace {
    worktreePath: string;
    branch: string;
    baseBranch: string;
  }
  
  // After
  interface TaskProjectContext {
    project: { id: string; name: string; description: string; status: string };
    repositories: Array<{ localPath: string; defaultBranch: string; role: string }>;
  }
  ```

### Stats

- 24 files changed, +137 / −536 lines

---

## v0.4.15

Secretary 统一建设者角色，新增分级 Git 审批机制；Task FSM 重构为声明式状态机；移除 worktree 耦合，prompt 工程全面清理；修复 dream cycle 幻觉与 UI 问题。

### New Features

- **Secretary 统一建设者角色** — 合并原 builder agents 为 Secretary，集成 hiring / install / hub-tools 能力，新增 `builder-service` 和 hub 工具集 (#10)
- **分级 Git 命令审批** — 实现 tiered git command approval 机制，shell_execute 支持 HITL 审批回调，`ApprovalCallback` 返回 `{ approved, comment }`

### Refactoring

- **Task FSM 声明式状态机** — 用声明式 transition matrix 替代散落的状态判断，引入 phased side-effect pipeline，统一任务生命周期管理
- **合并 task_assignment 到 task_status_update** — 消除独立的 `task_assignment` 消息类型，通过 `triggerExecution` 标志复用 `task_status_update`，修复被抢占任务的自动恢复
- **移除 worktree 耦合** — 核心 prompt 工程与 worktree 概念解耦，`TaskWorkspace.worktreePath` 重命名为 `repoPath`
- **Prompt 工程全面审查** — 清理冗余 prompt、统一术语、优化上下文注入策略

### Bug Fixes

- 修复 dream cycle（memory_consolidation）幻觉 — 新增独立 `memory_consolidation` scenario，避免 sleep 周期误触 task 工具
- 改进审批通知面板 UI
- 修复 Work 页面切换后筛选条件丢失

### Enhancements

- 移动端 UI 优化
- Reports / AgentBuilder / AgentProfile 页面细节改进

### Stats

- 43 files changed, +1,865 / −1,013 lines

---

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
