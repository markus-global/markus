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
 * Routing is untouched: this header is traceability only.
 *
 * S3 resolution (card §B2 "入队前经唯一 WORK_UNIT_REF 构造器 ensure ref"):
 * the IM entry mints a per-message external ref via the single C10-B
 * constructor `WORK_UNIT_REF.external(platform, nativeMessageId)` and passes
 * it through `options.workUnitRef` — the same entry-writes-ref invariant as
 * Web UI `prepareChatTurnWorkUnit` and `injectFollowUp` (agent.ts:2056, which
 * fixed the identical NULL-ref defect class for the follow-up chat entry).
 * The mailbox assembly point `ensureIdentity` guarantees the entity exists
 * before the item is persisted ("enqueue first, patch identity later" is
 * structurally inexpressible). Adapters without a surfaced native id claim
 * no ref (undefined → legacy behavior unchanged).
 */
import { imAddressRef, WORK_UNIT_REF, type Message } from '@markus/shared';
import type { DeliveryOrigin } from '@markus/core';

export function buildImInboundOrigin(message: Message): DeliveryOrigin {
  return {
    from: imAddressRef(message.platform, message.senderId),
    messageId: message.nativeMessageId ?? message.id,
    externalThreadRef: message.threadId ?? null,
    subject: (message.content.text ?? '').slice(0, 120),
  };
}

/**
 * Per-message external work-unit ref for IM inbound (C10-B2 S3).
 * Reuses the single C10-B constructor — no second construction point.
 * Returns undefined when no native id was surfaced (legacy adapters unchanged).
 */
export function buildImInboundWorkUnitRef(message: Message): string | undefined {
  if (!message.nativeMessageId) return undefined;
  return WORK_UNIT_REF.external(message.platform, message.nativeMessageId);
}
