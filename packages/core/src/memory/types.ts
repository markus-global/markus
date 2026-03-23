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
 * Both MemoryStore (basic) and EnhancedMemorySystem implement this.
 */
export interface IMemoryStore {
  addEntry(entry: MemoryEntry): void;
  getEntries(type?: MemoryEntry['type'], limit?: number): MemoryEntry[];
  search(query: string): MemoryEntry[];

  getSession(sessionId: string): ConversationSession | undefined;
  listSessions(agentId?: string): ConversationSession[];
  getLatestSession(agentId: string): ConversationSession | undefined;
  createSession(agentId: string): ConversationSession;
  getOrCreateSession(agentId: string, sessionId: string): ConversationSession;
  appendMessage(sessionId: string, message: LLMMessage): void;
  getRecentMessages(sessionId: string, limit: number): LLMMessage[];

  writeDailyLog(agentId: string, summary: string): void;
  getDailyLog(date?: string): string;
  getRecentDailyLogs(days?: number): string;

  addLongTermMemory(key: string, content: string): void;
  getLongTermMemory(): string;

  compactSession(sessionId: string, keepLast?: number): { summary: string; flushedCount: number };
  summarizeAndTruncate(sessionId: string, keepLast: number): LLMMessage[];
}
