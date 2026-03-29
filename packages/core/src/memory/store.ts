import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, getTextContent, type LLMMessage } from '@markus/shared';
import type { IMemoryStore, MemoryEntry, ConversationSession } from './types.js';

export type { MemoryEntry, ConversationSession, IMemoryStore } from './types.js';

const log = createLogger('memory-store');

export class MemoryStore implements IMemoryStore {
  private dataDir: string;
  private entries: MemoryEntry[] = [];
  private sessions = new Map<string, ConversationSession>();
  private sessionsDir: string;
  private logsDir: string;
  private saveDebounce: ReturnType<typeof setTimeout> | null = null;
  private longTermFile: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.sessionsDir = join(dataDir, 'sessions');
    this.logsDir = join(dataDir, 'daily-logs');
    this.longTermFile = join(dataDir, 'MEMORY.md');
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    this.loadFromDisk();
    this.loadSessionsFromDisk();
  }

  // --- Short-term: session messages ---

  addEntry(entry: MemoryEntry): void {
    this.entries.push(entry);
    this.saveToDisk();
    log.debug('Memory entry added', { type: entry.type, id: entry.id });
  }

  getEntries(type?: MemoryEntry['type'], limit?: number): MemoryEntry[] {
    let result = type ? this.entries.filter((e) => e.type === type) : [...this.entries];
    if (limit) result = result.slice(-limit);
    return result;
  }

  getEntriesByTag(tag: string, limit?: number): MemoryEntry[] {
    const tagged = this.entries.filter(e =>
      Array.isArray(e.metadata?.tags) && (e.metadata!.tags as string[]).includes(tag)
    );
    return limit ? tagged.slice(-limit) : tagged;
  }

  search(query: string): MemoryEntry[] {
    const lower = query.toLowerCase();
    return this.entries.filter((e) => e.content.toLowerCase().includes(lower));
  }

  removeEntries(ids: string[]): number {
    const idSet = new Set(ids);
    const before = this.entries.length;
    this.entries = this.entries.filter(e => !idSet.has(e.id));
    const removed = before - this.entries.length;
    if (removed > 0) this.saveToDisk();
    return removed;
  }

  replaceEntries(removedIds: string[], newEntry: MemoryEntry): void {
    this.removeEntries(removedIds);
    this.entries.push(newEntry);
    this.saveToDisk();
  }

  getSession(sessionId: string): ConversationSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(agentId?: string): ConversationSession[] {
    const all = [...this.sessions.values()];
    if (agentId) return all.filter((s) => s.agentId === agentId);
    return all;
  }

  getLatestSession(agentId: string): ConversationSession | undefined {
    const agentSessions = this.listSessions(agentId);
    if (agentSessions.length === 0) return undefined;
    return agentSessions.sort((a, b) =>
      new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
    )[0];
  }

  createSession(agentId: string): ConversationSession {
    const session: ConversationSession = {
      id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      messages: [],
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    this.debouncedSaveSession(session);
    return session;
  }

  getOrCreateSession(agentId: string, sessionId: string): ConversationSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session: ConversationSession = {
      id: sessionId,
      agentId,
      messages: [],
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, session);
    this.debouncedSaveSession(session);
    return session;
  }

  appendMessage(sessionId: string, message: LLMMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.messages.push(message);
    session.lastActivityAt = new Date().toISOString();
    this.debouncedSaveSession(session);

    // Auto-compact when context gets large
    this.checkAndCompact(session);
  }

  getRecentMessages(sessionId: string, limit: number): LLMMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.messages.slice(-limit);
  }

  // --- Medium-term: daily conversation logs ---

  writeDailyLog(agentId: string, summary: string): void {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(this.logsDir, `${today}.md`);
    const timestamp = new Date().toISOString().slice(11, 19);
    const entry = `\n## [${timestamp}] Agent: ${agentId}\n\n${summary}\n`;

    appendFileSync(logFile, entry);
    log.debug('Daily log entry written', { agentId, date: today });
  }

  getDailyLog(date?: string): string {
    const d = date ?? new Date().toISOString().slice(0, 10);
    const logFile = join(this.logsDir, `${d}.md`);
    if (!existsSync(logFile)) return '';
    return readFileSync(logFile, 'utf-8');
  }

  getRecentDailyLogs(days: number = 3): string {
    const logs: string[] = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      const content = this.getDailyLog(d);
      if (content) logs.push(`# ${d}\n${content}`);
    }
    return logs.join('\n\n');
  }

  // --- Long-term: MEMORY.md ---

  addLongTermMemory(key: string, content: string): void {
    let existing = '';
    if (existsSync(this.longTermFile)) {
      existing = readFileSync(this.longTermFile, 'utf-8');
    }

    const sectionHeader = `## ${key}`;
    try {
      if (existing.includes(sectionHeader)) {
        const regex = new RegExp(`(## ${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\n[\\s\\S]*?(?=\\n## |$)`);
        existing = existing.replace(regex, `${sectionHeader}\n${content}\n`);
        writeFileSync(this.longTermFile, existing);
      } else {
        appendFileSync(this.longTermFile, `\n${sectionHeader}\n${content}\n`);
      }
      log.debug('Long-term memory updated', { key });
    } catch (err) {
      log.warn('Failed to write long-term memory', { key, error: String(err) });
    }
  }

  getLongTermMemory(): string {
    if (!existsSync(this.longTermFile)) return '';
    return readFileSync(this.longTermFile, 'utf-8');
  }

  // --- Context compaction (OpenClawd pattern) ---

  compactSession(sessionId: string, keepLast: number = 20): { summary: string; flushedCount: number } {
    const session = this.sessions.get(sessionId);
    if (!session || session.messages.length <= keepLast) {
      return { summary: '', flushedCount: 0 };
    }

    const older = session.messages.slice(0, -keepLast);
    const flushedCount = older.length;

    const summary = this.buildHeuristicSummary(older);

    this.writeDailyLog(session.agentId, summary);

    const facts = older
      .filter((m) => m.role === 'assistant' && getTextContent(m.content).length > 50)
      .map((m) => getTextContent(m.content).slice(0, 150))
      .slice(0, 3);

    if (facts.length > 0) {
      this.addEntry({
        id: `compact_${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: 'conversation',
        content: facts.join('\n'),
        metadata: { sessionId, compactedMessages: flushedCount },
      });
    }

    const retained = session.messages.slice(-keepLast);

    // Inject a summary message so the model retains awareness of compacted history
    const summaryMessage: LLMMessage = {
      role: 'user',
      content: `[Conversation history summary — ${flushedCount} earlier messages were compacted]\n${summary}\n[End of summary. The conversation continues below with the most recent messages.]`,
    };
    session.messages = [summaryMessage, ...retained];
    this.saveSessionToDisk(session);

    log.info('Session compacted', { sessionId, flushedCount, remaining: session.messages.length });
    return { summary, flushedCount };
  }

  /**
   * Build a heuristic summary by extracting key lines from messages.
   * Used as the default (non-LLM) summarization strategy.
   */
  buildHeuristicSummary(messages: LLMMessage[]): string {
    const summaryParts: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue;
      const text = getTextContent(msg.content);
      if (msg.role === 'user') {
        summaryParts.push(`User: ${text.slice(0, 200)}`);
      } else if (msg.role === 'assistant' && text) {
        summaryParts.push(`Assistant: ${text.slice(0, 200)}`);
      } else if (msg.role === 'tool') {
        summaryParts.push(`Tool result: ${text.slice(0, 100)}`);
      }
    }
    return summaryParts.join('\n').slice(0, 2000);
  }

  summarizeAndTruncate(sessionId: string, keepLast: number): LLMMessage[] {
    this.compactSession(sessionId, keepLast);
    const session = this.sessions.get(sessionId);
    return session?.messages ?? [];
  }

  // --- Disk persistence ---

  private checkAndCompact(session: ConversationSession): void {
    // Only shrink tool results in-place when the session is very large.
    // The context-engine already handles per-message compression when preparing
    // LLM calls, so aggressive early mutation here permanently destroys data
    // the agent may still need (e.g. research results from web_search / browser).
    // Threshold raised: only compact tool results when we're about to summarize
    // the session anyway (> 80 messages), and keep more content (2000 chars).
    if (session.messages.length <= 80) return;

    let shrunk = 0;
    const recentBoundary = session.messages.length - 40;
    for (let i = 0; i < recentBoundary; i++) {
      const m = session.messages[i]!;
      const text = getTextContent(m.content);
      if (m.role === 'tool' && text.length > 20_000) {
        const origLen = text.length;
        const headSize = Math.min(1500, Math.floor(origLen * 0.3));
        const tailSize = Math.min(500, Math.floor(origLen * 0.1));
        const head = text.slice(0, headSize);
        const tail = text.slice(-tailSize);
        m.content = `[Tool result compacted: ${origLen} chars → ${headSize + tailSize} char preview]\n${head}\n[... ${origLen - headSize - tailSize} chars omitted ...]\n${tail}`;
        shrunk++;
      }
    }

    log.info('Auto-compacting session by count', {
      sessionId: session.id, messageCount: session.messages.length, shrunkToolResults: shrunk,
    });
    this.compactSession(session.id, 40);
  }

  private loadFromDisk(): void {
    const memFile = join(this.dataDir, 'memories.json');
    if (existsSync(memFile)) {
      try {
        this.entries = JSON.parse(readFileSync(memFile, 'utf-8')) as MemoryEntry[];
        log.info(`Loaded ${this.entries.length} memory entries`);
      } catch {
        log.warn('Failed to load memories from disk, starting fresh');
        this.entries = [];
      }
    }
  }

  private loadSessionsFromDisk(): void {
    try {
      const files = readdirSync(this.sessionsDir).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        try {
          const raw = readFileSync(join(this.sessionsDir, f), 'utf-8');
          const session = JSON.parse(raw) as ConversationSession;
          this.sessions.set(session.id, session);
        } catch {
          log.warn(`Failed to load session file: ${f}`);
        }
      }
      if (files.length > 0) {
        log.info(`Loaded ${files.length} conversation sessions`);
      }
    } catch {
      // sessions dir may not exist yet
    }
  }

  private saveToDisk(): void {
    try {
      const memFile = join(this.dataDir, 'memories.json');
      writeFileSync(memFile, JSON.stringify(this.entries, null, 2));
    } catch (err) {
      log.warn('Failed to save memories to disk', { error: String(err) });
    }
  }

  private saveSessionToDisk(session: ConversationSession): void {
    try {
      const sessionFile = join(this.sessionsDir, `${session.id}.json`);
      writeFileSync(sessionFile, JSON.stringify(session, null, 2));
    } catch (err) {
      log.warn('Failed to save session to disk', { sessionId: session.id, error: String(err) });
    }
  }

  private debouncedSaveSession(session: ConversationSession): void {
    if (this.saveDebounce) clearTimeout(this.saveDebounce);
    this.saveDebounce = setTimeout(() => {
      this.saveSessionToDisk(session);
      this.saveDebounce = null;
    }, 1000);
  }
}
