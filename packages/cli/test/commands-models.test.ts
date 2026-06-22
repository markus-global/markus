import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerModelsCommand } from '../src/commands/models.js';
import { setGlobalJson } from '../src/output.js';

describe('models command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setGlobalJson(false);
  });

  afterEach(() => {
    logSpy.mockRestore();
    setGlobalJson(false);
  });

  function runModels(args: string[]): Promise<void> {
    const program = new Command();
    program
      .option('--json')
      .hook('preAction', (_cmd, actionCmd) => {
        if (actionCmd.optsWithGlobals().json) setGlobalJson(true);
      });
    program.exitOverride();
    registerModelsCommand(program);
    return program.parseAsync(['node', 'markus', 'models', ...args]);
  }

  it('lists all providers when no provider argument', async () => {
    await runModels([]);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Model Directory');
    expect(output).toContain('openai');
    expect(output).toContain('anthropic');
  });

  it('lists models for a valid provider', async () => {
    await runModels(['openai']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('OpenAI');
    expect(output).toContain('default');
  });

  it('reports unknown provider with available list', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    await runModels(['not-a-provider']);
    const output = errorSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Unknown provider');
    expect(output).toContain('Available:');
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('outputs JSON for all providers with --json', async () => {
    await runModels(['--json']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.openai).toBeDefined();
    expect(Array.isArray(parsed.anthropic)).toBe(true);
  });

  it('outputs JSON for single provider with --json', async () => {
    await runModels(['google', '--json']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.google).toBeDefined();
  });
});
