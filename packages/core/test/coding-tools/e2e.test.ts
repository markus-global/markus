import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodingToolRuntime } from '../../src/coding-tools/runtime.js';
import { ClaudeCodeAdapter } from '../../src/coding-tools/adapters/index.js';
import type { TaskContextResponse, CodingToolEvent, ToolAdapter } from '@markus/shared';

function makeTaskContext(overrides?: Partial<TaskContextResponse['task']>): TaskContextResponse {
  return {
    task: {
      id: 'test-task-001',
      title: 'Test Task',
      description: 'A test task for E2E testing',
      status: 'in_progress',
      priority: 'medium',
      subtasks: [],
      assignedAgentId: 'agent-1',
      reviewerId: 'reviewer-1',
      executionRound: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    },
    upstream: [],
    downstream: [],
  };
}

function createMockAdapter(scriptPath: string): ToolAdapter {
  const adapter = new ClaudeCodeAdapter();
  return {
    name: adapter.name,
    displayName: adapter.displayName,
    binaryName: 'node',
    detect: async () => ({ available: true, version: 'mock', path: 'node' }),
    buildArgs: () => ({ args: [scriptPath], env: {} }),
    parseOutput: (line) => adapter.parseOutput(line),
    extractCost: (output) => adapter.extractCost(output),
  };
}

describe('coding tool E2E', () => {
  let tmpDir: string;
  let mockCliPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'markus-e2e-'));

    mockCliPath = join(tmpDir, 'mock-claude.mjs');
    writeFileSync(
      mockCliPath,
      `
const events = [
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Analyzing codebase...' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'write_file', input: { path: 'test.txt' } }] } },
  { type: 'result', result: 'Task completed successfully', cost_usd: 0.05, input_tokens: 1000, output_tokens: 500 },
];
for (const e of events) {
  console.log(JSON.stringify(e));
}
`,
    );
  });

  it('full session lifecycle with mock tool', async () => {
    const runtime = new CodingToolRuntime();
    const events: CodingToolEvent[] = [];
    const statuses: string[] = [];

    const mockAdapter = createMockAdapter(mockCliPath);

    const session = await runtime.execute('Implement feature X', {
      adapter: mockAdapter,
      repoPath: tmpDir,
      taskContext: makeTaskContext(),
      onEvent: (event) => events.push(event),
      onStatusChange: (s) => statuses.push(s.status),
    });

    expect(session.status).toBe('completed');
    expect(session.result?.success).toBe(true);

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'progress' && e.content.includes('Analyzing codebase'))).toBe(true);
    expect(events.some((e) => e.type === 'file_edit')).toBe(true);
    expect(events.some((e) => e.type === 'completed' && e.content.includes('Task completed successfully'))).toBe(
      true,
    );

    expect(existsSync(join(tmpDir, 'CLAUDE.md'))).toBe(true);
    const contextContent = readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(contextContent).toContain('Test Task');
    expect(contextContent).toContain('test-task-001');

    expect(session.cost).toBeDefined();
    expect(session.cost?.estimatedCostUsd).toBe(0.05);
    expect(session.cost?.inputTokens).toBe(1000);
    expect(session.cost?.outputTokens).toBe(500);

    expect(statuses).toEqual(['created', 'context_injected', 'running', 'completed']);

    expect(session.result?.rawOutput).toContain('Task completed successfully');
    expect(session.worktreePath).toBe(tmpDir);
  });

  it('handles tool failure gracefully', async () => {
    const failScript = join(tmpDir, 'mock-fail.mjs');
    writeFileSync(
      failScript,
      `
console.error('Something went wrong');
process.exit(1);
`,
    );

    const runtime = new CodingToolRuntime();
    const mockAdapter = createMockAdapter(failScript);

    const session = await runtime.execute('test', {
      adapter: mockAdapter,
      repoPath: tmpDir,
      taskContext: makeTaskContext({ id: 'test-002', title: 'Fail Test', description: 'test' }),
    });

    expect(session.status).toBe('failed');
    expect(session.result?.success).toBe(false);
    expect(session.result?.exitCode).toBe(1);
    expect(session.result?.error).toContain('Something went wrong');
  });
});
