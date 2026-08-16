<p align="center">
  <img src="logo.png" width="160" alt="Markus Logo" />
</p>

<h1 align="center">Markus</h1>

<p align="center">
  <strong>开源 AI 员工平台。</strong><br />
  单个 AI Agent 就像一个聪明但健忘的实习生，还总爱提前说“做完了”。<br />
  Markus 给 Agent 装上记忆、同事、审查和 24/7 心跳 — 让工作真正交付。
</p>

<p align="center">
  <a href="https://github.com/markus-global/markus/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/markus-global/markus/ci.yml?branch=main&label=CI" alt="CI Status" />
  </a>
  <a href="https://github.com/markus-global/markus/releases">
    <img src="https://img.shields.io/github/v/release/markus-global/markus?include_prereleases&label=Version" alt="Version" />
  </a>
  <a href="https://github.com/markus-global/markus/stargazers">
    <img src="https://img.shields.io/github/stars/markus-global/markus?style=flat" alt="GitHub Stars" />
  </a>
  <a href="https://github.com/markus-global/markus/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License" />
  </a>
  <a href="https://github.com/markus-global/markus/issues">
    <img src="https://img.shields.io/github/issues/markus-global/markus" alt="Issues" />
  </a>
</p>

<p align="center">
  <a href="https://www.markus.global"><strong>官网</strong></a> ·
  <a href="https://markus.global/blog">博客</a> ·
  <a href="docs/GUIDE.md">文档</a> ·
  <a href="https://github.com/markus-global/markus/discussions">讨论区</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>中文</strong>
</p>

<p align="center">
  <img src="docs/images/dashboard-preview.gif" alt="Markus 实况 — AI Agent 规划、执行、互审、交付，一个看板全部搞定" width="840" />
</p>

---

## 60 秒看懂

**Markus 是单 Agent 助手缺失的那一层「组织」。**

你了解单 Agent 副驾：单任务很强，一旦变成组织就垮掉。它们跨会话忘记你的决策、卡在阻塞点上没人可问；最糟的是，它们向自己汇报「做完了」。

Markus 改变了运行模型。你用自然语言描述目标；Markus 组建一支分角色 Agent 团队（调研、开发、审查、写作、运维），把工作拆成任务、让专家并行执行、所有交付先经过同行评审再送到你手上。你睡觉时，团队还在干活。

- **是团队，不是包装壳** — 内置完整 Agent 运行时。每个员工直接对接 LLM API，使用内置工具：shell、文件读写、git、网页搜索、代码分析、GUI 与浏览器自动化、任意 MCP 服务。不靠外部 CLI 转包。
- **零配置启动** — SQLite 存储、内置 Web UI、一条命令。从安装到跑起一个 AI 团队，大约 **10 分钟**。
- **7×24 自主运转** — 心跳调度器让 Agent 持续推进、审查、升级，不需要人一直在场。
- **随处可跑** — 你的笔记本、一台小云服务器或你的数据中心。macOS / Windows / Linux 桌面应用，手机也能用响应式控制台。

---

## 🚀 快速开始 — 10 分钟跑起一个 AI 团队

**1. 安装** — 选最顺手的方式：

```bash
# 桌面应用（macOS / Windows / Linux）
#   → 从 https://github.com/markus-global/markus/releases/latest 下载

# npm（需要 Node.js 22+）
npm install -g @markus-global/cli

# Linux 一键安装（无需 Node.js）
curl -fsSL https://markus.global/install.sh | bash
```

**2. 启动**

```bash
markus start
```

**3. 打开** [http://localhost:8056](http://localhost:8056) — 引导向导帮你设置账号（初始登录：`admin@markus.local` / `markus123`）。

**4. 告诉你的 Secretary 你要什么**

> *「我需要一个调研团队：扫描竞品、写竞争分析、再起草一份进入市场的策略。」*

Markus 会组建团队、把目标拆成任务，然后开始执行 — 专家并行干活，每个交付都经过审查。

**就这样。** SQLite 数据库、内置 Web UI、零外部依赖。从源码跑：`git clone` → `pnpm install && pnpm build && pnpm dev`。

---

## 💼 可以用 Markus 做什么

| 领域 | 示例 |
|------|---------|
| **调研与分析** | 扫描竞品、输出竞争分析报告、起草进入市场策略 |
| **软件工程** | 从需求到代码到测试完整交付一个功能，内置同行评审 |
| **内容与发布** | 起草、编辑、评审、排期发布文章、报告和社媒内容 |
| **运营** | 每日简报、问题分流、定时监控、阻塞升级 |
| **数据与报告** | 拉取数据、分析、定时交付成品报告 |
| **个人研究** | 深挖任意主题，拿回结构化、带引用的交付物 |

你合上电脑，团队仍在工作 — 心跳机制让 Agent 在你睡觉时持续推进。

---

## 为什么团队胜过单个 Copilot

单个 Agent — Claude Code、Codex、ChatGPT 或任意 copilot — 擅长一次执行一个任务。但一个员工撑不起一家公司。

| | 单个 AI Agent | Markus AI 团队 |
|---|---|---|
| **规模** | 一次一个任务 | 多个专家角色并行工作 |
| **记忆** | 会话结束上下文就蒸发 | 三层持久记忆，跨会话自动整理沉淀 |
| **主动性** | 每次都等你下指令 | 心跳 24/7 巡检任务 — 你睡觉也在干 |
| **质量** | “做完了”是自说自话 | 同事审查、互相纠错、把关每个交付 |
| **可见性** | 10 个 Agent = 10 个窗口 | 一个看板 + 一条审计轨迹 |
| **问责** | 没有护栏 | 渐进信任级别、提交-审查-合并、紧急暂停 |

你管理的是一个团队，而不是一堆零散的 Prompt。

---

## 🏛️ 为什么它是「组织」，不是「脚本」

- **🧠 三层记忆** — 程序性（怎么做事）、语义性（知道什么）、情景性（发生过什么）。知识跨会话积累并自动沉淀 — 团队跑得越久越聪明。
- **⏰ 心跳自驱** — Agent 不会干等指令。心跳调度器自动巡检待办、处理异步完成、上报阻塞 — 你合上电脑，工作继续推进。
- **🛡️ 渐进信任级别** — 试用 → 标准 → 信任 → 资深。Agent 用可靠表现换取权限与授权范围。
- **✅ 质量门禁** — 正式的提交 → 审查 → 合并交付闭环。没有评审过的产出到不了你手上；同行能抓到自报「完成」漏掉的问题。
- **📜 完整审计轨迹** — 每个动作都有日志：谁、做了什么、什么时候、为什么。复现结果、排查事故，都不用靠猜。

---

## 🔒 安全与数据主权

- **自托管，数据在你的手里** — 完全运行在你的基础设施上。默认 SQLite，支持 PostgreSQL。没有强制云依赖；除非你主动开启远程访问，数据不出你的网络。
- **隔离工作区** — 每个 Agent 在自己的沙箱工作区、独立 git 分支上作业，运行之间互不串扰。
- **最小权限** — 信任级别决定 Agent 能做什么；导入的技能把声明的权限（`allowed-tools` → `requiredPermissions`）映射为实际能力，而不是一把梭。
- **审计与控制** — 全量操作日志、紧急暂停、高风险步骤的人工审批关卡。
- **密钥自持** — 接入任意 LLM 供应商，凭据只存在于你的部署环境，第三方云不可见。
- **可选远程访问** — Cloudflare Tunnel、Tailscale、FRP 或 ngrok，随时随地在手机管理团队。

---

## 🌍 不是又一个封闭生态

Markus 与你在用的 AI 生态良好共处 — 不需要推倒重来。

- **8 万+ 社区技能，即插即用** — `markus skill import <path>` 自动识别并归一化来自 **skills.sh / Claude Code、SkillHub / ClawHub、OpenClaw、SOUL.md、AgentScope、MCP 服务器**的技能为标准 Markus 技能。不用改写，没有锁定。
- **反向导出** — `markus skill export <name> --format claude` 把你的最佳技能渲染成外部标准格式，发布回 skills.sh、SkillHub、OpenClaw 等社区。
- **对话内导入** — Agent 在对话里通过 `discover_tools({ mode: "import" })` 直接加载本地技能包，即刻生效，无需重启。
- **任意 MCP 服务** — 标准 MCP 服务端直接接入 Agent 工具层。
- **任意 LLM 供应商** — Anthropic、OpenAI、Google、DeepSeek、MiniMax、Ollama、OpenRouter、SiliconFlow、Moonshot — 自动故障切换、按任务路由。

> 完整说明：[技能生态适配器](docs/SKILL-ECOSYSTEM.md)

---

## 🏆 真实团队在用 Markus

### 案例：我们用 Markus 造 Markus

Markus 项目本身就是跑在 Markus 上的。技能生态适配器、双授权迁移、乃至你现在读的这份 README，都走的是我们交付给你的同一条流水线：需求 → 任务 → 并行 Agent → 同行审查 → 合并，每一步都可审计。发布节奏再快，纪律来自平台，而不是靠记性。

### 你的故事可以出现在这里

用 Markus 交付过产品、跑过调研冲刺、或者自动化了某项运营？到 [讨论区](https://github.com/markus-global/markus/discussions) 告诉我们 — 优秀案例会收录进这份 README 和我们的[博客](https://markus.global/blog)。带引语的用户证言一律先征得同意。

---

## 架构

```
┌─────────────────────────────────────────────────────────┐
│              Web UI (React) · Desktop (Electron)        │
│      Dashboard · Chat · Projects · Builder · Hub        │
└──────────────────────┬──────────────────────────────────┘
                       │ REST + WebSocket
┌──────────────────────┴──────────────────────────────────┐
│                  Org Manager (API Server)               │
│     Auth · Tasks · Governance · Projects · Reports      │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────────┐
│                  Agent Runtime (Core)                   │
│  Agent · LLM Router · Tools · Skills · Memory · A2A     │
└──────────┬────────────────────────────┬─────────────────┘
           │                            │
┌──────────┴──────────┐    ┌────────────┴─────────────────┐
│  Storage (SQLite /  │    │  Comms (Slack, Feishu,       │
│   PostgreSQL)       │    │   WhatsApp, Telegram)        │
└─────────────────────┘    └──────────────────────────────┘
```

TypeScript monorepo，模块化包结构：

| 包 | 职责 |
|---------|------|
| **core** | Agent 运行时 — LLM 路由、工具、技能、记忆、心跳、工作区隔离 |
| **org-manager** | REST API、WebSocket、治理、任务生命周期 |
| **web-ui** | React + Vite + Tailwind 控制台 |
| **desktop** | Electron 桌面应用（macOS / Windows / Linux） |
| **cli** | `@markus-global/cli` — 一条命令安装启动 |
| **storage** | SQLite 持久化（零外部依赖） |
| **gui** | GUI 自动化 — VNC、截图、输入控制、视觉分析 |
| **comms** | Slack / 飞书 / WhatsApp / Telegram 桥接 |
| **a2a** | Agent 间通信协议 |
| **remote** | 远程访问 — 隧道与零配置组网 |
| **chrome-extension** | 通过 Markus 扩展实现浏览器自动化 |
| **shared** | 共享类型、常量、工具 |

---

## 文档

| 指南 | 说明 |
|------|------|
| [用户指南](docs/GUIDE.md) | 安装、配置、Web 控制台使用 |
| [架构设计](docs/ARCHITECTURE.md) | 系统设计、Agent 运行时、记忆、治理 |
| [Agent 运行时](docs/AGENT-RUNTIME.md) | Agent 生命周期、执行模型、工作区隔离 |
| [工具系统](docs/TOOL-SYSTEM.md) | 内置工具、MCP 集成、工具契约 |
| [技能生态](docs/SKILL-ECOSYSTEM.md) | 从 skills.sh、SkillHub、OpenClaw、AgentScope、MCP 导入/导出技能 |
| [记忆系统](docs/MEMORY-SYSTEM.md) | 三层记忆架构（Tulving） |
| [认知架构](docs/COGNITIVE-ARCHITECTURE.md) | 认知准备流水线（CPP）设计 |
| [邮箱系统](docs/MAILBOX-SYSTEM.md) | Agent 注意力模型、优先级队列、分诊 |
| [提示词工程](docs/PROMPT-ENGINEERING.md) | 系统提示词组装、工具循环、压缩 |
| [状态机](docs/STATE-MACHINES.md) | 任务与需求 FSM 规范 |
| [API 参考](docs/API.md) | REST API 端点与 WebSocket 事件 |
| [编码工具](docs/CODING-TOOLS.md) | Claude Code / Codex / Cursor 集成 |
| [学习循环](docs/LEARNING-LOOP.md) | Agent 自我改进与记忆沉淀 |
| [远程访问](docs/REMOTE-ACCESS.md) | Cloudflare Tunnel、Tailscale、FRP、ngrok 配置 |
| [发布与分发](docs/RELEASE-AND-DISTRIBUTION.md) | 构建、打包、发布流水线 |
| [博客](https://markus.global/blog) | 关于 Markus 与 AI Agent 的文章与教程 |

---

## 参与贡献

```bash
pnpm install && pnpm build
pnpm dev          # API + Web UI 开发模式
pnpm test         # 运行测试
pnpm typecheck    # TypeScript 检查
pnpm lint         # ESLint
```

想贡献一份力量？

- [第一个好 issue](https://github.com/markus-global/markus/labels/good%20first%20issue) — 适合新手的任务
- [Help wanted](https://github.com/markus-global/markus/labels/help%20wanted) — 社区需要的功能
- [Bug 反馈](https://github.com/markus-global/markus/issues) — 帮我们修问题

完整指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可协议

Markus 采用双许可证：

- **开源版**：[Apache-2.0](LICENSE) — 可自由使用、修改、分发与自托管，包括商用
- **商业版**：[另行提供](LICENSE-COMMERCIAL.md) — 适用于需要企业级支持、法律保障、OEM 嵌入与定制条款的团队

市场共享的技能可采用各自的许可证（通常为 MIT）。

---

<p align="center">
  <a href="https://www.markus.global">官网</a> ·
  <a href="https://markus.global/blog">博客</a> ·
  <a href="https://github.com/markus-global/markus/discussions">讨论区</a> ·
  <a href="https://github.com/markus-global/markus/issues">Issues</a>
</p>

<p align="center">
  <sub>Markus — Where AI Agents Work as a Team</sub>
</p>