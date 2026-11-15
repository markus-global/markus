/**
 * Agent Memory Types
 *
 * Organized by Tulving's cognitive classification:
 * - Semantic: observations + curated knowledge (knowledge.md SSOT; MEMORY.md legacy)
 * - Episodic: conversation sessions (sessions/*.json)
 * - Procedural: identity & skills (managed by RoleLoader, not here)
 */
import type { LLMMessage } from '@markus/shared';

export interface MemoryEntry {
  id: string;
  timestamp: string;
  type: 'conversation' | 'fact' | 'task_result' | 'note' | 'insight' | 'conversation_fragment';
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Memory budget health — reported per MEASURED OBJECT, never per convenient constant.
 *
 * THREE numbers, three different questions (DR5):
 *
 *   1. **Injected payload** — `injectedChars / injectionCapChars`
 *      (`injectionUsedPercent`). This is what one turn actually puts into
 *      `## Your Knowledge`, measured by the injector itself
 *      (`prepareKnowledgeForPrompt().inlinedChars`) and written back through
 *      `IMemoryStore.recordInjectedKnowledge`. **This is the number the in-prompt
 *      banner and the `memory_stats` hint report.**
 *   2. **Curated region on disk** — `curatedChars / curatedCap` (`curatedPercent`,
 *      cap = `MEMORY_MD_CURATED_MAX_CHARS`). Region SIZE, report-only: it says how
 *      much knowledge has accumulated, not how much a turn carries. Before DR5 this
 *      was the banner's number, which is how a 16 673-char region got announced as
 *      "111% injected" while the turn injected 6 691 chars.
 *   3. **Observation buffer** — `observationChars / observationCap`
 *      (`observationPercent`). NOT injected at all (searched on demand); it has its
 *      own budget (`MEMORY_OBSERVATIONS_MAX_CHARS`) and its own signal.
 *
 * An earlier version collapsed all of knowledge.md into one `totalChars`/`cap` pair
 * measured over the WHOLE FILE, so a large (and perfectly healthy) observation buffer
 * made `percent` read >100% while the injected footprint was tiny — a permanent false
 * alarm that trained agents to ignore the banner.
 */
/**
 * DR3 — ONE dream run, TYPED: *which* run (`at`) and *which window* it covered
 * (`windowKey`).
 *
 * Why two fields instead of the old bare `lastConsolidatedAt`: two different events
 * (the dream cycle and a manual `memory_organize`) wrote the same untyped instant, and
 * the dream guard then read it as the boolean "did the dream run today". A manual
 * organize at 09:00 therefore cancelled the day's dream. The typed record can only be
 * written by the dream.
 *
 * `windowKey` is the string the WRITER computed (`dreamWindowKey`), stored as a fact.
 * It is never re-derived from `at` at read time: re-deriving would need `entryCount` at
 * READ time, which is a second source for one window (and it is how the bloated-buffer
 * key and the calendar-day key could disagree).
 */
export interface DreamRecord {
  /** When the dream finished successfully (ISO). */
  at: string;
  /** The window this run covered — the exact string the writer computed (`2026-11-15`, `2026-11-15_58`). */
  windowKey: string;
}

/**
 * DR3 — ONE manual `memory_organize` run. Deliberately carries NO `windowKey`: a manual
 * organize must never satisfy the dream's window guard (see `shouldRunDreamCycle`).
 */
export interface OrganizedRecord {
  at: string;
}

export interface MemoryHealth {
  // ── 1. The injected payload (the measured object; see DR5) ──────────────
  /** Characters of knowledge bodies the injector actually placed in the prompt this turn. */
  injectedChars: number;
  /** The injection ceiling ITSELF (min(SYSTEM_KNOWLEDGE_CHARS, knowledgeTokCap × 4)), not 15 000. */
  injectionCapChars: number;
  /** `injectedChars / injectionCapChars` as a percent — THE memory-health number. */
  injectionUsedPercent: number;
  /** Sections that did not fit in the payload and were named in the index line instead. */
  omittedSectionCount: number;
  /**
   * true = a real turn packing recorded the numbers above.
   * false = no turn has packed knowledge yet, so they are a PROJECTION of the same
   * quantity at `DEFAULT_KNOWLEDGE_INJECTION_CAP_CHARS` (worst case: region ≥ cap).
   * The projection never mixes in the region-only cap.
   */
  injectionMeasured: boolean;
  /** Alias of `injectionUsedPercent`, kept for existing call sites. Read the explicit name in new code. */
  percent: number;

  // ── 2. The curated region on disk (report-only; NOT the injection budget) ──
  /** Curated region size in chars — everything BEFORE `## _observations`. */
  curatedChars: number;
  /** Region soft budget (`MEMORY_MD_CURATED_MAX_CHARS`) — a disk-size reference, not an injection cap. */
  curatedCap: number;
  /** `curatedChars / curatedCap` — region size pressure, report-only. */
  curatedPercent: number;

  // ── 3. The observation buffer (not injected) ────────────────────────────
  /** `## _observations` buffer size in chars (NOT injected). */
  observationChars: number;
  observationCap: number;
  observationPercent: number;
  observations: number;
  curatedSections: number;
  archiveChars: number;
  /**
   * DR3 — REPORT-ONLY freshness instant = `max(dream.at, organized.at)`.
   *
   * "When did someone last tidy memory" and "did the dream already run in this window"
   * are two questions; this field answers the first (staleness banner, status API) and is
   * never a dedup input. The dedup input is `getDreamRecord().windowKey`.
   */
  lastConsolidatedAt: string | null;
}

export interface ConversationSession {
  id: string;
  agentId: string;
  title?: string;
  messages: LLMMessage[];
  startedAt: string;
  lastActivityAt: string;
  /** ContextOS: agent-pinned slot anchors (fixed段 C), never compacted. */
  slots?: Record<string, string>;
  /** ContextOS: durable compaction summary anchor — injected into the [SYSTEM]
   *  fixed segment ([CONTEXT SUMMARY]) every turn, so the agent always knows how
   *  much history was paged out. Stored OUT of messages: it is NOT a fake
   *  `role:'user'` turn, is never re-compacted, and never pollutes turn
   *  attribution. Populated by compactSession; cleared on unpin/all-purge. */
  summary?: string;
  /** Count of messages represented by `summary` (informational). */
  summaryPagedOut?: number;
  /**
   * Last provider-reported prompt measurement for this session.
   *
   * It lives on the session record itself — the same JSON this store already
   * owns and already persists — because that is the only thing the number
   * describes. A separate store for it would be a second place for one fact,
   * free to drift from the history it measures.
   */
  lastReportedInput?: { tokens: number; messageCount: number };
}

/**
 * Result of a session compaction.
 *
 * `found` distinguishes a *genuine failure* (no such session in memory nor on
 * disk) from a *valid no-op* (session already within `keep_last`) — the caller
 * must be able to tell them apart, otherwise a silent no-op masquerades as
 * success. This was the root of the 2026-09-30 刘利 P0 report ("compaction API
 * reports ok but does nothing").
 */
export interface CompactResult {
  summary: string;
  /** Number of messages paged out into the anchor summary / fragment archive. */
  flushedCount: number;
  /** Messages retained in the session after compaction (<= keep_last). */
  remaining: number;
  /** false when the session does not exist (in memory or on disk). */
  found: boolean;
}

/**
 * Unified memory interface for Agent and ContextEngine.
 * MemoryStore is the primary implementation.
 */
export interface IMemoryStore {
  // -- Semantic Memory: observation buffer (## _observations in knowledge.md) --
  /**
   * Append one observation. §24 — returns a VERDICT instead of silently dropping data:
   * `{ ok:false, reason }` means the log is at its hard ceiling and the caller must tell the
   * agent to make room. The platform never evicts/archives on the agent's behalf.
   */
  addEntry(entry: MemoryEntry): { ok: boolean; reason?: string };
  getEntries(type?: MemoryEntry['type'], limit?: number): MemoryEntry[];
  getEntriesByTag(tag: string, limit?: number): MemoryEntry[];
  search(query: string): MemoryEntry[];
  removeEntries(ids: string[]): number;
  replaceEntries(removedIds: string[], newEntry: MemoryEntry): void;
  removeEntriesByTag(tag: string): number;
  getObservations(): MemoryEntry[];

  // -- Semantic Memory: curated knowledge (knowledge.md SSOT) --
  /** Basename of the on-disk semantic store (normally "knowledge.md"). */
  getStoreFileName(): string;
  /** Memory budget health (audit P-12) — powers the in-prompt health signal.
   *  Reports the injected payload, the curated region and the observation buffer
   *  as three separate objects; see `MemoryHealth`. */
  getMemoryHealth(): MemoryHealth;
  /**
   * DR5 — the injector reports what it ACTUALLY put into the prompt this turn, so
   * `getMemoryHealth()` measures an injection payload instead of the on-disk region.
   * Called by `ContextEngine.buildSystemPrompt` right before it reads the health.
   * Optional so mocks stay simple.
   */
  recordInjectedKnowledge?(inlinedChars: number, omittedSectionCount: number, capChars?: number): void;
  /**
   * DR3 — the last DREAM, typed (`dream` half of `memory-meta.json`). `null` = never.
   * This is the ONLY thing the dream window guard may consult.
   */
  getDreamRecord?(): DreamRecord | null;
  /**
   * DR3 — the last manual `memory_organize`, typed (`organized` half). Reported for
   * freshness/staleness only; it never satisfies the dream's window guard.
   */
  getOrganizedRecord?(): OrganizedRecord | null;
  /**
   * DR3 — record ONE dream run, with the window key the CALLER computed.
   * Returns `false` when the record could not be persisted durably: the caller must then
   * report `ran:false` (a dream that "ran but was not remembered" is the restart-duplicate
   * bug from 2026-10-15 coming back silently).
   */
  recordDream?(windowKey: string, at?: Date): boolean;
  /** DR3 — record ONE manual organize run. Returns `false` when it could not be persisted. */
  recordOrganize?(at?: Date): boolean;
  /**
   * 审计 P-11：上次整理时间（dream 或 memory_organize 中较晚的那次）—— 供 memory_stats /
   * 状态 API / 「上次整理 N 天前」横幅取数。DR3 起它是对外**报告**字段，不再参与任何判定：
   * 判定读 `getDreamRecord()`。
   */
  getLastConsolidatedAt?(): string | null;
  addLongTermMemory(key: string, content: string): { ok: boolean; reason?: string };
  getLongTermMemory(): string;
  getLongTermMemoryExcluding(sections: string[]): string;
  getLongTermSection(sectionName: string): string;
  /**
   * Remove a curated section outright — the "forget" primitive.
   * A write-only (or overwrite-only) store inflates until it hits its cap and stays there.
   */
  removeLongTermSection(sectionName: string): { ok: boolean; reason?: string; removedChars: number };
  /**
   * §27 — the curated region's PREAMBLE: text before the first `## ` heading. Legacy files carry
   * one, and the section-based tools could not touch it — a write-only region with no removal path
   * accumulates stale content in the one place injected into EVERY prompt. Optional so mocks stay simple.
   */
  getLongTermPreamble?(): string;
  setLongTermPreamble?(text: string): { ok: boolean; reason?: string };
  removeLongTermPreamble?(): { ok: boolean; removedChars: number };
  /**
   * NOTE: `getStateMemory` / `pruneStateMemory` (the state.md half of the old
   * "knowledge.md / state.md dual store") were removed on 2026-09-16. Situational
   * short-lived state is Working-layer data and lives in NOTEBOOK.md. See
   * docs/architecture/memory-system.md §10.2 (option A).
   */

  // -- Episodic Memory: conversation sessions --
  getSession(sessionId: string): ConversationSession | undefined;
  listSessions(agentId?: string): ConversationSession[];
  /** Count session files on disk (honest total vs the in-memory warm cap). */
  countSessionsOnDisk?(): number;
  getLatestSession(agentId: string): ConversationSession | undefined;
  getLatestMainSession(agentId: string): ConversationSession | undefined;
  /**
   * Create or adopt a session. Passing `id` (an authoritative `cs_…` DB chat
   * session id) makes it the memory primary key — one conversation, one id, one
   * store entry. Idempotent: an existing session with that id is adopted, never
   * forked. Omitting `id` keeps generating `sess_…` for internal turns.
   */
  createSession(agentId: string, id?: string): ConversationSession;
  /** Force a session to disk now (bypasses the write debounce). */
  flushSession?(sessionId: string): void;
  getOrCreateSession(agentId: string, sessionId: string): ConversationSession;
  /** Rename a session (used by the agent session_rename tool). */
  renameSession?(sessionId: string, title: string): void;
  appendMessage(sessionId: string, message: LLMMessage): void;
  /** Persist the provider's last prompt measurement onto the session record. */
  recordReportedInputTokens?(sessionId: string, reading: { tokens: number; messageCount: number }): void;
  /** Read that measurement back (lazily loading the session from disk). */
  getReportedInputTokens?(sessionId: string): { tokens: number; messageCount: number } | undefined;
  /** Drop it — compaction shrank the history, so the old reading describes nothing. */
  clearReportedInputTokens?(sessionId: string): void;
  getRecentMessages(sessionId: string, limit: number): LLMMessage[];
  compactSession(sessionId: string, keepLast?: number): CompactResult;
  summarizeAndTruncate(sessionId: string, keepLast: number): LLMMessage[];

  // -- ContextOS: session slots (agent-managed fixed段) + fragment archive --
  getSlots?(sessionId: string): Array<{ key: string; text: string; updatedAt?: number }>;
  setSlot?(sessionId: string, key: string, text: string): void;
  removeSlot?(sessionId: string, key: string): void;
  serializeSlots?(sessionId: string): string;
  /** ContextOS: serialize this session's compaction summary into the fixed
   *  [CONTEXT SUMMARY] segment (empty string when there is none). Injected
   *  alongside slots but semantically a SEPARATE block. */
  serializeSummary?(sessionId: string): string;
  retrieveFragments?(
    query: string,
    maxResults?: number,
  ): Array<{ id: string; content: string; metadata?: Record<string, unknown> }>;
  includeFragment?(sessionId: string, fragmentId: string): { ok: boolean; message: string };
  purgeSessionFragments?(sessionId: string): number;
  sessionStats?(sessionId: string): { messageCount: number; slotKeys: string[]; fragmentCount: number };

  // -- Audit trail (write-only, not injected into prompts) --
  writeDailyLog(agentId: string, summary: string): void;
  getDailyLog(date?: string): string;
  getRecentDailyLogs(days?: number): string;
}
