# Phase 4 — 从脚手架到真正能干活的数字员工

## 第一性原理分析

### 核心问题：Markus 目前是"看起来能跑"但"不能真正干活"

**致命缺陷：**

1. **通过 API 创建的 Agent 没有任何工具** — `hireAgent` 不传 `tools`，导致 Agent 只能聊天不能执行任何操作
2. **MCP Client 已实现但从未接入** — Agent 无法连接外部工具链
3. **Docker Sandbox 已实现但从未启用** — `sandboxFactory` 永远不会被设置
4. **A2A 已实现但从未集成** — Agent 之间不能通信
5. **任务只在内存中** — TaskService 不用 TaskRepo，重启就丢失

**体验缺陷：**

6. **无流式响应** — 用户等待完整回复，可能等 30 秒无反馈
7. **记忆太简陋** — 只有字符串匹配，无分层记忆，无上下文压缩
8. **无安全模型** — Agent 可以执行任意命令，无确认机制

### OpenClawd / Claude Code 借鉴

| 借鉴点 | OpenClawd 做法 | Markus 对策 |
|--------|---------------|-------------|
| 三层记忆 | short(session) + medium(daily log) + long(MEMORY.md) | 实现 MemoryManager 三层架构 |
| 上下文压缩 | 达到 92% 容量时触发压缩，先 flush 记忆再截断 | ContextEngine 增加 compaction |
| 结构化工具反馈 | 成功/失败明确，文件读取分页 | 工具返回结构化 JSON |
| 流式响应 | SSE/WebSocket 逐 token 推送 | LLM Provider 流式 + WS 推送 |
| 安全模型 | 命令白名单/黑名单，高危操作需确认 | SecurityPolicy 模块 |
| 规划工具 | TodoWrite — Agent 自建任务列表 | 内置 todo_write / todo_read 工具 |
| Diff 式编辑 | 代码修改用 diff 而非全文重写 | file_edit 工具（str_replace 模式） |

## 任务清单

### P4-1: 修复关键缺陷（最高优先）
- hireAgent 自动注入 builtin tools
- 可选启用 sandbox（通过配置）
- TaskService 接入 TaskRepo 持久化

### P4-2: LLM 流式响应 + WebSocket 推送
- LLM Provider 增加 chatStream 方法
- Agent.handleMessageStream 流式处理
- WebSocket 推送 chat:stream 事件
- Web UI Chat 组件支持流式渲染

### P4-3: 三层记忆系统 + 上下文压缩
- 短期记忆：当前 session messages（已有）
- 中期记忆：每日对话摘要日志
- 长期记忆：MEMORY.md 持久化关键信息
- 上下文压缩：达到阈值时先 flush 记忆再截断

### P4-4: 安全模型
- SecurityPolicy：命令白名单/黑名单
- 高危操作（rm -rf, sudo, etc.）需要审批
- 文件路径沙箱限制
- API 确认接口

### P4-5: Agent 规划工具 + 结构化工具反馈
- todo_write / todo_read 工具
- file_edit 工具（str_replace 模式，比全文覆盖更安全）
- 所有工具返回结构化 JSON（status, output, error）

### P4-6: MCP 集成到 Agent
- Agent 创建时根据配置连接 MCP 服务器
- MCP 工具自动注册到 Agent 工具链
- 支持 stdio 和 HTTP/SSE 两种传输
