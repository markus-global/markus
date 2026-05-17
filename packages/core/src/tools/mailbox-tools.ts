import type { AgentToolHandler } from '../agent.js';
import type { AgentMindState } from '@markus/shared';

export interface MailboxToolContext {
  agentId: string;
  getMindState: () => AgentMindState;
  deferItem: (itemId: string, reason: string, deferUntilMs?: number) => boolean;
  dropItem: (itemId: string, reason: string) => boolean;
  prioritizeItem: (itemId: string, newPriority: number) => boolean;
  updateWorkingMemory: (key: string, content: string) => { status: string; key: string; evicted?: string };
  clearWorkingMemory: (key?: string) => { status: string; cleared: number };
  getWorkingMemorySnapshot: () => Array<{ key: string; text: string; updatedAt: number }>;
}

export function createMailboxTools(ctx: MailboxToolContext): AgentToolHandler[] {
  return [
    {
      name: 'check_mailbox',
      description: 'Inspect your mailbox queue: current focus, queued items, recent decisions. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<string> {
        const mind = ctx.getMindState();
        const now = Date.now();
        return JSON.stringify({
          status: 'ok',
          queueDepth: mind.mailboxDepth,
          currentFocus: mind.currentFocus
            ? {
                type: mind.currentFocus.type,
                label: mind.currentFocus.label,
                elapsedMs: now - new Date(mind.currentFocus.startedAt).getTime(),
              }
            : null,
          items: mind.queuedItems.map(i => ({
            id: i.id,
            type: i.sourceType,
            priority: i.priority,
            summary: i.summary,
            ageMs: now - new Date(i.queuedAt).getTime(),
          })),
          recentDecisions: mind.recentDecisions.slice(-5).map(d => ({
            type: d.decisionType,
            reasoning: d.reasoning.slice(0, 200),
          })),
        });
      },
    },

    {
      name: 'update_working_memory',
      description: 'Upsert a keyed entry in your working memory. Use to track priorities, context, decisions. Max 10 entries, 4000 chars each.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Label for this entry (e.g. "current-priorities", "task-context")' },
          content: { type: 'string', description: 'The content to store' },
        },
        required: ['key', 'content'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const key = args['key'] as string;
        const content = args['content'] as string;
        if (!key || typeof key !== 'string') {
          return JSON.stringify({ status: 'error', error: 'key is required' });
        }
        if (!content || typeof content !== 'string') {
          return JSON.stringify({ status: 'error', error: 'content is required' });
        }
        const result = ctx.updateWorkingMemory(key, content);
        return JSON.stringify(result);
      },
    },

    {
      name: 'clear_working_memory',
      description: 'Remove a working memory entry by key, or clear all entries.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to clear. Omit to clear all entries.' },
          all: { type: 'boolean', description: 'Set true to clear all entries' },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const key = args['key'] as string | undefined;
        const all = args['all'] as boolean | undefined;
        if (all) {
          return JSON.stringify(ctx.clearWorkingMemory());
        }
        return JSON.stringify(ctx.clearWorkingMemory(key));
      },
    },

    {
      name: 'defer_mailbox_item',
      description: 'Defer a queued mailbox item for later processing. Cannot defer human_chat items.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Mailbox item ID to defer' },
          reason: { type: 'string', description: 'Why this item is being deferred' },
          defer_minutes: { type: 'number', description: 'Optional: defer for N minutes. Omit to defer indefinitely.' },
        },
        required: ['item_id', 'reason'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const itemId = args['item_id'] as string;
        const reason = args['reason'] as string;
        const deferMinutes = args['defer_minutes'] as number | undefined;
        if (!itemId || !reason) {
          return JSON.stringify({ status: 'error', error: 'item_id and reason are required' });
        }
        const deferMs = deferMinutes ? deferMinutes * 60_000 : undefined;
        const ok = ctx.deferItem(itemId, reason, deferMs);
        if (!ok) {
          return JSON.stringify({ status: 'error', error: 'Item not found, not queued, or is a protected human_chat item' });
        }
        return JSON.stringify({ status: 'deferred', item_id: itemId });
      },
    },

    {
      name: 'drop_mailbox_item',
      description: 'Drop (discard) a stale or redundant mailbox item. Cannot drop human_chat items.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Mailbox item ID to drop' },
          reason: { type: 'string', description: 'Why this item is being dropped' },
        },
        required: ['item_id', 'reason'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const itemId = args['item_id'] as string;
        const reason = args['reason'] as string;
        if (!itemId || !reason) {
          return JSON.stringify({ status: 'error', error: 'item_id and reason are required' });
        }
        const ok = ctx.dropItem(itemId, reason);
        if (!ok) {
          return JSON.stringify({ status: 'error', error: 'Item not found, not queued, or is a protected human_chat item' });
        }
        return JSON.stringify({ status: 'dropped', item_id: itemId });
      },
    },

    {
      name: 'prioritize_mailbox_item',
      description: 'Change the priority of a queued mailbox item. Priority 0=critical, 1=high, 2=normal, 3=low, 4=background. Cannot reprioritize human_chat items.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Mailbox item ID to reprioritize' },
          priority: { type: 'number', description: 'New priority (0-4): 0=critical, 1=high, 2=normal, 3=low, 4=background' },
        },
        required: ['item_id', 'priority'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const itemId = args['item_id'] as string;
        let priority = args['priority'] as number;
        if (!itemId) {
          return JSON.stringify({ status: 'error', error: 'item_id is required' });
        }
        if (typeof priority !== 'number' || priority < 0 || priority > 4) {
          return JSON.stringify({ status: 'error', error: 'priority must be a number between 0 and 4' });
        }
        priority = Math.round(priority);
        const ok = ctx.prioritizeItem(itemId, priority);
        if (!ok) {
          return JSON.stringify({ status: 'error', error: 'Item not found or is a protected human_chat item' });
        }
        return JSON.stringify({ status: 'reprioritized', item_id: itemId, priority });
      },
    },
  ];
}
