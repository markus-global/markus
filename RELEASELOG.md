# Release Log

## v0.4.17

移除 PostgreSQL 支持，全面精简存储层；新增 Main Session 活动上下文与子 Agent 执行可见性；Mailbox 恢复与通知级联抑制；团队创建 UX 与流式动画优化；用户聊天可抢占后台处理。

### New Features

- **Main Session 活动上下文** — 新增 `is_main` 会话概念，非聊天类 mailbox 处理完成后自动注入活动摘要到主会话，Agent 跨任务执行保持叙事连续性
- **子 Agent 执行可见性** — Work 页任务执行日志展示嵌套子 Agent 时间线，ToolDetailModal 渲染子 Agent 详情，Chat 流式路径透传 subagentLogs
- **团队创建 UX 优化** — 创建团队后自动滚动高亮，空团队状态优化，Create Team 弹窗增加 Secretary 高级创建提示
- **流式气泡动画** — Chat 气泡在 Agent 流式输出时显示流动渐变边框动画
- **Heartbeat 支持创建任务/需求** — heartbeat 场景下允许调用 `task_create` 和 `requirement_propose`

### Bug Fixes

- **修复用户聊天无法抢占后台处理** — `handleMessage` 对自发场景（heartbeat、memory_consolidation、system_event、daily_report）支持抢占，human_chat 消息在下一个 yield point 中断后台工作
- **修复 notify_user 时序 bug** — `setUserNotifier` 追溯推送给所有已存在 Agent，缺少 notifier 时优雅降级而非硬错误
- **修复 discover_tools 参数混乱** — 合并 `name` 和 `tool_names` 为单一 `name` 参数，消除 LLM 参数混淆导致的技能激活失败
- **修复 Hub artifact manifest 写入错误** — `downloadAndInstall` 写入正确的类型文件名（agent.json/team.json/skill.json）而非通用 manifest.json
- **修复 main session 排序问题** — `getSessionsByAgent` 按 `is_main DESC` 排序，避免多会话 Agent 主会话被淹没
- **修复评论内容为 undefined** — task_comment/requirement_comment 增加内容校验
- **抑制审核通知级联** — 活跃审核期间抑制 reviewer→worker/creator 的冗余通知
- **Mailbox 启动恢复** — 重启时将卡在 processing 状态的 mailbox 项标记为 dropped
- **修复 agent_broadcast_status schema 枚举不匹配**
- **修复移动端 Profile 导航缺失 `enterMobileDetail` 调用**

### Refactoring

- **移除 PostgreSQL/Drizzle 支持** — 删除全部 Drizzle schema、repos、migrations 和 PgVectorStore，存储层仅保留 SQLite
- **存储类型整合** — 新增独立 `types.ts`，定义 `TaskRow` 等类型接口，移除 repo 的 `[key: string]: unknown` 索引签名
- **合并 A2A 工具组** — `structured-a2a` 和 `group-chat` 合并为 `a2a-extended`
- **静默状态转换** — blocked↔in_progress 转换不再触发冗余通知
- **集中 shell 超时限制** — 统一 shell 命令超时配置

### Enhancements

- FSM 感知的 TagPicker，高亮合法状态转换
- Mailbox 状态过滤器与 requirement_comment 类型支持
- WebSocket task:update handler 始终刷新看板
- 消息预览过滤未闭合 `<think>` 标签和工具调用 XML
- Secretary prompt 更新团队优先创建最佳实践
- Prompt 工程增加内置工具优先与禁止自动安装规则
- Manager 招聘指导扩展为 CREATE/INSTALL 两阶段工作流
- 安装脚本更新

### Stats

- 84 files changed, +1,632 / −4,911 lines

---

## v0.4.16

修复 Agent 动态创建全链路问题（白屏崩溃→数据丢失→事件断路）；修复 pause/resume 实际无效的 bug；移除 token 预算自动暂停机制；新增 heartbeat 完成任务复盘与 SOP 自动注入。

### Bug Fixes

- **修复秘书雇佣员工白屏崩溃** — LLM 调用 `team_hire_agent` 时可能不传 `name`，导致前端 `toLowerCase()` 崩溃；在工具层、`createAgent` 核心层和前端 API 层三重防御
- **修复新建 Agent 邮箱历史为空** — `start.ts` 监听的事件名 `agent:registered` 与实际 emit 的 `agent:created` 不匹配，导致动态创建的 Agent 未接入 mailbox 持久化
- **修复新建 Agent 重启后丢失** — 通过 `team_hire_agent` 创建的 Agent 未持久化到 DB，新增 `agent:created` 事件监听写入数据库
- **修复新建 Agent 无法发送主动消息** — `setUserMessageSender` 和 `setChatSessionsFetcher` 仅在启动时为已有 Agent 注册，重构为事件驱动，动态 Agent 也能即时接入
- **修复 pause/resume 实际无效** — `pause()` 只改状态标签但不停止 heartbeat、attention controller 和 memory timer，Agent 照常工作；现在真正停止/重启后台进程
- **修复 `builder_install` / `hub_install` 缺少参数校验** — 与 `team_hire_agent` 同类问题，补充运行时参数验证

### New Features

- **Heartbeat 完成任务复盘** — Agent heartbeat 时自动检查近期完成的任务，提取最佳实践并注入 SOP 上下文
- **11 个事件消费者接入 WS 广播** — `agent:removed/paused/resumed/started/stopped`、`task:completed/failed`、`system:pause-all/resume-all/emergency-stop/announcement` 全部通过 WebSocket 推送到前端
- **全局暂停状态 WS 同步** — 侧边栏 Pause/Resume 按钮监听 WS 事件实时同步，多客户端状态一致

### Refactoring

- **移除 token 预算自动暂停机制** — 删除 `maxTokensPerDay` 超限自动 pause 和午夜自动 resume 逻辑，保留 token 计数器供展示
- **清理冗余事件** — 移除 `agent:status-changed`（与 `stateChangeCallback` 重复）和 `agent:decision`（与 `attention:decision` 重复）
- **工作区安全策略重构** — 白名单策略替换为 deny-only 跨 Agent 隔离
- **API 路由加固** — 集中 agent-facing limits，统一前置条件校验

### Stats

- 43 files changed, +706 / −674 lines

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
