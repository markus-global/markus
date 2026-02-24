import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(this.dataDir, { recursive: true });
    this.loadFromDisk();
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

  createSession(agentId: string): ConversationSession {
    const session: ConversationSession = {
      id: `sess_${Date.now()}`,
      agentId,
      messages: [],
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  appendMessage(sessionId: string, message: LLMMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.messages.push(message);
    session.lastActivityAt = new Date().toISOString();
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

  private saveToDisk(): void {
    const memFile = join(this.dataDir, 'memories.json');
    writeFileSync(memFile, JSON.stringify(this.entries, null, 2));
  }
}
