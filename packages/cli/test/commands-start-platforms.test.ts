/**
 * Manifest-driven comms startup — issue #340, slice S2.
 *
 * The startup path must stop branching per platform: it walks `PLATFORM_MANIFESTS`
 * and connects whatever is enabled. Two layers of proof:
 *
 *  1. Unit tests drive `connectConfiguredPlatforms()` with stub manifests, pinning
 *     enablement, config resolution (file + env), failure isolation and runtime
 *     overrides.
 *  2. Integration tests run the real `markus start` command. The `@markus/comms`
 *     mock appends a platform (`fakechat`) that **start.ts has never heard of**;
 *     the assertion that its adapter connects is the invariant "adding a manifest
 *     must not require editing start.ts".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';

import { MessageRouter, PLATFORM_MANIFESTS } from '@markus/comms';
import type { CommAdapter, CommAdapterConfig, PlatformManifest } from '@markus/comms';
import type { MarkusConfig } from '@markus/shared';
import { connectConfiguredPlatforms } from '../src/commands/start.js';

// ── A platform the source code has never heard of ────────────────────────────
const hoisted = vi.hoisted(() => ({ fakeConnects: [] as string[] }));

vi.mock('@markus/comms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@markus/comms')>();
  const fakeManifest: PlatformManifest = {
    id: 'fakechat',
    label: 'Fake Chat',
    fields: [{ key: 'token', label: 'Token', type: 'text', required: true }],
    capabilities: { inbound: true, outbound: true, threads: false },
    createAdapter: () => ({
      platform: 'fakechat',
      connect: async () => {
        hoisted.fakeConnects.push('fakechat');
      },
      disconnect: async () => {},
      sendMessage: async () => 'fakechat-msg',
      sendReply: async () => 'fakechat-msg',
      onMessage: () => {},
      isConnected: () => true,
    }),
  };
  return { ...actual, PLATFORM_MANIFESTS: [...actual.PLATFORM_MANIFESTS, fakeManifest] };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

interface StubAdapter extends CommAdapter {
  connectCalls: CommAdapterConfig[];
}

function stubAdapter(platform: string, opts: { fail?: boolean } = {}): StubAdapter {
  const connectCalls: CommAdapterConfig[] = [];
  return {
    platform,
    connectCalls,
    async connect(config) {
      connectCalls.push(config);
      if (opts.fail) throw new Error('connect failed');
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
      return !opts.fail;
    },
  };
}

function manifest(
  id: string,
  createAdapter: () => CommAdapter,
  extra: Partial<PlatformManifest> = {},
): PlatformManifest {
  return {
    id,
    label: id,
    fields: [],
    capabilities: { inbound: true, outbound: true, threads: false },
    createAdapter,
    ...extra,
  };
}

function makeConfig(integrations?: MarkusConfig['integrations'] & Record<string, unknown>): MarkusConfig {
  return {
    org: { id: 'default', name: 'Test Org' },
    llm: { defaultProvider: 'anthropic', defaultModel: 'test-model', providers: {} },
    ...(integrations ? { integrations } : {}),
  };
}

const FEISHU_FIELDS: PlatformManifest['fields'] = [
  { key: 'appId', label: 'App ID', type: 'text', required: true },
  { key: 'appSecret', label: 'App Secret', type: 'password', required: true, secret: true },
  { key: 'webhookPort', label: 'Webhook port', type: 'number', required: false },
];

describe('connectConfiguredPlatforms (unit)', () => {
  it('always connects a defaultEnabled platform and applies runtime config', async () => {
    const adapter = stubAdapter('webui');
    const webui = manifest('webui', () => adapter, {
      label: 'Web UI',
      defaultEnabled: true,
      fields: [{ key: 'port', label: 'Port', type: 'number', required: false }],
    });

    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [webui],
      config: makeConfig(),
      runtimeConfig: { webui: { port: 9123 } },
    });

    expect(results).toEqual([{ id: 'webui', label: 'Web UI', connected: true }]);
    expect(adapter.connectCalls).toHaveLength(1);
    expect(adapter.connectCalls[0]).toMatchObject({ platform: 'webui', port: 9123 });
  });

  it('skips a platform whose required fields are absent, connects it once configured', async () => {
    const adapter = stubAdapter('feishu');
    const feishu = manifest('feishu', () => adapter, { label: 'Feishu / Lark', fields: FEISHU_FIELDS });

    const skipped = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [feishu],
      config: makeConfig(),
    });
    expect(skipped).toEqual([]);
    expect(adapter.connectCalls).toHaveLength(0);

    const connected = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [feishu],
      config: makeConfig({ feishu: { appId: 'cli_x', appSecret: 's3cret' } }),
    });
    expect(connected).toEqual([{ id: 'feishu', label: 'Feishu / Lark', connected: true }]);
    expect(adapter.connectCalls[0]).toMatchObject({ platform: 'feishu', appId: 'cli_x', appSecret: 's3cret' });
  });

  it('resolves required credentials from the environment (generic <PLATFORM>_<FIELD> naming)', async () => {
    const adapter = stubAdapter('feishu');
    const feishu = manifest('feishu', () => adapter, { label: 'Feishu / Lark', fields: FEISHU_FIELDS });

    process.env.FEISHU_APP_ID = 'env_app';
    process.env.FEISHU_APP_SECRET = 'env_secret';
    process.env.FEISHU_WEBHOOK_PORT = '9555';
    try {
      const results = await connectConfiguredPlatforms({
        router: new MessageRouter(),
        manifests: [feishu],
        config: makeConfig(),
      });
      expect(results).toHaveLength(1);
      expect(adapter.connectCalls[0]).toMatchObject({
        appId: 'env_app',
        appSecret: 'env_secret',
        webhookPort: 9555, // coerced to number by the field type
      });
    } finally {
      delete process.env.FEISHU_APP_ID;
      delete process.env.FEISHU_APP_SECRET;
      delete process.env.FEISHU_WEBHOOK_PORT;
    }
  });

  it('isolates a failing platform — others still connect', async () => {
    const ok = stubAdapter('webui');
    const bad = stubAdapter('feishu', { fail: true });

    const results = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [
        manifest('webui', () => ok, { label: 'Web UI', defaultEnabled: true }),
        manifest('feishu', () => bad, { label: 'Feishu / Lark', fields: FEISHU_FIELDS }),
      ],
      config: makeConfig({ feishu: { appId: 'a', appSecret: 'b' } }),
    });

    expect(results).toEqual([
      { id: 'webui', label: 'Web UI', connected: true },
      { id: 'feishu', label: 'Feishu / Lark', connected: false },
    ]);
  });

  it('keeps an all-optional platform off until something is configured', async () => {
    const adapter = stubAdapter('somechat');
    const somechat = manifest('somechat', () => adapter, {
      label: 'Some Chat',
      fields: [{ key: 'nickname', label: 'Nickname', type: 'text', required: false }],
    });

    const skipped = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [somechat],
      config: makeConfig(),
    });
    expect(skipped).toEqual([]);
    expect(adapter.connectCalls).toHaveLength(0);

    const connected = await connectConfiguredPlatforms({
      router: new MessageRouter(),
      manifests: [somechat],
      config: makeConfig({ somechat: { nickname: 'x' } }),
    });
    expect(connected).toEqual([{ id: 'somechat', label: 'Some Chat', connected: true }]);
  });

  it('connects a brand-new manifest added to the list — no start.ts branch required', async () => {
    const adapter = stubAdapter('newchat');
    const newManifest = manifest('newchat', () => adapter, {
      label: 'New Chat',
      fields: [{ key: 'token', label: 'Token', type: 'text', required: true }],
    });

    // Iterating the real registry plus one entry the source code never mentions.
    const router = new MessageRouter();
    const results = await connectConfiguredPlatforms({
      router,
      manifests: [...PLATFORM_MANIFESTS, newManifest],
      config: makeConfig({ newchat: { token: 't' } }),
    });
    await router.disconnectAll();

    expect(results.find((r) => r.id === 'newchat')).toEqual({
      id: 'newchat',
      label: 'New Chat',
      connected: true,
    });
  });
});

// ── Integration: the real start command ──────────────────────────────────────

vi.mock('../src/utils/browser.js', () => ({ openBrowserAfterHealthCheck: vi.fn() }));

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('markus start — manifest-driven gateway (integration)', () => {
  let tmpHome: string;
  let configPath: string;
  let apiPort: number;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  const originalHome = process.env.HOME;
  const originalFeishuId = process.env.FEISHU_APP_ID;
  const originalFeishuSecret = process.env.FEISHU_APP_SECRET;

  beforeEach(async () => {
    apiPort = await getFreePort();
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-start-platforms-'));
    process.env.HOME = tmpHome;
    mkdirSync(join(tmpHome, '.markus'), { recursive: true });
    configPath = join(tmpHome, '.markus', 'markus.json');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    hoisted.fakeConnects.length = 0;
    process.env.ANTHROPIC_API_KEY = 'sk-testkey1234567890';
  });

  afterEach(async () => {
    logSpy.mockRestore();
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env.HOME = originalHome;
    if (originalFeishuId) process.env.FEISHU_APP_ID = originalFeishuId;
    else delete process.env.FEISHU_APP_ID;
    if (originalFeishuSecret) process.env.FEISHU_APP_SECRET = originalFeishuSecret;
    else delete process.env.FEISHU_APP_SECRET;
    rmSync(tmpHome, { recursive: true, force: true });
    const { setSuppressConsole } = await import('../src/utils/logger.js');
    setSuppressConsole(false);
  });

  async function runStart(integrations?: Record<string, unknown>): Promise<{ log: string; out: string }> {
    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          providers: { anthropic: { apiKey: 'sk-testkey1234567890', enabled: true } },
        },
        server: { apiPort, webPort: apiPort + 1 },
        ...(integrations ? { integrations } : {}),
      }),
    );

    vi.resetModules();
    const shared = await import('@markus/shared');
    vi.spyOn(shared, 'getDefaultConfigPath').mockReturnValue(configPath);
    vi.spyOn(shared, 'checkForUpdate').mockResolvedValue({
      updateAvailable: false,
      currentVersion: '0.0.0',
      latestVersion: '0.0.0',
    });

    const { registerStartCommand } = await import('../src/commands/start.js');
    const program = new Command();
    program.option('--port <number>', 'API port');
    program.option('--config <path>', 'Config path');
    program.exitOverride();
    registerStartCommand(program);
    await program.parseAsync(['node', 'markus', 'start']);

    return {
      log: logSpy.mock.calls.map((c) => String(c[0])).join('\n'),
      out: writeSpy.mock.calls.map((c) => String(c[0])).join('\n'),
    };
  }

  it('(b) connects nothing when no external platform is configured', async () => {
    const { log, out } = await runStart();
    expect(log).not.toMatch(/Feishu/);
    expect(out).toMatch(/webhook adapters: none\b/);
    expect(hoisted.fakeConnects).toEqual([]);
  }, 60000);

  it('(a) connects Feishu as well when its credentials are configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
      }),
    );

    // A dev server on this machine may already own the default Feishu webhook
    // port (9000), so pin a free one to keep the assertion deterministic.
    const { log, out } = await runStart({
      feishu: { appId: 'cli_test', appSecret: 'secret', webhookPort: await getFreePort() },
    });

    expect(log).toMatch(/Feishu \/ Lark .*已连接/);
    expect(out).toMatch(/webhook adapters: Feishu \/ Lark/);
  }, 60000);

  it('(c) revives a manifest the source code has never heard of — no start.ts edit', async () => {
    await runStart({ fakechat: { token: 'tok' } });

    expect(hoisted.fakeConnects).toEqual(['fakechat']);
  }, 60000);
});

/**
 * Issue #340, defect A: `MessageRouter.bindAgentToChannel` used to be dead code
 * (zero call sites), so every inbound landed with an empty `agentId` and was
 * dropped. `applyPersistedPlatformBindings` is now the single hook that reads the
 * persisted bindings and applies them to the router at startup.
 */
describe('applyPersistedPlatformBindings (S6)', () => {
  it('applies the persisted platform→agent binding to the router', async () => {
    const { applyPersistedPlatformBindings } = await import('../src/commands/start.js');
    const router = new MessageRouter();
    const repo = {
      listByPlatform: (orgId: string, platform: string) =>
        orgId === 'default' && platform === 'feishu'
          ? [
              {
                id: 'feishu_default',
                orgId,
                platform,
                config: { appId: 'cli_x', appSecret: 'sec', agentId: 'agt_secretary' },
              },
            ]
          : [],
    };

    const count = applyPersistedPlatformBindings({
      router,
      repo: repo as never,
      orgId: 'default',
    });

    expect(count).toBe(1);
    expect(router.getBindings()).toEqual({
      platforms: { feishu: 'agt_secretary' },
      channels: {},
    });
  });

  it('applies a legacy markus.json binding when the database has none', async () => {
    const { applyPersistedPlatformBindings } = await import('../src/commands/start.js');
    const router = new MessageRouter();

    const count = applyPersistedPlatformBindings({
      router,
      repo: { listByPlatform: () => [] } as never,
      orgId: 'default',
      bootstrap: (platform) => (platform === 'feishu' ? { appId: 'a', appSecret: 's', agentId: 'legacy' } : {}),
    });

    expect(count).toBe(1);
    expect(router.getBindings().platforms['feishu']).toBe('legacy');
  });

  it('is a quiet no-op when nothing is bound', async () => {
    const { applyPersistedPlatformBindings } = await import('../src/commands/start.js');
    const router = new MessageRouter();

    const count = applyPersistedPlatformBindings({
      router,
      repo: { listByPlatform: () => [] } as never,
      orgId: 'default',
    });

    expect(count).toBe(0);
    expect(router.getBindings()).toEqual({ platforms: {}, channels: {} });
  });
});
