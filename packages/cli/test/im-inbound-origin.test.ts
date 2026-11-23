import { describe, it, expect } from 'vitest';
import { buildImInboundOrigin } from '../src/commands/im-inbound-origin.js';
import type { Message } from '@markus/shared';

/**
 * C10-B2 — the single writer of the IM inbound envelope header.
 *
 * Locks seam S1: the envelope idempotency key is the platform-native message id
 * surfaced by the adapter (`Message.nativeMessageId`), never the random item id;
 * adapters that do not surface a native id keep the legacy fallback (`message.id`).
 * The envelope contract (DeliveryOrigin / imAddressRef) is reused unchanged (S2).
 */
function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_0123456789abcdef01234567',
    platform: 'feishu',
    direction: 'inbound',
    channelId: 'oc_1',
    senderId: 'ou_1',
    senderName: 'User',
    agentId: '',
    content: { type: 'text', text: 'hello' },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('buildImInboundOrigin — IM inbound envelope header single writer (C10-B2)', () => {
  it('uses the surfaced native message id as the envelope idempotency key (S1)', () => {
    const origin = buildImInboundOrigin(
      makeMessage({ nativeMessageId: 'om_native_1', threadId: 'om_native_1' }),
    );
    expect(origin.messageId).toBe('om_native_1');
    expect(origin.externalThreadRef).toBe('om_native_1');
    // from is built only by the shared imAddressRef constructor (S2 — no second constructor).
    expect(origin.from).toEqual({ kind: 'im', platform: 'feishu', nativeUserId: 'ou_1' });
    expect(origin.subject).toBe('hello');
  });

  it('falls back to the platform item id when no native id was surfaced (legacy adapters unchanged)', () => {
    const origin = buildImInboundOrigin(makeMessage());
    expect(origin.messageId).toBe('msg_0123456789abcdef01234567');
    expect(origin.externalThreadRef).toBeNull();
  });

  it('slices the subject to 120 chars and tolerates missing text', () => {
    const long = 'x'.repeat(200);
    expect(
      buildImInboundOrigin(makeMessage({ content: { type: 'text', text: long } })).subject,
    ).toHaveLength(120);
    expect(buildImInboundOrigin(makeMessage({ content: { type: 'text' } })).subject).toBe('');
  });
});