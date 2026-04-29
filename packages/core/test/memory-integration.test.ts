import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'int-test-'));
}

function rmdir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// In-memory / file-based store simulating the memory layer
// ---------------------------------------------------------------------------
interface MemoryEntry {
  id: string;
  agentId: string;
  content: string;
  timestamp: number;
  type: 'working' | 'consolidated' | 'dream';
}

interface MemoryStore {
  entries: MemoryEntry[];
  dbPath: string;
}

function createStore(dbPath: string): MemoryStore {
  const store: MemoryStore = { entries: [], dbPath };
  if (fs.existsSync(dbPath)) {
    try { store.entries = JSON.parse(fs.readFileSync(dbPath, 'utf-8')); }
    catch { store.entries = []; }
  }
  return store;
}

function persistStore(store: MemoryStore): void {
  fs.mkdirSync(path.dirname(store.dbPath), { recursive: true });
  fs.writeFileSync(store.dbPath, JSON.stringify(store.entries, null, 2), 'utf-8');
}

function memorySave(store: MemoryStore, entry: Omit<MemoryEntry, 'timestamp'>): MemoryEntry {
  const full: MemoryEntry = { ...entry, timestamp: Date.now() };
  store.entries.push(full);
  persistStore(store);
  return full;
}

function search(store: MemoryStore, query: string): MemoryEntry[] {
  return store.entries.filter(e => e.content.toLowerCase().includes(query.toLowerCase()));
}

function consolidate(store: MemoryStore, count: number): MemoryEntry[] {
  const working = store.entries.filter(e => e.type === 'working');
  const toPromote = working.slice(0, count).map(e => ({ ...e, type: 'consolidated' as const }));
  // Remove originals, add promoted
  store.entries = store.entries.filter(e => e.type !== 'working' || !working.slice(0, count).includes(e));
  store.entries.push(...toPromote);
  persistStore(store);
  return toPromote;
}

function compactSession(store: MemoryStore, keepCount: number): string {
  const sorted = [...store.entries].sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length <= keepCount) return 'no-compaction-needed';
  const removed = sorted.slice(0, sorted.length - keepCount);
  store.entries = sorted.slice(sorted.length - keepCount);
  const summary = `Compacted ${removed.length} old messages. Retained ${store.entries.length} most recent.`;
  persistStore(store);
  return summary;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('MemoryIntegration — Full write persistence', () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = makeTempDir();
    store = createStore(path.join(tmp, 'memory.json'));
  });

  afterEach(() => {
    rmdir(tmp);
  });

  it('persists entry and retrieves via search', () => {
    memorySave(store, { id: 'e1', agentId: 'agent-1', content: 'Hello world', type: 'working' });
    const results = search(store, 'Hello');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Hello world');
  });

  it('persists multiple entries and searches all', () => {
    memorySave(store, { id: 'e1', agentId: 'agent-1', content: 'alpha', type: 'working' });
    memorySave(store, { id: 'e2', agentId: 'agent-1', content: 'beta', type: 'working' });
    memorySave(store, { id: 'e3', agentId: 'agent-2', content: 'alpha beta', type: 'working' });

    const results = search(store, 'alpha');
    expect(results).toHaveLength(2);
  });

  it('persists across store reload from disk', () => {
    memorySave(store, { id: 'persist', agentId: 'agent-1', content: 'disk check', type: 'working' });
    const reloaded = createStore(store.dbPath);
    const results = search(reloaded, 'disk');
    expect(results).toHaveLength(1);
  });

  it('returns empty array when no match', () => {
    memorySave(store, { id: 'e1', agentId: 'agent-1', content: 'unique', type: 'working' });
    expect(search(store, 'nonexistent')).toEqual([]);
  });
});

describe('MemoryIntegration — Multi-agent isolation', () => {
  let tmp: string;
  let storeA: MemoryStore;
  let storeB: MemoryStore;

  beforeEach(() => {
    tmp = makeTempDir();
    storeA = createStore(path.join(tmp, 'agent-a', 'memory.json'));
    storeB = createStore(path.join(tmp, 'agent-b', 'memory.json'));
  });

  afterEach(() => {
    rmdir(tmp);
  });

  it('agent A data is invisible to agent B', () => {
    memorySave(storeA, { id: 'secret-a', agentId: 'agent-a', content: 'A secret', type: 'working' });
    const resultsB = search(storeB, 'secret');
    expect(resultsB).toHaveLength(0);
  });

  it('agent B data is invisible to agent A', () => {
    memorySave(storeB, { id: 'secret-b', agentId: 'agent-b', content: 'B data', type: 'working' });
    const resultsA = search(storeA, 'data');
    expect(resultsA).toHaveLength(0);
  });

  it('agents can store independent entries with same content', () => {
    memorySave(storeA, { id: 'dup', agentId: 'agent-a', content: 'shared content', type: 'working' });
    memorySave(storeB, { id: 'dup', agentId: 'agent-b', content: 'shared content', type: 'working' });
    expect(search(storeA, 'shared')).toHaveLength(1);
    expect(search(storeB, 'shared')).toHaveLength(1);
  });
});

describe('MemoryIntegration — Dream Cycle integration', () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = makeTempDir();
    store = createStore(path.join(tmp, 'memory.json'));
  });

  afterEach(() => {
    rmdir(tmp);
  });

  it('save → consolidate → working entries become consolidated', () => {
    memorySave(store, { id: 'w1', agentId: 'agent-1', content: 'working memory', type: 'working' });
    memorySave(store, { id: 'w2', agentId: 'agent-1', content: 'more working', type: 'working' });

    const promoted = consolidate(store, 2);
    expect(promoted).toHaveLength(2);
    expect(promoted.every(e => e.type === 'consolidated')).toBe(true);

    const allEntries = createStore(store.dbPath).entries;
    const working = allEntries.filter(e => e.type === 'working');
    const consolidated = allEntries.filter(e => e.type === 'consolidated');
    expect(working).toHaveLength(0);
    expect(consolidated).toHaveLength(2);
  });

  it('only promotes requested count from working pool', () => {
    for (let i = 0; i < 5; i++) {
      memorySave(store, { id: `w${i}`, agentId: 'agent-1', content: `item ${i}`, type: 'working' });
    }

    const promoted = consolidate(store, 3);
    expect(promoted).toHaveLength(3);

    const entries = createStore(store.dbPath).entries;
    expect(entries.filter(e => e.type === 'consolidated')).toHaveLength(3);
    expect(entries.filter(e => e.type === 'working')).toHaveLength(2);
  });

  it('consolidate does nothing when no working entries exist', () => {
    const promoted = consolidate(store, 5);
    expect(promoted).toHaveLength(0);
  });

  it('consolidate does not affect dream-type entries', () => {
    memorySave(store, { id: 'd1', agentId: 'agent-1', content: 'dream data', type: 'dream' });
    memorySave(store, { id: 'w1', agentId: 'agent-1', content: 'working data', type: 'working' });

    consolidate(store, 1);

    const entries = createStore(store.dbPath).entries;
    expect(entries.filter(e => e.type === 'dream')).toHaveLength(1);
    expect(entries.filter(e => e.type === 'consolidated')).toHaveLength(1);
    expect(entries.filter(e => e.type === 'working')).toHaveLength(0);
  });
});

describe('MemoryIntegration — Session compaction', () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = makeTempDir();
    store = createStore(path.join(tmp, 'memory.json'));
  });

  afterEach(() => {
    rmdir(tmp);
  });

  it('appends 100 messages then compact retains only keepCount', () => {
    for (let i = 0; i < 100; i++) {
      memorySave(store, {
        id: `msg-${i}`,
        agentId: 'agent-1',
        content: `Message number ${i}`,
        type: 'working',
      });
    }

    expect(store.entries).toHaveLength(100);

    const summary = compactSession(store, 10);
    expect(summary).toContain('Compacted 90 old messages');

    const reloaded = createStore(store.dbPath);
    expect(reloaded.entries).toHaveLength(10);
  });

  it('compact returns no-compaction when under threshold', () => {
    memorySave(store, { id: 'only', agentId: 'agent-1', content: 'only one', type: 'working' });
    const summary = compactSession(store, 10);
    expect(summary).toBe('no-compaction-needed');
  });

  it('compact retains the most recent entries', () => {
    for (let i = 0; i < 5; i++) {
      memorySave(store, {
        id: `msg-${i}`,
        agentId: 'agent-1',
        content: `msg ${i}`,
        type: 'working',
      });
    }

    compactSession(store, 3);

    const reloaded = createStore(store.dbPath);
    const contents = reloaded.entries.map(e => e.content);
    expect(contents).toEqual(['msg 2', 'msg 3', 'msg 4']);
  });
});

describe('MemoryIntegration — Memory growth limits', () => {
  let tmp: string;
  let store: MemoryStore;
  const CAP = 5;

  beforeEach(() => {
    tmp = makeTempDir();
    store = createStore(path.join(tmp, 'memory.json'));
  });

  afterEach(() => {
    rmdir(tmp);
  });

  it('operates normally below capacity', () => {
    for (let i = 0; i < CAP; i++) {
      memorySave(store, { id: `m${i}`, agentId: 'agent-1', content: `entry ${i}`, type: 'working' });
    }
    expect(store.entries).toHaveLength(CAP);
  });

  it('search performance does not degrade at boundary', () => {
    for (let i = 0; i < CAP; i++) {
      memorySave(store, { id: `m${i}`, agentId: 'agent-1', content: `data ${i}`, type: 'working' });
    }
    const start = Date.now();
    const results = search(store, 'data');
    const elapsed = Date.now() - start;
    expect(results).toHaveLength(CAP);
    expect(elapsed).toBeLessThan(100); // reasonable bound
  });

  it('compact at boundary keeps correct count', () => {
    for (let i = 0; i < CAP; i++) {
      memorySave(store, { id: `m${i}`, agentId: 'agent-1', content: `entry ${i}`, type: 'working' });
    }

    compactSession(store, 2);
    const reloaded = createStore(store.dbPath);
    expect(reloaded.entries).toHaveLength(2);
  });

  it('handles zero entries gracefully at capacity operation', () => {
    const summary = compactSession(store, 10);
    expect(summary).toBe('no-compaction-needed');
    expect(search(store, 'anything')).toEqual([]);
  });
});
