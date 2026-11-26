import { describe, it, expect } from 'vitest';
import { buildImInboundOrigin, buildImInboundWorkUnitRef } from '../src/commands/im-inbound-origin.js';
import { WORK_UNIT_REF, type Message } from '@markus/shared';

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

/**
 * C10-B2 ref-leg (S3 resolution) — the IM entry ensures a per-message external
 * work-unit ref BEFORE enqueue, reusing the single C10-B constructor
 * `WORK_UNIT_REF.external(source, messageId)`. The entry is the ref writer
 * (same invariant as Web UI `prepareChatTurnWorkUnit` and `injectFollowUp`);
 * the mailbox assembly point `ensureIdentity` guarantees the entity exists.
 *
 * Red-first: at base the IM entry passes no workUnitRef (probe 2026-11-23
 * 04:03–04:10Z showed work_unit_ref=NULL, work_units=0, overview empty).
 */
describe('buildImInboundWorkUnitRef — IM entry per-message external ref (C10-B2 S3)', () => {
  it('mints the canonical external ref from platform + native message id', () => {
    const ref = buildImInboundWorkUnitRef(
      makeMessage({ nativeMessageId: 'om_native_1', threadId: 'om_native_1' }),
    );
    // Must equal the single C10-B constructor output — no second construction point.
    expect(ref).toBe(WORK_UNIT_REF.external('feishu', 'om_native_1'));
    expect(ref).toBe('external:feishu:om_native_1');
  });

  it('is idempotent: same native id always yields the same ref', () => {
    const msg = makeMessage({ nativeMessageId: 'om_dup_check' });
    expect(buildImInboundWorkUnitRef(msg)).toBe(buildImInboundWorkUnitRef(msg));
  });

  it('returns undefined when no native id was surfaced (legacy adapters unchanged)', () => {
    // Adapters not yet envelope-ized keep the previous behavior (no ref claim).
    expect(buildImInboundWorkUnitRef(makeMessage())).toBeUndefined();
  });

  it('uses the message platform as source (not a hard-coded string)', () => {
    const ref = buildImInboundWorkUnitRef(
      makeMessage({ platform: 'telegram', nativeMessageId: 'tg_123' }),
    );
    expect(ref).toBe(WORK_UNIT_REF.external('telegram', 'tg_123'));
  });
});