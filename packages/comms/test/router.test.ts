import { MessageRouter } from '../src/router.js';
import type { CommAdapter, CommAdapterConfig } from '../src/adapter.js';
import type { Message } from '@markus/shared';

// Capture router logging so "an unbound inbound is dropped loudly, not silently"
// is an asserted contract rather than a comment (issue #340, defect A).
const logCapture = vi.hoisted(() => ({ lines: [] as Array<{ level: string; msg: string; data?: Record<string, unknown> }> }));

vi.mock('@markus/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@markus/shared')>();
  const noop = () => {};
  const record = (level: string) => (msg: string, data?: Record<string, unknown>) => {
    logCapture.lines.push({ level, msg, data });
  };
  const makeLogger = (): Record<string, unknown> => ({
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => makeLogger(),
  });
  return { ...actual, createLogger: () => makeLogger() };
});

beforeEach(() => {
  logCapture.lines.length = 0;
});

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
    router.setAgentHandler(async (target) => {
      capturedAgentId = target.agentId;
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
    router.setAgentHandler(async (target) => {
      capturedAgentId = target.agentId;
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

    expect(adapter.sendReply).toHaveBeenCalledWith('C123', 'thread-ts-1', 'Thread reply', {
      markdown: true,
    });
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

  // ── Issue #340, defect A: the binding must actually route ──────────────────

  it('routes an inbound message through the platform default binding', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('feishu');
    router.registerAdapter(adapter);
    let capturedAgentId = '';
    router.setAgentHandler(async (target) => {
      capturedAgentId = target.agentId;
      return 'ok';
    });
    router.bindPlatformAgent('bound-agent', 'feishu');

    await router.connectAll([{ platform: 'feishu' }]);
    const onMessage = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // A pure-text Feishu inbound carries no agentId — exactly the message that
    // used to be dropped.
    await onMessage(makeMessage({ platform: 'feishu', channelId: 'oc_group', agentId: '' }));

    expect(capturedAgentId).toBe('bound-agent');
  });

  it('prefers an explicit channel binding over the platform default', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('slack');
    router.registerAdapter(adapter);
    let capturedAgentId = '';
    router.setAgentHandler(async (target) => {
      capturedAgentId = target.agentId;
      return 'ok';
    });
    router.bindPlatformAgent('platform-agent', 'slack');
    router.bindAgentToChannel('channel-agent', 'slack', 'C123');

    await router.connectAll([{ platform: 'slack' }]);
    const onMessage = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await onMessage(makeMessage({ platform: 'slack', channelId: 'C123' }));

    expect(capturedAgentId).toBe('channel-agent');
  });

  it('lets an explicit message.agentId win over every router binding', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('webui');
    router.registerAdapter(adapter);
    let capturedAgentId = '';
    router.setAgentHandler(async (target) => {
      capturedAgentId = target.agentId;
      return 'ok';
    });
    router.bindPlatformAgent('platform-agent', 'webui');

    await router.connectAll([{ platform: 'webui' }]);
    const onMessage = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await onMessage(makeMessage({ platform: 'webui', agentId: 'direct-agent' }));

    expect(capturedAgentId).toBe('direct-agent');
  });

  it('warns — it does not silently drop — when nothing is bound', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('slack');
    router.registerAdapter(adapter);
    const handler = vi.fn();
    router.setAgentHandler(handler);

    await router.connectAll([{ platform: 'slack' }]);
    const onMessage = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await onMessage(makeMessage({ platform: 'slack', channelId: 'unbound', agentId: '' }));

    expect(handler).not.toHaveBeenCalled();
    const logged = logCapture.lines.find((l) => /no agent bound at any level/i.test(l.msg));
    expect(logged).toBeDefined();
    expect(logged?.level).toBe('error');
    expect(logged?.data?.['platform']).toBe('slack');
    expect(String(logged?.data?.['hint'])).toMatch(/Secretary/);
  });

  it('sendAsAgent forwards the agent identity to the adapter (D7)', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('telegram');
    router.registerAdapter(adapter);
    await router.sendAsAgent('agent-1', 'telegram', '12345', 'hi');
    expect(adapter.sendMessage).toHaveBeenCalledWith('12345', 'hi', { agentId: 'agent-1' });
  });

  it('routes an unbound platform message to the global binding instead of dropping it (D6)', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('telegram');
    router.registerAdapter(adapter);
    let captured: { agentId: string; matchedScope: string } | undefined;
    router.setAgentHandler(async (target) => {
      captured = { agentId: target.agentId, matchedScope: target.matchedScope };
      return undefined;
    });
    router.setBindingLookup({
      bindings: () => [
        { scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'secretary' },
      ],
      platformDefaultAgent: () => undefined,
    });

    await router.connectAll([{ platform: 'telegram' }]);
    const onMessage = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await onMessage(makeMessage({ platform: 'telegram', channelId: '12345', agentId: '' }));

    expect(captured?.agentId).toBe('secretary');
    expect(captured?.matchedScope).toBe('global');
  });

  it('gives two groups of one instance independent session keys (D3)', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('feishu');
    router.registerAdapter(adapter);
    const keys: string[] = [];
    router.setAgentHandler(async (target) => {
      keys.push(target.conversationKey);
      return undefined;
    });
    router.setBindingLookup({
      bindings: () => [
        { scope: 'instance', instanceId: 'bi_1', nativeId: null, kind: null, agentId: 'agent-1' },
      ],
      platformDefaultAgent: () => undefined,
    });

    await router.connectAll([{ platform: 'feishu' }]);
    const onMessage = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await onMessage(makeMessage({ platform: 'feishu', channelId: 'oc_A', instanceId: 'bi_1', channelKind: 'group', agentId: '' }));
    await onMessage(makeMessage({ platform: 'feishu', channelId: 'oc_B', instanceId: 'bi_1', channelKind: 'group', agentId: '' }));

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe('im:bi_1:group:oc_A');
  });

  it('ignores inbound on a notification channel (outbound-only, not a silent drop)', async () => {
    const router = new MessageRouter();
    const adapter = makeMockAdapter('feishu');
    router.registerAdapter(adapter);
    const handler = vi.fn();
    router.setAgentHandler(handler);
    router.setBindingLookup({
      bindings: () => [
        { scope: 'channel', instanceId: 'bi_1', nativeId: 'oc_notify', kind: 'notification', agentId: 'agent-1' },
      ],
      platformDefaultAgent: () => undefined,
    });

    await router.connectAll([{ platform: 'feishu' }]);
    const onMessage = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await onMessage(makeMessage({ platform: 'feishu', channelId: 'oc_notify', instanceId: 'bi_1', agentId: '' }));

    expect(handler).not.toHaveBeenCalled();
    expect(logCapture.lines.some((l) => /notification channel is outbound-only/i.test(l.msg))).toBe(true);
  });

  it('exposes the effective bindings for observability', () => {
    const router = new MessageRouter();
    router.bindPlatformAgent('p-agent', 'feishu');
    router.bindAgentToChannel('c-agent', 'slack', 'C1');
    expect(router.getBindings()).toEqual({
      platforms: { feishu: 'p-agent' },
      channels: { 'slack:C1': 'c-agent' },
    });
  });
});
