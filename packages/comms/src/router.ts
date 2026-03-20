import { createLogger, type Message } from '@markus/shared';
import type { CommAdapter, CommAdapterConfig } from './adapter.js';

const log = createLogger('message-router');

export type AgentMessageHandler = (agentId: string, message: Message) => Promise<string | undefined>;

export class MessageRouter {
  private adapters = new Map<string, CommAdapter>();
  private agentChannelMap = new Map<string, string>();
  private agentHandler?: AgentMessageHandler;

  registerAdapter(adapter: CommAdapter): void {
    this.adapters.set(adapter.platform, adapter);
    log.info(`Registered comm adapter: ${adapter.platform}`);
  }

  bindAgentToChannel(agentId: string, platform: string, channelId: string): void {
    const key = `${platform}:${channelId}`;
    this.agentChannelMap.set(key, agentId);
    log.info(`Bound agent ${agentId} to ${key}`);
  }

  setAgentHandler(handler: AgentMessageHandler): void {
    this.agentHandler = handler;
  }

  async connectAll(configs: CommAdapterConfig[]): Promise<void> {
    for (const config of configs) {
      const adapter = this.adapters.get(config.platform);
      if (!adapter) {
        log.warn(`No adapter registered for platform: ${config.platform}`);
        continue;
      }

      await adapter.connect(config);

      adapter.onMessage(async (message: Message) => {
        await this.routeIncomingMessage(message);
      });
    }
  }

  async disconnectAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (adapter.isConnected()) {
        await adapter.disconnect();
      }
    }
  }

  async sendToChannel(platform: string, channelId: string, content: string): Promise<string | undefined> {
    const adapter = this.adapters.get(platform);
    if (!adapter || !adapter.isConnected()) {
      log.warn(`Adapter not available for platform: ${platform}`);
      return undefined;
    }
    return adapter.sendMessage(channelId, content);
  }

  async sendAsAgent(agentId: string, platform: string, channelId: string, content: string): Promise<string | undefined> {
    return this.sendToChannel(platform, channelId, content);
  }

  private async routeIncomingMessage(message: Message): Promise<void> {
    const key = `${message.platform}:${message.channelId}`;
    const agentId = message.agentId || this.agentChannelMap.get(key);

    if (!agentId) {
      log.debug('No agent bound to channel, skipping message', { key });
      return;
    }

    message.agentId = agentId;

    if (this.agentHandler) {
      try {
        const reply = await this.agentHandler(agentId, message);
        if (reply) {
          const adapter = this.adapters.get(message.platform);
          if (adapter?.isConnected() && message.threadId) {
            await adapter.sendReply(message.channelId, message.threadId, reply);
          } else if (adapter?.isConnected()) {
            await adapter.sendMessage(message.channelId, reply);
          }
        }
      } catch (error) {
        log.error('Agent handler failed', { agentId, error: String(error) });
      }
    }
  }
}
