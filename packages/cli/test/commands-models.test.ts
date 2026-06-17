import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerModelsCommand } from '../src/commands/models.js';

describe('models command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function runModels(args: string[]): Promise<void> {
    const program = new Command();
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
    await runModels(['not-a-provider']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Unknown provider');
    expect(output).toContain('Available:');
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
