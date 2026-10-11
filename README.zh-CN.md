<p align="center">
  <img src="logo.png" width="150" alt="Markus" />
</p>

<h1 align="center">Markus</h1>

<p align="center">
  <strong>开源的 AI 团队，跑在你自己的机器上。</strong><br />
  用一句大白话说清目标——它自己组队、拆活、干完回报。
</p>

<p align="center">
  <a href="https://github.com/markus-global/markus/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/markus-global/markus/ci.yml?branch=main&label=CI" alt="CI status" />
  </a>
  <a href="https://github.com/markus-global/markus/releases">
    <img src="https://img.shields.io/github/v/release/markus-global/markus?include_prereleases&label=version" alt="Latest version" />
  </a>
  <a href="https://github.com/markus-global/markus/stargazers">
    <img src="https://img.shields.io/github/stars/markus-global/markus?style=flat" alt="GitHub stars" />
  </a>
  <a href="https://github.com/markus-global/markus/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0" />
  </a>
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>中文</strong>
</p>

<p align="center">
  <img src="docs/images/dashboard-preview.gif" width="840" alt="Markus 控制台：智能体在规划、执行、评审并交付" />
</p>

---

*给那些想要一支 AI 团队、而不是一个聊天框的人。*

---

## 看它怎么干活

```
你      我要一份竞品分析和一份上市方案。

Markus  ▸ 建立需求
        ▸ 组建团队 —— 3 个角色、3 个任务、2 条依赖

            首席研究员      竞品扫描        审查人：高级研究员
            高级研究员      市场规模测算    审查人：首席研究员
            内容总监        上市方案        被上面两个任务阻塞

        08:41  两个任务并行开工，各自独立工作区
        09:12  竞品扫描交付 → 同伴评审 → 要求改一处
        09:26  修改后重新交付 → 通过
        09:30  上市方案解除阻塞，自动开工
        09:58  三份交付物躺在看板上，你只收到一条通知
```

---

## 一个 copilot 是实习生，你需要的是一家公司

copilot 很擅长单个任务：它记不住明天，还给自己打分。但真正要紧的活儿——一个季度的调研、
一次产品发布、一个会持续长大的代码库——都不是「单个任务」。

|                  | 单个 copilot             | Markus                                        |
| ---------------- | ------------------------ | --------------------------------------------- |
| **规模**         | 一次一个任务             | 多个专业角色并行推进                          |
| **记忆**         | 会话结束即蒸发           | 长期保留、自动整理、越用越强                  |
| **主动性**       | 等你开口                 | 自己巡检任务看板，昼夜不停                    |
| **质量**         | 「完成」是自己说的       | 每份交付都由同伴审查并放行                    |
| **可见性**       | N 个标签页、N 个窗口     | 一块看板、一条审计轨迹                        |
| **跑在哪**       | 别人的云上               | 你的机器、你的密钥、你的数据                  |

**模型与技能：** 任何供应商——Anthropic、OpenAI、Google、DeepSeek、MiniMax、Fireworks、
OpenRouter，或用 Ollama 跑本地模型；技能双向互通：从 skills.sh、SkillHub、OpenClaw、
AgentScope 或任意 MCP server 导入，也能把自己的导出回去。

---

## 🚀 快速开始

**推荐直接用桌面应用。** 它自带运行时，也自带浏览器——不用装 Node.js、不用碰命令行，装完也不用再打开别的东西。

| 平台 | 安装包 |
| --- | --- |
| **macOS** —— Apple Silicon 或 Intel | `Markus-….dmg` |
| **Windows** —— x64 | `Markus-Setup-….exe` |
| **Linux** —— x64 | `Markus-….AppImage`（另有 `.deb`、`.tar.gz`） |

从 **[官网](https://www.markus.global)** 或 **[GitHub Releases](https://github.com/markus-global/markus/releases/latest)** 下载，两边是同一批文件。

打开应用，然后给你的秘书一个真活儿：

> *「我们下季度要进欧洲市场。把市场调研清楚、算出规模，再起草一份上市方案。」*

你在旁边看着、随时调整、点头放行。

<details>
<summary><strong>更想跑在服务器 / VPS / 没有桌面的机器上？</strong></summary>

用 CLI，跑的是同一个东西，界面在你自己的浏览器里：<http://localhost:8056>。

```bash
# Linux / macOS —— 没装 Node.js 也会自动带上运行时
curl -fsSL https://markus.global/install.sh | bash && markus start

# 任何有 Node.js 22+ 的地方
npm install -g @markus-global/cli && markus start
```

这两条路都需要你自己有一个现代浏览器来打开界面。
</details>

不用装数据库、不用注册云账号：SQLite 和界面都随应用一起装好。

<sub>想从源码跑？见 [CONTRIBUTING.md](CONTRIBUTING.md)。</sub>

---

## 大家拿它干什么

- **调研与分析** —— 竞品扫描、市场规模测算、尽职调查，数字都标明出处。
- **内容运营** —— 一份 brief 同时变成文章、推文串、newsletter 和短视频脚本。
- **写代码** —— 这个仓库就是这么建起来的（见下）。
- **常态化盯盘** —— 每日扫描、价格与风险监控、收件箱分诊。这类「看一眼、再汇报」的活儿可以无人值守，真出变化时才叫你。

---

## 它自己造自己

Markus 是用 Markus 开发的。这个仓库里的 issue、需求、任务分派、同伴评审和发版说明，都由一个
Markus 组织跑完——跟你下载的是同一个产品。它自己的智能体发现的 bug，由它自己的智能体修，
最后由人合并。

这是我们能拿出的最诚实的基准：如果它连自己都交付不了，你就不该指望它交付你的活儿。

---

## 内部结构

一个 TypeScript monorepo：智能体运行时与上下文引擎、REST + WebSocket 接口、React 控制台、
Electron 桌面应用、SQLite 存储、消息桥接（Slack、飞书、WhatsApp、Telegram、Discord）、
GUI 与浏览器自动化，以及智能体之间的通信协议。

内部细节都好好写在文档里——从 **[文档索引](docs/README.md)** 开始：

| | |
| --- | --- |
| [系统架构](docs/architecture/architecture.md) | 各部件怎么拼起来，以及为什么这么设计 |
| [智能体运行时](docs/architecture/agent-runtime.md) · [记忆系统](docs/architecture/memory-system.md) · [工具系统](docs/architecture/tool-system.md) | 大家问得最多的三个子系统 |
| [API 参考](docs/api/api.md) · [使用指南](docs/guides/guide.md) | 想基于它开发，或者只是用起来 |
| [工程记录](docs/records/) | 带日期的审计与复盘，不加修饰地公开 |

---

## 💬 社区

- **GitHub Discussions** —— 提问、晒成果、案例分享：<https://github.com/markus-global/markus/discussions>
- **Blog** —— 教程与产品笔记：<https://markus.global/blog>
- **Discord** —— 与用户和贡献者实时交流（英文/全球）——*即将上线*
- **微信群** —— 中文用户交流群，内测与贡献支持（建设中）

所有渠道都遵循我们的[行为准则](CODE_OF_CONDUCT.md)，详细说明见
[docs/guides/community.md](docs/guides/community.md)。

---

## 参与贡献

```bash
pnpm install && pnpm build
pnpm dev          # 开发模式：API + Web UI
pnpm test         # 单元 + 集成测试
pnpm typecheck    # 全包 TypeScript 检查
pnpm lint         # ESLint
```

- [Good first issues](https://github.com/markus-global/markus/labels/good%20first%20issue) —— 范围小、有人带
- [Help wanted](https://github.com/markus-global/markus/labels/help%20wanted) —— 社区需要的东西
- [Bug 报告](https://github.com/markus-global/markus/issues) —— 最好带复现步骤

完整流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

Markus 目前是 **pre-1.0（0.11.x）**，迭代很快，小版本里可能有破坏性变更。正因为这样，现在
的反馈、issue 和 PR 才最值钱。

---

## 许可协议

Markus 采用双许可：

- **开源** —— [Apache-2.0](LICENSE)。随便用、随便改、自托管、商用都行。
- **商业** —— [可选](LICENSE-COMMERCIAL.md)，面向需要支持、赔偿保障、OEM 嵌入或定制条款的团队。

通过 Hub 分享的技能保持各自许可（通常是 MIT）。

---

<p align="center">
  <a href="https://www.markus.global">官网</a> ·
  <a href="https://markus.global/blog">博客</a> ·
  <a href="https://github.com/markus-global/markus/discussions">Discussions</a> ·
  <a href="https://github.com/markus-global/markus/issues">Issues</a>
</p>

<p align="center">
  <sub>Markus —— 让 AI 智能体像团队一样工作</sub>
</p>
