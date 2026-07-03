import type { AgentToolHandler } from '../agent.js';
import type { IMemoryStore, MemoryEntry } from '../memory/types.js';
import type { SemanticMemorySearch } from '../memory/semantic-search.js';
import { createLogger } from '@markus/shared';

const log = createLogger('memory-tools');

export interface FtsSearchCallback {
  (agentId: string, query: string, opts?: { limit?: number }): Array<{
    id: string;
    agentId: string;
    type: string;
    content: string;
    createdAt: string;
  }>;
}

export interface AgentMemoryContext {
  agentId: string;
  agentName: string;
  memory: IMemoryStore;
  semanticSearch?: SemanticMemorySearch;
  ftsSearch?: FtsSearchCallback;
}

export function createMemoryTools(ctx: AgentMemoryContext): AgentToolHandler[] {
  return [
    {
      name: 'memory_save',
      description:
        'Save an observation to your memory buffer (memories.json). ' +
        'Use for individual insights, tool tips, task outcomes, facts. ' +
        'Tag with "insight" for learned principles. ' +
        'Recurring patterns (3+) are promoted to MEMORY.md during dream cycles. ' +
        'For validated knowledge, use memory_update_longterm instead.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The information to remember. Be concise but include enough context to be useful later.',
          },
          type: {
            type: 'string',
            enum: ['fact', 'note', 'insight'],
            description: 'Type: "fact" for learned information, "note" for observations/decisions, "insight" for learned principles and patterns.',
          },
          tags: {
            type: 'string',
            description: 'Optional comma-separated tags for easier retrieval (e.g., "user-preference,ui,design")',
          },
        },
        required: ['content'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const content = args['content'] as string;
        const type = (args['type'] as MemoryEntry['type']) ?? 'fact';
        const rawTags = args['tags'];
        const tagArray = Array.isArray(rawTags)
          ? rawTags.map(String)
          : typeof rawTags === 'string'
            ? rawTags.split(',').map(t => t.trim())
            : undefined;

        const entry: MemoryEntry = {
          id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          type,
          content,
          metadata: tagArray?.length ? { tags: tagArray.filter(Boolean) } : undefined,
        };

        ctx.memory.addEntry(entry);

        if (ctx.semanticSearch?.isEnabled()) {
          ctx.semanticSearch.indexMemory(entry, ctx.agentId).catch(err => {
            log.warn('Failed to index memory for semantic search', { error: String(err) });
          });
        }

        log.info('Agent saved memory', { agentId: ctx.agentId, type, contentLen: content.length });
        return JSON.stringify({ status: 'saved', id: entry.id, type });
      },
    },

    {
      name: 'memory_search',
      description:
        'Search your memories for information relevant to a query. ' +
        'Returns matching memory entries ordered by relevance. ' +
        'Use this when you need to recall past decisions, facts, or context.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query — keywords or natural language description of what you want to recall.',
          },
          type: {
            type: 'string',
            enum: ['fact', 'note', 'task_result', 'conversation'],
            description: 'Optional: filter by memory type.',
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return (default: 10).',
          },
        },
        required: ['query'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const query = args['query'] as string;
        const type = args['type'] as MemoryEntry['type'] | undefined;
        const limit = (args['limit'] as number) ?? 10;

        // Tier 1: Semantic search (best quality, but may be unavailable)
        if (ctx.semanticSearch?.isEnabled()) {
          try {
            const semResults = await ctx.semanticSearch.search(query, {
              agentId: ctx.agentId,
              topK: limit,
            });
            let entries = semResults.map(r => r.entry);
            if (type) entries = entries.filter(e => e.type === type);

            if (entries.length > 0) {
              log.debug('Semantic memory search', { agentId: ctx.agentId, query, results: entries.length });
              return JSON.stringify({
                results: entries.map(e => ({
                  id: e.id,
                  type: e.type,
                  content: e.content,
                  timestamp: e.timestamp,
                  similarity: semResults.find(r => r.entry.id === e.id)?.similarity,
                })),
                count: entries.length,
                searchMethod: 'semantic',
              });
            }
            log.info('Semantic search returned 0 results, trying FTS5', {
              agentId: ctx.agentId, query,
            });
          } catch (err) {
            log.warn('Semantic search failed, trying FTS5', { error: String(err) });
          }
        }

        // Tier 2: FTS5 full-text search (keyword-aware, indexed, faster than substring)
        if (ctx.ftsSearch) {
          try {
            const ftsResults = ctx.ftsSearch(ctx.agentId, query, { limit });
            if (ftsResults.length > 0) {
              log.debug('FTS5 memory search', { agentId: ctx.agentId, query, results: ftsResults.length });
              return JSON.stringify({
                results: ftsResults.map(e => ({
                  id: e.id,
                  type: e.type,
                  content: e.content,
                  timestamp: e.createdAt,
                })),
                count: ftsResults.length,
                searchMethod: 'fts5',
              });
            }
            log.info('FTS5 search returned 0 results, falling back to substring', {
              agentId: ctx.agentId, query,
            });
          } catch (err) {
            log.warn('FTS5 search failed, falling back to substring', { error: String(err) });
          }
        }

        // Tier 3: In-memory substring search (always available, but O(n))
        let results = ctx.memory.search(query);
        if (type) results = results.filter(e => e.type === type);
        results = results.slice(0, limit);

        log.debug('Memory search (substring)', { agentId: ctx.agentId, query, results: results.length });
        return JSON.stringify({
          results: results.map(e => ({
            id: e.id,
            type: e.type,
            content: e.content,
            timestamp: e.timestamp,
            tags: (e.metadata as Record<string, unknown>)?.tags,
          })),
          count: results.length,
          searchMethod: 'substring',
        });
      },
    },

    {
      name: 'memory_list',
      description:
        'List your recent memories, optionally filtered by type. ' +
        'Useful for reviewing what you have remembered recently.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['fact', 'note', 'task_result', 'conversation'],
            description: 'Optional: filter by memory type.',
          },
          limit: {
            type: 'number',
            description: 'Maximum entries to return (default: 15).',
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const type = args['type'] as MemoryEntry['type'] | undefined;
        const limit = (args['limit'] as number) ?? 15;

        const entries = ctx.memory.getEntries(type ?? undefined, limit);
        return JSON.stringify({
          entries: entries.map(e => ({
            id: e.id,
            type: e.type,
            content: e.content,
            timestamp: e.timestamp,
          })),
          count: entries.length,
        });
      },
    },

    {
      name: 'memory_update_longterm',
      description:
        'Update a section of your curated knowledge (MEMORY.md). ' +
        'This is your permanent knowledge base — always in your system prompt as "## Your Knowledge". ' +
        'You organize your own sections — create whatever structure makes sense for your work. ' +
        'Common sections: "procedures", "conventions", "preferences", "domain-knowledge", "evolution-log". ' +
        'In "patch" mode, append to the existing section instead of replacing it.',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            description: 'Section name/key — you choose (e.g., "procedures", "conventions", "preferences", "domain-knowledge")',
          },
          content: {
            type: 'string',
            description: 'The content to store under this section.',
          },
          mode: {
            type: 'string',
            enum: ['replace', 'patch'],
            description: 'replace (default): overwrite the section. patch: append to existing section content.',
          },
        },
        required: ['section', 'content'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const section = args['section'] as string;
        const content = args['content'] as string;
        const mode = (args['mode'] as string) ?? 'replace';

        if (mode === 'patch') {
          const existing = ctx.memory.getLongTermSection(section);
          const merged = existing ? `${existing}\n${content}` : content;
          ctx.memory.addLongTermMemory(section, merged);
        } else {
          ctx.memory.addLongTermMemory(section, content);
        }
        log.info('Agent updated long-term memory', { agentId: ctx.agentId, section, mode, contentLen: content.length });
        return JSON.stringify({ status: 'updated', section, mode });
      },
    },

    {
      name: 'memory_delete',
      description:
        'Delete specific entries from your memory buffer (memories.json). ' +
        'Use this to clean up outdated, incorrect, or redundant observations. ' +
        'Provide either a list of entry IDs (from memory_list/memory_search) or a tag to remove all entries with that tag. ' +
        'Maximum 20 entries per call.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of memory entry IDs to delete. Use memory_list or memory_search to find IDs.',
          },
          tag: {
            type: 'string',
            description: 'Delete all entries with this tag. Alternative to specifying individual IDs.',
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const ids = args['ids'] as string[] | undefined;
        const tag = args['tag'] as string | undefined;

        if (!ids?.length && !tag) {
          return JSON.stringify({ status: 'error', error: 'Provide either ids or tag to delete.' });
        }

        const MAX_DELETE = 20;
        let removed = 0;

        if (ids?.length) {
          const capped = ids.slice(0, MAX_DELETE);
          removed = ctx.memory.removeEntries(capped);
          if (ctx.semanticSearch?.isEnabled()) {
            for (const id of capped) {
              ctx.semanticSearch.deleteMemory(id).catch(err => {
                log.warn('Failed to remove memory from semantic index', { error: String(err) });
              });
            }
          }
        } else if (tag) {
          removed = ctx.memory.removeEntriesByTag(tag);
        }

        log.info('Agent deleted memories', { agentId: ctx.agentId, removed, byTag: tag ?? null });
        return JSON.stringify({ status: 'deleted', removed });
      },
    },
  ];
}
