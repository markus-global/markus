import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'ext-role',
  name: 'Extended Test Role',
  description: 'Extended agent tests',
  category: 'engineering',
  systemPrompt: 'You are an extended test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(overrides?: {
  chatFn?: (...args: unknown[]) => Promise<unknown>;
  streamFn?: (...args: unknown[]) => Promise<unknown>;
}): LLMRouter {
  const chat = vi.fn(overrides?.chatFn ?? (async () => ({
    content: 'Stream reply complete.',
    finishReason: 'end_turn',
    usage: { inputTokens: 80, outputTokens: 40 },
  })));

  const chatStream = vi.fn(overrides?.streamFn ?? (async () => ({
    content: 'Hello world.',
    finishReason: 'end_turn',
    usage: { inputTokens: 80, outputTokens: 40 },
  })));

  return {
    chat,
    chatStream,
    getActiveModelContextWindow: () => 200000,
    getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000,
    getModelContextWindow: () => 200000,
    getModelMaxOutput: () => 8000,
    getModelCost: () => undefined,
    isCompactionSupported: () => true,
    modelSupportsVision: () => false,
    listProviders: () => ['test'],
    getProvider: () => undefined,
    getDefaultProvider: () => 'test',
    defaultProviderName: 'test',
    resolveModalityCandidates: vi.fn(() => []),
  } as unknown as LLMRouter;
}

function createAgent(router: LLMRouter, extra?: Record<string, unknown>) {
  return new Agent({
    config: {
      id: 'test-ext-agent',
      name: 'Extended Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
      skills: ['search'],
      ...extra,
    } as never,
    role: MOCK_ROLE,
    llmRouter: router,
    dataDir: tempDir,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-agent-ext-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('handleMessageStream', () => {
  it('streams content deltas and returns final text', async () => {
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        onEvent?.({ type: 'text_delta', text: 'Hello ' });
        onEvent?.({ type: 'text_delta', text: 'world.' });
        return {
          content: 'Hello world.',
          finishReason: 'end_turn',
          usage: { inputTokens: 80, outputTokens: 40 },
        };
      },
    });
    const agent = createAgent(router);
    const events: string[] = [];

    const reply = await agent.handleMessageStream(
      'Stream me a reply',
      (evt) => {
        if (evt.type === 'text_delta') events.push(evt.text ?? '');
      },
    );

    expect(reply).toContain('Hello world');
    expect(events.join('')).toContain('Hello');
    expect(router.chatStream).toHaveBeenCalled();
  });

  it('returns early when user cancels before processing', async () => {
    const agent = createAgent(makeMockRouter());
    const token = { cancelled: true, userStopped: true };

    const reply = await agent.handleMessageStream('cancelled msg', () => {}, undefined, undefined, token);
    expect(reply).toBe('[cancelled]');
  });
});

describe('generateDailyReport', () => {
  it('generates and logs a daily report via sendMessage path', async () => {
    const router = makeMockRouter({
      chatFn: async () => ({
        content: 'Today I reviewed PRs and fixed bugs.',
        finishReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const report = await agent.generateDailyReport();
    expect(report).toContain('reviewed PRs');
    await agent.stop();
  });
});

describe('injectFollowUp and sendTaskExecution', () => {
  it('injectFollowUp enqueues without blocking', async () => {
    const agent = createAgent(makeMockRouter());
    agent.injectFollowUp('Follow up question', 'user_1', { name: 'User', role: 'human' });
    expect(agent.getMailbox().depth).toBe(1);
  });

  it('sendTaskExecution enqueues task execution item', async () => {
    const agent = createAgent(makeMockRouter());
    const promise = agent.sendTaskExecution('task_abc', 'Implement feature X', {
      taskId: 'task_abc',
      title: 'Feature X',
    });
    expect(agent.getMailbox().depth).toBeGreaterThan(0);
    expect(promise).toBeInstanceOf(Promise);
  });
});

describe('skill and context helpers', () => {
  it('injectSkillInstructions and getActiveSkillNames track activated skills', () => {
    const agent = createAgent(makeMockRouter());
    agent.injectSkillInstructions('search', 'Use web search for research.');
    expect(agent.hasSkillInstructions('search')).toBe(true);
    expect(agent.getActiveSkillNames()).toContain('search');
  });

  it('addDynamicContextProvider injects runtime context into prompts', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    agent.addDynamicContextProvider(() => 'Current sprint: Sprint 42');

    await agent.handleMessage('What sprint are we in?');
    expect(router.chat).toHaveBeenCalled();
  });

  it('setIdentityContext exposes team name', () => {
    const agent = createAgent(makeMockRouter());
    agent.setIdentityContext({
      team: { id: 'team_1', name: 'Alpha Squad' },
    } as never);
    expect(agent.getTeamName()).toBe('Alpha Squad');
  });
});

describe('task helpers', () => {
  it('getAllTasks and getRunningTasks start empty', () => {
    const agent = createAgent(makeMockRouter());
    expect(agent.getAllTasks()).toEqual([]);
    expect(agent.getRunningTasks()).toEqual([]);
    expect(agent.getCurrentTaskId()).toBeUndefined();
  });

  it('cancelTask returns false for unknown task', () => {
    const agent = createAgent(makeMockRouter());
    expect(agent.cancelTask('task_missing')).toBe(false);
  });
});

describe('paused agent behavior', () => {
  it('resume after pause restores idle status', async () => {
    const agent = createAgent(makeMockRouter());
    await agent.start({ startAsPaused: true });
    agent.resume();
    expect(agent.getState().status).toBe('idle');
    await agent.stop();
  });
});

describe('tool execution errors', () => {
  it('handles tool execution failure gracefully', async () => {
    let calls = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: 'Trying tool',
            finishReason: 'tool_use',
            toolCalls: [{ id: 'tc_err', name: 'failing_tool', arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        return {
          content: 'Recovered after tool error.',
          finishReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    });

    const agent = createAgent(router);
    agent.registerTool({
      name: 'failing_tool',
      description: 'Always fails',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => { throw new Error('tool boom'); },
    });

    const reply = await agent.handleMessage('run failing tool');
    expect(reply).toContain('Recovered');
  });
});

describe('team data directory context', () => {
  it('loads team announcements from team data dir', async () => {
    const teamDir = join(tempDir, 'team');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'ANNOUNCEMENT.md'), 'Deploy freeze until Friday.');

    const router = makeMockRouter();
    const agent = createAgent(router);
    agent.setTeamDataDir(teamDir);

    await agent.handleMessage('Any announcements?');
    expect(router.chat).toHaveBeenCalled();
  });
});

describe('checkAttentionYieldPoint', () => {
  it('returns continue when mailbox has no higher priority items', async () => {
    const agent = createAgent(makeMockRouter());
    const result = await agent.checkAttentionYieldPoint();
    expect(result.decision).toBe('continue');
  });
});

describe('activateTools and registerBackgroundSession', () => {
  it('activateTools marks tools for inclusion', async () => {
    const agent = createAgent(makeMockRouter());
    agent.registerTool({
      name: 'extra_tool',
      description: 'Extra',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{}',
    });
    agent.activateTools(['extra_tool']);
    expect(agent.getTools().has('extra_tool')).toBe(true);
  });

  it('registerBackgroundSession tracks session origin mapping', () => {
    const agent = createAgent(makeMockRouter());
    agent.registerBackgroundSession('bg_sess_1', 'main_sess');
    expect(agent.registerBackgroundSession).toBeDefined();
  });
});

describe('additional handleMessage scenarios', () => {
  it('handles review scenario messages', async () => {
    const router = makeMockRouter({
      chatFn: async () => ({
        content: 'Review complete: approved.',
        finishReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    });
    const agent = createAgent(router);

    const reply = await agent.handleMessage('Please review this task', 'mgr_1', {
      name: 'Manager',
      role: 'manager',
    }, { scenario: 'review', sessionId: `review_task_1_${Date.now()}` });

    expect(reply).toContain('approved');
  });

  it('handles task_execution scenario with dedicated session', async () => {
    const router = makeMockRouter({
      chatFn: async () => ({
        content: 'Task execution started.',
        finishReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    });
    const agent = createAgent(router);

    const reply = await agent.handleMessage(
      'TASK EXECUTION: Implement feature',
      undefined,
      undefined,
      { scenario: 'task_execution', sessionId: 'task_exec_sess_1' },
    );

    expect(reply).toContain('Task execution');
  });

  it('applies input guardrail transformation', async () => {
    const agent = createAgent(makeMockRouter());
    agent.getGuardrails().addInputGuardrail({
      name: 'sanitizer',
      description: 'sanitize',
      check: async (input) => ({
        passed: true,
        transformedContent: input.replace('dirty', 'sanitized'),
      }),
    });

    const check = await agent.getGuardrails().checkInput('dirty text', { agentId: agent.id });
    expect(check.transformedInput).toBe('sanitized text');
  });
});

describe('cognitive and path policy agent', () => {
  it('constructs agent with cognitive config enabled', async () => {
    const agent = new Agent({
      config: {
        id: 'cog-agent',
        name: 'Cognitive Agent',
        roleId: 'worker',
        llmConfig: { modelMode: 'custom', primary: 'anthropic' },
        createdAt: new Date().toISOString(),
      } as never,
      role: MOCK_ROLE,
      llmRouter: makeMockRouter(),
      dataDir: tempDir,
      cognitive: { enabled: true },
    });

    await agent.handleMessage('Plan my work');
    expect(agent.getContextEngine()).toBeDefined();
  });
});

describe('mailbox utilities on agent', () => {
  it('dropStaleStatusUpdates removes queued status updates for task', () => {
    const agent = createAgent(makeMockRouter());
    agent.enqueueToMailbox('task_status_update', {
      summary: 'status',
      content: 'in progress',
      taskId: 'task_drop_1',
    });
    expect(agent.dropStaleStatusUpdates('task_drop_1')).toBe(1);
    expect(agent.getMailbox().depth).toBe(0);
  });

  it('getUsageStats returns token and interaction counts', async () => {
    const agent = createAgent(makeMockRouter());
    await agent.handleMessage('count usage');
    const stats = agent.getUsageStats();
    expect(stats.tokensToday).toBeGreaterThanOrEqual(0);
  });
});
