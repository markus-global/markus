import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSyncService } from '../src/knowledge-sync-service.js';
import { DeliverableService } from '../src/deliverable-service.js';

// Mock text extraction to avoid markitdown dependency in unit tests.
vi.mock('@markus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@markus/core')>();
  return {
    ...actual,
    extractTextFromFile: vi.fn(async (p: string) => `TEXT:${p.split('/').pop()}`),
  };
});

describe('KnowledgeSyncService', () => {
  let tmp: string;
  let root: string;
  let service: KnowledgeSyncService;
  let ds: DeliverableService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kb-sync-test-'));
    root = join(tmp, 'kb');
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'readme.md'), '# Readme\ncontent here');
    writeFileSync(join(root, 'data.json'), '{"a":1}');
    writeFileSync(join(root, 'docs', 'notes.txt'), 'notes body');
    writeFileSync(join(root, '.hidden.md'), 'hidden');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'dep.md'), 'vendored');
    ds = new DeliverableService(undefined);
    service = new KnowledgeSyncService(ds);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('scans root and registers knowledge deliverables', async () => {
    const result = await service.sync('proj-1', [root]);

    expect(result.scanned).toBe(3); // readme.md, data.json, docs/notes.txt
    expect(result.registered).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.outdated).toBe(0);
    expect(result.errors).toHaveLength(0);

    const { results } = ds.search({ projectId: 'proj-1', source: 'knowledge' });
    expect(results).toHaveLength(3);
    expect(results.every(d => d.status === 'active' && d.source === 'knowledge')).toBe(true);

    const readme = results.find(d => d.reference.endsWith('readme.md'))!;
    expect(readme.content).toContain('TEXT:readme.md');
    expect(readme.projectId).toBe('proj-1');
    expect(readme.knowledgeRoot).toBe(root);
  });

  it('upserts existing files as updated, not duplicates', async () => {
    await service.sync('proj-1', [root]);
    const result = await service.sync('proj-1', [root]);

    expect(result.registered).toBe(0);
    expect(result.updated).toBe(3);
    const { results } = ds.search({ projectId: 'proj-1', source: 'knowledge' });
    expect(results).toHaveLength(3); // no duplicates
  });

  it('marks removed files as outdated', async () => {
    await service.sync('proj-1', [root]);
    rmSync(join(root, 'data.json'));
    const result = await service.sync('proj-1', [root]);

    expect(result.outdated).toBe(1);
    const { results } = ds.search({ projectId: 'proj-1', source: 'knowledge' });
    expect(results).toHaveLength(2); // data.json excluded from active
    const { results: all } = ds.search({ projectId: 'proj-1', source: 'knowledge', status: 'outdated' });
    expect(all).toHaveLength(1);
    expect(all[0]!.reference.endsWith('data.json')).toBe(true);
  });

  it('reports error for missing root and scans nothing', async () => {
    const missing = join(tmp, 'nope');
    const result = await service.sync('proj-1', [missing]);
    expect(result.scanned).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('scans a single file root', async () => {
    const file = join(root, 'readme.md');
    const result = await service.sync('proj-1', [file]);
    expect(result.scanned).toBe(1);
    expect(result.registered).toBe(1);
  });
});