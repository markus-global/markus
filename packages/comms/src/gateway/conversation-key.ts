/**
 * Conversation identity for the messaging gateway
 * (docs/design/messaging-gateway.md §6.2).
 *
 * Why this is its own pure module: "which conversation is this message in?"
 * used to be answered in several places (the Feishu live path called
 * `getOrCreateMainSession`, the router passed no session at all), so two groups
 * — or two external users — landed in one context (defect D3). Identity is now
 * a pure function of `(instanceId, nativeId, kind)`, so it is testable and has
 * exactly one implementation.
 */

import type { MessageChannelKind } from '@markus/shared';

/** Conversation kind inside one bot instance. Single source: `@markus/shared`. */
export type ChannelKind = MessageChannelKind;

/** The native anchor of a conversation: which bot, which chat, of what kind. */
export interface ChannelRef {
  /** Bot instance that received the message. */
  instanceId: string;
  /** Native conversation id (Feishu chat id, Telegram chat id, Slack channel …). */
  nativeId: string;
  kind: ChannelKind;
}

/**
 * Sentinel conversation key for a channel *designated* as the agent's home
 * (design §6.2). A `main` channel maps to the bound agent's own main session —
 * continuity with Team Chat — instead of a per-channel session.
 */
export const MAIN_CONVERSATION_KEY = 'main';

/**
 * A notification is a destination, not a conversation: inbound traffic arriving
 * on a notification channel is ignored **by design** (and logged, never silently
 * dropped).
 */
export function isInboundIgnored(kind: ChannelKind): boolean {
  return kind === 'notification';
}

/** Percent-encode a part so the `:` separator can never be ambiguous. */
function enc(part: string): string {
  return encodeURIComponent(part);
}

/**
 * Canonical, stable, collision-free conversation key.
 *
 * The `im:` namespace keeps it from colliding with the Web UI's own channel keys
 * (`group:…`, `dm:a2a:…`). Parts are percent-encoded, so `a:b` + `c` and `a` +
 * `b:c` can never produce the same key — a plain `a:b:c` join would.
 */
export function conversationKeyOf(ref: ChannelRef): string {
  if (ref.kind === 'main') return MAIN_CONVERSATION_KEY;
  return `im:${enc(ref.instanceId)}:${ref.kind}:${enc(ref.nativeId)}`;
}
