import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResolveWhich = vi.fn<(name: string) => string | null>();
const mockExecSafeSync = vi.fn<(cmd: string, args: string[], opts?: any) => { stdout: string; exitCode: number }>();

vi.mock('@markus/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveWhich: (...args: unknown[]) => mockResolveWhich(...(args as [string])),
    execSafeSync: (...args: unknown[]) => mockExecSafeSync(...(args as [string, string[], any])),
  };
});

const mockExecFile = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

describe('coding tool adapters', () => {
  beforeEach(() => {
    mockResolveWhich.mockReset();
    mockExecSafeSync.mockReset();
    mockExecFile.mockReset();
  });

  describe('ClaudeCodeAdapter', () => {
    it('detect() returns available when claude is on PATH', async () => {
      mockResolveWhich.mockReturnValue('/usr/local/bin/claude');
      mockExecSafeSync.mockImplementation((cmd: string, args: string[]) => {
        if (args.includes('--version')) return { stdout: '1.2.3', exitCode: 0 };
        if (args.includes('api-key-status')) return { stdout: 'authenticated', exitCode: 0 };
        return { stdout: '', exitCode: 1 };
      });

      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const result = await adapter.detect();

      expect(result.available).toBe(true);
      expect(result.version).toBe('1.2.3');
      expect(result.path).toBe('/usr/local/bin/claude');
      expect(result.authenticated).toBe(true);
    });

    it('detect() returns not authenticated when api-key-status fails', async () => {
      mockResolveWhich.mockReturnValue('/usr/local/bin/claude');
      mockExecSafeSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('--version')) return { stdout: '1.2.3', exitCode: 0 };
        if (args.includes('api-key-status')) return { stdout: 'not authenticated', exitCode: 1 };
        return { stdout: '', exitCode: 1 };
      });

      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const result = await adapter.detect();

      expect(result.available).toBe(true);
      expect(result.authenticated).toBe(false);
      expect(result.authHint).toContain('ANTHROPIC_API_KEY');
    });

    it('detect() returns unavailable with install hint when claude is missing', async () => {
      mockResolveWhich.mockReturnValue(null);

      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const result = await adapter.detect();

      expect(result).toEqual({
        available: false,
        installHint: 'npm install -g @anthropic-ai/claude-code',
      });
    });

    it('detect() works with Windows path from resolveWhich', async () => {
      mockResolveWhich.mockReturnValue('C:\\Users\\user\\AppData\\Roaming\\npm\\claude.cmd');
      mockExecSafeSync.mockReturnValue({ stdout: '1.0.0', exitCode: 0 });

      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const result = await adapter.detect();

      expect(result.available).toBe(true);
      expect(result.path).toBe('C:\\Users\\user\\AppData\\Roaming\\npm\\claude.cmd');
    });

    it('buildArgs() returns stream-json non-interactive args', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const result = adapter.buildArgs({
        prompt: 'Fix the bug',
        workdir: '/tmp/project',
        config: { tool: 'claude-code', enabled: true, defaultArgs: ['--model', 'opus'], env: { FOO: 'bar' } },
      });

      expect(result.args).toEqual([
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--max-turns', '50',
        '--permission-mode', 'bypassPermissions',
        '--model', 'opus',
        'Fix the bug',
      ]);
      expect(result.env).toEqual({ FOO: 'bar' });
    });

    it('parseOutput() parses assistant text events', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Working on it...' }] },
      });

      const event = adapter.parseOutput(line);
      expect(event).toMatchObject({ type: 'progress', content: 'Working on it...' });
      expect(event?.timestamp).toBeDefined();
    });

    it('parseOutput() parses tool_use as file_edit when name includes edit', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'edit_file', input: { path: 'src/index.ts' } }],
        },
      });

      const event = adapter.parseOutput(line);
      expect(event).toMatchObject({
        type: 'file_edit',
        metadata: { toolName: 'edit_file', input: { path: 'src/index.ts' } },
      });
    });

    it('parseOutput() parses result events as completed', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const line = JSON.stringify({
        type: 'result',
        result: 'Done',
        cost_usd: 0.05,
        input_tokens: 1000,
        output_tokens: 500,
      });

      const event = adapter.parseOutput(line);
      expect(event).toMatchObject({
        type: 'completed',
        content: 'Done',
        metadata: { costUsd: 0.05, inputTokens: 1000, outputTokens: 500 },
      });
    });

    it('parseOutput() treats non-JSON lines as progress', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const event = adapter.parseOutput('plain text output');
      expect(event).toMatchObject({ type: 'progress', content: 'plain text output' });
    });

    it('extractCost() extracts cost from result event', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const output = [
        JSON.stringify({ type: 'assistant', message: { content: [] } }),
        JSON.stringify({
          type: 'result',
          cost_usd: 0.12,
          input_tokens: 2000,
          output_tokens: 800,
          cache_read_tokens: 100,
          cache_write_tokens: 50,
        }),
      ].join('\n');

      const cost = adapter.extractCost(output);
      expect(cost).toEqual({
        inputTokens: 2000,
        outputTokens: 800,
        cacheReadTokens: 100,
        cacheWriteTokens: 50,
        estimatedCostUsd: 0.12,
        source: 'tool_output',
      });
    });

    it('buildArgs() adds --model when model override provided', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const result = adapter.buildArgs({
        prompt: 'Fix bug',
        workdir: '/tmp/project',
        model: 'opus',
      });
      expect(result.args).toContain('--model');
      expect(result.args[result.args.indexOf('--model') + 1]).toBe('opus');
    });

    it('buildArgs() uses config.defaultModel when no model override', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const result = adapter.buildArgs({
        prompt: 'Fix bug',
        workdir: '/tmp/project',
        config: { tool: 'claude-code', enabled: true, defaultModel: 'haiku' },
      });
      expect(result.args).toContain('--model');
      expect(result.args[result.args.indexOf('--model') + 1]).toBe('haiku');
    });

    it('buildArgs() adds --effort and --max-budget-usd when provided', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const result = adapter.buildArgs({
        prompt: 'Complex task',
        workdir: '/tmp/project',
        effort: 'high',
        maxBudgetUsd: 5.0,
      });
      expect(result.args).toContain('--effort');
      expect(result.args[result.args.indexOf('--effort') + 1]).toBe('high');
      expect(result.args).toContain('--max-budget-usd');
      expect(result.args[result.args.indexOf('--max-budget-usd') + 1]).toBe('5');
    });

    it('buildArgs() adds --permission-mode when mode provided', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const result = adapter.buildArgs({
        prompt: 'Plan task',
        workdir: '/tmp/project',
        mode: 'plan',
      });
      expect(result.args).toContain('--permission-mode');
      expect(result.args[result.args.indexOf('--permission-mode') + 1]).toBe('plan');
    });

    it('buildArgs() uses config.maxBudgetPerSessionUsd when no maxBudgetUsd override', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const result = adapter.buildArgs({
        prompt: 'Task',
        workdir: '/tmp',
        config: { tool: 'claude-code', enabled: true, maxBudgetPerSessionUsd: 3.5 },
      });
      expect(result.args).toContain('--max-budget-usd');
      expect(result.args[result.args.indexOf('--max-budget-usd') + 1]).toBe('3.5');
    });

    it('listModels() returns static Claude Code aliases with source', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/coding-tools/adapters/claude-code-adapter.js');
      const adapter = new ClaudeCodeAdapter();
      const result = await adapter.listModels();
      expect(result.source).toBe('static');
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.models.find(m => m.id === 'sonnet')).toBeDefined();
      expect(result.models.find(m => m.id === 'opus')).toBeDefined();
      expect(result.models.find(m => m.id === 'sonnet')?.isDefault).toBe(true);
    });
  });

  describe('CodexAdapter', () => {
    it('detect() returns available when codex is on PATH', async () => {
      mockResolveWhich.mockReturnValue('/usr/local/bin/codex');
      mockExecSafeSync.mockReturnValue({ stdout: '0.5.0', exitCode: 0 });

      const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
      const adapter = new CodexAdapter();
      const result = await adapter.detect();

      expect(result.available).toBe(true);
      expect(result.version).toBe('0.5.0');
      expect(result.path).toBe('/usr/local/bin/codex');
    });

    it('detect() returns unavailable with install hint when codex is missing', async () => {
      mockResolveWhich.mockReturnValue(null);

      const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
      const adapter = new CodexAdapter();
      const result = await adapter.detect();

      expect(result).toEqual({
        available: false,
        installHint: 'npm install -g @openai/codex',
      });
    });

    it('detect() detects auth via OPENAI_API_KEY env var', async () => {
      mockResolveWhich.mockReturnValue('/usr/local/bin/codex');
      mockExecSafeSync.mockReturnValue({ stdout: '0.5.0', exitCode: 0 });

      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-key';
      try {
        const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
        const adapter = new CodexAdapter();
        const result = await adapter.detect();
        expect(result.authenticated).toBe(true);
      } finally {
        if (origKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = origKey;
      }
    });

    it('detect() works with Windows .cmd path', async () => {
      mockResolveWhich.mockReturnValue('C:\\Users\\user\\AppData\\Roaming\\npm\\codex.cmd');
      mockExecSafeSync.mockReturnValue({ stdout: '0.5.0', exitCode: 0 });

      const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
      const adapter = new CodexAdapter();
      const result = await adapter.detect();

      expect(result.available).toBe(true);
      expect(result.path).toBe('C:\\Users\\user\\AppData\\Roaming\\npm\\codex.cmd');
    });

    it('buildArgs() returns full-auto quiet args', async () => {
      const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
      const adapter = new CodexAdapter();
      const result = adapter.buildArgs({
        prompt: 'Implement feature',
        workdir: '/tmp/project',
      });

      expect(result.args).toEqual(['exec', '--full-auto', '--json', '--skip-git-repo-check', 'Implement feature']);
      expect(result.env).toEqual({});
    });

    it('parseOutput() parses JSON message events', async () => {
      const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
      const adapter = new CodexAdapter();
      const event = adapter.parseOutput(JSON.stringify({ type: 'message', content: 'Hello' }));
      expect(event).toMatchObject({ type: 'progress', content: 'Hello' });
    });

    it('parseOutput() treats non-JSON as progress', async () => {
      const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
      const adapter = new CodexAdapter();
      const event = adapter.parseOutput('status update');
      expect(event).toMatchObject({ type: 'progress', content: 'status update' });
    });

    it('extractCost() returns null', async () => {
      const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
      const adapter = new CodexAdapter();
      expect(adapter.extractCost('any output')).toBeNull();
    });

    it('buildArgs() adds -m flag when model override provided', async () => {
      const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
      const adapter = new CodexAdapter();
      const result = adapter.buildArgs({
        prompt: 'Fix bug',
        workdir: '/tmp/project',
        model: 'gpt-5.5',
      });
      expect(result.args).toContain('-m');
      expect(result.args[result.args.indexOf('-m') + 1]).toBe('gpt-5.5');
    });

    it('buildArgs() sets CODEX_REASONING_EFFORT env when effort provided', async () => {
      const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
      const adapter = new CodexAdapter();
      const result = adapter.buildArgs({
        prompt: 'Complex task',
        workdir: '/tmp/project',
        effort: 'high',
      });
      expect(result.env.CODEX_REASONING_EFFORT).toBe('high');
    });

    it('buildArgs() uses config.defaultModel when no model override', async () => {
      const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
      const adapter = new CodexAdapter();
      const result = adapter.buildArgs({
        prompt: 'Task',
        workdir: '/tmp',
        config: { tool: 'codex', enabled: true, defaultModel: 'gpt-5-codex' },
      });
      expect(result.args).toContain('-m');
      expect(result.args[result.args.indexOf('-m') + 1]).toBe('gpt-5-codex');
    });

    it('listModels() returns empty result with cli source when CLI unavailable', async () => {
      vi.resetModules();
      mockResolveWhich.mockReturnValue(null);

      const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
      const adapter = new CodexAdapter();
      const result = await adapter.listModels();
      expect(result.models).toEqual([]);
      expect(result.source).toBe('cli');
    });

    it('listModels() returns parsed models from CLI with source', async () => {
      vi.resetModules();
      mockResolveWhich.mockReturnValue('/usr/local/bin/codex');
      mockExecSafeSync.mockReturnValue({
        stdout: JSON.stringify([
          { id: 'gpt-5-codex', display_name: 'GPT-5 Codex', default: true },
          { id: 'gpt-5.5', display_name: 'GPT-5.5' },
        ]),
        exitCode: 0,
      });

      const { CodexAdapter } = await import('../../src/coding-tools/adapters/codex-adapter.js');
      const adapter = new CodexAdapter();
      const result = await adapter.listModels();
      expect(result.source).toBe('cli');
      expect(result.models.length).toBe(2);
      expect(result.models[0].id).toBe('gpt-5-codex');
      expect(result.models[0].isDefault).toBe(true);
      expect(result.models[1].id).toBe('gpt-5.5');
    });
  });

  describe('CursorAgentAdapter', () => {
    it('detect() returns available with auth status when cursor is on PATH', async () => {
      mockResolveWhich.mockReturnValue('/usr/local/bin/cursor');
      mockExecSafeSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('--version')) return { stdout: '3.6.31', exitCode: 0 };
        if (args.includes('status')) return { stdout: 'user@example.com', exitCode: 0 };
        return { stdout: '', exitCode: 1 };
      });

      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = await adapter.detect();

      expect(result.available).toBe(true);
      expect(result.version).toBe('3.6.31');
      expect(result.path).toBe('/usr/local/bin/cursor');
      expect(result.authenticated).toBe(true);
    });

    it('detect() returns not authenticated when not logged in', async () => {
      mockResolveWhich.mockReturnValue('/usr/local/bin/cursor');
      mockExecSafeSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('--version')) return { stdout: '3.6.31', exitCode: 0 };
        if (args.includes('status')) return { stdout: 'Not logged in', exitCode: 0 };
        return { stdout: '', exitCode: 1 };
      });

      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = await adapter.detect();

      expect(result.available).toBe(true);
      expect(result.authenticated).toBe(false);
      expect(result.authHint).toContain('cursor agent login');
    });

    it('detect() returns unavailable with install hint when cursor is missing', async () => {
      mockResolveWhich.mockReturnValue(null);

      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = await adapter.detect();

      expect(result.available).toBe(false);
      expect(result.installHint).toContain('cursor.com');
    });

    it('detect() works with Windows cursor.exe path', async () => {
      mockResolveWhich.mockReturnValue('C:\\Users\\user\\AppData\\Local\\Programs\\cursor\\cursor.exe');
      mockExecSafeSync.mockReturnValue({ stdout: '3.6.31', exitCode: 0 });

      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = await adapter.detect();

      expect(result.available).toBe(true);
      expect(result.path).toBe('C:\\Users\\user\\AppData\\Local\\Programs\\cursor\\cursor.exe');
    });

    it('buildArgs() returns correct --print --workspace --trust --force args', async () => {
      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = adapter.buildArgs({
        prompt: 'Refactor module',
        workdir: '/tmp/project',
      });

      expect(result.args).toEqual([
        'agent',
        '--print',
        '--output-format', 'stream-json',
        '--workspace', '/tmp/project',
        '--trust',
        '--force',
        'Refactor module',
      ]);
      expect(result.env).toEqual({});
    });

    it('buildArgs() includes defaultArgs before prompt', async () => {
      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = adapter.buildArgs({
        prompt: 'Fix bug',
        workdir: '/tmp/project',
        config: { tool: 'cursor-agent', enabled: true, defaultArgs: ['--model', 'gpt-5'] },
      });

      expect(result.args).toContain('--model');
      expect(result.args).toContain('gpt-5');
      expect(result.args[result.args.length - 1]).toBe('Fix bug');
    });

    it('parseOutput() parses stream-json events', async () => {
      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Working on it...' }] },
      });
      const event = adapter.parseOutput(line);
      expect(event).toMatchObject({ type: 'progress', content: 'Working on it...' });
    });

    it('parseOutput() parses result events with cost', async () => {
      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const line = JSON.stringify({
        type: 'result',
        result: 'Done',
        cost_usd: 0.03,
        input_tokens: 500,
        output_tokens: 200,
      });
      const event = adapter.parseOutput(line);
      expect(event).toMatchObject({
        type: 'completed',
        content: 'Done',
        metadata: { costUsd: 0.03, inputTokens: 500, outputTokens: 200 },
      });
    });

    it('parseOutput() treats plain text lines as progress', async () => {
      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const event = adapter.parseOutput('Agent thinking...');
      expect(event).toMatchObject({ type: 'progress', content: 'Agent thinking...' });
    });

    it('extractCost() extracts cost from result event', async () => {
      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const output = [
        JSON.stringify({ type: 'text', content: 'thinking' }),
        JSON.stringify({ type: 'result', result: 'done', cost_usd: 0.05, input_tokens: 1000, output_tokens: 400 }),
      ].join('\n');
      const cost = adapter.extractCost(output);
      expect(cost).toEqual({
        inputTokens: 1000,
        outputTokens: 400,
        estimatedCostUsd: 0.05,
        source: 'tool_output',
      });
    });

    it('buildArgs() adds --model when model override provided', async () => {
      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = adapter.buildArgs({
        prompt: 'Fix bug',
        workdir: '/tmp/project',
        model: 'claude-sonnet-4-6',
      });
      expect(result.args).toContain('--model');
      expect(result.args[result.args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
    });

    it('buildArgs() adds --mode when mode override provided', async () => {
      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = adapter.buildArgs({
        prompt: 'Plan architecture',
        workdir: '/tmp/project',
        mode: 'plan',
      });
      expect(result.args).toContain('--mode');
      expect(result.args[result.args.indexOf('--mode') + 1]).toBe('plan');
    });

    it('buildArgs() uses config.defaultModel when no model override', async () => {
      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = adapter.buildArgs({
        prompt: 'Task',
        workdir: '/tmp',
        config: { tool: 'cursor-agent', enabled: true, defaultModel: 'claude-opus-4-6' },
      });
      expect(result.args).toContain('--model');
      expect(result.args[result.args.indexOf('--model') + 1]).toBe('claude-opus-4-6');
    });

    it('listModels() returns empty result with cli source when cursor not found', async () => {
      vi.resetModules();
      delete process.env.CURSOR_API_KEY;
      mockResolveWhich.mockReturnValue(null);

      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = await adapter.listModels();
      expect(result.models).toEqual([]);
      expect(result.source).toBe('cli');
    });

    it('listModels() parses CLI output with header/footer lines', async () => {
      vi.resetModules();
      delete process.env.CURSOR_API_KEY;
      mockResolveWhich.mockReturnValue('/usr/local/bin/cursor');
      const cliOutput = [
        'Available models',
        '',
        'auto - Auto',
        'composer-2.5-fast - Composer 2.5 Fast (current, default)',
        'gpt-5.5 - GPT 5.5',
        'claude-opus-4-6 - Claude Opus 4.6',
        '',
        'Tip: use --model <id> to switch.',
      ].join('\n');
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, cliOutput, '');
        return { on: () => {} };
      });

      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = await adapter.listModels();
      expect(result.source).toBe('cli');
      expect(result.hint).toBeUndefined();
      expect(result.models.length).toBe(4);
      expect(result.models[0]).toEqual({ id: 'auto', name: 'Auto', isDefault: undefined });
      expect(result.models[1]).toEqual({ id: 'composer-2.5-fast', name: 'Composer 2.5 Fast', isDefault: true });
      expect(result.models[2]).toEqual({ id: 'gpt-5.5', name: 'GPT 5.5', isDefault: undefined });
      expect(result.models[3]).toEqual({ id: 'claude-opus-4-6', name: 'Claude Opus 4.6', isDefault: undefined });
    });

    it('listModels() always uses CLI even when CURSOR_API_KEY is set', async () => {
      vi.resetModules();
      process.env.CURSOR_API_KEY = 'cursor_test_key_123';
      mockResolveWhich.mockReturnValue('/usr/local/bin/cursor');
      const cliOutput = [
        'Available models',
        '',
        'auto - Auto',
        'composer-2.5-fast - Composer 2.5 Fast (current, default)',
        '',
        'Tip: use --model <id> to switch.',
      ].join('\n');
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, cliOutput, '');
        return { on: () => {} };
      });

      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = await adapter.listModels();

      expect(result.source).toBe('cli');
      expect(result.models.length).toBe(2);
      expect(result.models[0]).toEqual({ id: 'auto', name: 'Auto', isDefault: undefined });
      expect(result.models[1]).toEqual({ id: 'composer-2.5-fast', name: 'Composer 2.5 Fast', isDefault: true });

      delete process.env.CURSOR_API_KEY;
    });

    it('listModels() falls back to CLI when API returns 401', async () => {
      vi.resetModules();
      process.env.CURSOR_API_KEY = 'cursor_expired_key';

      const mockHttpsRequest = vi.fn();
      vi.doMock('node:https', () => ({
        request: mockHttpsRequest,
      }));

      mockHttpsRequest.mockImplementation((_opts: unknown, cb: Function) => {
        const res = {
          statusCode: 401,
          on: vi.fn((event: string, handler: Function) => {
            if (event === 'data') handler(Buffer.from('{"code":"error","message":"Invalid User API Key"}'));
            if (event === 'end') handler();
            return res;
          }),
        };
        cb(res);
        return { on: vi.fn(), end: vi.fn() };
      });

      mockResolveWhich.mockReturnValue('/usr/local/bin/cursor');
      const cliOutput = 'auto - Auto\ncomposer-2.5-fast - Composer 2.5 Fast (default)\n';
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, cliOutput, '');
        return { on: () => {} };
      });

      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = await adapter.listModels();

      expect(result.source).toBe('cli');
      expect(result.models.length).toBe(2);
      expect(result.models[0].id).toBe('auto');

      delete process.env.CURSOR_API_KEY;
    });

    it('listModels() returns CLI models even with API key and cursor not found', async () => {
      vi.resetModules();
      process.env.CURSOR_API_KEY = 'cursor_test_key';
      mockResolveWhich.mockReturnValue(null);

      const { CursorAgentAdapter } = await import('../../src/coding-tools/adapters/cursor-agent-adapter.js');
      const adapter = new CursorAgentAdapter();
      const result = await adapter.listModels();

      expect(result.source).toBe('cli');
      expect(result.models).toEqual([]);

      delete process.env.CURSOR_API_KEY;
    });
  });

  describe('adapter registry', () => {
    it('getAdapter() returns the correct adapter', async () => {
      const { getAdapter } = await import('../../src/coding-tools/adapters/index.js');
      const adapter = getAdapter('claude-code');
      expect(adapter.name).toBe('claude-code');
      expect(adapter.displayName).toBe('Claude Code');
    });

    it('getAdapter() throws for unknown tool', async () => {
      const { getAdapter } = await import('../../src/coding-tools/adapters/index.js');
      expect(() => getAdapter('unknown' as 'claude-code')).toThrow('Unknown coding tool: unknown');
    });

    it('getAllAdapters() returns all three adapters', async () => {
      const { getAllAdapters } = await import('../../src/coding-tools/adapters/index.js');
      const adapters = getAllAdapters();
      expect(adapters).toHaveLength(3);
      expect(adapters.map((a) => a.name).sort()).toEqual(['claude-code', 'codex', 'cursor-agent']);
    });
  });
});
