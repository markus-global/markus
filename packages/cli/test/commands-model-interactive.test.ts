import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import * as shared from '@markus/shared';

const answerQueue: string[] = [];
const closeMock = vi.hoisted(() => vi.fn());

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (ans: string) => void) => {
      cb(answerQueue.shift() ?? '');
    },
    close: closeMock,
  }),
}));

describe('model command interactive mode', () => {
  let tmpDir: string;
  let configPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'markus-model-interactive-'));
    configPath = join(tmpDir, 'markus.json');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    answerQueue.length = 0;
    closeMock.mockClear();

    const origLoad = shared.loadConfig;
    const origSave = shared.saveConfig;
    vi.spyOn(shared, 'getDefaultConfigPath').mockReturnValue(configPath);
    vi.spyOn(shared, 'loadConfig').mockImplementation((path?: string) =>
      origLoad(path ?? configPath),
    );
    vi.spyOn(shared, 'saveConfig').mockImplementation((cfg, path) =>
      origSave(cfg, path ?? configPath),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }),
    );
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runInteractiveModel(): Promise<void> {
    const { registerModelCommand } = await import('../src/commands/model.js');
    const program = new Command();
    program.exitOverride();
    registerModelCommand(program);
    await program.parseAsync(['node', 'markus', 'model']);
  }

  it('configures a new provider through the interactive wizard', async () => {
    const { PROVIDERS } = await import('@markus/shared');
    const anthropicNum = String(PROVIDERS.findIndex(p => p.id === 'anthropic') + 1);
    answerQueue.push('1', anthropicNum, '1', 'sk-anthropic1234567890', 'primary');

    await runInteractiveModel();

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/saved|valid/i);
    expect(readFileSync(configPath, 'utf-8')).toContain('sk-anthropic1234567890');
    expect(closeMock).toHaveBeenCalled();
  });

  it('quits immediately when user selects Q', async () => {
    answerQueue.push('q');

    await runInteractiveModel();

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/Model Configuration|Configured Providers/i);
    expect(closeMock).toHaveBeenCalled();
  });

  it('manages credential pool and adds backup key', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          defaultProvider: 'openai',
          providers: {
            openai: {
              apiKey: 'sk-primary1234567890',
              apiKeyLabel: 'primary',
              model: 'gpt-4o-mini',
            },
          },
        },
      }),
    );

    answerQueue.push('2', '1', '1', 'sk-backup1234567890', 'backup');

    await runInteractiveModel();

    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.providers.openai.apiKey2).toBe('sk-backup1234567890');
    expect(cfg.llm.providers.openai.apiKeyLabel2).toBe('backup');
  });

  it('sets default provider from interactive menu', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          defaultProvider: 'openai',
          providers: {
            openai: { apiKey: 'sk-openai1234567890', model: 'gpt-4o-mini' },
            anthropic: { apiKey: 'sk-anthropic1234567890', model: 'claude-sonnet-4-20250514' },
          },
        },
      }),
    );

    answerQueue.push('3', '1');

    await runInteractiveModel();

    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.defaultProvider).toBe('anthropic');
  });

  it('skips provider setup when no api key is entered', async () => {
    answerQueue.push('1', '1', '1', '', 'primary');

    await runInteractiveModel();

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/Skipped|configure later/i);
  });

  it('clears exhaustion flags from credential pool menu', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: {
          defaultProvider: 'openai',
          providers: {
            openai: {
              apiKey: 'sk-primary1234567890',
              exhausted: true,
              exhausted2: true,
              model: 'gpt-4o-mini',
            },
          },
        },
      }),
    );

    answerQueue.push('2', '1', '3');

    await runInteractiveModel();

    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.providers.openai.exhausted).toBe(false);
    expect(cfg.llm.providers.openai.exhausted2).toBe(false);
  });
});
