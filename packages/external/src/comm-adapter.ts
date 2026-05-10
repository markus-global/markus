/**
 * ExternalChatAdapter - CommAdapter implementation for external chat sessions.
 *
 * Plugs into the existing MessageRouter pattern so external conversations
 * are treated as a communication channel, consistent with Feishu/Slack/etc.
 */
import { createLogger, type Message } from '@markus/shared';
import type { ExternalService } from './external-service.js';

const log = createLogger('external-chat-adapter');

export interface CommAdapterConfig {
  platform: string;
  [key: string]: unknown;
}

export interface IncomingMessageHandler {
  (message: Message): Promise<void>;
}

export interface SendOptions {
  threadId?: string;
  richText?: boolean;
  mentionUserIds?: string[];
}

/**
 * Adapter that bridges external sessions into the CommAdapter interface.
 * This allows the MessageRouter to route messages to/from external chat
 * the same way it handles Slack, Feishu, etc.
 */
export class ExternalChatAdapter {
  readonly platform = 'external-chat';
  private connected = false;
  private handler: IncomingMessageHandler | null = null;
  private externalService: ExternalService | null = null;

  async connect(config: CommAdapterConfig): Promise<void> {
    this.connected = true;
    log.info('External chat adapter connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    log.info('External chat adapter disconnected');
  }

  setExternalService(service: ExternalService): void {
    this.externalService = service;
  }

  async sendMessage(channelId: string, content: string, _options?: SendOptions): Promise<string> {
    if (!this.externalService) {
      throw new Error('External service not configured');
    }

    try {
      const result = await this.externalService.handleMessage(channelId, content);
      return result.response;
    } catch (err) {
      log.error('Failed to send message through external service', { channelId, error: String(err) });
      throw err;
    }
  }

  async sendReply(channelId: string, _replyToId: string, content: string): Promise<string> {
    return this.sendMessage(channelId, content);
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handler = handler;
  }

  /**
   * Route an incoming external message into the comm system.
   * Called by the external API routes when a message arrives.
   */
  async routeIncoming(sessionId: string, content: string, participantId: string, agentId: string): Promise<void> {
    if (!this.handler) {
      log.warn('No message handler registered for external adapter');
      return;
    }

    const message: Message = {
      id: `extmsg_${Date.now()}`,
      platform: 'external',
      direction: 'inbound',
      channelId: sessionId,
      senderId: participantId,
      senderName: participantId,
      agentId,
      content: { type: 'text', text: content },
      timestamp: new Date().toISOString(),
    };

    await this.handler(message);
  }

  isConnected(): boolean {
    return this.connected;
  }
}
