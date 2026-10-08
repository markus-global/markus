import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordAdapter } from '../src/discord/adapter.js';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onmessage?: ((event: { data: string }) => void) | null;
  onclose?: ((event: { code: number }) => void) | null;
  onerror?: (() => void) | null;
  send = vi.fn();
  close = vi.fn();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe('Discord native transport', () => {
  let adapter: DiscordAdapter;
  afterEach(async () => {
    await adapter?.disconnect();
    vi.unstubAllGlobals();
    FakeSocket.instances = [];
  });

  async function start() {
    vi.stubGlobal('WebSocket', FakeSocket);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'bot', username: 'markus' })));
    vi.stubGlobal('fetch', fetch);
    adapter = new DiscordAdapter();
    const pending = adapter.connect({ platform: 'discord', botToken: 'token' });
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0];
    socket.emit({ op: 10, d: { heartbeat_interval: 45000 } });
    socket.emit({ op: 0, t: 'READY', d: { session_id: 'session' } });
    await pending;
    return { socket, fetch };
  }

  it('connects, maps real serialized events, sends a REST reply and disconnects', async () => {
    const { socket, fetch } = await start();
    expect(adapter.isConnected()).toBe(true);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
      op: 2,
      d: { intents: 33280 },
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);
    socket.emit({
      op: 0,
      t: 'MESSAGE_CREATE',
      d: {
        id: 'message',
        channel_id: 'channel',
        content: 'hello',
        timestamp: '2026-10-04T00:00:00Z',
        author: { id: 'user', username: 'alice' },
      },
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    expect(handler.mock.calls[0][0]).toMatchObject({
      platform: 'discord',
      channelId: 'channel',
      threadId: 'message',
    });
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'reply' })));
    await expect(adapter.sendReply('channel', 'message', 'hello back')).resolves.toBe('reply');
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/channels/channel/messages'),
      expect.objectContaining({
        body: JSON.stringify({
          content: 'hello back',
          message_reference: { message_id: 'message' },
        }),
      }),
    );
    await adapter.disconnect();
    expect(socket.close).toHaveBeenCalled();
    expect(adapter.isConnected()).toBe(false);
  });

  it('reports socket loss and rejects sends while reconnecting', async () => {
    const { socket } = await start();
    socket.onclose?.({ code: 1006 });
    expect(adapter.isConnected()).toBe(false);
    await expect(adapter.sendMessage('channel', 'hello')).rejects.toThrow('not connected');
  });

  it('rejects a Gateway error before READY', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'bot' }))));
    adapter = new DiscordAdapter();
    const pending = adapter.connect({ platform: 'discord', botToken: 'token' });
    const failure = expect(pending).rejects.toThrow('Gateway connection failed');
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    FakeSocket.instances[0].onerror?.();
    await failure;
    expect(adapter.isConnected()).toBe(false);
  });
});
