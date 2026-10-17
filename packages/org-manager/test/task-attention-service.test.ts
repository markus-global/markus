import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

/**
 * Service-level regression suite for the attention-economy changes
 * (2026-10-17). See docs/architecture/task-attention-economy.md.
 *
 * Covers:
 *  1. Completed cards cannot be reverted by an agent (T25: a stray task_update
 *     flipped completed → in_progress 94s after approval and silently broke the
 *     card's blockedBy dependents). The old guard failed OPEN because it INFERRED
 *     the actor type from an optional collaborator.
 *  2. One open question per card, with a single authorised decider.
 *  3. Record-only comments no longer wake anyone; they reach the running session
 *     as ONE coalesced digest instead of a per-comment interruption.
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

describe('one open question per card + single-point adjudication', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => { ctx = setup(); });

  it('opens a question and wakes exactly the decider', () => {
    const task = ctx.create();
    const updated = ctx.ts.askTaskDecision(task.id, {
      text: 'Which snapshot is authoritative — schema.sql:207 or the migration?',
      askedBy: PEER,
      askedByName: 'DB 工程师',
    });

    expect(updated.openQuestion?.text).toContain('Which snapshot');
    expect(updated.openQuestion?.deciderId).toBe(REVIEWER);
    expect(ctx.agents.get(REVIEWER)!.enqueueToMailbox).toHaveBeenCalledTimes(1);
    // The assignee is NOT woken by an open question addressed to the reviewer.
    expect(ctx.agents.get(AGENT)!.enqueueToMailbox).not.toHaveBeenCalled();
  });

  it('rejects a second open question with an actionable message', () => {
    const task = ctx.create();
    ctx.ts.askTaskDecision(task.id, { text: 'Q1', askedBy: PEER, askedByName: 'DB' });
    expect(() => ctx.ts.askTaskDecision(task.id, { text: 'Q2', askedBy: PEER, askedByName: 'DB' }))
      .toThrow(/already has one open question/i);
  });

  it('only the reviewer / creator / human may decide', () => {
    const task = ctx.create({ createdBy: 'user-9' });
    ctx.ts.askTaskDecision(task.id, { text: 'Q1', askedBy: PEER, askedByName: 'DB' });

    expect(() => ctx.ts.recordTaskDecision(task.id, {
      point: 'authoritative snapshot',
      decision: 'schema.sql',
      decidedBy: PEER,
      decidedByName: 'DB',
    })).toThrow(/Only the task reviewer/i);
  });

  it('records the ruling, closes the question, and notifies the assignee once', () => {
    const task = ctx.create();
    ctx.ts.askTaskDecision(task.id, { text: 'Q1', askedBy: PEER, askedByName: 'DB' });

    const updated = ctx.ts.recordTaskDecision(task.id, {
      point: 'authoritative snapshot',
      decision: 'schema.sql:207 wins',
      rationale: 'contract §3 pins uq_mint_ref',
      decidedBy: REVIEWER,
      decidedByName: '技术主管',
    });

    expect(updated.openQuestion).toBeUndefined();
    expect(updated.decisions).toHaveLength(1);
    expect(updated.decisions![0].decision).toBe('schema.sql:207 wins');

    const assigneeNotifs = ctx.agents.get(AGENT)!.enqueueToMailbox.mock.calls;
    expect(assigneeNotifs).toHaveLength(1);
    expect(String(assigneeNotifs[0][1].content)).toContain('No reply is required');
  });
});

describe('comment attention — record-only comments stop waking the team', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = setup();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a plain peer comment wakes nobody and does not interrupt the running session', async () => {
    const task = ctx.create();
    ctx.ts.approveTask(task.id, 'user-1'); // → in_progress

    await ctx.ts.postTaskComment(
      task.id, PEER, '数据库工程师',
      'Snapshot corrected: the ledger figure is 41, not 47.', // no mention
    );

    expect(ctx.agents.get(AGENT)!.enqueueToMailbox).not.toHaveBeenCalled();
    expect(ctx.agents.get(AGENT)!.injectUserMessage).not.toHaveBeenCalled();
  });

  it('coalesces several record-only comments into ONE digest message', async () => {
    const task = ctx.create();
    ctx.ts.approveTask(task.id, 'user-1');

    for (let i = 0; i < 4; i++) {
      await ctx.ts.postTaskComment(task.id, PEER, '数据库工程师', `correction ${i}`);
    }

    vi.advanceTimersByTime(60_000);

    const injected = ctx.agents.get(AGENT)!.injectUserMessage.mock.calls;
    expect(injected).toHaveLength(1);
    const message = String(injected[0][1]);
    expect(message).toContain('4 new comments were recorded');
    expect(message).toContain('RECORD, not a request');
  });

  it('a mention still wakes the named agent immediately', async () => {
    const task = ctx.create();
    ctx.ts.approveTask(task.id, 'user-1');

    await ctx.ts.postTaskComment(task.id, PEER, '数据库工程师', 'please confirm', [AGENT]);

    expect(ctx.agents.get(AGENT)!.enqueueToMailbox).toHaveBeenCalledTimes(1);
  });
});
