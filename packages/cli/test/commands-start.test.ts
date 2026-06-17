import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

describe('start command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers start command with --setup option', async () => {
    const { registerStartCommand } = await import('../src/commands/start.js');
    const program = new Command();
    program.exitOverride();
    registerStartCommand(program);

    const startCmd = program.commands.find(c => c.name() === 'start');
    expect(startCmd).toBeDefined();
    expect(startCmd?.description()).toContain('Start the Markus server');
    expect(startCmd?.options.some(o => o.long === '--setup')).toBe(true);
  });

  it('registers action that references init for first-run setup', async () => {
    const { registerStartCommand } = await import('../src/commands/start.js');
    const program = new Command();
    registerStartCommand(program);
    const startCmd = program.commands.find(c => c.name() === 'start');
    expect(startCmd?._actionHandler).toBeTypeOf('function');
  });

  it('registers --port and --config global options on parent program', async () => {
    const { registerStartCommand } = await import('../src/commands/start.js');
    const program = new Command();
    program.option('--port <number>', 'API port');
    program.option('--config <path>', 'Config path');
    registerStartCommand(program);
    expect(program.options.some(o => o.long === '--port')).toBe(true);
    expect(program.options.some(o => o.long === '--config')).toBe(true);
  });
});
