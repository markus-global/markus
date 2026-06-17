import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { quickInit } from '../src/commands/init.js';
import * as shared from '@markus/shared';

describe('quickInit', () => {
  let tmpHome: string;
  let configPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalHome = process.env.HOME;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalOpenaiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-init-'));
    process.env.HOME = tmpHome;
    configPath = join(tmpHome, '.markus', 'markus.json');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(shared, 'getDefaultConfigPath').mockReturnValue(configPath);
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    if (originalAnthropicKey) process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalOpenaiKey) process.env.OPENAI_API_KEY = originalOpenaiKey;
    else delete process.env.OPENAI_API_KEY;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('non-interactive manual mode saves provider config', async () => {
    await quickInit({
      nonInteractive: true,
      provider: 'openai',
      apiKey: 'sk-testkey1234567890',
      port: '9000',
      force: true,
    });

    expect(existsSync(configPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.defaultProvider).toBe('openai');
    expect(cfg.llm.providers.openai.apiKey).toBe('sk-testkey1234567890');
    expect(cfg.server.apiPort).toBe(9000);

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Setup Complete');
  });

  it('non-interactive exits when config exists without --force', async () => {
    mkdirSync(join(tmpHome, '.markus'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ org: { id: 'default' } }));

    await quickInit({ nonInteractive: true });
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('--force');
  });

  it('imports from environment variables in non-interactive mode', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-envkey1234567890';

    await quickInit({ nonInteractive: true, force: true });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.providers.anthropic.apiKey).toBe('sk-envkey1234567890');
    expect(cfg.llm.defaultProvider).toBe('anthropic');
  });

  it('supports ollama without api key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    await quickInit({
      nonInteractive: true,
      provider: 'ollama',
      force: true,
    });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.providers.ollama).toBeDefined();
    expect(cfg.llm.providers.ollama.enabled).toBe(true);
  });

  it('warns when no api key in manual non-interactive mode', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    await quickInit({
      nonInteractive: true,
      provider: 'anthropic',
      force: true,
    });
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('No API key');
  });

  it('registers init command with expected options', async () => {
    const { registerInitCommand } = await import('../src/commands/init.js');
    const { Command } = await import('commander');
    const program = new Command();
    registerInitCommand(program);
    const initCmd = program.commands.find(c => c.name() === 'init');
    expect(initCmd?.options.some(o => o.long === '--force')).toBe(true);
    expect(initCmd?.options.some(o => o.long === '--non-interactive')).toBe(true);
    expect(initCmd?.options.some(o => o.long === '--provider')).toBe(true);
  });

  it('non-interactive google provider saves config', async () => {
    await quickInit({
      nonInteractive: true,
      provider: 'google',
      apiKey: 'google-key1234567890',
      force: true,
    });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.providers.google.apiKey).toBe('google-key1234567890');
    expect(cfg.llm.defaultProvider).toBe('google');
  });

  it('creates default developer role template', async () => {
    await quickInit({
      nonInteractive: true,
      provider: 'openai',
      apiKey: 'sk-testkey1234567890',
      force: true,
    });
    const rolePath = join(tmpHome, '.markus', 'templates', 'roles', 'developer', 'ROLE.md');
    expect(existsSync(rolePath)).toBe(true);
  });

  it('non-interactive deepseek provider saves config', async () => {
    await quickInit({
      nonInteractive: true,
      provider: 'deepseek',
      apiKey: 'sk-deepseek1234567890',
      force: true,
    });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.providers.deepseek.apiKey).toBe('sk-deepseek1234567890');
    expect(cfg.llm.defaultProvider).toBe('deepseek');
  });

  it('non-interactive siliconflow provider saves config', async () => {
    await quickInit({
      nonInteractive: true,
      provider: 'siliconflow',
      apiKey: 'sf-key1234567890123456',
      force: true,
    });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.providers.siliconflow.apiKey).toBe('sf-key1234567890123456');
  });

  it('non-interactive openrouter provider saves config', async () => {
    await quickInit({
      nonInteractive: true,
      provider: 'openrouter',
      apiKey: 'or-key1234567890123456',
      force: true,
    });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.providers.openrouter.apiKey).toBe('or-key1234567890123456');
  });

  it('non-interactive zai provider saves config', async () => {
    await quickInit({
      nonInteractive: true,
      provider: 'zai',
      apiKey: 'zai-key1234567890123',
      force: true,
    });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.providers.zai.apiKey).toBe('zai-key1234567890123');
  });

  it('imports from openclaw config when present', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const openclawDir = join(tmpHome, '.openclaw');
    mkdirSync(openclawDir, { recursive: true });
    writeFileSync(
      join(openclawDir, 'openclaw.json'),
      JSON.stringify({
        models: {
          providers: {
            openai: { baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
          },
        },
      }),
    );

    await quickInit({ nonInteractive: true, importFrom: 'openclaw', force: true });
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/OpenClaw|Found .* provider/);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(Object.keys(cfg.llm.providers).length).toBeGreaterThan(0);
  });

  it('non-interactive minimax provider sets custom baseUrl', async () => {
    await quickInit({
      nonInteractive: true,
      provider: 'minimax',
      apiKey: 'minimax-key1234567890',
      force: true,
    });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.providers.minimax.baseUrl).toBe('https://api.minimax.io/v1');
    expect(cfg.llm.defaultProvider).toBe('minimax');
  });

  it('non-interactive mode uses importFrom when specified', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const openclawDir = join(tmpHome, '.openclaw');
    mkdirSync(openclawDir, { recursive: true });
    writeFileSync(
      join(openclawDir, 'openclaw.json'),
      JSON.stringify({
        models: {
          providers: {
            anthropic: { apiKey: 'sk-imported1234567890', models: [{ id: 'claude-sonnet-4-20250514', name: 'Sonnet' }] },
          },
        },
      }),
    );

    await quickInit({ nonInteractive: true, importFrom: 'openclaw', force: true });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.providers.anthropic).toBeDefined();
  });

  it('warns when non-interactive manual mode has no api key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    await quickInit({
      nonInteractive: true,
      provider: 'anthropic',
      force: true,
    });

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('No API key');
  });

  it('shows detected platforms hint after setup', async () => {
    const openclawDir = join(tmpHome, '.openclaw');
    mkdirSync(openclawDir, { recursive: true });
    writeFileSync(join(openclawDir, 'openclaw.json'), JSON.stringify({ models: { providers: {} } }));

    await quickInit({
      nonInteractive: true,
      provider: 'openai',
      apiKey: 'sk-testkey1234567890',
      force: true,
    });

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/Setup Complete|Detected external agent platforms|OpenClaw/i);
  });
});
