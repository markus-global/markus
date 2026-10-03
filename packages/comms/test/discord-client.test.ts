import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordAdapter } from '../src/discord/adapter.js';
import { MessageRouter } from '../src/router.js';
import { DiscordClient, type DiscordRestTransport } from '../src/discord/client.js';
import type { DiscordGatewayEvent, DiscordGatewayTransport } from '../src/discord/client.js';

function makeRest(body: unknown, ok = true, status = 200): DiscordRestTransport {
  return {
    fetch: vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  };
}

function makeGateway() {
  let onMessage: ((event: DiscordGatewayEvent) => void) | undefined;
  let onClose: (() => void) | undefined;

  const gateway: DiscordGatewayTransport & {
    emit: (event: DiscordGatewayEvent) => void;
    closeConnection: () => void;
  } = {
    connect: vi.fn((_url, messageHandler, closeHandler) => {
      onMessage = messageHandler;
      onClose = closeHandler;
      queueMicrotask(() => messageHandler({ op: 0, t: 'READY', d: {} }));
    }),
    send: vi.fn(),
    close: vi.fn(),
    emit: (event) => onMessage?.(event),
    closeConnection: () => onClose?.(),
  };

  return gateway;
}

describe('DiscordClient', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('rejects network-down REST authentication without opening the Gateway', async () => {
    const rest = {
      fetch: vi.fn().mockRejectedValue(new Error('network down')),
    };
    const gateway = makeGateway();
    const client = new DiscordClient({ botToken: 'token' }, rest, gateway);
    await expect(client.connect(() => undefined)).rejects.toThrow('network down');
    expect(gateway.connect).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });

  it('rejects an initial Gateway failure and cancels retries', async () => {
    vi.useFakeTimers();
    const gateway = makeGateway();
    vi.mocked(gateway.connect).mockImplementation((_url, _message, close) => close(4004));
    const client = new DiscordClient({ botToken: 'token' }, makeRest({ id: 'bot' }), gateway);
    await expect(client.connect(() => undefined)).rejects.toThrow('Gateway connection failed');
    await vi.advanceTimersByTimeAsync(20000);
    expect(gateway.connect).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(false);
  });

  it('backs off repeated failed reconnects and cancels them on disconnect', async () => {
    vi.useFakeTimers();
    const gateway = makeGateway();
    const client = new DiscordClient(
      { botToken: 'token', reconnectDelaysMs: [100, 200] },
      makeRest({ id: 'bot' }),
      gateway,
    );
    await client.connect(() => undefined);
    vi.mocked(gateway.connect).mockImplementation(() => {
      throw new Error('network down');
    });
    gateway.closeConnection();
    await vi.advanceTimersByTimeAsync(100);
    expect(gateway.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(gateway.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(gateway.connect).toHaveBeenCalledTimes(3);
    client.disconnect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(gateway.connect).toHaveBeenCalledTimes(3);
  });

  it('heartbeats with the latest sequence and reconnects if an ACK is missing', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const gateway = makeGateway();
    const client = new DiscordClient({ botToken: 'token' }, makeRest({ id: 'bot' }), gateway);
    await client.connect(() => undefined);
    gateway.emit({ op: 10, d: { heartbeat_interval: 1000 } });
    gateway.emit({ op: 0, t: 'OTHER', s: 42 });
    await vi.advanceTimersByTimeAsync(500);
    expect(gateway.send).toHaveBeenLastCalledWith({ op: 1, d: 42 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(gateway.connect).toHaveBeenCalledTimes(2);
    client.disconnect();
  });

  it('resumes an established session after a transient close', async () => {
    vi.useFakeTimers();
    const gateway = makeGateway();
    const client = new DiscordClient({ botToken: 'token' }, makeRest({ id: 'bot' }), gateway);
    await client.connect(() => undefined);
    vi.mocked(gateway.connect).mockImplementation((_url, messageHandler, closeHandler) => {
      gateway.emit = messageHandler;
      gateway.closeConnection = () => closeHandler();
    });
    gateway.emit({
      op: 0,
      t: 'READY',
      s: 7,
      d: {
        session_id: 'session',
        resume_gateway_url: 'wss://gateway.discord.gg',
      },
    });
    gateway.closeConnection();
    await vi.advanceTimersByTimeAsync(1000);
    gateway.emit({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(gateway.send).toHaveBeenCalledWith({
      op: 6,
      d: { token: 'token', session_id: 'session', seq: 7 },
    });
    client.disconnect();
  });

  it('keeps the router running after Discord authentication fails', async () => {
    vi.stubGlobal('fetch', makeRest({}, false, 401).fetch);
    const router = new MessageRouter();
    const adapter = new DiscordAdapter();
    router.registerAdapter(adapter);
    await expect(router.connectAll([{ platform: 'discord', botToken: 'bad' }])).resolves.toBeUndefined();
    expect(adapter.isConnected()).toBe(false);
  });
  it('validates a bot token through the REST transport', async () => {
    const rest = makeRest({ id: 'bot-1', username: 'markus' });
    const client = new DiscordClient({ botToken: 'valid-token' }, rest);

    await expect(client.getCurrentUser()).resolves.toEqual({
      id: 'bot-1',
      username: 'markus',
    });

    expect(rest.fetch).toHaveBeenCalledWith(
      'https://discord.com/api/v10/users/@me',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bot valid-token',
        }),
      }),
    );
  });

  it('rejects an invalid bot token', async () => {
    const rest = makeRest({ message: '401: Unauthorized' }, false, 401);
    const client = new DiscordClient({ botToken: 'invalid-token' }, rest);

    await expect(client.getCurrentUser()).rejects.toThrow('Discord API error: 401');
  });

  it('sends a message through the REST transport', async () => {
    const rest = makeRest({ id: 'message-1' });
    const client = new DiscordClient({ botToken: 'token' }, rest);

    await client.sendMessage('channel-1', 'Hello Discord');

    expect(rest.fetch).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/channel-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: 'Hello Discord' }),
      }),
    );
  });

  it('sends a reply with a Discord message reference', async () => {
    const rest = makeRest({ id: 'message-2' });
    const client = new DiscordClient({ botToken: 'token' }, rest);

    await client.sendReply('channel-1', 'original-1', 'Reply');

    expect(rest.fetch).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/channel-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          content: 'Reply',
          message_reference: { message_id: 'original-1' },
        }),
      }),
    );
  });

  it('identifies and receives Gateway messages', async () => {
    const rest = makeRest({ id: 'bot-1', username: 'markus' });
    const gateway = makeGateway();
    const handler = vi.fn();

    const client = new DiscordClient({ botToken: 'token' }, rest, gateway);
    await client.connect(handler);

    gateway.emit({ op: 10, d: { heartbeat_interval: 45000 } });

    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 2,
        d: expect.objectContaining({
          token: 'token',
          intents: 33280,
        }),
      }),
    );

    gateway.emit({ op: 0, t: 'READY', d: {} });

    expect(client.isConnected()).toBe(true);

    const message = {
      id: 'message-1',
      channel_id: 'channel-1',
      content: 'Hello Markus',
      timestamp: '2026-10-04T00:00:00.000Z',
      author: {
        id: 'user-1',
        username: 'alice',
      },
    };

    gateway.emit({ op: 0, t: 'MESSAGE_CREATE', d: message });
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith(message);
  });

  it('marks the client disconnected when the Gateway closes', async () => {
    const rest = makeRest({ id: 'bot-1', username: 'markus' });
    const gateway = makeGateway();
    const client = new DiscordClient({ botToken: 'token' }, rest, gateway);

    await client.connect(() => undefined);
    gateway.emit({ op: 0, t: 'READY', d: {} });

    expect(client.isConnected()).toBe(true);

    gateway.closeConnection();

    expect(client.isConnected()).toBe(false);
  });

  it('reconnects after the Gateway closes using the configured backoff', async () => {
    vi.useFakeTimers();

    try {
      const rest = makeRest({ id: 'bot-1', username: 'markus' });
      const gateway = makeGateway();
      const client = new DiscordClient(
        {
          botToken: 'token',
          reconnectDelaysMs: [100],
        },
        rest,
        gateway,
      );

      await client.connect(() => undefined);
      gateway.emit({ op: 0, t: 'READY', d: {} });

      gateway.closeConnection();

      expect(gateway.connect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(gateway.connect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(gateway.connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests message content and sends Gateway heartbeats', async () => {
    vi.useFakeTimers();

    try {
      const rest = makeRest({ id: 'bot-1', username: 'markus' });
      const gateway = makeGateway();
      const client = new DiscordClient({ botToken: 'token' }, rest, gateway);

      await client.connect(() => undefined);

      gateway.emit({
        op: 10,
        d: { heartbeat_interval: 1000 },
      });

      expect(gateway.send).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 2,
          d: expect.objectContaining({
            intents: 33280,
          }),
        }),
      );

      await vi.advanceTimersByTimeAsync(1000);

      expect(gateway.send).toHaveBeenCalledWith({
        op: 1,
        d: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
