import { describe, expect, it, vi } from 'vitest';
import { DiscordAdapter } from '../src/discord/adapter.js';

function makeClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ id: 'sent-1' }),
    sendReply: vi.fn().mockResolvedValue({ id: 'reply-1' }),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
  };
}

describe('DiscordAdapter', () => {
  it('has the discord platform', () => {
    expect(new DiscordAdapter().platform).toBe('discord');
  });

  it('sends messages through the Discord client', async () => {
    const adapter = new DiscordAdapter();
    const client = makeClient();

    (adapter as Record<string, unknown>)['client'] = client;
    (adapter as Record<string, unknown>)['connected'] = true;

    await expect(adapter.sendMessage('channel-1', 'Hello')).resolves.toBe('sent-1');
    await expect(adapter.sendReply('channel-1', 'original-1', 'Reply')).resolves.toBe('reply-1');

    expect(client.sendMessage).toHaveBeenCalledWith('channel-1', 'Hello');
    expect(client.sendReply).toHaveBeenCalledWith('channel-1', 'original-1', 'Reply');
  });

  it('rejects sending when disconnected', async () => {
    const adapter = new DiscordAdapter();

    await expect(adapter.sendMessage('channel-1', 'Hello')).rejects.toThrow('Discord adapter not connected');
  });

  it('maps inbound Discord messages to Markus messages', async () => {
    const adapter = new DiscordAdapter();
    const client = makeClient();
    const handler = vi.fn().mockResolvedValue(undefined);

    (adapter as Record<string, unknown>)['client'] = client;
    (adapter as Record<string, unknown>)['connected'] = true;
    (adapter as Record<string, unknown>)['handlers'] = [handler];

    const handleMessage = (adapter as Record<string, unknown>)['handleMessage'] as (message: unknown) => Promise<void>;

    await handleMessage.call(adapter, {
      id: 'discord-message-1',
      channel_id: 'channel-1',
      content: 'Hello Markus',
      timestamp: '2026-10-04T00:00:00.000Z',
      author: {
        id: 'user-1',
        username: 'alice',
      },
      message_reference: {
        message_id: 'original-1',
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'discord',
        direction: 'inbound',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'alice',
        content: {
          type: 'text',
          text: 'Hello Markus',
        },
        replyToId: 'original-1',
        threadId: 'discord-message-1',
        timestamp: '2026-10-04T00:00:00.000Z',
      }),
    );
  });

  it('ignores bot messages and empty messages', async () => {
    const adapter = new DiscordAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);

    (adapter as Record<string, unknown>)['handlers'] = [handler];

    const handleMessage = (adapter as Record<string, unknown>)['handleMessage'] as (message: unknown) => Promise<void>;

    await handleMessage.call(adapter, {
      id: 'bot-message',
      channel_id: 'channel-1',
      content: 'ignore me',
      timestamp: '2026-10-04T00:00:00.000Z',
      author: {
        id: 'bot-1',
        username: 'markus',
        bot: true,
      },
    });

    await handleMessage.call(adapter, {
      id: 'empty-message',
      channel_id: 'channel-1',
      content: '',
      timestamp: '2026-10-04T00:00:00.000Z',
      author: {
        id: 'user-1',
        username: 'alice',
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
