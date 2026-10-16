import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getManifest, MessageRouter } from '@markus/comms';
import type { MarkusConfig } from '@markus/shared';
import { connectConfiguredPlatforms } from '../src/commands/start.js';

// Keep startup, the manifest, adapter and router real; fake only the wire.
class FakeSocket {
  static instances: FakeSocket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  ready(): void {
    this.emit({ op: 10, d: { heartbeat_interval: 45000 } });
    this.emit({ op: 0, t: 'READY', s: 1, d: { session_id: 'session' } });
  }

  message(channel: string): void {
    this.emit({
      op: 0, t: 'MESSAGE_CREATE', s: 2,
      d: {
        id: `message-${channel}`, channel_id: channel, content: 'hello',
        timestamp: '2026-10-15T00:00:00Z',
        author: { id: 'user', username: 'Alice' },
      },
    });
  }
}

describe('Discord manifest-driven startup', () => {
  const manifest = getManifest('discord')!;
  let router: MessageRouter;
  const fetchMock = vi.fn<typeof fetch>();
  const config = { integrations: {} } as MarkusConfig;

  beforeEach(() => {
    router = new MessageRouter();
    FakeSocket.instances = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: 'sent', username: 'bot' })));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', FakeSocket);
    // Config resolution must not inherit real bot credentials from the shell.
    for (const key of ['DISCORD_BOT_TOKEN', 'DISCORD_AGENT_ID', 'DISCORD_API_URL', 'DISCORD_GATEWAY_URL']) {
      vi.stubEnv(key, '');
    }
  });

  afterEach(async () => {
    await router.disconnectAll();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('resolves stored instance config, waits for READY, routes inbound and sends the agent reply', async () => {
    const handler = vi.fn(async () => 'hello back');
    router.setAgentHandler(handler);
    router.setBindingLookup({
      bindings: () => [{ scope: 'instance', instanceId: 'discord-bot', nativeId: null, kind: null, agentId: 'agent-1' }],
      platformDefaultAgent: () => undefined,
    });
    const pending = connectConfiguredPlatforms({
      router, manifests: [manifest],
      config: { integrations: { discord: { botToken: 'file-token', apiUrl: 'https://discord.test/api/v10' } } } as MarkusConfig,
      instances: [{
        id: 'discord-bot', platform: 'discord', label: 'Test bot', enabled: true,
        config: { botToken: 'stored-token', agentId: 'agent-1', gatewayUrl: 'wss://discord.test/gateway' },
      }],
    });
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(router.getInstances()).toEqual([{ instanceId: 'discord-bot', platform: 'discord', connected: false }]);
    expect(fetchMock).toHaveBeenCalledWith('https://discord.test/api/v10/users/@me', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bot stored-token' }),
    }));
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe('wss://discord.test/gateway');
    socket.ready();
    expect(await pending).toEqual([{ id: 'discord-bot', label: 'Discord (Test bot)', connected: true }]);
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toMatchObject({ op: 2, d: { token: 'stored-token', intents: 33280 } });

    socket.message('channel-1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1', instanceId: 'discord-bot', matchedScope: 'instance',
    }), expect.objectContaining({ platform: 'discord', channelId: 'channel-1', threadId: 'message-channel-1' }));
    expect(fetchMock).toHaveBeenLastCalledWith('https://discord.test/api/v10/channels/channel-1/messages', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ content: 'hello back', message_reference: { message_id: 'message-channel-1' } }),
    }));
    await router.disconnectAll();
    expect(socket.close).toHaveBeenCalled();
    expect(router.getInstances()[0]?.connected).toBe(false);
  });

  it.each(['missing credentials', 'disabled'] as const)('skips an instance with %s without opening a transport', async (reason) => {
    const results = await connectConfiguredPlatforms({
      router, manifests: [manifest], config,
      instances: [{ id: 'off', platform: 'discord', label: 'Off',
        enabled: reason !== 'disabled', config: reason === 'disabled' ? { botToken: 'token', agentId: 'agent' } : {},
      }],
    });
    expect(results).toEqual([]);
    expect(router.getInstances()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('keeps two bots in the same channel isolated and replies through the receiving bot', async () => {
    const handler = vi.fn(async () => 'reply');
    router.setAgentHandler(handler);
    router.setBindingLookup({
      bindings: () => ['one', 'two'].map(id => ({
        scope: 'instance' as const, instanceId: id, nativeId: null, kind: null, agentId: `agent-${id}`,
      })),
      platformDefaultAgent: () => undefined,
    });
    const pending = connectConfiguredPlatforms({
      router, manifests: [manifest], config,
      instances: ['one', 'two'].map(id => ({
        id, platform: 'discord', label: id, config: { botToken: `${id}-token` },
      })),
    });
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    FakeSocket.instances[0]!.ready();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    FakeSocket.instances[1]!.ready();
    expect(await pending).toMatchObject([{ id: 'one', connected: true }, { id: 'two', connected: true }]);
    for (const [index, id] of ['one', 'two'].entries()) {
      FakeSocket.instances[index]!.message('shared-channel');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3 + index));
      expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({
        instanceId: id, agentId: `agent-${id}`, conversationKey: `im:${id}:group:shared-channel`,
      }), expect.objectContaining({ instanceId: id }));
      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://discord.com/api/v10/channels/shared-channel/messages',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bot ${id}-token` }) }),
      );
    }
  });

  it.each(['invalid token', 'network down', 'Gateway failure'] as const)('isolates %s so the next Discord bot connects', async (failure) => {
    if (failure === 'invalid token') fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    if (failure === 'network down') fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const pending = connectConfiguredPlatforms({
      router, manifests: [manifest], config,
      instances: ['bad', 'good'].map(id => ({
        id, platform: 'discord', label: id, enabled: true, config: { botToken: `${id}-token`, agentId: 'agent' },
      })),
    });
    if (failure === 'Gateway failure') {
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
      FakeSocket.instances[0]!.onerror?.();
    }
    const count = failure === 'Gateway failure' ? 2 : 1;
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(count));
    FakeSocket.instances[count - 1]!.ready();
    expect(await pending).toMatchObject([{ id: 'bad', connected: false }, { id: 'good', connected: true }]);
    expect(router.getInstances()).toMatchObject([{ instanceId: 'bad', connected: false }, { instanceId: 'good', connected: true }]);
    await expect(router.sendToChannel('discord', 'channel', 'still running', 'good')).resolves.toBe('sent');
  });
});
