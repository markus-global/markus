/**
 * Manifest-driven startup — slice S5 (issue #340).
 *
 * S5 declares the revived platforms in the registry; S2's traversal then has to
 * pick them up. This file proves the *end-to-end* promise for a revived platform:
 *
 *   configured (config file OR settings store)
 *     → adapter registered on the router
 *     → connected
 *     → an inbound message is routed to the bound agent
 *
 * The registry/stub layers are real (real `MessageRouter`, real `TelegramAdapter`
 * where noted); only the network is mocked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { MessageRouter, getManifest } from '@markus/comms';
import type { CommAdapter, PlatformManifest } from '@markus/comms';
import type { MarkusConfig } from '@markus/shared';
import { connectConfiguredPlatforms } from '../src/commands/start.js';

function cfg(integrations: Record<string, unknown>): MarkusConfig {
  return { integrations } as unknown as MarkusConfig;
}

/** A fetch stub that satisfies Telegram's `getMe` and `sendMessage` calls. */
function telegramFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: 1, username: 'bot', first_name: 'Bot' } }),
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('startup — a revived platform becomes reachable', () => {
  it('connects Telegram from the config file (real manifest + real adapter)', async () => {
    vi.stubGlobal('fetch', telegramFetch());
    const router = new MessageRouter();

    const results = await connectConfiguredPlatforms({
      router,
      manifests: [getManifest('telegram')!],
      config: cfg({ telegram: { botToken: 'tok' } }),
    });

    expect(results).toEqual([{ id: 'telegram', label: 'Telegram', connected: true }]);
    // Registration is observable: the router can now send through the platform.
    expect(await router.sendToChannel('telegram', 'chat-1', 'hi')).toBeTruthy();
  });

  it('does not touch Telegram when it is not configured', async () => {
    const fetchMock = telegramFetch();
    vi.stubGlobal('fetch', fetchMock);

    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [getManifest('telegram')!],
      config: cfg({}),
    });

    expect(results).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('startup — the settings store is a first-class source', () => {
  it('connects a platform whose credentials live only in the settings store', async () => {
    vi.stubGlobal('fetch', telegramFetch());

    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [getManifest('telegram')!],
      config: cfg({}), // nothing in markus.json
      storedConfig: (id) => (id === 'telegram' ? { values: { botToken: 'from-db' }, enabled: true } : undefined),
    });

    expect(results[0]).toMatchObject({ id: 'telegram', connected: true });
  });

  it('lets the stored value win over the file (the Settings API is the writer)', async () => {
    const fetchMock = telegramFetch();
    vi.stubGlobal('fetch', fetchMock);

    await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [getManifest('telegram')!],
      config: cfg({ telegram: { botToken: 'from-file' } }),
      storedConfig: () => ({ values: { botToken: 'from-db' }, enabled: true }),
    });

    expect(String(fetchMock.mock.calls[0]![0])).toContain('/botfrom-db/getMe');
  });

  it('honours the stored `enabled: false` toggle even when credentials exist', async () => {
    const fetchMock = telegramFetch();
    vi.stubGlobal('fetch', fetchMock);

    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [getManifest('telegram')!],
      config: cfg({ telegram: { botToken: 'tok' } }),
      storedConfig: () => ({ values: { botToken: 'tok' }, enabled: false }),
    });

    expect(results).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('startup — inbound routing to the bound agent (end to end)', () => {
  it('routes an inbound message from a configured platform to its bound agent', async () => {
    let deliver: ((m: unknown) => void) | undefined;
    const adapter: CommAdapter = {
      platform: 'loopback',
      connect: async () => {},
      disconnect: async () => {},
      sendMessage: async () => 'sent',
      sendReply: async () => 'sent',
      onMessage: (handler) => {
        deliver = handler as (m: unknown) => void;
      },
      isConnected: () => true,
    };
    const manifest: PlatformManifest = {
      id: 'loopback',
      label: 'Loopback',
      fields: [{ key: 'token', label: 'Token', type: 'text', required: true }],
      capabilities: { inbound: true, outbound: true, threads: false },
      createAdapter: () => adapter,
    };

    const router = new MessageRouter();
    const received: Array<{ agentId: string; conversationKey: string; matchedScope: string; text: string }> = [];
    router.setAgentHandler(async (target, message) => {
      received.push({
        agentId: target.agentId,
        conversationKey: target.conversationKey,
        matchedScope: target.matchedScope,
        text: message.content?.text ?? '',
      });
      return undefined;
    });
    router.bindAgentToChannel('agent-7', 'loopback', 'chan-9');

    const results = await connectConfiguredPlatforms({
      router,
      manifests: [manifest],
      config: cfg({ loopback: { token: 't' } }),
    });
    expect(results[0]).toMatchObject({ id: 'loopback', connected: true });

    // Simulate an inbound message arriving on the platform's bound channel.
    deliver!({ platform: 'loopback', channelId: 'chan-9', content: { text: 'hello' } });
    await new Promise((r) => setTimeout(r, 0));

    // The handler now receives the resolved target — agent *and* conversation
    // identity — not a bare agent id (G3). The explicit channel binding wins and
    // names the conversation; with no instance on the message the key is
    // instance-less.
    expect(received).toEqual([
      {
        agentId: 'agent-7',
        conversationKey: 'im::group:chan-9',
        matchedScope: 'channel',
        text: 'hello',
      },
    ]);
  });
});
