import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SemanticMemorySearch, type EmbeddingProvider, type VectorStore } from '../src/memory/semantic-search.js';
import type { MemoryEntry } from '../src/memory/types.js';

function wordSetEmbedding(text: string): number[] {
  // Word-bag embedding: each dimension corresponds to presence of common words
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  const vocab = ['typescript', 'project', 'uses', 'the', 'agent', 'data', 'fact', 'number'];
  return vocab.map(w => words.includes(w) ? 1.0 : 0.0);
}

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 8,
    embed: vi.fn(async (text: string) => wordSetEmbedding(text)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(t => wordSetEmbedding(t))),
  };
}

function createMockVectorStore(): VectorStore & {
  data: Map<string, { embedding: number[]; agentId: string; content: string; type: string }>;
} {
  const data = new Map<string, { embedding: number[]; agentId: string; content: string; type: string }>();

  function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  return {
    data,
    upsert: vi.fn(async (id, embedding, metadata) => {
      data.set(id, { embedding, ...metadata });
    }),
    search: vi.fn(async (queryEmbedding, opts) => {
      const results: Array<{ id: string; similarity: number; content: string; type: string }> = [];
      for (const [id, item] of data) {
        if (opts.agentId && item.agentId !== opts.agentId) continue;
        const sim = cosineSimilarity(queryEmbedding, item.embedding);
        if (sim >= (opts.minSimilarity ?? 0.3)) {
          results.push({ id, similarity: sim, content: item.content, type: item.type });
        }
      }
      return results.sort((a, b) => b.similarity - a.similarity).slice(0, opts.topK);
    }),
    delete: vi.fn(async (id) => {
      data.delete(id);
    }),
  };
}

describe('SemanticMemorySearch', () => {
  let embedding: EmbeddingProvider;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let search: SemanticMemorySearch;

  beforeEach(() => {
    embedding = createMockEmbedding();
    vectorStore = createMockVectorStore();
    search = new SemanticMemorySearch(embedding, vectorStore);
  });

  it('should not be enabled before initialization', () => {
    expect(search.isEnabled()).toBe(false);
  });

  it('should be enabled after initialization', async () => {
    await search.initialize();
    expect(search.isEnabled()).toBe(true);
  });

  it('should index and retrieve memory entries', async () => {
    await search.initialize();

    const entry: MemoryEntry = {
      id: 'mem-1',
      timestamp: new Date().toISOString(),
      type: 'fact',
      content: 'The project uses TypeScript',
    };

    await search.indexMemory(entry, 'agent-1');
    expect(vectorStore.upsert).toHaveBeenCalledWith(
      'mem-1',
      expect.any(Array),
      { agentId: 'agent-1', content: 'The project uses TypeScript', type: 'fact' },
    );

    const results = await search.search('TypeScript project');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.id).toBe('mem-1');
    expect(results[0]!.similarity).toBeGreaterThan(0);
  });

  it('should filter by agentId', async () => {
    await search.initialize();

    await search.indexMemory({
      id: 'mem-a', timestamp: '', type: 'fact', content: 'Agent A data',
    }, 'agent-a');

    await search.indexMemory({
      id: 'mem-b', timestamp: '', type: 'fact', content: 'Agent B data',
    }, 'agent-b');

    const results = await search.search('data', { agentId: 'agent-a' });
    for (const r of results) {
      const stored = vectorStore.data.get(r.entry.id);
      expect(stored?.agentId).toBe('agent-a');
    }
  });

  it('should respect topK limit', async () => {
    await search.initialize();

    for (let i = 0; i < 10; i++) {
      await search.indexMemory({
        id: `mem-${i}`, timestamp: '', type: 'fact', content: `Fact number ${i}`,
      }, 'agent-1');
    }

    const results = await search.search('fact', { topK: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('should delete memory entries', async () => {
    await search.initialize();

    await search.indexMemory({
      id: 'mem-del', timestamp: '', type: 'fact', content: 'To be deleted',
    }, 'agent-1');

    expect(vectorStore.data.has('mem-del')).toBe(true);
    await search.deleteMemory('mem-del');
    expect(vectorStore.delete).toHaveBeenCalledWith('mem-del');
  });

  it('should return empty results when not enabled', async () => {
    const results = await search.search('anything');
    expect(results).toEqual([]);
  });

  it('should not index when not enabled', async () => {
    await search.indexMemory({
      id: 'mem-x', timestamp: '', type: 'fact', content: 'data',
    }, 'agent-1');
    expect(vectorStore.upsert).not.toHaveBeenCalled();
  });
});
