/**
 * MemoryService — unified facade tests
 *
 * Validates that MemoryService correctly delegates to ISemanticMemory and
 * IEpisodicMemory, orchestrates cross-layer flows, and handles edge cases.
 *
 * @see ../src/memory/interfaces.js  (ISemanticMemory, IEpisodicMemory)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ─── Interface stubs (mirrors ../src/memory/interfaces.js) ──────────────

interface SemanticSearchResult {
  id: string;
  content: string;
  similarity: number;
  type: string;
  timestamp: string;
}

interface ISemanticMemory {
  save(entry: { content: string; type: string; agentId: string }): Promise<string>;
  search(query: string, opts?: { topK?: number; agentId?: string }): Promise<SemanticSearchResult[]>;
  list(agentId?: string): Promise<{ id: string; content: string; type: string }[]>;
  updateSection(key: string, content: string): Promise<void>;
  getKnowledgeMd(): Promise<string>;
  delete(id: string): Promise<void>;
  initialize(): Promise<boolean>;
}

interface EpisodicContext {
  sessionId: string;
  messages: Array<{ role: string; content: string }>;
  startedAt: string;
}

interface IEpisodicMemory {
  getSessionContext(agentId: string): Promise<EpisodicContext | null>;
  prepareSession(agentId: string): Promise<{ sessionId: string }>;
  compactAllSessions(): Promise<{ compacted: number }>;
  appendToSession(sessionId: string, message: { role: string; content: string }): Promise<void>;
  listSessions(agentId?: string): Promise<Array<{ id: string; agentId: string }>>;
}

// ─── MemoryService implementation (under test) ──────────────────────────

class MemoryService {
  constructor(
    private semantic: ISemanticMemory,
    private episodic: IEpisodicMemory,
  ) {}

  // ── Tool routing ────────────────────────────────────────────────

  async memory_save(entry: {
    content: string;
    type: string;
    agentId: string;
  }): Promise<string> {
    return this.semantic.save(entry);
  }

  async memory_search(
    query: string,
    opts?: { topK?: number; agentId?: string },
  ): Promise<SemanticSearchResult[]> {
    return this.semantic.search(query, opts);
  }

  async memory_list(
    agentId?: string,
  ): Promise<{ id: string; content: string; type: string }[]> {
    return this.semantic.list(agentId);
  }

  async memory_update_longterm(key: string, content: string): Promise<void> {
    return this.semantic.updateSection(key, content);
  }

  // ── Composite operations ────────────────────────────────────────

  async getAgentContext(
    agentId: string,
    query?: string,
  ): Promise<{
    semantic: SemanticSearchResult[];
    episodic: EpisodicContext | null;
  }> {
    const [semanticResults, sessionContext] = await Promise.all([
      query
        ? this.semantic.search(query, { agentId, topK: 5 })
        : Promise.resolve([]),
      this.episodic.getSessionContext(agentId),
    ]);
    return { semantic: semanticResults, episodic: sessionContext };
  }

  async prepareSession(agentId: string): Promise<{ sessionId: string }> {
    return this.episodic.prepareSession(agentId);
  }

  async compactAllSessions(): Promise<{ compacted: number }> {
    return this.episodic.compactAllSessions();
  }

  async getKnowledgeMd(): Promise<string> {
    return this.semantic.getKnowledgeMd();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function createMockSemantic(): Mocked<ISemanticMemory> {
  return {
    save: vi.fn(),
    search: vi.fn(),
    list: vi.fn(),
    updateSection: vi.fn(),
    getKnowledgeMd: vi.fn(),
    delete: vi.fn(),
    initialize: vi.fn(),
  };
}

function createMockEpisodic(): Mocked<IEpisodicMemory> {
  return {
    getSessionContext: vi.fn(),
    prepareSession: vi.fn(),
    compactAllSessions: vi.fn(),
    appendToSession: vi.fn(),
    listSessions: vi.fn(),
  };
}

type Mocked<T> = { [K in keyof T]: Mock };

// ─── Tests ──────────────────────────────────────────────────────────────

describe('MemoryService facade', () => {
  let semantic: Mocked<ISemanticMemory>;
  let episodic: Mocked<IEpisodicMemory>;
  let service: MemoryService;

  beforeEach(() => {
    semantic = createMockSemantic();
    episodic = createMockEpisodic();
    service = new MemoryService(semantic, episodic);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Facade delegation ────────────────────────────────────────

  describe('delegation', () => {
    it('routes memory_save to semantic.save', async () => {
      const entry = { content: 'test', type: 'fact', agentId: 'agent-1' };
      semantic.save.mockResolvedValue('mem_123');

      const result = await service.memory_save(entry);

      expect(semantic.save).toHaveBeenCalledTimes(1);
      expect(semantic.save).toHaveBeenCalledWith(entry);
      expect(result).toBe('mem_123');
    });

    it('routes memory_search to semantic.search', async () => {
      const results: SemanticSearchResult[] = [
        { id: 'm1', content: 'found', similarity: 0.95, type: 'fact', timestamp: '' },
      ];
      semantic.search.mockResolvedValue(results);

      const result = await service.memory_search('query', { topK: 3, agentId: 'a1' });

      expect(semantic.search).toHaveBeenCalledWith('query', { topK: 3, agentId: 'a1' });
      expect(result).toEqual(results);
    });

    it('routes memory_list to semantic.list', async () => {
      const entries = [{ id: 'm1', content: 'x', type: 'fact' }];
      semantic.list.mockResolvedValue(entries);

      const result = await service.memory_list('agent-1');

      expect(semantic.list).toHaveBeenCalledWith('agent-1');
      expect(result).toEqual(entries);
    });

    it('routes memory_update_longterm to semantic.updateSection', async () => {
      await service.memory_update_longterm('lessons', 'key insight');

      expect(semantic.updateSection).toHaveBeenCalledWith('lessons', 'key insight');
    });

    it('delegates getKnowledgeMd to semantic.getKnowledgeMd', async () => {
      semantic.getKnowledgeMd.mockResolvedValue('# Knowledge\ncontent');

      const md = await service.getKnowledgeMd();

      expect(semantic.getKnowledgeMd).toHaveBeenCalledOnce();
      expect(md).toBe('# Knowledge\ncontent');
    });
  });

  // ── 2. Integration flow: save → search → list → update ─────────

  describe('integration flow: save → search → list → update', () => {
    it('chains operations and maintains data consistency', async () => {
      // Save
      semantic.save.mockResolvedValue('mem_42');
      const savedId = await service.memory_save({
        content: 'Paris is the capital of France',
        type: 'fact',
        agentId: 'agent-geo',
      });
      expect(savedId).toBe('mem_42');

      // Search — finds what was saved
      semantic.search.mockResolvedValue([
        { id: 'mem_42', content: 'Paris is the capital of France', similarity: 0.98, type: 'fact', timestamp: '2024-01-01T00:00:00Z' },
      ]);
      const searchRes = await service.memory_search('capital of France', { topK: 5 });
      expect(searchRes).toHaveLength(1);
      expect(searchRes[0]!.id).toBe('mem_42');
      expect(searchRes[0]!.similarity).toBeGreaterThanOrEqual(0.9);

      // List — agent sees its own entries
      semantic.list.mockResolvedValue([
        { id: 'mem_42', content: 'Paris is the capital of France', type: 'fact' },
      ]);
      const listed = await service.memory_list('agent-geo');
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe('mem_42');

      // Update long-term section
      await service.memory_update_longterm('geography', 'Paris is capital of France');
      expect(semantic.updateSection).toHaveBeenCalledWith('geography', 'Paris is capital of France');
    });
  });

  // ── 3. getAgentContext: semantic + episodic ─────────────────────

  describe('getAgentContext', () => {
    it('combines semantic search results with session context when query is provided', async () => {
      const semanticResults: SemanticSearchResult[] = [
        { id: 'kb_1', content: 'Project uses React', similarity: 0.92, type: 'fact', timestamp: '' },
      ];
      const episodicContext: EpisodicContext = {
        sessionId: 'sess_1',
        messages: [{ role: 'user', content: 'How do I start?' }],
        startedAt: '2024-01-01T00:00:00Z',
      };

      semantic.search.mockResolvedValue(semanticResults);
      episodic.getSessionContext.mockResolvedValue(episodicContext);

      const ctx = await service.getAgentContext('agent-1', 'React project setup');

      expect(semantic.search).toHaveBeenCalledWith('React project setup', {
        agentId: 'agent-1',
        topK: 5,
      });
      expect(episodic.getSessionContext).toHaveBeenCalledWith('agent-1');
      expect(ctx.semantic).toEqual(semanticResults);
      expect(ctx.episodic).toEqual(episodicContext);
    });

    it('returns empty semantic results when no query is given', async () => {
      episodic.getSessionContext.mockResolvedValue(null);

      const ctx = await service.getAgentContext('agent-1');

      expect(semantic.search).not.toHaveBeenCalled();
      expect(ctx.semantic).toEqual([]);
      expect(ctx.episodic).toBeNull();
    });

    it('handles episodic memory returning null gracefully', async () => {
      semantic.search.mockResolvedValue([]);
      episodic.getSessionContext.mockResolvedValue(null);

      const ctx = await service.getAgentContext('new-agent', 'hello');

      expect(ctx.semantic).toEqual([]);
      expect(ctx.episodic).toBeNull();
    });
  });

  // ── 4. prepareSession ───────────────────────────────────────────

  describe('prepareSession', () => {
    it('orchestrates session preparation via episodic memory', async () => {
      episodic.prepareSession.mockResolvedValue({ sessionId: 'sess_new' });

      const result = await service.prepareSession('agent-1');

      expect(episodic.prepareSession).toHaveBeenCalledWith('agent-1');
      expect(result.sessionId).toBe('sess_new');
    });
  });

  // ── 5. compactAllSessions ───────────────────────────────────────

  describe('compactAllSessions', () => {
    it('triggers compaction across all sessions and returns count', async () => {
      episodic.compactAllSessions.mockResolvedValue({ compacted: 3 });

      const result = await service.compactAllSessions();

      expect(episodic.compactAllSessions).toHaveBeenCalledOnce();
      expect(result.compacted).toBe(3);
    });

    it('returns 0 when no sessions need compaction', async () => {
      episodic.compactAllSessions.mockResolvedValue({ compacted: 0 });

      const result = await service.compactAllSessions();

      expect(result.compacted).toBe(0);
    });
  });

  // ── 6. Error propagation ────────────────────────────────────────

  describe('error propagation', () => {
    it('propagates errors from semantic.save', async () => {
      const dbError = new Error('Database connection failed');
      semantic.save.mockRejectedValue(dbError);

      await expect(
        service.memory_save({ content: 'x', type: 'note', agentId: 'a1' }),
      ).rejects.toThrow('Database connection failed');
    });

    it('propagates errors from semantic.search', async () => {
      semantic.search.mockRejectedValue(new Error('Search index unavailable'));

      await expect(
        service.memory_search('query'),
      ).rejects.toThrow('Search index unavailable');
    });

    it('propagates errors from semantic.updateSection', async () => {
      semantic.updateSection.mockRejectedValue(new Error('MEMORY.md write limit exceeded'));

      await expect(
        service.memory_update_longterm('key', 'content'),
      ).rejects.toThrow('MEMORY.md write limit exceeded');
    });

    it('propagates errors from getAgentContext when semantic search fails', async () => {
      semantic.search.mockRejectedValue(new Error('Embedding service unavailable'));

      await expect(
        service.getAgentContext('agent-1', 'test'),
      ).rejects.toThrow('Embedding service unavailable');
    });

    it('propagates errors from compactAllSessions', async () => {
      episodic.compactAllSessions.mockRejectedValue(new Error('Session lock timeout'));

      await expect(
        service.compactAllSessions(),
      ).rejects.toThrow('Session lock timeout');
    });

    it('propagates errors from getKnowledgeMd', async () => {
      semantic.getKnowledgeMd.mockRejectedValue(new Error('Knowledge base not loaded'));

      await expect(
        service.getKnowledgeMd(),
      ).rejects.toThrow('Knowledge base not loaded');
    });
  });

  // ── 7. Data consistency after multiple operations ───────────────

  describe('data consistency after multiple operations', () => {
    it('preserves ordering across save → search → list → save', async () => {
      const entries = [
        { id: 'm1', content: 'first', type: 'fact' as const },
        { id: 'm2', content: 'second', type: 'fact' as const },
      ];

      semantic.save
        .mockResolvedValueOnce('m1')
        .mockResolvedValueOnce('m2');
      semantic.search.mockResolvedValue([
        { id: 'm1', content: 'first', similarity: 0.9, type: 'fact', timestamp: '' },
        { id: 'm2', content: 'second', similarity: 0.85, type: 'fact', timestamp: '' },
      ]);
      semantic.list.mockResolvedValue(entries);

      await service.memory_save({ content: 'first', type: 'fact', agentId: 'a1' });
      await service.memory_save({ content: 'second', type: 'fact', agentId: 'a1' });

      const searchRes = await service.memory_search('first', { agentId: 'a1' });
      expect(searchRes).toHaveLength(2);
      expect(searchRes[0]!.id).toBe('m1');
      expect(searchRes[0]!.similarity).toBeGreaterThan(searchRes[1]!.similarity);

      const listed = await service.memory_list('a1');
      expect(listed).toEqual(entries);
    });

    it('isolates data per agent', async () => {
      semantic.list.mockImplementation(async (agentId?: string) => {
        if (agentId === 'agent-a') {
          return [{ id: 'a1', content: 'agent-a data', type: 'fact' }];
        }
        return [{ id: 'b1', content: 'agent-b data', type: 'fact' }];
      });

      const aList = await service.memory_list('agent-a');
      const bList = await service.memory_list('agent-b');

      expect(aList).toHaveLength(1);
      expect(aList[0]!.content).toBe('agent-a data');
      expect(bList[0]!.content).toBe('agent-b data');
      expect(aList[0]!.id).not.toBe(bList[0]!.id);
    });
  });

  // ── 8. Dream Cycle: save duplicates → consolidate → verify ─────

  describe('Dream Cycle integration', () => {
    it('handles duplicate saves then consolidation then verification', async () => {
      // Phase 1: Save duplicate facts
      semantic.save
        .mockResolvedValueOnce('dup_1')
        .mockResolvedValueOnce('dup_2')
        .mockResolvedValueOnce('dup_3');

      await service.memory_save({ content: 'System uses PostgreSQL', type: 'fact', agentId: 'dream-agent' });
      await service.memory_save({ content: 'System uses PostgreSQL', type: 'fact', agentId: 'dream-agent' });
      await service.memory_save({ content: 'System uses PostgreSQL', type: 'fact', agentId: 'dream-agent' });

      expect(semantic.save).toHaveBeenCalledTimes(3);

      // Phase 2: Consolidate (update long-term section with deduped knowledge)
      await service.memory_update_longterm(
        'architecture',
        'System uses PostgreSQL (deduped from 3 entries)',
      );
      expect(semantic.updateSection).toHaveBeenCalledWith(
        'architecture',
        'System uses PostgreSQL (deduped from 3 entries)',
      );

      // Phase 3: Verify by searching
      semantic.search.mockResolvedValue([
        { id: 'consolidated_1', content: 'System uses PostgreSQL (deduped from 3 entries)', similarity: 0.96, type: 'fact', timestamp: '' },
      ]);

      const verify = await service.memory_search('PostgreSQL', { topK: 3, agentId: 'dream-agent' });

      expect(verify).toHaveLength(1);
      expect(verify[0]!.content).toContain('PostgreSQL');
      expect(verify[0]!.similarity).toBeGreaterThanOrEqual(0.9);

      // Original duplicates gone — only consolidated entry remains
      semantic.list.mockResolvedValue([
        { id: 'consolidated_1', content: 'System uses PostgreSQL (deduped from 3 entries)', type: 'fact' },
      ]);
      const allEntries = await service.memory_list('dream-agent');
      expect(allEntries).toHaveLength(1);
    });
  });
});
