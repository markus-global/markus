import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import { parseNotebook, serializeNotebook, loadNotebook, saveNotebook, type NotebookEntry, type NotebookEntryManaged } from '../src/memory/store.js';
import { PendingCallbackRegistry } from '../src/pending-callback.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cognitive-test-'));
}
function rmdir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// =============================================================================
// Notebook (NOTEBOOK.md) Persistence
// =============================================================================

describe('Notebook persistence — parseNotebook / serializeNotebook', () => {
  it('round-trips entries with managed tags', () => {
    const entries = new Map<string, NotebookEntry>([
      ['current-task', { text: 'Working on feature X', managed: 'agent', updatedAt: 1000 }],
      ['triage-decision', { text: 'Processing user message', managed: 'system', updatedAt: 2000 }],
      ['cognitive-context', { text: 'This is about refactoring', managed: 'cpp', updatedAt: 3000 }],
    ]);
    const md = serializeNotebook(entries);
    expect(md).toContain('## current-task');
    expect(md).toContain('<!-- managed: agent -->');
    expect(md).toContain('<!-- managed: system -->');
    expect(md).toContain('<!-- managed: cpp -->');
    expect(md).toContain('Working on feature X');

    const parsed = parseNotebook(md);
    expect(parsed.size).toBe(3);
    expect(parsed.get('current-task')?.managed).toBe('agent');
    expect(parsed.get('current-task')?.text).toContain('Working on feature X');
    expect(parsed.get('triage-decision')?.managed).toBe('system');
    expect(parsed.get('cognitive-context')?.managed).toBe('cpp');
  });

  it('defaults to agent managed when no tag present', () => {
    const md = '## my-note\nSome text here\n';
    const parsed = parseNotebook(md);
    expect(parsed.size).toBe(1);
    expect(parsed.get('my-note')?.managed).toBe('agent');
  });

  it('handles empty notebook', () => {
    expect(parseNotebook('').size).toBe(0);
    expect(parseNotebook('# NOTEBOOK\n').size).toBe(0);
  });
});

describe('Notebook file I/O — loadNotebook / saveNotebook', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTempDir(); });
  afterEach(() => rmdir(tmp));

  it('saves and loads NOTEBOOK.md', () => {
    const entries = new Map<string, NotebookEntry>([
      ['task-focus', { text: 'Implementing API', managed: 'agent', updatedAt: Date.now() }],
    ]);
    saveNotebook(tmp, entries);
    expect(fs.existsSync(path.join(tmp, 'NOTEBOOK.md'))).toBe(true);

    const loaded = loadNotebook(tmp);
    expect(loaded.size).toBe(1);
    expect(loaded.get('task-focus')?.text).toContain('Implementing API');
  });

  it('returns empty map when file does not exist', () => {
    const loaded = loadNotebook(path.join(tmp, 'nonexistent-dir'));
    expect(loaded.size).toBe(0);
  });
});

// =============================================================================
// Unified knowledge.md — observations section
// =============================================================================

describe('Unified knowledge.md — observations in ## _observations', () => {
  let tmp: string;
  let store: MemoryStore;
  beforeEach(() => {
    tmp = makeTempDir();
    store = new MemoryStore(tmp);
  });
  afterEach(() => rmdir(tmp));

  it('saves observations to ## _observations section in knowledge.md', () => {
    store.addEntry({ id: 'obs_1', timestamp: '2024-01-01', type: 'note', content: 'user prefers concise responses' });
    store.addEntry({ id: 'obs_2', timestamp: '2024-01-02', type: 'fact', content: 'project uses TypeScript' });

    const knowledgeMd = path.join(tmp, 'knowledge.md');
    expect(fs.existsSync(knowledgeMd)).toBe(true);
    const content = fs.readFileSync(knowledgeMd, 'utf-8');
    expect(content).toContain('## _observations');
    expect(content).toContain('user prefers concise responses');
    expect(content).toContain('project uses TypeScript');
  });

  it('getObservations() returns entries from _observations', () => {
    store.addEntry({ id: 'obs_a', timestamp: '2024-01-01', type: 'note', content: 'observation A' });
    store.addEntry({ id: 'obs_b', timestamp: '2024-01-01', type: 'note', content: 'observation B' });
    const obs = store.getObservations();
    expect(obs.length).toBeGreaterThanOrEqual(2);
    expect(obs.some(o => o.content === 'observation A')).toBe(true);
  });

  it('getLongTermMemory() excludes _observations section', () => {
    const knowledgeMd = path.join(tmp, 'knowledge.md');
    fs.writeFileSync(knowledgeMd, '# Agent Knowledge\n\n## procedures\nAlways test before deploying.\n\n## _observations\n### obs_1\nsome observation\n');
    const store2 = new MemoryStore(tmp);
    const longTerm = store2.getLongTermMemory();
    expect(longTerm).toContain('procedures');
    expect(longTerm).toContain('Always test before deploying');
    expect(longTerm).not.toContain('_observations');
    expect(longTerm).not.toContain('some observation');
  });

  it('migrates memories.json to knowledge.md on load', () => {
    const memoriesJson = path.join(tmp, 'memories.json');
    fs.writeFileSync(memoriesJson, JSON.stringify([
      { id: 'old_1', timestamp: '2024-01-01', type: 'fact', content: 'legacy observation' },
    ]));
    const store2 = new MemoryStore(tmp);
    expect(fs.existsSync(memoriesJson)).toBe(false);
    const obs = store2.getObservations();
    expect(obs.some(o => o.content === 'legacy observation')).toBe(true);
  });
});

// =============================================================================
// PendingCallbackRegistry
// =============================================================================

describe('PendingCallbackRegistry', () => {
  let registry: PendingCallbackRegistry;

  beforeEach(() => {
    registry = new PendingCallbackRegistry();
  });

  it('registers and resolves callbacks', () => {
    registry.register({
      id: 'cb_1',
      agentId: 'agent_a',
      originSessionId: 'session_1',
      type: 'background_exec',
      command: 'npm test',
      registeredAt: Date.now(),
      timeoutMs: 60_000,
    });
    expect(registry.size).toBe(1);

    const cb = registry.resolve('cb_1');
    expect(cb).toBeDefined();
    expect(cb!.agentId).toBe('agent_a');
    expect(registry.size).toBe(0);
  });

  it('returns undefined for unknown callback', () => {
    expect(registry.resolve('nonexistent')).toBeUndefined();
  });

  it('getByAgentId filters correctly', () => {
    registry.register({
      id: 'cb_a1', agentId: 'a', originSessionId: 's1',
      type: 'background_exec', registeredAt: Date.now(), timeoutMs: 60_000,
    });
    registry.register({
      id: 'cb_b1', agentId: 'b', originSessionId: 's2',
      type: 'background_exec', registeredAt: Date.now(), timeoutMs: 60_000,
    });
    expect(registry.getByAgentId('a')).toHaveLength(1);
    expect(registry.getByAgentId('b')).toHaveLength(1);
    expect(registry.getByAgentId('c')).toHaveLength(0);
  });

  it('detects timed-out callbacks', () => {
    registry.register({
      id: 'cb_old', agentId: 'a', originSessionId: 's1',
      type: 'background_exec', registeredAt: Date.now() - 120_000, timeoutMs: 60_000,
    });
    registry.register({
      id: 'cb_fresh', agentId: 'a', originSessionId: 's2',
      type: 'background_exec', registeredAt: Date.now(), timeoutMs: 60_000,
    });
    const timedOut = registry.getTimedOut();
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0].id).toBe('cb_old');
  });

  it('expireTimedOut removes and returns the callback', () => {
    registry.register({
      id: 'cb_expire', agentId: 'a', originSessionId: 's1',
      type: 'background_exec', registeredAt: Date.now() - 120_000, timeoutMs: 60_000,
    });
    const expired = registry.expireTimedOut('cb_expire');
    expect(expired).toBeDefined();
    expect(registry.size).toBe(0);
  });

  it('supports persistence', () => {
    const stored: Map<string, any> = new Map();
    const persistence = {
      save: (cb: any) => stored.set(cb.id, cb),
      remove: (id: string) => stored.delete(id),
      loadAll: () => [...stored.values()],
    };

    registry.setPersistence(persistence);
    registry.register({
      id: 'cb_p1', agentId: 'a', originSessionId: 's1',
      type: 'background_exec', registeredAt: Date.now(), timeoutMs: 60_000,
    });
    expect(stored.size).toBe(1);

    const registry2 = new PendingCallbackRegistry();
    registry2.setPersistence(persistence);
    expect(registry2.size).toBe(1);
    const cb = registry2.resolve('cb_p1');
    expect(cb).toBeDefined();
    expect(stored.size).toBe(0);
  });
});
