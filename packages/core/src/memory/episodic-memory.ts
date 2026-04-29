/**
 * episodic-memory.ts — Episodic Memory layer
 *
 * Stores conversation sessions and message history.
 * Implements IEpisodicMemory interface.
 *
 * Stores sessions as JSON files in a sessions/ directory
 * so existing consumers (MemoryStore) can also see them.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { createLogger, type LLMMessage } from '@markus/shared';
import type { IEpisodicMemory, ConversationSession } from './interfaces.js';

const log = createLogger('episodic-memory');

// =============================================================================
// EpisodicMemory
// =============================================================================

export class EpisodicMemory implements IEpisodicMemory {
  private sessionsDir: string;
  private sessions = new Map<string, ConversationSession>();
  private messages = new Map<string, LLMMessage[]>();

  constructor(config: { dataDir: string; agentId?: string }) {
    this.sessionsDir = join(config.dataDir, 'sessions');
    mkdirSync(this.sessionsDir, { recursive: true });
    this.loadFromDisk();
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  async createSession(agentId: string): Promise<ConversationSession> {
    const session: ConversationSession = {
      id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    this.saveSessionToDisk(session);
    log.debug('Session created', { sessionId: session.id, agentId });
    return { ...session };
  }

  async getOrCreateSession(
    agentId: string,
    sessionId?: string,
  ): Promise<ConversationSession> {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) return { ...existing };
    }
    const id = sessionId ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session: ConversationSession = {
      id,
      agentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    this.saveSessionToDisk(session);
    return { ...session };
  }

  async getSession(sessionId: string): Promise<ConversationSession | undefined> {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : undefined;
  }

  async listSessions(agentId?: string): Promise<ConversationSession[]> {
    const all = [...this.sessions.values()]
      .filter((s) => (agentId ? s.agentId === agentId : true))
      .map((s) => ({ ...s }));
    return all.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async getLatestSession(
    agentId: string,
  ): Promise<ConversationSession | undefined> {
    const all = [...this.sessions.values()]
      .filter((s) => s.agentId === agentId)
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    return all.length > 0 ? { ...all[0] } : undefined;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async appendMessage(sessionId: string, msg: LLMMessage): Promise<void> {
    const msgs = this.messages.get(sessionId);
    if (!msgs) throw new Error(`Session ${sessionId} not found`);
    msgs.push({ ...msg });
    const s = this.sessions.get(sessionId);
    if (s) {
      s.messageCount = msgs.length;
      s.updatedAt = new Date().toISOString();
      this.saveSessionToDisk(s);
    }
  }

  async getRecentMessages(
    sessionId: string,
    limit: number = 10,
  ): Promise<LLMMessage[]> {
    const msgs = this.messages.get(sessionId);
    if (!msgs) throw new Error(`Session ${sessionId} not found`);
    return msgs.slice(-limit).map((m) => ({ ...m }));
  }

  // ---------------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------------

  async compactSession(
    sessionId: string,
    keepLast: number = 10,
  ): Promise<{ summary: string; flushedCount: number }> {
    const msgs = this.messages.get(sessionId);
    if (!msgs) throw new Error(`Session ${sessionId} not found`);
    if (msgs.length <= keepLast) return { summary: '', flushedCount: 0 };

    const flushedCount = msgs.length - keepLast;
    const flushed = msgs.slice(0, flushedCount);
    const summary = `Compacted ${flushedCount} messages: ${flushed
      .map((m) => {
        const text =
          typeof m.content === 'string'
            ? m.content.slice(0, 100)
            : '[complex content]';
        return `${m.role}: ${text}`;
      })
      .join('; ')}`;

    this.messages.set(sessionId, msgs.slice(-keepLast));
    const s = this.sessions.get(sessionId);
    if (s) {
      s.messageCount = msgs.slice(-keepLast).length;
      s.summary = summary;
      s.updatedAt = new Date().toISOString();
      this.saveSessionToDisk(s);
    }
    return { summary, flushedCount };
  }

  async summarizeAndTruncate(
    sessionId: string,
    keepLast: number = 10,
  ): Promise<LLMMessage[]> {
    const msgs = this.messages.get(sessionId);
    if (!msgs) throw new Error(`Session ${sessionId} not found`);
    if (msgs.length <= keepLast) return msgs.map((m) => ({ ...m }));

    const kept = msgs.slice(-keepLast);
    const summaryText = `[TRUNCATED] Summarized ${msgs.length - keepLast} earlier messages.`;
    const summaryMsg: LLMMessage = {
      role: 'assistant',
      content: summaryText,
    };
    const result = [summaryMsg, ...kept.map((m) => ({ ...m }))];
    this.messages.set(sessionId, result);

    const s = this.sessions.get(sessionId);
    if (s) {
      s.messageCount = result.length;
      s.summary = typeof summaryMsg.content === 'string' ? summaryMsg.content : '[complex content]';
      s.updatedAt = new Date().toISOString();
      this.saveSessionToDisk(s);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private saveSessionToDisk(session: ConversationSession): void {
    try {
      const filePath = join(this.sessionsDir, `${session.id}.json`);
      const data = {
        session,
        messages: this.messages.get(session.id) ?? [],
      };
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      log.warn('Failed to save session to disk', {
        sessionId: session.id,
        error: String(err),
      });
    }
  }

  private loadFromDisk(): void {
    try {
      const files = readdirSync(this.sessionsDir).filter((f) =>
        f.endsWith('.json'),
      );
      for (const f of files) {
        try {
          const raw = readFileSync(join(this.sessionsDir, f), 'utf-8');
          const data = JSON.parse(raw) as {
            session: ConversationSession;
            messages?: LLMMessage[];
          };
          if (data.session && data.session.id) {
            this.sessions.set(data.session.id, data.session);
            this.messages.set(data.session.id, data.messages ?? []);
          }
        } catch {
          log.warn(`Failed to load session file: ${f}`);
        }
      }
      if (files.length > 0) {
        log.debug(`Loaded ${files.length} sessions from disk`);
      }
    } catch {
      // sessions dir may not exist yet
    }
  }

  /** Remove a session entirely (used for cleanup) */
  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    try {
      const filePath = join(this.sessionsDir, `${sessionId}.json`);
      if (existsSync(filePath)) rmSync(filePath);
    } catch {
      // ignore
    }
  }
}
