# Markus Agent Runtime

> Single source of truth for **Context Economics + Learning Loop**.
> Spec language: **MUST** / **SHOULD** / **MUST NOT**. Test IDs map to plan Wave A/B/C.
> Related: [PROMPT-ENGINEERING.md](./PROMPT-ENGINEERING.md), [TOOL-SYSTEM.md](./TOOL-SYSTEM.md),
> [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md), [LEARNING-LOOP.md](./LEARNING-LOOP.md),
> [STATE-MACHINES.md](./STATE-MACHINES.md).

**Formula**: `Agent = LLM + Harness + Learning Loop`.
**Hard constraint**: the Context Surface keeps cold-start fixed prefix cheap while skills/experience grow unbounded.

---

## §1 Invariants

### §1.1 Fixed-prefix budget

MUST: Every LLM call's fixed prefix `systemTokens + toolDefTokens` MUST fit the active scenario pack budget (see §3) before history is considered.

MUST: When `promptAffordTokens` is known and
`systemTokens + toolDefTokens + PROMPT_AFFORD_OUTPUT_RESERVE + safetyMargin > promptAffordTokens`,
the runtime MUST downgrade once to the `reflex` pack+profile and re-pack; if still over, it MUST NOT call the provider (`prompt_pack_rejected`).

MUST (§Afford.S1): The same afford gate MUST run on **every** LLM entry that calls
`prepareMessages` before the provider — including `handleMessage` **and**
`handleMessageStream` (and task streams that share prepare). Shared helper
`ensureAffordablePromptPack` MUST be used so stream/non-stream cannot drift.

MUST NOT: Shrink only `messageBudget` while shipping a fixed prefix that already exceeds afford.

Test IDs: `A-afford-downgrade`, `A-afford-heartbeat-fail`, `A-budget-contract-converse`,
`A-budget-contract-reflex`, `S-stream-afford-reject`, `S-stream-afford-downgrade`.

### §1.2 Unlimited capability, limited visibility

MUST: Skill full bodies and deferred tool schemas MUST enter context only via `discover_tools` (or equivalent L1 load). Cold start exposes L0 catalog (name + short description) only.

MUST NOT: Inject full SKILL.md bodies at spawn into the system prompt.

Test IDs: `A-skill-l0-only`, `A-tooldef-budget`.

### §1.3 Execute ≠ learn

MUST: Task execution MUST NOT write new team skills. Distillation runs after **`completed`**
(including rejection→revision→approval) via the Learning Loop hook with **`scenario: distillation`**
([LEARNING-LOOP.md](./LEARNING-LOOP.md) §2) — MUST NOT reuse Dream's `memory_consolidation`.
MUST NOT: Distill on `failed`.

Test IDs: `B-hook-skip-trivial`, `B-hook-fire-complex`, `B-hook-skip-failed`,
`B-distill-uses-distillation-scenario`.

### §1.4 Human gate for evolution

MUST: High-impact (or impact-omitted) skill installs require human approve via HITL
([LEARNING-LOOP.md](./LEARNING-LOOP.md) §8.3). Low-impact skill installs MAY proceed without HITL.
Optional `.pending/` staging (§3) remains a helper path.

MUST NOT: Couple skill usage/success metrics to trust score.

Test IDs: `B-approve-install`, `B-reject-feedback`, `B-stats-reject-feedback`.

---

## §2 Scenario Capability Packs

### §2.1 Pack definitions

| Pack | Scenarios | ToolDef budget (tokens) | Prompt profile |
|------|-----------|-------------------------|----------------|
| `reflex` | `heartbeat`, `memory_consolidation` (Dream), `memory_flush`, `distillation` | 3_000 | `reflex` |
| `converse` | `chat`, `a2a`, `group_chat`, `comment_response`, `requirement_action` | 8_000 | `converse` |
| `execute` | `task_execution` | 10_000 | `execute` |
| `govern` | `review`, `deliberation` | 8_000 | `govern` |

MUST: `selectTools` / allowlists MUST resolve through the pack for the active scenario.

### §2.2 Reflex core tools

MUST: `reflex` tool set MUST be a subset of:

`task_list`, `task_get`, `memory_save`, `memory_search`, `notify_user`, `request_user_input`,
`schedule_wakeup`, `cancel_wakeup`, `set_heartbeat_interval`, `discover_tools`,
`check_mailbox`, `file_read`, `agent_send_message`, `update_notebook`,
and for managers additionally `team_status`.

MUST NOT: Include `package_install`, `package_list`, `goal_create`, `goal_update`, `goal_status`,
`spawn_subagent`, `spawn_subagents`, `deliverable_create`, `requirement_propose`,
`memory_update_longterm` in the default reflex allowlist (reachable only via `discover_tools`).

### §2.2.1 Distillation allowlist extras

MUST: When `scenario: distillation`, the runtime MAY widen the allowlist with:
`memory_update`, `memory_update_longterm`, `file_write`, `file_edit`,
`package_list`, `package_install` (plus reflex core, which already includes `request_user_input`).
MUST NOT: Add `hub_install` on the distillation turn.
MUST: Skill `package_install` follows Learning Habits impact/HITL
([LEARNING-LOOP.md](./LEARNING-LOOP.md) §2.2 / §8.3) — high/omitted impact asks first.
MUST: Inject Learning Habits for `distillation`; MUST NOT inject them for `memory_consolidation`.

Test IDs: `A-pack-reflex-tools`, `B-hb-no-evolution-essay`, `B-distill-package-install-allowed`,
`B-distill-habits-injected`, `B-dream-no-habits`.

### §2.3 Converse / execute / govern

MUST: Default `converse` MUST NOT include `spawn_subagents` or `deliverable_create` (discover only).

MUST: `execute` MUST include code/shell/coding groups (or equivalent) needed for task work.

MUST: Keyword matching and `recentToolNames` MAY accelerate loading but MUST NOT exceed the pack `toolDefTokens` budget.

Test IDs: `A-pack-converse-no-spawn`, `A-pack-execute-has-code`, `A-tooldef-sticky-capped`.

---

## §3 Budgets

| Constant | Value | Purpose |
|----------|-------|---------|
| `TOOL_DEF_BUDGET_REFLEX` | 3_000 | Max tool schema tokens |
| `TOOL_DEF_BUDGET_CONVERSE` | 8_000 | Max tool schema tokens |
| `TOOL_DEF_BUDGET_EXECUTE` | 10_000 | Max tool schema tokens |
| `TOOL_DEF_BUDGET_GOVERN` | 8_000 | Max tool schema tokens |
| `ROLE_PROMPT_MAX_TOKENS` | 6_000 | ROLE soft size metric (warn only; never truncate) |
| `KNOWLEDGE_PROMPT_MAX_TOKENS` | 1_500 | knowledge.md injection (`execute`/`govern`) |
| `KNOWLEDGE_PROMPT_MAX_TOKENS_CONVERSE` | 1_200 | knowledge.md injection (`converse`) |
| `KNOWLEDGE_PROMPT_MAX_TOKENS_REFLEX` | 0 | reflex: no full knowledge dump |
| `STATE_PROMPT_MAX_LINES_REFLEX` | 5 | state.md lines in reflex |
| `STATE_TTL_DAYS` | 7 | state.md entry expiry |
| `COLD_CONVERSE_FIXED_MAX` | 28_000 | Acceptance: system+tools |
| `COLD_REFLEX_FIXED_MAX` | 8_000 | Acceptance: system+tools |
| `SYSTEM_PROMPT_BUDGET_CONVERSE` | 16_000 | Soft size metric for converse system (observe/warn; never truncate ROLE/L0) |
| `SYSTEM_ANNOUNCEMENTS_CHARS_CONVERSE` | 400 | Team announcements body cap (converse) |
| `SYSTEM_NORMS_CHARS_CONVERSE` | 400 | Team norms body cap (converse) |
| `SYSTEM_ANNOUNCEMENTS_CHARS` | 2_000 | Team announcements body cap (execute/govern) |
| `SYSTEM_NORMS_CHARS` | 2_000 | Team norms body cap (execute/govern) |
| `SYSTEM_WORKFLOWS_MAX_CONVERSE` | 3 | Available-workflow lines in converse |
| `SYSTEM_DYNAMIC_CONTEXT_CHARS_CONVERSE` | 800 | Caller `dynamicContext` blob cap (converse) |
| `DEFERRED_CATALOG_MAX_CHARS` | 1_500 | Tier-3 rediscovery catalog hard cap |
| `DEEP_SLEEP_IDLE_HEARTBEATS` | 3 | Consecutive idle before skip LLM |
| `SUBTASK_SOFT_CAP` | 8 | Warn at/above this count |

Constants live in `@markus/shared` `limits.ts`.

---

## §4 Prompt Profiles

### §4.1 Profile → sections

| Section | reflex | converse | execute/govern |
|---------|--------|----------|----------------|
| ROLE (full; soft warn metric) | yes | yes | yes |
| L0 + Collaboration Rules | yes (complete, concise) | yes (complete, concise) | yes (complete, concise) |
| Identity (roster) | manager + ≤3 active | capped (existing max) | capped |
| knowledge.md | no | capped (`KNOWLEDGE_PROMPT_MAX_TOKENS_CONVERSE`) | capped (`KNOWLEDGE_PROMPT_MAX_TOKENS`) |
| state.md | ≤5 lines | short/optional | short/optional |
| Skill L0 catalog | yes | yes | yes |
| Skill full bodies | discover only | discover only | discover only |
| L3 checklists (quality/git/error recovery) | no | **no** (incl. `comment_response`) | yes |
| Team announcements / norms | capped | capped (400 chars) | capped (2000 chars) |
| Available workflows | as needed | ≤3 short lines | full list |
| Channel history / shared deliverables | no | optional short | as needed |
| Task board detail | counts + top blocked/failed | only when non-empty | existing caps (empty stub ok) |
| Date / locale / Interaction Mode | yes | **always** (never trimmed) | yes |

MUST: `buildSystemPrompt` MUST accept `promptProfile` derived from scenario pack.

MUST: Size control is **progressive disclosure**, not truncation of always-on text:
- Always-on (never truncated): ROLE.md (persona only — **not** HANDBOOK.md), L0 capability
  rules, **`## Markus Collaboration Rules`** (distilled from HANDBOOK.md), Interaction Mode,
  date/locale.
- Collaboration Rules MUST encode **Conversation-first + Task-when-needed**: chat may
  pair-build; tasks for async/delegation/formal review; STOP only after `task_create`
  for that work. Managers are player-coach (ROLE may build; Position routes when useful).
- Progressive at assemble: knowledge digest (demote `##`→`###`, deprioritize stale
  fault/transcript sections), announcements/norms, workflows, CONTEXT.md
  (full content on disk / via tools). HANDBOOK.md long-form is the **AGENT HANDBOOK** —
  a single source of truth (`templates/roles/HANDBOOK.md`) that ships with the build and
  upgrades on rebuild/release; it is **NOT injected** and **NOT copied per-agent**. The
  `## Platform Handbook (on demand)` section injects the **resolved absolute path**
  (via `AgentManager.resolveHandbookPath`), so agents `file_read` the handbook directly
  without searching it.
- Progressive at tool layer: Markus core schemas LIVE; skill/MCP schemas only after
  `discover_tools` (boot MUST register without activate; sticky/recent MUST NOT
  re-activate skill/MCP). Activated skill/MCP MAY LRU-defer under toolDef budget;
  CORE_KEEP + HITL + discover never defer.
- Heartbeat MUST skip/defer LLM turns while `human_chat` is focused or queued.
- Team Status SHOULD label stopped agents as `stopped` (not scary `offline`); when
  all listed teammates are stopped, hint `agent_start` and that Owner chat work may continue.
- Work-context-bound tools (`task_submit_review`, subtasks, `task_note`, …) MUST appear
  LIVE only in **entity-bound sessions**: `execute` / `govern`, or converse scenarios
  `comment_response` / `requirement_action` / `workflow_action`. MUST NOT sticky into
  free `chat` / `a2a` / `group_chat` / reflex. `task_submit_review` resolves `task_id`
  from ALS/`activeTasks` when present; otherwise the agent MUST pass `task_id`
  (no board guessing).

MUST (§Afford.S3): `SYSTEM_PROMPT_BUDGET_CONVERSE` is an observe/warn metric only.
MUST NOT: Runtime-truncate ROLE, L0, or Collaboration Rules to fit that metric.
Provider afford guard handles hard limits (downgrade/reject).

Test IDs: `A-profile-reflex-omits`, `A-profile-role-full`, `A-collab-rules-always-on`,
`A-role-no-shared-append`, `A-knowledge-cap`, `A-profile-converse-no-l3`,
`S-converse-keeps-essentials`, `S-converse-keeps-date`, `S-tool-mcp-progressive`.

---

## §5 ToolDef budget eviction (Hermes Tool Search style)

MUST: Skill/MCP tool schemas (`feishu_*`, `*__*`, `chrome-devtools*`) MUST NOT enter
the LIVE tool list except via explicit `discover_tools` activation.
MUST: Markus core tools (`TOOL_DEF_CORE_KEEP`: shell/file/task/memory/…) +
`discover_tools` + HITL MUST stay LIVE for converse/execute/govern.
MUST: When estimated tool-definition tokens still exceed the pack budget, evict
optional extras / activated skill-MCP (LRU) only — never CORE_KEEP or HITL/discover.
Prefer catalog (Tier 3 / inactive namespace list) over schema dump.

Test IDs: `S-tool-mcp-progressive`, `S-tooldef-evict-mcp-before-core`, `S-activated-mcp-lru`.

MUST (§Afford.S2): Evicted tool rediscovery catalog MUST be injected into the volatile
`[Live context]` tail (never a system segment — byte-stable prefix must be preserved), as a
short name-only (or name + ≤40 chars) list, total ≤ `DEFERRED_CATALOG_MAX_CHARS`.

MUST NOT: Append the eviction catalog to `discover_tools.description` (that re-inflates
`toolDefTokens` and defeats the budget).

MUST: After `discover_tools` activates tool names, the runtime MUST rebuild the LLM
`tools` schema list before the next provider call (stream / chat / task / session
continuations). Core + HITL stay immune; skill/MCP activations may later LRU-defer.
MUST NOT: Reuse a stale pre-discover `llmTools` array across tool-loop iterations —
that makes activation a no-op and causes discover_tools death spirals.
MUST: Consecutive `discover_tools` calls (any args) ≥ 5 MUST be treated as a
critical loop and break the tool loop.

Test IDs: `A-tooldef-budget`, `A-tooldef-sticky-capped`, `S-catalog-not-in-tooldef`,
`S-discover-activated-protected`, `S-discover-tools-spin`.

### §5.1 max_tokens reservation clamp (§Afford.S4)

MUST: On OpenRouter reservation 402 (`requested up to N … can only afford M`), retry with
`max_tokens = min(M, max(512, M - safety))`.

MUST: When `lastPromptAffordTokens` is known, **first** request MUST also clamp
`max_tokens ≤ promptAfford - estimatedPrompt - margin` so the client does not send a
doomed high reservation (e.g. 13156) before failing.

Test IDs: `S-max-tokens-clamp-remaining`.

---

## §6 Memory taxonomy

MUST: Persistent semantic storage MUST use:

| File | Role |
|------|------|
| `knowledge.md` | Permanent curated knowledge |
| `state.md` | Time-bounded snapshots (TTL) |
| `NOTEBOOK.md` | Situational workspace |
| observations buffer | Raw insights; never fully injected |

MUST: On first load, migrate legacy `MEMORY.md` (heuristic: dated/silent/current → state; else knowledge).

Details: [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md).

Test IDs: `A-knowledge-cap`, `C-dream-state-ttl`.

---

## §7 Learning Loop (summary)

State machine: `task completed → DistillationHook → Habits encode (memory / skill+HITL) → stats → DreamLibrarian → fanout`.

Also: platform **Learning Habits** L0 (look-back / encode-where / skill impact) and user-initiated
**Remember-from-message** → child evolution session (user↔agent DM only).

Details and MUST rules: [LEARNING-LOOP.md](./LEARNING-LOOP.md) §2–§9.

Test IDs (habits / remember): `B-prompt-learning-habits-*`, `B-skill-install-*`,
`B-self-evolution-skill-retired`, `B-evolve-*`, `B-recall-chat-session-*`, `B-ui-remember-*`.

---

## §8 Governance (summary)

- Review verdicts: `approved` | `approved_with_notes` | `rejected`
- `task_context` attached on assign
- Deliverable `version` + `changelog`
- Deep sleep after idle heartbeats
- Subtask soft cap warning

Details: [STATE-MACHINES.md](./STATE-MACHINES.md) and TOOL/MEMORY docs.

Test IDs: `C-review-notes`, `C-task-context-inject`, `C-deliv-version`, `C-subtask-soft-cap`, `A-deep-sleep-skip`, `A-deep-sleep-wake`.

---

## §9 Acceptance metrics

| Metric | Target | Verify |
|--------|--------|--------|
| Cold converse fixed | ≤ 28_000 | `A-budget-contract-converse` + live |
| Cold reflex fixed | ≤ 8_000 | `A-budget-contract-reflex` + live |
| Deep sleep quiet period | 0 LLM calls | `A-deep-sleep-skip` + live |
| Afford over fixed | 0 provider calls | `A-afford-downgrade` |
| Skill library growth | Does not increase fixed L0 cost beyond catalog | `A-skill-l0-only` |
| Evolution rates API | reuse / first-pass / distill rate | `C-metrics-api` |

---

## §10 Spec → Test → Implement → Verify

1. Spec merged (this doc + linked specs).
2. Failing tests with Test IDs above.
3. Minimal implementation to green.
4. Verify checklist against MUST rows; live cold-start logs for Wave D.

If Spec is wrong: fix Spec → fix tests → fix code (never hack around Spec).

## §11 Verification checklist (Wave D)

Automated (must be green):

- [x] `packages/core/test/capability-packs.test.ts` (A-pack-*, A-tooldef-*)
- [x] `packages/core/test/afford-guard.test.ts` (A-afford-*)
- [x] `packages/core/test/deep-sleep.test.ts` (A-deep-sleep-*)
- [x] `packages/core/test/prompt-profiles.test.ts` (A-profile-*, B-hb-no-evolution-essay)
- [x] `packages/core/test/prompt-budget.contract.test.ts` (A-budget-contract-*)
- [x] `packages/core/test/learning-loop.test.ts` (B-hook-*, B-stats-*)
- [x] `packages/core/test/memory-taxonomy.test.ts` (A-knowledge / C-dream-state-ttl)
- [x] `packages/core/test/skill-fanout.test.ts` (C-fanout-*, C-task-context-inject)
- [x] `packages/core/test/evolution-metrics.test.ts` + `GET /api/evolution/metrics` (C-metrics-api)
- [x] `packages/core/test/governance-runtime.test.ts` (C-review-notes / C-subtask-soft-cap)

Live (operator):

1. Cold chat: log `systemTokens`+`toolDefTokens` ≤ 12k
2. Cold heartbeat / deep sleep: ≤ 8k fixed; idle skips LLM
3. Low afford: `prompt_pack_rejected` without OR call
4. Complex task complete → distillation (Habits encode; skill install via §8.3 HITL)
5. Deliverable update returns `version` bump
6. `acceptTask(..., notes)` stores `approved_with_notes`
