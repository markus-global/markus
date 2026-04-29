import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ISemanticMemory, MemoryEntry, MemorySearchOptions, ConsolidationResult, MemoryStats } from '../src/memory/interfaces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `mem-${crypto.randomUUID().slice(0, 8)}`,
    type: overrides.type ?? 'fact',
    content: overrides.content ?? '',
    timestamp: overrides.timestamp ?? now,
    tags: overrides.tags,
    agentId: overrides.agentId,
    source: overrides.source,
    metadata: overrides.metadata,
  };
}

function cloneEntry(e: MemoryEntry): MemoryEntry {
  return JSON.parse(JSON.stringify(e));
}

function buildMockStore(): ISemanticMemory {
  let entries: MemoryEntry[] = [];
  let knowledgeMd = '# Markus Knowledge\n\n## Architecture\nThe system is modular.\n\n## Guidelines\nWrite tests first.\n';

  const mock: ISemanticMemory = {
    save: vi.fn(async (entry: Omit<MemoryEntry, 'id' | 'timestamp'> & { agentId?: string }) => {
      const saved: MemoryEntry = {
        ...entry,
        id: `mem-${crypto.randomUUID().slice(0, 8)}`,
        timestamp: new Date().toISOString(),
        agentId: entry.agentId ?? 'default-agent',
      };
      entries.push(saved);
      return saved;
    }),

    search: vi.fn(async (query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]> => {
      let results = entries.filter(e => e.content.toLowerCase().includes(query.toLowerCase()));

      if (opts?.type) {
        results = results.filter(e => e.type === opts.type);
      }
      if (opts?.tags && opts.tags.length > 0) {
        results = results.filter(e => opts.tags!.some(t => e.tags?.includes(t)));
      }
      if (opts?.agentId) {
        results = results.filter(e => e.agentId === opts.agentId);
      }
      if (opts?.limit && opts.limit > 0) {
        results = results.slice(0, opts.limit);
      }
      return results;
    }),

    list: vi.fn(async (type?: MemoryEntry['type'], limit?: number): Promise<MemoryEntry[]> => {
      let results = type ? entries.filter(e => e.type === type) : [...entries];
      if (limit && limit > 0) {
        results = results.slice(0, limit);
      }
      return results;
    }),

    getByTag: vi.fn(async (tag: string, limit?: number): Promise<MemoryEntry[]> => {
      let results = entries.filter(e => e.tags?.includes(tag));
      if (limit && limit > 0) {
        results = results.slice(0, limit);
      }
      return results;
    }),

    remove: vi.fn(async (ids: string[]): Promise<number> => {
      const before = entries.length;
      entries = entries.filter(e => !ids.includes(e.id));
      return before - entries.length;
    }),

    replace: vi.fn(async (removedIds: string[], newEntry: Omit<MemoryEntry, 'id' | 'timestamp'> & { agentId?: string }): Promise<{ removed: MemoryEntry[]; created: MemoryEntry }> => {
      const removed: MemoryEntry[] = entries.filter(e => removedIds.includes(e.id));
      entries = entries.filter(e => !removedIds.includes(e.id));
      const created: MemoryEntry = {
        ...newEntry,
        id: `mem-${crypto.randomUUID().slice(0, 8)}`,
        timestamp: new Date().toISOString(),
        agentId: newEntry.agentId ?? 'default-agent',
        tags: newEntry.tags,
      };
      entries.push(created);
      return { removed, created };
    }),

    getKnowledgeMd: vi.fn(async (): Promise<string> => knowledgeMd),

    getSection: vi.fn(async (section: string): Promise<string | null> => {
      const re = new RegExp(`## ${section}\\n([\\s\\S]*?)(?=\\n## |\\n$|$)`);
      const match = knowledgeMd.match(re);
      return match ? match[1].trim() : null;
    }),

    updateSection: vi.fn(async (section: string, content: string): Promise<void> => {
      const header = `## ${section}`;
      const re = new RegExp(`## ${section}\\n[\\s\\S]*?(?=\\n## |\\n$|$)`, 'm');
      if (re.test(knowledgeMd)) {
        knowledgeMd = knowledgeMd.replace(re, `${header}\n${content}`);
      } else {
        knowledgeMd += `\n${header}\n${content}\n`;
      }
    }),

    getStats: vi.fn(async (): Promise<MemoryStats> => {
      const totalEntries = entries.length;
      const categories = [...new Set(entries.map(e => e.type))];
      const tagCounts: Record<string, number> = {};
      for (const e of entries) {
        for (const t of e.tags ?? []) {
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        }
      }
      const topCategories = categories
        .map(c => ({ category: c, count: entries.filter(e => e.type === c).length }))
        .sort((a, b) => b.count - a.count);
      return {
        totalEntries,
        knowledgeSizeBytes: new TextEncoder().encode(knowledgeMd).length,
        topCategories,
      };
    }),

    consolidate: vi.fn(async (): Promise<ConsolidationResult> => {
      const removed = entries.filter(e => e.type === 'observation');
      entries = entries.filter(e => e.type !== 'observation');
      const merged: MemoryEntry[] = [];
      const promoted: MemoryEntry[] = [];
      if (removed.length >= 2) {
        const content = removed.map(r => r.content).join('; ');
        merged.push({
          id: `mem-${crypto.randomUUID().slice(0, 8)}`,
          type: 'task_result',
          content,
          timestamp: new Date().toISOString(),
          agentId: 'default-agent',
          tags: ['consolidated'],
        });
        entries.push(merged[0]);
      }
      return { removed, merged, promoted };
    }),
  };

  return mock;
}

// Seed helper
async function seedEntries(store: ISemanticMemory, count: number): Promise<MemoryEntry[]> {
  const created: MemoryEntry[] = [];
  for (let i = 0; i < count; i++) {
    const entry = await store.save({
      type: i % 2 === 0 ? 'fact' : 'note',
      content: `Entry ${i}: ${'content '.repeat(i + 1)}`,
      tags: i < 3 ? ['early'] : ['late'],
      agentId: `agent-${i % 2}`,
    });
    created.push(entry);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ISemanticMemory — interface contract', () => {
  let store: ISemanticMemory;

  beforeEach(() => {
    store = buildMockStore();
  });

  // =====================================================================
  // Section 1 — Core Operations: save, search, list
  // =====================================================================


  describe('save()', () => {
    it('returns an entry with id, timestamp, and agentId', async () => {
      const entry = await store.save({
        type: 'fact',
        content: 'The sky is blue.',
        agentId: 'alice',
      });
      expect(entry).toBeDefined();
      expect(entry.id).toBeDefined();
      expect(typeof entry.id).toBe('string');
      expect(entry.id).toMatch(/^mem-/);
      expect(entry.timestamp).toBeDefined();
      expect(typeof entry.timestamp).toBe('string');
      expect(() => new Date(entry.timestamp)).not.toThrow();
      expect(entry.agentId).toBe('alice');
    });

    it('defaults agentId when not provided', async () => {
      const entry = await store.save({
        type: 'fact',
        content: 'Default agent.',
      });
      expect(entry.agentId).toBe('default-agent');
    });

    it('preserves all entry fields through save', async () => {
      const tags = ['typescript', 'testing'];
      const metadata = { priority: 'high', source: 'spec' };
      const entry = await store.save({
        type: 'note',
        content: 'TS interfaces are structural.',
        tags,
        source: 'handbook',
        agentId: 'bob',
        metadata,
      });
      expect(entry.type).toBe('note');
      expect(entry.content).toBe('TS interfaces are structural.');
      expect(entry.tags).toEqual(tags);
      expect(entry.source).toBe('handbook');
      expect(entry.agentId).toBe('bob');
      expect(entry.metadata).toEqual(metadata);
    });

    it('generates unique ids for each save', async () => {
      const a = await store.save({ type: 'fact', content: 'A' });
      const b = await store.save({ type: 'fact', content: 'B' });
      expect(a.id).not.toBe(b.id);
    });

    it('handles empty content gracefully', async () => {
      const entry = await store.save({ type: 'fact', content: '' });
      expect(entry).toBeDefined();
      expect(entry.content).toBe('');
    });

    it('handles very long content', async () => {
      const long = 'x'.repeat(10_000);
      const entry = await store.save({ type: 'fact', content: long });
      expect(entry.content.length).toBe(10_000);
    });
  });

  describe('search()', () => {
    beforeEach(async () => {
      await seedEntries(store, 6);
    });

    it('returns matching entries by content substring', async () => {
      const results = await store.search('Entry 1');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.content.includes('Entry 1'))).toBe(true);
    });

    it('is case-insensitive', async () => {
      await store.save({ type: 'fact', content: 'Hello World' });
      const results = await store.search('hello world');
      expect(results.length).toBe(1);
    });

    it('filters by type', async () => {
      const results = await store.search('Entry', { type: 'fact' });
      expect(results.every(r => r.type === 'fact')).toBe(true);
    });

    it('filters by tags (intersection)', async () => {
      const results = await store.search('Entry', { tags: ['early'] });
      expect(results.every(r => r.tags?.includes('early'))).toBe(true);
    });

    it('filters by agentId', async () => {
      const results = await store.search('Entry', { agentId: 'agent-0' });
      expect(results.every(r => r.agentId === 'agent-0')).toBe(true);
    });

    it('respects limit option', async () => {
      const results = await store.search('Entry', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty array for no match', async () => {
      const results = await store.search('zzzznosuch');
      expect(results).toEqual([]);
    });

    it('combines multiple filters', async () => {
      const results = await store.search('Entry', {
        type: 'fact',
        tags: ['early'],
        agentId: 'agent-0',
        limit: 10,
      });
      expect(results.every(r => r.type === 'fact' && r.agentId === 'agent-0')).toBe(true);
    });
  });

  describe('list()', () => {
    beforeEach(async () => {
      await seedEntries(store, 6);
    });

    it('returns all entries when no type filter', async () => {
      const all = await store.list();
      expect(all.length).toBe(6);
    });

    it('filters by type', async () => {
      const facts = await store.list('fact');
      expect(facts.every(r => r.type === 'fact')).toBe(true);
      const notes = await store.list('note');
      expect(notes.every(r => r.type === 'note')).toBe(true);
    });

    it('returns empty array for non-existent type', async () => {
      const results = await store.list('task_result' as any);
      expect(results).toEqual([]);
    });

    it('respects limit', async () => {
      const limited = await store.list(undefined, 3);
      expect(limited.length).toBe(3);
    });

    it('limit 0 returns all entries (no limit semantics)', async () => {
      await seedEntries(store, 5);
      const allResults = await store.list(undefined);
      const results = await store.list(undefined, 0);
      expect(results.length).toBe(allResults.length);
    });

    it('limit larger than total returns all', async () => {
      const results = await store.list(undefined, 999);
      expect(results.length).toBe(6);
    });
  });

  // =====================================================================
  // Section 2 — remove, replace, MEMORY.md integration
  // =====================================================================

  describe('remove()', () => {
    let ids: string[];

    beforeEach(async () => {
      const entries = await seedEntries(store, 4);
      ids = entries.map(e => e.id);
    });

    it('removes entries by id and returns the count', async () => {
      const count = await store.remove([ids[0], ids[2]]);
      expect(count).toBe(2);
      const remaining = await store.list();
      expect(remaining.length).toBe(2);
    });

    it('returns 0 when ids do not exist', async () => {
      const count = await store.remove(['nonexistent-id']);
      expect(count).toBe(0);
    });

    it('returns 0 for empty array', async () => {
      const count = await store.remove([]);
      expect(count).toBe(0);
    });

    it('removes a single entry', async () => {
      const count = await store.remove([ids[1]]);
      expect(count).toBe(1);
      const remaining = await store.list();
      expect(remaining.find(e => e.id === ids[1])).toBeUndefined();
    });

    it('handles duplicate ids gracefully', async () => {
      const count = await store.remove([ids[0], ids[0]]);
      expect(count).toBe(1);
    });

    it('succeeds when removing all entries', async () => {
      const count = await store.remove(ids);
      expect(count).toBe(4);
      const remaining = await store.list();
      expect(remaining).toEqual([]);
    });
  });

  describe('replace()', () => {
    let entries: MemoryEntry[];

    beforeEach(async () => {
      entries = await seedEntries(store, 3);
    });

    it('removes old entries and creates a new consolidated entry', async () => {
      const removedIds = [entries[0].id, entries[1].id];
      const result = await store.replace(removedIds, {
        type: 'task_result',
        content: 'Consolidated knowledge.',
        tags: ['merged'],
        agentId: 'dream-agent',
      });

      expect(result.removed.length).toBe(2);
      expect(result.removed.map(r => r.id).sort()).toEqual([...removedIds].sort());
      expect(result.created).toBeDefined();
      expect(result.created.id).toMatch(/^mem-/);
      expect(result.created.type).toBe('task_result');
      expect(result.created.agentId).toBe('dream-agent');
      expect(result.created.tags).toEqual(['merged']);

      // Verify old entries are gone
      const all = await store.list();
      expect(all.find(e => e.id === entries[0].id)).toBeUndefined();
      expect(all.find(e => e.id === entries[1].id)).toBeUndefined();
      // New entry exists
      expect(all.find(e => e.id === result.created.id)).toBeDefined();
    });

    it('handles empty removedIds (no removal, just add)', async () => {
      const result = await store.replace([], {
        type: 'note',
        content: 'Just adding.',
      });
      expect(result.removed).toEqual([]);
      expect(result.created).toBeDefined();
      const all = await store.list();
      expect(all.length).toBe(4); // 3 original + 1 new
    });

    it('handles non-existent removedIds gracefully', async () => {
      const result = await store.replace(['fake-id'], {
        type: 'fact',
        content: 'Replace ghost.',
      });
      expect(result.removed).toEqual([]);
      expect(result.created).toBeDefined();
    });

    it('preserves new entry metadata', async () => {
      const result = await store.replace([entries[0].id], {
        type: 'observation',
        content: 'Observed pattern.',
        source: 'analysis',
        metadata: { confidence: 0.95 },
      });
      expect(result.created.source).toBe('analysis');
      expect(result.created.metadata).toEqual({ confidence: 0.95 });
    });
  });

  // =====================================================================
  // MEMORY.md integration
  // =====================================================================

  describe('getKnowledgeMd()', () => {
    it('returns the full knowledge markdown content', async () => {
      const md = await store.getKnowledgeMd();
      expect(md).toContain('# Markus Knowledge');
      expect(md).toContain('## Architecture');
      expect(typeof md).toBe('string');
    });

    it('returns a non-empty string', async () => {
      const md = await store.getKnowledgeMd();
      expect(md.length).toBeGreaterThan(0);
    });
  });

  describe('getSection()', () => {
    it('extracts an existing section', async () => {
      const content = await store.getSection('Architecture');
      expect(content).toContain('The system is modular');
    });

    it('returns null for non-existent section', async () => {
      const content = await store.getSection('NonExistent');
      expect(content).toBeNull();
    });

    it('extracts sections with multi-line content', async () => {
      const content = await store.getSection('Guidelines');
      expect(content).toContain('Write tests first');
    });
  });

  describe('updateSection()', () => {
    it('updates content of an existing section', async () => {
      await store.updateSection('Architecture', 'The system is event-driven.');
      const updated = await store.getSection('Architecture');
      expect(updated).toBe('The system is event-driven.');
    });

    it('creates a new section when it does not exist', async () => {
      await store.updateSection('Deployment', 'Deploy via Docker.');
      const content = await store.getSection('Deployment');
      expect(content).toBe('Deploy via Docker.');
    });

    it('replaces multi-line section content', async () => {
      const multiLine = 'Line 1\nLine 2\nLine 3';
      await store.updateSection('Guidelines', multiLine);
      const content = await store.getSection('Guidelines');
      expect(content).toBe(multiLine);
    });

    it('does not corrupt other sections when updating one', async () => {
      await store.updateSection('Architecture', 'Updated.');
      const guidelines = await store.getSection('Guidelines');
      expect(guidelines).toContain('Write tests first');
    });
  });

  // =====================================================================
  // Section 3 — getStats, consolidate, edge cases
  // =====================================================================

  describe('getStats()', () => {
    it('returns zero stats when no entries exist', async () => {
      const stats = await store.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.knowledgeSizeBytes).toBeGreaterThan(0);
      expect(stats.topCategories).toEqual([]);
    });

    it('reflects entry count correctly', async () => {
      await seedEntries(store, 5);
      const stats = await store.getStats();
      expect(stats.totalEntries).toBe(5);
    });

    it('reports top categories sorted by count descending', async () => {
      await store.save({ type: 'fact', content: 'A' });
      await store.save({ type: 'fact', content: 'B' });
      await store.save({ type: 'fact', content: 'C' });
      await store.save({ type: 'note', content: 'D' });
      await store.save({ type: 'observation', content: 'E' });

      const stats = await store.getStats();
      expect(stats.topCategories.length).toBe(3);
      expect(stats.topCategories[0].category).toBe('fact');
      expect(stats.topCategories[0].count).toBe(3);
    });

    it('knowledgeSizeBytes reflects MEMORY.md size', async () => {
      const before = await store.getStats();
      await store.updateSection('NewSection', 'x'.repeat(500));
      const after = await store.getStats();
      expect(after.knowledgeSizeBytes).toBeGreaterThan(before.knowledgeSizeBytes);
    });

    it('updates stats after remove', async () => {
      const entries = await seedEntries(store, 4);
      await store.remove([entries[0].id]);
      const stats = await store.getStats();
      expect(stats.totalEntries).toBe(3);
    });
  });

  describe('consolidate()', () => {
    it('returns empty result when nothing to consolidate', async () => {
      await store.save({ type: 'fact', content: 'Stable fact' });
      const result = await store.consolidate();
      expect(result.removed).toEqual([]);
      expect(result.merged).toEqual([]);
      expect(result.promoted).toEqual([]);
    });

    it('consolidates observations into merged entries', async () => {
      await store.save({ type: 'observation', content: 'Observed X' });
      await store.save({ type: 'observation', content: 'Observed Y' });
      const result = await store.consolidate();
      expect(result.removed.length).toBe(2);
      expect(result.merged.length).toBeGreaterThanOrEqual(1);
      expect(result.merged[0].type).toBe('task_result');
      expect(result.merged[0].tags).toContain('consolidated');
    });

    it('removes consolidated entries from the store', async () => {
      await store.save({ type: 'observation', content: 'Temp observation' });
      await store.save({ type: 'observation', content: 'Another observation' });
      const before = await store.list();
      const obsBefore = before.filter(e => e.type === 'observation').length;
      await store.consolidate();
      const after = await store.list();
      const obsAfter = after.filter(e => e.type === 'observation').length;
      expect(obsAfter).toBeLessThan(obsBefore);
    });

    it('does not affect non-observation types', async () => {
      await store.save({ type: 'fact', content: 'Keep me' });
      await store.save({ type: 'note', content: 'Keep me too' });
      await store.consolidate();
      const all = await store.list();
      expect(all.length).toBe(2);
    });

    it('returns promoted as an empty array when none promoted', async () => {
      await store.save({ type: 'observation', content: 'Single obs' });
      const result = await store.consolidate();
      expect(result.promoted).toEqual([]);
    });
  });

  // =====================================================================
  // Edge cases & error handling
  // =====================================================================

  describe('getByTag()', () => {
    beforeEach(async () => {
      await store.save({ type: 'fact', content: 'A', tags: ['alpha', 'beta'] });
      await store.save({ type: 'note', content: 'B', tags: ['beta', 'gamma'] });
      await store.save({ type: 'observation', content: 'C', tags: ['gamma'] });
    });

    it('returns entries matching the tag', async () => {
      const results = await store.getByTag('beta');
      expect(results.length).toBe(2);
    });

    it('returns empty array for non-existent tag', async () => {
      const results = await store.getByTag('nonexistent');
      expect(results).toEqual([]);
    });

    it('respects limit', async () => {
      const results = await store.getByTag('gamma', 1);
      expect(results.length).toBe(1);
    });

    it('returns entries with no tags when querying empty tag', async () => {
      await store.save({ type: 'fact', content: 'No tags entry' });
      const results = await store.getByTag('');
      // no entries have empty tag, so should be 0
      expect(results.length).toBe(0);
    });
  });

  describe('save() — graceful handling', () => {
    it('handles invalid type gracefully', async () => {
      const result = await store.save({
        type: 'invalid_type' as any,
        content: 'bad',
      });
      expect(result).toBeDefined();
      expect(result.content).toBe('bad');
    });

    it('handles undefined content gracefully', async () => {
      const result = await store.save({
        type: 'fact',
        content: undefined as any,
      });
      expect(result).toBeDefined();
    });

    it('handles null content gracefully', async () => {
      const result = await store.save({
        type: 'fact',
        content: null as any,
      });
      expect(result).toBeDefined();
    });
  });

  describe('remove() — graceful handling', () => {
    it('handles null ids gracefully', async () => {
      const count = await store.remove(null as any);
      expect(count).toBe(0);
    });

    it('handles undefined ids gracefully', async () => {
      const count = await store.remove(undefined as any);
      expect(count).toBe(0);
    });
  });

  describe('replace() — graceful handling', () => {
    it('handles null removedIds gracefully', async () => {
      const result = await store.replace(null as any, {
        type: 'fact',
        content: 'test',
      });
      expect(result).toBeDefined();
    });

    it('handles newEntry with missing type gracefully', async () => {
      const result = await store.replace([], {
        content: 'test',
      } as any);
      expect(result).toBeDefined();
    });

    it('handles newEntry with missing content gracefully', async () => {
      const result = await store.replace([], {
        type: 'fact',
      } as any);
      expect(result).toBeDefined();
    });
  });

  describe('getSection() — graceful handling', () => {
    it('returns null for empty section name', async () => {
      const result = await store.getSection('');
      expect(result).toBeNull();
    });

    it('returns null for undefined section name', async () => {
      const result = await store.getSection(undefined as any);
      expect(result).toBeNull();
    });
  });

  describe('updateSection() — graceful handling', () => {
    it('handles empty section name gracefully', async () => {
      const result = await store.updateSection('', 'content');
      expect(result).toBeUndefined();
    });

    it('handles undefined content gracefully', async () => {
      const result = await store.updateSection('Architecture', undefined as any);
      expect(result).toBeUndefined();
    });
  });

  describe('consolidate() — edge cases', () => {
    it('handles single observation (no merge possible)', async () => {
      await store.save({ type: 'observation', content: 'Lone observation' });
      const result = await store.consolidate();
      // Single observation gets removed but nothing to merge into
      expect(result.removed.length).toBe(1);
    });

    it('handles many observations', async () => {
      for (let i = 0; i < 20; i++) {
        await store.save({ type: 'observation', content: `Obs ${i}` });
      }
      const result = await store.consolidate();
      expect(result.removed.length).toBe(20);
      expect(result.merged.length).toBeGreaterThanOrEqual(1);
    });

    it('is idempotent — calling twice does not double-remove', async () => {
      await store.save({ type: 'observation', content: 'O1' });
      await store.save({ type: 'observation', content: 'O2' });
      await store.consolidate();
      const afterFirst = (await store.list()).length;
      await store.consolidate();
      const afterSecond = (await store.list()).length;
      expect(afterSecond).toBe(afterFirst);
    });
  });

  describe('cross-method interactions', () => {
    it('search respects removes', async () => {
      const [e] = await seedEntries(store, 1);
      expect((await store.search(e.content)).length).toBe(1);
      await store.remove([e.id]);
      expect((await store.search(e.content)).length).toBe(0);
    });

    it('replace atomically updates the store', async () => {
      const [a, b] = await seedEntries(store, 2);
      await store.replace([a.id, b.id], {
        type: 'task_result',
        content: 'Merged',
      });
      const all = await store.list();
      expect(all.find(e => e.id === a.id)).toBeUndefined();
      expect(all.find(e => e.id === b.id)).toBeUndefined();
      expect(all.some(e => e.content === 'Merged')).toBe(true);
    });

    it('list reflects consolidation changes', async () => {
      await store.save({ type: 'observation', content: 'Obs before' });
      await store.save({ type: 'observation', content: 'Obs after' });
      const beforeList = await store.list('observation');
      expect(beforeList.length).toBe(2);
      await store.consolidate();
      const afterList = await store.list('observation');
      expect(afterList.length).toBe(0);
    });
  });
});
