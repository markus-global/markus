import { MessageRouter } from '../src/router.js';
import type { CommAdapter, CommAdapterConfig } from '../src/adapter.js';
import type { Message } from '@markus/shared';

function makeMockAdapter(platform: string, connected = true): CommAdapter {
  return {
    platform,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue('msg-id-1'),
    sendReply: vi.fn().mockResolvedValue('reply-id-1'),
    onMessage: vi.fn(),
    isConnected: vi.fn().mockReturnValue(connected),
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    platform: 'slack',
    direction: 'inbound',
    channelId: 'C123',
    senderId: 'U456',
    senderName: 'User',
    agentId: '',
    content: { type: 'text', text: 'Hello' },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('MessageRouter', () => {
  it('registers adapters by platform', () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('slack');
    router.registerAdapter(adapter);
    expect(adapter.platform).toBe('slack');
  });

  it('binds agents to channels', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('slack');
    router.registerAdapter(adapter);

    let capturedAgentId = '';
    router.setAgentHandler(async (agentId) => {
      capturedAgentId = agentId;
      return 'Reply text';
    });
    router.bindAgentToChannel('agent-1', 'slack', 'C123');

    // connectAll sets up adapter.onMessage callback via routeIncomingMessage
    await router.connectAll([{ platform: 'slack' }]);
    const onMessageCall = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await onMessageCall(makeMessage());

    expect(capturedAgentId).toBe('agent-1');
  });

  it('uses message.agentId when set', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('webui');
    router.registerAdapter(adapter);

    let capturedAgentId = '';
    router.setAgentHandler(async (agentId) => {
      capturedAgentId = agentId;
      return undefined;
    });

    await router.connectAll([{ platform: 'webui' }]);
    const onMessage = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await onMessage(makeMessage({ platform: 'webui', agentId: 'direct-agent', channelId: 'ch1' }));

    expect(capturedAgentId).toBe('direct-agent');
  });

  it('sends reply in thread when threadId is present', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('slack');
    router.registerAdapter(adapter);
    router.bindAgentToChannel('agent-1', 'slack', 'C123');
    router.setAgentHandler(async () => 'Thread reply');

    await router.connectAll([{ platform: 'slack' }]);
    const onMessage = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await onMessage(makeMessage({ threadId: 'thread-ts-1' }));

    expect(adapter.sendReply).toHaveBeenCalledWith('C123', 'thread-ts-1', 'Thread reply');
  });

  it('sendToChannel returns undefined when adapter disconnected', async () => {
    const router = new MessageRouter();
    router.registerAdapter(makeMockAdapter('slack', false));
    const result = await router.sendToChannel('slack', 'C123', 'hello');
    expect(result).toBeUndefined();
  });

  it('sendToChannel delegates to adapter', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('slack');
    router.registerAdapter(adapter);
    const result = await router.sendToChannel('slack', 'C123', 'hello');
    expect(result).toBe('msg-id-1');
    expect(adapter.sendMessage).toHaveBeenCalledWith('C123', 'hello');
  });

  it('connectAll skips unregistered platforms', async () => {
    const router = new MessageRouter();
    await expect(router.connectAll([{ platform: 'unknown' }])).resolves.toBeUndefined();
  });

  it('connectAll continues when adapter connect fails', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('slack');
    adapter.connect = vi.fn().mockRejectedValue(new Error('connect failed'));
    router.registerAdapter(adapter);
    await expect(router.connectAll([{ platform: 'slack' }])).resolves.toBeUndefined();
  });

  it('disconnectAll disconnects connected adapters', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('slack');
    router.registerAdapter(adapter);
    await router.disconnectAll();
    expect(adapter.disconnect).toHaveBeenCalled();
  });

  it('ignores messages with no bound agent', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('slack');
    router.registerAdapter(adapter);
    const handler = vi.fn();
    router.setAgentHandler(handler);

    await router.connectAll([{ platform: 'slack' }]);
    const onMessage = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await onMessage(makeMessage({ channelId: 'unbound' }));

    expect(handler).not.toHaveBeenCalled();
  });

  it('sendAsAgent delegates to sendToChannel', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('telegram');
    router.registerAdapter(adapter);
    const result = await router.sendAsAgent('agent-1', 'telegram', '12345', 'hi');
    expect(result).toBe('msg-id-1');
  });
});
