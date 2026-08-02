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

function storeName(memory: IMemoryStore): string {
  return typeof memory.getStoreFileName === 'function' ? memory.getStoreFileName() : 'knowledge.md';
}

function normalizeWriteMode(raw: unknown): 'replace' | 'patch' | 'delete' | string {
  const mode = typeof raw === 'string' ? raw : 'replace';
  if (mode === 'append') return 'patch';
  return mode;
}

function parseTags(rawTags: unknown): string[] | undefined {
  if (Array.isArray(rawTags)) return rawTags.map(String).map(t => t.trim()).filter(Boolean);
  if (typeof rawTags === 'string') {
    return rawTags.split(',').map(t => t.trim()).filter(Boolean);
  }
  return undefined;
}

/** Validate memory_save args before any disk write. */
export function validateMemorySaveArgs(args: unknown):
  | { ok: true; content: string; type: MemoryEntry['type']; tags?: string[] }
  | { ok: false; error: string } {
  if (Array.isArray(args)) {
    return {
      ok: false,
      error:
        'memory_save expects a single object { content, type?, tags? }, not an array. ' +
        'Call once per insight.',
    };
  }
  if (typeof args !== 'object' || args === null) {
    return { ok: false, error: 'memory_save expects an object with required string field "content".' };
  }
  const record = args as Record<string, unknown>;
  if ('severity' in record && !('type' in record)) {
    // Common model confusion — map severity→type when it matches the enum.
    const sev = record['severity'];
    if (sev === 'insight' || sev === 'fact' || sev === 'note') {
      record['type'] = sev;
    }
  }
  const content = record['content'];
  if (typeof content !== 'string' || !content.trim()) {
    return {
      ok: false,
      error:
        'memory_save requires non-empty string "content". ' +
        'Do not pass [{summary,content,...}] arrays; use one call per observation.',
    };
  }
  const typeRaw = record['type'];
  const type = (
    typeRaw === 'fact' || typeRaw === 'note' || typeRaw === 'insight'
      ? typeRaw
      : 'fact'
  ) as MemoryEntry['type'];
  return { ok: true, content: content.trim(), type, tags: parseTags(record['tags']) };
}

export function createMemoryTools(ctx: AgentMemoryContext): AgentToolHandler[] {
  return [
    {
      name: 'memory_save',
      description:
        'Save ONE observation to knowledge.md ## _observations (not auto-injected — retrieve later via memory_search). ' +
        'Args: { content: string, type?: "fact"|"note"|"insight", tags?: string|string[] }. ' +
        'Call once per insight — NEVER pass an array of objects. ' +
        'On success expect { status:"saved", store:"knowledge.md" }; on error fix args and retry — do not claim saved. ' +
        'Use after user corrections, tool gotchas, or one-line lessons. ' +
        'For multi-step procedures use memory_update instead. Recurring patterns (3+) may be promoted in dream cycles.',
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
            oneOf: [
              { type: 'string', description: 'Comma-separated tags (e.g., "user-preference,ui,design")' },
              { type: 'array', items: { type: 'string' }, description: 'Tag list' },
            ],
            description: 'Optional tags for easier retrieval (string or string array).',
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const validated = validateMemorySaveArgs(args);
        if (!validated.ok) {
          return JSON.stringify({ status: 'error', error: validated.error, store: storeName(ctx.memory) });
        }
        const { content, type, tags: tagArray } = validated;

        const entry: MemoryEntry = {
          id: `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          type,
          content,
          metadata: tagArray?.length ? { tags: tagArray } : undefined,
        };

        ctx.memory.addEntry(entry);

        if (ctx.semanticSearch?.isEnabled()) {
          ctx.semanticSearch.indexMemory(entry, ctx.agentId).catch(err => {
            log.warn('Failed to index memory for semantic search', { error: String(err) });
          });
        }

        const store = storeName(ctx.memory);
        log.info('Agent saved memory', { agentId: ctx.agentId, type, contentLen: content.length, store });
        return JSON.stringify({ status: 'saved', id: entry.id, type, store });
      },
    },

    {
      name: 'memory_search',
      description:
        'Search observations + curated sections in knowledge.md (observations are NOT in the system prompt). ' +
        'Matches by keywords (any token), not the whole query as one phrase. ' +
        'Call before non-trivial work that may repeat past mistakes or user corrections. ' +
        'Empty query lists recent observations. Returns matches ranked by keyword hit count.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords or natural language (space-separated terms OR-matched). Empty = list recent observations.',
          },
          type: {
            type: 'string',
            enum: ['fact', 'note', 'task_result', 'conversation', 'insight'],
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
        const store = storeName(ctx.memory);

        // Empty query = list recent observations
        if (!query.trim()) {
          const entries = ctx.memory.getEntries(type ?? undefined, limit);
          return JSON.stringify({
            entries: entries.map(e => ({
              id: e.id, type: e.type, content: e.content, timestamp: e.timestamp,
              tags: (e.metadata as Record<string, unknown>)?.tags,
            })),
            count: entries.length,
            store,
          });
        }

        // Keyword path always runs (covers curated knowledge.md sections).
        let keywordResults = ctx.memory.search(query);
        if (type) keywordResults = keywordResults.filter(e => e.type === type);

        if (ctx.semanticSearch?.isEnabled()) {
          try {
            const semResults = await ctx.semanticSearch.search(query, {
              agentId: ctx.agentId,
              topK: limit,
            });
            let semEntries = semResults.map(r => r.entry);
            if (type) semEntries = semEntries.filter(e => e.type === type);

            if (semEntries.length > 0) {
              // Merge: semantic hits first, then keyword/curated misses semantic skipped
              const seen = new Set(semEntries.map(e => e.id));
              const extras = keywordResults.filter(e => !seen.has(e.id));
              const merged = [...semEntries, ...extras].slice(0, limit);
              log.debug('Semantic+keyword memory search', {
                agentId: ctx.agentId, query, semantic: semEntries.length, keywordExtra: extras.length,
              });
              return JSON.stringify({
                results: merged.map(e => ({
                  id: e.id,
                  type: e.type,
                  content: e.content,
                  timestamp: e.timestamp,
                  similarity: semResults.find(r => r.entry.id === e.id)?.similarity,
                  tags: (e.metadata as Record<string, unknown>)?.tags,
                  source: (e.metadata as Record<string, unknown>)?.source,
                })),
                count: merged.length,
                searchMethod: extras.length > 0 ? 'semantic+keyword' : 'semantic',
                store,
              });
            }
            log.info('Semantic search returned 0 results, using keyword search', {
              agentId: ctx.agentId, query,
            });
          } catch (err) {
            log.warn('Semantic search failed, using keyword search', { error: String(err) });
          }
        }

        const results = keywordResults.slice(0, limit);
        log.debug('Memory search (keyword)', { agentId: ctx.agentId, query, results: results.length });
        return JSON.stringify({
          results: results.map(e => ({
            id: e.id,
            type: e.type,
            content: e.content,
            timestamp: e.timestamp,
            tags: (e.metadata as Record<string, unknown>)?.tags,
            source: (e.metadata as Record<string, unknown>)?.source,
          })),
          count: results.length,
          searchMethod: 'keyword',
          store,
        });
      },
    },

    {
      name: 'memory_update',
      description:
        'Update a curated section in knowledge.md (injected as "## Your Knowledge" on later turns). ' +
        'Use for personal multi-step procedures / durable domain lessons — not one-off tips (use memory_save). ' +
        'Args: { section, content, mode?: "replace"|"patch"|"append"|"delete" }. append≡patch. ' +
        'Prefer patch/append; replace only when rewriting the whole section. ' +
        'Do not put ## headings in content (auto-downgraded to ###). ' +
        'Success: { status:"updated", store:"knowledge.md" }. On error, retry — never claim updated without status.',
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
            enum: ['replace', 'patch', 'append', 'delete'],
            description: 'replace (default): overwrite. patch/append: append to existing. delete: remove observations by ID (use "ids" parameter).',
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
        const mode = normalizeWriteMode(args['mode']);
        const ids = args['ids'] as string[] | undefined;
        const store = storeName(ctx.memory);

        if (mode === 'delete') {
          if (!ids?.length) {
            return JSON.stringify({ status: 'error', error: 'Provide ids to delete.', store });
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
          return JSON.stringify({ status: 'deleted', removed, store });
        }

        if (!section?.trim()) {
          return JSON.stringify({ status: 'error', error: 'section is required', store });
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
          return JSON.stringify({ status: 'error', ok: false, error: writeResult.reason ?? 'knowledge.md write refused', section, mode, store });
        }
        log.info('Agent updated long-term memory', { agentId: ctx.agentId, section, mode, contentLen: content.length, store });
        return JSON.stringify({ status: 'updated', section, mode, store });
      },
    },

    // Backward compatibility aliases
    {
      name: 'memory_list',
      description: '[Alias for memory_search with empty query] List recent observations.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['fact', 'note', 'task_result', 'conversation', 'insight'], description: 'Filter by type.' },
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
          store: storeName(ctx.memory),
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
        const store = storeName(ctx.memory);
        if (!ids?.length && !tag) return JSON.stringify({ status: 'error', error: 'Provide ids or tag.', store });
        let removed = 0;
        if (ids?.length) {
          removed = ctx.memory.removeEntries(ids.slice(0, 20));
        } else if (tag) {
          removed = ctx.memory.removeEntriesByTag(tag);
        }
        return JSON.stringify({ status: 'deleted', removed, store });
      },
    },
    {
      name: 'memory_update_longterm',
      description:
        '[Alias for memory_update] Patch/replace a curated knowledge.md section (## Your Knowledge). ' +
        'Prefer mode patch/append. Success includes store:"knowledge.md"; verify before claiming success.',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', description: 'Section name' },
          content: { type: 'string', description: 'Content to store' },
          mode: { type: 'string', enum: ['replace', 'patch', 'append'], description: 'replace, patch, or append (alias of patch)' },
        },
        required: ['section', 'content'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const section = args['section'] as string;
        const content = args['content'] as string;
        const mode = normalizeWriteMode(args['mode']);
        const store = storeName(ctx.memory);
        let writeResult: { ok: boolean; reason?: string };
        if (mode === 'patch') {
          const existing = ctx.memory.getLongTermSection(section);
          writeResult = ctx.memory.addLongTermMemory(section, existing ? `${existing}\n${content}` : content);
        } else {
          writeResult = ctx.memory.addLongTermMemory(section, content);
        }
        if (!writeResult.ok) {
          return JSON.stringify({ status: 'error', ok: false, error: writeResult.reason ?? 'knowledge.md write refused', section, mode, store });
        }
        return JSON.stringify({ status: 'updated', section, mode, store });
      },
    },
  ];
}
