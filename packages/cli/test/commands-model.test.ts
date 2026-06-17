import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerModelCommand } from '../src/commands/model.js';
import * as shared from '@markus/shared';

describe('model command', () => {
  let tmpDir: string;
  let configPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'markus-model-cmd-'));
    configPath = join(tmpDir, 'markus.json');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const origLoad = shared.loadConfig;
    const origSave = shared.saveConfig;
    vi.spyOn(shared, 'loadConfig').mockImplementation(() =>
      origLoad(configPath),
    );
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

  function runModel(args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerModelCommand(program);
    return program.parseAsync(['node', 'markus', 'model', ...args]);
  }

  it('rejects unknown provider in non-interactive mode', async () => {
    await runModel(['--non-interactive', '--provider', 'not-a-provider']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Unknown provider');
  });

  it('saves provider config on successful non-interactive validation', async () => {
    await runModel([
      '--non-interactive',
      '--provider',
      'openai',
      '--api-key',
      'sk-testkey1234567890',
      '--model',
      'gpt-4o-mini',
      '--default',
    ]);

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/OK|Saved/);

    const cfg = shared.loadConfig(configPath);
    expect(cfg.llm?.providers?.openai?.apiKey).toBe('sk-testkey1234567890');
    expect(cfg.llm?.defaultProvider).toBe('openai');
  });

  it('reports failure when API validation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }),
    );

    await runModel([
      '--non-interactive',
      '--provider',
      'openai',
      '--api-key',
      'sk-testkey1234567890',
    ]);

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('FAIL');
    expect(output).toContain('Invalid API key');
  });

  it('requires api key in non-interactive mode', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    await runModel(['--non-interactive', '--provider', 'openai']);

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('No API key');

    if (prev) process.env.OPENAI_API_KEY = prev;
  });

  it('lists available providers when provider id is invalid', async () => {
    await runModel(['--non-interactive', '--provider', 'invalid-provider']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Available:');
    expect(output).toContain('openai');
  });

  it('validates anthropic provider successfully in non-interactive mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }),
    );
    await runModel([
      '--non-interactive',
      '--provider',
      'anthropic',
      '--api-key',
      'sk-anthropic1234567890',
      '--model',
      'claude-sonnet-4-20250514',
    ]);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/OK/);
    const cfg = shared.loadConfig(configPath);
    expect(cfg.llm?.providers?.anthropic?.apiKey).toBe('sk-anthropic1234567890');
  });

  it('reports rate limit failure for anthropic validation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'Rate limited' }),
    );
    await runModel([
      '--non-interactive',
      '--provider',
      'anthropic',
      '--api-key',
      'sk-anthropic1234567890',
    ]);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('FAIL');
    expect(output).toContain('Rate limited');
  });

  it('uses env key when --api-key omitted', async () => {
    process.env.OPENAI_API_KEY = 'sk-envopenai123456789';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }),
    );
    await runModel(['--non-interactive', '--provider', 'openai']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/OK/);
    delete process.env.OPENAI_API_KEY;
  });

  it('preserves existing default provider when --default not set', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: { defaultProvider: 'anthropic', providers: { anthropic: { apiKey: 'sk-old1234567890' } } },
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }),
    );
    await runModel([
      '--non-interactive',
      '--provider',
      'openai',
      '--api-key',
      'sk-testkey1234567890',
    ]);
    const cfg = shared.loadConfig(configPath);
    expect(cfg.llm?.defaultProvider).toBe('anthropic');
    expect(cfg.llm?.providers?.openai?.apiKey).toBe('sk-testkey1234567890');
  });
});
