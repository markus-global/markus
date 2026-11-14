import type { AgentToolHandler } from '../agent.js';
import type { Subscription, WakeCondition } from '../trigger.js';

/**
 * `rest(wakeOn)` — end the turn and be woken by the real event (C8-C).
 *
 * The tool is a *statement of intent*, not a sleep: it registers which event the agent
 * is waiting for, returns immediately, and the agent ends its turn. When that event
 * arrives the registry matches it and the agent is woken through the normal path. There
 * is no polling loop and no timer per wait — see `packages/core/src/trigger.ts` for why.
 *
 * Tool contract (deliberately machine-readable — the caller must be able to see WHAT it
 * is waiting for, unlike a plain "sleep"):
 *   { status: 'resting', subscriptionId, wakeOn, expiresAt, note }
 */
export interface TriggerToolContext {
  agentId: string;
  rest(input: { wakeOn: WakeCondition; note?: string; timeoutMs?: number }): Subscription;
  list(): Subscription[];
  cancel(id: string): boolean;
}

function parseWakeOn(raw: unknown): WakeCondition | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'wakeOn must be an object: { kind: "mailbox-type", sourceType } or { kind: "mailbox-any" }' };
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj['kind'];
  if (kind === 'mailbox-any') return { kind: 'mailbox-any' };
  if (kind === 'mailbox-type') {
    const sourceType = obj['sourceType'];
    if (typeof sourceType !== 'string' || sourceType.length === 0) {
      return { error: 'wakeOn.sourceType is required for kind="mailbox-type"' };
    }
    return { kind: 'mailbox-type', sourceType: sourceType as WakeCondition extends { kind: 'mailbox-type'; sourceType: infer T } ? T : never };
  }
  return { error: 'wakeOn.kind must be "mailbox-type" or "mailbox-any"' };
}

export function createTriggerTools(ctx: TriggerToolContext): AgentToolHandler[] {
  return [
    {
      name: 'rest',
      description:
        'Declare the external event you are waiting for, then end your turn. You will be woken by the real event — ' +
        'this does not poll, sleep or occupy a timer. Use it instead of repeatedly checking a queue.',
      inputSchema: {
        type: 'object',
        properties: {
          wakeOn: {
            type: 'object',
            description: 'The event that should wake you.',
            properties: {
              kind: { type: 'string', enum: ['mailbox-type', 'mailbox-any'] },
              sourceType: {
                type: 'string',
                description: 'Mailbox item type to wait for (when kind="mailbox-type"), e.g. "human_chat", "task_status_update".',
              },
            },
            required: ['kind'],
          },
          note: { type: 'string', description: 'Why you are waiting — shown when the wait fires or expires.' },
          timeoutMs: { type: 'number', description: 'Optional lifetime. Omit for the default window; 0 = no expiry.' },
        },
        required: ['wakeOn'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const parsed = parseWakeOn(args['wakeOn']);
        if ('error' in parsed) {
          return JSON.stringify({ status: 'error', error: parsed.error });
        }
        const note = typeof args['note'] === 'string' ? args['note'] : undefined;
        const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : undefined;
        const sub = ctx.rest({ wakeOn: parsed, note, timeoutMs });
        return JSON.stringify({
          status: 'resting',
          subscriptionId: sub.id,
          wakeOn: sub.wakeOn,
          expiresAt: sub.expiresAt === null ? null : new Date(sub.expiresAt).toISOString(),
          note: sub.note ?? null,
          hint: 'End your turn now. You will be woken when the event arrives; nothing is polled in the meantime.',
        });
      },
    },
    {
      name: 'list_waits',
      description: 'List the events you are currently waiting for (read-only).',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        return JSON.stringify({
          status: 'ok',
          waits: ctx.list().map(s => ({
            subscriptionId: s.id,
            wakeOn: s.wakeOn,
            note: s.note ?? null,
            expiresAt: s.expiresAt === null ? null : new Date(s.expiresAt).toISOString(),
          })),
        });
      },
    },
    {
      name: 'cancel_wait',
      description: 'Stop waiting for a previously declared event.',
      inputSchema: {
        type: 'object',
        properties: { subscriptionId: { type: 'string' } },
        required: ['subscriptionId'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const id = String(args['subscriptionId'] ?? '');
        const removed = ctx.cancel(id);
        return JSON.stringify({ status: removed ? 'cancelled' : 'not_found', subscriptionId: id });
      },
    },
  ];
}
