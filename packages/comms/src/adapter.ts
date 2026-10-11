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
  timestamp: string;
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
  isConnected(): boolean;
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
}
