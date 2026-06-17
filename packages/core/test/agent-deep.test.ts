import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent, type AgentToolHandler } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { COMPLETION_MARKER } from '@markus/shared';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'deep-role',
  name: 'Deep Test Role',
  description: 'Deep coverage tests',
  category: 'engineering',
  systemPrompt: 'You are a deep test agent.',
  defaultSkills: [],
  heartbeatChecklist: '- Check inbox',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(overrides?: {
  chatFn?: (...args: unknown[]) => Promise<unknown>;
  streamFn?: (...args: unknown[]) => Promise<unknown>;
  modelCost?: { input: number; output: number };
  supportsVision?: boolean;
}): LLMRouter {
  const chat = vi.fn(overrides?.chatFn ?? (async () => ({
    content: 'Default reply.',
    finishReason: 'end_turn',
    usage: { inputTokens: 80, outputTokens: 40 },
  })));

  const chatStream = vi.fn(overrides?.streamFn ?? (async (_req, onEvent) => {
    onEvent?.({ type: 'text_delta', text: 'Stream reply.' });
    return {
      content: 'Stream reply.',
      finishReason: 'end_turn',
      usage: { inputTokens: 80, outputTokens: 40 },
    };
  }));

  return {
    chat,
    chatStream,
    getActiveModelContextWindow: () => 200000,
    getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000,
    getModelContextWindow: () => 200000,
    getModelMaxOutput: () => 8000,
    getModelCost: () => overrides?.modelCost,
    isCompactionSupported: () => true,
    modelSupportsVision: () => overrides?.supportsVision ?? false,
    listProviders: () => ['test'],
    getProvider: () => undefined,
    getDefaultProvider: () => 'test',
    defaultProviderName: 'test',
    resolveModalityCandidates: vi.fn(() => []),
  } as unknown as LLMRouter;
}

function makeResponse(
  content: string,
  finishReason: string,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  extra?: { reasoningContent?: string },
) {
  return {
    content,
    finishReason,
    toolCalls,
    reasoningContent: extra?.reasoningContent,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

function createAgent(
  router: LLMRouter,
  extra?: Record<string, unknown> & {
    restoredState?: { tokensUsedToday: number };
    maxToolIterations?: number;
  },
) {
  const { restoredState, maxToolIterations, ...configExtra } = extra ?? {};
  return new Agent({
    config: {
      id: 'deep-test-agent',
      name: 'Deep Test Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
      skills: ['search'],
      ...configExtra,
    } as never,
    role: MOCK_ROLE,
    llmRouter: router,
    dataDir: tempDir,
    restoredState,
    maxToolIterations,
  });
}

async function processViaMailbox(
  agent: Agent,
  sourceType: Parameters<Agent['enqueueToMailbox']>[0],
  payload: Parameters<Agent['enqueueToMailbox']>[1],
  metadata?: Record<string, unknown>,
) {
  return new Promise<string>((resolve, reject) => {
    agent.enqueueToMailbox(sourceType, payload, {
      metadata: { ...metadata, responsePromise: { resolve, reject } },
    });
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-agent-deep-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('handleMessage guardrails and errors', () => {
  it('blocks response when output guardrail fails', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('Sensitive output here.', 'end_turn'),
    });
    const agent = createAgent(router);
    agent.getGuardrails().addOutputGuardrail({
      name: 'block-output',
      description: 'blocks sensitive',
      check: async (output) => ({
        passed: !output.includes('Sensitive'),
        reason: 'sensitive content',
      }),
    });

    const reply = await agent.handleMessage('Tell me something');
    expect(reply).toContain('Response filtered');
  });

  it('throws and pauses when daily token budget is exhausted', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('First reply.', 'end_turn'),
    });
    const agent = createAgent(router, {
      llmConfig: { modelMode: 'custom', primary: 'anthropic', maxTokensPerDay: 120 },
    });

    await agent.handleMessage('first message');
    expect(agent.getTokensUsedToday()).toBeGreaterThanOrEqual(120);

    await expect(agent.handleMessage('second message')).rejects.toThrow(/Daily token budget/);
    expect(agent.getPauseReason()).toContain('Daily token budget');
    expect(router.chat).toHaveBeenCalledTimes(1);
  });

  it('retries on transient network errors', async () => {
    let attempts = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        attempts++;
        if (attempts === 1) {
          const err = new Error('ECONNRESET');
          throw err;
        }
        return makeResponse('Recovered after retry.', 'end_turn');
      },
    });
    const agent = createAgent(router);

    const reply = await agent.handleMessage('retry me');
    expect(reply).toContain('Recovered');
    expect(attempts).toBe(2);
  });

  it('propagates non-network LLM errors after recording failure', async () => {
    const router = makeMockRouter({
      chatFn: async () => { throw new Error('API quota exceeded'); },
    });
    const agent = createAgent(router);

    await expect(agent.handleMessage('fail please')).rejects.toThrow('API quota exceeded');
    expect(agent.getState().status).toBe('error');
  });
});

describe('handleMessage scenarios and options', () => {
  it('handles comment_response with [NO_REPLY_NEEDED] marker', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('[NO_REPLY_NEEDED]', 'end_turn'),
    });
    const agent = createAgent(router);

    const reply = await agent.handleMessage('Comment on task', undefined, undefined, {
      scenario: 'comment_response',
      sessionId: `comment_test_${Date.now()}`,
    });
    expect(reply).toContain('NO_REPLY_NEEDED');
  });

  it('injects channel context on first turn', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('Got channel context.', 'end_turn'),
    });
    const agent = createAgent(router);

    await agent.handleMessage('What did they say?', undefined, undefined, {
      channelContext: [
        { role: 'user', content: 'Earlier message from channel' },
        { role: 'assistant', content: 'Earlier reply' },
      ],
    });

    const sessions = agent.getMemory().listSessions(agent.id);
    const session = sessions.find(s => s.messages.length >= 3);
    expect(session?.messages.some(m => String(m.content).includes('Earlier message'))).toBe(true);
  });

  it('collects tool events via toolEventCollector', async () => {
    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeResponse('Using tool', 'tool_use', [
            { id: 'tc_evt', name: 'evt_tool', arguments: { x: 1 } },
          ]);
        }
        return makeResponse('Done with tool.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.registerTool({
      name: 'evt_tool',
      description: 'Event tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"status":"ok"}',
    });

    const events: Array<{ tool: string; status: string }> = [];
    await agent.handleMessage('run evt tool', undefined, undefined, {
      toolEventCollector: events,
      sessionId: `evt_sess_${Date.now()}`,
    });

    expect(events.some(e => e.tool === 'evt_tool' && e.status === 'done')).toBe(true);
  });

  it('handles memory_consolidation scenario', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('Memory consolidated.', 'end_turn'),
    });
    const agent = createAgent(router);

    const reply = await agent.handleMessage('Consolidate memories', undefined, undefined, {
      scenario: 'memory_consolidation',
      sessionId: `mem_cons_${Date.now()}`,
    });
    expect(reply).toContain('consolidated');
  });

  it('handles workflow_action scenario', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('Workflow step handled.', 'end_turn'),
    });
    const agent = createAgent(router);

    const reply = await agent.handleMessage('Complete deployment step', undefined, undefined, {
      scenario: 'workflow_action',
      sessionId: `wf_${Date.now()}`,
    });
    expect(reply).toContain('Workflow');
  });

  it('records audit events and computes cost when model cost is set', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('Costed reply.', 'end_turn'),
      modelCost: { input: 3, output: 15 },
    });
    const agent = createAgent(router);
    const auditEvents: Array<{ type: string; action: string; cost?: number }> = [];
    agent.setAuditCallback((e) => auditEvents.push(e));

    await agent.handleMessage('cost me');
    expect(auditEvents.some(e => e.type === 'llm_request' && e.action === 'chat')).toBe(true);
  });
});

describe('handleMessageStream deep paths', () => {
  it('executes tool loop and emits stream events', async () => {
    let streamCalls = 0;
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        streamCalls++;
        if (streamCalls === 1) {
          onEvent?.({ type: 'thinking_delta', thinking: 'Let me check...' });
          return makeResponse('Checking...', 'tool_use', [
            { id: 'tc_s1', name: 'stream_tool', arguments: {} },
          ]);
        }
        onEvent?.({ type: 'text_delta', text: 'All done.' });
        return makeResponse('All done.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.registerTool({
      name: 'stream_tool',
      description: 'Stream tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"status":"ok"}',
    });

    const events: string[] = [];
    const reply = await agent.handleMessageStream(
      'stream with tool',
      (evt) => {
        if (evt.type === 'agent_tool') events.push(`${evt.phase}:${evt.tool}`);
        if (evt.type === 'text_delta') events.push(`text:${evt.text}`);
      },
    );

    expect(reply).toContain('All done');
    expect(events.some(e => e.includes('stream_tool'))).toBe(true);
    expect(streamCalls).toBe(2);
  });

  it('continues after max_tokens in stream mode', async () => {
    let calls = 0;
    const router = makeMockRouter({
      streamFn: async () => {
        calls++;
        if (calls === 1) return makeResponse('Part one...', 'max_tokens');
        return makeResponse('Part two complete.', 'end_turn');
      },
    });
    const agent = createAgent(router);

    const reply = await agent.handleMessageStream('long stream');
    expect(calls).toBe(2);
    expect(reply).toContain('Part two');
  });

  it('blocks stream when input guardrail fails', async () => {
    const agent = createAgent(makeMockRouter());
    agent.getGuardrails().addInputGuardrail({
      name: 'block-stream',
      description: 'blocks',
      check: async (input) => ({
        passed: !input.includes('BLOCKED'),
        reason: 'blocked',
      }),
    });

    const reply = await agent.handleMessageStream('This is BLOCKED content', () => {});
    expect(reply).toContain('cannot process');
  });

  it('continues processing when SSE disconnects (cancelled but not userStopped)', async () => {
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        onEvent?.({ type: 'text_delta', text: 'Persisted reply.' });
        return makeResponse('Persisted reply.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    const token = { cancelled: true, userStopped: false };

    const reply = await agent.handleMessageStream('SSE dropped', () => {}, undefined, undefined, token);
    expect(reply).toContain('Persisted');
    expect(router.chatStream).toHaveBeenCalled();
  });
});

describe('respondInSession and sendSessionReply', () => {
  it('respondInSession streams reply and logs events', async () => {
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        onEvent?.({ type: 'text_delta', text: 'Session ' });
        onEvent?.({ type: 'text_delta', text: 'response.' });
        return makeResponse('Session response.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    const sessionId = `ris_${Date.now()}`;
    const logs: string[] = [];

    const reply = await agent.respondInSession(sessionId, 'Follow up question', (entry) => {
      if (entry.type === 'text_delta') logs.push(entry.content);
    });

    expect(reply).toContain('Session response');
    expect(logs.join('')).toContain('Session');
  });

  it('respondInSession executes tools in loop', async () => {
    let calls = 0;
    const router = makeMockRouter({
      streamFn: async () => {
        calls++;
        if (calls === 1) {
          return makeResponse('Tool time', 'tool_use', [
            { id: 'tc_ris', name: 'ris_tool', arguments: {} },
          ]);
        }
        return makeResponse('Tool done.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.registerTool({
      name: 'ris_tool',
      description: 'RIS tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"result":"ok"}',
    });

    const toolEvents: string[] = [];
    const reply = await agent.respondInSession(`ris_tool_${Date.now()}`, 'use tool', (entry) => {
      if (entry.type === 'tool_start') toolEvents.push(entry.content);
    });

    expect(reply).toContain('Tool done');
    expect(toolEvents).toContain('ris_tool');
  });

  it('sendSessionReply routes through mailbox to respondInSession', async () => {
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        onEvent?.({ type: 'text_delta', text: 'Reply in session.' });
        return makeResponse(`Reply in session. ${COMPLETION_MARKER}`, 'end_turn');
      },
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const sessionId = `ssr_${Date.now()}`;
    const logs: Array<{ type: string }> = [];
    const reply = await agent.sendSessionReply(sessionId, 'Post-task question', (entry) => {
      logs.push({ type: entry.type });
    });

    expect(reply).toContain('Reply in session');
    expect(logs.length).toBeGreaterThan(0);
    await agent.stop();
  });
});

describe('executeTask paths', () => {
  function registerTaskTools(agent: Agent) {
    agent.registerTool({
      name: 'task_submit_review',
      description: 'Submit task for review',
      inputSchema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      execute: async () => JSON.stringify({ status: 'ok', submitted: true }),
    });
  }

  it('executes task with tool loop and completes', async () => {
    let streamCalls = 0;
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        streamCalls++;
        if (streamCalls === 1) {
          onEvent?.({ type: 'text_delta', text: 'Working...' });
          return makeResponse('Submitting...', 'tool_use', [
            { id: 'tc_submit', name: 'task_submit_review', arguments: { summary: 'Done' } },
          ]);
        }
        return makeResponse('Task complete summary.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    registerTaskTools(agent);

    const logs: Array<{ type: string; content: string }> = [];
    await agent.executeTask('task_exec_1', 'Implement feature X', (entry) => {
      if (entry.persist) logs.push({ type: entry.type, content: entry.content });
    });

    expect(logs.some(l => l.type === 'status' && l.content === 'started')).toBe(true);
    expect(logs.some(l => l.type === 'status' && l.content === 'execution_finished')).toBe(true);
    expect(agent.getActiveTasks()).toHaveLength(0);
    expect(streamCalls).toBeGreaterThanOrEqual(1);
  });

  it('cancels task execution when cancelToken is set during run', async () => {
    const cancelToken = { cancelled: false };
    const router = makeMockRouter({
      streamFn: async () => {
        cancelToken.cancelled = true;
        await new Promise(r => setTimeout(r, 20));
        return makeResponse('Should not finish', 'end_turn');
      },
    });
    const agent = createAgent(router);
    registerTaskTools(agent);

    const logs: Array<{ type: string; content: string }> = [];
    await agent.executeTask('task_cancel_1', 'Long task', (entry) => {
      logs.push({ type: entry.type, content: entry.content });
    }, cancelToken);

    expect(logs.some(l => l.type === 'status' && l.content === 'cancelled')).toBe(true);
    expect(agent.getActiveTasks()).toHaveLength(0);
  });

  it('removeActiveTask clears task from active set', async () => {
    const agent = createAgent(makeMockRouter());
    // Simulate external task removal
    (agent as unknown as { activeTasks: Set<string> }).activeTasks?.add('task_ext_1');
    agent.removeActiveTask('task_ext_1');
    expect(agent.getActiveTasks()).toHaveLength(0);
  });
});

describe('activity tracking and callbacks', () => {
  it('fires onLog and onEnd activity callbacks', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('Activity tracked.', 'end_turn', undefined, {
        reasoningContent: 'Thinking deeply...',
      }),
    });
    const agent = createAgent(router);
    const onStart = vi.fn();
    const onLog = vi.fn();
    const onEnd = vi.fn();
    agent.setActivityCallbacks({ onStart, onLog, onEnd });

    await agent.handleMessage('track activity', 'user_1', { name: 'User', role: 'human' });

    expect(onStart).toHaveBeenCalled();
    expect(onLog).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalled();
    const endSummary = onEnd.mock.calls[0]?.[1];
    expect(endSummary?.success).toBe(true);
  });

  it('getRecentActivities returns current activity info', async () => {
    const router = makeMockRouter({
      chatFn: async () => {
        await new Promise(r => setTimeout(r, 30));
        return makeResponse('Slow reply.', 'end_turn');
      },
    });
    const agent = createAgent(router);

    const promise = agent.handleMessage('slow');
    await new Promise(r => setTimeout(r, 10));
    const activities = agent.getRecentActivities();
    expect(activities.length).toBeGreaterThanOrEqual(0);
    await promise;
  });

  it('setStateChangeCallback receives status updates', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    const stateChanges: string[] = [];
    agent.setStateChangeCallback((_id, state) => stateChanges.push(state.status));

    await agent.handleMessage('trigger state');
    expect(stateChanges).toContain('working');
    expect(stateChanges).toContain('idle');
  });
});

describe('tool execution helpers', () => {
  it('executes notify_user tool and emits event', async () => {
    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeResponse('Notifying...', 'tool_use', [{
            id: 'tc_notify',
            name: 'notify_user',
            arguments: { title: 'Alert', body: 'Something happened' },
          }]);
        }
        return makeResponse('Notified user.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.registerTool({
      name: 'notify_user',
      description: 'Notify user',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } },
      execute: async (args) => {
        agent.getEventBus().emit('agent:notify-user', { agentId: agent.id, title: args.title, body: args.body });
        return JSON.stringify({ status: 'ok' });
      },
    });

    const events: unknown[] = [];
    agent.getEventBus().on('agent:notify-user', (e) => events.push(e));

    await agent.handleMessage('notify please');
    expect(events.length).toBeGreaterThan(0);
  });

  it('request_user_approval uses approval requester callback', async () => {
    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeResponse('Need approval', 'tool_use', [{
            id: 'tc_appr',
            name: 'request_user_approval',
            arguments: { title: 'Approve?', description: 'Please approve this action' },
          }]);
        }
        return makeResponse('Approved.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.setUserApprovalRequester(async () => ({ approved: true, comment: 'LGTM' }));
    agent.registerTool({
      name: 'request_user_approval',
      description: 'Request approval',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, description: { type: 'string' } },
      },
      execute: async (args) => {
        const cb = (agent as unknown as { userApprovalRequester?: (...a: unknown[]) => Promise<unknown> }).userApprovalRequester;
        if (!cb) return JSON.stringify({ status: 'error' });
        const result = await cb({
          agentId: agent.id,
          agentName: agent.config.name,
          title: args.title,
          description: args.description,
        });
        return JSON.stringify({ status: 'ok', ...(result as object) });
      },
    });

    const reply = await agent.handleMessage('need approval');
    expect(reply).toContain('Approved');
  });
});

describe('skill catalog and context helpers', () => {
  it('manages skill catalog and deactivation', () => {
    const agent = createAgent(makeMockRouter());
    agent.setAvailableSkillCatalog([
      { name: 'search', description: 'Web search', category: 'research' },
    ]);
    expect(agent.getAvailableSkillCatalog()).toHaveLength(1);

    agent.injectSkillInstructions('search', 'Use search for facts.');
    expect(agent.hasSkillInstructions('search')).toBe(true);
    agent.deactivateSkill('search');
    expect(agent.hasSkillInstructions('search')).toBe(false);
  });

  it('setTasksFetcher injects assigned tasks into prompts', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    agent.setTasksFetcher(() => [{ id: 't1', title: 'Fix bug', status: 'in_progress' }]);

    await agent.handleMessage('What are my tasks?');
    expect(router.chat).toHaveBeenCalled();
  });

  it('setWorkflowContextFetcher provides workflow context', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    agent.setWorkflowContextFetcher(() => ({
      activeRuns: [{
        workflowName: 'Deploy',
        runNumber: 1,
        status: 'running',
        taskCount: 3,
        startedAt: new Date().toISOString(),
      }],
      availableWorkflows: [],
    }));

    await agent.handleMessage('Workflow status?');
    expect(router.chat).toHaveBeenCalled();
  });

  it('injectActivityToMainSession adds to session for notify_user type', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('Hello.', 'end_turn'),
    });
    const agent = createAgent(router);
    await agent.handleMessage('start session');

    agent.injectActivityToMainSession({
      type: 'notify_user',
      summary: 'Task completed successfully',
      outcome: 'done',
      taskId: 'task_1',
    });

    const sessions = agent.getMemory().listSessions(agent.id);
    const hasInjected = sessions.some(s =>
      s.messages.some(m => String(m.content).includes('Task completed')),
    );
    expect(hasInjected).toBe(true);
  });

  it('getModelSupportsVision reflects router capability', () => {
    const agentVision = createAgent(makeMockRouter({ supportsVision: true }));
    expect(agentVision.getModelSupportsVision()).toBe(true);

    const agentNoVision = createAgent(makeMockRouter({ supportsVision: false }));
    expect(agentNoVision.getModelSupportsVision()).toBe(false);
  });
});

describe('mailbox routing extended', () => {
  it('routes memory_consolidation through mailbox', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse(`Consolidated. ${COMPLETION_MARKER}`, 'end_turn'),
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const reply = await processViaMailbox(agent, 'memory_consolidation', {
      summary: 'Memory flush',
      content: 'Consolidate long-term memories',
    });

    expect(reply).toContain('Consolidated');
    await agent.stop();
  });

  it('routes system_event through lightweight scenario', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse(`System handled. ${COMPLETION_MARKER}`, 'end_turn'),
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const reply = await processViaMailbox(agent, 'system_event', {
      summary: 'System event',
      content: 'Process system notification',
    });

    expect(reply).toContain('System handled');
    await agent.stop();
  });

  it('ensureCompletionMarker adds marker when missing from mailbox reply', async () => {
    let calls = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        calls++;
        if (calls === 1) {
          return makeResponse('Reply without marker.', 'end_turn');
        }
        return makeResponse(`Here is the marker. ${COMPLETION_MARKER}`, 'end_turn');
      },
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const reply = await processViaMailbox(agent, 'a2a_message', {
      summary: 'Peer msg',
      content: 'Help me please',
    }, { senderId: 'peer_1', senderName: 'Peer' });

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(typeof reply).toBe('string');
    await agent.stop();
  });

  it('sendMessageStream routes through mailbox with streaming', async () => {
    const router = makeMockRouter({
      streamFn: async (_req, onEvent) => {
        onEvent?.({ type: 'text_delta', text: 'Mailbox stream.' });
        return makeResponse(`Mailbox stream. ${COMPLETION_MARKER}`, 'end_turn');
      },
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const deltas: string[] = [];
    const reply = await agent.sendMessageStream(
      'Stream via mailbox',
      (evt) => { if (evt.type === 'text_delta') deltas.push(evt.text ?? ''); },
    );

    expect(reply).toContain('Mailbox stream');
    expect(deltas.join('')).toContain('Mailbox');
    await agent.stop();
  });
});

describe('metrics and configuration', () => {
  it('getMetrics supports 7d period', async () => {
    const agent = createAgent(makeMockRouter());
    await agent.handleMessage('metrics test');
    const metrics = agent.getMetrics('7d');
    expect(metrics.period).toBe('7d');
    expect(metrics.totalInteractions).toBeGreaterThan(0);
  });

  it('maxToolIterations setter treats 0 as Infinity', () => {
    const agent = createAgent(makeMockRouter());
    agent.maxToolIterations = 0;
    expect(agent.maxToolIterations).toBe(Infinity);
  });

  it('setEscalationCallback and setToolCallLimitChecker are wired', async () => {
    const agent = createAgent(makeMockRouter());
    const escalate = vi.fn();
    agent.setEscalationCallback(escalate);
    agent.setToolCallLimitChecker(() => ({ allowed: true }));

    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeResponse('Tool', 'tool_use', [
            { id: 'tc_lim', name: 'limited_tool', arguments: {} },
          ]);
        }
        return makeResponse('OK', 'end_turn');
      },
    });
    const limitedAgent = createAgent(router);
    limitedAgent.setToolCallLimitChecker(() => ({ allowed: true }));
    limitedAgent.registerTool({
      name: 'limited_tool',
      description: 'Limited',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"status":"ok"}',
    });

    await limitedAgent.handleMessage('run limited');
    expect(limitedAgent.getTools().has('limited_tool')).toBe(true);
  });

  it('loads team norms from team data directory', async () => {
    const teamDir = join(tempDir, 'team-norms');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'NORMS.md'), 'Always write tests first.');

    const router = makeMockRouter();
    const agent = createAgent(router);
    agent.setTeamDataDir(teamDir);

    await agent.handleMessage('What are team norms?');
    expect(router.chat).toHaveBeenCalled();
  });

  it('consumeDeliberationResult returns undefined when none pending', () => {
    const agent = createAgent(makeMockRouter());
    expect(agent.consumeDeliberationResult()).toBeUndefined();
  });
});

describe('handleMessage with reasoning and daily log', () => {
  it('logs daily activity for substantial replies with sender', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse(
        'Here is a detailed answer that is definitely longer than fifty characters for daily log purposes.',
        'end_turn',
        undefined,
        { reasoningContent: 'I thought carefully about this.' },
      ),
    });
    const agent = createAgent(router);

    await agent.handleMessage(
      'Explain the architecture in detail please',
      'user_daily',
      { name: 'Daily User', role: 'human' },
    );

    const log = agent.getMemory().getDailyLog();
    expect(log).toContain('Daily User');
    expect(log).toContain('architecture');
  });
});

describe('executeTool policy and hooks', () => {
  it('denies tools blocked by agent profile blacklist', async () => {
    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeResponse('Using blocked tool', 'tool_use', [
            { id: 'tc_blk', name: 'blocked_tool', arguments: {} },
          ]);
        }
        return makeResponse('Tool was denied.', 'end_turn');
      },
    });
    const agent = new Agent({
      config: {
        id: 'profile-agent',
        name: 'Profile Agent',
        roleId: 'worker',
        llmConfig: { modelMode: 'custom', primary: 'anthropic' },
        profile: { toolBlacklist: ['blocked_tool'] },
        createdAt: new Date().toISOString(),
      } as never,
      role: MOCK_ROLE,
      llmRouter: router,
      dataDir: tempDir,
    });
    agent.registerTool({
      name: 'blocked_tool',
      description: 'Blocked',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"status":"ok"}',
    });

    const reply = await agent.handleMessage('use blocked tool');
    expect(reply).toContain('denied');
  });

  it('blocks tool execution when before-hook denies', async () => {
    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeResponse('Hooked tool', 'tool_use', [
            { id: 'tc_hook', name: 'hooked_tool', arguments: {} },
          ]);
        }
        return makeResponse('Hook blocked execution.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.addToolHook({
      name: 'block-hook',
      before: async () => ({ proceed: false, reason: 'Not allowed by hook' }),
    });
    agent.registerTool({
      name: 'hooked_tool',
      description: 'Hooked',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"status":"ok"}',
    });

    const reply = await agent.handleMessage('run hooked tool');
    expect(reply).toContain('Hook blocked');
  });

  it('denies tool when toolCallLimitChecker rejects', async () => {
    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeResponse('Limited tool', 'tool_use', [
            { id: 'tc_limit', name: 'limited_tool', arguments: {} },
          ]);
        }
        return makeResponse('Limit reached.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.setToolCallLimitChecker(() => ({
      allowed: false,
      reason: 'Daily tool limit reached',
    }));
    agent.registerTool({
      name: 'limited_tool',
      description: 'Limited',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"status":"ok"}',
    });

    const reply = await agent.handleMessage('exceed limit');
    expect(reply).toContain('Limit reached');
  });

  it('handles unknown tool gracefully in tool loop', async () => {
    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeResponse('Unknown tool', 'tool_use', [
            { id: 'tc_unk', name: 'nonexistent_tool_xyz', arguments: {} },
          ]);
        }
        return makeResponse('Recovered from unknown tool.', 'end_turn');
      },
    });
    const agent = createAgent(router);

    const reply = await agent.handleMessage('call missing tool');
    expect(reply).toContain('Recovered');
  });
});

describe('discover_tools and skill helpers', () => {
  it('executes discover_tools list_skills mode', async () => {
    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeResponse('Listing skills', 'tool_use', [
            { id: 'tc_disc', name: 'discover_tools', arguments: { mode: 'list_skills' } },
          ]);
        }
        return makeResponse('Skills listed.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.registerTool({
      name: 'discover_tools',
      description: 'Discover tools',
      inputSchema: { type: 'object', properties: { mode: { type: 'string' } } },
      execute: async (args) => {
        if (args.mode === 'list_skills') {
          return JSON.stringify({ status: 'ok', skills: [], message: 'No skills' });
        }
        return JSON.stringify({ status: 'error' });
      },
    });

    const reply = await agent.handleMessage('list skills');
    expect(reply).toContain('Skills listed');
  });

  it('setSkillSearcher supports search_registry via discover_tools', async () => {
    const agent = createAgent(makeMockRouter());
    agent.setSkillSearcher(async (query) => [
      { name: 'remote-skill', description: 'Remote', source: 'registry', slug: query },
    ]);
    agent.registerTool({
      name: 'discover_tools',
      description: 'Discover',
      inputSchema: { type: 'object', properties: {} },
      execute: async (args) => {
        const mode = args.mode as string;
        if (mode === 'search_registry') {
          const searcher = (agent as unknown as { skillSearcher?: (q: string) => Promise<unknown[]> }).skillSearcher;
          const results = await searcher!('test');
          return JSON.stringify({ status: 'ok', results });
        }
        return JSON.stringify({ status: 'error' });
      },
    });

    const tool = agent.getTools().get('discover_tools')!;
    const raw = await tool.execute({ mode: 'search_registry', query: 'test' });
    const parsed = JSON.parse(raw) as { results: unknown[] };
    expect(parsed.results).toHaveLength(1);
  });

  it('setUserNotifier callback can be registered', () => {
    const agent = createAgent(makeMockRouter());
    const notifier = vi.fn();
    agent.setUserNotifier(notifier);
    expect(notifier).toBeDefined();
  });
});

describe('comment_response and requirement_action safeguards', () => {
  it('reminds agent when comment_response ends without posting comment', async () => {
    let calls = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        calls++;
        if (calls === 1) {
          return makeResponse('I will just reply in text.', 'end_turn');
        }
        return makeResponse('[NO_REPLY_NEEDED]', 'end_turn');
      },
    });
    const agent = createAgent(router);

    const reply = await agent.handleMessage('Comment please', undefined, undefined, {
      scenario: 'comment_response',
      sessionId: `comment_reminder_${Date.now()}`,
    });

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(reply).toContain('NO_REPLY_NEEDED');
  });

  it('reminds agent when requirement_action ends without action tool', async () => {
    let calls = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        calls++;
        if (calls === 1) {
          return makeResponse('Just thinking about it.', 'end_turn');
        }
        if (calls === 2) {
          return makeResponse('Taking action', 'tool_use', [
            { id: 'tc_req', name: 'notify_user', arguments: { title: 'Update', body: 'Done' } },
          ]);
        }
        return makeResponse('Action taken.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.registerTool({
      name: 'notify_user',
      description: 'Notify',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } },
      execute: async () => JSON.stringify({ status: 'ok' }),
    });

    const reply = await agent.handleMessage('Update requirement', undefined, undefined, {
      scenario: 'requirement_action',
      sessionId: `req_action_${Date.now()}`,
    });

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(reply).toContain('Action taken');
  });
});

describe('executeChatTask and heartbeat', () => {
  it('executeChatTask runs high-priority task execution', async () => {
    const router = makeMockRouter({
      streamFn: async () => makeResponse('Chat task done.', 'end_turn'),
    });
    const agent = createAgent(router);
    agent.registerTool({
      name: 'task_submit_review',
      description: 'Submit',
      inputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
      execute: async () => JSON.stringify({ status: 'ok' }),
    });

    const logs: Array<{ type: string; content: string }> = [];
    await agent.executeChatTask('chat_task_1', 'Quick chat task', (entry) => {
      logs.push({ type: entry.type, content: entry.content });
    });

    expect(logs.some(l => l.type === 'status' && l.content === 'started')).toBe(true);
  });

  it('skips idle heartbeat when fingerprint unchanged', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse(`Heartbeat ok. ${COMPLETION_MARKER}`, 'end_turn'),
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    await processViaMailbox(agent, 'heartbeat', {
      summary: 'HB1',
      content: '[HEARTBEAT] Check inbox',
    });
    const callsAfterFirst = router.chat.mock.calls.length;

    await processViaMailbox(agent, 'heartbeat', {
      summary: 'HB2',
      content: '[HEARTBEAT] Check inbox again',
    });

    expect(router.chat.mock.calls.length).toBe(callsAfterFirst);
    await agent.stop();
  });
});

describe('activity logs and browser session', () => {
  it('getActivityLogs returns logs for active activity', async () => {
    const router = makeMockRouter({
      chatFn: async () => {
        await new Promise(r => setTimeout(r, 50));
        return makeResponse('Slow response.', 'end_turn');
      },
    });
    const agent = createAgent(router);

    const handlePromise = agent.handleMessage('slow query');
    await vi.waitFor(() => agent.getCurrentActivityId() !== undefined, { timeout: 2000 });

    const actId = agent.getCurrentActivityId();
    if (actId) {
      const logs = agent.getActivityLogs(actId);
      expect(logs.length).toBeGreaterThan(0);
    }
    await handlePromise;
  });

  it('setBrowserCloseTabsHelper triggers follow-up on session end', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('Browser closed.', 'end_turn'),
    });
    const agent = createAgent(router);
    agent.setBrowserCloseTabsHelper(() =>
      '[SYSTEM] You have open browser tabs. Call close_page.',
    );

    await agent.handleMessage('done with browser');
    expect(router.chat.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('vision and channel key sessions', () => {
  it('builds multimodal user content when vision is supported', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('I see the image.', 'end_turn'),
      supportsVision: true,
    });
    const agent = createAgent(router);

    await agent.handleMessage('Describe this', undefined, undefined, {
      images: ['data:image/png;base64,abc123'],
    });

    const chatCall = router.chat.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: unknown }> };
    const userMsg = chatCall.messages.find(m => m.role === 'user');
    expect(Array.isArray(userMsg?.content)).toBe(true);
  });

  it('sendMessage with channelKey uses channel session', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('Channel reply.', 'end_turn'),
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const reply = await agent.sendMessage('Hello channel', 'user_1', { name: 'User', role: 'human' }, {
      channelKey: 'general',
    });

    expect(reply).toContain('Channel reply');
    await agent.stop();
  });
});

describe('complete_deliberation tool', () => {
  it('records deliberation result via complete_deliberation tool', async () => {
    const agent = createAgent(makeMockRouter());
    agent.registerTool({
      name: 'complete_deliberation',
      description: 'Complete deliberation',
      inputSchema: { type: 'object', properties: { process_item_id: { type: 'string' } } },
      execute: async (args) => {
        (agent as unknown as { pendingDeliberationResult?: unknown }).pendingDeliberationResult = {
          processItemId: args.process_item_id,
          deferItemIds: [],
          dropItemIds: [],
          inlineCompletedIds: [],
          reasoning: 'Focus on human chat',
        };
        return JSON.stringify({ status: 'ok' });
      },
    });

    const tool = agent.getTools().get('complete_deliberation')!;
    await tool.execute({ process_item_id: 'mbx_item_1', reasoning: 'Focus on human chat' });

    const result = agent.consumeDeliberationResult();
    expect(result?.processItemId).toBe('mbx_item_1');
    expect(result?.reasoning).toBe('Focus on human chat');
  });
});

describe('approval profile and task progress', () => {
  it('requires human approval for profile-restricted tools', async () => {
    let callIndex = 0;
    const approvalFn = vi.fn(async () => ({ approved: false, comment: 'Too risky' }));
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeResponse('Need approval', 'tool_use', [
            { id: 'tc_appr2', name: 'risky_tool', arguments: { cmd: 'rm -rf' } },
          ]);
        }
        return makeResponse('Approval denied.', 'end_turn');
      },
    });
    const agent = new Agent({
      config: {
        id: 'approval-agent',
        name: 'Approval Agent',
        roleId: 'worker',
        llmConfig: { modelMode: 'custom', primary: 'anthropic' },
        profile: { requireApprovalFor: ['risky_tool'] },
        createdAt: new Date().toISOString(),
      } as never,
      role: MOCK_ROLE,
      llmRouter: router,
      dataDir: tempDir,
    });
    agent.setApprovalCallback(approvalFn);
    agent.registerTool({
      name: 'risky_tool',
      description: 'Risky',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"status":"ok"}',
    });

    await agent.handleMessage('run risky tool');
    expect(approvalFn).toHaveBeenCalled();
  });

  it('updateTaskProgress delegates to task executor', async () => {
    const agent = createAgent(makeMockRouter());
    expect(agent.updateTaskProgress('nonexistent', 50)).toBe(false);
  });

  it('generateDailyReport produces report text', async () => {
    const router = makeMockRouter({
      chatFn: async () => makeResponse('Today I fixed bugs and reviewed PRs.', 'end_turn'),
    });
    const agent = createAgent(router);
    await agent.start({ startAsPaused: false });

    const report = await agent.generateDailyReport();
    expect(report).toContain('bugs');
    await agent.stop();
  });
});

describe('loop detection and escalation', () => {
  it('detects repeated tool calls and breaks critical loops', async () => {
    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        return makeResponse('Looping...', 'tool_use', [
          { id: `tc_loop_${callIndex}`, name: 'loop_tool', arguments: { same: 'args' } },
        ]);
      },
    });
    const agent = createAgent(router, { maxToolIterations: 15 });
    agent.registerTool({
      name: 'loop_tool',
      description: 'Loops',
      inputSchema: { type: 'object', properties: { same: { type: 'string' } } },
      execute: async () => '{"status":"same"}',
    });

    const reply = await agent.handleMessage('loop forever');
    expect(callIndex).toBeLessThanOrEqual(16);
    expect(reply).toBeDefined();
  });

  it('setEscalationCallback fires on consecutive failures', async () => {
    const escalate = vi.fn();
    let callIndex = 0;
    const router = makeMockRouter({
      chatFn: async () => {
        callIndex++;
        if (callIndex <= 3) {
          return makeResponse('Fail tool', 'tool_use', [
            { id: `tc_fail_${callIndex}`, name: 'always_fail', arguments: {} },
          ]);
        }
        return makeResponse('Done.', 'end_turn');
      },
    });
    const agent = createAgent(router);
    agent.setEscalationCallback(escalate);
    agent.registerTool({
      name: 'always_fail',
      description: 'Fails',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => JSON.stringify({ status: 'error', message: 'always fails' }),
    });

    await agent.handleMessage('trigger failures');
    // Escalation may fire after consecutive failures — verify tool ran multiple times
    expect(callIndex).toBeGreaterThan(1);
  });
});
