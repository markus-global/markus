import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerAuthCommand } from '../src/commands/auth.js';
import * as shared from '@markus/shared';

describe('auth command', () => {
  let tmpDir: string;
  let configPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'markus-auth-cmd-'));
    configPath = join(tmpDir, 'markus.json');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const origLoad = shared.loadConfig;
    const origSave = shared.saveConfig;
    vi.spyOn(shared, 'loadConfig').mockImplementation(() => origLoad(configPath));
    vi.spyOn(shared, 'saveConfig').mockImplementation((cfg, path) =>
      origSave(cfg, path ?? configPath),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({}),
      }),
    );
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runAuth(args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerAuthCommand(program);
    return program.parseAsync(['node', 'markus', 'auth', ...args]);
  }

  it('list shows credential pool header', async () => {
    await runAuth(['list']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Credential Pool');
  });

  it('list shows configured providers with masked keys', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          defaultProvider: 'openai',
          providers: {
            openai: { apiKey: 'sk-realkey1234567890', model: 'gpt-4o-mini' },
          },
        },
      }),
    );
    await runAuth(['list']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('OpenAI');
    expect(output).toContain('sk-r');
    expect(output).toContain('****');
  });

  it('add rejects unknown provider', async () => {
    await runAuth(['add', 'invalid-provider', '--key', 'sk-testkey1234567890', '--no-validate']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Unknown provider');
    expect(output).toContain('Available:');
  });

  it('add saves valid provider key with --no-validate', async () => {
    await runAuth([
      'add',
      'openai',
      '--key',
      'sk-testkey1234567890',
      '--label',
      'primary',
      '--no-validate',
    ]);
    const cfg = shared.loadConfig(configPath);
    expect(cfg.llm?.providers?.openai?.apiKey).toBe('sk-testkey1234567890');
    expect(cfg.llm?.providers?.openai?.apiKeyLabel).toBe('primary');
  });

  it('add rejects placeholder keys', async () => {
    await runAuth(['add', 'openai', '--key', 'test-key', '--no-validate']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('No valid API key');
  });

  it('remove primary key promotes secondary', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          providers: {
            openai: {
              apiKey: 'sk-primary1234567890',
              apiKey2: 'sk-secondary123456789',
              apiKeyLabel: 'primary',
              apiKeyLabel2: 'backup',
            },
          },
        },
      }),
    );
    await runAuth(['remove', 'openai']);
    const cfg = shared.loadConfig(configPath);
    expect(cfg.llm?.providers?.openai?.apiKey).toBe('sk-secondary123456789');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('promoted');
  });

  it('reset clears exhaustion flags', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          providers: {
            openai: { apiKey: 'sk-testkey1234567890', exhausted: true, exhausted2: true },
          },
        },
      }),
    );
    await runAuth(['reset', 'openai']);
    const cfg = shared.loadConfig(configPath);
    expect(cfg.llm?.providers?.openai?.exhausted).toBe(false);
    expect(cfg.llm?.providers?.openai?.exhausted2).toBe(false);
  });

  it('validate reports API failures', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          providers: {
            openai: { apiKey: 'sk-testkey1234567890', model: 'gpt-4o-mini' },
          },
        },
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' }),
    );
    await runAuth(['validate', 'openai']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Invalid API key');
  });

  it('remove unknown provider shows error', async () => {
    await runAuth(['remove', 'not-a-provider']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Unknown provider');
  });

  it('remove secondary key only', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          providers: {
            openai: {
              apiKey: 'sk-primary1234567890',
              apiKey2: 'sk-secondary123456789',
            },
          },
        },
      }),
    );
    await runAuth(['remove', 'openai', '--label', 'secondary']);
    const cfg = shared.loadConfig(configPath);
    expect(cfg.llm?.providers?.openai?.apiKey).toBe('sk-primary1234567890');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Secondary key removed');
  });

  it('reset all clears exhaustion flags across providers', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          providers: {
            openai: { apiKey: 'sk-testkey1234567890', exhausted: true },
            anthropic: { apiKey: 'sk-anthropic123456789', exhausted2: true },
          },
        },
      }),
    );
    await runAuth(['reset']);
    const cfg = shared.loadConfig(configPath);
    expect(cfg.llm?.providers?.openai?.exhausted).toBe(false);
    expect(cfg.llm?.providers?.anthropic?.exhausted2).toBe(false);
  });

  it('validate all succeeds with mocked fetch', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          providers: {
            openai: { apiKey: 'sk-testkey1234567890', model: 'gpt-4o-mini' },
          },
        },
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await runAuth(['validate']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('All credentials valid');
  });

  it('reset reports no exhausted credentials when none flagged', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          providers: {
            openai: { apiKey: 'sk-testkey1234567890', exhausted: false },
          },
        },
      }),
    );
    await runAuth(['reset']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('No exhausted credentials');
  });

  it('remove with explicit primary label removes primary key', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          providers: {
            openai: {
              apiKey: 'sk-primary1234567890',
              apiKey2: 'sk-secondary123456789',
            },
          },
        },
      }),
    );
    await runAuth(['remove', 'openai', '--label', 'primary']);
    const cfg = shared.loadConfig(configPath);
    expect(cfg.llm?.providers?.openai?.apiKey).toBe('sk-secondary123456789');
  });

  it('remove rejects unknown label', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: { providers: { openai: { apiKey: 'sk-testkey1234567890' } } },
      }),
    );
    await runAuth(['remove', 'openai', '--label', 'tertiary']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Unknown key label');
  });

  it('validate checks secondary key', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          providers: {
            openai: {
              apiKey: 'sk-primary1234567890',
              apiKey2: 'sk-secondary123456789',
              model: 'gpt-4o-mini',
            },
          },
        },
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await runAuth(['validate', 'openai']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/valid|secondary/i);
  });

  it('add validates key against provider API when validate enabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await runAuth(['add', 'anthropic', '--key', 'sk-anthropic1234567890']);
    const cfg = shared.loadConfig(configPath);
    expect(cfg.llm?.providers?.anthropic?.apiKey).toBe('sk-anthropic1234567890');
  });

  it('list shows env-backed providers', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-envanthropic123456789';
    await runAuth(['list']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/environment|ANTHROPIC_API_KEY/i);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('validate reports success for valid key', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          providers: {
            anthropic: { apiKey: 'sk-anthropic1234567890', model: 'claude-sonnet-4-20250514' },
          },
        },
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await runAuth(['validate', 'anthropic']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/valid/i);
  });

  it('add saves custom model when --model is provided', async () => {
    await runAuth([
      'add',
      'openai',
      '--key',
      'sk-testkey1234567890',
      '--model',
      'gpt-4o-mini',
      '--no-validate',
    ]);
    const cfg = shared.loadConfig(configPath);
    expect(cfg.llm?.providers?.openai?.model).toBe('gpt-4o-mini');
  });

  it('remove warns when provider has no credentials', async () => {
    await runAuth(['remove', 'openai']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/No credentials found/i);
  });

  it('remove primary key clears provider when no secondary exists', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: { providers: { openai: { apiKey: 'sk-onlykey1234567890' } } },
      }),
    );
    await runAuth(['remove', 'openai']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Primary key removed');
  });

  it('reset warns for provider without credentials', async () => {
    await runAuth(['reset', 'anthropic']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/No credentials/i);
  });

  it('validate checks both primary and secondary keys', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          providers: {
            openai: {
              apiKey: 'sk-primary1234567890',
              apiKey2: 'sk-secondary123456789',
              model: 'gpt-4o-mini',
            },
          },
        },
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await runAuth(['validate', 'openai']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/valid|primary|secondary/i);
  });

  it('remove rejects unknown key label', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: { providers: { openai: { apiKey: 'sk-testkey1234567890' } } },
      }),
    );
    await runAuth(['remove', 'openai', '--label', 'tertiary']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Unknown key label');
  });
});
