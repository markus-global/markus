/**
 * Agent Memory Types
 *
 * Organized by Tulving's cognitive classification:
 * - Semantic: factual knowledge (memories.json + MEMORY.md)
 * - Episodic: conversation sessions (sessions/*.json)
 * - Procedural: identity & skills (managed by RoleLoader, not here)
 */
import type { LLMMessage } from '@markus/shared';

export interface MemoryEntry {
  id: string;
  timestamp: string;
  type: 'conversation' | 'fact' | 'task_result' | 'note';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationSession {
  id: string;
  agentId: string;
  messages: LLMMessage[];
  startedAt: string;
  lastActivityAt: string;
}

/**
 * Unified memory interface for Agent and ContextEngine.
 * MemoryStore is the primary implementation.
 */
export interface IMemoryStore {
  // -- Semantic Memory: observation buffer (memories.json) --
  addEntry(entry: MemoryEntry): void;
  getEntries(type?: MemoryEntry['type'], limit?: number): MemoryEntry[];
  getEntriesByTag(tag: string, limit?: number): MemoryEntry[];
  search(query: string): MemoryEntry[];
  removeEntries(ids: string[]): number;
  replaceEntries(removedIds: string[], newEntry: MemoryEntry): void;
  removeEntriesByTag(tag: string): number;

  // -- Semantic Memory: curated knowledge (MEMORY.md) --
  addLongTermMemory(key: string, content: string): void;
  getLongTermMemory(): string;
  getLongTermMemoryExcluding(sections: string[]): string;
  getLongTermSection(sectionName: string): string;
  compressLongTermMemory(): { charsBefore: number; charsAfter: number; sectionsBefore: number; sectionsAfter: number; truncatedChunks: number };

  // -- Episodic Memory: conversation sessions --
  getSession(sessionId: string): ConversationSession | undefined;
  listSessions(agentId?: string): ConversationSession[];
  getLatestSession(agentId: string): ConversationSession | undefined;
  createSession(agentId: string): ConversationSession;
  getOrCreateSession(agentId: string, sessionId: string): ConversationSession;
  appendMessage(sessionId: string, message: LLMMessage): void;
  getRecentMessages(sessionId: string, limit: number): LLMMessage[];
  compactSession(sessionId: string, keepLast?: number): { summary: string; flushedCount: number };
  summarizeAndTruncate(sessionId: string, keepLast: number): LLMMessage[];

  // -- Audit trail (write-only, not injected into prompts) --
  writeDailyLog(agentId: string, summary: string): void;
  getDailyLog(date?: string): string;
  getRecentDailyLogs(days?: number): string;
}
