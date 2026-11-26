import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuAdapter } from '../src/feishu/adapter.js';
import type { FeishuClient } from '../src/feishu/client.js';
import type { Message } from '@markus/shared';

/**
 * C10-B2 — Feishu inbound envelope translation at the single dispatch point.
 *
 * Locks the NEW traceability behavior (plan §B2 / seam S1): the dispatch point
 * surfaces the platform's NATIVE message_id as `Message.nativeMessageId` so the
 * downstream envelope idempotency key is the native id, never the random
 * `msgId()` platform item id. Also fail-closes when no native id can be formed.
 *
 * These assertions read `nativeMessageId` through a structural cast so the file
 * compiles at the base commit (where the field does not exist yet) and goes RED
 * there because the adapter does not surface it — the red-first evidence.
 */
const sdkState = vi.hoisted(() => ({
  dispatcher: undefined as undefined | { handlers: Record<string, (data: unknown) => void> },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  WSClient: class {
    async start(): Promise<void> {}
    close(_params?: { force?: boolean }): void {}
  },
  EventDispatcher: class {
    handlers: Record<string, (data: unknown) => void> = {};
    constructor(_opts?: unknown) {}
    register(map: Record<string, (data: unknown) => void>) {
      this.handlers = map;
      sdkState.dispatcher = this;
      return this;
    }
  },
  LoggerLevel: { error: 0, warn: 1, info: 2, debug: 3 },
  Client: class {},
}));

function makeMockClient(): Partial<FeishuClient> {
  return {
    getTenantToken: vi.fn().mockResolvedValue('mock-token'),
    sendTextMessage: vi.fn().mockResolvedValue('om_sent'),
    replyMessage: vi.fn().mockResolvedValue('om_reply'),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  };
}

/** The FeishuEvent envelope the dispatch point consumes (adapter.ts:504). */
function messageEvent(messageId: string | undefined, text = 'hello'): Record<string, unknown> {
  const message: Record<string, unknown> = {
    chat_id: 'oc_bound',
    chat_type: 'group',
    content: JSON.stringify({ text }),
    message_type: 'text',
  };
  if (messageId !== undefined) message['message_id'] = messageId;
  return {
    header: { event_id: `e_${messageId ?? 'none'}`, event_type: 'im.message.receive_v1', create_time: '0', token: '' },
    event: { message, sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1' } } },
  };
}

type NativeCarrier = { nativeMessageId?: string };

describe('Feishu inbound envelope translation (C10-B2)', () => {
  let adapter: FeishuAdapter;
  let captured: Message[];

  beforeEach(() => {
    adapter = new FeishuAdapter();
    (adapter as Record<string, unknown>)['client'] = makeMockClient();
    (adapter as Record<string, unknown>)['connected'] = true;
    captured = [];
    adapter.onMessage(async (m) => {
      captured.push(m);
    });
  });

  async function drive(event: Record<string, unknown>): Promise<void> {
    await (adapter as unknown as { processMessageEvent(e: unknown): Promise<void> }).processMessageEvent(event);
  }

  it('surfaces the native message_id as Message.nativeMessageId (not the random item id)', async () => {
    await drive(messageEvent('om_native_abc'));
    expect(captured).toHaveLength(1);
    const m = captured[0]!;
    // The native id is surfaced for the envelope idempotency key (seam S1).
    expect((m as NativeCarrier).nativeMessageId).toBe('om_native_abc');
    // The random platform item id semantics are unchanged (golden locks idKind=generated).
    expect(m.id).not.toBe('om_native_abc');
    expect(m.id).toMatch(/^msg_[0-9a-f]{24}$/);
    // threadId still carries the native id (existing behavior, unchanged).
    expect(m.threadId).toBe('om_native_abc');
  });

  it('fail-closes: an inbound without a native message_id is NOT dispatched', async () => {
    await drive(messageEvent(undefined));
    // No stable idempotency key can be formed → the dispatch point refuses to
    // enqueue (acceptance: pre-enqueue identity fail-closed). At base the guard
    // is absent and the message IS dispatched → this assertion is RED there.
    expect(captured).toHaveLength(0);
  });

  it('a well-formed message still dispatches exactly once (routing unchanged)', async () => {
    await drive(messageEvent('om_native_xyz', 'hi there'));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.content.text).toBe('hi there');
    expect((captured[0]! as NativeCarrier).nativeMessageId).toBe('om_native_xyz');
  });
});