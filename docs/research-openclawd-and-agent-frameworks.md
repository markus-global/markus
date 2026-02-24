# Research: OpenClawd, Claude Code & Agent Frameworks — Analysis for Markus

## Executive Summary

This document summarizes research on **OpenClaw** (formerly OpenClawd), **Claude Code** (Claude Agent SDK), and related agent frameworks. Key findings and recommendations are tailored to Markus’s organizational AI platform goals.

---

## 1. OpenClaw (OpenClawd) — Personal AI Assistant Framework

### 1.1 What Is OpenClaw?

OpenClaw is an open-source personal AI assistant (223K+ GitHub stars) that runs locally on your devices. It acts as a **gateway control plane** connecting messaging platforms (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, etc.) to an LLM-powered agent.

### 1.2 Architecture Overview

```
Channels (WhatsApp/Telegram/Slack/Discord/...) → Gateway (WS control plane) → Pi agent runtime
                                                      ↓
                                              CLI / WebChat / macOS / iOS / Android
```

- **Gateway**: Single WebSocket control plane at `ws://127.0.0.1:18789`
- **Pi Agent Runtime**: RPC-mode agent with tool streaming and block streaming
- **Multi-agent routing**: Route channels/accounts/peers to isolated agents (workspaces + per-session)
- **Event-driven**: Session lifecycle, tool events, assistant deltas via event streams

Two core primitives distinguish it from simple chatbots:

1. **Autonomous invocation** — Time/event-driven execution with session isolation
2. **Persistent state** — Externalized memory as local Markdown documents

### 1.3 Key Features

| Feature | Implementation |
|---------|----------------|
| **Tools** | Built-in (~20 tools): shell, file, web fetch, apply-patch, browser, canvas, nodes, cron, sessions, Discord/Slack actions |
| **Skills** | Extensions in `skills/` directory; ClawHub marketplace (5,700+ community skills) |
| **Plugins** | MCP-based integrations for broader tool compatibility |
| **Context** | Bootstrap files (AGENTS.md, SOUL.md, TOOLS.md), workspace context |
| **Conversation** | Session model: main, group isolation, activation modes, queue modes |

### 1.4 Permissions & Security Model

- **Sandbox Mode**: Isolates high-risk skill execution via Docker (`agents.defaults.sandbox.mode: "non-main"`)
- **Workspace Scope**: Least-privilege directory restrictions (`WORKSPACE_DIR`)
- **Human Confirmation Gates**: Approval workflows for risky writes (`REQUIRE_HUMAN_CONFIRMATION`)
- **Exec Approvals**: Allowlist/denylist for shell commands; per-agent glob patterns
- **DM Pairing**: Unknown senders get pairing code; explicit opt-in for public DMs

### 1.5 Memory & Context Window Management

| Layer | Format | Behavior |
|-------|--------|----------|
| **Short-term** | In-session | Limited by model context; cleared when session ends |
| **Medium-term** | `memory/YYYY-MM-DD.md` | Auto-generated daily logs, append-only |
| **Long-term** | `MEMORY.md` | Curated persistent facts, preferences, decisions |

**Auto-compaction**: At ~92% context usage, OpenClaw summarizes older conversation history into a compact entry; persists in session JSONL.

**Memory flush**: Before compaction, a silent agentic turn reminds the model to write durable memories to disk (`agents.defaults.compaction.memoryFlush`).

**Tools**: `memory_get` (targeted read), `memory_search` (semantic recall via Mistral/Voyage embeddings)

### 1.6 MCP Integration

- OpenClaw supports MCP via **plugins** (MCP-based integrations)
- Claude Code skill (e.g., Enderfga/openclaw-claude-code-skill) integrates Claude Code via MCP
- Skills can expose MCP servers; tools flow as standard tool calls into the agent

### 1.7 Tools Provided

**Built-in**: bash, process, read, write, edit, sessions_list, sessions_history, sessions_send, sessions_spawn, browser, canvas, nodes, cron, discord, gateway (configurable allowlist/denylist per session)

**Skills (examples)**: Web Search (Brave API), Image Generation, Calendar, Voice, Browser automation

### 1.8 Multi-Turn Conversations & Tool Loops

- **Serialized per-session**: One run at a time per session lane
- **Queue modes**: collect/steer/followup feed into lane system to avoid races
- **Agent loop**: intake → context assembly → model inference → tool execution → streaming → persistence
- **Tool events**: Streamed as `tool` events; assistant deltas as `assistant` events; lifecycle as `lifecycle`

### 1.9 Prompt Engineering

- System prompt built from: base prompt, skills prompt, bootstrap context, per-run overrides
- Injected files: `AGENTS.md`, `SOUL.md`, `TOOLS.md`
- Skills: `~/.openclaw/workspace/skills/<skill>/SKILL.md`
- Hooks: `agent:bootstrap`, `before_prompt_build`, `before_model_resolve`

### 1.10 Streaming

- **Token-ish streaming** (Telegram): Temporary preview messages with partial text
- **Block streaming** (all channels): Completed text blocks via `EmbeddedBlockChunker`; configurable bounds (paragraph → newline → sentence → whitespace)
- **Discord**: `maxLinesPerMessage` (default 17), chunk modes (length/newline), coalescing

### 1.11 Communication Integrations

WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, BlueBubbles (iMessage), iMessage (legacy), Microsoft Teams, Matrix, Zalo, WebChat, macOS/iOS/Android nodes.

### 1.12 Deployment

- **Local**: `npm install -g openclaw@latest` + `openclaw onboard --install-daemon`
- **Docker**: Docker-based installs; sandbox containers for non-main sessions
- **Tailscale**: Serve (tailnet) or Funnel (public) for remote Gateway access
- **Cloud**: openclaw.new — deploy in under 1 minute (managed)

---

## 2. Claude Code (Claude Agent SDK) — Developer Agent Framework

### 2.1 Overview

Claude Code is Anthropic’s **Claude Agent SDK** — an open-source tool for building AI agents in Python and TypeScript. Focus: coding assistance and workflow automation.

### 2.2 Architecture: Master Agent Loop

```
User input → Model analyzes → If tool needed: call → Feed results → Repeat until final answer
```

**Pattern**: `while(tool_call) → execute tool → feed results → repeat`

- Single-threaded, flat message history
- No swarms; at most one sub-agent at a time for parallel exploration
- Design goal: debuggability and reliability

### 2.3 Key Components

| Component | Role |
|-----------|------|
| **Compressor (wU2)** | Triggers ~92% context usage; summarizes to long-term storage (Markdown) |
| **ToolEngine & Scheduler** | Orchestrates tool invocations, queues model queries |
| **StreamGen** | Streaming output |
| **h2A queue** | Async dual-buffer; pause/resume; user interjections mid-task |

### 2.4 Built-in Tools

- **Read**: Glob, LS, View (~2000 lines), GrepTool (regex, not embeddings)
- **Edit**: Write, Replace, Edit (surgical patches)
- **Execute**: Bash (persistent shell, risk classification, confirmation)
- **Web**: WebFetch (user-mentioned or in-project URLs)
- **Code**: NotebookRead/Edit, BatchTool
- **Planning**: TodoWrite (structured JSON task list)

### 2.5 MCP Integration

- Claude Code acts as **MCP client**
- Servers provide context, tools, prompts
- Transports: HTTP with SSE, stdio for local, custom
- Example: `claude mcp add --transport http notion https://mcp.notion.com/mcp`

### 2.6 Context & Memory

- **CLAUDE.md** as project memory
- Compressor summarizes when approaching context limits
- Simple Markdown files over databases (“do the simple thing first”)
- Regex over embeddings for search

### 2.7 Safety

- Permission system for write, risky Bash, external tools (MCP/web)
- Allowlist/denylist, always-allow rules
- Command sanitization; risk-level classification; diff-first workflow

---

## 3. Related Projects — Comparative Analysis

### 3.1 OpenHands (formerly OpenDevin)

| Aspect | Details |
|--------|---------|
| **Focus** | AI software engineer agent |
| **Architecture** | MonologueAgent default; SWE Agent under development; LiteLLM for models |
| **Sandbox** | Docker containers, isolated workspace |
| **Tools** | Bash, code editor, web browser |
| **SDK** | openhands.sdk (core), openhands.tools, openhands.workspace, openhands.agent_server |
| **Deployment** | Local (LocalWorkspace), CLI, GUI, enterprise cloud |

**Innovation**: Full software engineering loop (code, test, debug) in a sandbox; multi-agent coordination.

### 3.2 SWE-agent

| Aspect | Details |
|--------|---------|
| **Focus** | Automate GitHub issue resolution (SWE-bench) |
| **Architecture** | Agent class (YAML config), SWEEnv, History Processor, Parser |
| **Key Innovation** | **Agent-Computer Interface (ACI)** — LM-centric commands and feedback |

**ACI Principles**:

1. **Clear feedback** — Commands with no output return explicit success message
2. **Optimized search** — Custom directory search; succinct matching files only
3. **Specialized viewer** — Custom viewer, 100 lines/turn, scrolling
4. **Syntax validation** — Linter on edit commands before submission

**Learning**: “Good ACI design is as important as prompt engineering.”

### 3.3 AutoGPT / AgentGPT

| Aspect | Details |
|--------|---------|
| **Architecture** | Goal → initial prompt → LLM → iterative actions → feedback loop |
| **Patterns** | Goal-driven, self-planning, self-correction (criticism loops), autonomous decision |
| **AutoGPT Forge** | Component-based: SystemComponent, UserInteractionComponent, FileManagerComponent, CodeExecutorComponent |

### 3.4 CrewAI

| Aspect | Details |
|--------|---------|
| **Focus** | Multi-agent orchestration |
| **Concepts** | Agents (roles, goals, tools, memory), Tasks, Crews, Flows |
| **Execution** | Sequential, hierarchical, conditional, async kickoff |
| **Features** | Human-in-the-loop, task replay, workflow tracing, enterprise management |

### 3.5 LangGraph

| Aspect | Details |
|--------|---------|
| **Focus** | Stateful agent orchestration |
| **Model** | Directed graph: nodes = actions, edges = flow, conditional edges = branching |
| **Features** | State management, human-in-the-loop, checkpoints, streaming |
| **Production** | Used by Uber, LinkedIn, Klarna |

---

## 4. Key Innovations & Patterns Summary

| Project | Key Innovation | Relevance to Markus |
|---------|----------------|---------------------|
| **OpenClaw** | Gateway model, multi-channel, skills ecosystem, layered memory | Organizational scope, comms, extensibility |
| **Claude Code** | Simple master loop, compressor, TodoWrite, diff-first | Agent loop, context management |
| **OpenHands** | Full dev sandbox, SDK modularity | Compute isolation, packaging |
| **SWE-agent** | ACI — LM-centric commands, clear feedback | Tool UX, feedback design |
| **AutoGPT** | Criticism loops, component architecture | Self-correction, modular design |
| **CrewAI** | Multi-agent crews, flows, hierarchy | Multi-agent teams |
| **LangGraph** | Graph-based state machine, checkpointing | Complex workflows, recovery |

---

## 5. Actionable Recommendations for Markus

### 5.1 High Priority

#### 5.1.1 Context Compaction & Memory Flush

**Current**: Markus uses `summarizeAndTruncate` when messages exceed threshold; no proactive memory flush.

**Recommendation**: Add OpenClaw-style **auto-compaction** with **memory flush** before summarization:

- Trigger at ~85–90% of `maxContextTokens`
- Run a silent agent turn: “Summarize key facts and decisions to MEMORY.md before compaction”
- Then summarize and truncate older messages

#### 5.1.2 Layered Memory Architecture

**Current**: Markus has `MemoryStore` with entries (fact, note, conversation) and sessions; `search()` is substring-based.

**Recommendation**:

- Add **daily log** layer: `memory/YYYY-MM-DD.md`-style append-only logs
- Add **semantic search** via embeddings (Mistral/Voyage or local) for `memory_search`
- Keep MEMORY.md / equivalent for curated long-term facts

#### 5.1.3 Tool Feedback Quality (ACI-inspired)

**Current**: Tools return raw results; some may be empty or unclear.

**Recommendation**: SWE-agent ACI principles:

- **Explicit success**: When a tool returns no useful output, return `(success: no output)` or similar
- **Structured output**: Normalize tool responses (title, body, success, error)
- **Scoped viewers**: For file_read, consider pagination (e.g., 100 lines) with `offset`/`limit`

#### 5.1.4 Streaming Support

**Current**: Markus uses `llmRouter.chat()` which returns full response; no streaming.

**Recommendation**:

- Add streaming API to LLM provider and router
- Support block streaming (like OpenClaw) for comms adapters
- Expose `assistant` and `tool` event streams for real-time UI

#### 5.1.5 Permissions & Sandbox Layering

**Current**: Markus uses Docker sandbox per agent; policies in POLICIES.md.

**Recommendation**:

- Add **exec approval**: Allowlist/denylist for shell commands (glob patterns)
- Add **human confirmation** for high-risk writes (e.g., `file_write` outside workspace)
- Document and enforce workspace scope (least-privilege paths)

### 5.2 Medium Priority

#### 5.2.1 Agent Loop Hooks

**Recommendation**: OpenClaw-style plugin hooks for:

- `before_tool_call` / `after_tool_call`
- `before_compaction` / `after_compaction`
- `message_received` / `message_sending` / `message_sent`

Enables logging, compliance, and extensions without changing core code.

#### 5.2.2 TodoWrite / Planning Tool

**Recommendation**: Add a `todo_write` tool (like Claude Code) so agents can maintain a task list:

- Structured JSON: id, content, status, priority
- Inject current TODO state after tool uses to keep focus
- Expose in UI for visibility

#### 5.2.3 MCP HTTP Transport

**Current**: Markus MCP client uses stdio only.

**Recommendation**: Add HTTP/SSE transport for remote MCP servers (Notion, Slack, etc.) per `claude mcp add --transport http`.

#### 5.2.4 Skills / Extensions Registry

**Recommendation**: Introduce a skills/plugins system:

- `SKILL.md` per skill with name, description, tools
- Registry in `markus.json` or similar
- Optional marketplace (ClawHub-style) for community skills

### 5.3 Lower Priority / Roadmap

- **Session intelligence**: OpenClaw’s 5-factor scoring for resuming vs. new sessions
- **Block chunking**: Configurable chunk sizes for Discord/Slack (max lines, coalescing)
- **LangGraph-style flows**: For complex, branched workflows (e.g., approval chains)
- **A2A protocol**: Already on Markus roadmap; align with OpenClaw’s `sessions_send` semantics

---

## 6. Implementation Roadmap (Suggested Order)

1. **Tool feedback (ACI)** — Quick win; improves agent behavior
2. **Context compaction + memory flush** — Reduces context overflow
3. **Streaming** — Better UX for comms
4. **Semantic memory search** — Richer recall
5. **Exec approvals** — Security hardening
6. **Agent hooks** — Extensibility
7. **TodoWrite** — Planning support
8. **MCP HTTP transport** — Broader tooling
9. **Skills registry** — Ecosystem growth

---

## 7. References

- OpenClaw: https://github.com/openclaw/openclaw
- OpenClaw Docs: https://docs.openclaw.ai
- Claude Agent SDK: https://docs.anthropic.com/en/docs/claude-code/sdk
- Claude Code MCP: https://docs.claude.com/en/docs/claude-code/mcp
- SWE-agent: https://swe-agent.com
- SWE-agent ACI: https://swe-agent.com/0.7/background/aci
- OpenHands: https://docs.openhands.dev
- LangGraph: https://blog.langchain.dev/langgraph/
- CrewAI: https://docs.crewai.com

---

*Generated for Markus AI Native Digital Employee Platform. Last updated: Feb 2026.*
