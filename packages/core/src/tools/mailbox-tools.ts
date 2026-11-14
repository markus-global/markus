import type { AgentToolHandler } from '../agent.js';
import {
  NOTEBOOK_KEY_MAX_CHARS,
  NOTEBOOK_MAX_AGENT_ENTRIES,
  NOTEBOOK_MAX_CHARS_PER_ENTRY,
  NOTEBOOK_MAX_ENTRIES,
  type AgentMindState,
} from '@markus/shared';

export interface MailboxToolContext {
  agentId: string;
  getMindState: () => AgentMindState;
  deferItem: (itemId: string, reason: string, deferUntilMs?: number) => boolean;
  dropItem: (itemId: string, reason: string) => boolean;
  prioritizeItem: (itemId: string, newPriority: number) => boolean;
  updateWorkingMemory: (key: string, content: string) => { status: string; key: string; evicted?: string; expired?: string[] };
  clearWorkingMemory: (key?: string) => { status: string; cleared: number };
  getWorkingMemorySnapshot: () => Array<{ key: string; text: string; updatedAt: number }>;
  /**
   * 第六刀 C3（§2.4）：`message_route(messageId)` 的只读端口。未接线 ⇒ 工具不注册。
   *
   * 返回的是**路由事实**（信封 / 状态 / `drop_reason` / `bounce_target`），不是内容：
   * Agent 看不到日志，问「我这条消息到底投到哪了」必须能从工具返回里建模。
   */
  routeOfMessage?: (messageId: string) => unknown[];
  /** 第六刀 C3：catch-all 概览（只读）。未接线 ⇒ 工具不注册。 */
  catchAll?: () => unknown;
  /**
   * 第七刀 C7-A：`work_status()` 的只读端口。未接线 ⇒ 工具不注册。
   *
   * 答案必须来自 `work_units` 对象查询，**不得**从 payload / 会话文本推断 ——
   * 这正是需求 §10.1 缺口 A 的关闭点：今天「我有几个 worker 在跑」是每轮开头
   * 注入的一段文本，是快照、会漂移；这里给出的是可复查的对象。
   */
  workStatus?: (opts: { limit?: number }) => unknown;
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
      name: 'notebook_upsert',
      description:
        `Upsert a keyed entry in your Notebook — your persistent cognitive workspace. Use to track priorities, context, decisions, blockers. ` +
        `Keys are short labels (≤${NOTEBOOK_KEY_MAX_CHARS} chars, e.g. "current-priorities", "blockers") — reuse a key to REPLACE it instead of creating a near-duplicate. ` +
        `Capacity: ${NOTEBOOK_MAX_AGENT_ENTRIES} agent entries (oldest evicted), ${NOTEBOOK_MAX_CHARS_PER_ENTRY} chars each, ${NOTEBOOK_MAX_ENTRIES} entries total. ` +
        `Entries expire on their own (agent ~4d, machine-written entries sooner), so anything you write here is working state, not durable knowledge — use memory_save/memory_update for that. ` +
        `Delete entries you are done with via notebook_clear.`,
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Label for this entry (e.g. "current-priorities", "blockers", "pending-conversations")' },
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
      name: 'notebook_clear',
      description: 'Remove a Notebook entry by key, or clear all agent-managed entries.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to clear. Omit to clear all agent entries.' },
          all: { type: 'boolean', description: 'Set true to clear all agent entries' },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const key = args['key'] as string | undefined;
        const all = args['all'] as boolean | undefined;
        return JSON.stringify(ctx.clearWorkingMemory(all ? undefined : key));
      },
    },

    // 审计 §6：notebook 只读视图（原 update/clear_working_memory 别名已删除，名字归一）。
    {
      name: 'notebook_read',
      description:
        'Read your Notebook (working memory) — all entries, or a single key. Read-only. ' +
        'Entries are agent-written (your priorities/context) and machine-written (triage/deliberation), each with a TTL.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Read a single entry by key. Omit to list all entries.' },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const key = (args['key'] as string | undefined)?.trim();
        const snapshot = ctx.getWorkingMemorySnapshot();
        const entries = key ? snapshot.filter((e) => e.key === key) : snapshot;
        return JSON.stringify({
          status: 'ok',
          count: entries.length,
          entries: entries.map((e) => ({ key: e.key, text: e.text, updatedAt: new Date(e.updatedAt).toISOString() })),
        });
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
        // 严格状态管理事件（正式任务执行/评审/收尾动作）绝不能 defer：
        // 持久化会丢失 onLog 等闭包，resurface 后无法真正执行 → 任务卡死在 in_progress。
        const target = ctx.getMindState().queuedItems.find(i => i.id === itemId);
        if (target?.isStrictState) {
          return JSON.stringify({
            status: 'error',
            error: 'Item is a strict state-management item (task execution / review / requirement action). It MUST be executed by the normal single-item execution path and cannot be deferred.',
          });
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
        // 严格状态管理事件（正式任务执行/评审/收尾动作）绝不能 drop：
        // 丢弃会让 task 永远卡在 in_progress / review 且无执行日志，形成「处理中但无人处理」。
        const target = ctx.getMindState().queuedItems.find(i => i.id === itemId);
        if (target?.isStrictState) {
          return JSON.stringify({
            status: 'error',
            error: 'Item is a strict state-management item (task execution / review / requirement action). It MUST be executed by the normal single-item execution path and cannot be dropped.',
          });
        }
        const before = ctx.getMindState().queuedItems.some(i => i.id === itemId);
        const ok = ctx.dropItem(itemId, reason);
        if (!ok) {
          return JSON.stringify({ status: 'error', error: 'Item is a protected human_chat item or not droppable while processing' });
        }
        return JSON.stringify({
          // C3：discard 的终态是 bounced(stale_signal) → 归集到 catch-all，不再是 dropped。
          status: before ? 'bounced' : 'already_resolved',
          drop_reason: before ? 'stale_signal' : undefined,
          item_id: itemId,
          note: before
            ? 'Recorded as a bounce (stale_signal) and collected into your catch-all overview; it is no longer a silent drop.'
            : 'Item was not in the live queue (already handled or orphaned); marked resolved.',
        });
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

    // ─── 第六刀 C3：路由取证 + catch-all 概览（只读）────────────────────
    //
    // 这两个工具回答同一个问题：「我（或别人）发来的东西到底去哪了」。
    // 旧世界里这个问题只能看日志（Agent 看不到日志），而 `dropped` 终态又没有原因——
    // 于是「消息消失」在 Agent 视角是不可观测的。现在两者都是从结构列直接读回。
    ...(ctx.routeOfMessage ? [{
      name: 'message_route',
      description:
        'Trace one signal by its messageId (the platform-unique id in the delivery envelope). ' +
        'Returns routing facts only — status, drop_reason, bounce_target, signal_class, intent, ' +
        'and the envelope — newest first (a retried message can have several rows). ' +
        'Read-only. Use it to answer "did my message arrive, and if not, why?".',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'The envelope messageId to trace.' },
        },
        required: ['message_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const messageId = args['message_id'];
        if (typeof messageId !== 'string' || messageId.trim().length === 0) {
          return JSON.stringify({
            status: 'error',
            error: 'message_id is required (the envelope messageId, not a mailbox item id)',
          });
        }
        const rows = ctx.routeOfMessage!(messageId.trim());
        return JSON.stringify({
          status: rows.length === 0 ? 'not_found' : 'ok',
          messageId: messageId.trim(),
          count: rows.length,
          routes: rows,
          hint: rows.length === 0
            ? 'No mailbox row carries this messageId. It may predate delivery envelopes, or the sender used a different id.'
            : undefined,
        });
      },
    } as AgentToolHandler] : []),

    ...(ctx.catchAll ? [{
      name: 'catch_all',
      description:
        'Read your catch-all overview: every signal that could NOT be delivered to you, exactly once, ' +
        'with its drop_reason (unresolved_address / no_active_target / lease_expired / ' +
        'duplicate_message_id / stale_signal) and bounce_target. Read-only. ' +
        'Legacy rows archived before the reason column existed are counted separately as ' +
        '`legacyDropped` instead of being passed off as reason-bearing rows.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max entries (default 100).' },
        },
      },
      async execute(): Promise<string> {
        return JSON.stringify({ status: 'ok', ...(ctx.catchAll!() as Record<string, unknown>) });
      },
    } as AgentToolHandler] : []),
  // ─── 第七刀 C7-A：自省（只读）────────────────────────────────────────
    //
    // 这个工具关闭的是需求 §10.1 缺口 A：今天「我有几个 worker、分别在处理什么」
    // 是每轮开头注入的一段**文本**（从会话注册表现算），没有可查询实体。
    // 现在答案来自 `work_units` 对象：父子关系、认领者、租约、预算都是列，不是推断。
    ...(ctx.workStatus ? [{
      name: 'work_status',
      description:
        'Read the WorkUnit ledger for this agent: one row per unit of work (a chat turn, a task ' +
        'execution epoch, or one A2A delivery), answered from the work_units object — NOT from ' +
        'mailbox payload text — so the rows cannot drift from execution. ' +
        'Each row carries ref / status / parentId / claimedBy / leaseUntil / budget / used. Read-only. ' +
        'IMPORTANT — what this does NOT tell you: in cut 7 the chat WorkUnit is created when the turn ' +
        'settles, so `status` is `idle` for finished work and **no `running` row appears for an ' +
        'in-flight turn**. Treat an empty result as "no unit on record", never as "nothing is running"; ' +
        'live-turn observability is C7-B scope.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max units to return (default 50).' },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const limit = typeof args['limit'] === 'number' ? (args['limit'] as number) : undefined;
        return JSON.stringify({ status: 'ok', ...(ctx.workStatus!({ limit }) as Record<string, unknown>) });
      },
    } as AgentToolHandler] : []),
  ];
}
