# Phase 3 — 端到端集成与生产就绪

## 目标

将 Phase 1/2 的独立模块串联为可用的端到端系统，让数字员工真正"能干活"。

## 任务清单

### P3-1: Storage 集成 — 用数据库替换内存状态（高优先）
- OrgService / TaskService / AgentManager 接入 @markus/storage Repository
- Agent / Org / Task 创建/查询/更新通过数据库持久化
- 服务重启后数据不丢失

### P3-2: WebSocket 实时通信（高优先）
- API Server 增加 WebSocket endpoint
- Agent 状态变更、任务更新实时推送到 Web UI
- Chat 页面从轮询改为 WebSocket 双向通信

### P3-3: Agent 工具执行增强（中优先）
- web_fetch 工具支持真正的 HTTP 请求
- MCP Client 集成到 Agent 工具链
- 工具执行结果持久化到 memories 表

### P3-4: 任务自动分配与跟踪（中优先）
- 任务创建时根据技能自动匹配 Agent
- Agent 通过 A2A 协议接受/拒绝任务
- 任务状态随 Agent 工作自动流转

### P3-5: 多轮对话记忆持久化（中优先）
- 对话 session 保存到数据库
- Agent 重启后可恢复对话上下文
- 长期记忆从内存迁移到 PostgreSQL

### P3-6: 完善 Web UI 交互（低优先）
- Agent 详情页（配置、记忆、日志）
- 任务详情抽屉（描述、进度、子任务）
- 实时日志流展示

### P3-7: CLI 增强（低优先）
- `markus db:init` 数据库初始化命令
- `markus db:migrate` 迁移命令
- `markus agent:status` 查看 Agent 详细状态
