import { describe, it, expect, vi } from 'vitest';
import { createMemoryTools, type AgentMemoryContext } from '../src/tools/memory.js';
import type { IMemoryStore, MemoryEntry } from '../src/memory/types.js';
import type { SemanticMemorySearch } from '../src/memory/semantic-search.js';

function createMockMemory(entries: MemoryEntry[] = []): IMemoryStore {
  const data = [...entries];
  return {
    addEntry: vi.fn((e: MemoryEntry) => { data.push(e); }),
    getEntries: vi.fn((_type?: string, limit?: number) => data.slice(0, limit ?? data.length)),
    search: vi.fn((query: string) => data.filter(e => e.content.includes(query))),
    getEntriesByTag: vi.fn(),
    getEntryById: vi.fn(),
    removeEntries: vi.fn((ids: string[]) => {
      const before = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (ids.includes(data[i]!.id)) data.splice(i, 1);
      }
      return before - data.length;
    }),
    removeEntriesByTag: vi.fn((tag: string) => {
      const before = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        const tags = (data[i]!.metadata as { tags?: string[] })?.tags ?? [];
        if (tags.includes(tag)) data.splice(i, 1);
      }
      return before - data.length;
    }),
    replaceEntries: vi.fn(),
    addLongTermMemory: vi.fn(),
    getLongTermMemory: vi.fn().mockReturnValue(''),
    getLongTermSection: vi.fn((section: string) => (section === 'notes' ? 'Existing note' : '')),
    getLongTermMemoryExcluding: vi.fn().mockReturnValue(''),
    createSession: vi.fn(),
    getSession: vi.fn(),
    appendMessage: vi.fn(),
    getRecentMessages: vi.fn(),
    listSessions: vi.fn(),
    getLatestSession: vi.fn(),
    getLatestMainSession: vi.fn(),
    getOrCreateSession: vi.fn(),
    compactSession: vi.fn(),
    writeDailyLog: vi.fn(),
    getDailyLog: vi.fn().mockReturnValue(''),
  };
}

function createSemantic(enabled: boolean): SemanticMemorySearch {
  return {
    isEnabled: vi.fn(() => enabled),
    initialize: vi.fn(),
    search: vi.fn(async () => []),
    indexMemory: vi.fn(async () => {}),
    deleteMemory: vi.fn(async () => {}),
  } as unknown as SemanticMemorySearch;
}

function findTool(ctx: AgentMemoryContext, name: string) {
  const tool = createMemoryTools(ctx).find(t => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe('memory tools extended', () => {
  it('memory_save stores entry with string and array tags and indexes semantically', async () => {
    const memory = createMockMemory();
    const semanticSearch = createSemantic(true);
    const ctx: AgentMemoryContext = {
      agentId: 'agt_1',
      agentName: 'Agent',
      memory,
      semanticSearch,
    };

    const saved = JSON.parse(await findTool(ctx, 'memory_save').execute({
      content: 'Deploy uses blue-green',
      type: 'insight',
      tags: 'deploy, ops',
    }));
    expect(saved.status).toBe('saved');
    expect(memory.addEntry).toHaveBeenCalled();

    await findTool(ctx, 'memory_save').execute({
      content: 'Second note',
      tags: ['ui', 'design'],
    });
    expect(semanticSearch.indexMemory).toHaveBeenCalled();
  });

  it('memory_list returns recent entries', async () => {
    const memory = createMockMemory([
      { id: 'm1', timestamp: '2024-01-01', type: 'fact', content: 'Fact one' },
    ]);
    const ctx: AgentMemoryContext = { agentId: 'agt_1', agentName: 'Agent', memory };
    const result = JSON.parse(await findTool(ctx, 'memory_list').execute({ limit: 5 }));
    expect(result.count).toBe(1);
  });

  it('memory_update_longterm replace and patch modes', async () => {
    const memory = createMockMemory();
    const ctx: AgentMemoryContext = { agentId: 'agt_1', agentName: 'Agent', memory };

    await findTool(ctx, 'memory_update_longterm').execute({
      section: 'procedures',
      content: 'Step 1',
      mode: 'replace',
    });
    expect(memory.addLongTermMemory).toHaveBeenCalledWith('procedures', 'Step 1');

    await findTool(ctx, 'memory_update_longterm').execute({
      section: 'notes',
      content: ' appended',
      mode: 'patch',
    });
    expect(memory.addLongTermMemory).toHaveBeenCalledWith('notes', 'Existing note\n appended');
  });

  it('memory_delete by ids and by tag with semantic cleanup', async () => {
    const memory = createMockMemory();
    const semanticSearch = createSemantic(true);
    const ctx: AgentMemoryContext = {
      agentId: 'agt_1',
      agentName: 'Agent',
      memory,
      semanticSearch,
    };

    const missing = JSON.parse(await findTool(ctx, 'memory_delete').execute({}));
    expect(missing.status).toBe('error');

    const byIds = JSON.parse(await findTool(ctx, 'memory_delete').execute({ ids: ['m1', 'm2'] }));
    expect(byIds.status).toBe('deleted');
    expect(semanticSearch.deleteMemory).toHaveBeenCalled();

    const byTag = JSON.parse(await findTool(ctx, 'memory_delete').execute({ tag: 'stale' }));
    expect(byTag.removed).toBeDefined();
  });

  it('memory_search filters semantic results by type', async () => {
    const memory = createMockMemory();
    const semanticSearch = {
      isEnabled: vi.fn(() => true),
      search: vi.fn(async () => [
        { entry: { id: 'm1', timestamp: '2024', type: 'fact', content: 'A' }, similarity: 0.9 },
        { entry: { id: 'm2', timestamp: '2024', type: 'note', content: 'B' }, similarity: 0.8 },
      ]),
      indexMemory: vi.fn(),
      deleteMemory: vi.fn(),
      initialize: vi.fn(),
    } as unknown as SemanticMemorySearch;
    const ctx: AgentMemoryContext = { agentId: 'agt_1', agentName: 'Agent', memory, semanticSearch };
    const result = JSON.parse(await findTool(ctx, 'memory_search').execute({
      query: 'test',
      type: 'note',
    }));
    expect(result.count).toBe(1);
    expect(result.results[0].type).toBe('note');
  });
});
