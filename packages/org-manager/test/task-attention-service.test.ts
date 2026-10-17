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
    })).toThrow(/Only the named decider|Only the task reviewer/i);
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

/**
 * The ask → decide loop must actually close. These four tests exist because the
 * first implementation did not: the ruling only woke the ASSIGNEE, so an asker
 * who was a peer (the common case — a DB engineer asking on a backend-owned
 * card) never learned the answer, and the card stalled silently on a guess.
 */
describe('ask → decide loop: the ruling wakes the asker back', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => { ctx = setup(); });

  function activeTask() {
    const task = ctx.create();
    ctx.ts.approveTask(task.id, 'user-1');
    expect(ctx.ts.getTask(task.id)!.status).toBe('in_progress');
    return task;
  }

  it('task_ask_decision leaves the card in_progress and does not pause anything', () => {
    const task = activeTask();
    ctx.ts.askTaskDecision(task.id, {
      text: 'Is the ledger figure 41 or 47?',
      askedBy: PEER,
      askedByName: '数据库工程师',
    });

    const after = ctx.ts.getTask(task.id)!;
    // Documented state machine: status unchanged; the wait lives in openQuestion.
    expect(after.status).toBe('in_progress');
    expect(after.openQuestion?.text).toContain('ledger figure');
    expect(ctx.agents.get(REVIEWER)!.enqueueToMailbox).toHaveBeenCalledTimes(1);
  });

  it('wakes the ASKER (not just the assignee) when the ruling lands', () => {
    const task = activeTask();
    ctx.ts.askTaskDecision(task.id, {
      text: 'Is the ledger figure 41 or 47?',
      askedBy: PEER,
      askedByName: '数据库工程师',
    });

    ctx.ts.recordTaskDecision(task.id, {
      point: 'ledger figure',
      decision: '41 — the earlier snapshot was stale',
      decidedBy: REVIEWER,
      decidedByName: 'Reviewer',
    });

    expect(ctx.ts.getTask(task.id)!.openQuestion).toBeUndefined();
    const askerCalls = ctx.agents.get(PEER)!.enqueueToMailbox.mock.calls;
    expect(askerCalls).toHaveLength(1);
    const payload = askerCalls[0][1] as { content: string };
    expect(payload.content).toContain('You asked this');
    expect(payload.content).toContain('41');
  });

  it('a named peer decider can actually decide (no dead-lock)', () => {
    const task = activeTask();
    ctx.ts.askTaskDecision(task.id, {
      text: 'Which snapshot wins?',
      askedBy: PEER,
      askedByName: '数据库工程师',
      deciderId: AGENT, // assignee, NOT the reviewer
    });

    // Previously this threw DECISION_NOT_AUTHORIZED — the asker had woken a
    // decider who was structurally unable to answer.
    expect(() => ctx.ts.recordTaskDecision(task.id, {
      point: 'snapshot',
      decision: 'mine',
      decidedBy: AGENT,
      decidedByName: 'Backend',
    })).not.toThrow();
    expect(ctx.ts.getTask(task.id)!.decisions).toHaveLength(1);
  });

  it('rejects asking yourself, and asking on a closed card', () => {
    const task = activeTask();
    expect(() => ctx.ts.askTaskDecision(task.id, {
      text: 'self', askedBy: PEER, askedByName: '数据库工程师', deciderId: PEER,
    })).toThrow();

    const closed = ctx.create();
    ctx.ts.approveTask(closed.id, 'user-1');
    ctx.ts.updateTaskStatus(closed.id, 'review', AGENT, false, false, 'agent');
    ctx.ts.updateTaskStatus(closed.id, 'completed', REVIEWER, false, false, 'agent');
    expect(() => ctx.ts.askTaskDecision(closed.id, {
      text: 'too late', askedBy: PEER, askedByName: '数据库工程师',
    })).toThrow();
  });

  it('escalates a stale question exactly once', () => {
    const task = activeTask();
    ctx.ts.askTaskDecision(task.id, {
      text: 'unanswered', askedBy: PEER, askedByName: '数据库工程师',
    });
    const before = ctx.agents.get(REVIEWER)!.enqueueToMailbox.mock.calls.length; // the ask itself

    ctx.ts.escalateStaleQuestions(-1); // everything is "stale"
    ctx.ts.escalateStaleQuestions(-1); // must not spam again

    const after = ctx.agents.get(REVIEWER)!.enqueueToMailbox.mock.calls.length;
    expect(after - before).toBe(1);
  });
});
