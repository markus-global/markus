import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskContextResponse } from '@markus/shared';

function makeTaskContext(overrides?: Partial<TaskContextResponse>): TaskContextResponse {
  return {
    task: {
      id: 'task-001',
      title: 'Implement auth',
      description: 'Add JWT authentication to the API',
      status: 'in_progress',
      priority: 'high',
      subtasks: [
        { id: 'sub-1', title: 'Write middleware', status: 'pending' },
        { id: 'sub-2', title: 'Add tests', status: 'completed' },
      ],
      notes: ['Started JWT flow', 'Need to review token expiry'],
      assignedAgentId: 'agent-dev',
      reviewerId: 'agent-reviewer',
      executionRound: 2,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T01:00:00Z',
    },
    requirement: {
      id: 'req-001',
      title: 'User Authentication',
      description: 'Implement complete auth flow',
      status: 'in_progress',
    },
    project: {
      id: 'proj-001',
      name: 'MyApp',
      description: 'Main application project',
      repositories: [{ localPath: '/code/myapp', role: 'primary' }],
    },
    upstream: [
      {
        id: 'task-000',
        title: 'Database schema',
        status: 'completed',
        completionSummary: 'Created users table',
        deliverables: [{ type: 'file', reference: 'migrations/001.sql', summary: 'Users table schema' }],
      },
    ],
    downstream: [
      { id: 'task-002', title: 'API endpoints', status: 'blocked' },
    ],
    ...overrides,
  };
}

describe('context injector', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'markus-context-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('creates CLAUDE.md for claude-code tool', async () => {
    const { injectContext } = await import('../../src/coding-tools/context-injector.js');
    const result = injectContext({
      workdir,
      tool: 'claude-code',
      taskContext: makeTaskContext(),
    });

    const claudeFile = join(workdir, 'CLAUDE.md');
    expect(existsSync(claudeFile)).toBe(true);
    expect(result.filesCreated).toContain(claudeFile);
    expect(readFileSync(claudeFile, 'utf-8')).toContain('# Task: Implement auth');
  });

  it('creates .cursor/rules/markus-task.mdc for cursor-agent tool', async () => {
    const { injectContext } = await import('../../src/coding-tools/context-injector.js');
    const result = injectContext({
      workdir,
      tool: 'cursor-agent',
      taskContext: makeTaskContext(),
    });

    const agentsFile = join(workdir, '.cursor', 'rules', 'markus-task.mdc');
    expect(existsSync(agentsFile)).toBe(true);
    expect(result.filesCreated).toContain(agentsFile);
    expect(readFileSync(agentsFile, 'utf-8')).toContain('# Task: Implement auth');
  });

  it('creates .agent_context/task_context.md for codex tool', async () => {
    const { injectContext } = await import('../../src/coding-tools/context-injector.js');
    const result = injectContext({
      workdir,
      tool: 'codex',
      taskContext: makeTaskContext(),
    });

    const contextFile = join(workdir, '.agent_context', 'task_context.md');
    expect(existsSync(contextFile)).toBe(true);
    expect(result.filesCreated).toContain(contextFile);
    expect(readFileSync(contextFile, 'utf-8')).toContain('# Task: Implement auth');
  });

  it('content includes task title, description, subtasks, and notes', async () => {
    const { injectContext } = await import('../../src/coding-tools/context-injector.js');
    injectContext({
      workdir,
      tool: 'claude-code',
      taskContext: makeTaskContext(),
    });

    const content = readFileSync(join(workdir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('**ID:** task-001');
    expect(content).toContain('Add JWT authentication to the API');
    expect(content).toContain('[ ] Write middleware (pending)');
    expect(content).toContain('[x] Add tests (completed)');
    expect(content).toContain('- Started JWT flow');
    expect(content).toContain('- Need to review token expiry');
  });

  it('content includes requirement and project when available', async () => {
    const { injectContext } = await import('../../src/coding-tools/context-injector.js');
    injectContext({
      workdir,
      tool: 'codex',
      taskContext: makeTaskContext(),
    });

    const content = readFileSync(join(workdir, '.agent_context', 'task_context.md'), 'utf-8');
    expect(content).toContain('## Requirement');
    expect(content).toContain('**User Authentication** (in_progress)');
    expect(content).toContain('Implement complete auth flow');
    expect(content).toContain('## Project');
    expect(content).toContain('**MyApp**');
    expect(content).toContain('Main application project');
    expect(content).toContain('- /code/myapp (primary)');
  });

  it('content includes upstream and downstream dependencies', async () => {
    const { injectContext } = await import('../../src/coding-tools/context-injector.js');
    injectContext({
      workdir,
      tool: 'claude-code',
      taskContext: makeTaskContext(),
    });

    const content = readFileSync(join(workdir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('## Upstream Dependencies');
    expect(content).toContain('### Database schema (completed)');
    expect(content).toContain('Summary: Created users table');
    expect(content).toContain('Users table schema (migrations/001.sql)');
    expect(content).toContain('## Downstream Dependents');
    expect(content).toContain('- API endpoints (blocked)');
  });

  it('sets environment variables correctly', async () => {
    const { injectContext } = await import('../../src/coding-tools/context-injector.js');
    const result = injectContext({
      workdir,
      tool: 'codex',
      taskContext: makeTaskContext(),
      markusCli: '/usr/local/bin/markus',
      serverUrl: 'http://localhost:3000',
    });

    expect(result.envVars).toEqual({
      MARKUS_API_URL: 'http://localhost:3000',
      MARKUS_TASK_ID: 'task-001',
      MARKUS_CLI: '/usr/local/bin/markus',
    });
  });

  it('injects skill content when skills are provided', async () => {
    const { injectContext } = await import('../../src/coding-tools/context-injector.js');
    injectContext({
      workdir,
      tool: 'claude-code',
      taskContext: makeTaskContext(),
      skills: [
        { name: 'testing', content: 'Always write unit tests first.' },
        { name: 'security', content: 'Never log secrets.' },
      ],
    });

    const content = readFileSync(join(workdir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# Relevant Skills');
    expect(content).toContain('## Skill: testing');
    expect(content).toContain('Always write unit tests first.');
    expect(content).toContain('## Skill: security');
    expect(content).toContain('Never log secrets.');
  });

  it('buildContextContent includes CLI reporting instructions', async () => {
    const { buildContextContent } = await import('../../src/coding-tools/context-injector.js');
    const content = buildContextContent(makeTaskContext(), '/usr/local/bin/markus');

    expect(content).toContain('## Reporting Progress');
    expect(content).toContain('/usr/local/bin/markus task progress task-001');
    expect(content).toContain('/usr/local/bin/markus task note task-001');
  });
});
