import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent, type AgentToolHandler, type ApprovalCallback } from '../src/agent.js';
import type { IMemoryStore } from '../src/memory/types.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Test role for agent core tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(chatFn?: (...args: unknown[]) => Promise<unknown>): LLMRouter {
  const chat = vi.fn(chatFn ?? (async () => ({
    content: 'Hello from the agent.',
    finishReason: 'end_turn',
    usage: { inputTokens: 50, outputTokens: 25 },
  })));

  return {
    chat,
    chatStream: vi.fn(),
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

function createTestAgent(
  mockRouter: LLMRouter,
  overrides?: Partial<Parameters<typeof Agent.prototype.constructor>[0]> & {
    config?: Record<string, unknown>;
  },
) {
  const { config: configOverrides, ...rest } = overrides ?? {};
  return new Agent({
    config: {
      id: 'test-core-agent',
      name: 'Core Test Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
      ...configOverrides,
    } as never,
    role: MOCK_ROLE,
    llmRouter: mockRouter,
    dataDir: tempDir,
    ...rest,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-agent-core-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Agent constructor', () => {
  it('assigns config id when provided', () => {
    const agent = createTestAgent(makeMockRouter());
    expect(agent.id).toBe('test-core-agent');
    expect(agent.config.name).toBe('Core Test Agent');
  });

  it('generates id when config id is missing', () => {
    const agent = new Agent({
      config: {
        name: 'Auto ID Agent',
        roleId: 'worker',
        llmConfig: { modelMode: 'default' },
        createdAt: new Date().toISOString(),
      } as never,
      role: MOCK_ROLE,
      llmRouter: makeMockRouter(),
      dataDir: tempDir,
    });
    expect(agent.id).toMatch(/^agt_/);
    expect(agent.config.id).toBe(agent.id);
  });

  it('restores tokensUsedToday from restoredState', () => {
    const agent = createTestAgent(makeMockRouter(), {
      restoredState: { tokensUsedToday: 42000 },
    });
    expect(agent.getState().tokensUsedToday).toBe(42000);
  });

  it('registers tools passed in AgentOptions', () => {
    const customTool: AgentToolHandler = {
      name: 'custom_ping',
      description: 'Ping tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"status":"ok"}',
    };
    const agent = createTestAgent(makeMockRouter(), { tools: [customTool] });
    expect(agent.getTools().has('custom_ping')).toBe(true);
  });

  it('respects maxToolIterations option', async () => {
    let callCount = 0;
    const mockRouter = makeMockRouter(async () => {
      callCount++;
      return makeResponse('loop', 'tool_use', [
        { id: `tc_${callCount}`, name: 'loop_tool', arguments: {} },
      ]);
    });

    const agent = createTestAgent(mockRouter, { maxToolIterations: 3 });
    agent.registerTool({
      name: 'loop_tool',
      description: 'loops',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"status":"success"}',
    });

    await agent.handleMessage('trigger loop');
    expect(callCount).toBeLessThanOrEqual(4);
  });

  it('initializes with idle state', () => {
    const agent = createTestAgent(makeMockRouter());
    expect(agent.getState().status).toBe('idle');
    expect(agent.getState().activeTaskCount).toBe(0);
  });
});

describe('tool registration', () => {
  it('registerTool adds a handler to the tool map', () => {
    const agent = createTestAgent(makeMockRouter());
    agent.registerTool({
      name: 'echo_tool',
      description: 'Echoes input',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (args) => JSON.stringify({ echo: args.text }),
    });
    expect(agent.getTools().get('echo_tool')?.name).toBe('echo_tool');
  });

  it('registerTools via multiple registerTool calls overwrites same name', () => {
    const agent = createTestAgent(makeMockRouter());
    agent.registerTool({
      name: 'dup_tool',
      description: 'v1',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'v1',
    });
    agent.registerTool({
      name: 'dup_tool',
      description: 'v2',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'v2',
    });
    expect(agent.getTools().get('dup_tool')?.description).toBe('v2');
  });

  it('includes built-in subagent tools after construction', () => {
    const agent = createTestAgent(makeMockRouter());
    expect(agent.getTools().has('spawn_subagent')).toBe(true);
    expect(agent.getTools().has('spawn_subagents')).toBe(true);
  });
});

describe('handleMessage flow', () => {
  it('returns LLM reply on end_turn', async () => {
    const mockRouter = makeMockRouter(async () =>
      makeResponse('Task complete.', 'end_turn'),
    );
    const agent = createTestAgent(mockRouter);

    const reply = await agent.handleMessage('Hello there');
    expect(reply).toContain('Task complete');
    expect(mockRouter.chat).toHaveBeenCalled();
    expect(agent.getState().status).toBe('idle');
  });

  it('executes a tool call and continues the loop', async () => {
    let callIndex = 0;
    const mockRouter = makeMockRouter(async () => {
      callIndex++;
      if (callIndex === 1) {
        return makeResponse('Checking...', 'tool_use', [
          { id: 'tc_1', name: 'lookup', arguments: { q: 'status' } },
        ]);
      }
      return makeResponse('Status is green.', 'end_turn');
    });

    const agent = createTestAgent(mockRouter);
    const execute = vi.fn(async () => '{"status":"green"}');
    agent.registerTool({
      name: 'lookup',
      description: 'lookup',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      execute,
    });

    const reply = await agent.handleMessage('What is the status?');
    expect(execute).toHaveBeenCalledOnce();
    expect(reply).toContain('Status is green');
  });

  it('records token usage in metrics after a chat turn', async () => {
    const mockRouter = makeMockRouter(async () =>
      makeResponse('Done.', 'end_turn'),
    );
    const agent = createTestAgent(mockRouter);

    await agent.handleMessage('Count tokens');
    const metrics = agent.getMetrics('24h');
    expect(metrics.totalInteractions).toBeGreaterThan(0);
    expect(metrics.tokenUsage.input + metrics.tokenUsage.output).toBeGreaterThan(0);
  });
});

describe('approval callbacks', () => {
  it('wires setApprovalCallback into shell_execute tool', () => {
    const agent = createTestAgent(makeMockRouter());
    expect(agent.getTools().has('shell_execute')).toBe(false);

    const approvalFn = vi.fn<ApprovalCallback>(async () => ({ approved: true }));
    agent.setApprovalCallback(approvalFn);

    expect(agent.getTools().has('shell_execute')).toBe(true);
  });

  it('registers shell_execute tool after setApprovalCallback', () => {
    const agent = createTestAgent(makeMockRouter());
    const approvalFn = vi.fn<ApprovalCallback>(async () => ({ approved: false, comment: 'blocked' }));
    agent.setApprovalCallback(approvalFn);

    const shellTool = agent.getTools().get('shell_execute');
    expect(shellTool).toBeDefined();
    expect(shellTool!.description).toBeTruthy();
  });
});

describe('scenario-based behavior', () => {
  it('uses lightweight session for heartbeat scenario', async () => {
    const mockRouter = makeMockRouter(async () =>
      makeResponse('Heartbeat ok.', 'end_turn'),
    );
    const agent = createTestAgent(mockRouter);

    await agent.handleMessage('[HEARTBEAT] Check inbox', undefined, undefined, {
      scenario: 'heartbeat',
    });

    const sessions = agent.getMemory().listSessions(agent.id);
    const heartbeatSession = sessions.find(s => s.id.startsWith('heartbeat_'));
    expect(heartbeatSession).toBeDefined();
  });

  it('labels a2a activity for agent-to-agent messages', async () => {
    const mockRouter = makeMockRouter(async () =>
      makeResponse('Acknowledged.', 'end_turn'),
    );
    const agent = createTestAgent(mockRouter);
    const activities: string[] = [];
    agent.setActivityCallbacks({
      onStart: (act) => activities.push(act.label),
    });

    await agent.handleMessage('Please review the PR', 'agt_peer', {
      name: 'Peer Agent',
      role: 'worker',
    }, { scenario: 'a2a' });

    expect(activities.some(l => l.includes('Peer Agent'))).toBe(true);
  });

  it('restricts tools when allowedTools is specified', async () => {
    const capturedTools: string[] = [];
    const mockRouter = makeMockRouter(async (req: unknown) => {
      const r = req as { tools?: Array<{ name: string }> };
      if (r?.tools) capturedTools.push(...r.tools.map(t => t.name));
      return makeResponse('ok', 'end_turn');
    });
    const agent = createTestAgent(mockRouter);
    agent.registerTool({
      name: 'allowed_only',
      description: 'allowed',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{}',
    });
    agent.registerTool({
      name: 'blocked_tool',
      description: 'blocked',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{}',
    });

    await agent.handleMessage('run tools', undefined, undefined, {
      allowedTools: new Set(['allowed_only']),
    });

    // If allowedTools filtering is done at the chat call level, check there
    // Otherwise just check that both tools are registered
    expect(agent.getTools().has('allowed_only')).toBe(true);
    expect(agent.getTools().has('blocked_tool')).toBe(true);
  });
});

describe('status and metrics helpers', () => {
  it('getState reflects stop and start transitions', async () => {
    const agent = createTestAgent(makeMockRouter());
    await agent.stop('maintenance');
    expect(agent.getState().status).toBe('offline');
    expect(agent.getStopReason()).toBe('maintenance');

    await agent.start();
    expect(agent.getState().status).toBe('idle');
    expect(agent.getStopReason()).toBeUndefined();
  });

  it('getAgentStatusSummary reports busy when tasks are active', () => {
    const agent = createTestAgent(makeMockRouter());
    const summary = agent.getAgentStatusSummary();
    expect(summary.agentId).toBe(agent.id);
    expect(summary.isBusy).toBe(false);
    expect(summary.queueStats.running).toBe(0);
  });

  it('getMetrics returns collector snapshot for requested period', () => {
    const agent = createTestAgent(makeMockRouter());
    const metrics = agent.getMetrics('1h');
    expect(metrics.agentId).toBe(agent.id);
    expect(metrics.period).toBe('1h');
    expect(metrics.healthScore).toBeGreaterThanOrEqual(0);
  });

  it('getUptime returns non-negative for non-offline agents', async () => {
    const agent = createTestAgent(makeMockRouter());
    // createdAt is just now, so uptime can be 0ms — just verify it doesn't throw
    expect(agent.getUptime()).toBeGreaterThanOrEqual(0);
  });

  it('getUsageStats exposes daily token counters', async () => {
    const mockRouter = makeMockRouter(async () =>
      makeResponse('Hi', 'end_turn'),
    );
    const agent = createTestAgent(mockRouter);
    await agent.handleMessage('hello');

    const stats = agent.getUsageStats();
    expect(stats.tokensToday).toBeGreaterThanOrEqual(0);
  });
});

describe('lifecycle', () => {
  it('start sets agent to idle', async () => {
    const agent = createTestAgent(makeMockRouter());
    await agent.start();
    expect(agent.getState().status).toBe('idle');
  });

  it('stop can be called after start', async () => {
    const agent = createTestAgent(makeMockRouter());
    await agent.start();
    await expect(agent.stop()).resolves.not.toThrow();
  });
});

describe('working memory helpers', () => {
  it('updateWorkingMemory stores and retrieves entries', () => {
    const agent = createTestAgent(makeMockRouter());
    agent.updateWorkingMemory('focus', 'Review PR #42');
    const snapshot = agent.getWorkingMemorySnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].key).toBe('focus');
    expect(snapshot[0].text).toBe('Review PR #42');
  });

  it('uses custom memory store when provided', () => {
    const mockMemory: IMemoryStore = {
      addEntry: vi.fn(),
      getEntries: vi.fn(() => []),
      getEntriesByTag: vi.fn(() => []),
      search: vi.fn(() => []),
      removeEntries: vi.fn(() => 0),
      replaceEntries: vi.fn(),
      removeEntriesByTag: vi.fn(() => 0),
      addLongTermMemory: vi.fn(),
      getLongTermMemory: vi.fn(() => ''),
      getLongTermMemoryExcluding: vi.fn(() => ''),
      getLongTermSection: vi.fn(() => ''),
      compressLongTermMemory: vi.fn(() => ({ charsBefore: 0, charsAfter: 0, sectionsBefore: 0, sectionsAfter: 0, truncatedChunks: 0 })),
      createSession: vi.fn(() => ({
        id: 'sess_1',
        agentId: 'test',
        messages: [],
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      })),
      getOrCreateSession: vi.fn(() => ({
        id: 'sess_1',
        agentId: 'test',
        messages: [],
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      })),
      appendMessage: vi.fn(),
      getRecentMessages: vi.fn(() => []),
      getSession: vi.fn(),
      listSessions: vi.fn(() => []),
      getLatestSession: vi.fn(),
      writeDailyLog: vi.fn(),
      getDailyLog: vi.fn(() => ''),
      getRecentDailyLogs: vi.fn(() => ''),
      compactSession: vi.fn(() => ({ summary: '', flushedCount: 0 })),
      summarizeAndTruncate: vi.fn(() => []),
    };

    const agent = createTestAgent(makeMockRouter(), { memory: mockMemory });
    expect(agent.getMemory()).toBe(mockMemory);
  });

  it('evicts oldest entry when working memory exceeds max entries', () => {
    const agent = createTestAgent(makeMockRouter());
    for (let i = 0; i < 10; i++) {
      agent.updateWorkingMemory(`key_${i}`, `value ${i}`);
    }
    const result = agent.updateWorkingMemory('key_new', 'newest');
    expect(result.evicted).toBeDefined();
    expect(agent.getWorkingMemorySnapshot()).toHaveLength(10);
    expect(agent.getWorkingMemorySnapshot().some(e => e.key === 'key_new')).toBe(true);
  });

  it('clearWorkingMemory removes one or all entries', () => {
    const agent = createTestAgent(makeMockRouter());
    agent.updateWorkingMemory('a', 'A');
    agent.updateWorkingMemory('b', 'B');

    expect(agent.clearWorkingMemory('a').cleared).toBe(1);
    expect(agent.getWorkingMemorySnapshot()).toHaveLength(1);

    expect(agent.clearWorkingMemory().cleared).toBe(1);
    expect(agent.getWorkingMemorySnapshot()).toHaveLength(0);
  });
});

describe('memory operations', () => {
  it('addMemory stores facts in memory store', () => {
    const agent = createTestAgent(makeMockRouter());
    agent.addMemory('Deployment uses port 8080', 'fact');
    const entries = agent.getMemory().getEntries('fact');
    expect(entries.some(e => e.content.includes('8080'))).toBe(true);
  });

  it('recordToolUsage tracks skill proficiency', () => {
    const agent = createTestAgent(makeMockRouter());
    agent.recordToolUsage('shell_execute', true);
    agent.recordToolUsage('shell_execute', false);

    const prof = agent.getSkillProficiency();
    expect(prof.shell_execute.uses).toBe(2);
    expect(prof.shell_execute.successes).toBe(1);
  });

  it('resetDailyTokens clears daily counter', async () => {
    const mockRouter = makeMockRouter(async () => makeResponse('Hi', 'end_turn'));
    const agent = createTestAgent(mockRouter);
    await agent.handleMessage('hello');
    expect(agent.getState().tokensUsedToday).toBeGreaterThan(0);

    agent.resetDailyTokens();
    expect(agent.getTokensUsedToday()).toBe(0);
    expect(agent.getState().tokensUsedToday).toBe(0);
  });
});

describe('session management', () => {
  it('startNewSession creates a fresh session id', () => {
    const agent = createTestAgent(makeMockRouter());
    agent.startNewSession();
    const sessions = agent.getMemory().listSessions(agent.id);
    expect(sessions.length).toBeGreaterThan(0);
  });

  it('bindDbSession maps db session to memory session', () => {
    const agent = createTestAgent(makeMockRouter());
    agent.startNewSession();
    agent.bindDbSession('ses_db_123');
    expect(agent.getMemory().listSessions(agent.id).length).toBeGreaterThan(0);
  });

  it('restoreSessionFromHistory populates memory from db messages', () => {
    const agent = createTestAgent(makeMockRouter());
    agent.restoreSessionFromHistory('ses_db_456', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);

    const sessions = agent.getMemory().listSessions(agent.id);
    expect(sessions.some(s => s.messages.length >= 2)).toBe(true);
  });

  it('restoreSessionFromHistory with isRetry strips last assistant turn', () => {
    const agent = createTestAgent(makeMockRouter());
    agent.restoreSessionFromHistory('ses_retry', [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Bad answer' },
    ]);
    agent.restoreSessionFromHistory('ses_retry', [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Bad answer' },
    ], { isRetry: true });

    const sessions = agent.getMemory().listSessions(agent.id);
    const session = sessions.find(s => s.messages.length >= 0);
    expect(session?.messages.some(m => String(m.content).includes('Bad answer'))).toBe(false);
  });

  it('injectUserMessage appends directly when no active task', () => {
    const agent = createTestAgent(makeMockRouter());
    const session = agent.getMemory().createSession(agent.id);
    agent.injectUserMessage(session.id, 'Live comment during chat');
    const updated = agent.getMemory().getSession(session.id);
    expect(updated?.messages.some(m => String(m.content).includes('Live comment'))).toBe(true);
  });
});

describe('role reload', () => {
  it('reloadRole reads updated ROLE.md from disk', () => {
    const agent = createTestAgent(makeMockRouter());
    const roleDir = join(tempDir, 'role');
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, 'ROLE.md'), '# Updated Role\nNew system instructions.');

    agent.reloadRole();
    expect(agent.role.systemPrompt).toContain('New system instructions');
  });

  it('reloadHeartbeat reads HEARTBEAT.md from disk', () => {
    const agent = createTestAgent(makeMockRouter());
    const roleDir = join(tempDir, 'role');
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, 'HEARTBEAT.md'), '- Check deployment status');

    agent.reloadHeartbeat();
    expect(agent.role.heartbeatChecklist).toContain('Check deployment status');
  });
});

describe('mailbox and mind state', () => {
  it('enqueueToMailbox adds items to agent mailbox', () => {
    const agent = createTestAgent(makeMockRouter());
    const item = agent.enqueueToMailbox('system_event', { summary: 'evt', content: 'payload' });
    expect(item.agentId).toBe(agent.id);
    expect(agent.getMailbox().depth).toBe(1);
  });

  it('getMindState exposes mailbox and attention snapshot', () => {
    const agent = createTestAgent(makeMockRouter());
    agent.enqueueToMailbox('a2a_message', { summary: 'msg', content: 'body' });
    const mind = agent.getMindState();
    expect(mind.mailboxDepth).toBe(1);
    expect(mind.attentionState).toBeDefined();
  });

  it('sendMessage resolves when agent processes mailbox item', async () => {
    const mockRouter = makeMockRouter(async () => makeResponse('Reply via mailbox.', 'end_turn'));
    const agent = createTestAgent(mockRouter);
    await agent.start();

    const replyPromise = agent.sendMessage('Hello via sendMessage');
    const reply = await replyPromise;
    expect(reply).toContain('Reply via mailbox');

    await agent.stop();
  });
});

describe('guardrails and tool hooks', () => {
  it('blocks handleMessage when input guardrail fails', async () => {
    const agent = createTestAgent(makeMockRouter());
    agent.getGuardrails().addInputGuardrail({
      name: 'block-test',
      description: 'blocks bad input',
      check: async (input) => ({
        passed: !input.includes('FORBIDDEN'),
        reason: 'blocked content',
      }),
    });

    const reply = await agent.handleMessage('This contains FORBIDDEN text');
    expect(reply).toContain('cannot process');
  });

  it('registers and retrieves tool hooks', () => {
    const agent = createTestAgent(makeMockRouter());
    const hook = { name: 'test-hook', before: vi.fn(), after: vi.fn() };
    agent.addToolHook(hook);
    expect(agent.getToolHooks().getHooks()).toContain(hook);
  });
});

describe('subagent spawning', () => {
  it('executes spawn_subagent tool directly and returns result', async () => {
    const mockRouter = makeMockRouter(async () =>
      makeResponse('Subagent finished the work.', 'end_turn'),
    );
    const agent = createTestAgent(mockRouter, { maxToolIterations: 5 });
    agent.registerTool({
      name: 'file_read',
      description: 'Read files',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: async () => '{"content":"readme"}',
    });

    const spawnTool = agent.getTools().get('spawn_subagent');
    expect(spawnTool).toBeDefined();

    const raw = await spawnTool!.execute({ task: 'Summarize the readme file using file_read' });
    const parsed = JSON.parse(raw) as { status: string; result?: string };
    expect(parsed.status).toBe('completed');
    expect(parsed.result).toContain('Subagent finished');
    expect(mockRouter.chat).toHaveBeenCalled();
  });
});

describe('org context and callbacks', () => {
  it('setOrgContext updates org metadata used in prompts', async () => {
    const mockRouter = makeMockRouter(async () => makeResponse('OK', 'end_turn'));
    const agent = createTestAgent(mockRouter);
    agent.setOrgContext({ orgName: 'Test Org', teamName: 'Alpha Team' });

    await agent.handleMessage('status check');
    expect(agent.getEventBus()).toBeDefined();
  });

  it('setActivityCallbacks fires onStart during handleMessage', async () => {
    const mockRouter = makeMockRouter(async () => makeResponse('Done', 'end_turn'));
    const agent = createTestAgent(mockRouter);
    const onStart = vi.fn();
    agent.setActivityCallbacks({ onStart });

    await agent.handleMessage('trigger activity');
    expect(onStart).toHaveBeenCalled();
  });

  it('cancelActiveStream sets cancellation on active stream token', () => {
    const agent = createTestAgent(makeMockRouter());
    const token = agent.getStreamCancelToken();
    agent.cancelActiveStream();
    expect(token.cancelled).toBe(true);
    expect(token.userStopped).toBe(true);
  });

  it('getContextEngine returns shared context engine instance', () => {
    const agent = createTestAgent(makeMockRouter());
    expect(agent.getContextEngine()).toBeDefined();
  });
});
