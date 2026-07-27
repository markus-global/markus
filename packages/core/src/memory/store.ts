/**
 * MemoryStore — the agent's file-system-based memory.
 *
 * Covers two of Tulving's three memory systems:
 * - Semantic Memory: unified MEMORY.md (curated sections + ## _observations buffer)
 * - Episodic Memory: conversation sessions (sessions/*.json)
 *
 * Additionally exports Notebook (NOTEBOOK.md) parse/serialize for the cognitive workspace.
 * Procedural Memory (ROLE.md + skills) is managed by RoleLoader and the skill system.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  createLogger,
  getTextContent,
  type LLMMessage,
  MEMORY_MD_SECTION_MAX_CHARS,
  MEMORY_MD_TOTAL_MAX_CHARS,
  SESSION_STORAGE_COMPACT_KEEP,
  SESSION_STORAGE_COMPACT_TRIGGER,
  SESSION_STORAGE_TOOL_SHRINK_CHARS,
} from '@markus/shared';
import type { IMemoryStore, MemoryEntry, ConversationSession } from './types.js';

export type { MemoryEntry, ConversationSession, IMemoryStore } from './types.js';

const log = createLogger('memory-store');

const VALID_TYPES = new Set<string>(['conversation', 'fact', 'task_result', 'note']);

/** Reject objects that are clearly not MemoryEntry-shaped. */
function isValidEntry(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return typeof obj.id === 'string' && obj.id.length > 0;
}

/** Coerce fields to their expected types so downstream code never sees undefined. */
function sanitizeEntry(raw: Record<string, unknown> | MemoryEntry): MemoryEntry {
  const r = raw as Record<string, unknown>;
  return {
    id: String(r.id),
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : new Date().toISOString(),
    type: (typeof r.type === 'string' && VALID_TYPES.has(r.type)
      ? r.type
      : 'note') as MemoryEntry['type'],
    content: typeof r.content === 'string' ? r.content : '',
    metadata: (typeof r.metadata === 'object' && r.metadata !== null)
      ? r.metadata as Record<string, unknown>
      : undefined,
  };
}

// ─── Notebook (NOTEBOOK.md) parse/serialize ─────────────────────────────────

export type NotebookEntryManaged = 'agent' | 'system' | 'cpp';

export interface NotebookEntry {
  text: string;
  updatedAt: number;
  managed: NotebookEntryManaged;
}

const NOTEBOOK_HEADING_RE = /^## (.+)$/;
const NOTEBOOK_UPDATED_RE = /^<!-- updated: (.+) -->$/;
const NOTEBOOK_MANAGED_RE = /^<!-- managed: (\w+) -->$/;

/**
 * Parse a NOTEBOOK.md file into a Map of keyed entries.
 * Format: ## key\n<!-- updated: ISO -->\n<!-- managed: type -->\ncontent...
 */
export function parseNotebook(markdown: string): Map<string, NotebookEntry> {
  const entries = new Map<string, NotebookEntry>();
  if (!markdown.trim()) return entries;

  const lines = markdown.split('\n');
  let currentKey: string | null = null;
  let currentUpdated = Date.now();
  let currentManaged: NotebookEntryManaged = 'agent';
  let contentLines: string[] = [];

  const flush = () => {
    if (currentKey !== null) {
      const text = contentLines.join('\n').trim();
      entries.set(currentKey, { text, updatedAt: currentUpdated, managed: currentManaged });
    }
  };

  for (const line of lines) {
    const headingMatch = NOTEBOOK_HEADING_RE.exec(line);
    if (headingMatch) {
      flush();
      currentKey = headingMatch[1].trim();
      currentUpdated = Date.now();
      currentManaged = 'agent';
      contentLines = [];
      continue;
    }

    if (currentKey !== null) {
      const updatedMatch = NOTEBOOK_UPDATED_RE.exec(line);
      if (updatedMatch) {
        const parsed = Date.parse(updatedMatch[1]);
        if (!isNaN(parsed)) currentUpdated = parsed;
        continue;
      }
      const managedMatch = NOTEBOOK_MANAGED_RE.exec(line);
      if (managedMatch) {
        const val = managedMatch[1] as NotebookEntryManaged;
        if (val === 'agent' || val === 'system' || val === 'cpp') currentManaged = val;
        continue;
      }
      contentLines.push(line);
    }
  }
  flush();
  return entries;
}

/**
 * Serialize a Map of notebook entries into NOTEBOOK.md format.
 */
export function serializeNotebook(entries: Map<string, NotebookEntry>): string {
  if (entries.size === 0) return '# Notebook\n';

  const sections: string[] = ['# Notebook', ''];
  for (const [key, entry] of entries) {
    sections.push(`## ${key}`);
    sections.push(`<!-- updated: ${new Date(entry.updatedAt).toISOString()} -->`);
    sections.push(`<!-- managed: ${entry.managed} -->`);
    sections.push(entry.text);
    sections.push('');
  }
  return sections.join('\n');
}

/**
 * Load NOTEBOOK.md from disk, returning parsed entries.
 * Returns empty map if file doesn't exist.
 */
export function loadNotebook(dataDir: string): Map<string, NotebookEntry> {
  const filePath = join(dataDir, 'NOTEBOOK.md');
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      return parseNotebook(content);
    }
  } catch (err) {
    log.warn('Failed to load NOTEBOOK.md', { error: String(err) });
  }
  return new Map();
}

/**
 * Save notebook entries to NOTEBOOK.md on disk.
 */
export function saveNotebook(dataDir: string, entries: Map<string, NotebookEntry>): void {
  const filePath = join(dataDir, 'NOTEBOOK.md');
  try {
    writeFileSync(filePath, serializeNotebook(entries), 'utf-8');
  } catch (err) {
    log.warn('Failed to save NOTEBOOK.md', { error: String(err) });
  }
}

// ─── MemoryStore ─────────────────────────────────────────────────────────────

export class MemoryStore implements IMemoryStore {
  private static readonly MAX_SESSIONS_IN_MEMORY = 20;

  private dataDir: string;
  private entries: MemoryEntry[] = [];
  private sessions = new Map<string, ConversationSession>();
  private sessionAccessOrder: string[] = [];
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
    this.entries.push(sanitizeEntry(entry));
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
    this.entries.push(sanitizeEntry(newEntry));
    this.saveToDisk();
  }

  removeEntriesByTag(tag: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => {
      const tags = Array.isArray(e.metadata?.tags) ? e.metadata!.tags as string[] : [];
      return !tags.includes(tag);
    });
    const removed = before - this.entries.length;
    if (removed > 0) this.saveToDisk();
    return removed;
  }

  getSession(sessionId: string): ConversationSession | undefined {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.tryLoadSessionFromDisk(sessionId);
      if (session) this.sessions.set(session.id, session);
    }
    if (session) this.touchSession(sessionId);
    return session;
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

  /** Get latest main session, excluding temporary A2A and channel sessions. */
  getLatestMainSession(agentId: string): ConversationSession | undefined {
    const agentSessions = this.listSessions(agentId)
      .filter(s => !s.id.startsWith('a2a_') && !s.id.startsWith('channel_'));
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
    this.touchSession(session.id);
    this.debouncedSaveSession(session);
    return session;
  }

  getOrCreateSession(agentId: string, sessionId: string): ConversationSession {
    let existing = this.sessions.get(sessionId);
    if (!existing) {
      existing = this.tryLoadSessionFromDisk(sessionId);
      if (existing) this.sessions.set(existing.id, existing);
    }
    if (existing) {
      this.touchSession(sessionId);
      return existing;
    }
    const session: ConversationSession = {
      id: sessionId,
      agentId,
      messages: [],
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, session);
    this.touchSession(sessionId);
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

  /**
   * Write/replace a curated MEMORY.md section.
   *
   * Returns a structured result so callers (the memory tools) can surface a refusal
   * to the model instead of the write silently no-op'ing (B1). `{ ok: true }` on success;
   * `{ ok: false, reason }` when the write is refused (over the total cap even after
   * compression) or errors.
   */
  addLongTermMemory(key: string, content: string): { ok: boolean; reason?: string } {
    let truncatedContent = content;
    if (truncatedContent.length > MEMORY_MD_SECTION_MAX_CHARS) {
      log.warn('Section content exceeds limit, truncating', {
        key, original: content.length, limit: MEMORY_MD_SECTION_MAX_CHARS,
      });
      truncatedContent = truncatedContent.slice(0, MEMORY_MD_SECTION_MAX_CHARS);
    }

    let existing = '';
    if (existsSync(this.longTermFile)) {
      existing = readFileSync(this.longTermFile, 'utf-8');
    }

    const sectionHeader = `## ${key}`;
    try {
      let updated: string;
      if (existing.includes(sectionHeader)) {
        const regex = new RegExp(`(## ${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\n[\\s\\S]*?(?=\\n## |$)`);
        updated = existing.replace(regex, `${sectionHeader}\n${truncatedContent}\n`);
      } else {
        updated = existing + `\n${sectionHeader}\n${truncatedContent}\n`;
      }

      if (updated.length > MEMORY_MD_TOTAL_MAX_CHARS) {
        // Attempt auto-compression first before refusing the write
        log.warn('MEMORY.md total size exceeds limit, attempting compression', {
          key, fileSize: updated.length, limit: MEMORY_MD_TOTAL_MAX_CHARS,
        });
        const compressed = this.compressLongTermMemory();
        if (compressed.charsAfter < updated.length) {
          log.info('Compression freed space, retrying write', {
            key, charsFreed: updated.length - compressed.charsAfter,
          });
          // Re-read the freshly compressed file and retry
          existing = readFileSync(this.longTermFile, "utf-8");
          if (existing.includes(sectionHeader)) {
            const regex = new RegExp(`(## ${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\n[\\s\\S]*?(?=\\n## |$)`);
            updated = existing.replace(regex, `${sectionHeader}\n${truncatedContent}\n`);
          } else {
            updated = existing + `\n${sectionHeader}\n${truncatedContent}\n`;
          }
          if (updated.length > MEMORY_MD_TOTAL_MAX_CHARS) {
            log.warn('MEMORY.md still exceeds limit even after compression, refusing write', {
              key, fileSize: updated.length, limit: MEMORY_MD_TOTAL_MAX_CHARS,
            });
            return { ok: false, reason: `MEMORY.md is full (> ${MEMORY_MD_TOTAL_MAX_CHARS} chars) even after compression; write refused. Prune or shorten sections, or use memory_save (## _observations) instead.` };
          }
        } else {
          log.warn('MEMORY.md still exceeds limit after compression, refusing write', {
            key, fileSize: updated.length, limit: MEMORY_MD_TOTAL_MAX_CHARS,
          });
          return { ok: false, reason: `MEMORY.md is full (> ${MEMORY_MD_TOTAL_MAX_CHARS} chars) and could not be compressed further; write refused. Prune or shorten sections, or use memory_save (## _observations) instead.` };
        }
      }

      writeFileSync(this.longTermFile, updated);
      log.debug('Long-term memory updated', { key, sectionChars: truncatedContent.length, totalChars: updated.length });
      return { ok: true };
    } catch (err) {
      log.warn('Failed to write long-term memory', { key, error: String(err) });
      return { ok: false, reason: `Failed to write MEMORY.md: ${String(err)}` };
    }
  }

  getLongTermMemory(): string {
    if (!existsSync(this.longTermFile)) return '';
    const content = readFileSync(this.longTermFile, 'utf-8');
    // Return only curated sections (above ## _observations)
    const obsIdx = content.indexOf('\n## _observations');
    return obsIdx >= 0 ? content.slice(0, obsIdx).trimEnd() : content;
  }

  /** Get the raw ## _observations section content for dream cycle / search. */
  getObservations(): MemoryEntry[] {
    return [...this.entries];
  }

  getLongTermMemoryExcluding(sections: string[]): string {
    const full = this.getLongTermMemory();
    if (!full || sections.length === 0) return full;

    let result = full;
    for (const section of sections) {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(
        new RegExp(`\\n?## ${escaped}\\n[\\s\\S]*?(?=\\n## |$)`), ''
      );
    }
    return result.trim();
  }

  getLongTermSection(sectionName: string): string {
    const content = this.getLongTermMemory();
    if (!content) return '';
    const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = content.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
    return match?.[1]?.trim() ?? '';
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

    // No writeDailyLog here — compaction must be side-effect-free

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
    // Keep full transcripts by default. Per-request packing uses the model
    // window — we do not drop turns early to "save tokens".
    // 1) Shrink only pathological old tool blobs.
    // 2) Permanent summarize+truncate only at a very high message count (safety).
    let shrunk = 0;
    const keepRecentForShrink = Math.min(SESSION_STORAGE_COMPACT_KEEP, session.messages.length);
    const recentBoundary = Math.max(0, session.messages.length - keepRecentForShrink);
    for (let i = 0; i < recentBoundary; i++) {
      const m = session.messages[i]!;
      const text = getTextContent(m.content);
      if (m.role === 'tool' && text.length > SESSION_STORAGE_TOOL_SHRINK_CHARS) {
        const origLen = text.length;
        const headSize = Math.min(4_000, Math.floor(origLen * 0.3));
        const tailSize = Math.min(1_500, Math.floor(origLen * 0.1));
        const head = text.slice(0, headSize);
        const tail = text.slice(-tailSize);
        m.content = `[Tool result compacted: ${origLen} chars → ${headSize + tailSize} char preview]\n${head}\n[... ${origLen - headSize - tailSize} chars omitted ...]\n${tail}`;
        shrunk++;
      }
    }
    if (shrunk > 0) {
      log.info('Shrunk oversized tool results in session storage', {
        sessionId: session.id, messageCount: session.messages.length, shrunkToolResults: shrunk,
      });
    }

    if (session.messages.length <= SESSION_STORAGE_COMPACT_TRIGGER) return;

    log.info('Auto-compacting session by safety count threshold', {
      sessionId: session.id,
      messageCount: session.messages.length,
      keepLast: SESSION_STORAGE_COMPACT_KEEP,
      trigger: SESSION_STORAGE_COMPACT_TRIGGER,
    });
    this.compactSession(session.id, SESSION_STORAGE_COMPACT_KEEP);
  }

  private static readonly MAX_MEMORY_ENTRIES = 500;

  private loadFromDisk(): void {
    // Migration: if memories.json exists, convert to ## _observations in MEMORY.md
    const memFile = join(this.dataDir, 'memories.json');
    if (existsSync(memFile)) {
      try {
        const raw = JSON.parse(readFileSync(memFile, 'utf-8')) as unknown[];
        let entries = raw.filter(isValidEntry).map(sanitizeEntry);
        if (entries.length > MemoryStore.MAX_MEMORY_ENTRIES) {
          entries = entries.slice(-MemoryStore.MAX_MEMORY_ENTRIES);
        }
        this.entries = entries;
        // Migrate: write observations into MEMORY.md and remove memories.json
        this.saveToDisk();
        try {
          unlinkSync(memFile);
          log.info(`Migrated ${entries.length} entries from memories.json to MEMORY.md ## _observations`);
        } catch { /* best effort deletion */ }
        return;
      } catch {
        log.warn('Failed to migrate memories.json, starting fresh');
      }
    }

    // Load observations from ## _observations section of MEMORY.md
    this.entries = this.parseObservationsFromMemoryMd();
    if (this.entries.length > 0) {
      log.info(`Loaded ${this.entries.length} observation entries from MEMORY.md`);
    }
  }

  /** Parse the ## _observations section of MEMORY.md into MemoryEntry[] */
  private parseObservationsFromMemoryMd(): MemoryEntry[] {
    if (!existsSync(this.longTermFile)) return [];
    try {
      const content = readFileSync(this.longTermFile, 'utf-8');
      const obsMatch = content.match(/(?:^|\n)## _observations\n([\s\S]*)$/);
      if (!obsMatch) return [];
      const obsContent = obsMatch[1];
      const entries: MemoryEntry[] = [];
      const subsections = obsContent.split(/\n### /).filter(s => s.trim());
      for (const section of subsections) {
        const lines = section.split('\n');
        const headerLine = lines[0] ?? '';
        if (headerLine.startsWith('<!--')) continue;
        const idMatch = headerLine.match(/^(\S+)/);
        if (!idMatch) continue;
        const id = idMatch[1];
        // Parse metadata from HTML comments
        let type: MemoryEntry['type'] = 'note';
        let tags: string[] = [];
        const contentLines: string[] = [];
        for (let i = 1; i < lines.length; i++) {
          const metaMatch = lines[i].match(/^<!-- type: (\w+)(?:, tags: (.+))? -->$/);
          if (metaMatch) {
            const typeVal = metaMatch[1];
            if (typeVal && VALID_TYPES.has(typeVal)) type = typeVal as MemoryEntry['type'];
            if (metaMatch[2]) tags = metaMatch[2].split(',').map(t => t.trim());
            continue;
          }
          contentLines.push(lines[i]);
        }
        const idTs = id.match(/^obs_(\d+)/);
        const timestamp = idTs ? new Date(parseInt(idTs[1])).toISOString() : new Date().toISOString();
        entries.push({
          id,
          timestamp,
          type,
          content: contentLines.join('\n').trim(),
          metadata: tags.length > 0 ? { tags } : undefined,
        });
      }
      return entries;
    } catch (err) {
      log.warn('Failed to parse observations from MEMORY.md', { error: String(err) });
      return [];
    }
  }

  private loadSessionsFromDisk(): void {
    try {
      const files = readdirSync(this.sessionsDir).filter((f) => f.endsWith('.json'));
      if (files.length === 0) return;

      // Sort by mtime descending, only load the N most recent into memory
      const withMtime = files.map(f => {
        try {
          const stat = statSync(join(this.sessionsDir, f));
          return { f, mtime: stat.mtimeMs };
        } catch (err) {
          log.debug('Failed to stat session file', { file: f, error: String(err) });
          return { f, mtime: 0 };
        }
      });
      withMtime.sort((a, b) => b.mtime - a.mtime);
      const toLoad = withMtime.slice(0, MemoryStore.MAX_SESSIONS_IN_MEMORY);

      for (const { f } of toLoad) {
        try {
          const raw = readFileSync(join(this.sessionsDir, f), 'utf-8');
          const session = JSON.parse(raw) as ConversationSession;
          this.sessions.set(session.id, session);
          this.sessionAccessOrder.push(session.id);
        } catch {
          log.warn(`Failed to load session file: ${f}`);
        }
      }
      log.info(`Loaded ${this.sessions.size} of ${files.length} conversation sessions (max ${MemoryStore.MAX_SESSIONS_IN_MEMORY} in memory)`);
    } catch (err) {
      log.debug('Sessions directory not accessible', { dir: this.sessionsDir, error: String(err) });
    }
  }

  private tryLoadSessionFromDisk(sessionId: string): ConversationSession | undefined {
    try {
      const sessionFile = join(this.sessionsDir, `${sessionId}.json`);
      if (!existsSync(sessionFile)) return undefined;
      const raw = readFileSync(sessionFile, 'utf-8');
      return JSON.parse(raw) as ConversationSession;
    } catch (err) {
      log.debug('Failed to load session from disk', { error: String(err) });
      return undefined;
    }
  }

  private touchSession(sessionId: string): void {
    const idx = this.sessionAccessOrder.indexOf(sessionId);
    if (idx !== -1) this.sessionAccessOrder.splice(idx, 1);
    this.sessionAccessOrder.push(sessionId);
    this.evictOldSessions();
  }

  private evictOldSessions(): void {
    while (this.sessions.size > MemoryStore.MAX_SESSIONS_IN_MEMORY && this.sessionAccessOrder.length > 0) {
      const oldest = this.sessionAccessOrder.shift()!;
      const session = this.sessions.get(oldest);
      if (session) {
        this.saveSessionToDisk(session);
        this.sessions.delete(oldest);
      }
    }
  }

  private saveToDisk(): void {
    try {
      // Serialize observations as ## _observations subsections within MEMORY.md
      const obsLines: string[] = [
        '## _observations',
        '<!-- This section is the observation buffer. Searched on-demand, NOT always injected into prompt. -->',
        '<!-- Dream cycle consolidates recurring patterns into curated sections above. -->',
        '',
      ];
      const entries = this.entries.slice(-MemoryStore.MAX_MEMORY_ENTRIES);
      for (const entry of entries) {
        const tags = Array.isArray(entry.metadata?.tags)
          ? (entry.metadata!.tags as string[]).join(', ')
          : '';
        obsLines.push(`### ${entry.id}`);
        obsLines.push(`<!-- type: ${entry.type}${tags ? `, tags: ${tags}` : ''} -->`);
        obsLines.push(entry.content);
        obsLines.push('');
      }
      const obsSection = obsLines.join('\n');

      // Read existing MEMORY.md, replace or append ## _observations
      let existing = '';
      if (existsSync(this.longTermFile)) {
        existing = readFileSync(this.longTermFile, 'utf-8');
      }
      let obsStart = existing.indexOf('\n## _observations');
      if (obsStart < 0 && existing.startsWith('## _observations')) obsStart = 0;
      let updated: string;
      if (obsStart > 0) {
        updated = existing.slice(0, obsStart) + '\n' + obsSection;
      } else if (obsStart === 0) {
        updated = obsSection;
      } else {
        updated = (existing ? existing.trimEnd() + '\n\n' : '') + obsSection;
      }
      writeFileSync(this.longTermFile, updated);
    } catch (err) {
      log.warn('Failed to save observations to MEMORY.md', { error: String(err) });
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

  /** Compress MEMORY.md — truncate oversized sections to prevent context bloat */
  compressLongTermMemory(): { charsBefore: number; charsAfter: number; sectionsBefore: number; sectionsAfter: number; truncatedChunks: number } {
    if (!existsSync(this.longTermFile)) {
      return { charsBefore: 0, charsAfter: 0, sectionsBefore: 0, sectionsAfter: 0, truncatedChunks: 0 };
    }

    const content = readFileSync(this.longTermFile, 'utf-8');
    const charsBefore = content.length;
    const lines = content.split('\n');

    // Phase 1: walk lines to identify preamble + section layout
    let i = 0;
    const preambleLines: string[] = [];
    while (i < lines.length && !lines[i].startsWith('## ')) {
      preambleLines.push(lines[i]);
      i++;
    }

    // Sections as [headerLine, ...bodyLines]
    const sections: { headerLine: string; body: string[] }[] = [];
    let currentHeader = '';
    let currentBody: string[] = [];

    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('## ')) {
        if (currentHeader) {
          sections.push({ headerLine: currentHeader, body: currentBody });
        }
        currentHeader = line;
        currentBody = [];
      } else {
        currentBody.push(line);
      }
      i++;
    }
    // Push last section
    if (currentHeader) {
      sections.push({ headerLine: currentHeader, body: currentBody });
    }

    const sectionsBefore = sections.length;
    let truncatedChunks = 0;
    const outputLines: string[] = [...preambleLines];

    for (const section of sections) {
      const bodyStr = section.body.join('\n');
      if (bodyStr.length > MEMORY_MD_SECTION_MAX_CHARS) {
        const truncatedBody = bodyStr.slice(0, MEMORY_MD_SECTION_MAX_CHARS);
        outputLines.push(section.headerLine, truncatedBody);
        truncatedChunks++;
      } else {
        outputLines.push(section.headerLine, bodyStr);
      }
    }

    const compressed = outputLines.join('\n');
    writeFileSync(this.longTermFile, compressed);

    return {
      charsBefore,
      charsAfter: compressed.length,
      sectionsBefore,
      sectionsAfter: sections.length,
      truncatedChunks,
    };
  }
}
