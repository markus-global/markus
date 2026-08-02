import { describe, it, expect, vi } from 'vitest';
import { tokenizeSearchQuery, scoreKeywordHaystack } from '@markus/shared';
import { createMemoryTools, type AgentMemoryContext } from '../src/tools/memory.js';
import type { IMemoryStore, MemoryEntry } from '../src/memory/types.js';
import type { SemanticMemorySearch } from '../src/memory/semantic-search.js';

/** Mock search mirrors real MemoryStore keyword OR-match (not whole-phrase-only). */
function keywordSearchEntries(data: MemoryEntry[], query: string): MemoryEntry[] {
  const tokens = tokenizeSearchQuery(query);
  const full = query.trim().toLowerCase();
  return data
    .map((e) => ({ e, score: scoreKeywordHaystack(e.content, tokens, full) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e)
    .slice(0, 10);
}

function createMockMemory(entries?: MemoryEntry[]): IMemoryStore {
  const data: MemoryEntry[] = entries ?? [];
  return {
    addEntry: vi.fn((e: MemoryEntry) => { data.push(e); }),
    getEntries: vi.fn((type?: string) =>
      type ? data.filter(e => e.type === type) : [...data],
    ),
    search: vi.fn((query: string) => keywordSearchEntries(data, query)),
    getEntriesByTag: vi.fn(),
    getObservations: vi.fn(() => [...data]),
    removeEntries: vi.fn(),
    removeEntriesByTag: vi.fn(),
    replaceEntries: vi.fn(),
    getStoreFileName: vi.fn(() => 'knowledge.md'),
    addLongTermMemory: vi.fn(),
    getLongTermMemory: vi.fn().mockReturnValue(''),
    getLongTermSection: vi.fn().mockReturnValue(''),
    getLongTermMemoryExcluding: vi.fn().mockReturnValue(''),
    compressLongTermMemory: vi.fn().mockReturnValue({
      charsBefore: 0, charsAfter: 0, sectionsBefore: 0, sectionsAfter: 0, truncatedChunks: 0,
    }),
    createSession: vi.fn(),
    getSession: vi.fn(),
    appendMessage: vi.fn(),
    getRecentMessages: vi.fn(),
    listSessions: vi.fn(),
    getLatestSession: vi.fn(),
    getLatestMainSession: vi.fn(),
    getOrCreateSession: vi.fn(),
    compactSession: vi.fn(),
    summarizeAndTruncate: vi.fn(),
    writeDailyLog: vi.fn(),
    getDailyLog: vi.fn().mockReturnValue(''),
    getRecentDailyLogs: vi.fn().mockReturnValue(''),
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
    // Keyword search still runs so curated sections can merge in
    expect(ctx.memory.search).toHaveBeenCalledWith('TypeScript');
  });

  it('merges curated keyword hits when semantic returns observation hits', async () => {
    const memory = createMockMemory([
      { id: 'obs1', timestamp: '2024-01-01', type: 'note', content: 'standup notes' },
    ]);
    (memory.search as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      const kw = keywordSearchEntries(
        [
          { id: 'obs1', timestamp: '2024-01-01', type: 'note', content: 'standup notes' },
          {
            id: 'curated_crypto',
            timestamp: '',
            type: 'fact',
            content: '## Crypto\nBIP-39 entropy_check lessons',
            metadata: { source: 'curated', section: 'Crypto' },
          },
        ],
        query,
      );
      return kw;
    });
    const ctx: AgentMemoryContext = {
      agentId: 'test-agent',
      agentName: 'Test Agent',
      memory,
      semanticSearch: createMockSemanticSearch(true, [
        { id: 'sem1', timestamp: '2024-01-01', type: 'fact', content: 'wallet seed observation' },
      ]),
    };
    const tools = createMemoryTools(ctx);
    const searchTool = tools.find(t => t.name === 'memory_search')!;
    const result = JSON.parse(await searchTool.execute({ query: 'BIP-39 entropy_check' }));
    expect(result.searchMethod).toBe('semantic+keyword');
    expect(result.results.some((r: { id: string }) => r.id === 'sem1')).toBe(true);
    expect(result.results.some((r: { id: string }) => r.id === 'curated_crypto')).toBe(true);
  });

  it('falls back to keyword when semantic search returns 0 results', async () => {
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
    expect(result.searchMethod).toBe('keyword');
    expect(ctx.memory.search).toHaveBeenCalledWith('TypeScript');
  });

  it('falls back to keyword when semantic search throws', async () => {
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
    expect(result.searchMethod).toBe('keyword');
  });

  it('uses keyword search when semantic search is not enabled', async () => {
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
    expect(result.searchMethod).toBe('keyword');
  });
});
