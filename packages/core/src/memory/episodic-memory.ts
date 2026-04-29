/**
 * episodic-memory.ts — Episodic Memory layer
 *
 * Stores conversation sessions and message history using SqliteChatSessionRepo
 * from @markus/storage. Implements IEpisodicMemory interface.
 *
 * All repo methods are synchronous (SqliteChatSessionRepo uses Better-SQLite3's
 * sync API), so the async interface is a thin wrapper.
 */

import { createLogger, type LLMMessage } from '@markus/shared';
import type {
  SqliteChatSessionRepo,
  ChatSession,
  ChatMessage,
} from '@markus/storage';
import type { IEpisodicMemory, ConversationSession } from './interfaces.js';

const log = createLogger('episodic-memory');

// =============================================================================
// Mapping helpers — convert storage types to core types
// =============================================================================

/** Map a storage ChatSession to a core ConversationSession */
function toConversationSession(cs: ChatSession): ConversationSession {
  return {
    id: cs.id,
    agentId: cs.agentId,
    createdAt: cs.createdAt instanceof Date
      ? cs.createdAt.toISOString()
      : String(cs.createdAt),
    updatedAt: cs.lastMessageAt instanceof Date
      ? cs.lastMessageAt.toISOString()
      : String(cs.lastMessageAt),
    messageCount: 0, // computed below
    summary: cs.title ?? undefined,
  };
}

/** Compute message count by querying the repo */
function getMessageCount(
  repo: SqliteChatSessionRepo,
  sessionId: string,
): number {
  try {
    return repo.getMessageCount(sessionId);
  } catch {
    return 0;
  }
}

/** Map a storage ChatMessage role to an LLMMessage role */
function toLLMMessage(m: ChatMessage): LLMMessage {
  return {
    role: m.role as 'system' | 'user' | 'assistant' | 'tool',
    content: m.content as string,
  };
}

// =============================================================================
// EpisodicMemory
// =============================================================================

export class EpisodicMemory implements IEpisodicMemory {
  private repo: SqliteChatSessionRepo;

  constructor(config: { repo: SqliteChatSessionRepo }) {
    this.repo = config.repo;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  async createSession(agentId: string): Promise<ConversationSession> {
    const cs = this.repo.createSession(agentId) as ChatSession;
    const session = toConversationSession(cs);
    session.messageCount = 0;
    log.debug('Session created', { sessionId: session.id, agentId });
    return session;
  }

  async getOrCreateSession(
    agentId: string,
    sessionId?: string,
  ): Promise<ConversationSession> {
    if (sessionId) {
      const existing = this.repo.getSession(sessionId) as ChatSession | null;
      if (existing) {
        const session = toConversationSession(existing);
        session.messageCount = getMessageCount(this.repo, sessionId);
        return session;
      }
    }
    const cs = this.repo.createSession(agentId) as ChatSession;
    const session = toConversationSession(cs);
    session.messageCount = 0;
    return session;
  }

  async getSession(
    sessionId: string,
  ): Promise<ConversationSession | undefined> {
    const cs = this.repo.getSession(sessionId) as ChatSession | null;
    if (!cs) return undefined;
    const session = toConversationSession(cs);
    session.messageCount = getMessageCount(this.repo, sessionId);
    return session;
  }

  async listSessions(agentId?: string): Promise<ConversationSession[]> {
    const raw = agentId
      ? (this.repo.getSessionsByAgent(agentId, 100) as ChatSession[])
      : [];
    const sessions = raw.map((cs) => {
      const session = toConversationSession(cs);
      session.messageCount = getMessageCount(this.repo, cs.id);
      return session;
    });
    return sessions.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async getLatestSession(
    agentId: string,
  ): Promise<ConversationSession | undefined> {
    const raw = this.repo.getSessionsByAgent(agentId, 1) as ChatSession[];
    if (raw.length === 0) return undefined;
    const session = toConversationSession(raw[0]);
    session.messageCount = getMessageCount(this.repo, raw[0].id);
    return session;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async appendMessage(sessionId: string, msg: LLMMessage): Promise<void> {
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
    const session = this.repo.getSession(sessionId) as ChatSession | null;
    const agentId = session?.agentId ?? '';
    this.repo.appendMessage(sessionId, agentId, msg.role, content);
    this.repo.updateLastMessage(sessionId, undefined);
  }

  async getRecentMessages(
    sessionId: string,
    limit: number = 10,
  ): Promise<LLMMessage[]> {
    const { messages } = this.repo.getMessages(sessionId, limit) as { messages: ChatMessage[]; hasMore: boolean };
    return messages.map((m: ChatMessage) =>
      toLLMMessage(m),
    );
  }

  // ---------------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------------

  async compactSession(
    sessionId: string,
    keepLast: number = 10,
  ): Promise<{ summary: string; flushedCount: number }> {
    const { messages } = this.repo.getMessages(sessionId, keepLast + 1) as { messages: ChatMessage[]; hasMore: boolean };
    const allMessages = this.repo.getMessages(sessionId, 10000) as { messages: ChatMessage[]; hasMore: boolean };
    const totalCount = allMessages.messages.length;
    if (totalCount <= keepLast) return { summary: '', flushedCount: 0 };

    const flushedCount = totalCount - keepLast;
    const flushed = messages.slice(0, flushedCount);
    const summary = `Compacted ${flushedCount} messages: ${flushed
      .map((m: ChatMessage) => {
        const text =
          typeof m.content === 'string'
            ? m.content.slice(0, 100)
            : '[complex content]';
        return `${m.role}: ${text}`;
      })
      .join('; ')}`;

    return { summary, flushedCount };
  }

  async summarizeAndTruncate(
    sessionId: string,
    keepLast: number = 10,
  ): Promise<LLMMessage[]> {
    const { messages } = this.repo.getMessages(sessionId, keepLast) as { messages: ChatMessage[]; hasMore: boolean };
    const kept = messages.map((m: ChatMessage) => toLLMMessage(m));
    const summaryText = `[TRUNCATED] Summarized earlier messages.`;
    const summaryMsg: LLMMessage = {
      role: 'assistant',
      content: summaryText,
    };
    return [summaryMsg, ...kept];
  }

  /** Remove a session entirely (used for cleanup) */
  async deleteSession(sessionId: string): Promise<void> {
    this.repo.deleteSession(sessionId);
  }
}
