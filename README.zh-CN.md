<p align="center">
  <img src="logo.png" width="160" alt="Markus Logo" />
</p>

<h1 align="center">Markus</h1>

<p align="center">
  <strong>开源的 AI 团队，你睡觉它干活。</strong><br />
  给它一句话目标，它组队、拆活、并行开干、每份产出都过审，<br />
  你合上电脑它还在推进。<br />
  <em>而且没错——它是被它自己开发出来的。</em>
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
  <a href="README.md">English</a> | <strong>中文</strong>
</p>

<p align="center">
  <img src="docs/images/dashboard-preview.gif" alt="Markus 实战 — AI 团队在一个面板里规划、执行、审查、交付" width="840" />
</p>

---

> **🪞 我们自己用自己。** Markus 就是跑在 Markus 上的：issue、任务、代码、
> 审查、发布，整个闭环都是我们自己的 agent 团队在 Markus 上完成的。
> 它能把自己做出来，就能把你做的东西做出来。

---

## 三句话看懂

- **不是套壳** — agent 直连各家 LLM API，用真实工具干活：shell、文件、git、联网搜索、代码分析、GUI / 浏览器自动化、任意 MCP 服务。
- **7×24 干活** — 心跳机制让团队自动推进任务、处理异步完成、上报阻塞。你睡觉，它交付。
- **越用越聪明** — 三层持久记忆自动沉淀，团队跑得越久，越好用。

**数据在自己手里** — 完全自托管，默认 SQLite（支持 PostgreSQL），不上云、不锁定。

---

## 一个人，还是一支团队

单个 copilot 像个聪明的实习生：单点任务很强，睡一觉就忘光，还爱自报"搞定了"。但一个人撑不起一家公司。

| | 单个 AI agent | Markus 团队 |
|---|---|---|
| **规模** | 一次一件事 | 多角色并行推进 |
| **记忆** | 会话结束就蒸发 | 持久记忆，自动沉淀 |
| **主动性** | 每次等你发话 | 心跳 24/7 巡检 |
| **质量** | 自报"完成" | 队友审查，每份交付把关 |
| **可见性** | N 个窗口来回切 | 一个面板、一份审计轨迹 |

---

## 🚀 10 分钟跑起来

```bash
# 桌面应用（macOS / Windows / Linux）
#   → https://github.com/markus-global/markus/releases/latest

npm install -g @markus-global/cli   # 需要 Node.js 22+；或用免 Node 的 Linux 一键脚本
markus start
```

打开 [http://localhost:8056](http://localhost:8056) — 引导向导会帮你建账号（初始登录：`admin@markus.local` / `markus123`）。然后对你的 Secretary 说：

> *"搭一个调研团队：扫一遍竞品，写份竞品分析，再起草一份 Go-to-Market 策略。"*

Markus 会组队、拆任务、开始执行 — 专才并行，每份交付都过审。

**就这些。** SQLite + 内置 Web UI，零外部依赖。源码方式：`git clone` → `pnpm install && pnpm build && pnpm dev`。

---

## 里面有什么

- 🧠 **三层记忆** — 程序性、语义性、情景性。知识跨会话积累，自动沉淀，不用你管。
- ⏰ **心跳自驱** — 没人盯着，任务也在推进；异步完成和阻塞照常处理。
- 🔀 **真并发** — 多个会话在互相隔离的工作区并行跑，同一聊天里开多线也不串台。
- 🧬 **ContextOS 上下文引擎** — 结构锚点固定、上下文预算稳定、压缩不丢决策。长会话又快又稳。
- 🛡️ **信任与门禁** — 渐进信任级别，正式的提交 → 审查 → 合并闭环，完整审计轨迹，随时紧急暂停。
- 🔌 **技能生态** — 从 skills.sh / Claude Code、SkillHub、OpenClaw、AgentScope、MCP 服务器导入技能，也能把你最好的技能导回社区。
- 🤖 **任意 LLM** — Anthropic、OpenAI、Google、DeepSeek、MiniMax、Ollama、OpenRouter 等 — 模型统一自动发现，故障自动切换。
- 🔒 **自带密钥** — 凭证只存在你的部署里，绝不上第三方云。

> 技能生态完整说明：[技能生态适配器](docs/SKILL-ECOSYSTEM.md)

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
│  Agent · LLM Router · ContextOS · Tools · Skills ·      │
│  Memory · A2A · Concurrency · Decision · Heartbeat      │
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
| **core** | Agent 运行时 — LLM 路由、ContextOS、工具、技能、记忆、并发、心跳、工作区隔离 |
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
| [并发处理](docs/CONCURRENT-PROCESSING.md) | 单个 Agent 并行处理多个邮箱项 / 会话 |
| [流式与重连](docs/STREAMING-AND-REATTACH.md) | 流式事件、断连重连、工具循环完整性 |
| [API 参考](docs/API.md) | REST API 端点与 WebSocket 事件 |
| [编码工具](docs/CODING-TOOLS.md) | Claude Code / Codex / Cursor 集成 |
| [学习循环](docs/LEARNING-LOOP.md) | Agent 自我改进与记忆沉淀 |
| [远程访问](docs/REMOTE-ACCESS.md) | Cloudflare Tunnel、Tailscale、FRP、ngrok 配置 |
| [发布与分发](docs/RELEASE-AND-DISTRIBUTION.md) | 构建、打包、发布流水线 |
| [博客](https://markus.global/blog) | 关于 Markus 与 AI Agent 的文章与教程 |

---

## 💬 社区

- **GitHub Discussions** — 提问、晒成果、案例分享：<https://github.com/markus-global/markus/discussions>
- **博客** — 教程与产品更新：<https://markus.global/blog>
- **Discord** — 全球英文用户实时交流 — *即将上线*
- **微信群** — 中文用户交流群，获取帮助、内测与贡献支持（建设中）

加入方式、频道地图与贡献者升级路径见 [docs/COMMUNITY.md](docs/COMMUNITY.md)。所有频道遵守我们的 [行为准则](CODE_OF_CONDUCT.md)。

---

## 参与贡献

```bash
pnpm install && pnpm build
pnpm dev          # API + Web UI 开发模式
pnpm test         # 运行测试
pnpm typecheck    # TypeScript 检查
pnpm lint         # ESLint
```

- [新手友好任务](https://github.com/markus-global/markus/labels/good%20first%20issue) — 入门级任务
- [社区急需功能](https://github.com/markus-global/markus/labels/help%20wanted) — 社区需要的功能
- [Bug 反馈](https://github.com/markus-global/markus/issues) — 帮我们修问题

完整指引见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可协议

Markus 采用双授权：

- **开源版**: [Apache-2.0](LICENSE) — 可自由使用、修改、分发、自托管，含商用
- **商业版**: [可获取](LICENSE-COMMERCIAL.md) — 面向需要企业支持、赔偿、OEM 嵌入或定制条款的团队

通过市场共享的技能通常使用各自许可（一般为 MIT）。

---

<p align="center">
  <a href="https://www.markus.global">官网</a> ·
  <a href="https://markus.global/blog">博客</a> ·
  <a href="https://github.com/markus-global/markus/discussions">讨论区</a> ·
  <a href="https://github.com/markus-global/markus/issues">Issues</a>
</p>

<p align="center">
  <sub>Markus — 让 AI Agent 像一支团队一样协作</sub>
</p>

