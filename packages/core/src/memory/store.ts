import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMMessage } from '@markus/shared';
import { createLogger } from '@markus/shared';

const log = createLogger('memory-store');

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

export class MemoryStore {
  private dataDir: string;
  private entries: MemoryEntry[] = [];
  private sessions = new Map<string, ConversationSession>();
  private sessionsDir: string;
  private saveDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.sessionsDir = join(dataDir, 'sessions');
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });
    this.loadFromDisk();
    this.loadSessionsFromDisk();
  }

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

  search(query: string): MemoryEntry[] {
    const lower = query.toLowerCase();
    return this.entries.filter((e) => e.content.toLowerCase().includes(lower));
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

  appendMessage(sessionId: string, message: LLMMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.messages.push(message);
    session.lastActivityAt = new Date().toISOString();
    this.debouncedSaveSession(session);
  }

  getRecentMessages(sessionId: string, limit: number): LLMMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.messages.slice(-limit);
  }

  summarizeAndTruncate(sessionId: string, keepLast: number): LLMMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    if (session.messages.length <= keepLast) return session.messages;

    const older = session.messages.slice(0, -keepLast);
    const summary = older
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n')
      .slice(0, 500);

    this.addEntry({
      id: `mem_${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: 'conversation',
      content: summary,
      metadata: { sessionId },
    });

    session.messages = session.messages.slice(-keepLast);
    this.saveSessionToDisk(session);
    return session.messages;
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
    const memFile = join(this.dataDir, 'memories.json');
    writeFileSync(memFile, JSON.stringify(this.entries, null, 2));
  }

  private saveSessionToDisk(session: ConversationSession): void {
    const sessionFile = join(this.sessionsDir, `${session.id}.json`);
    writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  }

  private debouncedSaveSession(session: ConversationSession): void {
    if (this.saveDebounce) clearTimeout(this.saveDebounce);
    this.saveDebounce = setTimeout(() => {
      this.saveSessionToDisk(session);
      this.saveDebounce = null;
    }, 1000);
  }
}
