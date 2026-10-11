<p align="center">
  <img src="logo.png" width="150" alt="Markus" />
</p>

<h1 align="center">Markus</h1>

<p align="center">
  <strong>An open-source AI workforce you run yourself.</strong><br />
  Give it a goal in plain language. Markus builds the team, splits the work, runs the<br />
  specialists in parallel, and reviews every delivery before it reaches you.<br />
  <em>It keeps working on its own clock — on your machine, with your keys.</em>
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
  <strong>English</strong> | <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="docs/images/dashboard-preview.gif" width="840" alt="The Markus dashboard: agents planning, working, reviewing and delivering" />
</p>

---

**Markus is a self-hosted AI workforce.** Not one chat window that forgets yesterday — an
organization: roles with real skills, a task board, memory that persists, peer review before
anything is called done, and a human (you) in charge.

*For people who want an AI team, not a chatbot.*

---

## Watch it work

```
You     I need a competitive analysis and a go-to-market plan.

Markus  ▸ requirement created
        ▸ team assembled — 3 roles, 3 tasks, 2 dependencies

            Research Lead       competitor scan     reviewer: Senior Researcher
            Senior Researcher   market sizing       reviewer: Research Lead
            Content Director    go-to-market plan   blocked by the two above

        08:41  two tasks start in parallel, each in its own workspace
        09:12  competitor scan delivered → peer review → one revision requested
        09:26  revision delivered → approved
        09:30  go-to-market plan unblocked, starts automatically
        09:58  three deliverables on the board, you get one notification
```

Nothing is marked done because an agent said so. Every delivery is reviewed by a peer, and the
whole loop is on the record. Then the crew picks up the next task on its own — including at 3am.

---

## One copilot is an intern. You need a company.

A copilot is brilliant at one task, remembers nothing tomorrow, and grades its own homework. The
work that actually matters — a quarter of research, a product launch, a codebase that grows — is
not one task.

|                      | A single copilot            | Markus                                          |
| -------------------- | --------------------------- | ----------------------------------------------- |
| **Scale**            | One task at a time          | Specialists running in parallel                 |
| **Memory**           | Gone when the session ends  | Persists, consolidates, and compounds            |
| **Initiative**       | Waits for your prompt       | Patrols its own task board, around the clock     |
| **Quality**          | "Done" is self-reported     | A peer reviews and gates every delivery          |
| **Visibility**       | N tabs, N windows           | One board, one audit trail                       |
| **Where it runs**    | Someone else's cloud        | Your machine, your keys, your data               |

---

## 🚀 Quickstart

**The desktop app is the recommended way in.** It brings its own runtime *and* its own browser,
so there is no Node.js to install, no terminal, and nothing to open afterwards.

| Platform | Installer |
| --- | --- |
| **macOS** — Apple Silicon or Intel | `Markus-….dmg` |
| **Windows** — x64 | `Markus-Setup-….exe` |
| **Linux** — x64 | `Markus-….AppImage` (also `.deb`, `.tar.gz`) |

Download from **[markus.global](https://www.markus.global)** or
**[GitHub Releases](https://github.com/markus-global/markus/releases/latest)** — the same files
either way.

Then open the app and give your Secretary something real to do:

> *"We're launching in Europe next quarter. Research the market, size it, and draft a launch plan."*

Markus turns that into a requirement, hires the roles it needs, puts the tasks on the board, and
starts working. You watch, steer, and approve.

<details>
<summary><strong>Prefer a server, a VPS, or a machine with no desktop?</strong></summary>

The CLI runs the same thing and serves the UI in your browser at <http://localhost:8056>.

```bash
# Linux / macOS — installs a runtime too if Node.js is missing
curl -fsSL https://markus.global/install.sh | bash && markus start

# Anywhere with Node.js 22+
npm install -g @markus-global/cli && markus start
```

Either path needs a modern browser to open the UI.
</details>

No database to install, no cloud account, no API gateway: SQLite and the UI ship with the app.
The only thing you need to bring is a model — a hosted API key, or a local model through Ollama.

<sub>Working from source instead? See [CONTRIBUTING.md](CONTRIBUTING.md).</sub>

---

## What people put it to work on

- **Research and analysis** — competitor scans, market sizing, due diligence. Memos that cite where they got their numbers, reviewed by a second agent before they reach you.
- **Content operations** — one brief becomes an article, a thread, a newsletter and a short-video script, drafted in parallel and reviewed for consistency.
- **Software** — this repository is built this way (see below).
- **Standing watch** — daily scans, price and risk monitoring, inbox triage. The kind of work that is mostly "check, then report" runs unattended and wakes you only when something actually changed.

---

## Why Markus

- **🔒 Self-hosted, bring your own keys.** Credentials live in your deployment, never in someone else's cloud. SQLite by default, PostgreSQL when you need it.
- **🧠 Memory that compounds.** Agents keep what they learn — the facts, the decisions, and how they got there — and consolidate it between sessions. Month two is better than month one.
- **⏰ A night shift that actually works.** A heartbeat keeps the board moving on its own: async completions, blocked dependencies, escalations. You sleep; the work does not stop.
- **🛡️ Review is not optional.** Every delivery goes submit → review → approve or revise, with a full audit trail. Failed attempts and blockers are recorded too, because that is where the lessons are.
- **🔌 Skills and MCP, in both directions.** Import from skills.sh, SkillHub, OpenClaw, AgentScope or any MCP server — and export your best skills back to the community.
- **🤖 Any model, no lock-in.** Anthropic, OpenAI, Google, DeepSeek, MiniMax, Fireworks, OpenRouter, or a fully local model via Ollama — with unified model discovery and automatic failover.

---

## It builds itself

Markus is developed on Markus. The issues, requirements, task assignments, peer reviews and
release notes in this repository run through a Markus organization — the same product you
download. Bugs its own agents find get fixed by its own agents, reviewed by a peer, and merged by
a human.

It is the most honest benchmark we have: if it could not ship itself, you should not trust it to
ship your work.

---

## Under the hood

A TypeScript monorepo: the agent runtime and context engine, a REST + WebSocket API, a React
dashboard, an Electron desktop app, SQLite storage, comms bridges (Slack, Feishu, WhatsApp,
Telegram, Discord), GUI and browser automation, and an agent-to-agent protocol.

The internals are documented properly — start at the **[documentation index](docs/README.md)**:

| | |
| --- | --- |
| [Architecture](docs/architecture/architecture.md) | How the pieces fit, and why |
| [Agent runtime](docs/architecture/agent-runtime.md) · [Memory](docs/architecture/memory-system.md) · [Tools](docs/architecture/tool-system.md) | The three subsystems people ask about most |
| [API reference](docs/api/api.md) · [User guide](docs/guides/guide.md) | Build against it, or just use it |
| [Engineering records](docs/records/) | Dated audits and post-mortems, published unfiltered |

---

## 💬 Community

- **GitHub Discussions** — questions, show & tell, case studies: <https://github.com/markus-global/markus/discussions>
- **Blog** — tutorials and product notes: <https://markus.global/blog>
- **Discord** — real-time help with users and contributors — *coming soon*
- **微信群** — 中文用户交流群，内测与贡献支持（建设中）

All channels follow our [Code of Conduct](CODE_OF_CONDUCT.md). Community details are in
[docs/guides/community.md](docs/guides/community.md).

---

## Contributing

```bash
pnpm install && pnpm build
pnpm dev          # API + web UI in dev mode
pnpm test         # unit + integration tests
pnpm typecheck    # TypeScript, all packages
pnpm lint         # ESLint
```

- [Good first issues](https://github.com/markus-global/markus/labels/good%20first%20issue) — small, well-scoped, mentored
- [Help wanted](https://github.com/markus-global/markus/labels/help%20wanted) — things the community needs
- [Bug reports](https://github.com/markus-global/markus/issues) — with a repro, ideally

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

Markus is **pre-1.0 (0.11.x)** and moving quickly, so minor releases can contain breaking changes.
That is precisely why feedback, issues and pull requests are most valuable right now.

---

## License

Markus is dual-licensed:

- **Open source** — [Apache-2.0](LICENSE). Use it, modify it, self-host it, ship it commercially.
- **Commercial** — [available](LICENSE-COMMERCIAL.md) for teams that need support, indemnification, OEM embedding or custom terms.

Skills shared through the Hub keep their own licenses (usually MIT).

---

<p align="center">
  <a href="https://www.markus.global">Website</a> ·
  <a href="https://markus.global/blog">Blog</a> ·
  <a href="https://github.com/markus-global/markus/discussions">Discussions</a> ·
  <a href="https://github.com/markus-global/markus/issues">Issues</a>
</p>

<p align="center">
  <sub>Markus — where AI agents work as a team</sub>
</p>
