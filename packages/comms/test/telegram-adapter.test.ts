import { TelegramAdapter } from '../src/telegram/adapter.js';
import { TelegramClient, type TelegramUpdate } from '../src/telegram/client.js';

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

  it('sendMessage renders markdown as Telegram HTML when markdown is enabled', async () => {
    await adapter.sendMessage('123', '**bold** and `code`', { markdown: true });
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockTelegramClient>;
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: '<b>bold</b> and <code>code</code>', parse_mode: 'HTML' }),
    );
  });

  it('sendMessage sends verbatim (no parse mode) without the markdown flag', async () => {
    await adapter.sendMessage('123', '**bold**');
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockTelegramClient>;
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: '**bold**', parse_mode: undefined }),
    );
  });

  it('re-sends as plain text when Telegram rejects the formatted message', async () => {
    const client = (adapter as Record<string, unknown>)['client'] as ReturnType<typeof makeMockTelegramClient>;
    client.sendMessage.mockRejectedValueOnce(new Error('Bad Request: can\'t parse entities'));
    const id = await adapter.sendMessage('123', '**bold**', { markdown: true });
    expect(id).toBe('42');
    // first attempt formatted, second attempt verbatim so the message is not lost
    expect(client.sendMessage.mock.calls[0][0]).toEqual(
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(client.sendMessage.mock.calls[1][0]).toEqual(
      expect.objectContaining({ text: '**bold**' }),
    );
    expect((client.sendMessage.mock.calls[1][0] as Record<string, unknown>)['parse_mode']).toBeUndefined();
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

/**
 * The inbound leg. Before the fix the adapter could only receive via a webhook
 * at a `localhost` URL — which Telegram never calls — so a message to the bot
 * was silently dropped. These tests pin the transport that replaced it.
 */
describe('TelegramAdapter long polling (inbound)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('connect() polls getUpdates and delivers inbound messages to handlers', async () => {
    const delivered: Array<{ channelId: string; senderId: string; content: unknown }> = [];
    const polled: Array<number | undefined> = [];
    const a = new TelegramAdapter();
    a.onMessage(async (m) => {
      delivered.push({ channelId: m.channelId, senderId: m.senderId, content: m.content });
    });

    vi.spyOn(TelegramClient.prototype, 'getMe').mockResolvedValue({
      id: 1,
      username: 'bot',
      first_name: 'Bot',
    });
    vi.spyOn(TelegramClient.prototype, 'deleteWebhook').mockResolvedValue(true);
    vi.spyOn(TelegramClient.prototype, 'getUpdates').mockImplementation(
      async (offset?: number): Promise<TelegramUpdate[]> => {
        polled.push(offset);
        if (polled.length === 1) {
          return [
            {
              update_id: 100,
              message: {
                message_id: 1,
                chat: { id: 555, type: 'private' },
                from: { id: 9, is_bot: false, first_name: 'Ada', username: 'ada' },
                text: 'hello from telegram',
                date: 1_700_000_000,
              },
            },
          ];
        }
        // Park so the loop does not spin while the assertion runs.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [];
      },
    );

    await a.connect({ platform: 'telegram', botToken: '123:ABC' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await a.disconnect();

    expect(delivered).toEqual([
      { channelId: '555', senderId: '9', content: { type: 'text', text: 'hello from telegram' } },
    ]);
    // The offset must advance past the processed update, or every poll replays it.
    expect(polled[0]).toBeUndefined();
    expect(polled[1]).toBe(101);
  });

  it('disconnect() stops the poll loop so no message is delivered afterwards', async () => {
    const delivered: unknown[] = [];
    const a = new TelegramAdapter();
    a.onMessage(async (m) => {
      delivered.push(m);
    });

    vi.spyOn(TelegramClient.prototype, 'getMe').mockResolvedValue({ id: 1, username: 'b', first_name: 'B' });
    vi.spyOn(TelegramClient.prototype, 'deleteWebhook').mockResolvedValue(true);
    let calls = 0;
    vi.spyOn(TelegramClient.prototype, 'getUpdates').mockImplementation(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [
        {
          update_id: calls,
          message: {
            message_id: calls,
            chat: { id: 555, type: 'private' },
            from: { id: 9, is_bot: false, first_name: 'Ada' },
            text: `msg ${calls}`,
            date: 1_700_000_000,
          },
        },
      ];
    });

    await a.connect({ platform: 'telegram', botToken: '123:ABC' });
    await a.disconnect();
    const countAtDisconnect = delivered.length;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(delivered.length).toBe(countAtDisconnect);
    expect(a.isConnected()).toBe(false);
  });

  it('a failing poll retries instead of giving up', async () => {
    const a = new TelegramAdapter();
    vi.spyOn(TelegramClient.prototype, 'getMe').mockResolvedValue({ id: 1, username: 'b', first_name: 'B' });
    vi.spyOn(TelegramClient.prototype, 'deleteWebhook').mockResolvedValue(true);
    let calls = 0;
    const getUpdates = vi
      .spyOn(TelegramClient.prototype, 'getUpdates')
      .mockImplementation(async (offset?: number): Promise<TelegramUpdate[]> => {
        calls += 1;
        if (calls === 1) throw new Error('transient 502');
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [];
      });

    await a.connect({ platform: 'telegram', botToken: '123:ABC' });
    // Backoff starts at 1s, so wait past it to see the retry.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await a.disconnect();

    expect(getUpdates.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
