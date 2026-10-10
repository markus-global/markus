/**
 * Slice G2 — startup iterates bot instances, not platforms.
 *
 * `connectConfiguredPlatforms` must build one adapter per persisted
 * `platform_instances` row (each with its own credentials), fall back to the
 * legacy platform path only when a platform has no instance row, and keep the
 * pre-G2 identity (instance id = platform id) for that implicit bot.
 */
import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '@markus/comms';
import type { CommAdapter, CommAdapterConfig, PlatformManifest } from '@markus/comms';
import type { MarkusConfig } from '@markus/shared';
import { connectConfiguredPlatforms } from '../src/commands/start.js';

interface CreatedAdapter {
  calls: CommAdapterConfig[];
  adapter: CommAdapter;
}

/** A manifest whose factory returns a fresh adapter each call, recording connect configs. */
function telegramManifest(created: CreatedAdapter[]): PlatformManifest {
  return {
    id: 'telegram',
    label: 'Telegram',
    fields: [{ key: 'botToken', label: 'Bot Token', type: 'password', required: true, secret: true }],
    capabilities: { inbound: true, outbound: true, threads: true },
    createAdapter: () => {
      const rec: CreatedAdapter = { calls: [], adapter: undefined as unknown as CommAdapter };
      rec.adapter = {
        platform: 'telegram',
        async connect(config) {
          rec.calls.push(config);
        },
        async disconnect() {},
        async sendMessage() {
          return 'msg-id';
        },
        async sendReply() {
          return 'msg-id';
        },
        onMessage() {},
        isConnected() {
          return true;
        },
      };
      created.push(rec);
      return rec.adapter;
    },
  };
}

function makeConfig(integrations?: MarkusConfig['integrations'] & Record<string, unknown>): MarkusConfig {
  return {
    org: { id: 'default', name: 'Test Org' },
    llm: { defaultProvider: 'anthropic', defaultModel: 'test-model', providers: {} },
    ...(integrations ? { integrations } : {}),
  };
}

describe('connectConfiguredPlatforms — bot instances (G2)', () => {
  it('connects two instances of the same platform, each with its own credentials', async () => {
    const created: CreatedAdapter[] = [];
    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [telegramManifest(created)],
      config: makeConfig(),
      instances: [
        { id: 'bi_tg_sales', platform: 'telegram', label: 'sales-bot', config: { botToken: 'SALES' }, enabled: true },
        { id: 'bi_tg_ops', platform: 'telegram', label: 'ops-bot', config: { botToken: 'OPS' }, enabled: true },
      ],
    });

    expect(created).toHaveLength(2);
    expect(created[0].calls[0]).toMatchObject({ platform: 'telegram', botToken: 'SALES' });
    expect(created[1].calls[0]).toMatchObject({ platform: 'telegram', botToken: 'OPS' });
    expect(results).toEqual([
      { id: 'bi_tg_sales', label: 'Telegram (sales-bot)', connected: true },
      { id: 'bi_tg_ops', label: 'Telegram (ops-bot)', connected: true },
    ]);
  });

  it('skips a disabled instance', async () => {
    const created: CreatedAdapter[] = [];
    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [telegramManifest(created)],
      config: makeConfig(),
      instances: [
        { id: 'bi_a', platform: 'telegram', label: 'a', config: { botToken: 'A' }, enabled: true },
        { id: 'bi_b', platform: 'telegram', label: 'b', config: { botToken: 'B' }, enabled: false },
      ],
    });

    expect(created).toHaveLength(1);
    expect(results).toEqual([{ id: 'bi_a', label: 'Telegram (a)', connected: true }]);
  });

  it('falls back to the legacy path (instance id = platform) when there is no instance row', async () => {
    const created: CreatedAdapter[] = [];
    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [telegramManifest(created)],
      config: makeConfig({ telegram: { botToken: 'LEGACY' } }),
    });

    expect(results).toEqual([{ id: 'telegram', label: 'Telegram', connected: true }]);
    expect(created[0].calls[0]).toMatchObject({ platform: 'telegram', botToken: 'LEGACY' });
  });

  it('prefers instance rows over the legacy fallback for the same platform (dual read)', async () => {
    const created: CreatedAdapter[] = [];
    const storedConfig = vi.fn(() => ({ values: { botToken: 'LEGACY' }, enabled: true }));
    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [telegramManifest(created)],
      config: makeConfig(),
      instances: [{ id: 'bi_new', platform: 'telegram', label: 'new-bot', config: { botToken: 'NEW' }, enabled: true }],
      storedConfig,
    });

    expect(results).toEqual([{ id: 'bi_new', label: 'Telegram (new-bot)', connected: true }]);
    expect(created[0].calls[0]).toMatchObject({ botToken: 'NEW' });
    // The legacy source is not even consulted once a platform has an instance row.
    expect(storedConfig).not.toHaveBeenCalled();
  });
});
