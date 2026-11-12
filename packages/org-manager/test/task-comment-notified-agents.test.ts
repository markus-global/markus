import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

/**
 * Regression: the renderer's "thinking…" row must come from the server.
 *
 * `postTaskComment` used to return only the comment, so the UI guessed who was
 * woken: it matched @mentions by *display name* (mentions travel as agent IDs,
 * so that always missed), then added the assignee and the task creator. Result:
 * mentioning agent B showed the task CREATOR as "thinking…" and agent B never
 * appeared. The fix is that the service reports the agents it actually enqueued
 * a notification for, and nothing else.
 */

const ASSIGNEE = 'agent-assignee';
const CREATOR = 'agent-creator';
const MENTIONED = 'agent-mentioned';
const REVIEWER = 'agent-reviewer';
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
    [ASSIGNEE, makeAgent()],
    [CREATOR, makeAgent()],
    [MENTIONED, makeAgent()],
    [REVIEWER, makeAgent()],
  ]);

  const agentManager = {
    hasAgent: (id: string) => agents.has(id),
    getAgent: (id: string) => {
      const a = agents.get(id);
      if (!a) throw new Error(`Agent not found: ${id}`);
      return a;
    },
    listAgents: () => [...agents.keys()].map(id => ({ id })),
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
    assignedAgentId: ASSIGNEE,
    reviewerId: REVIEWER,
    creatorRole: 'agent',
    createdBy: CREATOR,
    ...overrides,
  } as never);

  return { ts, agents, create };
}

describe('postTaskComment — notifiedAgentIds is the authoritative wake list', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => { ctx = setup(); });

  it('names the mentioned agent (not the creator) when a human mentions one agent', async () => {
    const task = ctx.create();
    const result = await ctx.ts.postTaskComment(
      task.id, 'user-1', 'Jason Carter',
      'please review @Mentioned',
      [MENTIONED], undefined, { authorType: 'human' },
    );

    expect(result.notifiedAgentIds).toContain(MENTIONED);
    // The mentioned agent is woken...
    expect(ctx.agents.get(MENTIONED)!.enqueueToMailbox).toHaveBeenCalled();
  });

  it('never lists an agent that was not actually enqueued', async () => {
    const task = ctx.create();
    const result = await ctx.ts.postTaskComment(
      task.id, 'user-1', 'Jason Carter',
      'please review @Mentioned',
      [MENTIONED], undefined, { authorType: 'human' },
    );

    for (const id of result.notifiedAgentIds) {
      expect(ctx.agents.get(id)!.enqueueToMailbox).toHaveBeenCalled();
    }
    // An id that exists but was never woken must not appear.
    if (!ctx.agents.get(CREATOR)!.enqueueToMailbox.mock.calls.length) {
      expect(result.notifiedAgentIds).not.toContain(CREATOR);
    }
  });

  it('drops ids the agent manager does not know (no phantom "thinking" row)', async () => {
    const task = ctx.create();
    const result = await ctx.ts.postTaskComment(
      task.id, 'user-1', 'Jason Carter',
      'hello @ghost',
      ['agt_does_not_exist'], undefined, { authorType: 'human' },
    );

    expect(result.notifiedAgentIds).toEqual([]);
  });

  it('is empty for a record-only agent comment that names nobody', async () => {
    const task = ctx.create();
    const result = await ctx.ts.postTaskComment(task.id, ASSIGNEE, 'Assignee', 'note to self');

    expect(result.notifiedAgentIds).toEqual([]);
  });
});
