/**
 * Issue #376 — "every inbound `Message` carries the id of the bot that received
 * it" is **one invariant with one writer**.
 *
 * #375 fixed Discord by stamping `Message.instanceId` inside the Discord adapter.
 * Telegram and WhatsApp still build their inbound `Message` with no instance id,
 * so on those platforms a second bot's messages lost the id: an `instance`-scope
 * binding never matched and the message resolved at the platform/global level —
 * the exact bug #375 fixed, just spelled differently. Fixing it adapter by
 * adapter leaves the invariant with five writers, and the next adapter or
 * refactor re-introduces the miss.
 *
 * These tests pin the structural fix: the **router** stamps the receiving
 * instance — it is the only party that knows which bot's handler fired — so no
 * adapter can drop it. The stub adapter below deliberately never sets
 * `instanceId` (the Telegram/WhatsApp shape); every assertion here must still
 * hold, which is what makes the guarantee adapter-independent.
 */
import { MessageRouter } from '../src/router.js';
import type { CommAdapter, CommAdapterConfig } from '../src/adapter.js';
import type { BindingLookup, ScopeBinding } from '../src/gateway/inbound.js';
import type { Message } from '@markus/shared';

interface StubAdapter extends CommAdapter {
  /** Push an inbound message into the handler the router wired at registration. */
  deliver(message: Message): Promise<void>;
}

function stubAdapter(platform: string): StubAdapter {
  let handler: ((message: Message) => Promise<void>) | undefined;
  const adapter = {
    platform,
    connect: vi.fn(async (_config: CommAdapterConfig) => {}),
    disconnect: vi.fn(async () => {}),
    sendMessage: vi.fn(async (_channelId: string, content: string) => `msg:${content}`),
    sendReply: vi.fn(
      async (_channelId: string, _replyToId: string, content: string) => `reply:${content}`,
    ),
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

/** The Telegram/WhatsApp shape: no `instanceId` on the inbound message. */
function inbound(platform: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    platform: platform as Message['platform'],
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

function lookupOf(bindings: ScopeBinding[], platformDefault?: string): BindingLookup {
  return {
    bindings: (_orgId, platform) =>
      bindings.filter((b) => b.scope === 'global' || platform === 'telegram' || platform === 'feishu'),
    platformDefaultAgent: () => platformDefault,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('MessageRouter — inbound instance stamping is adapter-independent (#376)', () => {
  it('stamps the receiving instance on a message whose adapter never set one', async () => {
    const router = new MessageRouter();
    const seen: Message[] = [];
    const adapter = stubAdapter('telegram');
    router.registerAdapter(adapter, 'bi_tg_sales');
    router.setBindingLookup(lookupOf([], 'agent-platform'));
    router.setAgentHandler(async (_target, message) => {
      seen.push(message);
      return undefined;
    });

    await router.connectInstance('bi_tg_sales', { platform: 'telegram', instanceId: 'bi_tg_sales' });
    await adapter.deliver(inbound('telegram'));
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.instanceId).toBe('bi_tg_sales');
  });

  it('stamps before the connection-test port sees the message', async () => {
    // The test registry matches by instance, so a message that reaches it
    // unstamped can never be recognised as the verification reply it is.
    const router = new MessageRouter();
    const inboundIds: Array<string | undefined> = [];
    const adapter = stubAdapter('telegram');
    router.registerAdapter(adapter, 'bi_tg_ops');
    router.setBindingLookup(lookupOf([], 'agent-platform'));
    router.setConnectionTestRegistry({
      noteInbound: async (message) => {
        inboundIds.push(message.instanceId);
        return true; // consume it: a verification reply is a handshake
      },
    });
    const agentHandler = vi.fn(async () => undefined);
    router.setAgentHandler(agentHandler);

    await router.connectInstance('bi_tg_ops', { platform: 'telegram', instanceId: 'bi_tg_ops' });
    await adapter.deliver(inbound('telegram'));
    await flush();

    expect(inboundIds).toEqual(['bi_tg_ops']);
    expect(agentHandler).not.toHaveBeenCalled();
  });

  it('lets an instance-scope binding match a message the adapter never stamped', async () => {
    const router = new MessageRouter();
    const adapter = stubAdapter('telegram');
    const targets: string[] = [];
    router.registerAdapter(adapter, 'bi_tg_ops');
    router.setBindingLookup(
      lookupOf(
        [
          { scope: 'instance', instanceId: 'bi_tg_ops', nativeId: null, kind: null, agentId: 'agent-ops' },
          { scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'agent-global' },
        ],
        'agent-platform',
      ),
    );
    router.setAgentHandler(async (target) => {
      targets.push(`${target.agentId}:${target.matchedScope}`);
      return undefined;
    });

    await router.connectInstance('bi_tg_ops', { platform: 'telegram', instanceId: 'bi_tg_ops' });
    await adapter.deliver(inbound('telegram'));
    await flush();

    // Before the fix this resolved at `platform` (or `global`): the instance
    // binding could never be reached without an instance id on the message.
    expect(targets).toEqual(['agent-ops:instance']);
  });

  it('routes two bots of one platform to their own instance bindings on a shared channel', async () => {
    const router = new MessageRouter();
    const sales = stubAdapter('telegram');
    const ops = stubAdapter('telegram');
    router.registerAdapter(sales, 'bi_tg_sales');
    router.registerAdapter(ops, 'bi_tg_ops');
    router.setBindingLookup(
      lookupOf([
        { scope: 'instance', instanceId: 'bi_tg_sales', nativeId: null, kind: null, agentId: 'agent-sales' },
        { scope: 'instance', instanceId: 'bi_tg_ops', nativeId: null, kind: null, agentId: 'agent-ops' },
      ]),
    );
    router.setAgentHandler(async (target) => `ack:${target.agentId}`);

    await router.connectInstance('bi_tg_sales', { platform: 'telegram', instanceId: 'bi_tg_sales' });
    await router.connectInstance('bi_tg_ops', { platform: 'telegram', instanceId: 'bi_tg_ops' });

    // Same native channel id, different receiving bot — parity with the Discord
    // case in #375, but without any adapter-side stamping.
    await sales.deliver(inbound('telegram', { channelId: 'SAME' }));
    await ops.deliver(inbound('telegram', { channelId: 'SAME' }));
    await flush();

    expect(sales.sendMessage).toHaveBeenCalledWith('SAME', 'ack:agent-sales', { markdown: true });
    expect(ops.sendMessage).toHaveBeenCalledWith('SAME', 'ack:agent-ops', { markdown: true });
    expect(sales.sendMessage).not.toHaveBeenCalledWith('SAME', 'ack:agent-ops', expect.anything());
  });

  it('keeps the implicit single-bot identity: the platform id, as before', async () => {
    // A platform's only bot is registered under its platform id. Stamping yields
    // the same value the adapters used to fall back to (`?? platform`), so a
    // single-bot setup still resolves at the platform level and the conversation
    // key keeps its `im:<platform>:…` shape.
    const router = new MessageRouter();
    const adapter = stubAdapter('telegram');
    const seen: Array<{ instanceId?: string; key: string; scope: string }> = [];
    router.registerAdapter(adapter);
    router.bindPlatformAgent('agent-legacy', 'telegram');
    router.setAgentHandler(async (target, message) => {
      seen.push({
        instanceId: message.instanceId,
        key: target.conversationKey,
        scope: target.matchedScope,
      });
      return undefined;
    });

    await router.connectAll([{ platform: 'telegram' }]);
    await adapter.deliver(inbound('telegram'));
    await flush();

    expect(seen).toEqual([
      { instanceId: 'telegram', key: 'im:telegram:group:C1', scope: 'platform' },
    ]);
  });
});
