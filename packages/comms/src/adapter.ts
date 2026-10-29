import type { Message } from '@markus/shared';

export interface CommAdapterConfig {
  platform: string;
  /**
   * Bot instance id — which registered adapter this config connects.
   *
   * Defaults to `platform`, i.e. the single implicit bot every platform had
   * before instances existed. A platform hosting several bots passes the
   * `platform_instances.id` here so each adapter connects on its own credentials
   * (docs/architecture/messaging-gateway.md §4.2).
   */
  instanceId?: string;
  [key: string]: unknown;
}

export interface IncomingMessageHandler {
  (message: Message): Promise<void>;
}

/**
 * A platform **action** — a non-conversational inbound signal (e.g. a Feishu
 * interactive-card button tap). It is deliberately *not* a {@link Message}: an
 * approval tap is a HITL state transition, not an agent turn, so feeding it to
 * the conversation handler would be wrong (docs/architecture/messaging-gateway.md §6.5).
 *
 * The gateway routes it to a single injected action handler; the wiring layer
 * resolves it (verify the signed ref, then `respondToApproval`).
 */
export interface InboundAction {
  platform: string;
  /** Bot instance that received the action — lets the wiring layer scope it. */
  instanceId: string;
  /** Raw platform payload (Feishu: `{action:{value}, operator:{open_id}, ...}`). */
  payload: Record<string, unknown>;
  /** Best-effort actor id on the platform (Feishu: the operator's `open_id`). */
  actorId?: string;
  /**
   * The id of the message the action came from, when the platform supplies one
   * (Feishu: `open_message_id`). Lets the wiring layer rewrite that card in place
   * after the decision, so a tap produces visible feedback instead of leaving the
   * user staring at a card that looks untouched.
   */
  messageId?: string;
  timestamp: string;
}

/**
 * The outcome of resolving an interactive card's action. An adapter that can edit
 * its own messages re-renders the card from this, so the tapper sees the result.
 *
 * Deliberately platform-neutral: `status` + `title`/`body` are facts the decision
 * layer owns; how they are painted is the adapter's business.
 */
export interface CardResolution {
  /** Terminal status of the underlying request. */
  status: 'approved' | 'rejected' | 'cancelled' | 'expired' | 'pending';
  /** Card header — the original notification title, re-used verbatim. */
  title: string;
  /** Card body — the original notification body, re-used verbatim. */
  body: string;
  /** Platform id of whoever acted (Feishu: operator `open_id`). */
  actorId?: string;
  /**
   * Human-readable name for {@link actorId}, when the platform could resolve one.
   * Purely presentational: absent ⇒ the adapter falls back to the raw id, which
   * is always correct, just less friendly.
   */
  actorName?: string;
  /** The tapped option id, when the card offered a choice. */
  selectedOption?: string;
  /** ISO timestamp of the decision. */
  at?: string;
}

export interface InboundActionHandler {
  (action: InboundAction): void | Promise<void>;
}

export interface CommAdapter {
  readonly platform: string;
  connect(config: CommAdapterConfig): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(channelId: string, content: string, options?: SendOptions): Promise<string>;
  sendReply(channelId: string, replyToId: string, content: string, options?: SendOptions): Promise<string>;
  onMessage(handler: IncomingMessageHandler): void;
  /**
   * Optional action port. Adapters that receive non-message platform actions
   * (card buttons, menu picks) register them here instead of faking a Message;
   * the router forwards them to its single action handler (§6.5).
   */
  onAction?(handler: InboundActionHandler): void;
  /**
   * Optional: rewrite an already-sent interactive card to show a decision, so a
   * tap produces visible feedback. Adapters whose platform cannot edit a sent
   * message simply omit this; the caller treats "absent" as "no feedback
   * possible", never as a failure.
   */
  updateResolvedCard?(messageId: string, resolution: CardResolution): Promise<void>;
  /**
   * Optional: turn a platform actor id (Feishu `open_id`) into a display name.
   * Adapters that cannot look names up simply omit this; the caller then keeps
   * the raw id. Best-effort by contract — must never throw.
   */
  resolveActorName?(actorId: string): Promise<string | null>;
  isConnected(): boolean;
}

/**
 * How a destination id is addressed on the wire — the platform's receive-id
 * *type*. Mirrors the gateway's `NotifyReceiveIdType` (a single union; this is
 * the one definition, re-exported there) so a resolved target's addressing can
 * travel to the adapter instead of the adapter hard-coding a default (fixes R4:
 * a Feishu `open_id` DM was previously inexpressible).
 */
export type SendReceiveIdType = 'chat_id' | 'open_id' | 'user_id' | 'union_id';

/**
 * The representation the renderer chose for this message (mirrors the gateway's
 * `OutboundFormat`). Carried so a card-capable adapter takes its **card** path
 * rather than always degrading to text — the structural reason an approval
 * arrived as literal `[label] ref` instead of tappable buttons (fixes R3).
 */
export type SendFormat = 'card' | 'markdown' | 'text';

/**
 * A button on a rich outbound message. `ref` is a **signed, opaque token** the
 * inbound side verifies — the internal approval id never travels in the clear.
 */
export interface SendCardAction {
  id: string;
  label: string;
  style?: 'primary' | 'default' | 'danger';
  /** Signed action ref (`signActionRef`); resolved back on the inbound side. */
  ref: string;
}

/**
 * Platform-neutral structured content for an interactive card. A card-capable
 * adapter turns this into its own dialect (Feishu interactive card, Slack Block
 * Kit, …); an adapter that cannot render cards ignores it and sends `content`.
 * The gateway never speaks a platform's card JSON — the adapter owns the dialect.
 */
export interface SendCard {
  title: string;
  body: string;
  /** Action buttons; each carries a signed `ref` so a tap completes an approval. */
  actions?: SendCardAction[];
  /**
   * Who sent the message (agent name, and its team when it has one). Structure
   * rather than body text, so a card-capable adapter can show it in its own
   * extension slot — a footnote on Feishu, a context block on Slack — while a
   * text-only path already carries it inline via the plain-text projection.
   */
  origin?: { agentName?: string; teamName?: string };
}

export interface SendOptions {
  threadId?: string;
  richText?: boolean;
  /**
   * `content` is markdown and should be rendered in the platform's own dialect
   * (see render/markdown.ts). Distinct from {@link richText}, which means
   * "content is already a platform-native rich payload" (Feishu card JSON). An
   * adapter that cannot format ignores this and sends the text verbatim — never
   * a silent drop.
   */
  markdown?: boolean;
  mentionUserIds?: string[];
  /**
   * Identity of the agent the message is sent *as* (design §4). Carried through
   * so "send as this agent" is not silently discarded (defect D7); adapters that
   * cannot render a per-agent identity simply ignore it.
   */
  agentId?: string;
  /**
   * The renderer's chosen representation. `card` asks the adapter for its
   * interactive-card path (buttons and all); `markdown`/`text` ask for text.
   * Absent ⇒ the adapter's own default (text), so existing callers are unchanged.
   */
  format?: SendFormat;
  /**
   * Send-addressing type for the destination id in `channelId`. Absent ⇒ the
   * adapter's default (Feishu: `chat_id`). Honoured by the adapter so a resolved
   * destination can be a user DM (`open_id`) rather than only a chat (fixes R4).
   */
  receiveIdType?: SendReceiveIdType;
  /**
   * Structured content for a card. Present when `format === 'card'` so the
   * adapter can build a real interactive card; the adapter ignores it otherwise.
   */
  card?: SendCard;
}
