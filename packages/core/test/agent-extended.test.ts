import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import { pendingCallbackRegistry } from '../src/pending-callback.js';
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

  it('A: aborts a degenerate turn that repeats itself and finishes with a visible note', async () => {
    const line = 'Let me finalize the report and check the video output now.\n';
    const router = makeMockRouter({
      streamFn: async (_req, onEvent, _provider, signal) => {
        for (let i = 0; i < 12; i++) {
          if ((signal as AbortSignal | undefined)?.aborted) throw new Error('aborted');
          (onEvent as (e: { type: string; text: string }) => void)?.({ type: 'text_delta', text: line });
        }
        return { content: line.repeat(12), finishReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 40 } };
      },
    });
    const agent = createAgent(router);
    const events: string[] = [];

    const reply = await agent.handleMessageStream('please test everything', (evt) => {
      if (evt.type === 'text_delta') events.push(evt.text ?? '');
    });

    // The turn stops instead of streaming the same sentence forever.
    expect(reply).toContain('[response stopped: repetitive output detected]');
    // Marked complete so upstream does not run a marker continuation on garbage.
    expect(reply).toContain('<<HANDLE_COMPLETE>>');
    // The stop note is visible to the UI.
    expect(events.join('')).toContain('[response stopped');
  });

  it('B: forwards the marker-continuation text to the UI when streaming', async () => {
    const router = makeMockRouter({
      chatFn: async () => ({
        content: 'Finishing the report now. <<HANDLE_COMPLETE>>',
        finishReason: 'end_turn',
        usage: { inputTokens: 30, outputTokens: 10 },
      }),
    });
    const agent = createAgent(router);
    const memory = (agent as unknown as { memory: { createSession: (id: string) => { id: string } } }).memory;
    const sessionId = memory.createSession(agent.id).id;

    const events: string[] = [];
    const ensure = (agent as unknown as {
      ensureCompletionMarker: (r: string, s: string, e: (evt: { type: string; text?: string }) => void) => Promise<string>;
    }).ensureCompletionMarker.bind(agent);

    const result = await ensure('Here is the plan.', sessionId, (evt) => {
      if (evt.type === 'text_delta') events.push(evt.text ?? '');
    });

    // Continuation content is streamed to the UI (marker stripped from deltas)...
    expect(events.join('')).toContain('Finishing the report now.');
    expect(events.join('')).not.toContain('<<HANDLE_COMPLETE>>');
    // ...and the returned reply carries the marker so the turn is complete.
    expect(result).toContain('<<HANDLE_COMPLETE>>');
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
    await agent.start();

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

  it('trimMessagesForRestore keeps recent turns and inserts a trim marker', () => {
    const msgs = Array.from({ length: 120 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}-${'x'.repeat(200)}`,
    }));
    const trimmed = Agent.trimMessagesForRestore(msgs, 40, 8_000);
    expect(trimmed.length).toBeLessThan(msgs.length);
    expect(trimmed[0]?.content).toMatch(/trimmed on restore/i);
    expect(trimmed.some(m => m.content.includes('msg-119'))).toBe(true);
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

describe('stopped agent behavior', () => {
  it('start after stop restores idle status', async () => {
    const agent = createAgent(makeMockRouter());
    await agent.stop();
    expect(agent.getState().status).toBe('offline');
    await agent.start();
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
    const pending = pendingCallbackRegistry.getByAgentId(agent.id);
    const entry = pending.find(c => c.id === 'bg_sess_1');
    expect(entry).toBeDefined();
    expect(entry?.originSessionId).toBe('main_sess');
    expect(entry?.type).toBe('background_exec');
    pendingCallbackRegistry.resolve('bg_sess_1'); // cleanup shared singleton
  });

  it('executing background_exec registers a pending callback bound to the active session', async () => {
    // Mock LLM: first turn issues a background_exec tool call, second turn ends.
    let turn = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        turn++;
        if (turn === 1) {
          return {
            content: '',
            finishReason: 'tool_use',
            toolCalls: [{ id: 'tc_bg', name: 'background_exec', arguments: { command: 'echo hi' } }],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        return { content: 'Started in background.', finishReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    });
    const agent = createAgent(router);
    // Fake background_exec tool: returns immediately, never spawns a real process.
    agent.registerTool({
      name: 'background_exec',
      description: 'fake bg exec',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: async () => JSON.stringify({ status: 'running', sessionId: 'bg_reg_test_1', pid: 123, command: 'echo hi' }),
    });

    await agent.handleMessage('run echo in background', undefined, undefined, { sessionId: 'chat_sess_bg' });

    const pending = pendingCallbackRegistry.getByAgentId(agent.id);
    const entry = pending.find(c => c.id === 'bg_reg_test_1');
    expect(entry).toBeDefined();
    expect(entry?.originSessionId).toBe('chat_sess_bg');
    expect(entry?.command).toBe('echo hi');
    pendingCallbackRegistry.resolve('bg_reg_test_1'); // cleanup shared singleton
  });
});

describe('deliverCallback routing', () => {
  it('in_session delivery enqueues a callback_result bound to the origin session', () => {
    const agent = createAgent(makeMockRouter());
    agent.deliverCallback({
      callbackId: 'cb1', type: 'background_exec', deliveryMode: 'in_session',
      originSessionId: 'origin_sess', summary: 'done', content: 'output',
    });
    const items = agent.getMailbox().getQueuedItems();
    const item = items.find(i => i.payload.extra?.['callbackId'] === 'cb1');
    expect(item?.sourceType).toBe('callback_result');
    expect(item?.payload.extra?.['originSessionId']).toBe('origin_sess');
  });

  it('mailbox delivery enqueues a system_event (new attention cycle)', () => {
    const agent = createAgent(makeMockRouter());
    agent.deliverCallback({
      callbackId: 'cb2', type: 'wakeup', deliveryMode: 'mailbox',
      originSessionId: 'origin_sess', summary: 'wake', content: 'time to check',
    });
    const items = agent.getMailbox().getQueuedItems();
    const item = items.find(i => i.payload.extra?.['callbackId'] === 'cb2');
    expect(item?.sourceType).toBe('system_event');
  });
});

describe('schedule_wakeup / cancel_wakeup', () => {
  const wakeupToolCall = (args: Record<string, unknown>) => ({
    chatFn: (() => {
      let turn = 0;
      return async () => {
        turn++;
        if (turn === 1) {
          return {
            content: '', finishReason: 'tool_use',
            toolCalls: [{ id: 'tc_w', name: 'schedule_wakeup', arguments: args }],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        return { content: 'Scheduled.', finishReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
      };
    })(),
  });

  it('registers a wakeup callback with a future wakeAt', async () => {
    const agent = createAgent(makeMockRouter(wakeupToolCall({ in_seconds: 3600, note: 'check the build' })));
    await agent.handleMessage('remind me', undefined, undefined, { sessionId: 'chat_wk' });
    const wk = pendingCallbackRegistry.getByAgentId(agent.id).find(c => c.type === 'wakeup');
    expect(wk).toBeDefined();
    expect(wk?.note).toBe('check the build');
    expect(wk?.wakeAt).toBeGreaterThan(Date.now());
    if (wk) pendingCallbackRegistry.resolve(wk.id);
  });

  it('rejects a wakeup without a valid time', async () => {
    const agent = createAgent(makeMockRouter(wakeupToolCall({ note: 'no time given' })));
    await agent.handleMessage('remind me', undefined, undefined, { sessionId: 'chat_wk2' });
    const wk = pendingCallbackRegistry.getByAgentId(agent.id).find(c => c.type === 'wakeup');
    expect(wk).toBeUndefined();
  });
});

describe('agent_send_message await_in_session', () => {
  it('registers an a2a_reply callback bound to the origin session', async () => {
    let turn = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        turn++;
        if (turn === 1) {
          return {
            content: '', finishReason: 'tool_use',
            toolCalls: [{ id: 'tc_a', name: 'agent_send_message', arguments: { agent_id: 'agt_peer', message: 'help?', await_in_session: true } }],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        return { content: 'Sent.', finishReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    });
    const agent = createAgent(router);
    agent.registerTool({
      name: 'agent_send_message',
      description: 'fake a2a send',
      inputSchema: { type: 'object', properties: { agent_id: { type: 'string' }, message: { type: 'string' } }, required: ['agent_id', 'message'] },
      execute: async () => JSON.stringify({ status: 'dispatched', conversation_id: 'conv_test_1', channel_key: 'dm:a2a:x:y' }),
    });
    await agent.handleMessage('ask peer', undefined, undefined, { sessionId: 'chat_a2a' });
    const cb = pendingCallbackRegistry.getByAgentId(agent.id).find(c => c.type === 'a2a_reply');
    expect(cb).toBeDefined();
    expect(cb?.correlationId).toBe('conv_test_1');
    expect(cb?.originSessionId).toBe('chat_a2a');
    expect(cb?.deliveryMode).toBe('in_session');
    if (cb) pendingCallbackRegistry.resolve(cb.id);
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
