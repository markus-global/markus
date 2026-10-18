import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

/**
 * Service-level regression suite for the attention-economy changes
 * (2026-10-17/18). See docs/architecture/task-attention-economy.md.
 *
 * Covers:
 *  1. Terminal-state authority: a completed card cannot be reopened by an agent
 *     (T25 — a stray task_update flipped completed → in_progress 94s after
 *     approval and silently broke the card's blockedBy dependents). The old
 *     guard failed OPEN because it INFERRED the actor type from a collaborator.
 *  2. Comment attention: only a HUMAN comment enters a running session or wakes
 *     anyone. Agent comments are records — never interruptions.
 *
 * The former "ask decision / decide" mechanism was removed on 2026-10-18 and
 * replaced by the blocking `agent_ask_agent` tool (core, not task-service).
 */

const AGENT = 'agent-a';
const PEER = 'agent-b';
const REVIEWER = 'reviewer-1';
const ORG = 'org-1';

function makeAgent() {
  return {
    config: { name: 'x', orgId: ORG },
    enqueueToMailbox: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    injectUserMessage: vi.fn(),
    sendSessionReply: vi.fn().mockResolvedValue('ok'),
    dropStaleStatusUpdates: vi.fn(),
    getState: vi.fn(() => ({ status: 'idle', activeTaskCount: 0 })),
  };
}

function setup() {
  const agents = new Map<string, ReturnType<typeof makeAgent>>([
    [AGENT, makeAgent()],
    [PEER, makeAgent()],
    [REVIEWER, makeAgent()],
  ]);

  const agentManager = {
    hasAgent: (id: string) => agents.has(id),
    getAgent: (id: string) => {
      const a = agents.get(id);
      if (!a) throw new Error(`Agent not found: ${id}`);
      return a;
    },
    listAgents: () => [{ id: AGENT }, { id: PEER }, { id: REVIEWER }],
  };

  const ts = new TaskService();
  ts.setGovernancePolicy({
    enabled: false,
    defaultTier: 'auto',
    maxPendingTasksPerAgent: 100,
    maxTotalActiveTasks: 100,
    requireApprovalForPriority: [],
    requireRequirement: false,
    rules: [],
  } as never);
  ts.setAgentManager(agentManager as never);

  const comments: Array<Record<string, unknown>> = [];
  ts.setTaskCommentRepo({
    add: vi.fn(async (data: Record<string, unknown>) => {
      const comment = { id: `tc_${comments.length + 1}`, createdAt: new Date(), ...data };
      comments.push(comment);
      return comment;
    }),
    getByTask: vi.fn(async (taskId: string) => comments.filter(c => c['taskId'] === taskId)),
  } as never);
  ts.setStatusTransitionRepo({ record: vi.fn() } as never);

  const create = (overrides: Record<string, unknown> = {}) => ts.createTask({
    orgId: ORG,
    title: 'Task',
    description: 'Do something',
    assignedAgentId: AGENT,
    reviewerId: REVIEWER,
    creatorRole: 'human',
    ...overrides,
  } as never);

  return { ts, agents, comments, create };
}

describe('terminal-state authority — an agent cannot reopen a completed card', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => { ctx = setup(); });
  afterEach(() => { vi.useRealTimers(); });

  function completedTask() {
    const task = ctx.create();
    ctx.ts.approveTask(task.id, 'user-1');
    ctx.ts.updateTaskStatus(task.id, 'review', AGENT, false, false, 'agent', 'submitted');
    ctx.ts.updateTaskStatus(task.id, 'completed', REVIEWER, false, false, 'agent', 'review approved');
    expect(ctx.ts.getTask(task.id)!.status).toBe('completed');
    return task;
  }

  it('rejects completed → in_progress for an agent, even when explicitly typed', () => {
    const task = completedTask();
    expect(() => ctx.ts.updateTaskStatus(task.id, 'in_progress', AGENT, false, false, 'agent'))
      .toThrow();
    expect(ctx.ts.getTask(task.id)!.status).toBe('completed');
  });

  it('fails CLOSED when the caller omits the actor type (the T25 fail-open path)', () => {
    const task = completedTask();
    // This is exactly what the agent tool surface used to do: no explicit type.
    expect(() => ctx.ts.updateTaskStatus(task.id, 'in_progress', AGENT))
      .toThrow();
    expect(ctx.ts.getTask(task.id)!.status).toBe('completed');
  });

  it('still allows a human to reopen', () => {
    const task = completedTask();
    ctx.ts.updateTaskStatus(task.id, 'in_progress', 'user-1', false, false, 'human');
    expect(ctx.ts.getTask(task.id)!.status).toBe('in_progress');
  });
});

describe('comment attention — only a human enters a running session', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => { ctx = setup(); });

  it('an agent comment wakes nobody and never enters the running session', async () => {
    const task = ctx.create();
    ctx.ts.approveTask(task.id, 'user-1'); // → in_progress

    for (let i = 0; i < 4; i++) {
      await ctx.ts.postTaskComment(task.id, PEER, '数据库工程师', `correction ${i}`);
    }

    // No mailbox wake, and — the point — nothing injected into the session.
    expect(ctx.agents.get(AGENT)!.enqueueToMailbox).not.toHaveBeenCalled();
    expect(ctx.agents.get(AGENT)!.injectUserMessage).not.toHaveBeenCalled();
  });

  it('a human comment is injected into the running session, verbatim', async () => {
    const task = ctx.create();
    ctx.ts.approveTask(task.id, 'user-1');

    await ctx.ts.postTaskComment(
      task.id, 'user-1', 'Jason Carter',
      'Stop and fix the ledger figure first.',
      undefined, undefined, { authorType: 'human' },
    );

    const injected = ctx.agents.get(AGENT)!.injectUserMessage.mock.calls;
    expect(injected).toHaveLength(1);
    const message = String(injected[0][1]);
    expect(message).toContain('Stop and fix the ledger figure first.');
    expect(message).toContain('(human)');
  });

  it('a mention still wakes the named agent immediately', async () => {
    const task = ctx.create();
    ctx.ts.approveTask(task.id, 'user-1');

    await ctx.ts.postTaskComment(task.id, PEER, '数据库工程师', 'please confirm', [AGENT]);

    expect(ctx.agents.get(AGENT)!.enqueueToMailbox).toHaveBeenCalledTimes(1);
  });
});
