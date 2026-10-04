import type { AgentToolHandler } from '../agent.js';
import type { IMemoryStore, MemoryEntry } from '../memory/types.js';
import type { SemanticMemorySearch } from '../memory/semantic-search.js';
import { createLogger, MEMORY_HEALTH_WARN_PERCENT } from '@markus/shared';

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

function normalizeWriteMode(raw: unknown): 'replace' | 'patch' | 'delete' | 'forget' | string {
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

        const wrote = ctx.memory.addEntry(entry);
        // Tolerate legacy/mock stores that return void — only an explicit refusal blocks.
        if (wrote && wrote.ok === false) {
          // §24 — the store REFUSES past its hard ceiling and moves nothing. Surfacing the
          // verdict is the whole point: the AGENT decides how to make room (no silent eviction).
          return JSON.stringify({
            status: 'error', ok: false, id: entry.id,
            error: wrote.reason ?? 'memory write refused', store: storeName(ctx.memory),
          });
        }

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
        'Args: { section, content, mode?: "replace"|"patch"|"append"|"forget"|"delete" }. append≡patch. ' +
        'Prefer patch/append; replace only when rewriting the whole section. ' +
        'Mode="forget" removes the named curated section entirely (superseded knowledge must be ' +
        'removable — the store is capped, so a write-only store would inflate until it fills up). ' +
        'Reserved key `_preamble` targets the text BEFORE the first `## ` heading (legacy scaffold). ' +
        'mode="delete" removes observation entries listed in "ids". ' +
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
            enum: ['replace', 'patch', 'append', 'forget', 'delete'],
            description: 'replace (default): overwrite. patch/append: append to existing. forget: remove the whole curated section (content not needed). delete: remove observations by ID (use "ids").',
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

        // §27 — reserved key for the curated region's PREAMBLE (text before the first `## `).
        // The section-based tools could not reach it, so legacy preamble was injected forever.
        if (section === '_preamble') {
          if (mode === 'forget' || mode === 'delete') {
            const r = ctx.memory.removeLongTermPreamble?.();
            if (!r) return JSON.stringify({ status: 'error', error: 'this store does not support preamble removal', store });
            if (!r.ok) return JSON.stringify({ status: 'error', error: 'preamble removal refused', store });
            log.info('Agent cleared the curated preamble', { agentId: ctx.agentId, removedChars: r.removedChars });
            return JSON.stringify({ status: 'forgotten', section: '_preamble', removedChars: r.removedChars, store });
          }
          const w = ctx.memory.setLongTermPreamble?.(content);
          if (!w) return JSON.stringify({ status: 'error', error: 'this store does not support a preamble', store });
          if (!w.ok) return JSON.stringify({ status: 'error', error: w.reason ?? 'preamble write refused', section, store });
          return JSON.stringify({ status: 'updated', section: '_preamble', mode, store });
        }

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

        if (mode === 'forget') {
          if (!section?.trim()) {
            return JSON.stringify({ status: 'error', error: 'Provide the section name to forget.', store });
          }
          const result = ctx.memory.removeLongTermSection(section);
          if (!result.ok) {
            return JSON.stringify({ status: 'error', error: result.reason ?? 'Failed to forget section.', store });
          }
          log.info('Agent forgot a curated section', {
            agentId: ctx.agentId, section, removedChars: result.removedChars,
          });
          return JSON.stringify({
            status: 'forgotten',
            section,
            removedChars: result.removedChars,
            reason: `Section "${section}" removed from ${store}.`,
            store,
          });
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

    {
      name: 'memory_stats',
      description:
        'Inspect your memory health: the CURATED (injected) knowledge budget vs its cap, plus the ' +
        'separate `## _observations` buffer usage, observation count and curated section count. ' +
        'Note the two budgets are independent — the observation buffer is NOT injected into the prompt. ' +
        'Use periodically (or when memory feels bloated) to decide whether to run memory_organize. ' +
        'Returns JSON with budget usage percent. No args.',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        const store = storeName(ctx.memory);
        // SSOT：预算口径必须与提示词横幅（context-engine「记忆健康」行）完全一致，
        // 否则会出现「横幅说 122%、工具说 95%」的自相矛盾（审计 P-12/P-16）。
        // 现在是两个**独立**预算，分开报：curated（注入）与观察缓冲（不注入）。
        const health = ctx.memory.getMemoryHealth();
        const curated = ctx.memory.getLongTermMemory();
        const obs = ctx.memory.getObservations();
        const sectionNames = [...curated.matchAll(/^## (.+)$/gm)]
          .map((m) => m[1]!)
          .filter((n) => n !== '_observations');
        const obsChars = obs.reduce((s, e) => s + (e.content?.length ?? 0), 0);
        return JSON.stringify({
          status: 'ok',
          store,
          // The injected budget — the one that actually costs prompt space.
          budget: {
            curatedChars: health.curatedChars,
            limit: health.curatedCap,
            usedPercent: health.percent,
          },
          // A separate, non-injected budget (searched on demand).
          observationBuffer: {
            chars: health.observationChars,
            limit: health.observationCap,
            usedPercent: health.observationPercent,
          },
          observations: { count: obs.length, chars: obsChars },
          curatedSections: { count: sectionNames.length, names: sectionNames.slice(0, 20) },
          archivedChars: health.archiveChars,
          lastConsolidatedAt: health.lastConsolidatedAt,
          hint: health.percent >= MEMORY_HEALTH_WARN_PERCENT
            ? 'Injected knowledge is near its budget — run memory_organize to merge sections, or memory_update mode="forget" on superseded knowledge.'
            : undefined,
          observationHint: health.observationPercent >= MEMORY_HEALTH_WARN_PERCENT
            ? 'The observation buffer is near its own limit (it is NOT injected into the prompt). It is trimmed losslessly, oldest-first, when it overflows — memory_organize merges recurring patterns into curated sections before that happens.'
            : undefined,
        });
      },
    },

    {
      name: 'memory_organize',
      description:
        'Merge matching observations from ## _observations into a curated section and archive them. ' +
        'Args: { target_section: string (required), query?: string, ids?: string[], limit?: number }. ' +
        'Selects observations whose content matches `query` keywords OR whose ids are listed, appends them as bullet lines ' +
        'under target_section (budget-aware), then removes them from _observations. ' +
        'Returns { status, moved, archived, section }. Use to consolidate scattered observations into durable knowledge ' +
        '(the manual counterpart of dream-cycle consolidation).',
      inputSchema: {
        type: 'object',
        properties: {
          target_section: {
            type: 'string',
            description: 'Curated section to append the merged observations into (e.g. "procedures", "conventions").',
          },
          query: {
            type: 'string',
            description: 'Keyword filter — observations whose content contains any of these tokens (OR-match) get merged. Omit to use ids only.',
          },
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Explicit observation entry IDs to merge (from memory_search / memory_list).',
          },
          limit: {
            type: 'number',
            description: 'Max observations to merge in one call (default 20, max 50).',
          },
        },
        required: ['target_section'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const store = storeName(ctx.memory);
        const target = String(args['target_section'] ?? '').trim();
        if (!target) {
          return JSON.stringify({ status: 'error', error: 'target_section is required.', store });
        }
        if (/^_observations$/i.test(target)) {
          return JSON.stringify({
            status: 'error',
            error: 'The `_observations` buffer is not a curated section — merge INTO a named section (e.g. "procedures").',
            store,
          });
        }
        const query = String(args['query'] ?? '').trim().toLowerCase();
        const ids = Array.isArray(args['ids']) ? args['ids'].map(String) : [];
        const limit = Math.min(Math.max(Number(args['limit']) || 20, 1), 50);

        const all = ctx.memory.getObservations();
        let matches = all;
        if (ids.length > 0) {
          const idSet = new Set(ids);
          matches = matches.filter((e) => idSet.has(e.id));
        }
        if (query) {
          matches = matches.filter(
            (e) =>
              (e.content ?? '').toLowerCase().includes(query) ||
              JSON.stringify(e.metadata ?? {}).toLowerCase().includes(query),
          );
        }
        if (matches.length === 0) {
          return JSON.stringify({
            status: 'ok',
            moved: 0,
            archived: 0,
            section: target,
            message: 'No matching observations found.',
            store,
          });
        }

        const selected = matches.slice(-limit);
        const existing = ctx.memory.getLongTermSection(target);
        const newLines = selected.map(
          (e) =>
            `- [${e.type}] (${(e.timestamp ?? '').slice(0, 10)}) ${e.content}`,
        );
        const merged = existing ? `${existing}\n${newLines.join('\n')}` : newLines.join('\n');
        const writeResult = ctx.memory.addLongTermMemory(target, merged);
        if (!writeResult.ok) {
          log.warn('memory_organize write refused', {
            agentId: ctx.agentId, target, reason: writeResult.reason,
          });
          return JSON.stringify({
            status: 'error',
            error: writeResult.reason ?? 'knowledge.md write refused',
            moved: 0,
            section: target,
            store,
          });
        }

        const archived = ctx.memory.removeEntries(selected.map((e) => e.id));
        ctx.memory.markConsolidated?.();
        if (ctx.semanticSearch?.isEnabled()) {
          for (const e of selected) {
            ctx.semanticSearch.deleteMemory(e.id).catch((err) => {
              log.warn('Failed to remove from semantic index', { error: String(err) });
            });
          }
        }

        log.info('Agent organized memory', {
          agentId: ctx.agentId, target, moved: selected.length, archived,
        });
        return JSON.stringify({
          status: 'organized',
          moved: selected.length,
          archived,
          section: target,
          message: `Merged ${selected.length} observation(s) into "${target}" and archived them.`,
          store,
        });
      },
    },
  ];
}
