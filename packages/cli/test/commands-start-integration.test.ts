import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';

vi.mock('../src/utils/browser.js', () => ({
  openBrowserAfterHealthCheck: vi.fn(),
}));

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('start command integration', () => {
  let tmpHome: string;
  let configPath: string;
  let apiPort: number;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  const originalHome = process.env.HOME;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    apiPort = await getFreePort();
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-start-'));
    process.env.HOME = tmpHome;
    mkdirSync(join(tmpHome, '.markus'), { recursive: true });
    configPath = join(tmpHome, '.markus', 'markus.json');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          providers: {
            anthropic: {
              apiKey: 'sk-testkey1234567890',
              model: 'claude-sonnet-4-20250514',
              enabled: true,
            },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
      }),
    );

    process.env.ANTHROPIC_API_KEY = 'sk-testkey1234567890';

    const shared = await import('@markus/shared');
    vi.spyOn(shared, 'getDefaultConfigPath').mockReturnValue(configPath);
    vi.spyOn(shared, 'checkForUpdate').mockResolvedValue({
      updateAvailable: false,
      currentVersion: '0.0.0',
      latestVersion: '0.0.0',
    });
  });

  afterEach(async () => {
    logSpy.mockRestore();
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    if (originalAnthropicKey) process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    else delete process.env.ANTHROPIC_API_KEY;
    rmSync(tmpHome, { recursive: true, force: true });
    const { setSuppressConsole } = await import('../src/utils/logger.js');
    setSuppressConsole(false);
  });

  async function runStart(args: string[] = [], globalArgs: string[] = []): Promise<void> {
    vi.resetModules();
    const { registerStartCommand } = await import('../src/commands/start.js');
    const program = new Command();
    program.option('--port <number>', 'API port');
    program.option('--config <path>', 'Config path');
    program.exitOverride();
    registerStartCommand(program);
    await program.parseAsync(['node', 'markus', ...globalArgs, 'start', ...args]);
  }

  it('boots server with existing config and exits under vitest', async () => {
    await runStart();
    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/running/i);
    expect(existsSync(configPath)).toBe(true);
  }, 60000);

  it('auto-runs quickInit when config is missing', async () => {
    rmSync(configPath);
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-openaikey123456789';

    await runStart();

    expect(existsSync(configPath)).toBe(true);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/No configuration found|auto-configuring/i);
    delete process.env.OPENAI_API_KEY;
  }, 60000);

  it('forces setup wizard with --setup flag', async () => {
    await runStart(['--setup']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/Existing configuration found|--force/i);
  }, 60000);

  it('warns and auto-inits when no valid LLM key in config', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          providers: {
            anthropic: { apiKey: 'test-key', enabled: true },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
      }),
    );
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-openaikey123456789';

    await runStart();

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/LLM Providers|running/i);
    delete process.env.OPENAI_API_KEY;
  }, 60000);

  it('reports update available when newer version exists', async () => {
    vi.resetModules();
    const shared = await import('@markus/shared');
    vi.spyOn(shared, 'getDefaultConfigPath').mockReturnValue(configPath);
    vi.spyOn(shared, 'checkForUpdate').mockResolvedValue({
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
    });

    const { registerStartCommand } = await import('../src/commands/start.js');
    const program = new Command();
    program.exitOverride();
    registerStartCommand(program);
    await program.parseAsync(['node', 'markus', 'start']);
    await new Promise(r => setTimeout(r, 200));

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/New version available|2\.0\.0/);
  }, 60000);

  it('propagates search API keys into environment', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'anthropic',
          providers: {
            anthropic: { apiKey: 'sk-testkey1234567890', enabled: true },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
        integrations: {
          search: {
            serperApiKey: 'serper-key',
            tavilyApiKey: 'tavily-key',
            braveApiKey: 'brave-key',
          },
        },
      }),
    );

    delete process.env.SERPER_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;

    await runStart();

    expect(process.env.SERPER_API_KEY).toBe('serper-key');
    expect(process.env.TAVILY_API_KEY).toBe('tavily-key');
    expect(process.env.BRAVE_SEARCH_API_KEY).toBe('brave-key');
  }, 60000);

  it('propagates admin password from security config', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'anthropic',
          providers: {
            anthropic: { apiKey: 'sk-testkey1234567890', enabled: true },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
        security: { adminPassword: 'secret-admin-pass' },
      }),
    );
    delete process.env.ADMIN_PASSWORD;

    await runStart();

    expect(process.env.ADMIN_PASSWORD).toBe('secret-admin-pass');
  }, 60000);

  it('continues when feishu adapter connection fails', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'anthropic',
          providers: {
            anthropic: { apiKey: 'sk-testkey1234567890', enabled: true },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
        integrations: {
          feishu: { appId: 'bad_app', appSecret: 'bad_secret' },
        },
      }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ code: 99991663, msg: 'invalid app' }),
      }),
    );

    await runStart();

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/running|WebUI/i);
    vi.unstubAllGlobals();
  }, 60000);

  it('connects feishu adapter when configured', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          providers: {
            anthropic: {
              apiKey: 'sk-testkey1234567890',
              model: 'claude-sonnet-4-20250514',
              enabled: true,
            },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
        integrations: {
          feishu: { appId: 'cli_test', appSecret: 'secret' },
        },
      }),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.includes('tenant_access_token') || u.includes('auth/v3')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        });
      }
      return originalFetch(url as RequestInfo);
    }) as typeof fetch;

    await runStart();

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/running|Feishu|Gateway/i);
    globalThis.fetch = originalFetch;
  }, 60000);

  it('boots with agent cognitive and browser config', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'anthropic',
          autoFallback: false,
          providers: {
            anthropic: { apiKey: 'sk-testkey1234567890', enabled: true },
            openai: { apiKey: 'sk-openai12345678901', enabled: false },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
        agent: {
          maxToolIterations: 25,
          cognitive: { enabled: true, maxDepth: 2, timeoutMs: 10000 },
        },
        browser: {
          bringToFront: true,
          autoCloseTabs: false,
          remoteDebuggingPort: 9222,
          autoClickAllowDialog: true,
        },
      }),
    );

    await runStart();

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/running/i);
  }, 60000);

  it('boots with alternate LLM providers from config and env', async () => {
    process.env.SILICONFLOW_API_KEY = 'sf-key1234567890123456';
    process.env.DEEPSEEK_API_KEY = 'ds-key1234567890123456';
    process.env.OPENROUTER_API_KEY = 'or-key1234567890123456';

    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'siliconflow',
          capabilityRouting: { coding: 'deepseek' },
          routingDefaultModel: 'Qwen/Qwen3.5-35B-A3B',
          customModels: {
            siliconflow: [{ id: 'custom-model', name: 'Custom' }],
          },
          providers: {
            anthropic: { apiKey: 'sk-testkey1234567890', enabled: false },
            siliconflow: { enabled: true },
            'siliconflow-intl': { apiKey: 'sf-intl-key1234567890', enabled: true },
            minimax: { apiKey: 'mm-key1234567890123456', enabled: true },
            'minimax-cn': { apiKey: 'mm-cn-key123456789012', enabled: true },
            openrouter: { enabled: true },
            zai: { apiKey: 'zai-key1234567890123', enabled: true },
            deepseek: { enabled: true },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
        hub: { url: 'https://hub.example.com' },
        security: { gatewaySecret: 'custom-gateway-secret' },
        fileStorage: { local: { dir: join(tmpHome, 'uploads') } },
        mcpServers: { test: { command: 'echo', args: ['mcp'] } },
      }),
    );

    await runStart([], ['--port', String(apiPort + 10)]);

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/running/i);

    delete process.env.SILICONFLOW_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  }, 60000);

  it('propagates remaining search API keys into environment', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'anthropic',
          providers: {
            anthropic: { apiKey: 'sk-testkey1234567890', enabled: true },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
        integrations: {
          search: {
            bingApiKey: 'bing-key',
            googleSearchApiKey: 'google-key',
            googleSearchCx: 'cx-123',
            serpApiKey: 'serp-key',
            exaApiKey: 'exa-key',
            bochaApiKey: 'bocha-key',
          },
        },
      }),
    );

    for (const key of [
      'BING_SEARCH_API_KEY',
      'GOOGLE_SEARCH_API_KEY',
      'GOOGLE_SEARCH_CX',
      'SERPAPI_API_KEY',
      'EXA_API_KEY',
      'BOCHA_API_KEY',
    ]) {
      delete process.env[key];
    }

    await runStart();

    expect(process.env.BING_SEARCH_API_KEY).toBe('bing-key');
    expect(process.env.GOOGLE_SEARCH_API_KEY).toBe('google-key');
    expect(process.env.GOOGLE_SEARCH_CX).toBe('cx-123');
    expect(process.env.SERPAPI_API_KEY).toBe('serp-key');
    expect(process.env.EXA_API_KEY).toBe('exa-key');
    expect(process.env.BOCHA_API_KEY).toBe('bocha-key');
  }, 60000);

  it('starts without feishu when credentials are missing', async () => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;

    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'anthropic',
          providers: {
            anthropic: { apiKey: 'sk-testkey1234567890', enabled: true },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
      }),
    );

    await runStart();

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/running|WebUI/i);
  }, 60000);

  it('boots with explicit database url', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'anthropic',
          providers: {
            anthropic: { apiKey: 'sk-testkey1234567890', enabled: true },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
        database: { url: `file:${join(tmpHome, 'custom.db')}` },
      }),
    );

    await runStart();

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/running/i);
  }, 60000);

  it('boots with google and ollama providers from environment', async () => {
    process.env.GOOGLE_API_KEY = 'google-key1234567890';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'google',
          providers: {
            google: { enabled: true },
            ollama: { baseUrl: 'http://127.0.0.1:11434', enabled: true },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
      }),
    );

    await runStart();

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/running/i);

    delete process.env.GOOGLE_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
  }, 60000);

  it('boots with remote access when hub token is present', async () => {
    writeFileSync(join(tmpHome, '.markus', 'hub-token'), 'hub-token-test-value');
    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: {
          defaultProvider: 'anthropic',
          providers: {
            anthropic: { apiKey: 'sk-testkey1234567890', enabled: true },
          },
        },
        server: { apiPort, webPort: apiPort + 1 },
        remote: { enabled: true, autoConnect: false },
      }),
    );

    await runStart();

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/running/i);
  }, 60000);
});
