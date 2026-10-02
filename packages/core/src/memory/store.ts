/**
 * MemoryStore — the agent's file-system-based memory.
 *
 * Covers two of Tulving's three memory systems:
 * - Semantic Memory: knowledge.md SSOT (curated sections + ## _observations buffer)
 * - Episodic Memory: conversation sessions (sessions/*.json)
 *
 * Additionally exports Notebook (NOTEBOOK.md) parse/serialize for the cognitive workspace.
 * Procedural Memory (ROLE.md + skills) is managed by RoleLoader and the skill system.
 *
 * ─── Migration-read layer（审计 P-08：**读旧、只写新**）────────────────────
 * 记忆读写遵循单一策略：**读取端容忍一切历史格式，写入端只发一种规范格式**。
 * 遗留数据不删除，而是在加载时被**读入并迁移**为规范形态（无损、可检索）：
 *   来源（读）                               → 归宿（写，唯一规范）
 *   1. `memories.json`                       → knowledge.md `## _observations`，源消费
 *   2. `MEMORY.md`                           → knowledge.md（源保留；仅当 knowledge 不存在时并入）
 *   3. `state.md`（已退场介质）              → knowledge.md `## _observations`，源改名 `.migrated`
 *   4. 旧 `<!-- type: x, tags: a, b -->` 行  → 加载时收敛为单 `data-meta` JSON 行
 * 不变量：任一次落盘后，knowledge.md 内不再残留旧格式（`, tags: ` 行）。读取端的
 * 容忍只为让旧数据**能进来**，不是长期形态。清退条件：线上所有 agent 目录均无上述
 * 遗留文件、且 knowledge.md 无 `, tags: ` 行（实测 2026-09-29 仍有多名 agent 残留，故暂不满足）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  createLogger,
  getTextContent,
  tokenizeSearchQuery,
  scoreKeywordHaystack,
  type LLMMessage,
  MEMORY_MD_SECTION_MAX_CHARS,
  MEMORY_MD_TOTAL_MAX_CHARS,
  MEMORY_OBSERVATIONS_MAX_CHARS,
  MEMORY_ENTRY_MAX_CHARS,
  KNOWLEDGE_MD_SELF_HEAL_BYTES,
  KNOWLEDGE_SECTION_KEY_MAX_CHARS,
  NOTEBOOK_KEY_MAX_CHARS,
  NOTEBOOK_MAX_ENTRIES,
  NOTEBOOK_MAX_AGENT_ENTRIES,
  NOTEBOOK_TTL_MS_AGENT,
  NOTEBOOK_TTL_MS_SYSTEM,
  SESSION_STORAGE_COMPACT_KEEP,
  SESSION_STORAGE_COMPACT_TRIGGER,
  CONTEXT_SLOT_MAX_CHARS,
} from '@markus/shared';
import type { IMemoryStore, MemoryEntry, ConversationSession, CompactResult } from './types.js';
import { ensureKnowledgeFile, knowledgePath, retiredStatePath } from './taxonomy.js';
import { writeFileAtomic } from '../atomic-write.js';
import { buildSlotSegment, buildSummarySegment, sanitizeSlotKey, type SlotEntry } from '../context-slot.js';

export type { MemoryEntry, ConversationSession, IMemoryStore } from './types.js';

const log = createLogger('memory-store');

const VALID_TYPES = new Set<string>(['conversation', 'fact', 'task_result', 'note', 'insight', 'conversation_fragment']);

/** Prevent section bodies from introducing sibling ## headings that split the store. */
export function sanitizeSectionBody(content: string): string {
  return content.replace(/^## /gm, '### ');
}

/**
 * Normalize a curated knowledge.md SECTION KEY.
 *
 * Section keys are headings of a durable knowledge base, not free text. Real
 * knowledge.md accumulated headings copied verbatim from scratch notes
 * (`## ✅ 修复完成：摘要锚点进固定段（3a745f00）`, `## 但这不必然阻塞`) — which both reads
 * as junk and made one topic exist twice (once as a notebook key, once as a
 * knowledge section). Reject line breaks and over-long keys outright; keep CJK
 * and `-_` so existing legitimate Chinese section names keep working.
 *
 * Returns `null` when the key is unusable (caller refuses the write and says why).
 */
export function normalizeSectionKey(raw: string): string | null {
  const flat = String(raw ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!flat) return null;
  // `## ` inside a key would split the section in two on the next parse.
  if (flat.includes('##')) return null;
  if (flat.length > KNOWLEDGE_SECTION_KEY_MAX_CHARS) return null;
  return flat;
}

/** Reject objects that are clearly not MemoryEntry-shaped. */
function isValidEntry(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return typeof obj.id === 'string' && obj.id.length > 0;
}

/** Coerce fields to their expected types so downstream code never sees undefined. */
function sanitizeEntry(raw: Record<string, unknown> | MemoryEntry): MemoryEntry {
  const r = raw as Record<string, unknown>;
  let content = typeof r.content === 'string' ? r.content : '';
  // Hard per-entry cap: a single runaway observation must never balloon the
  // shared knowledge.md file (observed: one merged obs hit 50MB, dragging
  // every subsequent getLongTermMemory() read + Tier2 prefix with it).
  if (content.length > MEMORY_ENTRY_MAX_CHARS) {
    content = content.slice(0, MEMORY_ENTRY_MAX_CHARS) +
      `\n[... truncated from ${content.length} chars]`;
  }
  return {
    id: String(r.id),
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : new Date().toISOString(),
    type: (typeof r.type === 'string' && VALID_TYPES.has(r.type)
      ? r.type
      : 'note') as MemoryEntry['type'],
    content,
    metadata: (typeof r.metadata === 'object' && r.metadata !== null)
      ? r.metadata as Record<string, unknown>
      : undefined,
  };
}

/** Best-effort JSON stringify for embedding in an HTML comment (never throws). */
function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s : '';
  } catch {
    return '';
  }
}

/** Parse a data-meta JSON payload embedded in an HTML comment (never throws). */
function parseDataMeta(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

// ─── Notebook (NOTEBOOK.md) parse/serialize ─────────────────────────────────

export type NotebookEntryManaged = 'agent' | 'system';

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
        if (val === 'agent' || val === 'system') currentManaged = val;
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
 * Normalize a notebook KEY into a label.
 *
 * Keys are labels, not sentences. Real notebooks accumulated headings like
 * `## ✅ 修复完成：摘要锚点进固定段（3a745f00）` and `## 但这不必然阻塞`, which
 * (a) read as document sections rather than slots, and (b) let one topic spawn
 * many near-duplicate entries instead of overwriting one — the main driver of
 * the 23-agent-entry bloat. Normalization is deliberately lossless for CJK:
 * only line breaks, leading `#`, and length are enforced.
 */
export function normalizeNotebookKey(raw: string): string {
  const flattened = String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Strip heading markers AFTER trimming — a leading space would otherwise
    // leave the `#` in place (`' ## x'` does not match `/^#+/`).
    .replace(/^#+\s*/, '')
    .trim();
  if (flattened.length <= NOTEBOOK_KEY_MAX_CHARS) return flattened;
  return flattened.slice(0, NOTEBOOK_KEY_MAX_CHARS).trimEnd();
}

/** Per-tier TTL lookup for a notebook entry. */
export function notebookTtlMs(managed: NotebookEntryManaged): number {
  if (managed === 'system') return NOTEBOOK_TTL_MS_SYSTEM;
  return NOTEBOOK_TTL_MS_AGENT;
}

export interface NotebookPruneResult {
  /** Keys dropped because they exceeded their tier TTL. */
  expired: string[];
  /** Keys dropped to satisfy the hard entry cap. */
  evicted: string[];
}

/**
 * Enforce the notebook invariants IN PLACE: per-tier TTL, then the hard total
 * entry cap (and the tighter agent-tier cap).
 *
 * This is the single authority for "notebook state is legal". It must be applied
 * after load, after every write, and before prompt injection — the historical bug
 * was that the cap lived on ONE write path (`updateWorkingMemory`) while three
 * other writers called `workingMemory.set()` directly, and the load path trimmed
 * nothing, so a notebook could only ever grow.
 *
 * Eviction order is oldest-`updatedAt`-first within a tier, and the machine-written
 * `system` tier is evicted BEFORE the agent tier: machine situational state is
 * cheaper to lose than the agent's own deliberate notes, and it expires on its own
 * soon anyway.
 */
export function pruneNotebookEntries(
  entries: Map<string, NotebookEntry>,
  now: number = Date.now(),
): NotebookPruneResult {
  const result: NotebookPruneResult = { expired: [], evicted: [] };

  // ── Pass 1: TTL ────────────────────────────────────────────────────────
  for (const [key, entry] of [...entries]) {
    const age = now - (entry.updatedAt ?? 0);
    if (age > notebookTtlMs(entry.managed)) {
      entries.delete(key);
      result.expired.push(key);
    }
  }

  // ── Pass 2: per-tier agent cap ─────────────────────────────────────────
  const evictOldest = (predicate: (e: NotebookEntry) => boolean, keep: number): void => {
    const candidates = [...entries.entries()]
      .filter(([, e]) => predicate(e))
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (let i = 0; i < candidates.length - keep; i++) {
      const key = candidates[i]![0];
      entries.delete(key);
      result.evicted.push(key);
    }
  };
  evictOldest(e => e.managed === 'agent', NOTEBOOK_MAX_AGENT_ENTRIES);

  // ── Pass 3: hard total cap ─────────────────────────────────────────────
  // Evict oldest-first, and among comparable ages drop the LOWER-durability tier
  // first: system → agent. Machine-written situational state is cheaper to
  // lose than the agent's own deliberate notes (and it would expire on its own
  // soon anyway). Getting this order backwards silently ate the agent's own notes
  // whenever the machine tiers filled the budget.
  if (entries.size > NOTEBOOK_MAX_ENTRIES) {
    const evictionRank = (e: NotebookEntry) => (e.managed === 'system' ? 0 : 1);
    const evictable = [...entries.entries()].sort((a, b) => {
      const ra = evictionRank(a[1]); const rb = evictionRank(b[1]);
      if (ra !== rb) return ra - rb;
      return a[1].updatedAt - b[1].updatedAt;
    });
    for (let i = 0; i < evictable.length - NOTEBOOK_MAX_ENTRIES; i++) {
      const key = evictable[i]![0];
      entries.delete(key);
      result.evicted.push(key);
    }
  }

  return result;
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
    writeFileAtomic(filePath, serializeNotebook(entries));
  } catch (err) {
    log.warn('Failed to save NOTEBOOK.md', { error: String(err) });
  }
}

// ─── MemoryStore ─────────────────────────────────────────────────────────────

export class MemoryStore implements IMemoryStore {
  private static readonly MAX_SESSIONS_IN_MEMORY = 20;
  /** 审计 P-09：summary 是**追加式多代锚点**，最多保留这么多代（旧锚仍在归档 fragment 中）。 */
  private static readonly MAX_SUMMARY_ANCHORS = 6;

  private dataDir: string;
  private entries: MemoryEntry[] = [];
  private sessions = new Map<string, ConversationSession>();
  private sessionAccessOrder: string[] = [];
  private sessionsDir: string;
  private logsDir: string;
  private saveDebounce: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private longTermFile: string;
  private longTermArchiveFile: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.sessionsDir = join(dataDir, 'sessions');
    this.logsDir = join(dataDir, 'daily-logs');
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    ensureKnowledgeFile(dataDir);
    // SSOT: always knowledge.md after ensure (never write legacy MEMORY.md).
    this.longTermFile = knowledgePath(dataDir);
    this.longTermArchiveFile = join(dataDir, 'knowledge-archive.md');
    this.loadFromDisk();
    this.loadSessionsFromDisk();
  }

  getStoreFileName(): string {
    return basename(this.longTermFile);
  }

  /** 归档文件名：超预算段落正文的**无损**去处（可被 memory_search 检索，不注入）。 */
  getArchiveFileName(): string {
    return basename(this.longTermArchiveFile);
  }

  /**
   * 记忆预算健康度（审计 P-12）：驱动提示词内的健康信号，让 Agent 知道何时该整理。
   */
  getMemoryHealth(): { totalChars: number; cap: number; percent: number; observations: number; curatedSections: number; archiveChars: number; lastConsolidatedAt: string | null } {
    let totalChars = 0;
    try {
      if (existsSync(this.longTermFile)) totalChars = readFileSync(this.longTermFile, 'utf-8').length;
    } catch { /* unreadable — treat as 0 */ }
    let archiveChars = 0;
    try {
      if (existsSync(this.longTermArchiveFile)) archiveChars = readFileSync(this.longTermArchiveFile, 'utf-8').length;
    } catch { /* archive optional */ }
    const cap = MEMORY_MD_TOTAL_MAX_CHARS;
    return {
      totalChars,
      cap,
      percent: cap > 0 ? Math.round((totalChars / cap) * 100) : 0,
      observations: this.entries.length,
      curatedSections: parseCuratedSections(this.getLongTermMemory()).length,
      archiveChars,
      lastConsolidatedAt: this.getLastConsolidatedAt(),
    };
  }

  /** 审计 P-11：上次整理（dream / memory_organize）时间 —— 供 memory_stats 与前端可观测。 */
  getLastConsolidatedAt(): string | null {
    try {
      const f = join(this.dataDir, 'memory-meta.json');
      if (!existsSync(f)) return null;
      const meta = JSON.parse(readFileSync(f, 'utf-8')) as { lastConsolidatedAt?: string };
      return meta.lastConsolidatedAt ?? null;
    } catch {
      return null;
    }
  }

  /** 记录一次整理发生（用于陈旧度信号）。 */
  markConsolidated(at: Date = new Date()): void {
    try {
      const f = join(this.dataDir, 'memory-meta.json');
      let meta: Record<string, unknown> = {};
      if (existsSync(f)) {
        try { meta = JSON.parse(readFileSync(f, 'utf-8')) as Record<string, unknown>; } catch { meta = {}; }
      }
      meta['lastConsolidatedAt'] = at.toISOString();
      writeFileAtomic(f, JSON.stringify(meta, null, 2));
    } catch (err) {
      log.warn('Failed to persist memory meta', { error: String(err) });
    }
  }

  /**
   * Losslessly move a curated section body into `knowledge-archive.md`
   * (审计 P-04/P-05：绝不静默丢弃 / 截断)。
   * 主文件保留标题 + 指针，主题仍可发现；正文原文进归档，仍可检索。
   */
  private archiveSection(name: string, body: string): number {
    const trimmed = body.trim();
    if (!trimmed) return 0;
    try {
      const head = '# Knowledge Archive\n\n'
        + '<!-- 超预算段落正文的无损归档（由记忆服务维护，可被 memory_search 检索）。 -->\n\n';
      const existing = existsSync(this.longTermArchiveFile)
        ? readFileSync(this.longTermArchiveFile, 'utf-8')
        : head;
      if (!existing.includes(trimmed)) {
        appendFileSync(this.longTermArchiveFile, `## ${name}\n${trimmed}\n\n`);
      }
    } catch (err) {
      log.warn('Failed to archive section body', { name, error: String(err) });
    }
    return trimmed.length;
  }

  /**
   * NOTE (2026-09-16): `getStateMemory()` / `pruneStateMemory()` were removed together
   * with the state.md store. Situational state is Working-layer data and lives in
   * NOTEBOOK.md (`notebook_upsert`), which already has per-tier TTL — a second
   * short-lived store added no capability, only a second place to look.
   * See docs/MEMORY-SYSTEM.md §10.2 (option A).
   */

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
    const tokens = tokenizeSearchQuery(query);
    if (tokens.length === 0) return [];

    const fullLower = query.trim().toLowerCase();
    const scored: Array<{ entry: MemoryEntry; score: number }> = [];

    for (const e of this.entries) {
      const score = scoreKeywordHaystack(
        `${e.content}\n${formatTags(e.metadata)}`,
        tokens,
        fullLower,
      );
      if (score > 0) scored.push({ entry: e, score });
    }

    // Curated knowledge.md sections (tool claims to search these; observations alone are incomplete)
    const curated = this.getLongTermMemory();
    for (const section of parseCuratedSections(curated)) {
      const body = `## ${section.name}\n${section.body}`;
      const score = scoreKeywordHaystack(body, tokens, fullLower);
      if (score <= 0) continue;
      scored.push({
        entry: {
          id: `curated_${slugSectionId(section.name)}`,
          timestamp: '',
          type: 'fact',
          content: body.length > 2500 ? `${body.slice(0, 2500)}\n…` : body,
          metadata: { source: 'curated', section: section.name, store: 'knowledge.md' },
        },
        // Slight boost so durable curated knowledge ranks above raw observations at equal hit count
        score: score + 0.25,
      });
    }

    // 归档段落（无损去处）：memory_search 必须能找回被归档的内容（审计 P-04/P-05）。
    try {
      if (existsSync(this.longTermArchiveFile)) {
        const archivedText = readFileSync(this.longTermArchiveFile, 'utf-8');
        for (const section of parseCuratedSections(archivedText)) {
          const body = `## ${section.name}\n${section.body}`;
          const score = scoreKeywordHaystack(body, tokens, fullLower);
          if (score <= 0) continue;
          scored.push({
            entry: {
              id: `archived_${slugSectionId(section.name)}`,
              timestamp: '',
              type: 'fact',
              content: body.length > 2500 ? `${body.slice(0, 2500)}…` : body,
              metadata: { source: 'archive', section: section.name, store: this.getArchiveFileName() },
            },
            score: score + 0.1,
          });
        }
      }
    } catch { /* archive missing/unreadable — non-fatal */ }

    scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    return scored.map((s) => s.entry);
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

  /**
   * Count session files persisted on disk. Cheap (a single readdir) and used to
   * report an honest `total` — the in-memory cap (MAX_SESSIONS_IN_MEMORY)
   * otherwise makes `session list` look like older conversations vanished.
   */
  countSessionsOnDisk(): number {
    try {
      return readdirSync(this.sessionsDir).filter((f) => f.endsWith('.json')).length;
    } catch {
      return this.sessions.size;
    }
  }

  getLatestSession(agentId: string): ConversationSession | undefined {
    const agentSessions = this.listSessions(agentId);
    if (agentSessions.length === 0) return undefined;
    return agentSessions.sort((a, b) =>
      new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
    )[0];
  }

  /**
   * Get latest main session, excluding temporary A2A / channel / heartbeat sessions.
   *
   * `hb_` 也必须排除：心跳会话每次巡检都会被写一次（按天滚动后更是如此），
   * 容易成为「最近活跃」的那一个，从而在重启时被当成 agent 的主会话恢复
   * （见 agent.ts 启动路径的 getLatestMainSession 调用）。巡检会话不是主对话。
   */
  getLatestMainSession(agentId: string): ConversationSession | undefined {
    const agentSessions = this.listSessions(agentId)
      .filter(s => !s.id.startsWith('a2a_') && !s.id.startsWith('channel_') && !s.id.startsWith('hb_'));
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

  /** Rename a memory session (titles surface in session_list and agent tooling). */
  renameSession(sessionId: string, title: string): void {
    let session = this.sessions.get(sessionId);
    if (!session) session = this.tryLoadSessionFromDisk(sessionId);
    if (!session) return;
    session.title = String(title ?? '').trim().slice(0, 120);
    if (!session.title) delete session.title;
    this.saveSessionToDisk(session);
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

  /**
   * Recent messages for a session.
   *
   * Two deliberate properties (both regressions from the old silent version):
   *  1. A session that is merely NOT RESIDENT (evicted from the in-memory LRU,
   *     or never preloaded after a restart) is lazily loaded from disk — the
   *     same lookup `getSession()` performs. Returning [] for it made valid
   *     conversations look empty after a restart or a busy day.
   *  2. A genuinely unknown id now WARNS instead of returning [] silently: an
   *     unknown/empty session id used to be indistinguishable from "this
   *     conversation has no history yet", which is exactly what let a session
   *     identity bug masquerade as an empty conversation.
   */
  getRecentMessages(sessionId: string, limit: number): LLMMessage[] {
    if (!sessionId) {
      log.warn('getRecentMessages called without a session id — returning empty history');
      return [];
    }
    const session = this.sessions.get(sessionId) ?? this.getSession(sessionId);
    if (!session) {
      log.warn('getRecentMessages: unknown session id — returning empty history', { sessionId });
      return [];
    }
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

  // --- Long-term: knowledge.md ---

  /**
   * Write/replace a curated knowledge.md section.
   *
   * Returns a structured result so callers (the memory tools) can surface a refusal
   * to the model instead of the write silently no-op'ing (B1). `{ ok: true }` on success;
   * `{ ok: false, reason }` when the write is refused (over the total cap even after
   * compression) or errors.
   */
  addLongTermMemory(rawKey: string, content: string): { ok: boolean; reason?: string } {
    const sectionKey = normalizeSectionKey(rawKey);
    if (sectionKey === null) {
      return {
        ok: false,
        reason: `Invalid section key (${String(rawKey).length} chars). Keys are short headings: no line breaks, `
          + `no "##", at most ${KNOWLEDGE_SECTION_KEY_MAX_CHARS} chars — e.g. "procedures", "定价与计费原则".`,
      };
    }
    const key = sectionKey;
    const truncatedContent = sanitizeSectionBody(content);
    // 审计 P-04/P-05：单段正文超限 —— 不再静默截断，改为可读拒绝（无损、可操作）。
    if (truncatedContent.length > MEMORY_MD_SECTION_MAX_CHARS) {
      return {
        ok: false,
        reason: `Section body is ${truncatedContent.length} chars, over the ${MEMORY_MD_SECTION_MAX_CHARS}-char per-section limit. `
          + 'Split it into multiple sections or shorten it — content is never silently truncated.',
      };
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
        // 审计 P-17（严重 bug 修复）：`## _observations` 必须是**最后一个**段落——
        // saveToDisk() 以该标记为界重建文件，会丢弃其后的所有内容。历史上这里直接
        // `existing + section` 追加到末尾，恰好落在 _observations 之后，导致**任何新建
        // curated 段落在下一次观察区保存时被静默删除**（正文只剩归档副本）。
        // 正确做法：新段落插入到 _observations **之前**。
        const obsIdx = existing.indexOf('\n## _observations');
        if (obsIdx >= 0) {
          updated = existing.slice(0, obsIdx) + `\n${sectionHeader}\n${truncatedContent}\n` + existing.slice(obsIdx);
        } else {
          updated = existing + `\n${sectionHeader}\n${truncatedContent}\n`;
        }
      }

      writeFileAtomic(this.longTermFile, updated);
      // 审计 P-04/P-05：总量超预算 → 无损再平衡（归档），绝不拒绝写入、绝不静默丢弃。
      if (updated.length > MEMORY_MD_TOTAL_MAX_CHARS) {
        const rebalanced = this.compressLongTermMemory();
        log.info('knowledge.md over budget after write — rebalanced losslessly', {
          key, totalChars: updated.length, charsAfter: rebalanced.charsAfter, archived: rebalanced.truncatedChunks,
        });
      }
      log.debug('Long-term memory updated', { key, sectionChars: truncatedContent.length, totalChars: updated.length, store: this.getStoreFileName() });
      return { ok: true };
    } catch (err) {
      log.warn('Failed to write long-term memory', { key, error: String(err) });
      return { ok: false, reason: `Failed to write knowledge.md: ${String(err)}` };
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

  /**
   * Remove a curated section from knowledge.md — the missing "forget" primitive.
   *
   * A store you can only write to (and overwrite in place) but never remove from will
   * inflate until it hits a cap and then stay there: this file was measured at 23 323
   * chars against a 15 000 budget, and superseded topics had no way to disappear.
   *
   * `## _observations` is never accepted here — it is the observation buffer with its
   * own cap and its own curation path; delete individual observations by id instead.
   */
  removeLongTermSection(sectionName: string): { ok: boolean; reason?: string; removedChars: number } {
    const name = String(sectionName ?? '').trim().replace(/^#+\s*/, '');
    if (!name) return { ok: false, reason: 'Section name is required.', removedChars: 0 };
    if (/^_observations$/i.test(name)) {
      return {
        ok: false,
        reason: 'The `_observations` buffer is not a curated section — delete individual observations by id instead.',
        removedChars: 0,
      };
    }
    if (!existsSync(this.longTermFile)) {
      return { ok: false, reason: 'knowledge.md does not exist.', removedChars: 0 };
    }
    try {
      const content = readFileSync(this.longTermFile, 'utf-8');
      const curatedBefore = this.getLongTermMemory();
      if (!curatedBefore.includes('## ' + name)) {
        return { ok: false, reason: `Section "${name}" not found.`, removedChars: 0 };
      }
      // Reuse the existing, already-correct section stripper instead of duplicating its
      // escaping rules here.
      const curatedAfter = this.getLongTermMemoryExcluding([name]);
      const obsIdx = content.indexOf('## _observations');
      const obsPart = obsIdx >= 0 ? content.slice(obsIdx).trimStart() : '';
      const updated = (curatedAfter.trimEnd() + (obsPart ? '\n\n' + obsPart : '')).trimEnd() + '\n';
      writeFileAtomic(this.longTermFile, updated);
      log.info('Curated section removed', {
        name,
        removedChars: curatedBefore.length - curatedAfter.length,
        totalChars: updated.length,
      });
      return { ok: true, removedChars: curatedBefore.length - curatedAfter.length };
    } catch (err) {
      log.warn('Failed to remove curated section', { name, error: String(err) });
      return { ok: false, reason: `Failed to remove section: ${String(err)}`, removedChars: 0 };
    }
  }

  // --- Context compaction (OpenClawd pattern) ---

  /**
   * MessageGroup atomicity (ContextOS design §4.2): a group is
   * [assistant(tool_calls)] + the immediately-following [tool results].
   * Compaction must NOT split a group — otherwise the LLM sees an assistant
   * whose tool_calls lack results (or orphan tool results).
   *
   * Given the desired cutoff (first "kept" message), widen it to a safe
   * boundary: if the cut would split an assistant's tool_calls from its
   * results, extend the cut forward past the whole group (retain more, never
   * break a pair). Structural boundaries (user / system / plain assistant)
   * are always safe.
   */
  private computeSafeCutoff(messages: LLMMessage[], cutoff: number): number {
    if (cutoff <= 0 || cutoff >= messages.length) return cutoff;
    let idx = cutoff;
    while (idx < messages.length) {
      const m = messages[idx]!;
      if (m.role === 'assistant' && m.toolCalls?.length) {
        // This assistant's results follow; extend cut past the whole
        // tool-result run so assistant+results stay together in retained.
        const wanted = new Set(m.toolCalls.map((t) => t.id));
        let j = idx + 1;
        while (j < messages.length && messages[j]!.role === 'tool') {
          j++;
        }
        // The tool run ends at j. Keep results contiguous with their assistant:
        // extend idx to the group end.
        if (j > idx + 1) {
          idx = j;
          break;
        }
        // No tool messages follow (bare assistant w/ toolCalls) — safe to cut here.
        break;
      }
      // Plain assistant (no toolCalls) — safe boundary; stop widening.
      if (m.role === 'system' || m.role === 'user' || (m.role === 'assistant' && !m.toolCalls?.length)) {
        break;
      }
      // tool message: skip forward (it belongs to whatever group it's a result for)
      idx++;
    }
    return idx;
  }

  compactSession(sessionId: string, keepLast: number = 20): CompactResult {
    // SSOT / LRU fallback: the in-memory map only holds the N most recent
    // sessions (MAX_SESSIONS_IN_MEMORY=20) while thousands live on disk. Reading
    // ONLY `this.sessions` made compact() a silent no-op for any session that
    // had been evicted — it returned ok with flushedCount:0 and the agent could
    // not tell "nothing to compact" from "compaction failed" (the 2026-09-30
    // 刘利 P0 report). Every OTHER session accessor already falls back to disk
    // (getSession/getSlots/serializeSummary/getRecentMessages); this one must too.
    const session = this.sessions.get(sessionId) ?? this.getSession(sessionId);
    if (!session) {
      return { summary: '', flushedCount: 0, remaining: 0, found: false };
    }
    if (session.messages.length <= keepLast) {
      return { summary: '', flushedCount: 0, remaining: session.messages.length, found: true };
    }

    // MessageGroup-atomic cut: never split an assistant(tool_calls) from its
    // tool results. Widen the raw count-based cut to a safe group boundary.
    const desiredCut = session.messages.length - keepLast;
    const safeCut = this.computeSafeCutoff(session.messages, desiredCut);
    const older = session.messages.slice(0, safeCut);
    const flushedCount = older.length;

    const summary = this.buildHeuristicSummary(older);

    // (ContextOS stage A) NEVER drop paged-out history — archive the full
    // fragment before replacing it with the summary anchor. The agent can
    // recover it verbatim via session_retrieve. This is the "preserve raw
    // data" invariant: compaction == pagination, not deletion.
    if (older.length > 0) {
      this.addEntry({
        id: `frag_${Date.now()}_${session.id}`,
        timestamp: new Date().toISOString(),
        type: 'conversation_fragment',
        content: older
          .map((m) => {
            const text = getTextContent(m.content);
            const tcn = m.role === 'assistant' && m.toolCalls?.length
              ? ` [tool-calls: ${m.toolCalls.map((t: { name?: string }) => t.name ?? '?').join(', ')}]`
              : '';
            return `[${m.role}${tcn}] ${text}`;
          })
          .join('\n'),
        metadata: {
          sessionId: session.id,
          agentId: session.agentId,
          pagedOutCount: older.length,
          first: getTextContent(older[0]!.content).slice(0, 120),
          last: getTextContent(older[older.length - 1]!.content).slice(0, 120),
        },
      });
    }

    const retained = session.messages.slice(safeCut);

    // ContextOS: the summary anchor lives in the durable `session.summary` and
    // is injected into the [SYSTEM] fixed segment ([CONTEXT SUMMARY]) every
    // turn — NOT injected as a `role:'user'` fake message. This keeps it:
    //   - always present (agent knows what was paged out, every turn);
    //   - never re-compacted (a message in the flow would re-enter the
    //     variable-segment compression chain and be collapsed again);
    //   - turn-neutral (a `role:'user'` message would pollute attribution and
    //     could be mistaken for genuine human input).
    // Raw history is still fully recoverable via the archived fragment below.
    // 审计 P-09：摘要锚点是**追加式多代**（不再覆盖）——每次压缩各留一条代锚，
    // 最新在后、总代有界（超出的旧锚仍在归档 fragment 中，可 session_retrieve）。
    const anchorLine = `- [${new Date().toISOString()}] ${summary.replace(/\s+/g, ' ').trim().slice(0, 400)}`;
    const priorAnchors = (session.summary ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    session.summary = [...priorAnchors, anchorLine].slice(-MemoryStore.MAX_SUMMARY_ANCHORS).join('\n');
    session.summaryPagedOut = flushedCount;
    session.messages = retained;
    this.saveSessionToDisk(session);

    log.info('Session compacted', { sessionId, flushedCount, remaining: session.messages.length });
    return { summary, flushedCount, remaining: session.messages.length, found: true };
  }

  /**
   * Build a heuristic summary by extracting key lines from messages.
   * Used as the default (non-LLM) summarization strategy.
   *
   * Anchor-aware (0.9.7 context-root-fix): instead of blindly truncating every
   * message to a fixed head, we preserve the *navigation anchors* the agent
   * needs to re-orient after compaction:
   *  - the LAST user request/intent (full, short);
   *  - every distinct tool call NAME + its result head/tail (so the agent knows
   *    what work was already done and where the results live);
   *  - the last assistant decision/answer head.
   * This keeps the summary compact but high-density: it trades token count for
   * re-orientation value, which is exactly what prevents the "re-read the same
   * files / repeat the same actions" loop caused by lost anchors.
   */
  buildHeuristicSummary(messages: LLMMessage[]): string {
    const summaryParts: string[] = [];
    let lastUserIntent = '';
    const toolCallsSeen = new Set<string>();
    let lastAssistant = '';

    for (const msg of messages) {
      if (msg.role === 'system') continue;
      const text = getTextContent(msg.content);
      if (!text) continue;

      if (msg.role === 'user') {
        // Keep the latest user intent verbatim (short), older ones collapsed.
        const line = text.replace(/\s+/g, ' ').trim();
        lastUserIntent = line.slice(0, 300);
      } else if (msg.role === 'assistant') {
        // Keep the last assistant decision/answer head for context continuity.
        lastAssistant = text.replace(/\s+/g, ' ').trim().slice(0, 200);
      } else if (msg.role === 'tool') {
        // Tool results: dedupe by name, keep head + tail (anchors to outputs).
        const toolName = this.extractToolName(text);
        const head = text.slice(0, 120);
        let tail = '';
        if (text.length > 240) tail = text.slice(-80);
        if (toolName && !toolCallsSeen.has(toolName)) {
          toolCallsSeen.add(toolName);
          summaryParts.push(
            `Tool ${toolName}: ${head}${tail ? ` … ${tail}` : ''}`,
          );
        }
      }
    }

    if (lastUserIntent) summaryParts.unshift(`Latest user intent: ${lastUserIntent}`);
    if (lastAssistant) summaryParts.push(`Last assistant: ${lastAssistant}`);

    // Cap at 3000 chars: denser than before (2000) but still bounded.
    return summaryParts.join('\n').slice(0, 3000);
  }

  /** Best-effort extraction of a tool name from a tool-result blob. */
  private extractToolName(text: string): string {
    const m = text.match(/^(\[?\w[\w_-]*\]?|\w[\w._-]*)/);
    if (!m) return 'tool';
    const name = m[1].replace(/^\[|\]$/g, '').trim();
    return name.length > 0 && name.length <= 48 ? name : 'tool';
  }

  summarizeAndTruncate(sessionId: string, keepLast: number): LLMMessage[] {
    this.compactSession(sessionId, keepLast);
    const session = this.sessions.get(sessionId);
    return session?.messages ?? [];
  }

  /**
   * (0.9.7 context-root-fix) Agent-driven context compaction.
   *
   * Unlike {@link checkAndCompact} (passive threshold), this lets the agent
   * actively collapse stale history on demand: when it decides earlier turns
   * are useless (e.g. after a large file refactor the old tool blobs no longer
   * matter), it swaps them for an anchor summary via an explicit tool call —
   * instead of waiting for storage safety triggers, which fire too late.
   *
   * Backward compatible: keeps the same `[Conversation history summary …]`
   * wrapper so downstream consumers (LLM, UI) treat it like any compaction.
   * Returns the number of flushed messages.
   */
  compactSessionOnDemand(
    sessionId: string,
    keepLast: number = 40,
  ): { summary: string; flushedCount: number } {
    return this.compactSession(sessionId, keepLast);
  }

  // ─── ContextOS: session slots + fragment retrieval (agent-managed) ───────

  getSlots(sessionId: string): SlotEntry[] {
    const session = this.sessions.get(sessionId) ?? this.tryLoadSessionFromDisk(sessionId);
    const slots = session?.slots ?? {};
    return Object.entries(slots)
      .map(([key, text]) => ({ key, text, updatedAt: Date.now() }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  setSlot(sessionId: string, key: string, text: string): void {
    let session = this.sessions.get(sessionId);
    if (!session) session = this.tryLoadSessionFromDisk(sessionId);
    if (!session) return; // unknown session — caller (session tool) validates ownership first
    session.slots = session.slots ?? {};
    session.slots[sanitizeSlotKey(key)] = text.slice(0, CONTEXT_SLOT_MAX_CHARS);
    session.lastActivityAt = new Date().toISOString();
    this.saveSessionToDisk(session);
  }

  removeSlot(sessionId: string, key: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.slots) return;
    delete session.slots[key];
    session.lastActivityAt = new Date().toISOString();
    this.saveSessionToDisk(session);
  }

  /** Serialize this session's slots into the fixed [SLOTS] injection segment. */
  serializeSlots(sessionId: string): string {
    return buildSlotSegment(this.getSlots(sessionId));
  }

  /** Serialize this session's compaction summary into the fixed [CONTEXT SUMMARY]
   *  segment (empty string when none). Semantically separate from [SLOTS]. */
  serializeSummary(sessionId: string): string {
    const session = this.sessions.get(sessionId) ?? this.tryLoadSessionFromDisk(sessionId);
    if (!session?.summary) return '';
    return buildSummarySegment(session.summary, session.summaryPagedOut);
  }

  /** Search archived conversation_fragment entries for this session. */
  retrieveFragments(
    query: string,
    maxResults: number = 5,
  ): Array<{ id: string; content: string; metadata?: Record<string, unknown> }> {
    const q = query.trim().toLowerCase();
    const hits = this.entries.filter(
      (e) => e.type === 'conversation_fragment',
    );
    // score by keyword hits against content
    const scored = hits
      .map((e) => {
        const hay = e.content.toLowerCase();
        let score = 0;
        if (q) {
          const tokens = q.split(/\s+/).filter(Boolean);
          score = tokens.filter((t) => hay.includes(t)).length;
          if (tokens.some((t) => e.id.toLowerCase().includes(t))) score += 2;
        } else {
          score = 1;
        }
        return { e, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
    return scored.map((s) => ({ id: s.e.id, content: s.e.content, metadata: s.e.metadata }));
  }

  /** Re-inject one archived fragment back into the live session as a user message. */
  includeFragment(sessionId: string, fragmentId: string): { ok: boolean; message: string } {
    const entry = this.entries.find((e) => e.id === fragmentId && e.type === 'conversation_fragment');
    if (!entry) {
      return { ok: false, message: `No archived fragment with id ${fragmentId}.` };
    }
    let session = this.sessions.get(sessionId);
    if (!session) session = this.tryLoadSessionFromDisk(sessionId);
    if (!session) {
      return { ok: false, message: `No session with id ${sessionId}.` };
    }
    session.messages.push({
      role: 'user',
      content: `[RECALLED ARCHIVE fragment ${fragmentId} — reinjected into context at agent request]\n${entry.content}\n[End of recalled archive.]`,
    });
    session.lastActivityAt = new Date().toISOString();
    this.saveSessionToDisk(session);
    return { ok: true, message: `Reinjected fragment ${fragmentId} (${entry.content.length} chars) into the session.` };
  }

  /** Purge archived fragments for a session (used by session_purge). */
  purgeSessionFragments(sessionId: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e) => !(e.type === 'conversation_fragment' && e.metadata?.sessionId === sessionId),
    );
    const removed = before - this.entries.length;
    if (removed > 0) this.saveToDisk();
    return removed;
  }

  /** Lightweight session stats for session_status. */
  sessionStats(sessionId: string): {
    messageCount: number;
    slotKeys: string[];
    fragmentCount: number;
  } {
    const session = this.sessions.get(sessionId);
    const fragmentCount = this.entries.filter(
      (e) => e.type === 'conversation_fragment' && e.metadata?.sessionId === sessionId,
    ).length;
    return {
      messageCount: session?.messages.length ?? 0,
      slotKeys: Object.keys(session?.slots ?? {}),
      fragmentCount,
    };
  }

  // --- Disk persistence ---

  private checkAndCompact(session: ConversationSession): void {
    // Cache-safety: do NOT rewrite already-archived history in place. In-place
    // mutation of a middle tool message breaks the implicit prefix-cache (the
    // whole replayed prefix) for every subsequent turn until it ages out.
    // Per-request packing (`shrinkOversizedMessages`) already bounds each tool
    // result transiently, so storage stays a byte-stable full transcript until
    // the deliberate safety compact below (which archives with a summary).
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

  /**
   * Migration-read layer（P-08）——**读旧、只写新**。
   *
   * 读取端容忍一切历史格式；写入端只发单一规范格式（单 `data-meta` JSON 行）。
   * 遗留数据不删除，而是在加载时被读入并迁移为规范形态：
   *   - 已退场的 `state.md` → 一条规范观察（源改名 `.migrated`，可恢复、不重复读）；
   *   - knowledge.md 内的旧 `<!-- type: x, tags: a, b -->` 行 → 标记需收敛重写。
   * （`memories.json` / `MEMORY.md` 的迁移在各自调用点，见文件头。）
   *
   * @returns true 表示内存态已变化、调用方应落盘收敛为规范格式。
   */
  private runLegacyMigrations(): boolean {
    let changed = false;

    // 已退场的 state.md：读入为一条观察，源改名（而非删除）→ 不再重复读取。
    const retired = retiredStatePath(this.dataDir);
    if (existsSync(retired)) {
      try {
        const raw = readFileSync(retired, 'utf-8').trim();
        if (raw) {
          this.entries.push({
            id: `obs_${Date.now()}`,
            timestamp: new Date().toISOString(),
            type: 'note',
            content: raw,
            metadata: { tags: ['legacy-state'] },
          });
          changed = true;
        }
        renameSync(retired, `${retired}.migrated`);
        log.info('Migrated retired state.md into knowledge.md observations', { chars: raw.length });
      } catch (err) {
        log.warn('Failed to migrate retired state.md', { error: String(err) });
      }
    }

    // 旧 `, tags:` 行（单 data-meta 之前的历史格式）：标记需收敛重写为规范格式。
    try {
      const raw = readFileSync(this.longTermFile, 'utf-8');
      if (/(?:^|\n)<!-- type: \w+, tags: /.test(raw)) {
        changed = true;
        log.info('knowledge.md has legacy `, tags:` observation lines — converging to canonical `data-meta`');
      }
    } catch { /* file may not exist yet */ }

    return changed;
  }

  private loadFromDisk(): void {
    // [LEGACY-COMPAT #1] memories.json → ## _observations（见文件头「Legacy
    // compatibility layer」）。仅当该遗留文件存在时触发一次，归一后不再触发。
    const memFile = join(this.dataDir, 'memories.json');
    if (existsSync(memFile)) {
      try {
        const raw = JSON.parse(readFileSync(memFile, 'utf-8')) as unknown[];
        let entries = raw.filter(isValidEntry).map(sanitizeEntry);
        if (entries.length > MemoryStore.MAX_MEMORY_ENTRIES) {
          entries = entries.slice(-MemoryStore.MAX_MEMORY_ENTRIES);
        }
        this.entries = entries;
        // Migrate: write observations into knowledge.md and remove memories.json
        this.saveToDisk();
        try {
          unlinkSync(memFile);
          log.info(`Migrated ${entries.length} entries from memories.json to knowledge.md ## _observations`);
        } catch { /* best effort deletion */ }
        return;
      } catch {
        log.warn('Failed to migrate memories.json, starting fresh');
      }
    }

    // Load observations from ## _observations section of knowledge.md
    this.entries = this.parseObservationsFromMemoryMd();
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.content.trim().length > 0);
    if (this.entries.length < before) {
      log.info('Pruned empty observation entries on load', {
        removed: before - this.entries.length,
        store: this.getStoreFileName(),
      });
      this.saveToDisk();
    }

    // ── Migration-read layer（P-08）：读旧 → 写成规范格式 ──────────────────
    const migrationChanged = this.runLegacyMigrations();

    // ── Boot-time self-heal ──────────────────────────────────────────────
    // Some agents inherited a knowledge.md ballooned to tens/hundreds of MB by
    // an older nested-serialize feedback bug (a `data-meta` blob re-parsed as a
    // tag, re-written, re-nested indefinitely). That not only wastes disk/read
    // time every turn — the oversized Tier-2 "Your Knowledge" injection keeps
    // changing its prefix, which silently destroys the DeepSeek/OpenAI
    // implicit prefix-cache hit rate (measured: 19% instead of 60-80%).
    // Because it is a boot-time concern shared by ALL agents, we self-heal
    // right here: if the file is unexpectedly large or contains nested-meta
    // corruption, re-serialize the in-memory (already-split/fixed) entries back
    // through the single-data-meta JSON writer and cap each section size.
    // This is idempotent and safe: entries were parsed with the fixed reader,
    // so re-writing them produces a clean, compact file.
    if (this.shouldSelfHeal()) {
      // 审计 P-07：安全修复 —— 先备份原文，再重建（绝不丢数据）。
      try {
        const backup = `${this.longTermFile}.corrupt-${Date.now()}.bak`;
        writeFileSync(backup, readFileSync(this.longTermFile, 'utf-8'));
        log.warn('knowledge.md oversized/corrupt — backed up, then rebuilding observations', {
          store: this.getStoreFileName(),
          backup: basename(backup),
          fileBytes: statSync(this.longTermFile).size,
          entryCount: this.entries.length,
        });
      } catch (err) {
        log.warn('Failed to back up knowledge.md before self-heal', { error: String(err) });
      }
      this.saveToDisk();
    } else if (migrationChanged) {
      this.saveToDisk();
    }

    if (this.entries.length > 0) {
      log.info(`Loaded ${this.entries.length} observation entries from ${this.getStoreFileName()}`);
    }

    // ── Boot-time TOTAL convergence ──────────────────────────────────────
    // The total cap used to be enforced ONLY on the write path, where crossing it
    // caused the write to be REFUSED. A refused write cannot shrink an oversized
    // file, so an over-budget knowledge.md stayed over budget forever (measured:
    // 23 323 chars against a 15 000 limit). Enforcing it at load makes the cap an
    // actual invariant: "what was read is what fits".
    this.convergeLongTermToCap();
  }

  /**
   * Shrink knowledge.md to `MEMORY_MD_TOTAL_MAX_CHARS` if it is over budget.
   *
   * Idempotent and cheap when already within budget (one `statSync`). Delegates to
   * `compressLongTermMemory` so the per-section cap, the stub marker and the
   * `## _observations` carve-out all follow one implementation.
   */
  convergeLongTermToCap(): { converged: boolean; charsBefore: number; charsAfter: number } {
    if (!existsSync(this.longTermFile)) {
      return { converged: false, charsBefore: 0, charsAfter: 0 };
    }
    let chars = 0;
    try {
      chars = readFileSync(this.longTermFile, 'utf-8').length;
    } catch {
      return { converged: false, charsBefore: 0, charsAfter: 0 };
    }
    if (chars <= MEMORY_MD_TOTAL_MAX_CHARS) {
      return { converged: false, charsBefore: chars, charsAfter: chars };
    }
    const result = this.compressLongTermMemory();
    log.warn('knowledge.md over budget at load — converged', {
      charsBefore: result.charsBefore,
      charsAfter: result.charsAfter,
      cap: MEMORY_MD_TOTAL_MAX_CHARS,
      store: this.getStoreFileName(),
    });
    return { converged: true, charsBefore: result.charsBefore, charsAfter: result.charsAfter };
  }

  /**
   * Detect a knowledge.md that needs a boot-time rebuild: either unexpectedly
   * large (nested-serialize bloat) or containing the tell-tale re-nested
   * `data-meta` syntax inside a tag field (old corruption that even the fixed
   * reader can only partially reconstruct). Cheap to compute at boot.
   */
  private shouldSelfHeal(): boolean {
    try {
      if (!existsSync(this.longTermFile)) return false;
      const st = statSync(this.longTermFile);
      if (st.size > KNOWLEDGE_MD_SELF_HEAL_BYTES) return true;
      // Nested-meta marker: a corrupted obs line contains ", data-meta" inside
      // the tags position, i.e. ", , data-meta" spreading. We just check that
      // no loaded entry's tags look like a serialized blob.
      return this.entries.some((e) =>
        Array.isArray(e.metadata?.tags) &&
        (e.metadata!.tags as string[]).some((t) => /data-meta|\\"/i.test(t)),
      );
    } catch {
      return false;
    }
  }

  /** Parse the ## _observations section of knowledge.md into MemoryEntry[] */
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
        let restoredMeta: Record<string, unknown> | undefined;
        const contentLines: string[] = [];
        for (let i = 1; i < lines.length; i++) {
          // Parse metadata from HTML comment. Prefer a single `data-meta` JSON
          // payload (new format). The legacy `, tags: a, b` form is tolerated via
          // a NON-GREEDY tags capture that must NOT consume a trailing
          // `, data-meta:` — otherwise a tag with a comma/JSON regenerates on
          // every round-trip (the 50MB obs bomb). We first try to strip the
          // enclosed `data-meta: <json> -->` tail so `(.+?)` can never eat it.
          const metaMatch = lines[i].match(/^<!-- type: (\w+)(?:, tags: (.*?))?(?:, data-meta: (.+))? -->$/);
          if (metaMatch) {
            const typeVal = metaMatch[1];
            if (typeVal && VALID_TYPES.has(typeVal)) type = typeVal as MemoryEntry['type'];
            let parsedMeta: Record<string, unknown> | undefined;
            if (metaMatch[3]) parsedMeta = parseDataMeta(metaMatch[3]);
            const legacyTags = metaMatch[2] ? metaMatch[2].split(',').map(t => t.trim()).filter(Boolean) : [];
            const metaTags = parsedMeta && Array.isArray(parsedMeta.tags)
              ? parsedMeta.tags as string[]
              : legacyTags;
            // Faithful restored metadata (excluding tags, which are carried above).
            if (parsedMeta) {
              const rest = { ...parsedMeta };
              delete rest.tags;
              restoredMeta = { ...(restoredMeta ?? {}), ...rest };
            }
            if (Array.isArray(metaTags)) {
              tags = metaTags.map(String);
              restoredMeta = { ...(restoredMeta ?? {}), tags };
            } else if (parsedMeta) {
              restoredMeta = { ...(restoredMeta ?? {}) };
            }
            // Safety: if tags somehow contain a re-nested data-meta blob (old
            // corruption), drop tags entirely rather than re-nest on the next write.
            if (tags.some((t) => /data-meta|\\"|\\:/i.test(t))) tags = [];
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
          metadata: restoredMeta !== undefined
            ? restoredMeta
            : (tags.length > 0 ? { tags } : undefined),
        });
      }
      return entries;
    } catch (err) {
      log.warn('Failed to parse observations from knowledge.md', { error: String(err) });
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
      // Serialize observations as ## _observations subsections within knowledge.md
      const obsLines: string[] = [
        '## _observations',
        '<!-- This section is the observation buffer. Searched on-demand, NOT always injected into prompt. -->',
        '<!-- Dream cycle consolidates recurring patterns into curated sections above. -->',
        '',
      ];
      // 审计 P-10：观察缓冲区有界（字符），且与压缩碎片**分池**（各有 500 上限），
      // 碎片不再挤占观察配额。超限的观察**无损归档**（可检索），绝不静默丢弃。
      const isFrag = (e: MemoryEntry) => e.type === 'conversation_fragment';
      const obsCount = () => this.entries.filter(e => !isFrag(e)).length;
      let obsChars = this.entries
        .filter(e => !isFrag(e))
        .reduce((n, e) => n + e.content.length + 96, 0);
      while (obsChars > MEMORY_OBSERVATIONS_MAX_CHARS && obsCount() > 1) {
        const idx = this.entries.findIndex(e => !isFrag(e));
        if (idx < 0) break;
        const oldest = this.entries.splice(idx, 1)[0]!;
        this.archiveSection(`observation ${oldest.id}`, oldest.content);
        obsChars -= oldest.content.length + 96;
      }
      // 分池计数上限：观察与碎片各自独立保留最新 500 条（保持原顺序）。
      const keptObs = this.entries.filter(e => !isFrag(e)).slice(-MemoryStore.MAX_MEMORY_ENTRIES);
      const keptFrags = this.entries.filter(isFrag).slice(-MemoryStore.MAX_MEMORY_ENTRIES);
      const keepIds = new Set<string>([...keptObs, ...keptFrags].map(e => e.id));
      const entries = this.entries.filter(e => keepIds.has(e.id) && e.content.trim().length > 0);
      this.entries = entries;
      for (const entry of entries) {
        obsLines.push(`### ${entry.id}`);
        // Serialize metadata faithfully: conversation_fragment retro-traceability
        // (sessionId/agentId/pagedOutCount/first/last) must survive disk round-trips.
        // CRITICAL: emit a SINGLE `data-meta` JSON payload and store tags INSIDE it.
        // Never emit a bare `, tags: a, b` field AND a separate data-meta that both
        // carry the tags — the old dual format let a tag containing a comma/JSON blob
        // be re-parsed by the greedy reader, re-serialized, re-nested indefinitely
        // (observed: a single obs grew to 50MB from this feedback loop).
        const tags = Array.isArray(entry.metadata?.tags)
          ? (entry.metadata!.tags as string[])
          : [];
        const meta = entry.metadata && typeof entry.metadata === 'object'
          ? { ...entry.metadata, tags }
          : (tags.length > 0 ? { tags } : undefined);
        const metaJson = meta ? safeJson(meta) : '';
        obsLines.push(`<!-- type: ${entry.type}${metaJson ? `, data-meta: ${metaJson}` : ''} -->`);
        obsLines.push(entry.content);
        obsLines.push('');
      }
      const obsSection = obsLines.join('\n');

      // Read existing knowledge.md, replace or append ## _observations
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
      writeFileAtomic(this.longTermFile, updated);
    } catch (err) {
      log.warn('Failed to save observations to knowledge.md', { error: String(err) });
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
    // 定时器必须**按会话**分开：并发模式下多个 worker 各有自己的会话，共用
    // 一个实例级定时器时，后到的 worker 会 clearTimeout 掉先到者的待写 ——
    // 前一个会话的变更被静默丢弃（进程重启即丢失）。按 session.id 键控修掉。
    const key = session.id;
    const existing = this.saveDebounce.get(key);
    if (existing) clearTimeout(existing);
    this.saveDebounce.set(key, setTimeout(() => {
      this.saveDebounce.delete(key);
      this.saveSessionToDisk(session);
    }, 1000));
  }

  /** Compress knowledge.md — truncate oversized sections to prevent context bloat */
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

    // Sections as [headerLine, ...bodyLines]. `## _observations` is NOT a section
    // we may touch: it is the observation buffer with its own cap and its own
    // curation path (dream cycle). It is carried through verbatim.
    const sections: { headerLine: string; body: string[]; observationBuffer: boolean }[] = [];
    let currentHeader = '';
    let currentBody: string[] = [];
    let currentIsObs = false;

    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('## ')) {
        if (currentHeader) {
          sections.push({ headerLine: currentHeader, body: currentBody, observationBuffer: currentIsObs });
        }
        currentHeader = line;
        currentBody = [];
        currentIsObs = /^##\s+_observations\s*$/.test(line);
      } else {
        currentBody.push(line);
      }
      i++;
    }
    // Push last section
    if (currentHeader) {
      sections.push({ headerLine: currentHeader, body: currentBody, observationBuffer: currentIsObs });
    }

    const sectionsBefore = sections.length;
    let archived = 0;

    const render = (): string => {
      const out: string[] = [...preambleLines];
      for (const s of sections) out.push(s.headerLine, s.body.join('\n'));
      return out.join('\n');
    };
    const size = () => render().length;

    const isPointer = (s: { body: string[] }) => /^_\[archived/.test(s.body.join('\n').trim());
    const archiveBodyOf = (section: { headerLine: string; body: string[] }): void => {
      const bodyStr = section.body.join('\n').trim();
      if (!bodyStr) return;
      const name = section.headerLine.replace(/^##\s+/, '').trim();
      this.archiveSection(name, bodyStr); // 无损：正文进 knowledge-archive.md
      section.body = [`_[archived → ${this.getArchiveFileName()}；正文已无损归档，可用 memory_search 检索]_`];
      archived++;
    };

    // ── Phase 2: 单段超限 → 归档该段正文（无损，不截断）──────────────────
    for (const section of sections) {
      if (section.observationBuffer) continue;
      if (section.body.join('\n').length > MEMORY_MD_SECTION_MAX_CHARS) archiveBodyOf(section);
    }

    // ── Phase 3: 总量超限 → 逐个归档最大段落正文，直到达标 ─────────────────
    // 审计 P-04/P-05：以前这里把段落「压成 stub」（有损）；现在改为把正文移入
    // knowledge-archive.md（无损、可检索、不注入），主文件只留标题 + 指针。
    // 绝不触碰 ## _observations（它有自己的容量与整理路径）。
    if (size() > MEMORY_MD_TOTAL_MAX_CHARS) {
      const shrinkable = sections
        .filter(s => !s.observationBuffer && !isPointer(s))
        .sort((a, b) => b.body.join('\n').length - a.body.join('\n').length);
      for (const section of shrinkable) {
        if (size() <= MEMORY_MD_TOTAL_MAX_CHARS) break;
        if (section.body.join('\n').trim().length <= 120) continue; // 已是小段，不值得归档
        archiveBodyOf(section);
      }
    }

    const compressed = render();
    if (compressed !== content) writeFileAtomic(this.longTermFile, compressed);

    return {
      charsBefore,
      charsAfter: compressed.length,
      sectionsBefore,
      sectionsAfter: sections.length,
      truncatedChunks: archived,
    };
  }
}

function formatTags(metadata?: Record<string, unknown>): string {
  const tags = metadata?.tags;
  return Array.isArray(tags) ? tags.map(String).join(' ') : '';
}

function parseCuratedSections(markdown: string): Array<{ name: string; body: string }> {
  if (!markdown.trim()) return [];
  const sections: Array<{ name: string; body: string }> = [];
  const re = /^## (.+)$/gm;
  let match: RegExpExecArray | null;
  const headers: Array<{ name: string; index: number; headerLen: number }> = [];
  while ((match = re.exec(markdown)) !== null) {
    headers.push({ name: match[1]!.trim(), index: match.index, headerLen: match[0].length });
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    const start = h.index + h.headerLen;
    const end = i + 1 < headers.length ? headers[i + 1]!.index : markdown.length;
    const body = markdown.slice(start, end).trim();
    if (h.name === '_observations') continue;
    sections.push({ name: h.name, body });
  }
  return sections;
}

function slugSectionId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '_').replace(/^_|_$/g, '').slice(0, 80) || 'section';
}
