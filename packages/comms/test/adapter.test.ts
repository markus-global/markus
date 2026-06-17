import type { CommAdapter, CommAdapterConfig, IncomingMessageHandler, SendOptions } from '../src/adapter.js';
import type { Message } from '@markus/shared';

class TestAdapter implements CommAdapter {
  readonly platform = 'test';
  private connected = false;
  private handlers: IncomingMessageHandler[] = [];

  async connect(_config: CommAdapterConfig): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.connected) throw new Error('not connected');
    return `sent:${channelId}:${content.length}:${options?.threadId ?? ''}`;
  }

  async sendReply(channelId: string, replyToId: string, content: string): Promise<string> {
    return this.sendMessage(channelId, content, { threadId: replyToId });
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async emit(message: Message): Promise<void> {
    for (const h of this.handlers) await h(message);
  }
}

describe('CommAdapter interface', () => {
  it('implements connect/disconnect lifecycle', async () => {
    const adapter = new TestAdapter();
    expect(adapter.isConnected()).toBe(false);
    await adapter.connect({ platform: 'test' });
    expect(adapter.isConnected()).toBe(true);
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it('sends messages when connected', async () => {
    const adapter = new TestAdapter();
    await adapter.connect({ platform: 'test' });
    const id = await adapter.sendMessage('ch-1', 'hello');
    expect(id).toBe('sent:ch-1:5:');
  });

  it('sendMessage throws when not connected', async () => {
    const adapter = new TestAdapter();
    await expect(adapter.sendMessage('ch-1', 'hello')).rejects.toThrow('not connected');
  });

  it('sendReply passes threadId via options', async () => {
    const adapter = new TestAdapter();
    await adapter.connect({ platform: 'test' });
    const id = await adapter.sendReply('ch-1', 'thread-99', 'reply');
    expect(id).toBe('sent:ch-1:5:thread-99');
  });

  it('delivers inbound messages to registered handlers', async () => {
    const adapter = new TestAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);

    const msg: Message = {
      id: 'm1',
      platform: 'test',
      direction: 'inbound',
      channelId: 'ch-1',
      senderId: 'u1',
      senderName: 'User',
      agentId: 'agent-1',
      content: { type: 'text', text: 'ping' },
      timestamp: new Date().toISOString(),
    };
    await adapter.emit(msg);
    expect(handler).toHaveBeenCalledWith(msg);
  });

  it('CommAdapterConfig accepts arbitrary platform fields', () => {
    const config: CommAdapterConfig = {
      platform: 'custom',
      apiKey: 'secret',
      webhookPort: 9000,
    };
    expect(config.platform).toBe('custom');
    expect(config.apiKey).toBe('secret');
  });
});
