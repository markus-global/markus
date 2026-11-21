import { describe, it, expect } from 'vitest';
import { createMemoryTools, type AgentMemoryContext } from '../src/tools/memory.js';
import type { IMemoryStore } from '../src/memory/types.js';

/**
 * memory_curate — batch curation across knowledge sections + notebook keys.
 *
 * This is the tool that replaces the ad-hoc `{op, target, reason}` JSON the model
 * used to emit into the void: the same intent now lands on a real handler.
 */

function makeStore() {
  const sections = new Map<string, string>();
  const store = {
    getStoreFileName: () => 'knowledge.md',
    getLongTermSection: (s: string) => sections.get(s),
    removeLongTermSection: (s: string) => {
      if (!sections.has(s)) return { ok: false, reason: 'section not found', removedChars: 0 };
      const n = sections.get(s)!.length;
      sections.delete(s);
      return { ok: true, removedChars: n };
    },
    addLongTermMemory: (s: string, c: string) => {
      sections.set(s, c);
      return { ok: true };
    },
  } as unknown as IMemoryStore;
  return { store, sections };
}

function getTool(tools: ReturnType<typeof createMemoryTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe('memory_curate — batch curation', () => {
  it('applies forget/replace across knowledge; keep is recorded, not applied', async () => {
    const { store, sections } = makeStore();
    sections.set('old', 'stale');
    sections.set('procedures', 'a');
    const ctx: AgentMemoryContext = { agentId: 'a', agentName: 'A', memory: store };
    const curate = getTool(createMemoryTools(ctx), 'memory_curate');

    const out = JSON.parse(
      await curate.execute({
        ops: [
          { op: 'forget', target: 'knowledge.old', reason: 'superseded' },
          { op: 'replace', target: 'knowledge.procedures', content: 'b', reason: 'merge' },
          { op: 'keep', target: 'knowledge.keepme', reason: 'still valid' },
        ],
      }),
    );

    expect(out.status).toBe('curated');
    expect(out.applied).toBe(2);
    expect(out.kept).toBe(1);
    expect(out.failed).toBe(0);
    expect(sections.has('old')).toBe(false);
    expect(sections.get('procedures')).toBe('b');
    // The keep decision is an audit record, not a no-op that vanishes.
    const keptRow = out.results.find((r: { target: string }) => r.target === 'knowledge.keepme');
    expect(keptRow.outcome).toBe('kept');
    expect(keptRow.reason).toBe('still valid');
  });

  it('notebook targets work when accessors are wired', async () => {
    const { store } = makeStore();
    const nb = new Map<string, string>([['ctx-a', 'x']]);
    const ctx: AgentMemoryContext = {
      agentId: 'a',
      agentName: 'A',
      memory: store,
      updateWorkingMemory: (k, c) => {
        nb.set(k, c);
        return { status: 'ok', key: k };
      },
      clearWorkingMemory: (k) => {
        if (k) nb.delete(k);
        else nb.clear();
        return { status: 'ok', cleared: 1 };
      },
    };
    const curate = getTool(createMemoryTools(ctx), 'memory_curate');

    const out = JSON.parse(
      await curate.execute({
        ops: [
          { op: 'forget', target: 'notebook.ctx-a' },
          { op: 'replace', target: 'notebook.ctx-b', content: 'y' },
        ],
      }),
    );

    expect(out.applied).toBe(2);
    expect(nb.has('ctx-a')).toBe(false);
    expect(nb.get('ctx-b')).toBe('y');
  });

  it('notebook target without accessors → unavailable, does not throw', async () => {
    const { store } = makeStore();
    const ctx: AgentMemoryContext = { agentId: 'a', agentName: 'A', memory: store };
    const curate = getTool(createMemoryTools(ctx), 'memory_curate');

    const out = JSON.parse(await curate.execute({ ops: [{ op: 'forget', target: 'notebook.ctx-a' }] }));

    expect(out.failed).toBe(1);
    expect(out.results[0].outcome).toBe('unavailable');
  });

  it('bad target / bad op / missing content → per-op error, batch continues', async () => {
    const { store, sections } = makeStore();
    sections.set('s', 'v');
    const ctx: AgentMemoryContext = { agentId: 'a', agentName: 'A', memory: store };
    const curate = getTool(createMemoryTools(ctx), 'memory_curate');

    const out = JSON.parse(
      await curate.execute({
        ops: [
          { op: 'forget', target: 'bogus' },        // no namespace
          { op: 'nuke', target: 'knowledge.s' },     // bad op
          { op: 'replace', target: 'knowledge.s' },  // missing content
          { op: 'forget', target: 'knowledge.s' },   // valid — applied after the failures
        ],
      }),
    );

    expect(out.failed).toBe(3);
    expect(out.applied).toBe(1);
    expect(sections.has('s')).toBe(false);
  });

  it('empty ops → error', async () => {
    const { store } = makeStore();
    const curate = getTool(
      createMemoryTools({ agentId: 'a', agentName: 'A', memory: store }),
      'memory_curate',
    );
    const out = JSON.parse(await curate.execute({ ops: [] }));
    expect(out.status).toBe('error');
  });
});
