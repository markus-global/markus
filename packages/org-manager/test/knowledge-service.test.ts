import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileKnowledgeStore } from '../src/file-knowledge-store.js';
import { KnowledgeService } from '../src/knowledge-service.js';
import type { KnowledgeEntry } from '@markus/shared';

describe('FileKnowledgeStore', () => {
  let baseDir: string;
  let store: FileKnowledgeStore;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'kb-store-'));
    store = new FileKnowledgeStore(baseDir);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('saves, loads, and rebuilds entries', () => {
    const entry: KnowledgeEntry = {
      id: 'kb_test1', scope: 'project', scopeId: 'p1', category: 'decision',
      title: 'Test', content: 'Body', tags: ['a'], source: 'user-1',
      importance: 70, status: 'draft', accessCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    store.saveEntry(entry);
    store.saveIndex('project', 'p1', [entry]);
    store.persist(entry, [entry]);
    store.rebuildIndex('project', 'p1', [entry]);

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(store.entryPath(entry)).toContain('kb_test1.json');

    store.removeEntryFile(entry);
  });

  it('handles corrupt index gracefully', () => {
    const dir = join(baseDir, 'org', 'o1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_index.json'), 'not-json');
    expect(store.loadAll()).toEqual([]);
  });
});

describe('KnowledgeService', () => {
  let baseDir: string;
  let service: KnowledgeService;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'kb-svc-'));
    service = new KnowledgeService(new FileKnowledgeStore(baseDir));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('contributes, searches, browses, and manages status', () => {
    const low = service.contribute({
      scope: 'project', scopeId: 'p1', category: 'decision',
      title: 'Auto verify entry', content: 'low importance', source: 'u1', importance: 40,
    });
    expect(low.status).toBe('verified');

    const high = service.contribute({
      scope: 'project', scopeId: 'p1', category: 'process',
      title: 'Deploy checklist', content: 'steps for deploy', source: 'u1', importance: 80,
      tags: ['deploy'],
    });
    expect(high.status).toBe('draft');

    const results = service.search({ query: 'Auto verify', scope: 'project', scopeId: 'p1' });
    expect(results.some(r => r.title.includes('Auto'))).toBe(true);

    service.contribute({
      scope: 'project', scopeId: 'p1', category: 'decision',
      title: 'Old decision', content: 'superseded', source: 'u1', importance: 60,
      supersedes: high.id,
    });

    const browseCounts = service.browse({ scope: 'project', scopeId: 'p1' }) as Record<string, number>;
    expect(Object.keys(browseCounts).length).toBeGreaterThan(0);

    service.verify(high.id, 'reviewer');
    const found = service.findByScope('project', 'p1', { status: 'verified', orderBy: 'importance', limit: 5 });
    expect(found.length).toBeGreaterThan(0);

    service.flagOutdated(low.id, 'obsolete');
    service.flagDisputed(high.id, 'disputed');

    const byCategory = service.browse({ scope: 'project', scopeId: 'p1', category: 'process' }) as KnowledgeEntry[];
    expect(Array.isArray(byCategory)).toBe(true);

    const entry = service.get(high.id);
    expect(entry?.accessCount).toBe(1);
    expect(service.getEntryFilePath(high.id)).toBeDefined();
    expect(service.getEntryPath(high)).toBeDefined();

    expect(service.getTotalCount('project', 'p1')).toBeGreaterThan(0);
    expect(service.getContributions('p1', new Date('2026-01-01'), new Date('2027-01-01')).length).toBeGreaterThan(0);
  });

  it('works without file store', () => {
    const memOnly = new KnowledgeService();
    const entry = memOnly.contribute({
      scope: 'org', scopeId: 'o1', category: 'decision',
      title: 'Mem', content: 'content', source: 'u1',
    });
    expect(memOnly.search({ query: 'Mem' })).toHaveLength(1);
    expect(memOnly.getEntryFilePath(entry.id)).toBeUndefined();
  });
});
