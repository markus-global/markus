# Learning Loop

> Normative Spec for Markus self-evolution. SSOT overview: [AGENT-RUNTIME.md](./AGENT-RUNTIME.md) §1.3–§1.4 / §7.
> Inspired by Hermes: execute ≠ learn; write-approval gate; progressive disclosure prerequisite.

---

## §0 Architecture map (one SOP, five triggers)

**Learning Habits** (§8) is the single encode SOP. Triggers must not steal each other's jobs:

| Mechanism | Trigger | Scenario | Habits injected? | Job |
|-----------|---------|----------|------------------|-----|
| Learning Habits | Always (non-dream) | N/A (L0 text) | — | Look back / me-vs-others / encode / verify |
| Remember | User button (DM) | `chat` child session | Yes | Human-driven chat replay (§9) |
| Distillation | Task **completed** (predicates) | **`distillation`** | **Yes** | Trajectory → Learning Habits encode (§2) |
| Dream | obs ≥50, ~1×/day | `memory_consolidation` | **No** | Hygiene: dedupe/merge/promote/TTL (§5) |
| Memory Flush | Context high-water | `memory_flush` / sys | No essay | Preserve before compaction |
| Heartbeat | Timer | `heartbeat` | Yes (short) | Patrol only; ≤1-line `memory_save` (§7) |

MUST NOT: Run post-task reflection under `memory_consolidation` (that scenario is Dream-only).
MUST NOT: Use Dream to encode a fresh task trajectory (Distillation owns that).

---

## §1 Goals

Turn **completed** task trajectories (especially those with reviewer/user feedback via revision)
into durable assets (memory → skills) without bloating the Context Surface.
Skill library growth MUST only increase L0 catalog size.

---

## §2 Distillation Hook

### §2.1 Trigger

MUST: After a task reaches **`completed`** (including rejection→revision→later-approval),
evaluate distillation predicates asynchronously (MUST NOT block the status transition).

MUST NOT: Run distillation on `failed` / cancelled / still-open tasks — there is no accepted
outcome yet; wait until completion (or human Remember §9).

MUST fire when status is `completed` and **any** of:

1. Tool-call count on the execution trajectory ≥ 5 (**known** count)
2. Task experienced at least one review rejection / `executionRound > 1` (feedback exists)
3. ≥ 2 similar tasks completed in a recent window (same project + overlapping title tokens)

MUST NOT fire when none of the above hold (trivial first-pass short tasks).
When tool-call count is unknown/missing, runtime MAY still distill on `completed` (transitional
until telemetry lands) — MUST NOT treat a **known** low count as “unknown”.

Test IDs: `B-hook-skip-trivial`, `B-hook-fire-complex`, `B-hook-skip-failed`.

### §2.2 Execution

MUST: Run with `scenario: distillation` (capability pack `reflex` + distillation allowlist).
MUST NOT: Use `scenario: memory_consolidation` for post-task reflection.

MUST: Inject `## Learning Habits` (§8) into the system prompt for `distillation`
(`B-distill-habits-injected`). Dream MUST omit Habits (`B-dream-no-habits`).

MUST: Tool allowlist = reflex core ∪
`memory_update`, `memory_update_longterm`, `file_write`, `file_edit`,
`package_list`, `package_install`.
MUST NOT: Include `hub_install` / agent|team auto-deploy on the distillation turn
(`B-distill-no-hub-install`). Skill install MUST follow §8.3 impact/HITL
(`B-distill-package-install-allowed`): high/omitted → `request_user_input` then install;
low → may install directly.

MUST NOT: Require a structured JSON outcome enum. The agent follows Learning Habits —
encode with tools when there is a durable lesson; if nothing noteworthy, stop quietly.

Test IDs: `B-distill-uses-distillation-scenario`, `B-distill-habits-injected`,
`B-distill-package-install-allowed`.

---

## §3 Staged skills + approval (optional helper)

Primary agent path is §8.3: create under `builder-artifacts/skills/` then `package_install`
with impact/HITL. This section is an optional staging helper when the agent prefers a draft
before install.

MUST: `.pending/` drafts MUST NOT become live until human approve (or the agent installs via §8.3).

Storage options (either is compliant):

1. `builder-artifacts/skills/.pending/<name>/SKILL.md` (+ skill.json), or
2. Requirement type `skill-distillation` whose body is the SKILL.md content

MUST: On approve → install under `builder-artifacts/skills/<name>/` (or equivalent package path)
and expose via L0 catalog / `discover_tools`.

MUST: On reject → persist reason as negative feedback; SHOULD suppress near-identical re-proposals.

Test IDs: `B-stage-not-live`, `B-approve-install`, `B-reject-feedback`.

MUST NOT: Auto-write team skills from inside `task_execution`.

---

## §4 Skill stats

MUST: Persist per-skill stats (sidecar `stats.json` or `skill.json.stats`):

```json
{
  "usage_count": 0,
  "success_count": 0,
  "last_used": null,
  "avg_token_cost": null,
  "feedback": []
}
```

MUST: `discover_tools` activation of a skill increments `usage_count` and updates `last_used`.
MUST: When a task that activated the skill reaches `completed`, increment `success_count`.
MUST: On task `rejected` (review), append a feedback line if the skill was active.
MUST NOT: Modify trust score based on these stats.

Test IDs: `B-stats-activate`, `B-stats-success`, `B-stats-reject-feedback`.

---

## §5 Dream Librarian

MUST: Dream runs only as `scenario: memory_consolidation` (hygiene). MUST NOT inject Learning Habits.
MUST NOT: Use Dream for post-task trajectory reflection (§2 owns that).

MUST: Periodic dream/consolidation SHOULD also:

1. Suggest archive for skills with `usage_count = 0` and age > 30 days
2. Suggest revise when `success_count / usage_count < 0.5` (usage ≥ 3)
3. Suggest merge when duplicate skill names/tags collide
4. Expire `state.md` entries older than `STATE_TTL_DAYS`
5. Promote recurring observations (3+) into `knowledge.md`
6. When negative feedback ≥ 3 on a skill, open/suggest a revision task
7. When ≥ 3 agents independently record the same insight theme, suggest a team skill

Test IDs: `C-dream-archive-suggest`, `C-dream-state-ttl`, `C-dream-promote-insight`,
`B-dream-no-habits`.

---

## §6 Fanout + metrics API

MUST: On new live skill or major version, enqueue at most **one** skill-update mailbox item per
agent per calendar day (merge multiples). Recipients MUST match skill tags ↔ agent ROLE/skills.

MUST: Evolution metrics API exposes:

- skill reuse rate = tasks that activated ≥1 skill / tasks completed
- first-pass rate = tasks approved without prior rejection / tasks reviewed
- distill rate = tasks that ran post-task distillation / tasks completed

Healthy distill rate band: 10–30% (informational).

Test IDs: `C-fanout-cap`, `C-fanout-tag-match`, `C-metrics-api`.

---

## §7 Heartbeat

MUST NOT: Inject long self-evolution essays into reflex heartbeat prompts.
Distillation (§2), Dream (§5), and Prompt Habits (§8) cover learning; heartbeat MAY at most
`memory_save` a one-line insight.

Test ID: `B-hb-no-evolution-essay`.

---

## §8 Prompt Habits (Look back / Encode where / Skill impact)

MUST: Platform Tier-1 L0 injects a short `## Learning Habits` section into
`ContextEngine.buildSystemPrompt()` for all scenarios **except** `memory_consolidation`
(Dream). MUST include `distillation`, `chat`, `group_chat`, `task_execution`, `review`,
`heartbeat`.

MUST: Section length ≤ **1600 characters**.

MUST NOT: Rely on the retired alwaysOn `self-evolution` skill for this SOP — habits are
platform-native. The `self-evolution` skill package MUST NOT ship in `templates/skills/`.

### §8.1 Look back

SHOULD before non-trivial work:

1. Read injected `## Your Knowledge`
2. `memory_search` and/or `recall_activity` for similar past work
3. If L0 skill catalog matches → `discover_tools` activate before reinventing

MUST NOT require look-back for greetings / one-shot factual lookups / pure acks.

### §8.2 Encode where

After complex, corrected, failed-then-fixed, or reusable work, SHOULD encode using the
**lightest store that changes future behavior**.

**Me vs others (first cut):**

| Audience | Store |
|---|---|
| Only helps *this* agent / *this* user (prefs, one-off lessons, personal workflows) | Memory (`memory_save` / `memory_update` → `knowledge.md`) or ROLE / HEARTBEAT |
| Helps *other agents* as an executable playbook / MCP / shared workflow | Skill under `builder-artifacts/skills/` then §8.3 install |

Skill MUST be steps/tools/boundaries — MUST NOT be a diary dump of transcripts.
Same theme recurring 3+ times AND shareable → SHOULD promote memory → skill.

| Learned what | Where |
|---|---|
| One-off lesson / gotcha | `memory_save` |
| Personal multi-step procedure | `memory_update` / `memory_update_longterm` → `knowledge.md` curated section |
| Always-on behavioral rule (this agent) | append ROLE.md via `file_edit`; identity/scope rewrite → ask human first |
| Recurring patrol check | edit HEARTBEAT.md (keep lean) |
| Team-reusable / MCP / shared workflow | create under `builder-artifacts/skills/` then §8.3 install |

SHOULD prefer concrete `[INSIGHT]` one-liners; SHOULD prune stale `knowledge.md` / HEARTBEAT entries;
MUST NOT dump raw transcripts into memory. Tool results SHOULD report `store: "knowledge.md"`
(legacy `MEMORY.md` is not the write target).

### §8.3 Skill install impact

After creating/updating a skill artifact:

- **Low impact** (narrow tip, no MCP/network/secrets, unlikely to reshape other agents’
  workflows): `package_install({ type: "skill", name, impact: "low" })` — MUST skip HITL.
- **High impact** (broad procedures, MCP/permissions, overlaps existing skills, org process):
  MUST ask via `request_user_input` (or equivalent), then
  `package_install({ type: "skill", name, impact: "high" })` — MUST require HITL.
- If `impact` omitted for `type: "skill"`, MUST treat as **high**.
- `type: "agent" | "team"`: MUST always HITL; MUST NOT auto-hire/deploy without explicit human ask.

Note: §3 `.pending` staging remains a distillation-helper path; **agent-facing instructions
MUST use builder-artifacts + `package_install` impact**, not `.pending` promote UI (not productized).

### §8.4 Soften “No auto-install”

MUST: L0 platform rules distinguish skills (follow §8.3) from agents/teams (hard gate).

Test IDs: `B-prompt-learning-habits-present`, `B-prompt-learning-habits-absent-dream`,
`B-prompt-learning-habits-budget`, `B-skill-install-low-skips-hitl`,
`B-skill-install-high-requires-hitl`, `B-agent-install-always-hitl`,
`B-self-evolution-skill-retired`.

User-initiated Remember UX: §9.

---

## §9 Remember-from-message (user↔agent DM)

### §9.1 UX

MUST: On agent bubbles in **user↔agent personal DM chat only**, offer a **Remember** action.

MUST NOT: Show Remember in Team/group chat or agent↔agent (A2A) threads.

SHOULD: Modal with optional user note (“what to remember”) + Confirm/Cancel.

MUST: On confirm, open a **new personal evolution child session** with that agent — process
visible to the user. MUST NOT inject evolution tool chatter into the parent DM transcript
beyond lineage metadata on the child.

### §9.2 API

MUST: `POST /api/agents/:agentId/evolve-from-message` (same auth as chat).

Body:

| Field | Rule |
|---|---|
| `parentSessionId` | Required; MUST be a personal DM `chat_sessions` row for this user↔agent |
| `sourceMessageId` | Optional focus bubble id |
| `sourceText` | Optional client excerpt fallback |
| `userNote` | Optional highest-priority intent |

MUST reject non-DM / foreign parents (`B-evolve-api-rejects-non-dm-parent`).

MUST: Create child session; set `chat_sessions.metadata`:

```json
{
  "kind": "evolution",
  "parentSessionId": "...",
  "sourceMessageId": "...",
  "sourceAgentId": "...",
  "sourceExcerpt": "...",
  "createdFrom": "remember_button"
}
```

MUST: Seed a user message that includes:

1. Capped parent transcript (last **40** messages or **~24k chars**; mark truncation)
2. Tool summaries on assistant turns when present
3. Focus message marker when available
4. Explicit `parentSessionId`, `evolutionSessionId`, optional `sourceMessageId`
5. Instruction to follow Learning Habits (§8) and, if truncated, fetch more via
   `recall_context({ scope: "chat_session", session_id: parentSessionId, before, limit })`
6. Prefer lessons from user corrections/outcomes; summarize encodings at end

MUST: Start the agent turn on the **child** session only (`scenario: chat`, tools on —
MUST NOT use dream `memory_consolidation`).

Test IDs: `B-evolve-api-creates-child-session`, `B-evolve-api-metadata-lineage`,
`B-evolve-seed-includes-parent-session-id`, `B-evolve-seed-includes-parent-transcript`,
`B-evolve-seed-includes-tool-summaries-when-present`, `B-evolve-seed-marks-focus-message`,
`B-evolve-api-seed-contains-habits-instructions`, `B-evolve-only-writes-child-session`,
`B-ui-remember-action-on-dm-agent-bubble`, `B-ui-remember-hidden-in-group-and-a2a`.

### §9.3 `recall_context` scope `chat_session`

MUST: Extend `recall_context` with `scope: "chat_session"` + required `session_id`,
`limit` (default 40, max 100), `before` (ISO pagination).

MUST: Only allow sessions owned by the calling agent; reject foreign sessions.

Test IDs: `B-recall-chat-session-paginates`, `B-recall-chat-session-rejects-foreign`.

### §9.4 Non-goals

MUST NOT: Session tree/forest explorer; auto-fork every assistant message; silent background
evolution without user confirm; Remember on group/A2A.
