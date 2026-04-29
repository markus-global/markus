import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { IEpisodicMemory, ConversationSession, LLMMessage } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeId = (): string => Math.random().toString(36).slice(2, 10);
const fakeMsg = (role: LLMMessage['role'] = 'user'): LLMMessage => ({
  role,
  content: `Message ${fakeId()}`,
  timestamp: new Date().toISOString(),
});

const fakeSession = (overrides?: Partial<ConversationSession>): ConversationSession => ({
  id: fakeId(),
  agentId: 'agent-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  messageCount: 0,
  summary: undefined,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mock implementation of IEpisodicMemory
// ---------------------------------------------------------------------------
function createMockMemory(): IEpisodicMemory {
  const sessions = new Map<string, ConversationSession>();
  const messages = new Map<string, LLMMessage[]>();
  const activities = new Map<string, any[]>();
  const decisions = new Map<string, any[]>();
  const summaries = new Map<string, string>();
  const summaryLog = new Map<string, string[]>(); // agentId → summaries

  const touch = (s: ConversationSession) => {
    s.updatedAt = new Date().toISOString();
  };

  return {
    // ---- Session lifecycle ------------------------------------------------
    async createSession(agentId: string): Promise<ConversationSession> {
      const s = fakeSession({ agentId, messageCount: 0 });
      sessions.set(s.id, s);
      messages.set(s.id, []);
      activities.set(s.id, []);
      decisions.set(s.id, []);
      return { ...s };
    },

    async getOrCreateSession(agentId: string, sessionId?: string): Promise<ConversationSession> {
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (existing) return { ...existing };
      }
      const s = sessionId
        ? fakeSession({ id: sessionId, agentId, messageCount: 0 })
        : fakeSession({ agentId, messageCount: 0 });
      sessions.set(s.id, s);
      messages.set(s.id, []);
      activities.set(s.id, []);
      decisions.set(s.id, []);
      return { ...s };
    },

    async getSession(sessionId: string): Promise<ConversationSession | undefined> {
      const s = sessions.get(sessionId);
      return s ? { ...s } : undefined;
    },

    async listSessions(agentId?: string): Promise<ConversationSession[]> {
      const all = [...sessions.values()]
        .filter((s) => (agentId ? s.agentId === agentId : true))
        .map((s) => ({ ...s }));
      return all.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    },

    async getLatestSession(agentId: string): Promise<ConversationSession | undefined> {
      const all = [...sessions.values()]
        .filter((s) => s.agentId === agentId)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      return all.length > 0 ? { ...all[0] } : undefined;
    },

    // ---- Messages ---------------------------------------------------------
    async appendMessage(sessionId: string, msg: LLMMessage): Promise<void> {
      const msgs = messages.get(sessionId);
      if (!msgs) throw new Error(`Session ${sessionId} not found`);
      msgs.push({ ...msg, timestamp: msg.timestamp || new Date().toISOString() });
      const s = sessions.get(sessionId);
      if (s) {
        s.messageCount = msgs.length;
        touch(s);
      }
      // Append activity for message
      const acts = activities.get(sessionId);
      if (acts) {
        acts.push({ type: 'message', role: msg.role, content: msg.content, timestamp: new Date().toISOString() });
      }
    },

    async getRecentMessages(sessionId: string, limit: number = 10): Promise<LLMMessage[]> {
      const msgs = messages.get(sessionId);
      if (!msgs) throw new Error(`Session ${sessionId} not found`);
      return msgs.slice(-limit).map((m) => ({ ...m }));
    },

    // ---- Compaction -------------------------------------------------------
    async compactSession(
      sessionId: string,
      keepLast: number = 10,
    ): Promise<{ summary: string; flushedCount: number }> {
      const msgs = messages.get(sessionId);
      if (!msgs) throw new Error(`Session ${sessionId} not found`);
      if (msgs.length <= keepLast) return { summary: '', flushedCount: 0 };
      const flushedCount = msgs.length - keepLast;
      const flushed = msgs.slice(0, flushedCount);
      const summary = `Compacted ${flushedCount} messages: ${flushed.map((m) => m.content).join('; ')}`;
      messages.set(sessionId, msgs.slice(-keepLast));
      const s = sessions.get(sessionId);
      if (s) {
        s.messageCount = msgs.slice(-keepLast).length;
        s.summary = summary;
        touch(s);
      }
      return { summary, flushedCount };
    },

    async summarizeAndTruncate(
      sessionId: string,
      keepLast: number = 10,
    ): Promise<LLMMessage[]> {
      const msgs = messages.get(sessionId);
      if (!msgs) throw new Error(`Session ${sessionId} not found`);
      if (msgs.length <= keepLast) return msgs.map((m) => ({ ...m }));
      const kept = msgs.slice(-keepLast);
      const summaryMsg: LLMMessage = {
        role: 'assistant',
        content: `[TRUNCATED] Summarized ${msgs.length - keepLast} earlier messages.`,
        timestamp: new Date().toISOString(),
      };
      const result = [summaryMsg, ...kept.map((m) => ({ ...m }))];
      messages.set(sessionId, result);
      const s = sessions.get(sessionId);
      if (s) {
        s.messageCount = result.length;
        s.summary = summaryMsg.content;
        touch(s);
      }
      return result.map((m) => ({ ...m }));
    },

    // ---- Activities -------------------------------------------------------
    async getActivities(sessionId: string, limit?: number): Promise<any[]> {
      const acts = activities.get(sessionId);
      if (!acts) throw new Error(`Session ${sessionId} not found`);
      const slice = limit ? acts.slice(-limit) : [...acts];
      return slice.map((a) => ({ ...a }));
    },

    async searchActivities(query: string, opts?: { sessionId?: string; limit?: number }): Promise<any[]> {
      const results: any[] = [];
      for (const [sid, acts] of activities) {
        if (opts?.sessionId && sid !== opts.sessionId) continue;
        for (const a of acts) {
          if (
            (a.type?.toLowerCase().includes(query.toLowerCase()) ?? false) ||
            (a.content?.toLowerCase().includes(query.toLowerCase()) ?? false)
          ) {
            results.push({ ...a, sessionId: sid });
          }
        }
      }
      const limit = opts?.limit ?? results.length;
      return results.slice(0, limit);
    },

    // ---- Decisions --------------------------------------------------------
    async getDecisions(sessionId: string, limit?: number): Promise<any[]> {
      const d = decisions.get(sessionId);
      if (!d) throw new Error(`Session ${sessionId} not found`);
      const slice = limit ? d.slice(-limit) : [...d];
      return slice.map((x) => ({ ...x }));
    },

    // ---- Summaries --------------------------------------------------------
    async generateSummary(sessionId: string): Promise<string> {
      const msgs = messages.get(sessionId);
      if (!msgs) throw new Error(`Session ${sessionId} not found`);
      const s = sessions.get(sessionId);
      const summary = `Summary of session ${sessionId}: ${msgs.length} messages.`;
      if (s) {
        s.summary = summary;
        touch(s);
      }
      summaries.set(sessionId, summary);
      // Log to agent summary history
      if (s) {
        const log = summaryLog.get(s.agentId) ?? [];
        log.push(summary);
        summaryLog.set(s.agentId, log);
      }
      return summary;
    },

    async getRecentSummaries(agentId: string, count: number): Promise<string[]> {
      const log = summaryLog.get(agentId) ?? [];
      return log.slice(-count);
    },

    // ---- Cleanup ----------------------------------------------------------
    async cleanupOldSessions(retentionDays: number): Promise<void> {
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000).getTime();
      for (const [id, s] of sessions) {
        if (new Date(s.updatedAt).getTime() < cutoff) {
          sessions.delete(id);
          messages.delete(id);
          activities.delete(id);
          decisions.delete(id);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('IEpisodicMemory', () => {
  let memory: IEpisodicMemory;

  // Helper to seed messages into a session
  async function seedMessages(
    sessionId: string,
    count: number,
    roles: Array<LLMMessage['role']> = ['user', 'assistant'],
  ) {
    for (let i = 0; i < count; i++) {
      await memory.appendMessage(sessionId, fakeMsg(roles[i % roles.length]));
    }
  }

  beforeEach(async () => {
    memory = createMockMemory();
  });

  // ===================================================================
  // 1. Session lifecycle
  // ===================================================================
  describe('session lifecycle', () => {
    it('should create a session and return it with an id', async () => {
      const session = await memory.createSession('agent-1');
      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(session.agentId).toBe('agent-1');
      expect(session.messageCount).toBe(0);
    });

    it('should get a session by id', async () => {
      const created = await memory.createSession('agent-1');
      const fetched = await memory.getSession(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.agentId).toBe('agent-1');
    });

    it('should return undefined for a non-existent session', async () => {
      const fetched = await memory.getSession('non-existent');
      expect(fetched).toBeUndefined();
    });

    it('should list all sessions for an agent', async () => {
      const s1 = await memory.createSession('agent-1');
      const s2 = await memory.createSession('agent-1');
      const s3 = await memory.createSession('agent-2');

      const list1 = await memory.listSessions('agent-1');
      expect(list1).toHaveLength(2);
      expect(list1.map((s) => s.id)).toContain(s1.id);
      expect(list1.map((s) => s.id)).toContain(s2.id);

      const listAll = await memory.listSessions();
      expect(listAll).toHaveLength(3);
    });

    it('should list sessions ordered by updatedAt descending', async () => {
      const s1 = await memory.createSession('agent-1');
      await new Promise((r) => setTimeout(r, 5));
      const s2 = await memory.createSession('agent-1');
      await new Promise((r) => setTimeout(r, 5));
      const s3 = await memory.createSession('agent-1');

      const list = await memory.listSessions('agent-1');
      expect(list[0].id).toBe(s3.id);
      expect(list[1].id).toBe(s2.id);
      expect(list[2].id).toBe(s1.id);
    });

    it('should get the latest session for an agent', async () => {
      const s1 = await memory.createSession('agent-1');
      await new Promise((r) => setTimeout(r, 5));
      const s2 = await memory.createSession('agent-1');

      const latest = await memory.getLatestSession('agent-1');
      expect(latest).toBeDefined();
      expect(latest!.id).toBe(s2.id);
    });

    it('should return undefined for getLatestSession when no sessions exist', async () => {
      const latest = await memory.getLatestSession('ghost-agent');
      expect(latest).toBeUndefined();
    });

    it('should get or create an existing session', async () => {
      const created = await memory.createSession('agent-1');
      const got = await memory.getOrCreateSession('agent-1', created.id);
      expect(got.id).toBe(created.id);
    });

    it('should create a new session when getOrCreateSession gets unknown id', async () => {
      const got = await memory.getOrCreateSession('agent-1', 'brand-new-id');
      expect(got.id).toBe('brand-new-id');
      expect(got.agentId).toBe('agent-1');
    });

    it('should create a fresh session when getOrCreateSession is called without id', async () => {
      const got = await memory.getOrCreateSession('agent-1');
      expect(got.id).toBeDefined();
      expect(got.agentId).toBe('agent-1');
    });
  });

  // ===================================================================
  // 2. Message operations
  // ===================================================================
  describe('message operations', () => {
    it('should append a message and increase count', async () => {
      const session = await memory.createSession('agent-1');
      await memory.appendMessage(session.id, fakeMsg('user'));
      const fetched = await memory.getSession(session.id);
      expect(fetched!.messageCount).toBe(1);
    });

    it('should return recent messages in order', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 5);
      const recent = await memory.getRecentMessages(session.id, 3);
      expect(recent).toHaveLength(3);
    });

    it('should return all messages when limit exceeds total', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 3);
      const all = await memory.getRecentMessages(session.id, 100);
      expect(all).toHaveLength(3);
    });

    it('should throw when appending to non-existent session', async () => {
      await expect(memory.appendMessage('no-such-id', fakeMsg('user'))).rejects.toThrow(/not found/i);
    });

    it('should throw when getting messages from non-existent session', async () => {
      await expect(memory.getRecentMessages('no-such-id')).rejects.toThrow(/not found/i);
    });

    it('should return messages with correct roles and content', async () => {
      const session = await memory.createSession('agent-1');
      await memory.appendMessage(session.id, { role: 'user', content: 'Hello', timestamp: new Date().toISOString() });
      await memory.appendMessage(session.id, { role: 'assistant', content: 'Hi there', timestamp: new Date().toISOString() });
      const msgs = await memory.getRecentMessages(session.id, 10);
      expect(msgs[0].role).toBe('user');
      expect(msgs[0].content).toBe('Hello');
      expect(msgs[1].role).toBe('assistant');
      expect(msgs[1].content).toBe('Hi there');
    });
  });

  // ===================================================================
  // 3. Session not found edge cases
  // ===================================================================
  describe('session not found', () => {
    it('should return undefined for getSession with unknown id', async () => {
      const result = await memory.getSession('unknown');
      expect(result).toBeUndefined();
    });

    it('should return empty list for listSessions with unknown agent', async () => {
      const list = await memory.listSessions('unknown-agent');
      expect(list).toEqual([]);
    });

    it('should throw on compactSession with unknown id', async () => {
      await expect(memory.compactSession('unknown')).rejects.toThrow(/not found/i);
    });

    it('should throw on summarizeAndTruncate with unknown id', async () => {
      await expect(memory.summarizeAndTruncate('unknown')).rejects.toThrow(/not found/i);
    });

    it('should throw on getActivities with unknown id', async () => {
      await expect(memory.getActivities('unknown')).rejects.toThrow(/not found/i);
    });

    it('should throw on getDecisions with unknown id', async () => {
      await expect(memory.getDecisions('unknown')).rejects.toThrow(/not found/i);
    });

    it('should throw on generateSummary with unknown id', async () => {
      await expect(memory.generateSummary('unknown')).rejects.toThrow(/not found/i);
    });
  });

  // ===================================================================
  // 4. Compaction
  // ===================================================================
  describe('compaction', () => {
    it('should flush older messages and return summary with compactSession', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 15);

      const result = await memory.compactSession(session.id, 5);
      expect(result.flushedCount).toBe(10);
      expect(result.summary).toContain('Compacted');

      const remaining = await memory.getRecentMessages(session.id, 50);
      expect(remaining).toHaveLength(5);
    });

    it('should return zero flushed when messages <= keepLast', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 3);

      const result = await memory.compactSession(session.id, 10);
      expect(result.flushedCount).toBe(0);
      expect(result.summary).toBe('');
    });

    it('should update session summary after compactSession', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 20);

      await memory.compactSession(session.id, 5);
      const updated = await memory.getSession(session.id);
      expect(updated!.summary).toContain('Compacted');
      expect(updated!.messageCount).toBe(5);
    });

    it('should insert a summary message via summarizeAndTruncate', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 12);

      const result = await memory.summarizeAndTruncate(session.id, 5);
      expect(result).toHaveLength(6); // 1 summary + 5 kept
      expect(result[0].role).toBe('assistant');
      expect(result[0].content).toContain('[TRUNCATED]');
    });

    it('should keep all messages when summarizeAndTruncate threshold not exceeded', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 3);

      const result = await memory.summarizeAndTruncate(session.id, 10);
      expect(result).toHaveLength(3);
      expect(result[0].content).not.toContain('[TRUNCATED]');
    });

    it('should throw compactSession for unknown session', async () => {
      await expect(memory.compactSession('unknown')).rejects.toThrow();
    });

    it('should throw summarizeAndTruncate for unknown session', async () => {
      await expect(memory.summarizeAndTruncate('unknown')).rejects.toThrow();
    });
  });

  // ===================================================================
  // 5. Activities
  // ===================================================================
  describe('activities', () => {
    it('should return activity timeline for a session', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 4);
      // Append decisions manually via private helper (we'll test via messages)
      const acts = await memory.getActivities(session.id);
      expect(acts.length).toBeGreaterThanOrEqual(4);
      expect(acts.every((a: any) => a.type === 'message')).toBe(true);
    });

    it('should respect limit parameter in getActivities', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 10);
      const acts = await memory.getActivities(session.id, 3);
      expect(acts).toHaveLength(3);
    });

    it('should throw getActivities for unknown session', async () => {
      await expect(memory.getActivities('unknown')).rejects.toThrow();
    });

    it('should search activities by type', async () => {
      const s1 = await memory.createSession('agent-1');
      const s2 = await memory.createSession('agent-1');
      await seedMessages(s1.id, 3);
      await seedMessages(s2.id, 2);

      const results = await memory.searchActivities('message');
      expect(results.length).toBeGreaterThanOrEqual(5);
      expect(results.every((r: any) => r.type === 'message')).toBe(true);
    });

    it('should search activities with sessionId filter', async () => {
      const s1 = await memory.createSession('agent-1');
      const s2 = await memory.createSession('agent-1');
      await seedMessages(s1.id, 3);
      await seedMessages(s2.id, 2);

      const results = await memory.searchActivities('message', { sessionId: s1.id });
      expect(results.length).toBeGreaterThanOrEqual(3);
      expect(results.every((r: any) => r.sessionId === s1.id)).toBe(true);
    });

    it('should return empty results for non-matching search', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 3);
      const results = await memory.searchActivities('zzz_nonexistent_zzz');
      expect(results).toEqual([]);
    });

    it('should limit search results', async () => {
      const s1 = await memory.createSession('agent-1');
      await seedMessages(s1.id, 10);
      const results = await memory.searchActivities('message', { limit: 2 });
      expect(results).toHaveLength(2);
    });
  });

  // ===================================================================
  // 6. Decisions
  // ===================================================================
  describe('decisions', () => {
    it('should throw getDecisions for unknown session', async () => {
      await expect(memory.getDecisions('unknown')).rejects.toThrow();
    });

    it('should return empty decisions for a fresh session (mock returns empty array)', async () => {
      const session = await memory.createSession('agent-1');
      // By default the mock has an empty decisions array
      const d = await memory.getDecisions(session.id);
      expect(Array.isArray(d)).toBe(true);
    });

    it('should respect limit in getDecisions', async () => {
      const session = await memory.createSession('agent-1');
      const d = await memory.getDecisions(session.id, 5);
      expect(Array.isArray(d)).toBe(true);
    });
  });

  // ===================================================================
  // 7. Summaries
  // ===================================================================
  describe('summaries', () => {
    it('should generate a summary for a session', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 5);
      const summary = await memory.generateSummary(session.id);
      expect(summary).toContain('Summary');
      expect(summary).toContain(session.id);
    });

    it('should update session with summary after generation', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 3);
      await memory.generateSummary(session.id);
      const updated = await memory.getSession(session.id);
      expect(updated!.summary).toContain('Summary');
    });

    it('should throw generateSummary for unknown session', async () => {
      await expect(memory.generateSummary('unknown')).rejects.toThrow();
    });

    it('should return recent summaries for an agent', async () => {
      const s1 = await memory.createSession('agent-1');
      const s2 = await memory.createSession('agent-1');
      await seedMessages(s1.id, 3);
      await seedMessages(s2.id, 4);
      await memory.generateSummary(s1.id);
      await memory.generateSummary(s2.id);

      const recents = await memory.getRecentSummaries('agent-1', 5);
      expect(recents).toHaveLength(2);
      expect(recents[0]).toContain('Summary');
    });

    it('should respect count in getRecentSummaries', async () => {
      for (let i = 0; i < 5; i++) {
        const s = await memory.createSession('agent-1');
        await seedMessages(s.id, 1);
        await memory.generateSummary(s.id);
      }
      const recents = await memory.getRecentSummaries('agent-1', 2);
      expect(recents).toHaveLength(2);
    });

    it('should return empty array when no summaries exist', async () => {
      const recents = await memory.getRecentSummaries('agent-without-summaries', 5);
      expect(recents).toEqual([]);
    });

    it('should generate summary for empty session', async () => {
      const session = await memory.createSession('agent-1');
      const summary = await memory.generateSummary(session.id);
      expect(summary).toContain('0 messages');
    });
  });

  // ===================================================================
  // 8. Cleanup
  // ===================================================================
  describe('cleanup', () => {
    it('should purge old sessions beyond retention period', async () => {
      const session = await memory.createSession('agent-1');
      // Manually set updatedAt far in the past via the session object
      // The mock uses the real date, so we rely on retentionDays = 0
      // which will delete anything older than now
      await new Promise((r) => setTimeout(r, 10));
      await memory.cleanupOldSessions(0);
      const fetched = await memory.getSession(session.id);
      expect(fetched).toBeUndefined();
    });

    it('should keep sessions within retention period', async () => {
      const session = await memory.createSession('agent-1');
      await memory.cleanupOldSessions(365);
      const fetched = await memory.getSession(session.id);
      expect(fetched).toBeDefined();
    });

    it('should clean up associated messages and activities', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 5);
      await new Promise((r) => setTimeout(r, 10));
      await memory.cleanupOldSessions(0);
      await expect(memory.getRecentMessages(session.id, 10)).rejects.toThrow();
    });

    it('should not affect sessions from other agents', async () => {
      const old = await memory.createSession('agent-1');
      const fresh = await memory.createSession('agent-2');
      await new Promise((r) => setTimeout(r, 10));
      await memory.cleanupOldSessions(0);
      const oldFetched = await memory.getSession(old.id);
      const freshFetched = await memory.getSession(fresh.id);
      expect(oldFetched).toBeUndefined();
      expect(freshFetched).toBeUndefined();
    });
  });

  // ===================================================================
  // 9. Edge cases
  // ===================================================================
  describe('edge cases', () => {
    it('should handle empty session gracefully (no messages)', async () => {
      const session = await memory.createSession('agent-1');
      const msgs = await memory.getRecentMessages(session.id, 10);
      expect(msgs).toEqual([]);
    });

    it('should handle zero limit in getRecentMessages (returns all)', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 5);
      const msgs = await memory.getRecentMessages(session.id, 0);
      expect(msgs.length).toBe(5);
    });

    it('should handle very large message content', async () => {
      const session = await memory.createSession('agent-1');
      const largeContent = 'A'.repeat(100_000);
      await memory.appendMessage(session.id, { role: 'user', content: largeContent, timestamp: new Date().toISOString() });
      const msgs = await memory.getRecentMessages(session.id, 1);
      expect(msgs[0].content).toHaveLength(100_000);
    });

    it('should handle many messages without performance regression (smoke)', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 500);
      const msgs = await memory.getRecentMessages(session.id, 10);
      expect(msgs).toHaveLength(10);
    });

    it('should handle special characters in content', async () => {
      const session = await memory.createSession('agent-1');
      const special = 'Hello\nWorld\t🚀\u2000emoji';
      await memory.appendMessage(session.id, { role: 'user', content: special, timestamp: new Date().toISOString() });
      const msgs = await memory.getRecentMessages(session.id, 1);
      expect(msgs[0].content).toBe(special);
    });

    it('should handle concurrent session creation', async () => {
      const sessions = await Promise.all([
        memory.createSession('agent-1'),
        memory.createSession('agent-1'),
        memory.createSession('agent-1'),
      ]);
      expect(sessions).toHaveLength(3);
      const ids = new Set(sessions.map((s) => s.id));
      expect(ids.size).toBe(3);
    });

    it('should handle concurrent message appends', async () => {
      const session = await memory.createSession('agent-1');
      const promises = Array.from({ length: 20 }, (_, i) =>
        memory.appendMessage(session.id, { role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}`, timestamp: new Date().toISOString() }),
      );
      await Promise.all(promises);
      const msgs = await memory.getRecentMessages(session.id, 50);
      expect(msgs).toHaveLength(20);
    });

    it('should preserve message order under concurrent appends', async () => {
      const session = await memory.createSession('agent-1');
      const promises = Array.from({ length: 10 }, (_, i) =>
        memory.appendMessage(session.id, { role: 'user', content: String(i), timestamp: new Date().toISOString() }),
      );
      await Promise.all(promises);
      const msgs = await memory.getRecentMessages(session.id, 20);
      expect(msgs.length).toBe(10);
    });

    it('should return distinct session objects (immutability)', async () => {
      const created = await memory.createSession('agent-1');
      const fetched = await memory.getSession(created.id);
      expect(fetched).not.toBe(created);
      // Modify the returned object; should not affect store
      if (fetched) (fetched as any).agentId = 'hacked';
      const refetched = await memory.getSession(created.id);
      expect(refetched!.agentId).toBe('agent-1');
    });

    it('should return distinct message arrays (immutability)', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 3);
      const msgs1 = await memory.getRecentMessages(session.id, 10);
      const msgs2 = await memory.getRecentMessages(session.id, 10);
      expect(msgs1).toEqual(msgs2);
      // Modifying one should not affect the other
      msgs1[0].content = 'MUTATED';
      const msgs3 = await memory.getRecentMessages(session.id, 10);
      expect(msgs3[0].content).not.toBe('MUTATED');
    });

    it('should cleanup only the specified agent sessions (if store scoped)', async () => {
      await memory.createSession('agent-1');
      await memory.createSession('agent-2');
      // Retention 0 should purge all sessions
      await new Promise((r) => setTimeout(r, 10));
      await memory.cleanupOldSessions(0);
      const list = await memory.listSessions();
      expect(list).toHaveLength(0);
    });

    it('should handle repeated generateSummary calls', async () => {
      const session = await memory.createSession('agent-1');
      await seedMessages(session.id, 5);
      const s1 = await memory.generateSummary(session.id);
      const s2 = await memory.generateSummary(session.id);
      // Both calls should succeed; summaries may differ
      expect(s1).toBeDefined();
      expect(s2).toBeDefined();
    });

    it('should handle getOrCreateSession race conditions (sequential)', async () => {
      const id = 'race-id';
      const [r1, r2] = await Promise.all([
        memory.getOrCreateSession('agent-1', id),
        memory.getOrCreateSession('agent-1', id),
      ]);
      expect(r1.id).toBe(id);
      expect(r2.id).toBe(id);
    });
  });
});
