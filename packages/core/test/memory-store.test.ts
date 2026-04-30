import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import type { MemoryEntry, ConversationSession } from '../src/memory/types.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-test-'));
}

function rmdir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// =============================================================================
// Semantic Memory: Observation Buffer (memories.json)
// =============================================================================

describe('MemoryStore — Semantic: observation buffer', () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new MemoryStore(tmp);
  });
  afterEach(() => rmdir(tmp));

  it('addEntry persists and getEntries retrieves', () => {
    store.addEntry({ id: 'e1', timestamp: '2024-01-01', type: 'fact', content: 'hello world' });
    const entries = store.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('e1');
    expect(entries[0].content).toBe('hello world');
  });

  it('getEntries filters by type', () => {
    store.addEntry({ id: 'e1', timestamp: '2024-01-01', type: 'fact', content: 'a fact' });
    store.addEntry({ id: 'e2', timestamp: '2024-01-01', type: 'note', content: 'a note' });
    store.addEntry({ id: 'e3', timestamp: '2024-01-01', type: 'fact', content: 'another fact' });

    expect(store.getEntries('fact')).toHaveLength(2);
    expect(store.getEntries('note')).toHaveLength(1);
    expect(store.getEntries('task_result')).toHaveLength(0);
  });

  it('getEntries respects limit (returns last N)', () => {
    for (let i = 0; i < 10; i++) {
      store.addEntry({ id: `e${i}`, timestamp: '2024-01-01', type: 'note', content: `item ${i}` });
    }
    const last3 = store.getEntries(undefined, 3);
    expect(last3).toHaveLength(3);
    expect(last3[0].content).toBe('item 7');
    expect(last3[2].content).toBe('item 9');
  });

  it('search finds entries by substring (case-insensitive)', () => {
    store.addEntry({ id: 'e1', timestamp: '2024-01-01', type: 'fact', content: 'TypeScript is great' });
    store.addEntry({ id: 'e2', timestamp: '2024-01-01', type: 'fact', content: 'Python is popular' });

    expect(store.search('typescript')).toHaveLength(1);
    expect(store.search('is')).toHaveLength(2);
    expect(store.search('rust')).toHaveLength(0);
  });

  it('removeEntries removes by ID and persists', () => {
    store.addEntry({ id: 'e1', timestamp: '2024-01-01', type: 'fact', content: 'keep' });
    store.addEntry({ id: 'e2', timestamp: '2024-01-01', type: 'fact', content: 'remove' });
    store.addEntry({ id: 'e3', timestamp: '2024-01-01', type: 'fact', content: 'keep too' });

    const removed = store.removeEntries(['e2']);
    expect(removed).toBe(1);
    expect(store.getEntries()).toHaveLength(2);

    const reloaded = new MemoryStore(tmp);
    expect(reloaded.getEntries()).toHaveLength(2);
  });

  it('replaceEntries atomically removes and adds', () => {
    store.addEntry({ id: 'e1', timestamp: '2024-01-01', type: 'fact', content: 'old1' });
    store.addEntry({ id: 'e2', timestamp: '2024-01-01', type: 'fact', content: 'old2' });
    store.addEntry({ id: 'e3', timestamp: '2024-01-01', type: 'fact', content: 'keep' });

    store.replaceEntries(['e1', 'e2'], {
      id: 'merged', timestamp: '2024-01-01', type: 'note', content: 'merged content',
    });

    const entries = store.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.id).sort()).toEqual(['e3', 'merged']);
  });

  it('getEntriesByTag filters by metadata.tags', () => {
    store.addEntry({ id: 'e1', timestamp: '2024-01-01', type: 'note', content: 'tagged', metadata: { tags: ['insight'] } });
    store.addEntry({ id: 'e2', timestamp: '2024-01-01', type: 'note', content: 'untagged' });
    store.addEntry({ id: 'e3', timestamp: '2024-01-01', type: 'note', content: 'also tagged', metadata: { tags: ['insight', 'domain:ts'] } });

    expect(store.getEntriesByTag('insight')).toHaveLength(2);
    expect(store.getEntriesByTag('domain:ts')).toHaveLength(1);
    expect(store.getEntriesByTag('nonexistent')).toHaveLength(0);
  });

  it('removeEntriesByTag removes all entries with matching tag', () => {
    store.addEntry({ id: 'e1', timestamp: '2024-01-01', type: 'note', content: 'a', metadata: { tags: ['temp'] } });
    store.addEntry({ id: 'e2', timestamp: '2024-01-01', type: 'note', content: 'b', metadata: { tags: ['keep'] } });
    store.addEntry({ id: 'e3', timestamp: '2024-01-01', type: 'note', content: 'c', metadata: { tags: ['temp'] } });

    const removed = store.removeEntriesByTag('temp');
    expect(removed).toBe(2);
    expect(store.getEntries()).toHaveLength(1);
    expect(store.getEntries()[0].id).toBe('e2');
  });

  it('persists entries to disk and reloads on construction', () => {
    store.addEntry({ id: 'persist-test', timestamp: '2024-01-01', type: 'fact', content: 'survives restart' });

    const reloaded = new MemoryStore(tmp);
    const entries = reloaded.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('survives restart');
  });

  it('sanitizes malformed entries on load', () => {
    const memFile = path.join(tmp, 'memories.json');
    fs.writeFileSync(memFile, JSON.stringify([
      { id: 'ok', type: 'fact', content: 'valid', timestamp: '2024-01-01' },
      { id: 'bad-type', type: 'INVALID', content: 'bad type', timestamp: '2024-01-01' },
      { id: '', type: 'fact', content: 'empty id' },
      'not-an-object',
    ]));

    const loaded = new MemoryStore(tmp);
    const entries = loaded.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('fact');
    expect(entries[1].type).toBe('note');
  });
});

// =============================================================================
// Semantic Memory: Curated Knowledge (MEMORY.md)
// =============================================================================

describe('MemoryStore — Semantic: MEMORY.md', () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new MemoryStore(tmp);
  });
  afterEach(() => rmdir(tmp));

  it('addLongTermMemory creates new section', () => {
    store.addLongTermMemory('conventions', 'Use kebab-case for file names.');
    const content = store.getLongTermMemory();
    expect(content).toContain('## conventions');
    expect(content).toContain('Use kebab-case');
  });

  it('addLongTermMemory replaces existing section', () => {
    store.addLongTermMemory('procedures', 'Step 1: init');
    store.addLongTermMemory('procedures', 'Step 1: init\nStep 2: build');

    const section = store.getLongTermSection('procedures');
    expect(section).toContain('Step 2: build');
    expect(section.match(/Step 1/g)).toHaveLength(1);
  });

  it('getLongTermSection returns empty string for missing section', () => {
    store.addLongTermMemory('existing', 'data');
    expect(store.getLongTermSection('nonexistent')).toBe('');
  });

  it('getLongTermMemoryExcluding omits specified sections', () => {
    store.addLongTermMemory('keep', 'important');
    store.addLongTermMemory('remove', 'not needed');

    const filtered = store.getLongTermMemoryExcluding(['remove']);
    expect(filtered).toContain('important');
    expect(filtered).not.toContain('not needed');
  });

  it('truncates section content exceeding limit', () => {
    const longContent = 'x'.repeat(5000);
    store.addLongTermMemory('big', longContent);
    const section = store.getLongTermSection('big');
    expect(section.length).toBeLessThanOrEqual(3000);
  });

  it('refuses write when total MEMORY.md exceeds limit', () => {
    for (let i = 0; i < 6; i++) {
      store.addLongTermMemory(`section-${i}`, 'a'.repeat(2500));
    }
    const before = store.getLongTermMemory();
    store.addLongTermMemory('overflow', 'b'.repeat(2500));
    const after = store.getLongTermMemory();
    expect(after).toBe(before);
  });

  it('persists MEMORY.md to disk', () => {
    store.addLongTermMemory('test', 'persisted');
    const reloaded = new MemoryStore(tmp);
    expect(reloaded.getLongTermSection('test')).toBe('persisted');
  });
});

// =============================================================================
// Episodic Memory: Conversation Sessions
// =============================================================================

describe('MemoryStore — Episodic: sessions', () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new MemoryStore(tmp);
  });
  afterEach(() => rmdir(tmp));

  it('createSession returns a valid session', () => {
    const session = store.createSession('agent-1');
    expect(session.id).toMatch(/^sess_/);
    expect(session.agentId).toBe('agent-1');
    expect(session.messages).toEqual([]);
  });

  it('getSession retrieves created session', () => {
    const session = store.createSession('agent-1');
    const retrieved = store.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(session.id);
  });

  it('getSession returns undefined for unknown ID', () => {
    expect(store.getSession('nonexistent')).toBeUndefined();
  });

  it('appendMessage adds to session', () => {
    const session = store.createSession('agent-1');
    store.appendMessage(session.id, { role: 'user', content: 'hello' });
    store.appendMessage(session.id, { role: 'assistant', content: 'hi there' });

    const messages = store.getRecentMessages(session.id, 10);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('hello');
    expect(messages[1].content).toBe('hi there');
  });

  it('appendMessage throws for unknown session', () => {
    expect(() => store.appendMessage('bad-id', { role: 'user', content: 'x' })).toThrow();
  });

  it('getRecentMessages returns last N messages', () => {
    const session = store.createSession('agent-1');
    for (let i = 0; i < 20; i++) {
      store.appendMessage(session.id, { role: 'user', content: `msg ${i}` });
    }
    const recent = store.getRecentMessages(session.id, 5);
    expect(recent).toHaveLength(5);
    expect(recent[0].content).toBe('msg 15');
    expect(recent[4].content).toBe('msg 19');
  });

  it('listSessions filters by agentId', () => {
    store.createSession('agent-1');
    store.createSession('agent-1');
    store.createSession('agent-2');

    expect(store.listSessions('agent-1')).toHaveLength(2);
    expect(store.listSessions('agent-2')).toHaveLength(1);
    expect(store.listSessions()).toHaveLength(3);
  });

  it('getLatestSession returns most recent by lastActivityAt', async () => {
    const s1 = store.createSession('agent-1');
    store.appendMessage(s1.id, { role: 'user', content: 'first' });

    // Ensure different timestamp
    await new Promise(r => setTimeout(r, 5));

    const s2 = store.createSession('agent-1');
    store.appendMessage(s2.id, { role: 'user', content: 'second' });

    const latest = store.getLatestSession('agent-1');
    expect(latest!.id).toBe(s2.id);
  });

  it('getOrCreateSession returns existing or creates new', () => {
    const created = store.getOrCreateSession('agent-1', 'custom-id');
    expect(created.id).toBe('custom-id');

    const retrieved = store.getOrCreateSession('agent-1', 'custom-id');
    expect(retrieved.id).toBe('custom-id');
    expect(retrieved).toBe(created);
  });

  it('compactSession keeps last N messages and adds summary', () => {
    const session = store.createSession('agent-1');
    for (let i = 0; i < 30; i++) {
      store.appendMessage(session.id, { role: 'user', content: `message ${i}` });
    }

    const result = store.compactSession(session.id, 10);
    expect(result.flushedCount).toBe(20);
    expect(result.summary).toBeTruthy();

    const remaining = store.getRecentMessages(session.id, 100);
    expect(remaining.length).toBe(11); // 10 kept + 1 summary
    expect(remaining[0].content).toContain('summary');
  });

  it('compactSession is no-op when below threshold', () => {
    const session = store.createSession('agent-1');
    store.appendMessage(session.id, { role: 'user', content: 'only one' });

    const result = store.compactSession(session.id, 10);
    expect(result.flushedCount).toBe(0);
    expect(result.summary).toBe('');
  });

  it('sessions persist to disk and reload', async () => {
    const session = store.createSession('agent-1');
    store.appendMessage(session.id, { role: 'user', content: 'persisted msg' });

    // Debounced save has 1000ms delay
    await new Promise(r => setTimeout(r, 1200));

    const reloaded = new MemoryStore(tmp);
    const restored = reloaded.getSession(session.id);
    expect(restored).toBeDefined();
    expect(restored!.messages).toHaveLength(1);
    expect(restored!.messages[0].content).toBe('persisted msg');
  });
});

// =============================================================================
// Audit Trail (daily-logs)
// =============================================================================

describe('MemoryStore — Audit trail: daily-logs', () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new MemoryStore(tmp);
  });
  afterEach(() => rmdir(tmp));

  it('writeDailyLog appends to date-named file', () => {
    store.writeDailyLog('agent-1', 'Did some work today.');
    const log = store.getDailyLog();
    expect(log).toContain('agent-1');
    expect(log).toContain('Did some work today.');
  });

  it('writeDailyLog is append-only', () => {
    store.writeDailyLog('agent-1', 'First entry.');
    store.writeDailyLog('agent-1', 'Second entry.');
    const log = store.getDailyLog();
    expect(log).toContain('First entry.');
    expect(log).toContain('Second entry.');
  });

  it('getDailyLog returns empty for nonexistent date', () => {
    expect(store.getDailyLog('1999-01-01')).toBe('');
  });
});
