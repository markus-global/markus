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
  MEMORY_MD_CURATED_MAX_CHARS,
  MEMORY_MD_CURATED_HARD_MAX_CHARS,
  MEMORY_OBSERVATIONS_MAX_CHARS,
  MEMORY_OBSERVATIONS_HARD_MAX_CHARS,
  MEMORY_FRAGMENTS_MAX_CHARS,
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
import type { IMemoryStore, MemoryEntry, ConversationSession, CompactResult, MemoryHealth } from './types.js';
import { ensureKnowledgeFile, knowledgePath, retiredStatePath } from './taxonomy.js';
import { indexArchiveBodies, healStubLines, accumulateResidue } from './residue-repair.js';
import { writeFileAtomic } from '../atomic-write.js';
import { buildSlotSegment, buildSummarySegment, sanitizeSlotKey, type SlotEntry } from '../context-slot.js';

export type { MemoryEntry, ConversationSession, IMemoryStore } from './types.js';

/** Outcome of the one-time H13 residue repair. Rules live in `residue-repair.ts`. */
export interface ResidueRepairReport {
  /** Stub lines successfully replaced by their archived body. */
  repaired: number;
  /** Stubs whose owning name matched MORE THAN ONE archived section — left untouched. */
  ambiguous: Array<{ name: string; candidates: number }>;
  /** Stubs whose owning name matched no archived section — left untouched. */
  notFound: string[];
  curatedChanged: boolean;
  entriesChanged: boolean;
  fragmentsChanged: boolean;
}

// NOTE (H12, updated by H25): there is deliberately NO "per-entry overhead" constant here.
// The observation buffer has exactly ONE size definition, shared by the writer, the trimmer
// and the health report. Since H24 the buffer is a JSON record file, and since H25 that
// definition is the **payload** (sum of entry bodies) — NOT the container's serialized
// length. Measuring the container made capacity depend on the format: moving markdown →
// pretty-printed JSON inflated the same knowledge by ~37% (indentation + repeated keys) and
// silently evicted healthy observations at migration time.
// The invariant to preserve is: measure the agent's bytes, never an approximation of them,
// and never the container's syntax.

const log = createLogger('memory-store');

// H24 — 机器记录用机器格式（见 `records.ts` 与 docs §20）。载荷是 JSON 字符串，无法伪造记录边界。
import { parseRecords, serializeRecords } from './records.js';

const VALID_TYPES = new Set<string>(['conversation', 'fact', 'task_result', 'note', 'insight', 'conversation_fragment']);

/** Prevent section bodies from introducing sibling ## headings that split the store. */
/**
 * Sanitize a curated section body AT WRITE TIME — the single point at which the agent's
 * knowledge enters the store.
 *
 * §24 (I3) — the platform never rewrites the agent's curated content on READ. Anything it
 * guarantees about that text must be guaranteed here, once, deterministically:
 *   • a `## ` inside a body would split the section in two on the next parse → demote to `### `;
 *   • leaked `<think>` blocks (model reasoning accidentally saved) must not land in the region
 *     that is injected into EVERY prompt. Doing it here replaces the old load-time heuristic
 *     sweep (`pruneMemoryMd` Pass 2, removed with §24).
 */
export function sanitizeSectionBody(content: string): string {
  return stripThinkBlocks(content).replace(/^## /gm, '### ');
}

/** Drop `<think>…</think>` blocks, plus any unterminated opener (and everything after it). */
function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .replace(/^\s*<\/think>\s*$/gm, '');
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
  /**
   * H24 — observations live in a JSON record file. Structure is JSON's, so no payload can forge a
   * record boundary; the H13/H17/H18/H22 family is gone by construction, not by another heuristic.
   */
  private observationFile: string;
  private observationArchiveFile: string;
  /**
   * H16 — session compaction fragments live in their OWN pool + file, never mixed
   * with `this.entries` (agent-authored observations). See MEMORY_FRAGMENTS_MAX_CHARS.
   */
  private fragments: MemoryEntry[] = [];
  private fragmentFile: string;
  private fragmentArchiveFile: string;

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
    this.observationFile = join(dataDir, 'observations.json');
    this.observationArchiveFile = join(dataDir, 'observations-archive.json');
    this.fragmentFile = join(dataDir, 'session-fragments.json');
    this.fragmentArchiveFile = join(dataDir, 'session-fragments-archive.json');
    this.loadFromDisk();
    this.loadFragmentsFromDisk();
    // §24 (R4) — the H13 residue repair is a **migration**, not an invariant, so it runs
    // exactly ONCE per agent, gated by a marker file. It used to run on EVERY load: a
    // permanent heuristic rewriter of agent-authored content sitting on the hot path —
    // which is precisely how H27 (repair writing back the retired container, leaving two
    // copies of one fact) became possible. Once an agent has migrated, loading does no
    // prose parsing and no content rewriting at all.
    if (!existsSync(this.migrationMarkerPath())) {
      this.repairStubResidue();
      try {
        writeFileSync(this.migrationMarkerPath(), new Date().toISOString(), 'utf-8');
      } catch { /* best-effort marker; the repair itself is idempotent */ }
    }
    this.loadSessionsFromDisk();
  }

  getStoreFileName(): string {
    return basename(this.longTermFile);
  }

  /**
   * §24 — marker for the ONE-SHOT memory migration (legacy prose containers + the H13
   * residue repair). Present ⇒ this agent is fully migrated: the load path is pure JSON,
   * parses no prose and rewrites no content. Delete criterion for the whole migration
   * module: every `agents/*` dir has this marker (docs §24.4).
   */
  private migrationMarkerPath(): string {
    return join(this.dataDir, '.memory-v2-migrated');
  }

  /** 归档文件名：超预算段落正文的**无损**去处（可被 memory_search 检索，不注入）。 */
  getArchiveFileName(): string {
    return basename(this.longTermArchiveFile);
  }

  /**
   * 记忆预算健康度（审计 P-12）：驱动提示词内的健康信号，让 Agent 知道何时该整理。
   */
  getMemoryHealth(): MemoryHealth {
    let content = '';
    try {
      if (existsSync(this.longTermFile)) content = readFileSync(this.longTermFile, 'utf-8');
    } catch { /* unreadable — treat as empty */ }
    // H24 — "archived chars" is the TOTAL lossless overflow across EVERY archive (curated sections,
    // observations, fragments), which is exactly what the banner's "已归档 N 字符" claims.
    let archiveChars = 0;
    for (const f of [this.longTermArchiveFile, this.observationArchiveFile, this.fragmentArchiveFile]) {
      try {
        if (existsSync(f)) archiveChars += readFileSync(f, 'utf-8').length;
      } catch { /* archive optional */ }
    }

    // Two budgets, measured separately and honestly. See MEMORY_MD_CURATED_MAX_CHARS.
    // H12: observations are reported via the SAME canonical measure the writer and
    // the trimmer enforce (`observationPayloadChars`, H25: payload — NOT container size), not the raw on-disk slice —
    // otherwise a file with content after `## _observations` makes the banner
    // disagree with the very cap it is supposed to represent.
    const { curated } = splitKnowledgeSections(content);
    const curatedChars = curated.length;
    // H24 — observations live in a JSON record file; report the canonical serialized size so the
    // banner, the trigger and the trimmer all speak about ONE quantity.
    const observationChars = this.observationPayloadChars();
    return {
      curatedChars,
      curatedCap: MEMORY_MD_CURATED_MAX_CHARS,
      percent: MEMORY_MD_CURATED_MAX_CHARS > 0
        ? Math.round((curatedChars / MEMORY_MD_CURATED_MAX_CHARS) * 100)
        : 0,
      observationChars,
      observationCap: MEMORY_OBSERVATIONS_MAX_CHARS,
      observationPercent: MEMORY_OBSERVATIONS_MAX_CHARS > 0
        ? Math.round((observationChars / MEMORY_OBSERVATIONS_MAX_CHARS) * 100)
        : 0,
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
      if (!existing.includes(`## ${name}\n`)) {
        appendFileSync(this.longTermArchiveFile, `## ${name}\n${trimmed}\n\n`);
      } else if (!existing.includes(trimmed)) {
        // H21 — never create a DUPLICATE section name. A repeated name makes any later
        // lookup (the residue repair included) undecidable; that ambiguity is exactly what
        // left 5 stubs unresolvable on the live org. Suffix until the name is unique.
        let n = 2;
        while (existing.includes(`## ${name} (${n})\n`)) n += 1;
        appendFileSync(this.longTermArchiveFile, `## ${name} (${n})\n${trimmed}\n\n`);
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

  addEntry(entry: MemoryEntry): { ok: boolean; reason?: string } {
    // H16 — route by TYPE. A conversation fragment is a platform pagination payload,
    // not an agent observation; it belongs in the fragment pool/file, never in
    // knowledge.md `## _observations`. Routing here keeps every caller (compaction
    // included) unchanged.
    if (entry.type === 'conversation_fragment') {
      this.fragments.push(sanitizeEntry(entry));
      this.saveFragmentsToDisk();
      log.debug('Memory fragment added', { type: entry.type, id: entry.id });
      return { ok: true };
    }
    const sanitized = sanitizeEntry(entry);
    // §24 — the ONLY hard enforcement point for the observation log. Refuse at the ceiling
    // and keep everything already stored untouched, rather than silently evicting the
    // oldest entries (which moved the agent's history without asking and made capacity
    // depend on the storage container — H25).
    if (this.observationPayloadChars() + sanitized.content.length > MEMORY_OBSERVATIONS_HARD_MAX_CHARS) {
      const reason = `Observation log is at its hard ceiling (${MEMORY_OBSERVATIONS_HARD_MAX_CHARS} chars). `
        + 'Nothing was discarded — make room with `memory_organize` (merge recurring observations into a curated section) '
        + 'or `memory_update({ mode: "delete", ... })`, then save again.';
      log.warn('observation write REFUSED at the hard ceiling (no eviction, nothing moved)', {
        chars: this.observationPayloadChars(),
        ceiling: MEMORY_OBSERVATIONS_HARD_MAX_CHARS,
        id: entry.id,
      });
      return { ok: false, reason };
    }
    this.entries.push(sanitized);
    this.saveToDisk();
    log.debug('Memory entry added', { type: entry.type, id: entry.id });
    return { ok: true };
  }

  getEntries(type?: MemoryEntry['type'], limit?: number): MemoryEntry[] {
    // Fragments are a separate pool (H16) — a `conversation_fragment` query must read
    // the fragment pool, not the observation entries.
    const source = type === 'conversation_fragment' ? this.fragments : this.entries;
    let result = type ? source.filter((e) => e.type === type) : [...source];
    if (limit) result = result.slice(-limit);
    return result;
  }

  /** All session-compaction fragments currently held (most recent last). */
  getFragments(): MemoryEntry[] {
    return [...this.fragments];
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

    // H24 — observation archive (JSON records): memory_search must still find trimmed observations.
    try {
      if (existsSync(this.observationArchiveFile)) {
        for (const e of parseRecords(readFileSync(this.observationArchiveFile, 'utf-8')).entries) {
          const score = scoreKeywordHaystack(`${e.content}\n${formatTags(e.metadata)}`, tokens, fullLower);
          if (score > 0) scored.push({ entry: e, score });
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
   * `{ ok: false, reason }` when the write is refused (invalid or oversized section) or
   * errors. Note: exceeding the **total** cap is no longer a refusal — the store
   * rebalances losslessly (`compressLongTermMemory`), so the write always lands.
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
        // Replacer must be a FUNCTION: `truncatedContent` is agent-authored and may
        // contain `$&` / ``$` `` / `$'` / `$1`, which a string replacement would
        // expand — silently duplicating the surrounding file. Same class of bug as
        // tools/literal-replace.ts; see docs/FILE-EDIT-LITERAL-REPLACEMENT-FIX.md.
        updated = existing.replace(regex, () => `${sectionHeader}\n${truncatedContent}\n`);
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

      // H19 — the curated region is injected into EVERY prompt, so it has a HARD ceiling.
      // Exceeding it is REFUSED (fail-closed; nothing is written) with an actionable reason,
      // exactly like the per-section limit above. Between the SOFT budget
      // (`MEMORY_MD_CURATED_MAX_CHARS`) and that ceiling we only REPORT (log + in-prompt
      // banner). The old code silently archived the largest sections here — value-blind,
      // invisible to the agent, inconsistent with the per-section policy, and the root of
      // H13; it never legitimately fired (0 of 94 agents ever exceeded the soft budget).
      // Measured on the CURATED slice only — the observation buffer has its own budget and
      // counting it here is what produced the old "always true" trigger.
      const curatedChars = splitKnowledgeSections(updated).curated.length;
      if (curatedChars > MEMORY_MD_CURATED_HARD_MAX_CHARS) {
        return {
          ok: false,
          reason: `Curated knowledge would reach ${curatedChars} chars, over the hard ceiling of `
            + `${MEMORY_MD_CURATED_HARD_MAX_CHARS} (this region is injected into every prompt). `
            + 'Nothing was written. Consolidate first — `memory_organize` (merge related sections) '
            + 'or `memory_update` (mode:"delete" an outdated section) — then retry.',
        };
      }

      this.writeKnowledgeMd(updated);
      if (curatedChars > MEMORY_MD_CURATED_MAX_CHARS) {
        log.warn('knowledge.md curated over SOFT budget — reported, not rewritten', {
          key, curatedChars, softCap: MEMORY_MD_CURATED_MAX_CHARS,
          hardCap: MEMORY_MD_CURATED_HARD_MAX_CHARS, store: this.getStoreFileName(),
        });
      }
      log.debug('Long-term memory updated', { key, sectionChars: truncatedContent.length, curatedChars, store: this.getStoreFileName() });
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
      this.writeKnowledgeMd(updated);
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
    // H16: search BOTH the live fragment pool and the overflow archive — an archived
    // fragment is still "recoverable verbatim", so retrieval must see it.
    const hits = [...this.fragments, ...this.archivedFragmentEntries()]
      .filter((e) => e.type === 'conversation_fragment');
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
    const entry = [...this.fragments, ...this.archivedFragmentEntries()]
      .find((e) => e.id === fragmentId && e.type === 'conversation_fragment');
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
    const before = this.fragments.length;
    this.fragments = this.fragments.filter(
      (e) => !(e.type === 'conversation_fragment' && e.metadata?.sessionId === sessionId),
    );
    const removed = before - this.fragments.length;
    if (removed > 0) this.saveFragmentsToDisk();
    return removed;
  }

  /** Lightweight session stats for session_status. */
  sessionStats(sessionId: string): {
    messageCount: number;
    slotKeys: string[];
    fragmentCount: number;
  } {
    const session = this.sessions.get(sessionId);
    const fragmentCount = this.fragments.filter(
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

    // ── H24 — observations are a JSON record file. Structure is JSON's, so no payload can forge a
    // record boundary: the H13/H17/H18/H22 family is gone by construction, not by another heuristic. ──
    if (existsSync(this.observationFile)) {
      const { entries, error } = parseRecords(readFileSync(this.observationFile, 'utf-8'));
      if (error) {
        log.error('observations.json unreadable — NOT overwriting it; starting with empty in-memory state', {
          error, file: basename(this.observationFile),
        });
      }
      this.entries = entries.filter(e => e.content.trim().length > 0);
      if (this.runLegacyMigrations()) this.saveToDisk();
      this.enforceMemoryBudgets();
      return;
    }

    // ── LEGACY MIGRATION ONLY (delete once every agent has migrated; docs §20) ──
    // Load observations from the retired `## _observations` markdown section; the `saveToDisk`
    // call at the end of this block writes observations.json and strips the region out of knowledge.md.
    const hadLegacyRegion = this.hasLegacyObservationRegion();
    const parsed = this.parseObservationsFromMemoryMd();
    // H16 migration: fragments found in knowledge.md's `## _observations` (the legacy
    // single-pool layout) move to their OWN pool/file; knowledge.md then self-heals on
    // the save below. Lossless — every fragment is carried over verbatim.
    const migratedFragments = parsed.filter(e => e.type === 'conversation_fragment');
    if (migratedFragments.length > 0) {
      this.fragments.push(...migratedFragments);
      this.saveFragmentsToDisk();
      log.info('Migrated session fragments out of knowledge.md observations', {
        count: migratedFragments.length,
        store: this.getStoreFileName(),
      });
    }
    this.entries = parsed.filter(e => e.type !== 'conversation_fragment');
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.content.trim().length > 0);
    if (this.entries.length < before) {
      log.info('Pruned empty observation entries on load', {
        removed: before - this.entries.length,
        store: this.getStoreFileName(),
      });
    }

    // H26 — persist the migration **unconditionally** whenever the retired in-band region was
    // present. Previously the write happened only on the prune / fragment / self-heal paths,
    // so a legacy agent whose buffer fit under the cap NEVER converged: the observations stayed
    // in knowledge.md, no observations.json was created, and the ambiguity-prone markdown
    // reader remained the source of truth on every subsequent load. Measured on the live org:
    // only 10 of 94 agents had migrated — precisely the ones that happened to exceed the cap
    // (the over-budget path was the only one that saved). A migration that only runs when you
    // are already in trouble is not a migration.
    if (hadLegacyRegion) {
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
    this.enforceMemoryBudgets();
  }

  /**
   * Enforce BOTH memory budgets at load time. Idempotent and cheap when already
   * within budget (one read).
   *
   * Two budgets, two independent strong enforcement points (see
   * `MEMORY_MD_CURATED_MAX_CHARS` / `MEMORY_OBSERVATIONS_MAX_CHARS`):
   *
   *   1. curated (injected) → `compressLongTermMemory` archives the largest
   *      section bodies losslessly until the injected part fits.
   *   2. observations → `trimObservationsToCap` archives the OLDEST observations
   *      losslessly until the buffer fits.
   *
   * Step 2 is the piece that used to be missing. `compressLongTermMemory`
   * deliberately skips the observation buffer ("it has its own budget"), but that
   * budget was only enforced on the WRITE path — so an agent whose excess lived
   * entirely in observations could never converge at load: the file was rewritten
   * byte-for-byte and still logged `converged {charsBefore: X, charsAfter: X}`.
   * A cap with no enforcement point is not a cap.
   */
  enforceMemoryBudgets(): MemoryBudgetEnforcement {
    const read = (): { curated: string; observations: string } => {
      try {
        return splitKnowledgeSections(existsSync(this.longTermFile) ? readFileSync(this.longTermFile, 'utf-8') : '');
      } catch {
        return { curated: '', observations: '' };
      }
    };

    const start = read();

    // ── Budget 1: curated (injected) — REPORT ONLY (H19) ──────────────────
    // The platform does NOT rewrite the curated region on its own. The old
    // `compressLongTermMemory()` archived the LARGEST section bodies into
    // knowledge-archive.md and left pointer stubs — value-blind, invisible to the agent,
    // inconsistent with the per-section "never silently truncated" policy, and the root
    // of H13. It never legitimately fired (measured: 0 / 94 agents over the soft budget).
    // Over-budget is REPORTED here and by the in-prompt banner; the agent consolidates
    // with its own tools (`memory_organize` / `memory_update`). The HARD ceiling is
    // enforced fail-closed on the write path (see `addLongTermMemory`).
    const curated = {
      before: start.curated.length,
      after: start.curated.length,
      // H19: curated is REPORT-ONLY — the platform never rewrites it, so no enforcement
      // action is ever taken. Kept `false` to match the field's meaning everywhere else
      // ("did an enforcement action succeed?", as for `observations` below), NOT
      // "is the region within budget?" (use `before <= MEMORY_MD_CURATED_MAX_CHARS`).
      converged: false,
      archived: 0,
    };
    if (curated.before > MEMORY_MD_CURATED_MAX_CHARS) {
      log.warn('knowledge.md CURATED over soft budget at load — reported only, not rewritten', {
        charsBefore: curated.before, cap: MEMORY_MD_CURATED_MAX_CHARS,
        hardCap: MEMORY_MD_CURATED_HARD_MAX_CHARS, store: this.getStoreFileName(),
      });
    }

    // ── Budget 2: observation buffer (NOT injected, searched on demand) ────
    // Measured by the CANONICAL payload size (see `observationPayloadChars`) so
    // the trigger, the trimmer and the health banner all speak about ONE quantity.
    // The old trigger read the on-disk slice while the trimmer used a hand-rolled
    // per-entry estimate; the two straddled the cap and the trim became a no-op (H12).
    // §24 (R2+R4) — REPORT ONLY. The platform no longer evicts or archives on the agent's
    // behalf: the buffer is the agent's own scratch log, and choosing what to drop is the
    // agent's decision (`memory_organize` / `memory_update mode:"delete"`). The single hard
    // enforcement point is the append path (`addEntry`), which REFUSES past
    // MEMORY_OBSERVATIONS_HARD_MAX_CHARS instead of silently moving older entries.
    const obsBefore = this.observationPayloadChars();
    const observations = {
      before: obsBefore,
      after: obsBefore,
      converged: obsBefore <= MEMORY_OBSERVATIONS_MAX_CHARS,
      archived: 0,
    };
    if (obsBefore > MEMORY_OBSERVATIONS_MAX_CHARS) {
      log.warn('observation buffer over the ADVISORY line — reported only (agent decides)', {
        chars: obsBefore,
        advisory: MEMORY_OBSERVATIONS_MAX_CHARS,
        hardCeiling: MEMORY_OBSERVATIONS_HARD_MAX_CHARS,
        entries: this.entries.length,
        store: this.getStoreFileName(),
      });
    }

    return { curated, observations };
  }

  /**
   * The exact set of entries that will be written into `## _observations`: the
   * per-pool COUNT cap (500 newest observations) plus the empty-content filter.
   * Kept in ONE place so the measured size and the written size can never diverge.
   * (H16: session fragments are their OWN pool/file and are NOT part of this set.)
   */
  private observationWriteSet(): MemoryEntry[] {
    return this.entries
      .filter(e => e.content.trim().length > 0)
      .slice(-MemoryStore.MAX_MEMORY_ENTRIES);
  }

  /**
   * Canonical size (chars) of the observation buffer = the **payload** the agent authored
   * (sum of entry bodies), NOT the container's serialized length.
   *
   * H25 — the measure must be INVARIANT under a change of container. H24 moved observations
   * from in-band markdown into `observations.json`, and this function was switched to
   * `serializeRecords(...).length` at the same time. The cap (`MEMORY_OBSERVATIONS_MAX_CHARS`)
   * was calibrated for markdown, so the same knowledge suddenly measured ~37% larger
   * (indentation + repeated keys + quotes): measured on real data, 34 entries were
   * 25 716 chars (86%, healthy) under markdown but 35 182 (117%, over) under pretty JSON —
   * and the load-time trimmer therefore **silently evicted** observations that were healthy
   * before the format change (observed in the boot log: 10 agents archived 1–6 each).
   *
   * Measuring the payload makes capacity independent of how we persist it: a future format
   * change can never again decide by itself which knowledge stays live. The count cap
   * (`MAX_MEMORY_ENTRIES`) remains the structural bound on entry count.
   */
  private observationPayloadChars(): number {
    return this.observationWriteSet().reduce((sum, e) => sum + e.content.length, 0);
  }

  // §24 — `trimObservationBufferToCap()` was REMOVED together with the archive pool.
  //
  // It archived the OLDEST observations whenever the buffer passed its cap. Two things were
  // wrong with that, and both are structural rather than incidental:
  //   1. R4 — the platform decided, silently, what the agent gets to keep. "Lossless" is not
  //      the same as "harmless": the live set shrank without the agent acting.
  //   2. R2 — it made capacity depend on the MEASUREMENT. When the container changed
  //      (markdown → JSON) the same entries measured ~37% larger, so a format change alone
  //      evicted healthy history (H25, observed: 10 agents archived 1–6 entries at boot).
  // The replacement is a single, honest point: `addEntry` refuses at
  // MEMORY_OBSERVATIONS_HARD_MAX_CHARS and moves nothing.

  // ─── H16: session-compaction fragments (their OWN pool + file) ──────────────
  //
  // A conversation fragment is the platform's compaction pagination payload, not an
  // agent observation. It lives in `session-fragments.md` with its OWN budget, is
  // NOT injected, and is NOT fed to the dream cycle — see MEMORY_FRAGMENTS_MAX_CHARS.

  /** Entries written to `session-fragments.md`: newest N, empty-content filtered. */
  private fragmentWriteSet(): MemoryEntry[] {
    return this.fragments
      .filter(e => e.type === 'conversation_fragment' && e.content.trim().length > 0)
      .slice(-MemoryStore.MAX_MEMORY_ENTRIES);
  }

  /**
   * Canonical size (chars) of the fragment pool — payload only, same H25 invariant as
   * `observationPayloadChars`: the cap must not move when the container changes.
   */
  private fragmentPayloadChars(): number {
    return this.fragmentWriteSet().reduce((sum, e) => sum + e.content.length, 0);
  }

  /**
   * Losslessly trim `session-fragments.md` to `MEMORY_FRAGMENTS_MAX_CHARS`: the
   * OLDEST fragments are appended verbatim to `session-fragments-archive.md`, which
   * `retrieveFragments` also searches — so pagination stays recoverable.
   */
  private trimFragmentsToCap(): { archived: number; converged: boolean } {
    let archived = 0;
    while (this.fragmentPayloadChars() > MEMORY_FRAGMENTS_MAX_CHARS && this.fragments.length > 1) {
      const oldest = this.fragments.shift();
      if (!oldest) break;
      this.archiveFragment(oldest);
      archived++;
    }
    return { archived, converged: this.fragmentPayloadChars() <= MEMORY_FRAGMENTS_MAX_CHARS };
  }

  /** Append one fragment to the JSON archive (lossless, idempotent, deduped by id). */
  private archiveFragment(entry: MemoryEntry): void {
    this.appendRecords(this.fragmentArchiveFile, [entry]);
  }

  /**
   * H24 — append to a JSON record archive. Read + push + atomic write (rather than a raw text
   * append) is what makes a JSON array safe: the array structure is JSON's, so no payload can ever
   * end a record early. Deduped by id ⇒ idempotent.
   */
  private appendRecords(file: string, entries: MemoryEntry[]): void {
    try {
      const existing = existsSync(file) ? parseRecords(readFileSync(file, 'utf-8')).entries : [];
      const seen = new Set(existing.map(e => e.id));
      const merged = [...existing, ...entries.filter(e => !seen.has(e.id))];
      writeFileAtomic(file, serializeRecords(merged));
    } catch (err) {
      log.warn('Failed to append to record archive', { file: basename(file), error: String(err) });
    }
  }

  /** Fragments that overflowed into the archive — still searchable via session_retrieve. */
  private archivedFragmentEntries(): MemoryEntry[] {
    try {
      if (!existsSync(this.fragmentArchiveFile)) return [];
      return parseRecords(readFileSync(this.fragmentArchiveFile, 'utf-8')).entries
        .filter(e => e.type === 'conversation_fragment');
    } catch {
      return [];
    }
  }

  /**
   * H13/H20/H21 — repair the residue of the retired whole-file compression bug.
   *
   * The rules (deterministic, conservative, never-guess, idempotent) live in
   * `residue-repair.ts`; this method is the orchestrator. It heals three regions:
   *   1. the CURATED region — the part injected into every prompt (H21). A stub here is the
   *      worst case: the agent's live knowledge shows an EMPTY section behind a pointer line,
   *      which H20 (entry pools only) never touched — measured: 65 stubs across 25 agents.
   *   2. the observation pool,  3. the fragment pool.
   * Whatever changed is persisted here. Ambiguous (duplicate archive name) or unmatched
   * stubs are left untouched and REPORTED — the content is still in the archive, searchable.
   */
  repairStubResidue(): ResidueRepairReport {
    const report: ResidueRepairReport = {
      repaired: 0, ambiguous: [], notFound: [],
      curatedChanged: false, entriesChanged: false, fragmentsChanged: false,
    };

    let archive = '';
    try {
      if (existsSync(this.longTermArchiveFile)) archive = readFileSync(this.longTermArchiveFile, 'utf-8');
    } catch { return report; }
    const bodies = indexArchiveBodies(archive);
    if (bodies.size === 0) return report;

    const acc = { ambiguous: new Map<string, number>(), notFound: new Set<string>() };

    // 1) Curated region — read as raw text (that is how `saveToDisk` preserves it).
    let curated = '';
    let curatedRaw = '';
    try {
      if (existsSync(this.longTermFile)) curatedRaw = readFileSync(this.longTermFile, 'utf-8');
    } catch { /* unreadable — nothing to heal */ }
    if (curatedRaw) {
      curated = splitKnowledgeSections(curatedRaw).curated;
      const healed = healStubLines(curated, bodies);
      accumulateResidue(acc, healed.result);
      if (healed.result.repaired > 0) {
        curated = healed.text;
        report.curatedChanged = true;
        report.repaired += healed.result.repaired;
      }
    }

    // 2) Observation entries.
    for (const entry of this.entries) {
      const healed = healStubLines(entry.content, bodies);
      accumulateResidue(acc, healed.result);
      if (healed.result.repaired > 0) {
        entry.content = healed.text;
        report.entriesChanged = true;
        report.repaired += healed.result.repaired;
      }
    }

    // 3) Conversation fragments (their own file since H16).
    for (const fragment of this.fragments) {
      const healed = healStubLines(fragment.content, bodies);
      accumulateResidue(acc, healed.result);
      if (healed.result.repaired > 0) {
        fragment.content = healed.text;
        report.fragmentsChanged = true;
        report.repaired += healed.result.repaired;
      }
    }

    // H27 — persist through the CANONICAL writers only.
    //
    // The old code did `writeFileAtomic(knowledge.md, curated + serializeObservationBuffer(entries))`,
    // i.e. it re-serialized the RETIRED in-band container. Two consequences, both real:
    //   1. it resurrected the very `## _observations` region the H24/H26 migration had just
    //      removed from knowledge.md (observed: after a load, a legacy region reappeared next to
    //      a fresh observations.json — two containers for one fact);
    //   2. it never updated observations.json, so on the next load the JSON (still holding the
    //      un-repaired stub) won, and the repair was **silently discarded** — knowledge.md is no
    //      longer the source of truth for observations.
    // One fact ⇒ one writer. (Same defect class as H4/H12: a second writer of the same state.)
    if (report.entriesChanged) {
      this.saveToDisk(); // → observations.json (+ curated.md), the canonical pair
    }
    if (report.curatedChanged) {
      // curated is STILL markdown — it is the injected, human-readable region. Write it via the
      // single writer (curated ONLY: never an observation region).
      this.writeKnowledgeMd(curated);
    }
    if (report.fragmentsChanged) this.saveFragmentsToDisk();

    report.ambiguous = [...acc.ambiguous.entries()].map(([name, candidates]) => ({ name, candidates }));
    report.notFound = [...acc.notFound];
    if (report.repaired > 0) {
      log.warn('H13 residue repaired — re-inlined archived bodies (H21: curated region included)', {
        repaired: report.repaired, curatedChanged: report.curatedChanged,
        entriesChanged: report.entriesChanged, fragmentsChanged: report.fragmentsChanged,
        store: this.getStoreFileName(), archive: this.getArchiveFileName(),
      });
    }
    if (report.ambiguous.length > 0 || report.notFound.length > 0) {
      log.warn('H13 residue remains — left untouched (never guess); content still searchable in the archive', {
        ambiguous: report.ambiguous.slice(0, 20), notFound: report.notFound.slice(0, 20),
        store: this.getStoreFileName(),
      });
    }
    return report;
  }

  private loadFragmentsFromDisk(): void {
    try {
      if (existsSync(this.fragmentFile)) {
        const { entries, error } = parseRecords(readFileSync(this.fragmentFile, 'utf-8'));
        if (error) {
          log.error('session-fragments.json unreadable — NOT overwriting it; starting empty', {
            error, file: basename(this.fragmentFile),
          });
        }
        this.fragments = entries.filter(e => e.type === 'conversation_fragment' && e.content.trim().length > 0);
        if (this.fragments.length > 0) {
          log.info(`Loaded ${this.fragments.length} session fragments from ${basename(this.fragmentFile)}`);
        }
        return;
      }
      // ── LEGACY MIGRATION ONLY (delete once every agent has migrated; docs §20) ──
      // Read the retired in-band markdown container exactly once and re-persist it as JSON.
      const legacy = join(this.dataDir, 'session-fragments.md');
      if (!existsSync(legacy)) return;
      const region = extractFragmentRegion(readFileSync(legacy, 'utf-8'));
      this.fragments = this.parseEntryBlocks(region, 'frag_\\S*')
        .filter(e => e.type === 'conversation_fragment' && e.content.trim().length > 0);
      this.saveFragmentsToDisk();
      try { unlinkSync(legacy); } catch { /* best effort removal after a successful JSON write */ }
      log.info('H24: migrated session fragments from markdown to JSON', {
        count: this.fragments.length, file: basename(this.fragmentFile),
      });
    } catch (err) {
      log.warn('Failed to load session fragments', { error: String(err) });
    }
  }

  private saveFragmentsToDisk(): void {
    try {
      this.trimFragmentsToCap();
      this.fragments = this.fragmentWriteSet();
      writeFileAtomic(this.fragmentFile, serializeRecords(this.fragments));
    } catch (err) {
      log.warn('Failed to save session fragments', { error: String(err) });
    }
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
  /**
   * H26 — is the retired in-band `## _observations` region present in knowledge.md?
   * Used to decide whether the one-time migration to `observations.json` still has work to do,
   * independently of whether the buffer happens to be over budget.
   */
  private hasLegacyObservationRegion(): boolean {
    try {
      if (!existsSync(this.longTermFile)) return false;
      return /(?:^|\n)## _observations\n/.test(readFileSync(this.longTermFile, 'utf-8'));
    } catch {
      return false;
    }
  }

  private parseObservationsFromMemoryMd(): MemoryEntry[] {
    if (!existsSync(this.longTermFile)) return [];
    try {
      const content = readFileSync(this.longTermFile, 'utf-8');
      const obsMatch = content.match(/(?:^|\n)## _observations\n([\s\S]*)$/);
      if (!obsMatch) return [];
      return this.parseEntryBlocks(obsMatch[1]!);
    } catch (err) {
      log.warn('Failed to parse observations from knowledge.md', { error: String(err) });
      return [];
    }
  }

  /**
   * Parse `### <id>` entry blocks (with `<!-- type: … -->` meta comments) from a region
   * body. Shared by the observation region, the session-fragment region AND the fragment
   * archive — so all three round-trip through the SAME reader (no format drift).
   */
  private parseEntryBlocks(obsContent: string, boundaryId = '\\S+'): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    // H17 — the boundary is anchored on the MACHINE-emitted meta comment, not on a bare
    // `### ` heading. `### ` is markdown H3, which an agent-authored body can freely
    // contain; splitting on it silently truncated the entry and fabricated a phantom
    // entry (same class as H13: `## ` misread inside a body). The single writer,
    // `serializeEntryLines`, ALWAYS emits `### <id>` followed by `<!-- type: … -->`, so
    // requiring that shape is exact for every byte this store writes — and a plain
    // `### heading` inside a body no longer matches. See docs §13.
    const subsections = obsContent.split(new RegExp(`\\n### (?=${boundaryId}\\n<!-- type: )`)).filter(s => s.trim());
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
          // H18: the meta comment is emitted by `serializeEntryLines` at a FIXED
          // position — the line immediately after `### <id>` — so ONLY that line is
          // metadata. A body line that merely *looks* like a meta comment is payload
          // and must be preserved verbatim: the old reader matched `<!-- type: … -->`
          // on ANY line, so an agent write that contained such a line had it silently
          // consumed (it could overwrite the entry's type, and when it was the entry's
          // only body line the whole entry was dropped as "empty"). Same class as H13/H17:
          // a structural token the payload can also produce. Anchor it, don't pattern-match it.
          const metaMatch = i === 1
            ? lines[i].match(/^<!-- type: (\w+)(?:, tags: (.*?))?(?:, data-meta: (.+))? -->$/)
            : null;
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
          contentLines.push(decodeEntryBodyLine(lines[i]));
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
      // §24 — write exactly what the agent has. NO trimming here: eviction silently moved
      // the agent's own history and made "what stays live" depend on the storage container
      // (H25: the same entries measured 25 716 chars as markdown vs 35 182 as pretty JSON,
      // so a format change alone evicted healthy data). The only enforcement point is
      // `addEntry`, which REFUSES past the hard ceiling.
      const entries = this.observationWriteSet();
      this.entries = entries;

      // H24 — observations → JSON records; structure is JSON's, not markdown's.
      writeFileAtomic(this.observationFile, serializeRecords(entries));
      this.writeCuratedKnowledgeMd();
    } catch (err) {
      log.warn('Failed to save observations', { error: String(err) });
    }
  }

  /**
   * H24 — `knowledge.md` now holds ONLY the curated region (the injected, human-readable part) plus
   * a pointer comment. If a legacy `## _observations` region is still present, everything from it on
   * is dropped — that content already lives in `observations.json`.
   */
  private writeCuratedKnowledgeMd(): void {
    let existing = '';
    try {
      if (existsSync(this.longTermFile)) existing = readFileSync(this.longTermFile, 'utf-8');
    } catch { /* unreadable — treat as empty */ }
    this.writeKnowledgeMd(existing);
  }

  /**
   * I1 — the SINGLE writer of `knowledge.md`.
   *
   * Every path that persists curated knowledge funnels through here, so "what is in
   * knowledge.md" is decided in exactly one place: the R1 defect (one fact, several writers)
   * is no longer expressible. It enforces the post-migration contract — the file holds the
   * CURATED region ONLY; anything from a legacy in-band `## _observations` region is dropped,
   * because that content lives in `observations.json` since H24 (§20). Bootstrap creation of
   * the file (`ensureKnowledgeFile`) is separate: it only ever runs when the file is absent.
   *
   * A trailing pointer comment is deliberately NOT written: the curated region is injected into
   * every prompt, so a comment after the last `## section` would be absorbed into that section's
   * body and injected with it. Where observations went is documented in
   * docs/PLATFORM-HARDENING-2026-10.md §20 and visible as observations.json next to the file.
   */
  private writeKnowledgeMd(text: string): void {
    const curated = splitKnowledgeSections(text).curated.trimEnd();
    writeFileAtomic(this.longTermFile, curated ? `${curated}\n` : '');
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
  // H19 — `compressLongTermMemory()` was REMOVED. It silently archived the LARGEST curated
  // section bodies into knowledge-archive.md and left pointer stubs: value-blind,
  // invisible to the agent, inconsistent with the per-section "never silently truncated"
  // policy, and the root cause of the H13 corruption (it scanned the WHOLE file, so an
  // observation body containing `## ` was misread as a curated section and gutted).
  // Measured: it never legitimately fired — 0 of 94 agents ever exceeded the soft budget.
  // The contract is now explicit: over the SOFT budget → REPORT only; over the HARD
  // ceiling → REFUSE the write (see `addLongTermMemory`); the agent consolidates with its
  // own tools (`memory_organize` / `memory_update`). See docs §15.
}

function formatTags(metadata?: Record<string, unknown>): string {
  const tags = metadata?.tags;
  return Array.isArray(tags) ? tags.map(String).join(' ') : '';
}

/**
 * Split a `knowledge.md` body into its two budgeted parts.
 *
 * Invariant (see `saveToDisk`): `## _observations` is always LAST, so everything
 * from that marker onward is the observation buffer and everything before it is
 * the curated (injected) part. Measuring the two together is what made the health
 * percentage read >100% for a healthy agent — see `MemoryHealth`.
 */
/**
 * Serialize the `## _observations` section EXACTLY as it is written to disk.
 *
 * This is THE canonical definition of the observation buffer's size — the writer,
 * the trimmer and the health report all measure `serializeObservationBuffer(entries).length`,
 * so the number shown to an agent and the number enforced can never drift apart.
 * (H12: `OBSERVATION_ENTRY_OVERHEAD_CHARS` was exactly such a drift.)
 */
/** Header line of the session-fragment region — fragments live in their OWN file (H16). */
export const FRAGMENT_REGION_HEADER = '## _session_fragments';

/**
 * H23 — close the in-band-container family (H13/H17/H18/H22) at the FORMAT level.
 *
 * The entry boundary is a line `### <id>` followed by a meta comment. `### ` is markdown H3 and
 * `<!-- … -->` is markdown, so an agent-authored body can produce both — measured in the live org:
 * `### 团队协调与通信路由` + `<!-- type: note -->` inside a conversation fragment (a context dump)
 * was read as a record boundary, which TRUNCATED the real fragment by 2501 chars on load and then
 * persisted the truncation. Shape heuristics (H17/H18) cannot fix this: the payload and a record are
 * textually identical.
 *
 * Fix, in two independent halves:
 *   1. WRITE — `escapeEntryBodyLine` prefixes a body line that starts with `\`, `### ` or `<!-- `
 *      with one backslash, so a payload can never emit a structural-looking line. `decodeEntryBodyLine`
 *      reverses it exactly. This is the structural guarantee (forward-safe for ANY payload).
 *   2. READ  — `parseEntryBlocks` keeps accepting the machine-emitted shape for ANY id: ids are
 *      caller-supplied and NOT shape-constrained in this codebase (measured in-tree: `o1`, `marker-0`,
 *      `test-role`), so an id-shape rule would silently drop real entries — it broke 3 existing tests
 *      when tried. Escaping is therefore what closes the family going forward. The ONE pool whose ids
 *      the store fully owns is session fragments (written only as `frag_<ts>_<sessionId>`), so that pool
 *      additionally anchors on the `frag_` prefix — which recovers fragment files damaged before the
 *      escape existed. Legacy observation-pool forgeries are REPORTED, never guessed (see §19).
 */
export function escapeEntryBodyLine(line: string): string {
  return /^(\\|### |<!-- )/.test(line) ? `\\${line}` : line;
}

/** Reverse of `escapeEntryBodyLine`. Identity on lines the writer never escaped (all legacy data). */
export function decodeEntryBodyLine(line: string): string {
  return /^(\\\\|\\### |\\<!-- )/.test(line) ? line.slice(1) : line;
}

/** Serialize the per-entry lines (`### id` + meta comment + body + blank). */
function serializeEntryLines(entries: MemoryEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`### ${entry.id}`);
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
    lines.push(`<!-- type: ${entry.type}${metaJson ? `, data-meta: ${metaJson}` : ''} -->`);
    // H23 — escape body lines that could be mistaken for structure (boundary or meta).
    lines.push(...entry.content.split('\n').map(escapeEntryBodyLine));
    lines.push('');
  }
  return lines;
}

/**
 * LEGACY markdown serialization of the `## _observations` region (the retired H24 container).
 *
 * NOT a production path: since H24 observations are written as JSON records, and H27 removed the
 * last caller that re-serialized this region. It is kept ONLY because the migration reader still
 * has to parse historical markdown, and the regression suites use it to build legacy fixtures.
 * Delete together with `parseObservationsFromMemoryMd` once every agent has migrated (docs §20).
 */
export function serializeObservationBuffer(entries: MemoryEntry[]): string {
  return [
    '## _observations',
    '<!-- This section is the observation buffer. Searched on-demand, NOT always injected into prompt. -->',
    '<!-- Dream cycle consolidates recurring patterns into curated sections above. -->',
    '',
    ...serializeEntryLines(entries),
  ].join('\n');
}

/** Serialize the `## _session_fragments` region EXACTLY as it is written to disk. */
export function serializeFragmentRegion(entries: MemoryEntry[]): string {
  return [
    FRAGMENT_REGION_HEADER,
    '<!-- Platform-managed session compaction pagination payload; NOT agent knowledge. -->',
    '<!-- Not injected into the prompt and NOT consolidated by the dream cycle. -->',
    '<!-- Search on demand via session_retrieve; recover verbatim via session_include. -->',
    '',
    ...serializeEntryLines(entries),
  ].join('\n');
}

/** Drop the leading `## _session_fragments` header line (if present) before parsing. */
export function extractFragmentRegion(content: string): string {
  if (content.startsWith(FRAGMENT_REGION_HEADER)) {
    const nl = content.indexOf('\n');
    return nl >= 0 ? content.slice(nl + 1) : '';
  }
  return content;
}

export function splitKnowledgeSections(content: string): { curated: string; observations: string } {
  const idx = content.indexOf('\n## _observations');
  if (idx >= 0) return { curated: content.slice(0, idx), observations: content.slice(idx) };
  if (content.startsWith('## _observations')) return { curated: '', observations: content };
  return { curated: content, observations: '' };
}

/** Outcome of enforcing both memory budgets at load/write time. */
export interface MemoryBudgetEnforcement {
  curated: { before: number; after: number; converged: boolean; archived: number };
  observations: { before: number; after: number; converged: boolean; archived: number };
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
