/**
 * C10-B2 — the single writer of the IM inbound delivery origin (envelope header).
 *
 * Extracted from the start.ts agent handler so the translation is one named,
 * testable function instead of an inline literal. The envelope contract itself
 * is unchanged (sixth-cut C2 / C10-B): `DeliveryOrigin` from core, `from` built
 * only by the shared `imAddressRef` constructor (no second constructor).
 *
 * Seam S1 fix: `messageId` is the platform-native message id surfaced by the
 * adapter at the dispatch point (`Message.nativeMessageId`), NOT the random
 * `msgId()` item id — otherwise a redelivered external message could never hit
 * the V5 `(agent, messageId)` duplicate check. Adapters that do not surface a
 * native id keep the previous behavior (`message.id`) until they are
 * envelope-ized; this card closes Feishu, the only IM channel with real traffic.
 *
 * Routing is untouched: this header is traceability only. The chat turn's
 * work-unit identity stays the session ref (chat path, `Agent.onItemEnqueued`);
 * the external per-event ref (`WORK_UNIT_REF.external`) belongs to the
 * external-signal ingest path (webhook/RSS), not to IM chat turns.
 */
import { imAddressRef, type Message } from '@markus/shared';
import type { DeliveryOrigin } from '@markus/core';

export function buildImInboundOrigin(message: Message): DeliveryOrigin {
  return {
    from: imAddressRef(message.platform, message.senderId),
    messageId: message.nativeMessageId ?? message.id,
    externalThreadRef: message.threadId ?? null,
    subject: (message.content.text ?? '').slice(0, 120),
  };
}
