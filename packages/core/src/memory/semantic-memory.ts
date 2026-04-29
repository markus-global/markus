/**
 * semantic-memory.ts — Semantic Memory layer
 *
 * Stores factual knowledge (MEMORY.md) and observations (memory_save entries).
 * Implements ISemanticMemory interface.
 *
 * Key behaviours:
 * - MEMORY.md is read/written as the long-term knowledge base
 * - Observations are kept in-memory and periodically consolidated
 * - Consolidation merges duplicate/expired observations, promotes to MEMORY.md
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@markus/shared';
import type {
  ISemanticMemory,
  MemoryEntry,
  MemorySearchOptions,
  ConsolidationResult,
  MemoryStats,
} from './interfaces.js';

const log = createLogger('semantic-memory');

// =============================================================================
// Defaults & constants
// =============================================================================

const VALID_TYPES = new Set(['fact', 'note', 'observation', 'task_result', 'conversation']);
const DEFAULT_OBSERVATION_FILE = 'memories.json';
const SECTION_HEADER_REGEX = /^## (.+)$/m;

// =============================================================================
// SemanticMemory
// =============================================================================

export class SemanticMemory implements ISemanticMemory {
  private dataDir: string;
  private memoryMdPath: string;
  private entries: MemoryEntry[] = [];
  private agentId: string;

  constructor(config: { dataDir: string; agentId?: string }) {
    this.dataDir = config.dataDir;
    this.agentId = config.agentId ?? 'default-agent';
    this.memoryMdPath = join(this.dataDir, 'MEMORY.md');
    mkdirSync(this.dataDir, { recursive: true });
    this.loadFromDisk();
  }

  // ---------------------------------------------------------------------------
  // Core CRUD
  // ---------------------------------------------------------------------------

  async save(
    entry: Omit<MemoryEntry, 'id' | 'timestamp'> & { agentId?: string },
  ): Promise<MemoryEntry> {
    const saved: MemoryEntry = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: this.normalizeType(entry.type),
      content: entry.content ?? '',
      timestamp: new Date().toISOString(),
      tags: entry.tags,
      agentId: entry.agentId ?? 'default-agent',
      source: entry.source,
      metadata: entry.metadata,
    };
    this.entries.push(saved);
    this.saveToDisk();
    return saved;
  }

  async search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]> {
    if (!query) return [];
    const lower = query.toLowerCase();
    let results = this.entries.filter((e) => e.content.toLowerCase().includes(lower));

    if (opts?.type) {
      results = results.filter((e) => e.type === opts.type);
    }
    if (opts?.tags && opts.tags.length > 0) {
      results = results.filter((e) =>
        e.tags?.some((t) => opts.tags!.includes(t)),
      );
    }
    if (opts?.agentId) {
      results = results.filter((e) => e.agentId === opts.agentId);
    }
    if (opts?.offset) {
      results = results.slice(opts.offset);
    }
    if (opts?.limit && opts.limit > 0) {
      results = results.slice(0, opts.limit);
    }
    return results;
  }

  async list(
    type?: MemoryEntry['type'],
    limit?: number,
  ): Promise<MemoryEntry[]> {
    let results = type
      ? this.entries.filter((e) => e.type === type)
      : [...this.entries];
    if (limit && limit > 0) {
      results = results.slice(0, limit);
    }
    return results;
  }

  async getByTag(tag: string, limit?: number): Promise<MemoryEntry[]> {
    if (!tag) return [];
    let results = this.entries.filter((e) => e.tags?.includes(tag));
    if (limit && limit > 0) {
      results = results.slice(0, limit);
    }
    return results;
  }

  async remove(ids: string[]): Promise<number> {
    if (!ids || ids.length === 0) return 0;
    const idSet = new Set(ids);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !idSet.has(e.id));
    const removed = before - this.entries.length;
    if (removed > 0) this.saveToDisk();
    return removed;
  }

  async replace(
    removedIds: string[],
    newEntry: Omit<MemoryEntry, 'id' | 'timestamp'> & { agentId?: string },
  ): Promise<{ removed: MemoryEntry[]; created: MemoryEntry }> {
    const removed: MemoryEntry[] = [];
    if (removedIds && removedIds.length > 0) {
      const idSet = new Set(removedIds);
      for (const e of this.entries) {
        if (idSet.has(e.id)) removed.push(e);
      }
      this.entries = this.entries.filter((e) => !idSet.has(e.id));
    }
    const created = await this.save(newEntry);
    return { removed, created };
  }

  // ---------------------------------------------------------------------------
  // MEMORY.md access
  // ---------------------------------------------------------------------------

  async getKnowledgeMd(): Promise<string> {
    if (!existsSync(this.memoryMdPath)) return '';
    return readFileSync(this.memoryMdPath, 'utf-8');
  }

  async getSection(section: string): Promise<string | null> {
    if (!section) return null;
    const content = await this.getKnowledgeMd();
    if (!content) return null;
    const escaped = this.escapeRegex(section);
    const re = new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |\\n*$)`);
    const match = content.match(re);
    return match?.[1]?.trim() ?? null;
  }

  async updateSection(section: string, content: string): Promise<void> {
    if (!section || content === undefined || content === null) return;
    let existing = '';
    if (existsSync(this.memoryMdPath)) {
      existing = readFileSync(this.memoryMdPath, 'utf-8');
    }
    const sectionHeader = `## ${section}`;
    const escaped = this.escapeRegex(section);
    const sectionRegex = new RegExp(
      `(## ${escaped})\\n[\\s\\S]*?(?=\\n## |\\n*$)`,
    );
    let updated: string;
    if (existing.includes(sectionHeader)) {
      updated = existing.replace(
        sectionRegex,
        `${sectionHeader}\n${content}`,
      );
    } else {
      updated = existing
        ? `${existing}\n\n${sectionHeader}\n${content}\n`
        : `${sectionHeader}\n${content}\n`;
    }
    writeFileSync(this.memoryMdPath, updated, 'utf-8');
    log.debug('MEMORY.md section updated', { section });
  }

  // ---------------------------------------------------------------------------
  // Consolidation (dream cycle)
  // ---------------------------------------------------------------------------

  async consolidate(
    opts?: { minSimilarity?: number; minCount?: number },
  ): Promise<ConsolidationResult> {
    const removed: MemoryEntry[] = [];
    const merged: MemoryEntry[] = [];
    const promoted: MemoryEntry[] = [];

    // Step 1: Find all observations
    const observations = this.entries.filter((e) => e.type === 'observation');
    if (observations.length === 0) {
      return { promoted: 0, pruned: 0 };
    }

    const minSimilarity = opts?.minSimilarity ?? 0.5;
    const minCount = opts?.minCount ?? 3;

    // Group observations by content similarity
    const groups = new Map<string, MemoryEntry[]>();
    for (const obs of observations) {
      let matched = false;
      for (const [key, group] of groups) {
        const sim = this.stringSimilarity(key, obs.content);
        if (sim >= minSimilarity) {
          group.push(obs);
          matched = true;
          break;
        }
      }
      if (!matched) {
        groups.set(obs.content, [obs]);
      }
    }

    // Remove all observations
    const obsIds = observations.map((e) => e.id);
    this.entries = this.entries.filter(
      (e) => !obsIds.includes(e.id),
    );

    // Groups with minCount+ observations become consolidated entries
    let promotedCount = 0;
    for (const [, group] of groups) {
      if (group.length >= minCount) {
        const mergedContent = group
          .map((o) => o.content)
          .filter(Boolean)
          .join('\n');
        if (mergedContent) {
          const mergedEntry: MemoryEntry = {
            id: `cons-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: 'note',
            content: mergedContent.slice(0, 5000),
            timestamp: new Date().toISOString(),
            tags: ['consolidated'],
            agentId: this.agentId,
            source: 'consolidation',
          };
          this.entries.push(mergedEntry);
          promotedCount++;
        }
      }
    }

    // Promote to MEMORY.md if any were consolidated
    if (promotedCount > 0) {
      const promotedLines = observations
        .filter((e) => e.content && e.content.length > 20)
        .slice(0, 3)
        .map((e) => `- ${e.content}`)
        .join('\n');
      if (promotedLines) {
        const existingMd = await this.getKnowledgeMd();
        if (existingMd.includes('## consolidated-insights')) {
          await this.updateSection('consolidated-insights', `${promotedLines}\n`);
        } else {
          const updated = existingMd
            ? `${existingMd}\n\n## consolidated-insights\n${promotedLines}\n`
            : `## consolidated-insights\n${promotedLines}\n`;
          writeFileSync(this.memoryMdPath, updated, 'utf-8');
        }
      }
    }

    this.saveToDisk();
    log.debug('Consolidation complete', {
      pruned: observations.length,
      promoted: promotedCount,
    });
    return { promoted: promotedCount, pruned: observations.length };
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  async getStats(): Promise<MemoryStats> {
    const byType: Record<string, number> = {};
    for (const e of this.entries) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
    }
    const serialized = JSON.stringify(this.entries);
    return {
      totalEntries: this.entries.length,
      byType,
      sizeBytes: new TextEncoder().encode(serialized).length,
      dataDir: this.dataDir,
      agentId: this.agentId,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Simple string similarity using bigram overlap (Dice coefficient).
   */
  private stringSimilarity(a: string, b: string): number {
    const bigrams = (s: string): Set<string> => {
      const bg = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) {
        bg.add(s.slice(i, i + 2));
      }
      return bg;
    };

    const bgA = bigrams(a);
    const bgB = bigrams(b);
    if (bgA.size === 0 && bgB.size === 0) return 1;
    let intersection = 0;
    for (const bg of bgA) {
      if (bgB.has(bg)) intersection++;
    }
    const denominator = bgA.size + bgB.size;
    return denominator === 0 ? 0 : (2 * intersection) / denominator;
  }

  private normalizeType(t: string): MemoryEntry['type'] {
    if (VALID_TYPES.has(t)) return t as MemoryEntry['type'];
    return 'note';
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private loadFromDisk(): void {
    const memFile = join(this.dataDir, DEFAULT_OBSERVATION_FILE);
    if (existsSync(memFile)) {
      try {
        const raw = JSON.parse(readFileSync(memFile, 'utf-8')) as unknown[];
        this.entries = raw.filter(this.isValidEntry).map(this.sanitizeEntry);
        log.debug(`Loaded ${this.entries.length} memory entries from disk`);
      } catch {
        log.warn('Failed to load memories.json, starting fresh');
        this.entries = [];
      }
    }
  }

  private saveToDisk(): void {
    try {
      const memFile = join(this.dataDir, DEFAULT_OBSERVATION_FILE);
      writeFileSync(memFile, JSON.stringify(this.entries, null, 2), 'utf-8');
    } catch (err) {
      log.warn('Failed to save memories to disk', { error: String(err) });
    }
  }

  private isValidEntry(raw: unknown): raw is Record<string, unknown> {
    if (typeof raw !== 'object' || raw === null) return false;
    const obj = raw as Record<string, unknown>;
    return typeof obj.id === 'string' && obj.id.length > 0;
  }

  private sanitizeEntry(raw: Record<string, unknown>): MemoryEntry {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id),
      timestamp: typeof r.timestamp === 'string' ? r.timestamp : new Date().toISOString(),
      type: (typeof r.type === 'string' && VALID_TYPES.has(r.type)
        ? r.type
        : 'note') as MemoryEntry['type'],
      content: typeof r.content === 'string' ? r.content : '',
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : undefined,
      agentId: typeof r.agentId === 'string' ? r.agentId : undefined,
      source: typeof r.source === 'string' ? r.source : undefined,
      metadata:
        typeof r.metadata === 'object' && r.metadata !== null
          ? (r.metadata as Record<string, unknown>)
          : undefined,
    };
  }
}
