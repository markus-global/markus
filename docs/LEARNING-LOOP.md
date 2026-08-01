# Learning Loop

> Normative Spec for Markus self-evolution. SSOT overview: [AGENT-RUNTIME.md](./AGENT-RUNTIME.md) §1.3–§1.4 / §7.
> Inspired by Hermes: execute ≠ learn; write-approval gate; progressive disclosure prerequisite.

---

## §1 Goals

Turn successful/failed task trajectories into durable assets (insights → knowledge → staged skills)
without bloating the Context Surface. Skill library growth MUST only increase L0 catalog size.

---

## §2 Distillation Hook

### §2.1 Trigger

MUST: After a task reaches `completed` or `failed`, or after a rejection→revision→later-approval
path that recorded a rejection, evaluate distillation predicates asynchronously (MUST NOT block
the task status transition).

MUST fire when **any** of:

1. Tool-call count on the execution trajectory ≥ 5
2. Task experienced at least one review rejection in its life
3. ≥ 2 similar tasks completed in a recent window (same project + overlapping title tokens)
4. Terminal status is `failed`

MUST NOT fire when none of the above hold (trivial tasks).

Test IDs: `B-hook-skip-trivial`, `B-hook-fire-complex`, `B-hook-fire-failed`.

### §2.2 Execution

MUST: Run in a lightweight session (`scenario: memory_consolidation` or `distillation`) with
`reflex` or slim `govern` tools — MUST NOT use full `execute` pack.

MUST: Output one of: `none` | `insight` | `staged_skill`.

- `insight` → `memory_save` (observations) and/or knowledge patch
- `staged_skill` → staging path (§3)
- `none` → record “distilled” marker; stop

---

## §3 Staged skills + approval

MUST: Drafts MUST NOT become live installed skills until human approve.

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

MUST: Periodic dream/consolidation SHOULD also:

1. Suggest archive for skills with `usage_count = 0` and age > 30 days
2. Suggest revise when `success_count / usage_count < 0.5` (usage ≥ 3)
3. Suggest merge when duplicate skill names/tags collide
4. Expire `state.md` entries older than `STATE_TTL_DAYS`
5. Promote recurring observations (3+) into `knowledge.md`
6. When negative feedback ≥ 3 on a skill, open/suggest a revision task
7. When ≥ 3 agents independently record the same insight theme, suggest a team skill

Test IDs: `C-dream-archive-suggest`, `C-dream-state-ttl`, `C-dream-promote-insight`.

---

## §6 Fanout + metrics API

MUST: On new live skill or major version, enqueue at most **one** skill-update mailbox item per
agent per calendar day (merge multiples). Recipients MUST match skill tags ↔ agent ROLE/skills.

MUST: Evolution metrics API exposes:

- skill reuse rate = tasks that activated ≥1 skill / tasks completed
- first-pass rate = tasks approved without prior rejection / tasks reviewed
- distill rate = tasks that produced insight or staged_skill / tasks completed

Healthy distill rate band: 10–30% (informational).

Test IDs: `C-fanout-cap`, `C-fanout-tag-match`, `C-metrics-api`.

---

## §7 Heartbeat

MUST NOT: Inject long self-evolution essays into reflex heartbeat prompts.
System distillation (§2–§5) and Prompt Habits (§8) cover learning; heartbeat MAY at most
`memory_save` a one-line insight.

Test ID: `B-hb-no-evolution-essay`.

---

## §8 Prompt Habits (Look back / Encode where / Skill impact)

MUST: Platform Tier-1 L0 injects a short `## Learning Habits` section into
`ContextEngine.buildSystemPrompt()` for all non-`memory_consolidation` scenarios
(including `chat`, `group_chat`, `task_execution`, `review`, `heartbeat`).

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
**lightest store that changes future behavior**:

| Learned what | Where |
|---|---|
| One-off lesson / gotcha | `memory_save` |
| Personal multi-step procedure | `memory_update_longterm` → MEMORY.md |
| Always-on behavioral rule (this agent) | append ROLE.md via `file_edit`; identity/scope rewrite → ask human first |
| Recurring patrol check | edit HEARTBEAT.md (keep lean) |
| Team-reusable / MCP / shared workflow | create under `builder-artifacts/skills/` then §8.3 install |

SHOULD prefer concrete `[INSIGHT]` one-liners; SHOULD prune stale MEMORY/HEARTBEAT entries;
MUST NOT dump raw transcripts into memory.

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
