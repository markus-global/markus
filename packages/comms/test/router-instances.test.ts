/**
 * Slice G2 — a platform may host many bot instances.
 *
 * The router used to key adapters by **platform**, so a second registration of the
 * same platform silently replaced the first: "one platform = one bot" was baked
 * into the connection table, not just the database. These tests pin the new
 * contract — adapters are keyed by **instance**, and two bots of one platform run
 * side by side with independent credentials and independent inbound namespaces.
 */
import { MessageRouter } from '../src/router.js';
import type { CommAdapter, CommAdapterConfig } from '../src/adapter.js';
import type { Message } from '@markus/shared';

interface StubAdapter extends CommAdapter {
  connectCalls: CommAdapterConfig[];
  /** Push an inbound message into the handler the router wired on connect. */
  deliver(message: Message): Promise<void>;
}

function stubAdapter(platform: string): StubAdapter {
  const connectCalls: CommAdapterConfig[] = [];
  let handler: ((message: Message) => Promise<void>) | undefined;
  const adapter = {
    platform,
    connectCalls,
    connect: vi.fn(async (config: CommAdapterConfig) => {
      connectCalls.push(config);
    }),
    disconnect: vi.fn(async () => {}),
    sendMessage: vi.fn(async (_channelId: string, content: string) => `msg:${content}`),
    sendReply: vi.fn(async (_channelId: string, _replyToId: string, content: string) => `reply:${content}`),
    onMessage: vi.fn((h: (message: Message) => Promise<void>) => {
      handler = h;
    }),
    isConnected: vi.fn(() => true),
    async deliver(message: Message) {
      await handler?.(message);
    },
  };
  return adapter as unknown as StubAdapter;
}

function inbound(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    platform: 'telegram',
    direction: 'inbound',
    channelId: 'C1',
    senderId: 'U1',
    senderName: 'User',
    agentId: '',
    content: { type: 'text', text: 'hello' },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('MessageRouter — bot instances (G2)', () => {
  it('keeps the implicit single-bot identity (platform id) when no instance id is given', async () => {
    const router = new MessageRouter();
    const adapter = stubAdapter('telegram');
    router.registerAdapter(adapter);

    await router.connectAll([{ platform: 'telegram' }]);

    expect(adapter.connectCalls).toHaveLength(1);
    expect(router.getInstances()).toEqual([{ instanceId: 'telegram', platform: 'telegram', connected: true }]);
  });

  it('runs two bots of the same platform side by side, each with its own credentials', async () => {
    const router = new MessageRouter();
    const sales = stubAdapter('telegram');
    const ops = stubAdapter('telegram');

    router.registerAdapter(sales, 'bi_tg_sales');
    router.registerAdapter(ops, 'bi_tg_ops');

    await router.connectAll([
      { platform: 'telegram', instanceId: 'bi_tg_sales', botToken: 'SALES' },
      { platform: 'telegram', instanceId: 'bi_tg_ops', botToken: 'OPS' },
    ]);

    // Both connected — not one overwriting the other.
    expect(sales.connectCalls).toHaveLength(1);
    expect(ops.connectCalls).toHaveLength(1);
    expect(sales.connectCalls[0]).toMatchObject({ platform: 'telegram', botToken: 'SALES' });
    expect(ops.connectCalls[0]).toMatchObject({ platform: 'telegram', botToken: 'OPS' });
    expect(router.getInstances()).toEqual([
      { instanceId: 'bi_tg_sales', platform: 'telegram', connected: true },
      { instanceId: 'bi_tg_ops', platform: 'telegram', connected: true },
    ]);
  });

  it('isolates each instance: a reply leaves through the bot that received the message', async () => {
    const router = new MessageRouter();
    const sales = stubAdapter('telegram');
    const ops = stubAdapter('telegram');
    router.registerAdapter(sales, 'bi_tg_sales');
    router.registerAdapter(ops, 'bi_tg_ops');
    // Instance-scoped channel bindings — the shape the gateway persists. The
    // message carries the receiving instance (the router stamps it, #376), so a
    // binding is addressed by that instance, not by the platform.
    const channelBindings = [
      { scope: 'channel' as const, instanceId: 'bi_tg_sales', nativeId: 'C1', kind: null, agentId: 'agent-sales' },
      { scope: 'channel' as const, instanceId: 'bi_tg_ops', nativeId: 'C2', kind: null, agentId: 'agent-ops' },
    ];
    router.setBindingLookup({
      bindings: (_orgId, platform) => (platform === 'telegram' ? channelBindings : []),
      platformDefaultAgent: () => undefined,
    });
    // The handler receives the resolved target (G3 contract), so the agent id
    // is `target.agentId` — not the target object itself.
    router.setAgentHandler(async (target) => `ack:${target.agentId}`);

    await router.connectAll([
      { platform: 'telegram', instanceId: 'bi_tg_sales' },
      { platform: 'telegram', instanceId: 'bi_tg_ops' },
    ]);

    await sales.deliver(inbound({ channelId: 'C1' }));
    await ops.deliver(inbound({ channelId: 'C2' }));
    await flush();

    // Each instance answers in its own namespace, via its own adapter.
    expect(sales.sendMessage).toHaveBeenCalledWith('C1', 'ack:agent-sales', { markdown: true });
    expect(ops.sendMessage).toHaveBeenCalledWith('C2', 'ack:agent-ops', { markdown: true });
    expect(sales.sendMessage).not.toHaveBeenCalledWith('C2', expect.anything());
    expect(ops.sendMessage).not.toHaveBeenCalledWith('C1', expect.anything());
  });

  it('addresses one instance explicitly on outbound', async () => {
    const router = new MessageRouter();
    const sales = stubAdapter('telegram');
    const ops = stubAdapter('telegram');
    router.registerAdapter(sales, 'bi_tg_sales');
    router.registerAdapter(ops, 'bi_tg_ops');

    const sent = await router.sendToChannel('telegram', 'C9', 'hi', 'bi_tg_ops');

    expect(sent).toBe('msg:hi');
    expect(ops.sendMessage).toHaveBeenCalledWith('C9', 'hi');
    expect(sales.sendMessage).not.toHaveBeenCalled();
  });

  it('skips (not silently overwrites) a connect config with no matching instance', async () => {
    const router = new MessageRouter();
    const sales = stubAdapter('telegram');
    router.registerAdapter(sales, 'bi_tg_sales');

    await router.connectAll([{ platform: 'telegram', instanceId: 'bi_missing' }]);

    expect(sales.connectCalls).toHaveLength(0);
  });
});

/**
 * Runtime (de)registration — the adapter set is *derived* state.
 *
 * Startup was the only writer of the adapter table: `registerAdapter` ran at boot
 * and `reconnectPlatform` could only reach bots that were *already* registered.
 * A bot created afterwards therefore had no adapter to connect and stayed dead
 * until the process restarted. These pin the two primitives that close the gap.
 */
describe('MessageRouter — runtime instance registration', () => {
  it('connects an instance registered after boot (the "no restart" path)', async () => {
    const router = new MessageRouter();
    const late = stubAdapter('telegram');
    router.registerAdapter(late, 'bi_tg_late');
    expect(router.hasInstance('bi_tg_late')).toBe(true);

    const ok = await router.connectInstance('bi_tg_late', {
      platform: 'telegram',
      botToken: 'X',
      instanceId: 'bi_tg_late',
    });

    expect(ok).toBe(true);
    expect(late.connectCalls).toHaveLength(1);
    expect(late.connectCalls[0]).toMatchObject({ botToken: 'X', instanceId: 'bi_tg_late' });
  });

  it('wires the message handler when connecting at runtime (no drift vs connectAll)', async () => {
    const router = new MessageRouter();
    const late = stubAdapter('telegram');
    router.registerAdapter(late, 'bi_tg_late');

    await router.connectInstance('bi_tg_late', { platform: 'telegram', instanceId: 'bi_tg_late' });

    // The wiring lives in one place, so a runtime connect must attach it too —
    // without this a late bot would connect but never receive anything.
    expect(late.onMessage).toHaveBeenCalledTimes(1);
  });

  it('answers false (never throws) for an unknown instance', async () => {
    const router = new MessageRouter();

    await expect(router.connectInstance('nope', { platform: 'telegram' })).resolves.toBe(false);
  });

  it('unregister disconnects the bot and removes it from the instance list', async () => {
    const router = new MessageRouter();
    const bot = stubAdapter('telegram');
    router.registerAdapter(bot, 'bi_tg_x');
    await router.connectInstance('bi_tg_x', { platform: 'telegram', instanceId: 'bi_tg_x' });

    await router.unregisterInstance('bi_tg_x');

    expect(bot.disconnect).toHaveBeenCalled();
    expect(router.hasInstance('bi_tg_x')).toBe(false);
    expect(router.getInstances().some((b) => b.instanceId === 'bi_tg_x')).toBe(false);
  });

  it('unregister is idempotent — dropping an unknown bot is a quiet no-op', async () => {
    const router = new MessageRouter();
    const bot = stubAdapter('telegram');
    router.registerAdapter(bot, 'bi_tg_x');

    await router.unregisterInstance('bi_tg_x');
    await expect(router.unregisterInstance('bi_tg_x')).resolves.toBeUndefined();

    // Exactly one disconnect: the second drop must not re-touch a gone bot.
    expect(bot.disconnect).toHaveBeenCalledTimes(1);
  });
});
