import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, type MarkusConfig } from '@markus/shared';
import { createServices } from '../src/commands/start.js';

describe('createServices', () => {
  let tmpHome: string;
  let configPath: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-start-services-'));
    process.env.HOME = tmpHome;
    mkdirSync(join(tmpHome, '.markus'), { recursive: true });
    configPath = join(tmpHome, '.markus', 'markus.json');
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeConfig(cfg: Partial<MarkusConfig> & Record<string, unknown>): void {
    writeFileSync(
      configPath,
      JSON.stringify({
        org: { id: 'default', name: 'Test Org' },
        llm: { defaultProvider: 'anthropic', providers: {} },
        server: { apiPort: 8056, webPort: 8057 },
        ...cfg,
      }),
    );
  }

  it('builds services with multiple LLM providers from config and env', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic1234567890';
    process.env.OPENAI_API_KEY = 'sk-openai12345678901';
    process.env.SILICONFLOW_API_KEY = 'sf-key1234567890123456';
    process.env.DEEPSEEK_API_KEY = 'ds-key1234567890123456';
    process.env.OPENROUTER_API_KEY = 'or-key1234567890123456';
    process.env.ZAI_API_KEY = 'zai-key1234567890123';
    process.env.MINIMAX_API_KEY = 'mm-key1234567890123456';
    process.env.MINIMAX_CN_API_KEY = 'mm-cn-key123456789012';

    writeConfig({
      llm: {
        defaultProvider: 'openrouter',
        autoFallback: false,
        capabilityRouting: { coding: 'deepseek' },
        routingDefaultModel: 'deepseek-v4-flash',
        customModels: {
          openrouter: [{ id: 'custom/router-model', name: 'Router Custom' }],
        },
        providers: {
          anthropic: { model: 'claude-sonnet-4-20250514', enabled: true },
          openai: { enabled: true },
          siliconflow: { enabled: true },
          'siliconflow-intl': { apiKey: 'sf-intl-key1234567890', enabled: true },
          minimax: { enabled: true },
          'minimax-cn': { enabled: true },
          openrouter: { enabled: true },
          zai: { enabled: true },
          deepseek: { enabled: true },
        },
      },
      agent: {
        maxToolIterations: 30,
        cognitive: { enabled: true, maxDepth: 3, timeoutMs: 5000 },
      },
      browser: {
        bringToFront: false,
        autoCloseTabs: true,
        remoteDebuggingPort: 9333,
        autoClickAllowDialog: true,
        extensionBridgePort: 9334,
      },
      mcpServers: { echo: { command: 'echo', args: ['hello'] } },
    });

    const config = loadConfig(configPath);
    const services = await createServices(config);

    expect(services.llmRouter).toBeDefined();
    expect(services.agentManager).toBeDefined();
    expect(services.taskService).toBeDefined();
    expect(services.orgService).toBeDefined();
    expect(services.agentManager.maxToolIterations).toBe(30);
    expect(services.agentManager.cognitiveConfig?.enabled).toBe(true);

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ZAI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_CN_API_KEY;
  }, 60000);

  it('falls back to first available provider when default has no key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-openai12345678901';

    writeConfig({
      llm: {
        defaultProvider: 'anthropic',
        providers: {
          openai: { enabled: true },
        },
      },
    });

    const config = loadConfig(configPath);
    const services = await createServices(config);
    expect(services.llmRouter).toBeDefined();

    delete process.env.OPENAI_API_KEY;
  }, 60000);
});
