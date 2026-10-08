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
 * Memory budget health — TWO budgets, reported separately and honestly.
 *
 * `knowledge.md` carries two kinds of content with different injection
 * semantics and therefore **separate** budgets (see
 * `MEMORY_MD_CURATED_MAX_CHARS` / `MEMORY_OBSERVATIONS_MAX_CHARS`):
 *
 *   - curated sections → INJECTED every turn; `curatedChars` / `percent` is the
 *     real "memory pressure" and the number the agent sees.
 *   - `## _observations` → NOT injected, searched on demand; `observationChars`
 *     / `observationPercent` is its own signal.
 *
 * Historically these were collapsed into one `totalChars`/`cap` pair measured
 * over the WHOLE FILE, so a large (and perfectly healthy) observation buffer
 * made `percent` read >100% while the injected footprint was tiny — a permanent
 * false alarm that trained agents to ignore the banner.
 */
export interface MemoryHealth {
  /** Curated (injected) footprint in chars — everything BEFORE `## _observations`. */
  curatedChars: number;
  curatedCap: number;
  /** `curatedChars / curatedCap` as a percent — THE memory-health number. */
  percent: number;
  /** `## _observations` buffer size in chars (NOT injected). */
  observationChars: number;
  observationCap: number;
  observationPercent: number;
  observations: number;
  curatedSections: number;
  archiveChars: number;
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
   *  Reports the TWO budgets separately and honestly; see `MemoryHealth`. */
  getMemoryHealth(): MemoryHealth;
  /** 审计 P-11：整理时间可观测（可选，便于 mock）。 */
  getLastConsolidatedAt?(): string | null;
  markConsolidated?(at?: Date): void;
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
  createSession(agentId: string): ConversationSession;
  getOrCreateSession(agentId: string, sessionId: string): ConversationSession;
  /** Rename a session (used by the agent session_rename tool). */
  renameSession?(sessionId: string, title: string): void;
  appendMessage(sessionId: string, message: LLMMessage): void;
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
