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

export interface ConversationSession {
  id: string;
  agentId: string;
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
 * Unified memory interface for Agent and ContextEngine.
 * MemoryStore is the primary implementation.
 */
export interface IMemoryStore {
  // -- Semantic Memory: observation buffer (## _observations in knowledge.md) --
  addEntry(entry: MemoryEntry): void;
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
  addLongTermMemory(key: string, content: string): { ok: boolean; reason?: string };
  getLongTermMemory(): string;
  getLongTermMemoryExcluding(sections: string[]): string;
  getLongTermSection(sectionName: string): string;
  compressLongTermMemory(): { charsBefore: number; charsAfter: number; sectionsBefore: number; sectionsAfter: number; truncatedChunks: number };
  /** Optional state.md snapshot for reflex prompts (AGENT-RUNTIME memory taxonomy). */
  getStateMemory?(): string;
  /** Optional TTL prune for state.md (Dream librarian). */
  pruneStateMemory?(): void;

  // -- Episodic Memory: conversation sessions --
  getSession(sessionId: string): ConversationSession | undefined;
  listSessions(agentId?: string): ConversationSession[];
  getLatestSession(agentId: string): ConversationSession | undefined;
  getLatestMainSession(agentId: string): ConversationSession | undefined;
  createSession(agentId: string): ConversationSession;
  getOrCreateSession(agentId: string, sessionId: string): ConversationSession;
  appendMessage(sessionId: string, message: LLMMessage): void;
  getRecentMessages(sessionId: string, limit: number): LLMMessage[];
  compactSession(sessionId: string, keepLast?: number): { summary: string; flushedCount: number };
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
