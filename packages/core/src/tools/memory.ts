import type { AgentToolHandler } from '../agent.js';
import type { IMemoryStore, MemoryEntry } from '../memory/types.js';
import type { SemanticMemorySearch } from '../memory/semantic-search.js';
import { createLogger } from '@markus/shared';

const log = createLogger('memory-tools');

export interface AgentMemoryContext {
  agentId: string;
  agentName: string;
  memory: IMemoryStore;
  semanticSearch?: SemanticMemorySearch;
}

export function createMemoryTools(ctx: AgentMemoryContext): AgentToolHandler[] {
  return [
    {
      name: 'memory_save',
      description:
        'Save an observation to your memory (## _observations in MEMORY.md). ' +
        'Use for individual insights, tool tips, task outcomes, facts. ' +
        'Tag with "insight" for learned principles. ' +
        'Recurring patterns (3+) are promoted to curated knowledge during dream cycles. ' +
        'For validated knowledge, use memory_update instead.',
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
          id: `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
        'Search your memories across both observations and curated knowledge. ' +
        'Returns matching entries ordered by relevance. ' +
        'Use with an empty query to list recent observations.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query — keywords or natural language. Leave empty to list recent observations.',
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
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const query = (args['query'] as string) ?? '';
        const type = args['type'] as MemoryEntry['type'] | undefined;
        const limit = (args['limit'] as number) ?? 10;

        // Empty query = list recent observations
        if (!query.trim()) {
          const entries = ctx.memory.getEntries(type ?? undefined, limit);
          return JSON.stringify({
            entries: entries.map(e => ({
              id: e.id, type: e.type, content: e.content, timestamp: e.timestamp,
              tags: (e.metadata as Record<string, unknown>)?.tags,
            })),
            count: entries.length,
          });
        }

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
            log.info('Semantic search returned 0 results, falling back to substring', {
              agentId: ctx.agentId, query,
            });
          } catch (err) {
            log.warn('Semantic search failed, falling back to substring', { error: String(err) });
          }
        }

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
      name: 'memory_update',
      description:
        'Update a section of your curated knowledge (MEMORY.md). ' +
        'This is your permanent knowledge base — always in your system prompt as "## Your Knowledge". ' +
        'You organize your own sections — create whatever structure makes sense for your work. ' +
        'Common sections: "procedures", "conventions", "preferences", "domain-knowledge". ' +
        'Modes: "replace" overwrites the section, "patch" appends to it, "delete" removes entries by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            description: 'Section name/key — you choose (e.g., "procedures", "conventions", "preferences")',
          },
          content: {
            type: 'string',
            description: 'The content to store under this section.',
          },
          mode: {
            type: 'string',
            enum: ['replace', 'patch', 'delete'],
            description: 'replace (default): overwrite. patch: append to existing. delete: remove observations by ID (use "ids" parameter).',
          },
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'When mode="delete": array of observation entry IDs to remove (max 20).',
          },
        },
        required: ['section'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const section = args['section'] as string;
        const content = (args['content'] as string) ?? '';
        const mode = (args['mode'] as string) ?? 'replace';
        const ids = args['ids'] as string[] | undefined;

        if (mode === 'delete') {
          if (!ids?.length) {
            return JSON.stringify({ status: 'error', error: 'Provide ids to delete.' });
          }
          const capped = ids.slice(0, 20);
          const removed = ctx.memory.removeEntries(capped);
          if (ctx.semanticSearch?.isEnabled()) {
            for (const id of capped) {
              ctx.semanticSearch.deleteMemory(id).catch(err => {
                log.warn('Failed to remove from semantic index', { error: String(err) });
              });
            }
          }
          log.info('Agent deleted memories', { agentId: ctx.agentId, removed });
          return JSON.stringify({ status: 'deleted', removed });
        }

        let writeResult: { ok: boolean; reason?: string };
        if (mode === 'patch') {
          const existing = ctx.memory.getLongTermSection(section);
          const merged = existing ? `${existing}\n${content}` : content;
          writeResult = ctx.memory.addLongTermMemory(section, merged);
        } else {
          writeResult = ctx.memory.addLongTermMemory(section, content);
        }
        if (!writeResult.ok) {
          log.warn('Agent long-term memory write refused', { agentId: ctx.agentId, section, mode, reason: writeResult.reason });
          return JSON.stringify({ status: 'error', ok: false, error: writeResult.reason ?? 'MEMORY.md write refused', section, mode });
        }
        log.info('Agent updated long-term memory', { agentId: ctx.agentId, section, mode, contentLen: content.length });
        return JSON.stringify({ status: 'updated', section, mode });
      },
    },

    // Backward compatibility aliases
    {
      name: 'memory_list',
      description: '[Alias for memory_search with empty query] List recent observations.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['fact', 'note', 'task_result', 'conversation'], description: 'Filter by type.' },
          limit: { type: 'number', description: 'Maximum entries (default: 15).' },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const type = args['type'] as MemoryEntry['type'] | undefined;
        const limit = (args['limit'] as number) ?? 15;
        const entries = ctx.memory.getEntries(type ?? undefined, limit);
        return JSON.stringify({
          entries: entries.map(e => ({
            id: e.id, type: e.type, content: e.content, timestamp: e.timestamp,
          })),
          count: entries.length,
        });
      },
    },
    {
      name: 'memory_delete',
      description: '[Alias for memory_update with mode="delete"] Remove observation entries by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Entry IDs to delete.' },
          tag: { type: 'string', description: 'Delete all entries with this tag.' },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const ids = args['ids'] as string[] | undefined;
        const tag = args['tag'] as string | undefined;
        if (!ids?.length && !tag) return JSON.stringify({ status: 'error', error: 'Provide ids or tag.' });
        let removed = 0;
        if (ids?.length) {
          removed = ctx.memory.removeEntries(ids.slice(0, 20));
        } else if (tag) {
          removed = ctx.memory.removeEntriesByTag(tag);
        }
        return JSON.stringify({ status: 'deleted', removed });
      },
    },
    {
      name: 'memory_update_longterm',
      description: '[Alias for memory_update] Update curated knowledge section in MEMORY.md.',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', description: 'Section name' },
          content: { type: 'string', description: 'Content to store' },
          mode: { type: 'string', enum: ['replace', 'patch'], description: 'replace or patch' },
        },
        required: ['section', 'content'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const section = args['section'] as string;
        const content = args['content'] as string;
        const mode = (args['mode'] as string) ?? 'replace';
        let writeResult: { ok: boolean; reason?: string };
        if (mode === 'patch') {
          const existing = ctx.memory.getLongTermSection(section);
          writeResult = ctx.memory.addLongTermMemory(section, existing ? `${existing}\n${content}` : content);
        } else {
          writeResult = ctx.memory.addLongTermMemory(section, content);
        }
        if (!writeResult.ok) {
          return JSON.stringify({ status: 'error', ok: false, error: writeResult.reason ?? 'MEMORY.md write refused', section, mode });
        }
        return JSON.stringify({ status: 'updated', section, mode });
      },
    },
  ];
}
