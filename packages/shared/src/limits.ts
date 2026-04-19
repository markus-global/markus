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

/** Max characters for the unified "## Your Knowledge" section from MEMORY.md.
 *  MEMORY.md is loaded as a single section — no separate SOPs/lessons/etc.
 *  8000 chars ≈ ~2000 tokens — fits ~5 sections of agent-organized knowledge. */
export const SYSTEM_KNOWLEDGE_CHARS = 8000;

/** @deprecated Use SYSTEM_KNOWLEDGE_CHARS. Kept for backward compat. */
export const SYSTEM_SOPS_CHARS = 3000;
/** @deprecated Use SYSTEM_KNOWLEDGE_CHARS. Kept for backward compat. */
export const SYSTEM_LONGTERM_MEMORY_CHARS = 5000;

/** Hard cap on individual MEMORY.md section content (chars).
 *  Prevents any single section from growing unbounded. */
export const MEMORY_MD_SECTION_MAX_CHARS = 3000;

/** Hard cap on total MEMORY.md file size (chars).
 *  Prevents the file from growing without bound even if the agent
 *  keeps creating new sections.  15 000 chars ≈ 5 sections × 3 000. */
export const MEMORY_MD_TOTAL_MAX_CHARS = 15_000;

/** @deprecated Lesson/best-practice taxonomy removed. Use unified knowledge. */
export const SYSTEM_LESSON_ENTRIES_MAX = 10;
/** @deprecated Lesson/best-practice taxonomy removed. Use unified knowledge. */
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
 *  JSON payload.  8192 tokens covers verbose chain-of-thought plus
 *  tool-call reasoning when triage tools are enabled. */
export const TRIAGE_MAX_TOKENS = 8192;

/** Temperature for the triage LLM call.
 *  Low temperature produces deterministic, focused decisions. */
export const TRIAGE_TEMPERATURE = 0.1;

/** Max recent messages from the agent's main session included in triage context.
 *  More messages give the triage LLM better situational awareness.
 *  20 messages × ~2000 chars ≈ ~40K chars — generous but justified since
 *  good triage decisions save far more downstream cost. */
export const TRIAGE_CONTEXT_MESSAGES_MAX = 20;

/** Max characters per message in the triage context.
 *  2000 chars lets the LLM see real content instead of useless fragments. */
export const TRIAGE_CONTEXT_MSG_CHARS = 2000;

/** Max characters for payload.content per candidate item in the triage prompt.
 *  The summary alone is often insufficient; the full content provides
 *  actionable detail for prioritization decisions. */
export const TRIAGE_ITEM_CONTENT_CHARS = 3000;

/** Age threshold (ms) for auto-dropping informational items before triage.
 *  Informational items (task_status_update, heartbeat, memory_consolidation,
 *  daily_report) older than this are stale — the information they carried is
 *  outdated and processing them would waste attention.
 *  4 hours is generous enough for agents that were paused but short enough
 *  to prevent unbounded queue growth. */
export const TRIAGE_STALE_INFO_TTL_MS = 4 * 60 * 60 * 1000;

/** Informational mailbox types eligible for age-based auto-drop before triage.
 *  These types carry context that decays rapidly and do not require LLM processing. */
export const TRIAGE_STALE_DROP_TYPES: readonly string[] = [
  'task_status_update', 'heartbeat', 'memory_consolidation', 'daily_report',
];

/** Max tool-use iterations allowed during triage deliberation.
 *  Enough to gather context (task_list, task_get, etc.) but not enough
 *  to do real work. */
export const TRIAGE_MAX_TOOL_ITERATIONS = 3;

/** Read-only tools allowed during triage deliberation.
 *  These let the triage LLM understand current workload, task dependencies,
 *  and team state before deciding priority. */
export const TRIAGE_ALLOWED_TOOLS: readonly string[] = [
  'task_list', 'task_get', 'requirement_list', 'requirement_get',
  'list_projects', 'team_list',
];

// ─── Subagent Limits ────────────────────────────────────────────────────────
// These control subagent execution behavior and progress preview truncation.

/** Max characters for the task preview in subagent progress events.
 *  Shown in the frontend execution log as context. */
export const SUBAGENT_TASK_PREVIEW_CHARS = 500;

/** Max characters for the thinking preview in subagent progress events.
 *  Shown while the subagent is processing (streaming teaser). */
export const SUBAGENT_THINKING_PREVIEW_CHARS = 1000;

/** Max characters for the result preview in subagent progress events.
 *  Shown in tool_end events and completion metadata. */
export const SUBAGENT_RESULT_PREVIEW_CHARS = 500;

/** Max characters for tool result content in persisted subagent log entries.
 *  Full results are kept in messages for context; this caps the log file copy. */
export const SUBAGENT_LOG_ENTRY_CHARS = 10_000;

/** Max characters for error message previews in retry logs. */
export const SUBAGENT_ERROR_PREVIEW_CHARS = 500;

/** Max parallel subagents in a single spawn_subagents call. */
export const SUBAGENT_MAX_PARALLEL = 10;

/** Max LLM call retries for transient errors within a subagent. */
export const SUBAGENT_MAX_LLM_RETRIES = 2;

/** Base delay (ms) for exponential backoff on retryable LLM errors. */
export const SUBAGENT_RETRY_BASE_MS = 2000;

// ─── Shell Execution Limits ─────────────────────────────────────────────────

/** Default timeout for shell commands (ms).
 *  60s covers typical builds, tests, git operations. */
export const SHELL_TIMEOUT_DEFAULT_MS = 60_000;

/** Maximum allowed timeout for shell commands (ms).
 *  5 minutes caps even explicitly requested long-running operations.
 *  Prevents commands from hanging indefinitely (e.g. interactive git rebase). */
export const SHELL_TIMEOUT_MAX_MS = 300_000;

// ─── Human-Approval Wait ─────────────────────────────────────────────────────

/** Backstop timeout (ms) for mailbox items that are blocking on human approval.
 *  Normal processing uses MAILBOX_PROCESSING_TIMEOUT_MS (10 min), but
 *  request_user_approval can wait indefinitely for the user. 24 hours is a
 *  generous safety net while allowing realistic human response times. */
export const APPROVAL_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// ─── Heartbeat Startup ──────────────────────────────────────────────────────

/** Minimum initial delay (ms) before an agent's first heartbeat fires.
 *  Prevents the first agent from firing immediately at startup, giving the
 *  system time to settle and avoiding a burst of LLM requests at boot. */
export const HEARTBEAT_MIN_INITIAL_DELAY_MS = 5_000;

/** Random jitter (ms) added to deterministic heartbeat stagger on startup.
 *  When multiple agents start together, each gets a stagger offset plus
 *  this random jitter to avoid deterministic collisions across restarts. */
export const HEARTBEAT_STARTUP_JITTER_MS = 10_000;

// ─── LLM Router Circuit Breaker ─────────────────────────────────────────────

/** Circuit-breaker cooldown (ms) specifically for rate-limit (HTTP 429) errors.
 *  Much shorter than the generic 5-minute cooldown because rate limits
 *  typically clear within seconds. */
export const LLM_CIRCUIT_RESET_RATE_LIMIT_MS = 30 * 1000;

/** Max concurrent in-flight LLM requests per provider before jitter kicks in.
 *  When exceeded, additional requests add a random delay to spread the load
 *  and avoid thundering-herd 429 cascades. */
export const LLM_MAX_CONCURRENT_PER_PROVIDER = 5;

/** Base delay (ms) for the random jitter applied when per-provider concurrency
 *  exceeds LLM_MAX_CONCURRENT_PER_PROVIDER.  Actual delay is in the range
 *  [JITTER_BASE, JITTER_BASE * 3]. */
export const LLM_CONCURRENCY_JITTER_BASE_MS = 500;
