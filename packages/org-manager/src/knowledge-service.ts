import {
  createLogger,
  generateId,
  type KnowledgeEntry,
  type KnowledgeScope,
  type KnowledgeCategory,
  type KnowledgeStatus,
} from '@markus/shared';
import type { FileKnowledgeStore } from './file-knowledge-store.js';

const log = createLogger('knowledge-service');

export class KnowledgeService {
  private entries = new Map<string, KnowledgeEntry>();
  private fileStore?: FileKnowledgeStore;

  constructor(fileStore?: FileKnowledgeStore) {
    if (fileStore) {
      this.fileStore = fileStore;
      for (const entry of fileStore.loadAll()) {
        this.entries.set(entry.id, entry);
      }
      log.info('Knowledge loaded from file store', { count: this.entries.size });
    }
  }

  /** Returns the absolute file path of a knowledge entry (for agent file_read). */
  getEntryPath(entry: KnowledgeEntry): string | undefined {
    return this.fileStore?.entryPath(entry);
  }

  /** Lookup by ID and return the file path. */
  getEntryFilePath(id: string): string | undefined {
    const entry = this.entries.get(id);
    if (!entry || !this.fileStore) return undefined;
    return this.fileStore.entryPath(entry);
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  contribute(opts: {
    scope: KnowledgeScope;
    scopeId: string;
    category: KnowledgeCategory;
    title: string;
    content: string;
    source: string;
    importance?: number;
    tags?: string[];
    supersedes?: string;
  }): KnowledgeEntry {
    const now = new Date().toISOString();
    const importance = opts.importance ?? 50;
    const autoVerify = importance < 60;

    const entry: KnowledgeEntry = {
      id: generateId('kb'),
      scope: opts.scope,
      scopeId: opts.scopeId,
      category: opts.category,
      title: opts.title,
      content: opts.content,
      tags: opts.tags ?? [],
      source: opts.source,
      importance,
      status: autoVerify ? 'verified' : 'draft',
      supersedes: opts.supersedes,
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.entries.set(entry.id, entry);

    if (opts.supersedes) {
      const old = this.entries.get(opts.supersedes);
      if (old) {
        old.status = 'outdated';
        old.updatedAt = now;
        this.fileStore?.saveEntry(old);
      }
    }

    this.persistScope(entry.scope, entry.scopeId);

    log.info('Knowledge contributed', {
      id: entry.id,
      scope: entry.scope,
      category: entry.category,
      title: entry.title,
    });
    return entry;
  }

  get(id: string): KnowledgeEntry | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      entry.accessCount++;
      entry.lastAccessedAt = new Date().toISOString();
    }
    return entry;
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  search(opts: {
    query: string;
    scope?: KnowledgeScope;
    scopeId?: string;
    category?: KnowledgeCategory;
    limit?: number;
  }): KnowledgeEntry[] {
    const limit = opts.limit ?? 10;
    const queryLower = opts.query.toLowerCase();
    const keywords = queryLower.split(/\s+/).filter(Boolean);

    let results = [...this.entries.values()];

    if (opts.scope) results = results.filter(e => e.scope === opts.scope);
    if (opts.scopeId) results = results.filter(e => e.scopeId === opts.scopeId);
    if (opts.category) results = results.filter(e => e.category === opts.category);

    results = results.filter(e => e.status !== 'outdated');

    if (keywords.length === 0) {
      return results
        .sort((a, b) => b.importance - a.importance || b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    }

    const scored = results.map(entry => {
      const text = `${entry.title} ${entry.content} ${entry.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) score += 1;
        if (entry.title.toLowerCase().includes(kw)) score += 2;
      }
      score += entry.importance / 100;
      if (entry.status === 'verified') score += 0.5;
      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.entry);
  }

  browse(opts: {
    scope: KnowledgeScope;
    scopeId: string;
    category?: KnowledgeCategory;
  }): KnowledgeEntry[] | Record<string, number> {
    const entries = [...this.entries.values()].filter(
      e => e.scope === opts.scope && e.scopeId === opts.scopeId && e.status !== 'outdated'
    );

    if (opts.category) {
      return entries.filter(e => e.category === opts.category);
    }

    const counts: Record<string, number> = {};
    for (const e of entries) {
      counts[e.category] = (counts[e.category] ?? 0) + 1;
    }
    return counts;
  }

  findByScope(
    scope: KnowledgeScope,
    scopeId: string,
    opts?: { status?: KnowledgeStatus; limit?: number; orderBy?: 'importance' | 'date' }
  ): KnowledgeEntry[] {
    let results = [...this.entries.values()].filter(
      e => e.scope === scope && e.scopeId === scopeId
    );
    if (opts?.status) results = results.filter(e => e.status === opts.status);

    if (opts?.orderBy === 'importance') {
      results.sort((a, b) => b.importance - a.importance);
    } else {
      results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    return opts?.limit ? results.slice(0, opts.limit) : results;
  }

  // ─── Status Management ─────────────────────────────────────────────────────

  flagOutdated(id: string, reason: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.status = 'outdated';
    entry.updatedAt = new Date().toISOString();
    this.persistScope(entry.scope, entry.scopeId);
    log.info('Knowledge flagged as outdated', { id, reason });
  }

  flagDisputed(id: string, reason: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.status = 'disputed';
    entry.updatedAt = new Date().toISOString();
    this.persistScope(entry.scope, entry.scopeId);
    log.info('Knowledge flagged as disputed', { id, reason });
  }

  verify(id: string, verifiedBy: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.status = 'verified';
    entry.verifiedBy = verifiedBy;
    entry.updatedAt = new Date().toISOString();
    this.persistScope(entry.scope, entry.scopeId);
    log.info('Knowledge verified', { id, verifiedBy });
  }

  // ─── Metrics ───────────────────────────────────────────────────────────────

  getContributions(scopeId: string, periodStart: Date, periodEnd: Date): KnowledgeEntry[] {
    return [...this.entries.values()].filter(e => {
      const created = new Date(e.createdAt);
      return e.scopeId === scopeId && created >= periodStart && created <= periodEnd;
    });
  }

  getTotalCount(scope: KnowledgeScope, scopeId: string): number {
    return [...this.entries.values()].filter(
      e => e.scope === scope && e.scopeId === scopeId && e.status !== 'outdated'
    ).length;
  }

  // ─── Persistence helpers ───────────────────────────────────────────────────

  private persistScope(scope: string, scopeId: string): void {
    if (!this.fileStore) return;
    const scopeEntries = [...this.entries.values()].filter(
      e => e.scope === scope && e.scopeId === scopeId
    );
    this.fileStore.rebuildIndex(scope, scopeId, scopeEntries);
  }
}
