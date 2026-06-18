import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { COMPLETION_MARKER } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'mbx-role',
  name: 'Mailbox Routing Role',
  description: 'Tests mailbox routing',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({
      content: `Handled. ${COMPLETION_MARKER}`,
      finishReason: 'end_turn',
      usage: { inputTokens: 40, outputTokens: 20 },
    })),
    chatStream: vi.fn(async () => ({
      content: `Stream handled. ${COMPLETION_MARKER}`,
      finishReason: 'end_turn',
      usage: { inputTokens: 40, outputTokens: 20 },
    })),
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

function createAgent(router: LLMRouter) {
  return new Agent({
    config: {
      id: 'mbx-routing-agent',
      name: 'Mailbox Routing Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: router,
    dataDir: tempDir,
  });
}

async function processViaMailbox(
  agent: Agent,
  sourceType: Parameters<Agent['enqueueToMailbox']>[0],
  payload: Parameters<Agent['enqueueToMailbox']>[1],
  metadata?: Parameters<Agent['enqueueToMailbox']>[2] extends { metadata?: infer M } ? M : never,
) {
  return new Promise<string>((resolve, reject) => {
    agent.enqueueToMailbox(sourceType, payload, {
      metadata: { ...metadata, responsePromise: { resolve, reject } },
    });
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-mbx-route-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Agent mailbox item routing', () => {
  it('routes a2a_message through handleMessage', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    await agent.start();

    const reply = await processViaMailbox(agent, 'a2a_message', {
      summary: 'Peer message',
      content: 'Can you help?',
    }, { senderId: 'agt_peer', senderName: 'Peer', senderRole: 'worker' });

    expect(reply).toContain('Handled');
    expect(router.chat).toHaveBeenCalled();
    await agent.stop();
  });

  it('routes mention items with a2a scenario', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    await agent.start();

    const reply = await processViaMailbox(agent, 'mention', {
      summary: '@agent please review',
      content: 'You were mentioned in the channel',
    });

    expect(reply).toContain('Handled');
    await agent.stop();
  });

  it('routes requirement_comment through comment_response scenario', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    await agent.start();

    const reply = await processViaMailbox(agent, 'requirement_comment', {
      summary: 'Req comment',
      content: 'Please clarify scope',
      requirementId: 'req_1',
    });

    expect(reply).toContain('Handled');
    await agent.stop();
  });

  it('routes requirement_update with actionRequired', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    await agent.start();

    const reply = await processViaMailbox(agent, 'requirement_update', {
      summary: 'Req approved',
      content: 'Requirement was approved — take action',
      requirementId: 'req_2',
      extra: { actionRequired: true },
    });

    expect(reply).toContain('Handled');
    await agent.stop();
  });

  it('skips LLM for informational requirement_update', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    await agent.start();

    const reply = await processViaMailbox(agent, 'requirement_update', {
      summary: 'Req status',
      content: 'Status changed to in_review',
      requirementId: 'req_3',
    });

    expect(reply).toBe('');
    await agent.stop();
  });

  it('routes workflow_update with actionRequired', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    await agent.start();

    const reply = await processViaMailbox(agent, 'workflow_update', {
      summary: 'Workflow step',
      content: 'Complete the deployment step',
      extra: { actionRequired: true, event: 'step_complete' },
    });

    expect(reply).toContain('Handled');
    await agent.stop();
  });

  it('routes review_request through review scenario', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    await agent.start();

    const reply = await processViaMailbox(agent, 'review_request', {
      summary: 'Review task',
      content: 'Please review submitted work',
      taskId: 'task_rev_1',
    }, { senderId: 'mgr_1', senderName: 'Manager', senderRole: 'manager' });

    expect(reply).toContain('Handled');
    await agent.stop();
  });

  it('handles task_status_update without triggerExecution as informational', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    await agent.start();

    const reply = await processViaMailbox(agent, 'task_status_update', {
      summary: 'Task in progress',
      content: 'Worker started task',
      taskId: 'task_info_1',
    });

    expect(reply).toBe('');
    await agent.stop();
  });

  it('routes task_comment when no active task', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    await agent.start();

    const reply = await processViaMailbox(agent, 'task_comment', {
      summary: 'Comment',
      content: 'Add unit tests please',
      taskId: 'task_cmt_1',
    });

    expect(reply).toBe('');
    expect(router.chat).toHaveBeenCalled();
    await agent.stop();
  });

  it('routes heartbeat through lightweight scenario', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    await agent.start();

    const reply = await processViaMailbox(agent, 'heartbeat', {
      summary: 'Heartbeat',
      content: '[HEARTBEAT] Check inbox',
    });

    expect(router.chat).toHaveBeenCalled();
    expect(typeof reply).toBe('string');
    await agent.stop();
  });
});
