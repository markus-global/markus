/**
 * Centralized limits for agent-facing context and tool responses.
 *
 * Every numeric limit that controls what agents see — in tool responses,
 * execution prompts, reviewer notifications, or system prompts — is
 * defined here with a documented rationale.  Call sites import from this
 * module instead of using inline magic numbers.
 *
 * Guidelines for changing these values:
 *   • Increasing a limit gives agents more context but costs more tokens.
 *   • Decreasing a limit saves tokens but may cause agents to miss critical
 *     information (especially notes used for human↔agent communication).
 *   • After changing, grep for the constant name to find all affected paths.
 */

// ─── Tool Response Limits ────────────────────────────────────────────────────
// These control what `task_get` / `task_list` return to the calling agent.

/** Max notes returned by `task_get` in default (non-full) mode.
 *  Notes are the primary human↔agent communication channel — must be
 *  generous enough to cover an ongoing conversation without requiring
 *  `full=true` every time. */
export const TASK_GET_NOTES_DEFAULT = 50;

/** Max deliverables returned by `task_get` in default (non-full) mode.
 *  Deliverables are rarely >10; cap prevents accidental token explosion
 *  for long-running scheduled tasks that accumulate deliverables. */
export const TASK_GET_DELIVERABLES_DEFAULT = 20;

// ─── Execution Prompt Limits ─────────────────────────────────────────────────
// These control how much context the agent receives when resuming a task
// (previous execution logs, notes, dependency context, comments).

/** Max notes included in the task execution prompt.
 *  These appear in "Task Notes (accumulated knowledge)" and in the
 *  no-prior-context notes section.  Covers the recent conversation
 *  history; older notes are summarized by the "N of M" hint. */
export const PROMPT_TASK_NOTES_MAX = 30;

/** Max characters per note in the execution prompt.
 *  Long notes (e.g. pasted logs) are truncated to keep the overall
 *  prompt within token budget. */
export const PROMPT_TASK_NOTE_CHARS = 1200;

/** Max notes per dependency task shown in the execution prompt.
 *  Dependencies are secondary context — show enough for continuity. */
export const PROMPT_DEP_NOTES_MAX = 5;

/** Max characters per dependency note. */
export const PROMPT_DEP_NOTE_CHARS = 500;

/** Max characters for a dependency task's description. */
export const PROMPT_DEP_DESC_CHARS = 300;

/** Max execution rounds shown in the "Execution timeline" prompt section.
 *  More rounds → more context for retries; 3 is usually sufficient. */
export const PROMPT_EXECUTION_ROUNDS_MAX = 3;

/** Max characters per execution log entry in the prompt. */
export const PROMPT_LOG_ENTRY_CHARS = 800;

/** Max recent error entries shown in the execution prompt. */
export const PROMPT_RECENT_ERRORS_MAX = 10;

/** Max human/external comments included in the execution prompt.
 *  These are high-signal; 5 recent items cover most feedback threads. */
export const PROMPT_HUMAN_COMMENTS_MAX = 5;

// ─── Reviewer Notification Limits ────────────────────────────────────────────

/** Max notes included in the reviewer notification message.
 *  Reviewer gets a compact summary; they can `task_get` for full detail. */
export const REVIEWER_NOTES_MAX = 5;

// ─── System Prompt (Task Board) Limits ───────────────────────────────────────
// These appear in the agent's system prompt to provide situational awareness.

/** Max of the agent's own active tasks shown in the system prompt. */
export const SYSTEM_MY_TASKS_MAX = 15;

/** Max team tasks (assigned to others) shown in the system prompt. */
export const SYSTEM_TEAM_TASKS_MAX = 10;

/** Max characters of task description in the system prompt task board.
 *  Just enough to identify the task; full description comes from
 *  execution context or `task_get`. */
export const SYSTEM_TASK_DESC_CHARS = 150;

// ─── Project / Requirement Context ───────────────────────────────────────────

/** Max characters for project description in execution prompt. */
export const PROMPT_PROJECT_DESC_CHARS = 300;

/** Max characters for requirement description in execution prompt. */
export const PROMPT_REQUIREMENT_DESC_CHARS = 500;

/** Max files listed in reviewer notification before "N more" hint. */
export const REVIEWER_FILE_LIST_MAX = 10;

/** Max characters for deliverable title/summary. */
export const DELIVERABLE_TITLE_CHARS = 200;

/** Max characters for revision reason in notification. */
export const REVISION_REASON_CHARS = 200;

// ─── Task Execution Retry Policy ─────────────────────────────────────────────

/** Max retries after transient errors (network, rate-limit). */
export const TASK_MAX_RETRIES = 3;

/** Max retries for mailbox items whose reply lacks the completion marker.
 *  Keeps retry budget low because repeated failures with the same model
 *  are unlikely to self-correct. */
export const MAILBOX_ITEM_MAX_RETRIES = 2;

/** Sentinel token the agent must emit at the end of every mailbox-item reply
 *  to signal successful processing.  Absence triggers automatic retry.
 *  Chosen to be unique enough to never collide with natural language. */
export const COMPLETION_MARKER = '<<HANDLE_COMPLETE>>';

/** Instruction appended to the user message for LLM-invoking mailbox items. */
export const COMPLETION_MARKER_INSTRUCTION =
  `\n\n[IMPORTANT: When you have finished processing this request, you MUST end your final response with the exact token: ${COMPLETION_MARKER}]`;

/** Max auto-retries when execution finishes without task_submit_review. */
export const TASK_MAX_NO_SUBMIT_RETRIES = 8;

/** Progressive retry delays in milliseconds (base values before jitter). */
export const TASK_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000, 60_000, 120_000, 300_000];

/** Apply ±20% random jitter to a delay to avoid thundering-herd retries. */
export function withJitter(baseMs: number, factor = 0.2): number {
  const jitter = baseMs * factor * (2 * Math.random() - 1);
  return Math.max(0, Math.round(baseMs + jitter));
}

/** Delay (ms) before re-queuing a preempted task, giving the higher-priority
 *  item time to enter processing first. */
export const PREEMPT_REQUEUE_DELAY_MS = 3_000;

// ─── System Prompt: Memory & Knowledge Injection ─────────────────────────────
// These control how much memory context is injected into the system prompt.
// All agents see this on every LLM call — tuning affects quality vs. token cost.

/** Max characters for the SOPs section extracted from MEMORY.md.
 *  SOPs are high-value procedural memory — agents must see them fully.
 *  A typical SOP is ~200-300 chars; 3000 chars fits ~10 SOPs comfortably.
 *  Loaded independently from the general MEMORY.md cap. */
export const SYSTEM_SOPS_CHARS = 3000;

/** Max characters for the full MEMORY.md (Long-term Knowledge).
 *  Contains lessons-learned, tool-preferences, role-evolution-log, etc.
 *  Note: SOPs are loaded separately above, so this budget is for everything else.
 *  5000 chars ≈ ~1200 tokens — moderate cost, good coverage. */
export const SYSTEM_LONGTERM_MEMORY_CHARS = 5000;

/** Max recent lesson entries (tagged "lesson") injected into system prompt.
 *  These are individual memory_save entries from self-evolution.
 *  10 entries × ~150 chars = ~1500 chars ≈ ~375 tokens. */
export const SYSTEM_LESSON_ENTRIES_MAX = 10;

/** Max recent best-practice entries (tagged "best-practice") injected.
 *  These come from heartbeat task reviews; same budget as lessons.
 *  10 entries × ~200 chars = ~2000 chars ≈ ~500 tokens. */
export const SYSTEM_BEST_PRACTICE_ENTRIES_MAX = 10;

/** Max characters for shared deliverables context in system prompt.
 *  Deliverables are team-wide knowledge; 3000 chars provides useful context
 *  without overwhelming the prompt. */
export const SYSTEM_DELIVERABLES_CHARS = 3000;

/** Max characters for the daily activity log summary in system prompt.
 *  Provides recent context; 1500 chars covers key events from the day. */
export const SYSTEM_DAILY_LOG_CHARS = 1500;

/** Number of recent days of daily logs to include. */
export const SYSTEM_DAILY_LOG_DAYS = 1;

/** Max characters for the shared user profile (USER.md) in system prompt.
 *  Owner preferences and communication style; kept compact. */
export const SYSTEM_USER_PROFILE_CHARS = 1500;

/** Max chat sessions shown in system prompt for continuity. */
export const SYSTEM_CHAT_SESSIONS_MAX = 5;

/** Max characters for the manager daily report activity log in heartbeat. */
export const HEARTBEAT_DAILY_LOG_CHARS = 3000;

/** Max characters for project description in system prompt. */
export const SYSTEM_PROJECT_DESC_CHARS = 200;

/** Max characters for project deliverable content preview. */
export const SYSTEM_DELIVERABLE_PREVIEW_CHARS = 200;

/** Max characters for mailbox merged context shown in system prompt. */
export const SYSTEM_MAILBOX_MERGED_CHARS = 500;

/** Max characters for mailbox item summary/reasoning preview. */
export const SYSTEM_MAILBOX_ITEM_PREVIEW_CHARS = 120;

// ─── Pagination Defaults ─────────────────────────────────────────────────────

/** Default page size for task_list tool. */
export const TASK_LIST_PAGE_SIZE = 20;

/** Max page size for task queries (prevents accidental full-table scans). */
export const TASK_LIST_PAGE_MAX = 100;

// ─── Auto-Archive Policy ─────────────────────────────────────────────────────

/** Days after which completed tasks are auto-archived.
 *  30 days gives reviewers/users plenty of time to revisit results
 *  before the task moves to the archive filter. */
export const ARCHIVE_COMPLETED_AFTER_DAYS = 30;

/** Days after which failed/rejected/cancelled tasks are auto-archived.
 *  Terminal-but-unsuccessful tasks are less likely to be revisited;
 *  7 days keeps the board clean without losing traceability. */
export const ARCHIVE_TERMINAL_AFTER_DAYS = 7;

/** Days after which completed/failed/rejected/cancelled requirements are auto-archived.
 *  Aligned with task archival for consistency. */
export const ARCHIVE_REQUIREMENT_AFTER_DAYS = 30;

/** Interval between automatic archive scans (ms).
 *  6 hours balances responsiveness with minimal overhead. */
export const ARCHIVE_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ─── Mailbox Item TTL ────────────────────────────────────────────────────────

/** Maximum age (ms) for queued mailbox items before they are dropped on restart.
 *  Items older than 3 days are stale — the context they carried is no longer
 *  timely, and processing them would confuse agents with outdated information. */
export const MAILBOX_QUEUED_TTL_MS = 3 * 24 * 60 * 60 * 1000;

// ─── Mailbox Processing ─────────────────────────────────────────────────────

/** Maximum time (ms) allowed for processing a single mailbox item.
 *  If processing exceeds this duration — typically caused by system sleep,
 *  network hang, or an unresponsive LLM provider — the item is requeued
 *  for retry and the attention loop continues.
 *  10 minutes covers even long tool-chain executions while catching genuine hangs. */
export const MAILBOX_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;

/** Watchdog interval (ms) for detecting system sleep/wake cycles.
 *  A timer fires every WATCHDOG_INTERVAL_MS; if the actual elapsed time
 *  between fires exceeds WATCHDOG_DRIFT_THRESHOLD_MS, the system likely slept.
 *  On detection, any in-flight processing is aborted and requeued. */
export const WATCHDOG_INTERVAL_MS = 30_000;

/** Drift threshold (ms) that signals a sleep/wake event.
 *  If a 30s timer fires 60+ seconds late, the system was asleep. */
export const WATCHDOG_DRIFT_THRESHOLD_MS = 60_000;

// ─── Mailbox Triage ─────────────────────────────────────────────────────────
// These control the LLM-driven triage phase in the attention controller.
// Triage runs when multiple queued items compete for attention and priority
// alone cannot decide the order.

/** Max candidate items included in the triage LLM prompt.
 *  Items beyond this count are omitted from the prompt (but still in the
 *  queue).  50 items × ~5 lines each ≈ 250 lines — substantial context
 *  without overwhelming the model's attention. */
export const TRIAGE_PROMPT_MAX_ITEMS = 50;

/** Max tokens for the triage LLM response.
 *  Must be generous enough for models that emit <think> blocks before the
 *  JSON payload.  4096 tokens covers even verbose chain-of-thought. */
export const TRIAGE_MAX_TOKENS = 4096;

/** Temperature for the triage LLM call.
 *  Low temperature produces deterministic, focused decisions. */
export const TRIAGE_TEMPERATURE = 0.1;

// ─── Shell Execution Limits ─────────────────────────────────────────────────

/** Default timeout for shell commands (ms).
 *  60s covers typical builds, tests, git operations. */
export const SHELL_TIMEOUT_DEFAULT_MS = 60_000;

/** Maximum allowed timeout for shell commands (ms).
 *  5 minutes caps even explicitly requested long-running operations.
 *  Prevents commands from hanging indefinitely (e.g. interactive git rebase). */
export const SHELL_TIMEOUT_MAX_MS = 300_000;
