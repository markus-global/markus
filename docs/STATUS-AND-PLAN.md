# Markus 功能现状与规划

> 2026-03-10

---

## 已完成

### 核心运行时

| 功能 | 成熟度 |
|------|--------|
| Agent 生命周期管理（创建/启动/停止/角色/工具注入） | ★★★★ |
| 多轮对话 + 工具调用 + 流式响应 | ★★★★ |
| LLM 多模型路由（Anthropic/OpenAI/DeepSeek/SiliconFlow/OpenRouter，复杂度路由 + 降级） | ★★★★ |
| 上下文引擎（优先级排序、Token 预算、消息压缩） | ★★★★ |
| Token 计量（启发式 + Anthropic API + 校准，CJK 感知） | ★★★★ |
| 环境感知（OS/Shell/工具/运行时/浏览器/包管理器/资源） | ★★★★ |
| 心跳调度（Cron/Interval，OpenClaw 格式） | ★★★ |
| 记忆系统三层（文件持久化：memories.json / sessions / daily-logs / MEMORY.md） | ★★★ |
| Agent 指标（Token/任务完成率/健康评分，metrics.json 持久化） | ★★★ |
| 安全守卫（Shell 命令 + 文件路径校验） | ★★★ |
| 并发任务队列（TaskQueue + TaskExecutor + AgentStateManager） | ★★★ |
| Docker Sandbox 接入（CLI → `@markus/compute` SandboxManager → AgentManager） | ★★★ |
| 语义搜索（SemanticMemorySearch + OpenAI Embedding + LocalVectorStore，memory_search & context-engine 集成） | ★★★ |
| MCP 工具接入（MarkusConfig mcpServers 配置 → AgentManager → MCPClientManager） | ★★★ |

### 工具 & 技能

| 工具集 | 注入方式 |
|--------|----------|
| Builtin（Shell/File/Search/Patch/Web/Process） | 默认 |
| A2A 消息 + 结构化协作 | AgentManager |
| 记忆 / 任务 / 项目 / Manager | AgentManager |
| Skill（Git/Code Analysis/Browser/Feishu/Todo） | AgentManager |

### A2A 协议

A2ABus / DelegationManager / CollaborationManager / StructuredMessageManager — 完整实现，已接入 AgentManager。

### 组织与治理

组织/团队/人员 CRUD · 团队级 Agent 批量启停（Start All / Stop All / Pause / Resume） · 任务系统（DB 持久化 + blocked_by 依赖 + 自动解阻） · 项目/迭代 · 需求（人类审批） · 三层审批 + 信任等级 · Git Worktree 隔离 · 交付评审 · 质量门禁 · 知识库 · 周期报告 + 人类反馈 · 审计日志 · 归档清理 · 停滞检测 · 全局控制 + 公告

### 数据存储

| 后端 | 说明 |
|------|------|
| **SQLite（默认）** | `better-sqlite3`，零配置 |
| PostgreSQL（可选） | Drizzle ORM，`DATABASE_URL` 切换 |

完整 Repo 层（SQLite + PG 各一套），memory_embeddings 表已建。

### API & 传输

REST API（完整） · SSE 流式 · WebSocket 推送 · JWT + 角色权限 · 外部 Agent 网关（OpenClaw）

### Web UI

Dashboard · Chat · TaskBoard（Kanban + DAG 依赖视图） · Team（含批量启停） · Projects · Governance · Knowledge · Reports · AgentProfile · SkillStore · TemplateMarketplace · AgentBuilder · Settings · Login

### 编排 & 生态

Workflow DAG 引擎 · Agent 组合模式 · 团队模板（5 个内建） · 模板系统 + DB 持久化 · Marketplace（DB + API + UI） · 17+ 内建角色

### 通信适配器

| 平台 | 状态 |
|------|------|
| WebUI | ✅ |
| 飞书 | ✅ |
| Telegram | ✅ |
| Slack | ⚠️ 仅发送 |
| WhatsApp | ⚠️ 仅发送 |

### GUI 自动化

| 层级 | 模块 | 说明 |
|------|------|------|
| VNC 客户端 | `vnc-client.ts` | RFB 协议连接、帧缓冲、指针/键盘事件 |
| 截图 | `screenshot.ts` | VNC 帧捕获 → Sharp 转 PNG/JPEG/base64 |
| 输入模拟 | `input.ts` | 鼠标点击/拖拽/滚轮、键盘输入/组合键、X11 keysym |
| 元素识别 | `element-detector.ts` | OmniParser HTTP API + Tesseract.js OCR 后备 |
| 高级自动化 | `visual-automation.ts` | clickElement / typeToElement / waitForElement / executeWorkflow |
| Agent 工具 | `gui-agent-tools.ts` | 14 个工具（截图/点击/类型/键盘/滚动/分析/查找/OCR/自动化流） |
| Core 技能 | `gui-skill.ts` / `advanced-gui-skill.ts` | 接受 VNC 配置自动切换真实实现，无 VNC 时降级为 stub |

### 部署

Docker Compose · Kubernetes manifests · Dockerfile

---

## 未完成

### 需补全

| 功能 | 工作量 |
|------|--------|
| Slack 收消息（webhook / Socket Mode） | 1-2 天 |
| WhatsApp 收消息（webhook 验证 + 解析） | 1-2 天 |
| `markus init` 快速启动引导 | 2-3 天 |

### 需新开发

| 功能 | 优先级 | 工作量 |
|------|--------|--------|
| Prompt Engineering Studio | P3 | 1-2 周 |
| Markus Cloud（多租户 SaaS） | P3 | 远期 |

---

## 包实现度

| 包 | 实现度 | 缺口 |
|----|--------|------|
| `core` | ★★★★ | — |
| `org-manager` | ★★★★ | — |
| `storage` | ★★★★ | — |
| `web-ui` | ★★★★ | — |
| `shared` | ★★★★ | — |
| `a2a` | ★★★★ | — |
| `cli` | ★★★★ | `markus init` 引导 |
| `comms` | ★★★ | Slack / WhatsApp 收消息 |
| `compute` | ★★★★ | — |
| `gui` | ★★★ | 依赖 VNC 服务端环境 + OmniParser 部署 |
