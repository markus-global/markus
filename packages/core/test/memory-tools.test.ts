import { describe, it, expect, vi } from 'vitest';
import { createMemoryTools, type AgentMemoryContext } from '../src/tools/memory.js';
import type { IMemoryStore, MemoryEntry } from '../src/memory/types.js';
import type { SemanticMemorySearch } from '../src/memory/semantic-search.js';

function createMockMemory(entries?: MemoryEntry[]): IMemoryStore {
  const data: MemoryEntry[] = entries ?? [];
  return {
    addEntry: vi.fn((e: MemoryEntry) => { data.push(e); }),
    getEntries: vi.fn((type?: string) =>
      type ? data.filter(e => e.type === type) : [...data],
    ),
    search: vi.fn((query: string) => {
      const lower = query.toLowerCase();
      return data.filter(e => e.content.toLowerCase().includes(lower)).slice(0, 10);
    }),
    getEntriesByTag: vi.fn(),
    getEntryById: vi.fn(),
    removeEntries: vi.fn(),
    removeEntriesByTag: vi.fn(),
    replaceEntries: vi.fn(),
    addLongTermMemory: vi.fn(),
    getLongTermMemory: vi.fn().mockReturnValue(''),
    getLongTermSection: vi.fn().mockReturnValue(''),
    getLongTermMemoryExcluding: vi.fn().mockReturnValue(''),
    createSession: vi.fn(),
    getSession: vi.fn(),
    appendMessage: vi.fn(),
    getRecentMessages: vi.fn(),
    listSessions: vi.fn(),
    getLatestSession: vi.fn(),
    getOrCreateSession: vi.fn(),
    compactSession: vi.fn(),
    writeDailyLog: vi.fn(),
    getDailyLog: vi.fn().mockReturnValue(''),
  };
}

function createMockSemanticSearch(enabled: boolean, searchResult?: MemoryEntry[]): SemanticMemorySearch {
  return {
    isEnabled: vi.fn(() => enabled),
    initialize: vi.fn(),
    search: vi.fn(async (_query: string, _opts?: Record<string, unknown>) => {
      if (searchResult) {
        return searchResult.map(e => ({
          entry: e,
          similarity: 0.95,
        }));
      }
      return [];
    }),
    indexMemory: vi.fn(),
    deleteMemory: vi.fn(),
  } as unknown as SemanticMemorySearch;
}

describe('memory_search tool', () => {
  it('uses semantic search when enabled and results found', async () => {
    const ctx: AgentMemoryContext = {
      agentId: 'test-agent',
      agentName: 'Test Agent',
      memory: createMockMemory(),
      semanticSearch: createMockSemanticSearch(true, [
        { id: 'm1', timestamp: '2024-01-01', type: 'fact', content: 'TypeScript is awesome' },
      ]),
    };
    const tools = createMemoryTools(ctx);
    const searchTool = tools.find(t => t.name === 'memory_search')!;
    const result = JSON.parse(await searchTool.execute({ query: 'TypeScript' }));
    expect(result.count).toBe(1);
    expect(result.results[0].content).toBe('TypeScript is awesome');
    expect(result.searchMethod).toBe('semantic');
    expect(ctx.memory.search).not.toHaveBeenCalled();
  });

  it('falls back to substring when semantic search returns 0 results', async () => {
    const ctx: AgentMemoryContext = {
      agentId: 'test-agent',
      agentName: 'Test Agent',
      memory: createMockMemory([
        { id: 'm1', timestamp: '2024-01-01', type: 'fact', content: 'TypeScript is great' },
      ]),
      semanticSearch: createMockSemanticSearch(true), // returns empty
    };
    const tools = createMemoryTools(ctx);
    const searchTool = tools.find(t => t.name === 'memory_search')!;
    const result = JSON.parse(await searchTool.execute({ query: 'TypeScript' }));
    expect(result.count).toBe(1);
    expect(result.results[0].content).toBe('TypeScript is great');
    expect(result.searchMethod).toBe('substring');
    expect(ctx.memory.search).toHaveBeenCalledWith('TypeScript');
  });

  it('falls back to substring when semantic search throws', async () => {
    const ctx: AgentMemoryContext = {
      agentId: 'test-agent',
      agentName: 'Test Agent',
      memory: createMockMemory([
        { id: 'm1', timestamp: '2024-01-01', type: 'fact', content: 'TypeScript is great' },
      ]),
      semanticSearch: {
        isEnabled: vi.fn(() => true),
        initialize: vi.fn(),
        search: vi.fn().mockRejectedValue(new Error('API down')),
        indexMemory: vi.fn(),
        deleteMemory: vi.fn(),
      } as unknown as SemanticMemorySearch,
    };
    const tools = createMemoryTools(ctx);
    const searchTool = tools.find(t => t.name === 'memory_search')!;
    const result = JSON.parse(await searchTool.execute({ query: 'TypeScript' }));
    expect(result.count).toBe(1);
    expect(result.results[0].content).toBe('TypeScript is great');
    expect(result.searchMethod).toBe('substring');
  });

  it('uses substring search when semantic search is not enabled', async () => {
    const ctx: AgentMemoryContext = {
      agentId: 'test-agent',
      agentName: 'Test Agent',
      memory: createMockMemory([
        { id: 'm1', timestamp: '2024-01-01', type: 'fact', content: 'TypeScript is great' },
      ]),
    };
    const tools = createMemoryTools(ctx);
    const searchTool = tools.find(t => t.name === 'memory_search')!;
    const result = JSON.parse(await searchTool.execute({ query: 'TypeScript' }));
    expect(result.count).toBe(1);
    expect(result.results[0].content).toBe('TypeScript is great');
    expect(result.searchMethod).toBe('substring');
  });
});
