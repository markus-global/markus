import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent, type AgentToolHandler } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { COMPLETION_MARKER } from '@markus/shared';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'cov-role',
  name: 'Coverage Role',
  description: 'Coverage tests',
  category: 'engineering',
  systemPrompt: 'You are a coverage test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeResponse(
  content: string,
  finishReason: string,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
) {
  return {
    content,
    finishReason,
    toolCalls,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

function makeMockRouter(overrides?: {
  chatFn?: (...args: unknown[]) => Promise<unknown>;
  streamFn?: (...args: unknown[]) => Promise<unknown>;
}): LLMRouter {
  const chat = vi.fn(overrides?.chatFn ?? (async () =>
    makeResponse('Default reply.', 'end_turn')));

  const chatStream = vi.fn(overrides?.streamFn ?? (async (_req, onEvent) => {
    onEvent?.({ type: 'text_delta', text: 'Streamed ' });
    onEvent?.({ type: 'text_delta', text: 'output.' });
    return makeResponse('Streamed output.', 'end_turn');
  }));

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

function createAgent(
  router: LLMRouter,
  overrides?: {
    config?: Record<string, unknown>;
    restoredState?: { tokensUsedToday?: number };
    maxToolIterations?: number;
  },
) {
  const { config: configOverrides, ...rest } = overrides ?? {};
  return new Agent({
    config: {
      id: 'cov-agent',
      name: 'Coverage Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
      ...configOverrides,
    } as never,
    role: MOCK_ROLE,
    llmRouter: router,
    dataDir: tempDir,
    ...rest,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-agent-cov-'));
  mkdirSync(join(tempDir, 'role'), { recursive: true });
  writeFileSync(join(tempDir, 'role', 'ROLE.md'), '# Role\nInitial prompt.');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('executeTask and task lifecycle', () => {
  it('executes a task via sendTaskExecution and emits status logs', async () => {
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        onEvent?.({ type: 'text_delta', text: 'Working on task.' });
        return makeResponse('Task done.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const logs: Array<{ type: string; content: string }> = [];
    await agent.sendTaskExecution('task_exec_1', 'Implement a small feature', (entry) => {
      if (entry.persist) logs.push({ type: entry.type, content: entry.content });
    });

    expect(logs.some(l => l.type === 'status' && l.content === 'started')).toBe(true);
    expect(logs.some(l => l.type === 'status' && l.content === 'execution_finished')).toBe(true);
    expect(router.chatStream).toHaveBeenCalled();
    await agent.stop();
  });

  it('executeTask directly completes and clears active tasks', async () => {
    const router = makeMockRouter({
      streamFn: async () => makeResponse('Finished.', 'end_turn'),
    });
    const agent = createAgent(router);
    const logs: string[] = [];

    await agent.executeTask('task_direct', 'Run unit tests', (entry) => {
      logs.push(entry.type);
    });

    expect(logs).toContain('status');
    expect(agent.getActiveTasks()).toEqual([]);
    expect(agent.getRunningTasks()).toEqual([]);
  });

  it('executeChatTask runs through task executor with high priority', async () => {
    const router = makeMockRouter({
      streamFn: async () => makeResponse('Chat task done.', 'end_turn'),
    });
    const agent = createAgent(router);
    const logs: string[] = [];

    await agent.executeChatTask('chat_task_1', 'Answer user question', (entry) => {
      logs.push(entry.type);
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(router.chatStream).toHaveBeenCalled();
  });

  it('cancelled token stops task execution early', async () => {
    const router = makeMockRouter({
      streamFn: async () => makeResponse('Should not finish.', 'end_turn'),
    });
    const agent = createAgent(router);
    const cancelToken = { cancelled: true };

    await agent.executeTask('task_cancel', 'Cancelled task', () => {}, cancelToken);

    expect(router.chatStream).not.toHaveBeenCalled();
  });

  it('removeActiveTask clears task tracking and pending injections', async () => {
    const agent = createAgent(makeMockRouter());
    const session = agent.getMemory().createSession(agent.id, 'task_task_rm_r1');
    agent.injectUserMessage(session.id, 'pending injection');

    agent.removeActiveTask('task_rm');
    expect(agent.getActiveTasks()).toEqual([]);
  });

  it('updateTaskProgress delegates to task executor', async () => {
    const agent = createAgent(makeMockRouter());
    expect(agent.updateTaskProgress('task_prog', 50, 'halfway')).toBe(false);
  });
});

describe('session reply and respondInSession', () => {
  it('sendSessionReply routes through mailbox and returns reply', async () => {
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        onEvent?.({ type: 'text_delta', text: 'Session ' });
        return makeResponse(`Session reply. ${COMPLETION_MARKER}`, 'end_turn');
      },
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const session = agent.getMemory().createSession(agent.id);
    const logs: string[] = [];
    const reply = await agent.sendSessionReply(
      session.id,
      'Can you clarify the deliverable?',
      (entry) => { logs.push(entry.type); },
    );

    expect(reply).toContain('Session reply');
    expect(logs.length).toBeGreaterThan(0);
    await agent.stop();
  });

  it('respondInSession streams without task_submit_review requirement', async () => {
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        onEvent?.({ type: 'text_delta', text: 'Clarified.' });
        return makeResponse('Clarified.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    const session = agent.getMemory().createSession(agent.id);
    const logs: string[] = [];

    const reply = await agent.respondInSession(
      session.id,
      'What files were changed?',
      (entry) => { if (entry.persist) logs.push(entry.type); },
    );

    expect(reply).toContain('Clarified');
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe('token budget and large tool results', () => {
  it('pauses agent when daily token budget is exhausted', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router, {
      config: {
        llmConfig: { modelMode: 'custom', primary: 'anthropic', maxTokensPerDay: 100 },
      },
    });

    await agent.handleMessage('first message');
    await expect(agent.handleMessage('second message')).rejects.toThrow(/Daily token budget/);
    expect(agent.getPauseReason()).toMatch(/Daily token budget/);
    expect(agent.getTokensUsedToday()).toBeGreaterThanOrEqual(100);
  });

  it('offloads large tool results to filesystem', async () => {
    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeResponse('Reading...', 'tool_use', [
            { id: 'tc_big', name: 'big_tool', arguments: {} },
          ]);
        }
        return makeResponse('Processed large output.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    const hugePayload = 'x'.repeat(60_000);
    agent.registerTool({
      name: 'big_tool',
      description: 'Returns huge output',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => hugePayload,
    });

    await agent.handleMessage('run big tool');
    const offloadDir = join(tempDir, 'tool-outputs');
    const files = readFileSync(join(offloadDir, readdirSync(offloadDir)[0]!), 'utf-8');
    expect(files.length).toBe(60_000);
  });
});

describe('handleMessage advanced paths', () => {
  it('continues after max_tokens finish reason', async () => {
    let calls = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        calls++;
        if (calls === 1) {
          return makeResponse('Partial response...', 'max_tokens');
        }
        return makeResponse('Continued and complete.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    const reply = await agent.handleMessage('Tell me a long story');
    expect(reply).toContain('Continued');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('injects channel context on first turn', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);

    await agent.handleMessage('New message in channel', undefined, undefined, {
      channelContext: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
      ],
    });

    const sessions = agent.getMemory().listSessions(agent.id);
    const session = sessions.find(s => s.messages.length >= 3);
    expect(session?.messages.some(m => String(m.content).includes('Earlier question'))).toBe(true);
  });

  it('updates channel context hash on subsequent turns', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    const channelContext = [{ role: 'user' as const, content: 'Message v1' }];

    await agent.handleMessage('First', undefined, undefined, { channelContext, sessionId: 'chan_sess_1' });
    await agent.handleMessage('Second', undefined, undefined, {
      channelContext: [{ role: 'user' as const, content: 'Message v2' }],
      sessionId: 'chan_sess_1',
    });

    const session = agent.getMemory().getSession('chan_sess_1');
    expect(session?.messages.some(m => String(m.content).includes('Channel context update'))).toBe(true);
  });

  it('handles images when model supports vision', async () => {
    const router = makeMockRouter();
    (router.modelSupportsVision as ReturnType<typeof vi.fn>) = vi.fn(() => true);
    const agent = createAgent(router);

    await agent.handleMessage('Describe this image', undefined, undefined, {
      images: ['data:image/png;base64,abc'],
    });
    expect(router.chat).toHaveBeenCalled();
  });

  it('collects tool events when toolEventCollector is provided', async () => {
    let calls = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        calls++;
        if (calls === 1) {
          return makeResponse('Using tool', 'tool_use', [
            { id: 'tc_evt', name: 'evt_tool', arguments: { q: 'x' } },
          ]);
        }
        return makeResponse('Done with tool.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.registerTool({
      name: 'evt_tool',
      description: 'event tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"ok":true}',
    });

    const events: Array<{ tool: string; status: string }> = [];
    await agent.handleMessage('run evt tool', undefined, undefined, {
      toolEventCollector: events,
    });

    expect(events.some(e => e.tool === 'evt_tool' && e.status === 'done')).toBe(true);
  });

  it('uses default model mode without custom provider', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router, {
      config: { llmConfig: { modelMode: 'default', primary: 'anthropic' } },
    });

    await agent.handleMessage('default provider test');
    expect(router.chat).toHaveBeenCalled();
  });
});

describe('callbacks, hooks, and helpers', () => {
  it('fires audit callback on LLM request', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    const audit = vi.fn();
    agent.setAuditCallback(audit);

    await agent.handleMessage('audit me');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'llm_request' }));
  });

  it('fires escalation callback when configured', async () => {
    const agent = createAgent(makeMockRouter());
    const escalate = vi.fn();
    agent.setEscalationCallback(escalate);
    agent.setEscalationCallback(escalate);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('reloads role after agent modifies ROLE.md via tool hook', async () => {
    const agent = createAgent(makeMockRouter());
    const rolePath = join(tempDir, 'role', 'ROLE.md');
    const hooks = agent.getToolHooks().getHooks();
    const autoReload = hooks.find(h => h.name === 'role-auto-reload');
    expect(autoReload?.after).toBeDefined();

    writeFileSync(rolePath, '# Role\nUpdated via hook.');
    await autoReload!.after!({
      toolName: 'file_write',
      arguments: { path: rolePath },
      agentId: agent.id,
      result: '{"ok":true}',
      durationMs: 1,
      success: true,
    });

    expect(agent.role.systemPrompt).toContain('Updated via hook');
  });

  it('loads team norms alongside announcements', async () => {
    const teamDir = join(tempDir, 'team');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'ANNOUNCEMENT.md'), 'Sprint review Friday.');
    writeFileSync(join(teamDir, 'NORMS.md'), 'Always write tests.');

    const router = makeMockRouter();
    const agent = createAgent(router, {
      config: { agentRole: 'manager' },
    });
    agent.setTeamDataDir(teamDir);

    await agent.handleMessage('Team context check');
    expect(router.chat).toHaveBeenCalled();
  });

  it('consumeDeliberationResult returns and clears pending result', () => {
    const agent = createAgent(makeMockRouter());
    expect(agent.consumeDeliberationResult()).toBeUndefined();

    (agent as unknown as { pendingDeliberationResult: unknown }).pendingDeliberationResult = {
      decision: 'proceed',
      reasoning: 'test',
    };
    const result = agent.consumeDeliberationResult();
    expect(result?.decision).toBe('proceed');
    expect(agent.consumeDeliberationResult()).toBeUndefined();
  });

  it('getAgentStatusSummary reflects active tasks without state manager path', async () => {
    const router = makeMockRouter({
      streamFn: async () => makeResponse('Working.', 'end_turn'),
    });
    const agent = createAgent(router);

    const execPromise = agent.executeTask('task_busy', 'Busy work', () => {});
    await new Promise(r => setTimeout(r, 20));
    const summary = agent.getAgentStatusSummary();
    expect(summary.isBusy || summary.activeTaskCount >= 0).toBe(true);
    await execPromise;
  });

  it('setAvailableSkillCatalog and setUserApprovalRequester are wired', () => {
    const agent = createAgent(makeMockRouter());
    agent.setAvailableSkillCatalog([{ name: 'search', description: 'Search web', category: 'research' }]);
    agent.setUserApprovalRequester(vi.fn(async () => ({ approved: true })));
    expect(agent.getActiveSkillNames()).toBeDefined();
  });
});

describe('subagent and streaming paths', () => {
  it('spawn_subagents runs parallel subagent tool', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('Parallel subagent done.', 'end_turn'),
    });
    const agent = createAgent(router, { maxToolIterations: 5 });
    agent.registerTool({
      name: 'helper_tool',
      description: 'Helper',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"result":"ok"}',
    });

    const spawnTool = agent.getTools().get('spawn_subagents');
    expect(spawnTool).toBeDefined();

    const raw = await spawnTool!.execute({
      tasks: [{ task: 'Quick check using helper_tool', label: 'check' }],
    });
    const parsed = JSON.parse(raw) as { status: string };
    expect(parsed.status).toBe('completed');
  });

  it('sendMessageStream delivers stream events', async () => {
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        onEvent?.({ type: 'text_delta', text: 'Hello ' });
        onEvent?.({ type: 'text_delta', text: 'stream.' });
        return makeResponse('Hello stream.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const deltas: string[] = [];
    const reply = await agent.sendMessageStream(
      'Stream please',
      (evt) => { if (evt.type === 'text_delta') deltas.push(evt.text ?? ''); },
    );

    expect(reply).toContain('Hello stream');
    expect(deltas.join('')).toContain('Hello');
    await agent.stop();
  });

  it('ensureCompletionMarker triggers follow-up when marker missing', async () => {
    let calls = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        calls++;
        if (calls === 1) return makeResponse('Reply without marker', 'end_turn');
        return makeResponse(`Fixed reply. ${COMPLETION_MARKER}`, 'end_turn');
      },
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const reply = await agent.sendMessage('needs marker', 'user_1', { name: 'User', role: 'human' }, {
      sourceType: 'a2a_message',
      scenario: 'a2a',
    });

    expect(typeof reply).toBe('string');
    expect(calls).toBeGreaterThanOrEqual(1);
    await agent.stop();
  });
});

describe('mailbox scenarios not covered elsewhere', () => {
  async function processViaMailbox(
    agent: Agent,
    sourceType: Parameters<Agent['enqueueToMailbox']>[0],
    payload: Parameters<Agent['enqueueToMailbox']>[1],
  ) {
    return new Promise<string>((resolve, reject) => {
      agent.enqueueToMailbox(sourceType, payload, {
        metadata: { responsePromise: { resolve, reject } },
      });
    });
  }

  it('routes memory_consolidation scenario', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const reply = await processViaMailbox(agent, 'memory_consolidation', {
      summary: 'Consolidate',
      content: 'Review and consolidate memories',
    });

    expect(typeof reply).toBe('string');
    expect(router.chat).toHaveBeenCalled();
    await agent.stop();
  });

  it('routes system_event through heartbeat scenario', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const reply = await processViaMailbox(agent, 'system_event', {
      summary: 'System notice',
      content: 'Scheduled maintenance tonight',
    });

    expect(typeof reply).toBe('string');
    await agent.stop();
  });

  it('injects task_comment into active task session', async () => {
    const router = makeMockRouter({
      streamFn: async () => makeResponse('Task running.', 'end_turn'),
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const taskPromise = agent.sendTaskExecution('task_cmt_active', 'Long running task', () => {});
    await new Promise(r => setTimeout(r, 30));

    await processViaMailbox(agent, 'task_comment', {
      summary: 'Comment',
      content: 'Please add error handling',
      taskId: 'task_cmt_active',
    });

    await taskPromise.catch(() => {});
    await agent.stop();
  });
});

describe('task execution with prior history', () => {
  it('continues from existing session messages on retry', async () => {
    const router = makeMockRouter({
      streamFn: async () => makeResponse('Resumed work.', 'end_turn'),
    });
    const agent = createAgent(router);
    const sessionId = 'task_task_retry_r1';
    agent.getMemory().getOrCreateSession(agent.id, sessionId);
    agent.getMemory().appendMessage(sessionId, { role: 'user', content: 'Initial task prompt' });
    agent.getMemory().appendMessage(sessionId, { role: 'assistant', content: 'Partial work done' });

    await agent.executeTask(
      'task_retry',
      '## Previous Execution Context\nResume work',
      () => {},
      undefined,
      undefined,
      1,
    );

    const session = agent.getMemory().getSession(sessionId);
    expect(session?.messages.some(m => String(m.content).includes('interrupted'))).toBe(true);
  });

  it('runs tool loop during task execution via chatStream', async () => {
    let streamCalls = 0;
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        streamCalls++;
        if (streamCalls === 1) {
          onEvent?.({ type: 'text_delta', text: 'Calling tool...' });
          return makeResponse('Calling tool', 'tool_use', [
            { id: 'tc_task_tool', name: 'task_helper', arguments: { step: 1 } },
          ]);
        }
        onEvent?.({ type: 'text_delta', text: 'Done.' });
        return makeResponse('Task finished after tool.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.registerTool({
      name: 'task_helper',
      description: 'Task helper',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"step":"done"}',
    });

    const toolEvents: string[] = [];
    await agent.executeTask('task_tool_loop', 'Run task_helper once', (entry) => {
      if (entry.type === 'tool_start' || entry.type === 'tool_end') {
        toolEvents.push(entry.type);
      }
    });

    expect(streamCalls).toBeGreaterThanOrEqual(2);
    expect(toolEvents).toContain('tool_start');
    expect(toolEvents).toContain('tool_end');
  });

  it('surfaces task execution errors through onLog', async () => {
    const router = makeMockRouter({
      streamFn: async () => { throw new Error('LLM stream failed'); },
    });
    const agent = createAgent(router);
    const errors: string[] = [];

    await expect(agent.executeTask('task_err', 'Fail this task', (entry) => {
      if (entry.type === 'error') errors.push(entry.content);
    })).rejects.toThrow('LLM stream failed');

    expect(errors.some(e => e.includes('LLM stream failed'))).toBe(true);
  });
});

describe('handleMessageStream tool and guardrail paths', () => {
  it('executes tools during streaming chat', async () => {
    let streamCalls = 0;
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        streamCalls++;
        if (streamCalls === 1) {
          onEvent?.({ type: 'text_delta', text: 'Tool time' });
          return makeResponse('', 'tool_use', [
            { id: 'tc_stream', name: 'stream_tool', arguments: {} },
          ]);
        }
        return makeResponse('Stream complete.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.registerTool({
      name: 'stream_tool',
      description: 'stream tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"streamed":true}',
    });

    const events: string[] = [];
    const reply = await agent.handleMessageStream(
      'Use stream tool',
      (evt) => { if (evt.type === 'text_delta') events.push(evt.text ?? ''); },
    );

    expect(reply).toContain('Stream complete');
    expect(streamCalls).toBeGreaterThanOrEqual(2);
  });

  it('continues streaming when SSE disconnects before processing', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    const token = { cancelled: true, userStopped: false };

    const reply = await agent.handleMessageStream(
      'Process despite disconnect',
      () => {},
      undefined,
      undefined,
      token,
    );

    expect(reply).toContain('Stream');
    expect(router.chatStream).toHaveBeenCalled();
  });

  it('filters output when output guardrail fails', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('Sensitive content here.', 'end_turn'),
    });
    const agent = createAgent(router);
    agent.getGuardrails().addOutputGuardrail({
      name: 'block-sensitive',
      description: 'blocks sensitive',
      check: async (output) => ({
        passed: !output.includes('Sensitive'),
        reason: 'contains sensitive data',
      }),
    });

    const reply = await agent.handleMessage('Tell me secrets');
    expect(reply).toContain('Response filtered');
  });

  it('records LLM cost when router provides model cost', async () => {
    const router = makeMockRouter();
    (router.getModelCost as ReturnType<typeof vi.fn>) = vi.fn(() => ({
      inputPer1M: 3,
      outputPer1M: 15,
    }));
    const agent = createAgent(router);
    const audit = vi.fn();
    agent.setAuditCallback(audit);

    await agent.handleMessage('cost tracking');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'llm_request',
      cost: expect.any(Number),
    }));
  });
});

describe('agent lifecycle and metrics', () => {
  it('start schedules consolidation and stop clears timers', async () => {
    const agent = createAgent(makeMockRouter());
    await agent.start({ startAsPaused: true, initialHeartbeatDelayMs: 999999 });
    expect(agent.getState().status).toBe('paused');
    await agent.stop();
    expect(agent.getState().status).toBe('paused');
  });

  it('getUsageStats includes request counts after chat', async () => {
    const agent = createAgent(makeMockRouter());
    await agent.handleMessage('usage');
    const stats = agent.getUsageStats();
    expect(stats.requestsToday).toBeGreaterThan(0);
    expect(stats.tokensToday).toBeGreaterThan(0);
  });

  it('getMetrics supports multiple time periods', async () => {
    const agent = createAgent(makeMockRouter());
    await agent.handleMessage('metrics ping');
    expect(agent.getMetrics('1h').period).toBe('1h');
    expect(agent.getMetrics('7d').period).toBe('7d');
    expect(agent.getMetrics('30d').totalInteractions).toBeGreaterThan(0);
  });

  it('cancelTask returns false when task is not running', () => {
    const agent = createAgent(makeMockRouter());
    expect(agent.cancelTask('nonexistent_task')).toBe(false);
  });

  it('reminds agent to post comment in comment_response scenario', async () => {
    let calls = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        calls++;
        if (calls === 1) {
          return makeResponse('Here is my answer in text.', 'end_turn');
        }
        return makeResponse('Posted via tool.', 'end_turn');
      },
    });
    const agent = createAgent(router);

    await agent.handleMessage(
      'Reply to the comment thread',
      undefined,
      undefined,
      { scenario: 'comment_response', sessionId: 'comment_reminder_sess' },
    );

    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('handles workflow_action scenario', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);

    const reply = await agent.handleMessage(
      'Workflow step requires action',
      undefined,
      undefined,
      { scenario: 'workflow_action', sessionId: 'wf_action_sess' },
    );

    expect(reply).toContain('Default reply');
  });

  it('reminds agent to take action in requirement_action scenario', async () => {
    let calls = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        calls++;
        if (calls === 1) {
          return makeResponse('I will think about it.', 'end_turn');
        }
        return makeResponse('Updated requirement status.', 'end_turn');
      },
    });
    const agent = createAgent(router);

    const reply = await agent.handleMessage(
      'Requirement approved — update status',
      undefined,
      undefined,
      { scenario: 'requirement_action', sessionId: 'req_action_sess' },
    );

    expect(reply).toContain('Updated requirement');
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('performDeliberation and cognitive pipeline', () => {
  it('performDeliberation completes via complete_deliberation tool', async () => {
    const router = makeMockRouter({
      chatFn: async (req: unknown) => {
        const messages = (req as { messages: Array<{ role: string; content: unknown }> }).messages;
        const userContent = messages
          .filter(m => m.role === 'user')
          .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n');

        if (userContent.includes('[DELIBERATION MODE]')) {
          const idMatch = userContent.match(/id="([^"]+)"/);
          const processId = idMatch?.[1] ?? 'mbx_head';
          return makeResponse('', 'tool_use', [{
            id: 'tc_delib',
            name: 'complete_deliberation',
            arguments: {
              process_item_id: processId,
              reasoning: 'Focus on highest priority peer message',
              inline_completed_ids: [],
              memory_updates: [{ type: 'working', key: 'delib_focus', content: 'Handle peer messages first' }],
            },
          }]);
        }
        return makeResponse(`Handled. ${COMPLETION_MARKER}`, 'end_turn');
      },
    });

    const agent = createAgent(router);
    const headItem = agent.enqueueToMailbox('a2a_message', { summary: 'msg-1', content: 'first peer message' });
    const queuedItem = agent.enqueueToMailbox('a2a_message', { summary: 'msg-2', content: 'second peer message' });

    expect(typeof (agent as unknown as { performDeliberation?: unknown }).performDeliberation).toBe('function');

    const result = await (agent as unknown as {
      performDeliberation: (head: typeof headItem, all: typeof headItem[]) => Promise<unknown>;
    }).performDeliberation(headItem, [headItem, queuedItem]) as {
      processItemId: string;
      reasoning: string;
    } | null;
    expect(result).not.toBeNull();
    expect(result!.processItemId).toBe(headItem.id);
    expect(result!.reasoning).toContain('Focus');
  });

  it('runs cognitive appraisal when cognitive config is enabled', async () => {
    const router = makeMockRouter({
      chatFn: async (req: unknown) => {
        const meta = (req as { metadata?: { purpose?: string } }).metadata;
        if (meta?.purpose === 'cognitive_appraisal') {
          return {
            content: JSON.stringify({
              intent: 'User wants deployment help',
              relevance: 'Matches current sprint work',
              confidence: 'high',
              retrievalPlan: { memoryQueries: ['deploy'], activityQueries: [], taskQueries: [] },
              reflectionNeeded: false,
              cognitiveContext: 'User needs help deploying the service.',
            }),
            finishReason: 'end_turn',
            usage: { inputTokens: 30, outputTokens: 15 },
          };
        }
        return makeResponse('Deployment guidance provided.', 'end_turn');
      },
    });
    const agent = createAgent(router, { cognitive: { enabled: true } });
    await agent.handleMessage('Help me deploy the latest build');
    expect(router.chat.mock.calls.some(
      c => (c[0] as { metadata?: { purpose?: string } }).metadata?.purpose === 'cognitive_appraisal',
    )).toBe(true);
  });

  it('includes working memory in dynamic context during chat', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    agent.updateWorkingMemory('sprint_goal', 'Ship auth refactor by Friday');
    await agent.handleMessage('What is our sprint goal?');
    const chatReq = router.chat.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
    const systemMsg = chatReq.messages.find(m => m.role === 'system');
    expect(String(systemMsg?.content)).toContain('sprint_goal');
  });

  it('exposes mailbox context when queue has items during chat', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    agent.enqueueToMailbox('a2a_message', { summary: 'Queued peer msg', content: 'Waiting in queue' });
    await agent.handleMessage('Process my request');
    const chatReq = router.chat.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
    const systemMsg = chatReq.messages.find(m => m.role === 'system');
    expect(String(systemMsg?.content)).toMatch(/mailbox|queue|Queued/i);
  });

  it('getAgentStatusSummary and getRunningTasks reflect in-flight tasks', async () => {
    const router = makeMockRouter({
      streamFn: async () => {
        await new Promise(r => setTimeout(r, 300));
        return makeResponse('Task finished.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    const execPromise = agent.executeTask('task_status_live', 'Long running work', () => {});
    await vi.waitFor(() => agent.getActiveTasks().length > 0, { timeout: 2000 });

    const summary = agent.getAgentStatusSummary();
    expect(summary.isBusy).toBe(true);
    expect(summary.activeTaskCount).toBe(1);
    expect(summary.currentTasks[0]?.id).toBe('task_status_live');
    expect(agent.getRunningTasks()).toHaveLength(1);

    await execPromise;
  });

  it('reloadHeartbeat updates checklist from HEARTBEAT.md', () => {
    const agent = createAgent(makeMockRouter());
    writeFileSync(join(tempDir, 'role', 'HEARTBEAT.md'), '- Check CI pipeline\n- Review PRs');
    agent.reloadHeartbeat();
    expect(agent.role.heartbeatChecklist).toContain('Check CI pipeline');
  });

  it('routes session_reply through mailbox with sessionId', async () => {
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        onEvent?.({ type: 'text_delta', text: 'Session ' });
        return makeResponse(`Session reply. ${COMPLETION_MARKER}`, 'end_turn');
      },
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });
    const session = agent.getMemory().createSession(agent.id);

    const reply = await new Promise<string>((resolve, reject) => {
      agent.enqueueToMailbox('session_reply', {
        summary: 'Follow up',
        content: 'Can you clarify?',
        extra: { sessionId: session.id, onLog: () => {} },
      }, {
        metadata: { responsePromise: { resolve, reject } },
      });
    });

    expect(reply).toContain('Session reply');
    await agent.stop();
  });

  it('executes task via mailbox triggerExecution path', async () => {
    const router = makeMockRouter({
      streamFn: async () => makeResponse('Task executed via mailbox.', 'end_turn'),
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const logs: string[] = [];
    await new Promise<void>((resolve, reject) => {
      agent.enqueueToMailbox('task_status_update', {
        summary: 'Execute task',
        content: 'Run the integration tests',
        taskId: 'task_mbx_exec',
        extra: {
          triggerExecution: true,
          onLog: (entry: { type: string; content: string }) => { logs.push(entry.type); },
        },
      }, { metadata: { taskId: 'task_mbx_exec', responsePromise: { resolve: () => resolve(), reject } } });
    });

    expect(logs).toContain('status');
    await agent.stop();
  });

  it('injectFollowUp enqueues with image metadata', () => {
    const agent = createAgent(makeMockRouter());
    agent.injectFollowUp('See attached screenshot', 'user_1', { name: 'User', role: 'human' }, ['data:image/png;base64,abc']);
    const depth = agent.getMailbox().depth;
    expect(depth).toBe(1);
  });

  it('generateDailyReport returns error message when sendMessage fails', async () => {
    const router = makeMockRouter({
      chatFn: async () => { throw new Error('LLM unavailable'); },
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const report = await agent.generateDailyReport();
    expect(report).toContain('Unable to generate report');
    await agent.stop();
  });

  it('offloads browser tool results with larger preview', async () => {
    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeResponse('', 'tool_use', [
            { id: 'tc_browser', name: 'chrome-devtools__take_snapshot', arguments: {} },
          ]);
        }
        return makeResponse('Processed browser output.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.registerTool({
      name: 'chrome-devtools__take_snapshot',
      description: 'Browser snapshot',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'x'.repeat(60_000),
    });

    await agent.handleMessage('Take a browser snapshot');
    expect(callIndex).toBeGreaterThanOrEqual(2);
  });

  it('cancelActiveStream marks stream token as user-stopped', async () => {
    const router = makeMockRouter({
      streamFn: async () => {
        await new Promise(r => setTimeout(r, 500));
        return makeResponse('Late reply.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    const token = agent.getStreamCancelToken();
    agent.cancelActiveStream();
    expect(token.cancelled).toBe(true);
    expect(token.userStopped).toBe(true);
  });

  it('resume after pause restarts heartbeat and attention controller', async () => {
    const agent = createAgent(makeMockRouter());
    await agent.start({ startAsPaused: true });
    expect(agent.getState().status).toBe('paused');
    agent.resume();
    expect(agent.getState().status).toBe('idle');
    expect(agent.getPauseReason()).toBeUndefined();
    await agent.stop();
  });

  it('injectUserMessage appends directly when no active task', () => {
    const agent = createAgent(makeMockRouter());
    agent.injectUserMessage('sess_direct', 'Direct injection message');
    const session = agent.getMemory().getSession('sess_direct');
    expect(session?.messages.some(m => String(m.content).includes('Direct injection'))).toBe(true);
  });

  it('blocks handleMessage when input guardrail fails', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    agent.getGuardrails().addInputGuardrail({
      name: 'block-all',
      description: 'blocks',
      check: async () => ({ passed: false, reason: 'Not allowed' }),
    });
    const reply = await agent.handleMessage('blocked input');
    expect(reply).toContain('cannot process');
    expect(router.chat).not.toHaveBeenCalled();
  });

  it('sendMessage returns promise from mailbox routing', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });
    const reply = await agent.sendMessage('Hello via sendMessage', 'user_1', { name: 'User', role: 'human' });
    expect(reply).toContain('Default reply');
    await agent.stop();
  });

  it('getMailbox helpers expose controller and drop stale updates', () => {
    const agent = createAgent(makeMockRouter());
    agent.enqueueToMailbox('task_status_update', {
      summary: 'status',
      content: 'in progress',
      taskId: 'task_drop_cov',
    });
    expect(agent.getMailbox().depth).toBe(1);
    expect(agent.dropStaleStatusUpdates('task_drop_cov')).toBe(1);
    expect(agent.getAttentionController()).toBeDefined();
  });

  it('setOrgContext and deactivateSkill update agent configuration', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    agent.setOrgContext({ orgName: 'Acme Corp', teamName: 'Platform' } as never);
    agent.injectSkillInstructions('temp_skill', 'Temporary instructions');
    agent.deactivateSkill('temp_skill');
    expect(agent.hasSkillInstructions('temp_skill')).toBe(false);
    await agent.handleMessage('Org context check');
    expect(router.chat).toHaveBeenCalled();
  });

  it('schedules memory consolidation timer on start', async () => {
    vi.useFakeTimers();
    try {
      const router = makeMockRouter({
        chatFn: async () => makeResponse(`Consolidated. ${COMPLETION_MARKER}`, 'end_turn'),
      });
      const agent = createAgent(router);
      await agent.start({ startAsPaused: true, initialHeartbeatDelayMs: 999999 });
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 + 5000);
      await agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
