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
        const tags = args['tags'] as string | undefined;

        const entry: MemoryEntry = {
          id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          type,
          content,
          metadata: tags ? { tags: tags.split(',').map(t => t.trim()) } : undefined,
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

        if (ctx.semanticSearch?.isEnabled()) {
          try {
            const semResults = await ctx.semanticSearch.search(query, {
              agentId: ctx.agentId,
              topK: limit,
            });
            let entries = semResults.map(r => r.entry);
            if (type) entries = entries.filter(e => e.type === type);

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
  ];
}
