import { TelegramAdapter } from '../src/telegram/adapter.js';

function makeMockTelegramClient() {
  return {
    getMe: vi.fn().mockResolvedValue({ id: 1, username: 'testbot', first_name: 'Test' }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42, chat: { id: 123 }, date: Date.now() / 1000 }),
    setWebhook: vi.fn().mockResolvedValue(true),
  };
}

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    adapter = new TelegramAdapter();
    (adapter as Record<string, unknown>)['client'] = makeMockTelegramClient();
    (adapter as Record<string, unknown>)['config'] = {
      platform: 'telegram',
      botToken: '123:ABC',
    };
    (adapter as Record<string, unknown>)['connected'] = true;
  });

  it('has platform telegram', () => {
    expect(adapter.platform).toBe('telegram');
  });

  it('sendMessage converts numeric channelId', async () => {
    const id = await adapter.sendMessage('12345', 'Hello');
    expect(id).toBe('42');
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockTelegramClient>;
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: 12345, text: 'Hello' }),
    );
  });

  it('sendMessage preserves @username channelId', async () => {
    await adapter.sendMessage('@mychannel', 'Hello');
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockTelegramClient>;
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: '@mychannel' }),
    );
  });

  it('sendMessage uses Markdown when richText enabled', async () => {
    await adapter.sendMessage('123', '*bold*', { richText: true });
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockTelegramClient>;
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
  });

  it('sendReply includes reply_to_message_id', async () => {
    await adapter.sendReply('123', '99', 'Reply text');
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockTelegramClient>;
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ reply_to_message_id: 99 }),
    );
  });

  it('sendBlocks converts blocks to text', async () => {
    const blocks = [
      { type: 'header', text: { text: 'Title' } },
      { type: 'section', text: { text: 'Body' } },
      { type: 'divider' },
    ];
    await adapter.sendBlocks('123', blocks);
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockTelegramClient>;
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('# Title'), parse_mode: 'HTML' }),
    );
  });

  it('sendMessage throws when not connected', async () => {
    (adapter as Record<string, unknown>)['client'] = undefined;
    await expect(adapter.sendMessage('123', 'hi')).rejects.toThrow('Telegram adapter not connected');
  });

  it('connect validates bot via getMe', async () => {
    const fresh = new TelegramAdapter();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { id: 1, username: 'bot', first_name: 'Bot' } }),
      }),
    );
    await fresh.connect({ platform: 'telegram', botToken: '123:ABC' });
    expect(fresh.isConnected()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('deleteMessage logs warning without throwing', async () => {
    await expect(adapter.deleteMessage('123', '42')).resolves.toBeUndefined();
  });

  it('isConnected reflects state', () => {
    expect(adapter.isConnected()).toBe(true);
    (adapter as Record<string, unknown>)['connected'] = false;
    expect(adapter.isConnected()).toBe(false);
  });
});
