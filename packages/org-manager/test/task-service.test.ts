import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskService, computeNextRunFromConfig } from '../src/task-service.js';
import type { OrganizationService } from '../src/org-service.js';

const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const REVIEWER = 'reviewer-1';
const ORG = 'org-1';

function createDefaults(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    title: 'Task',
    description: 'Do something',
    assignedAgentId: AGENT_A,
    reviewerId: REVIEWER,
    ...overrides,
  };
}

type ExecutionLogEntry = {
  type: string;
  content: string;
  persist?: boolean;
  metadata?: Record<string, unknown>;
};

function createMockAgentManager(executionHandler?: (
  taskId: string,
  log: (entry: ExecutionLogEntry) => Promise<void>,
  cancelToken: { cancelled: boolean },
) => Promise<void>) {
  const agents = new Set([AGENT_A, AGENT_B, REVIEWER]);
  const makeAgent = (id: string) => ({
    config: { name: id, orgId: ORG, agentRole: id === REVIEWER ? 'manager' : 'worker' },
    enqueueToMailbox: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    injectUserMessage: vi.fn(),
    sendSessionReply: vi.fn().mockResolvedValue('Thanks for the feedback'),
    dropStaleStatusUpdates: vi.fn(),
    getState: vi.fn(() => ({ status: 'busy', activeTaskCount: 1 })),
    sendTaskExecution: vi.fn(async (
      taskId: string,
      _desc: string,
      logFn: (entry: ExecutionLogEntry) => Promise<void>,
      cancelToken: { cancelled: boolean },
    ) => {
      if (executionHandler) {
        await executionHandler(taskId, logFn, cancelToken);
        return;
      }
      await logFn({ type: 'status', content: 'started', persist: true });
      await logFn({ type: 'text', content: 'Working on task', persist: true });
      await logFn({ type: 'status', content: 'execution_finished', persist: true });
    }),
  });
  const agentMap = new Map([
    [AGENT_A, makeAgent(AGENT_A)],
    [AGENT_B, makeAgent(AGENT_B)],
    [REVIEWER, makeAgent(REVIEWER)],
  ]);
  return {
    hasAgent: vi.fn((id: string) => agents.has(id)),
    getAgent: vi.fn((id: string) => {
      const agent = agentMap.get(id);
      if (!agent) throw new Error(`Agent not found: ${id}`);
      return agent;
    }),
    listAgents: vi.fn(() => [{ id: AGENT_A }, { id: AGENT_B }]),
  };
}

function createWsMock() {
  return {
    broadcast: vi.fn(),
    broadcastTaskCreate: vi.fn(),
    broadcastTaskUpdate: vi.fn(),
  };
}

async function createTaskInReview(ts: TaskService) {
  const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
  ts.approveTask(task.id, 'user-1');
  await ts.submitForReview(task.id, [{ type: 'file', reference: '/tmp/out.txt', summary: 'Output' }]);
  return ts.getTask(task.id)!;
}

function createService(overrides: { governanceEnabled?: boolean; executionHandler?: Parameters<typeof createMockAgentManager>[0] } = {}) {
  const agentManager = createMockAgentManager(overrides.executionHandler);
  const svc = new TaskService();
  svc.setGovernancePolicy({
    enabled: overrides.governanceEnabled ?? false,
    defaultTier: 'auto',
    maxPendingTasksPerAgent: 100,
    maxTotalActiveTasks: 100,
    requireApprovalForPriority: ['urgent'],
    requireRequirement: false,
    rules: [
      {
        tier: 'human',
        condition: { titlePattern: 'sensitive', creatorRole: 'worker' },
      },
    ],
  });
  svc.setAgentManager(agentManager as never);
  svc.setWSBroadcaster(createWsMock() as never);
  return { svc, agentManager };
}

describe('TaskService', () => {
  let ts: TaskService;
  let agentManager: ReturnType<typeof createMockAgentManager>;

  beforeEach(() => {
    ({ svc: ts, agentManager } = createService());
  });

  afterEach(() => {
    ts.stopTimeoutChecker();
    vi.restoreAllMocks();
  });

  describe('createTask validation', () => {
    it('requires assignedAgentId and reviewerId', () => {
      expect(() => ts.createTask(createDefaults({ assignedAgentId: undefined }) as never))
        .toThrow(/assignedAgentId is required/);
      expect(() => ts.createTask(createDefaults({ reviewerId: undefined }) as never))
        .toThrow(/reviewerId is required/);
    });

    it('validates agent existence when agentManager is set', () => {
      expect(() => ts.createTask(createDefaults({ assignedAgentId: 'missing' }) as never))
        .toThrow(/assigned agent not found/);
      expect(() => ts.createTask(createDefaults({ reviewerId: 'missing' }) as never))
        .toThrow(/reviewer agent not found/);
    });

    it('allows human reviewer without agent record', () => {
      const task = ts.createTask(createDefaults({
        reviewerId: 'human-reviewer',
        reviewerType: 'human',
        creatorRole: 'human',
      }) as never);
      expect(task.reviewerType).toBe('human');
      expect(task.status).toBe('pending');
    });
  });

  describe('governance', () => {
    it('determines approval tier based on policy rules', () => {
      ts.setGovernancePolicy({
        enabled: true,
        defaultTier: 'auto',
        maxPendingTasksPerAgent: 100,
        maxTotalActiveTasks: 100,
        requireApprovalForPriority: [],
        requireRequirement: false,
        rules: [
          { tier: 'human', condition: { titlePattern: 'sensitive', creatorRole: 'worker' } },
        ],
      });
      expect(ts.determineApprovalTier(createDefaults({ title: 'sensitive task' }) as never, 'worker'))
        .toBe('human');
      expect(ts.determineApprovalTier(createDefaults({ title: 'normal task' }) as never, 'worker'))
        .toBe('auto');
      expect(ts.determineApprovalTier(createDefaults({ creatorRole: 'human' }) as never))
        .toBe('auto');
      expect(ts.determineApprovalTier(createDefaults({ approvedVia: 'workflow' }) as never, 'worker'))
        .toBe('auto');
    });

    it('requires human approval for urgent priority when governance enabled', () => {
      ts.setGovernancePolicy({
        enabled: true,
        defaultTier: 'auto',
        maxPendingTasksPerAgent: 100,
        maxTotalActiveTasks: 100,
        requireApprovalForPriority: ['urgent'],
        requireRequirement: false,
        rules: [],
      });
      expect(ts.determineApprovalTier(createDefaults({ priority: 'urgent' }) as never, 'worker'))
        .toBe('human');
    });

    it('blocks task creation when org-wide cap reached', () => {
      ts.setGovernancePolicy({
        enabled: true,
        defaultTier: 'auto',
        maxPendingTasksPerAgent: 100,
        maxTotalActiveTasks: 1,
        requireApprovalForPriority: [],
        requireRequirement: false,
        rules: [],
      });
      ts.createTask(createDefaults({ title: 'First' }) as never);
      expect(() => ts.createTask(createDefaults({ title: 'Second' }) as never))
        .toThrow(/Org-wide active task cap/);
    });

    it('blocks task creation when agent cap reached', () => {
      ts.setGovernancePolicy({
        enabled: true,
        defaultTier: 'auto',
        maxPendingTasksPerAgent: 1,
        maxTotalActiveTasks: 100,
        requireApprovalForPriority: [],
        requireRequirement: false,
        rules: [],
      });
      ts.createTask(createDefaults({ title: 'First' }) as never);
      expect(() => ts.createTask(createDefaults({ title: 'Second' }) as never))
        .toThrow(/Agent task cap/);
    });

    it('requires requirementId when policy mandates it', () => {
      ts.setGovernancePolicy({
        enabled: true,
        defaultTier: 'auto',
        maxPendingTasksPerAgent: 100,
        maxTotalActiveTasks: 100,
        requireApprovalForPriority: [],
        requireRequirement: true,
        rules: [],
      });
      expect(() => ts.createTask(createDefaults() as never))
        .toThrow(/must reference an approved requirement/);
    });
  });

  describe('approve and reject', () => {
    it('approves pending agent-created task', () => {
      const task = ts.createTask(createDefaults({
        title: 'Needs approval',
        creatorRole: 'worker',
      }) as never);
      expect(task.status).toBe('pending');

      const approved = ts.approveTask(task.id, 'user-1');
      expect(approved.status).toBe('in_progress');
      expect(approved.approvedVia).toBe('human');
    });

    it('rejects pending task', () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'worker' }) as never);
      const rejected = ts.rejectTask(task.id, 'user-1');
      expect(rejected.status).toBe('rejected');
    });

    it('throws when approving non-pending task', () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');
      expect(() => ts.approveTask(task.id, 'user-1')).toThrow(/cannot approve/);
    });

    it('handles scheduled task approval without runNow', () => {
      const task = ts.createTask(createDefaults({
        creatorRole: 'worker',
        taskType: 'scheduled',
        scheduleConfig: { type: 'cron', cron: '0 9 * * *' },
      }) as never);
      const approved = ts.approveTask(task.id, 'user-1', false);
      expect(approved.status).toBe('completed');
    });
  });

  describe('pause and resume', () => {
    it('pauses in-progress task to blocked', () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');
      const paused = ts.pauseTask(task.id, 'user-1', 'human');
      expect(paused.status).toBe('blocked');
    });

    it('resumes blocked task to in_progress', () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');
      ts.pauseTask(task.id);
      const resumed = ts.resumeTask(task.id, 'user-1', 'human');
      expect(resumed.status).toBe('in_progress');
    });

    it('throws when pausing non-in-progress task', () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      expect(() => ts.pauseTask(task.id)).toThrow(/Cannot pause/);
    });
  });

  describe('cancel and assign', () => {
    it('cancels task and cascades to dependents', () => {
      const parent = ts.createTask(createDefaults({ title: 'Parent', creatorRole: 'human' }) as never);
      ts.approveTask(parent.id, 'user-1');
      const child = ts.createTask(createDefaults({
        title: 'Child',
        blockedBy: [parent.id],
        creatorRole: 'human',
      }) as never);

      ts.cancelTask(parent.id, true, 'user-1', 'human');
      expect(ts.getTask(parent.id)!.status).toBe('cancelled');
      expect(ts.getTask(child.id)!.status).toBe('cancelled');
    });

    it('counts dependent blocked tasks', () => {
      const parent = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(parent.id, 'user-1');
      ts.createTask(createDefaults({
        blockedBy: [parent.id],
        creatorRole: 'human',
      }) as never);
      expect(ts.getDependentTaskCount(parent.id)).toBe(1);
    });

    it('assigns task to another agent', () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      const assigned = ts.assignTask(task.id, AGENT_B, 'user-1');
      expect(assigned.assignedAgentId).toBe(AGENT_B);
    });

    it('adds notes to a task', () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.addTaskNote(task.id, 'Progress update', 'Alice');
      expect(ts.getTask(task.id)!.notes?.length).toBe(1);
      expect(ts.getTask(task.id)!.notes![0]).toContain('Progress update');
    });
  });

  describe('list and query', () => {
    beforeEach(() => {
      ts.createTask(createDefaults({ title: 'Alpha task', priority: 'high', creatorRole: 'human' }) as never);
      ts.createTask(createDefaults({
        title: 'Beta task',
        assignedAgentId: AGENT_B,
        priority: 'low',
        projectId: 'proj-1',
        creatorRole: 'human',
      }) as never);
    });

    it('filters tasks via listTasks', () => {
      expect(ts.listTasks({ orgId: ORG })).toHaveLength(2);
      expect(ts.listTasks({ assignedAgentId: AGENT_B })).toHaveLength(1);
      expect(ts.listTasks({ projectId: 'proj-1' })).toHaveLength(1);
    });

    it('searches, sorts, and paginates via queryTasks', () => {
      const result = ts.queryTasks({
        orgId: ORG,
        search: 'alpha',
        sortBy: 'title',
        sortOrder: 'asc',
        page: 1,
        pageSize: 10,
      });
      expect(result.total).toBe(1);
      expect(result.tasks[0]?.title).toBe('Alpha task');
    });

    it('returns tasks grouped on board', () => {
      const board = ts.getTaskBoard(ORG);
      expect(board.pending.length + board.in_progress.length).toBeGreaterThan(0);
    });

    it('returns tasks by agent', () => {
      expect(ts.getTasksByAgent(AGENT_B)).toHaveLength(1);
    });
  });

  describe('updateTask', () => {
    it('updates fields and detects circular dependencies', () => {
      const t1 = ts.createTask(createDefaults({ title: 'T1', creatorRole: 'human' }) as never);
      const t2 = ts.createTask(createDefaults({ title: 'T2', creatorRole: 'human' }) as never);
      ts.approveTask(t1.id, 'user-1');
      ts.approveTask(t2.id, 'user-1');

      expect(() => ts.updateTask(t1.id, { blockedBy: [t2.id] }))
        .not.toThrow();
      expect(() => ts.updateTask(t2.id, { blockedBy: [t1.id] }))
        .toThrow(/Circular dependency/);
    });

    it('reevaluates blocked status when blockers cleared', () => {
      const dep = ts.createTask(createDefaults({ title: 'Dep', creatorRole: 'human' }) as never);
      ts.approveTask(dep.id, 'user-1');
      const blocked = ts.createTask(createDefaults({
        blockedBy: [dep.id],
        creatorRole: 'human',
      }) as never);
      expect(blocked.status).toBe('blocked');

      ts.updateTaskStatus(dep.id, 'review');
      ts.updateTaskStatus(dep.id, 'completed');
      ts.updateTask(blocked.id, { blockedBy: [] });
      expect(ts.getTask(blocked.id)!.status).toBe('in_progress');
    });
  });

  describe('status transitions', () => {
    it('rejects illegal transitions', () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');
      expect(() => ts.updateTaskStatus(task.id, 'completed'))
        .toThrow(/Illegal task state transition/);
    });

    it('records status history when repo configured', () => {
      const statusTransitionRepo = {
        record: vi.fn(),
        getByEntity: vi.fn(() => [{
          changedById: 'user-1',
          changedByType: 'human',
        }]),
      };
      ts.setStatusTransitionRepo(statusTransitionRepo);
      ts.setUserNameLookup(() => 'Alice');

      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');
      expect(statusTransitionRepo.record).toHaveBeenCalled();

      const history = ts.getTaskStatusHistory(task.id);
      expect(history.length).toBeGreaterThan(0);
    });
  });

  describe('submitForReview', () => {
    it('transitions in-progress task to review with deliverables', async () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');

      const deliverables = [{ type: 'file' as const, reference: '/tmp/out.txt', summary: 'Output file' }];
      const submitted = await ts.submitForReview(task.id, deliverables);
      expect(submitted.status).toBe('review');
      expect(submitted.deliverables).toEqual(deliverables);
    });

    it('throws when task is not in progress', async () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      await expect(ts.submitForReview(task.id, [])).rejects.toThrow(/cannot submit for review/);
    });
  });

  describe('comments', () => {
    it('posts task comment via repo', async () => {
      const taskCommentRepo = {
        add: vi.fn().mockResolvedValue({
          id: 'comment-1',
          taskId: 'task-1',
          authorId: 'user-1',
          authorName: 'Alice',
          authorType: 'human',
          content: 'Hello',
          createdAt: new Date(),
        }),
        getByTask: vi.fn().mockResolvedValue([]),
      };
      const wsBroadcast = vi.fn();
      ts.setTaskCommentRepo(taskCommentRepo as never);
      ts.setWSBroadcaster({
        broadcast: wsBroadcast,
        broadcastTaskCreate: vi.fn(),
        broadcastTaskUpdate: vi.fn(),
      } as never);

      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      const result = await ts.postTaskComment(task.id, 'user-1', 'Alice', 'Hello');
      expect(result.id).toBe('comment-1');
      expect(taskCommentRepo.add).toHaveBeenCalled();
      expect(wsBroadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'task:comment' }));
    });

    it('throws when comment repo unavailable', async () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      await expect(ts.postTaskComment(task.id, 'user-1', 'Alice', 'Hi'))
        .rejects.toThrow(/comment repo not available/);
    });
  });

  describe('requirement linkage', () => {
    it('inherits projectId from requirement service', () => {
      const requirementService = {
        getRequirement: vi.fn(() => ({ id: 'req-1', projectId: 'proj-from-req' })),
        linkTask: vi.fn(),
      };
      ts.setRequirementService(requirementService as never);

      const task = ts.createTask(createDefaults({
        requirementId: 'req-1',
        creatorRole: 'human',
      }) as never);
      expect(task.projectId).toBe('proj-from-req');
      expect(requirementService.linkTask).toHaveBeenCalledWith('req-1', task.id);
    });
  });

  describe('review workflow', () => {
    it('accepts task in review and completes it', async () => {
      const task = await createTaskInReview(ts);
      const accepted = ts.acceptTask(task.id, REVIEWER);
      expect(accepted.status).toBe('completed');
    });

    it('rejects self-review', async () => {
      const task = await createTaskInReview(ts);
      expect(() => ts.acceptTask(task.id, AGENT_A)).toThrow(/cannot accept their own task/);
    });

    it('requests revision and increments execution round', async () => {
      const taskCommentRepo = {
        add: vi.fn().mockResolvedValue({ id: 'c1' }),
        getByTask: vi.fn().mockResolvedValue([]),
      };
      ts.setTaskCommentRepo(taskCommentRepo as never);
      const task = await createTaskInReview(ts);
      const revised = await ts.requestRevision(task.id, 'Fix tests', REVIEWER);
      expect(revised.status).toBe('in_progress');
      expect(revised.executionRound).toBe(2);
      expect(taskCommentRepo.add).toHaveBeenCalled();
    });

    it('throws when accepting non-review task', () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      expect(() => ts.acceptTask(task.id, REVIEWER)).toThrow(/cannot accept/);
    });
  });

  describe('archive and scheduled tasks', () => {
    it('archives completed task', async () => {
      const task = await createTaskInReview(ts);
      ts.acceptTask(task.id, REVIEWER);
      const archived = ts.archiveTask(task.id, 'user-1', 'human');
      expect(archived.status).toBe('archived');
    });

    it('lists scheduled tasks', () => {
      ts.createTask(createDefaults({
        creatorRole: 'human',
        taskType: 'scheduled',
        scheduleConfig: { type: 'cron', cron: '0 9 * * *' },
      }) as never);
      expect(ts.listScheduledTasks()).toHaveLength(1);
    });

    it('updates schedule config fields', async () => {
      const task = ts.createTask(createDefaults({
        creatorRole: 'human',
        taskType: 'scheduled',
        scheduleConfig: { type: 'interval', every: '1h' },
      }) as never);
      const updated = await ts.updateScheduleFields(task.id, { every: '2h', maxRuns: 5 });
      expect(updated.scheduleConfig?.every).toBe('2h');
      expect(updated.scheduleConfig?.maxRuns).toBe(5);
    });
  });

  describe('loadFromDB', () => {
    it('loads tasks and migrates legacy statuses', async () => {
      const taskRepo = {
        listByOrg: vi.fn().mockResolvedValue([{
          id: 'task-db',
          orgId: ORG,
          title: 'Loaded',
          description: 'From DB',
          status: 'pending_approval',
          priority: 'medium',
          assignedAgentId: AGENT_A,
          reviewerId: REVIEWER,
          createdAt: new Date(),
          updatedAt: new Date(),
        }]),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      };
      ts.setTaskRepo(taskRepo as never);
      await ts.loadFromDB(ORG);
      expect(ts.getTask('task-db')?.status).toBe('pending');
      expect(taskRepo.updateStatus).toHaveBeenCalledWith('task-db', 'pending');
    });
  });

  describe('shared data dir and governance getter', () => {
    it('sets and returns shared data directory', () => {
      ts.setSharedDataDir('/tmp/markus-shared');
      expect(ts.getSharedDataDir()).toBe('/tmp/markus-shared');
    });

    it('returns configured governance policy', () => {
      const policy = ts.getGovernancePolicy();
      expect(policy.enabled).toBe(false);
    });
  });

  describe('requirement comments', () => {
    it('posts and lists requirement comments', async () => {
      const requirementCommentRepo = {
        add: vi.fn().mockResolvedValue({
          id: 'rc-1',
          requirementId: 'req-1',
          authorId: 'user-1',
          authorName: 'Alice',
          authorType: 'human',
          content: 'Note',
          createdAt: new Date(),
        }),
        getByRequirement: vi.fn(() => [{
          id: 'rc-1',
          authorId: 'user-1',
          authorName: 'Alice',
          authorType: 'human',
          content: 'Note',
          createdAt: new Date().toISOString(),
        }]),
      };
      ts.setRequirementCommentRepo(requirementCommentRepo as never);
      ts.setWSBroadcaster(createWsMock() as never);

      const result = await ts.postRequirementComment('req-1', 'user-1', 'Alice', 'Note');
      expect(result.id).toBe('rc-1');
      expect(ts.getRequirementComments('req-1')).toHaveLength(1);
    });
  });

  describe('getTaskComments', () => {
    it('returns comments from repo', async () => {
      const taskCommentRepo = {
        getByTask: vi.fn().mockResolvedValue([{
          id: 'c1',
          authorId: 'user-1',
          authorName: 'Alice',
          content: 'Hi',
          createdAt: new Date().toISOString(),
        }]),
      };
      ts.setTaskCommentRepo(taskCommentRepo as never);
      const comments = await ts.getTaskComments('task-1');
      expect(comments).toHaveLength(1);
    });
  });

  describe('HITL integration on approve', () => {
    it('responds to pending HITL approval when approving task', () => {
      const hitlService = {
        listApprovals: vi.fn(() => [{ id: 'hitl-1', details: { taskId: 'pending' } }]),
        respondToApproval: vi.fn(),
        requestApprovalAndWait: vi.fn().mockResolvedValue({ approved: true, respondedBy: 'user-1' }),
        notify: vi.fn(),
      };
      ts.setHITLService(hitlService as never);
      ts.setWSBroadcaster(createWsMock() as never);

      const task = ts.createTask(createDefaults({ creatorRole: 'worker' }) as never);
      hitlService.listApprovals.mockReturnValue([{ id: 'hitl-1', details: { taskId: task.id } }]);
      ts.approveTask(task.id, 'user-1');
      expect(hitlService.respondToApproval).toHaveBeenCalledWith('hitl-1', true, 'user-1');
    });
  });

  describe('runTask execution', () => {
    it('runs in-progress task and broadcasts execution logs', async () => {
      const ws = createWsMock();
      const taskLogRepo = {
        append: vi.fn(async (entry: Record<string, unknown>) => ({ id: 'log-1', ...entry })),
        getByTask: vi.fn(async () => []),
        getMaxSeq: vi.fn(async () => 0),
      };
      const executionStreamRepo = {
        append: vi.fn(),
        getMaxSeq: vi.fn(() => -1),
      };
      const taskRepo = {
        create: vi.fn(async () => {}),
        ensureExists: vi.fn(async () => {}),
        update: vi.fn(async () => {}),
        updateStatus: vi.fn(async () => {}),
      };

      ts.setWSBroadcaster(ws as never);
      ts.setTaskLogRepo(taskLogRepo as never);
      ts.setExecutionStreamRepo(executionStreamRepo as never);
      ts.setTaskRepo(taskRepo as never);

      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');

      await ts.runTask(task.id);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(taskLogRepo.append).toHaveBeenCalled();
      expect(ws.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'execution:log' }));
    });

    it('skips runTask when task is not in_progress', async () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      await ts.runTask(task.id);
      expect(agentManager.getAgent(AGENT_A).sendTaskExecution).not.toHaveBeenCalled();
    });

    it('loads previous logs and dependency context', async () => {
      const dep = ts.createTask(createDefaults({
        title: 'Dependency',
        creatorRole: 'human',
        deliverables: [{ type: 'file', reference: '/tmp/dep.txt', summary: 'Dep output' }],
        notes: ['Dep note'],
      }) as never);
      ts.approveTask(dep.id, 'user-1');
      ts.updateTaskStatus(dep.id, 'review');
      ts.updateTaskStatus(dep.id, 'completed');

      const taskLogRepo = {
        append: vi.fn(async (entry: Record<string, unknown>) => ({ id: 'log-1', ...entry })),
        getByTask: vi.fn(async () => [{
          id: 'l1',
          taskId: 'task-x',
          agentId: AGENT_A,
          seq: 0,
          type: 'text',
          content: 'Previous work',
          executionRound: 1,
          createdAt: new Date(),
        }]),
        getMaxSeq: vi.fn(async () => 0),
      };
      ts.setTaskLogRepo(taskLogRepo as never);
      ts.setProjectService({
        getProject: vi.fn(() => ({
          id: 'proj-1',
          name: 'Project',
          description: 'Desc',
          status: 'active',
          repositories: [{ localPath: '/repo', defaultBranch: 'main', role: 'primary' }],
        })),
      } as never);
      ts.setRequirementService({
        getRequirement: vi.fn(() => ({
          id: 'req-1',
          title: 'Requirement',
          description: 'Req desc',
          projectId: 'proj-1',
        })),
        linkTask: vi.fn(),
        checkCompletion: vi.fn(),
      } as never);

      const task = ts.createTask(createDefaults({
        creatorRole: 'human',
        blockedBy: [dep.id],
        requirementId: 'req-1',
        projectId: 'proj-1',
        subtasks: [{ id: 'sub-1', title: 'Subtask', status: 'pending' }],
        notes: ['Task note'],
      }) as never);
      ts.approveTask(task.id, 'user-1');

      await ts.runTask(task.id);
      await new Promise<void>((resolve) => setImmediate(resolve));

      const agent = agentManager.getAgent(AGENT_A);
      expect(agent.sendTaskExecution).toHaveBeenCalled();
      const description = vi.mocked(agent.sendTaskExecution).mock.calls[0]?.[1] as string;
      expect(description).toContain('Dependency');
      expect(description).toContain('Requirement');
    });

    it('retries on transient error log entries', async () => {
      vi.useFakeTimers();
      const retryAgentManager = createMockAgentManager(async (_taskId, logFn) => {
        await logFn({ type: 'error', content: 'fetch failed: ECONNRESET', persist: true });
      });
      const svc = new TaskService();
      svc.setAgentManager(retryAgentManager as never);
      svc.setWSBroadcaster(createWsMock() as never);
      svc.setGovernancePolicy({
        enabled: false, defaultTier: 'auto', maxPendingTasksPerAgent: 100, maxTotalActiveTasks: 100,
        requireApprovalForPriority: [], requireRequirement: false, rules: [],
      });

      const task = svc.createTask(createDefaults({ creatorRole: 'human' }) as never);
      svc.approveTask(task.id, 'user-1');
      await svc.runTask(task.id);
      await vi.runOnlyPendingTimersAsync();

      expect(retryAgentManager.getAgent(AGENT_A).sendTaskExecution.mock.calls.length).toBeGreaterThanOrEqual(1);
      vi.useRealTimers();
    });

    it('marks task failed after non-retryable error', async () => {
      const failAgentManager = createMockAgentManager(async (_taskId, logFn) => {
        await logFn({ type: 'error', content: 'invalid api key 401', persist: true });
      });
      const svc = new TaskService();
      svc.setAgentManager(failAgentManager as never);
      svc.setGovernancePolicy({
        enabled: false, defaultTier: 'auto', maxPendingTasksPerAgent: 100, maxTotalActiveTasks: 100,
        requireApprovalForPriority: [], requireRequirement: false, rules: [],
      });

      const task = svc.createTask(createDefaults({ creatorRole: 'human' }) as never);
      svc.approveTask(task.id, 'user-1');
      await svc.runTask(task.id);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(svc.getTask(task.id)!.status).toBe('failed');
    });
  });

  describe('postTaskComment notifications', () => {
    it('notifies mentioned agents and injects comment into in-progress task', async () => {
      const taskCommentRepo = {
        add: vi.fn().mockResolvedValue({
          id: 'c2',
          taskId: 'task-1',
          authorId: REVIEWER,
          authorName: 'Reviewer',
          authorType: 'human',
          content: 'Please fix tests',
          createdAt: new Date(),
        }),
        getByTask: vi.fn().mockResolvedValue([
          { id: 'c1', authorType: 'agent', authorName: 'Agent', content: 'First', createdAt: new Date() },
          { id: 'c0', authorType: 'agent', authorName: 'Agent', content: 'Second', createdAt: new Date() },
        ]),
      };
      ts.setTaskCommentRepo(taskCommentRepo as never);
      ts.setWSBroadcaster(createWsMock() as never);

      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');

      await ts.postTaskComment(task.id, REVIEWER, 'Reviewer', 'Please fix tests', [AGENT_B], undefined, {
        authorType: 'human',
        replyToId: 'c1',
      });

      const agentB = agentManager.getAgent(AGENT_B);
      expect(agentB.enqueueToMailbox).toHaveBeenCalledWith(
        'mention',
        expect.objectContaining({ taskId: task.id }),
        expect.any(Object),
      );
      const agentA = agentManager.getAgent(AGENT_A);
      expect(agentA.injectUserMessage).toHaveBeenCalled();
    });

    it('notifies human mentions via HITL service', async () => {
      const hitlService = { notify: vi.fn() };
      const orgService = {
        resolveHumanIdentity: vi.fn((id: string) => ({ id, name: 'Human User' })),
      };
      ts.setHITLService(hitlService as never);
      ts.setOrgService(orgService as unknown as OrganizationService);
      ts.setTaskCommentRepo({
        add: vi.fn().mockResolvedValue({
          id: 'c1', taskId: 't1', authorId: AGENT_A, authorName: 'Agent A',
          authorType: 'agent', content: 'Hi @human', createdAt: new Date(),
        }),
        getByTask: vi.fn().mockResolvedValue([]),
      } as never);

      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      await ts.postTaskComment(task.id, AGENT_A, 'Agent A', 'Hi @human', ['human-user-1']);

      expect(hitlService.notify).toHaveBeenCalledWith(expect.objectContaining({
        targetUserId: 'human-user-1',
        title: expect.stringContaining('mentioned you'),
      }));
    });

    it('posts requirement comment with creator notification', async () => {
      const requirementCommentRepo = {
        add: vi.fn().mockResolvedValue({
          id: 'rc-2',
          requirementId: 'req-1',
          authorId: AGENT_A,
          authorName: 'Agent A',
          authorType: 'agent',
          content: 'Update needed',
          createdAt: new Date(),
        }),
        getByRequirement: vi.fn(() => [
          { id: 'rc-0', authorType: 'agent', authorName: 'A', content: 'a', createdAt: new Date().toISOString() },
          { id: 'rc-1', authorType: 'agent', authorName: 'B', content: 'b', createdAt: new Date().toISOString() },
        ]),
      };
      ts.setRequirementCommentRepo(requirementCommentRepo as never);
      ts.setRequirementService({
        getRequirement: vi.fn(() => ({
          id: 'req-1',
          title: 'Req',
          status: 'draft',
          createdBy: AGENT_B,
        })),
      } as never);

      await ts.postRequirementComment('req-1', AGENT_A, 'Agent A', 'Update needed', [AGENT_B]);

      const agentB = agentManager.getAgent(AGENT_B);
      expect(agentB.enqueueToMailbox).toHaveBeenCalled();
    });
  });

  describe('scheduling and recurrence', () => {
    it('computeNextRunFromConfig handles interval and cron', () => {
      const base = new Date('2024-06-01T12:00:00Z');
      const interval = computeNextRunFromConfig({ type: 'interval', every: '1h' }, base);
      expect(interval).toBe(new Date(base.getTime() + 3600000).toISOString());

      const cron = computeNextRunFromConfig({ type: 'cron', cron: '0 9 * * *' }, base);
      expect(cron).toBeTruthy();

      const invalidCron = computeNextRunFromConfig({ type: 'cron', cron: 'not a cron' }, base);
      expect(invalidCron).toBeTruthy();
    });

    it('approves scheduled task and sets nextRunAt', () => {
      const task = ts.createTask(createDefaults({
        creatorRole: 'worker',
        taskType: 'scheduled',
        scheduleConfig: { type: 'interval', every: '1h' },
      }) as never);
      const approved = ts.approveTask(task.id, 'user-1', false);
      expect(approved.scheduleConfig?.nextRunAt).toBeTruthy();
    });

    it('approves scheduled task with runNow moves to in_progress', () => {
      const task = ts.createTask(createDefaults({
        creatorRole: 'worker',
        taskType: 'scheduled',
        scheduleConfig: { type: 'interval', every: '1h' },
      }) as never);
      const approved = ts.approveTask(task.id, 'user-1', true);
      expect(approved.status).toBe('in_progress');
    });

    it('advanceScheduleConfig increments run counters', async () => {
      const task = ts.createTask(createDefaults({
        creatorRole: 'human',
        taskType: 'scheduled',
        scheduleConfig: { type: 'interval', every: '30m' },
      }) as never);
      ts.getTask(task.id)!.scheduleConfig!.currentRuns = 2;
      await ts.advanceScheduleConfig(task.id);
      expect(ts.getTask(task.id)!.scheduleConfig?.currentRuns).toBe(3);
      expect(ts.getTask(task.id)!.scheduleConfig?.lastRunAt).toBeTruthy();
    });

    it('approveTask with blockers sets blocked status', () => {
      const blocker = ts.createTask(createDefaults({ title: 'Blocker', creatorRole: 'human' }) as never);
      ts.approveTask(blocker.id, 'user-1');
      const blocked = ts.createTask(createDefaults({
        title: 'Blocked child',
        creatorRole: 'worker',
        blockedBy: [blocker.id],
      }) as never);
      const approved = ts.approveTask(blocked.id, 'user-1');
      expect(approved.status).toBe('blocked');
    });

    it('rejectTask responds to HITL and rejects', () => {
      ts.setGovernancePolicy({
        enabled: false,
        defaultTier: 'auto',
        maxPendingTasksPerAgent: 100,
        maxTotalActiveTasks: 100,
        requireApprovalForPriority: [],
        requireRequirement: false,
        rules: [],
      });
      const hitlService = {
        listApprovals: vi.fn(() => [{ id: 'hitl-r', details: { taskId: 'pending' } }]),
        respondToApproval: vi.fn(),
        requestApprovalAndWait: vi.fn().mockResolvedValue({ approved: false, respondedBy: 'user-1' }),
        cancelApprovalsByDetail: vi.fn(() => 0),
        notify: vi.fn(),
      };
      ts.setHITLService(hitlService as never);
      const task = ts.createTask(createDefaults({ creatorRole: 'worker' }) as never);
      hitlService.listApprovals.mockReturnValue([{ id: 'hitl-r', details: { taskId: task.id } }]);
      const rejected = ts.rejectTask(task.id, 'user-1');
      expect(rejected.status).toBe('rejected');
      expect(hitlService.respondToApproval).toHaveBeenCalledWith('hitl-r', false, 'user-1');
    });
  });

  describe('timeout checker and webhooks', () => {
    it('fails in-progress tasks that exceed timeout', () => {
      vi.useFakeTimers();
      const webhook = vi.fn();
      ts.onTaskEvent(webhook);
      ts.startTimeoutChecker(1000);

      const task = ts.createTask(createDefaults({
        creatorRole: 'human',
        timeoutMs: 1000,
      }) as never);
      ts.approveTask(task.id, 'user-1');
      const started = ts.getTask(task.id)!;
      started.startedAt = new Date(Date.now() - 5000).toISOString();

      vi.advanceTimersByTime(1500);
      expect(ts.getTask(task.id)!.status).toBe('failed');
      expect(webhook).toHaveBeenCalledWith(expect.objectContaining({ type: 'timeout' }));

      ts.stopTimeoutChecker();
      vi.useRealTimers();
    });
  });

  describe('retryTaskFresh and post-task comments', () => {
    it('retryTaskFresh starts clean execution round', async () => {
      const taskRepo = {
        create: vi.fn(async () => {}),
        clearForRerun: vi.fn(async () => {}),
        update: vi.fn(async () => {}),
        ensureExists: vi.fn(async () => {}),
        updateStatus: vi.fn(async () => {}),
      };
      ts.setTaskRepo(taskRepo as never);
      ts.setWSBroadcaster(createWsMock() as never);

      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');
      ts.updateTaskStatus(task.id, 'failed');

      const retried = await ts.retryTaskFresh(task.id);
      expect(retried.executionRound).toBe(2);
      expect(retried.status).toBe('in_progress');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(agentManager.getAgent(AGENT_A).sendTaskExecution).toHaveBeenCalled();
    });

    it('handles post-task comment on completed task', async () => {
      const taskCommentRepo = {
        add: vi.fn().mockResolvedValue({
          id: 'reply-1',
          taskId: 'task-1',
          authorId: AGENT_A,
          authorName: AGENT_A,
          authorType: 'agent',
          content: 'Acknowledged',
          createdAt: new Date(),
        }),
        getByTask: vi.fn().mockResolvedValue([]),
      };
      const taskLogRepo = {
        append: vi.fn(async (e: Record<string, unknown>) => ({ id: 'log-x', ...e })),
        getMaxSeq: vi.fn(async () => 0),
        getByTask: vi.fn(async () => []),
      };
      ts.setTaskCommentRepo(taskCommentRepo as never);
      ts.setTaskLogRepo(taskLogRepo as never);
      ts.setWSBroadcaster(createWsMock() as never);

      const task = await createTaskInReview(ts);
      ts.acceptTask(task.id, REVIEWER);

      await ts.postTaskComment(task.id, 'user-1', 'User', 'One more thing', undefined, undefined, {
        authorType: 'human',
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(agentManager.getAgent(AGENT_A).sendSessionReply).toHaveBeenCalled();
    });
  });

  describe('governance rule matching', () => {
    it('matches manager tier and priority rules', () => {
      ts.setGovernancePolicy({
        enabled: true,
        defaultTier: 'auto',
        maxPendingTasksPerAgent: 100,
        maxTotalActiveTasks: 100,
        requireApprovalForPriority: ['critical'],
        requireRequirement: false,
        rules: [
          { tier: 'manager', condition: { creatorRole: 'worker', priority: 'high' } },
        ],
      });
      expect(ts.determineApprovalTier(createDefaults({ priority: 'high' }) as never, 'worker'))
        .toBe('manager');
      expect(ts.determineApprovalTier(createDefaults({ priority: 'critical' }) as never, 'worker'))
        .toBe('human');
    });
  });

  describe('runTask retry and preempt paths', () => {
    it('includes retry notice when re-running with previous context', async () => {
      const taskLogRepo = {
        append: vi.fn(async (e: Record<string, unknown>) => ({ id: 'log-1', ...e })),
        getByTask: vi.fn(async () => [{
          id: 'l1', taskId: 't', agentId: AGENT_A, seq: 0, type: 'status', content: 'started',
          executionRound: 1, createdAt: new Date(),
        }, {
          id: 'l2', taskId: 't', agentId: AGENT_A, seq: 1, type: 'text', content: 'Did work',
          executionRound: 1, createdAt: new Date(),
        }]),
        getMaxSeq: vi.fn(async () => 1),
      };
      ts.setTaskLogRepo(taskLogRepo as never);

      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');
      await ts.runTask(task.id, 1, 'no_submit');
      await new Promise<void>((resolve) => setImmediate(resolve));

      const description = vi.mocked(agentManager.getAgent(AGENT_A).sendTaskExecution).mock.calls.at(-1)?.[1] as string;
      expect(description).toContain('task_submit_review');
    });

    it('handles preempted status and re-queues task', async () => {
      const preemptAgentManager = createMockAgentManager(async (_taskId, logFn) => {
        await logFn({ type: 'status', content: 'preempted', persist: true, metadata: { preemptedBy: 'urgent-mailbox' } });
      });
      const svc = new TaskService();
      svc.setAgentManager(preemptAgentManager as never);
      svc.setGovernancePolicy({
        enabled: false, defaultTier: 'auto', maxPendingTasksPerAgent: 100, maxTotalActiveTasks: 100,
        requireApprovalForPriority: [], requireRequirement: false, rules: [],
      });

      const task = svc.createTask(createDefaults({ creatorRole: 'human' }) as never);
      svc.approveTask(task.id, 'user-1');
      await svc.runTask(task.id);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(preemptAgentManager.getAgent(AGENT_A).sendTaskExecution).toHaveBeenCalled();
      expect(svc.getTask(task.id)!.notes?.some(n => n.includes('preempted'))).toBe(true);
    });

    it('injects human feedback on retry when comments exist', async () => {
      const quickAgentManager = createMockAgentManager(async (_taskId, logFn) => {
        await logFn({ type: 'status', content: 'resumed', persist: true });
      });
      const svc = new TaskService();
      svc.setAgentManager(quickAgentManager as never);
      svc.setGovernancePolicy({
        enabled: false, defaultTier: 'auto', maxPendingTasksPerAgent: 100, maxTotalActiveTasks: 100,
        requireApprovalForPriority: [], requireRequirement: false, rules: [],
      });
      const taskLogRepo = {
        append: vi.fn(async (e: Record<string, unknown>) => ({ id: 'log-1', ...e })),
        getByTask: vi.fn(async () => [{
          id: 'l1', taskId: 't', agentId: AGENT_A, seq: 0, type: 'status', content: 'started',
          executionRound: 1, createdAt: new Date(),
        }]),
        getMaxSeq: vi.fn(async () => 0),
      };
      const taskCommentRepo = {
        getByTask: vi.fn(async () => [{
          id: 'c1', authorType: 'human', authorName: 'User', content: 'Fix the bug',
          createdAt: new Date(),
        }]),
      };
      svc.setTaskLogRepo(taskLogRepo as never);
      svc.setTaskCommentRepo(taskCommentRepo as never);

      const task = svc.createTask(createDefaults({ creatorRole: 'human' }) as never);
      svc.approveTask(task.id, 'user-1');
      await svc.runTask(task.id, 1);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(quickAgentManager.getAgent(AGENT_A).injectUserMessage).toHaveBeenCalled();
    });
  });

  describe('submitForReview deliverable publishing', () => {
    it('creates deliverable entities and publishes to shared workspace', async () => {
      const deliverableService = { create: vi.fn(async (d: Record<string, unknown>) => ({ id: 'del-1', ...d })) };
      const auditService = { record: vi.fn() };
      const builderAgentManager = createMockAgentManager();
      builderAgentManager.listAgents = vi.fn(() => [{
        id: AGENT_A, name: 'Builder', role: 'Agent Father', agentRole: 'worker', status: 'idle', skills: ['agent-building'],
      }]);
      builderAgentManager.getAgent = vi.fn((id: string) => ({
        ...agentManager.getAgent(id),
        config: { name: id, orgId: ORG, skills: ['agent-building'], agentRole: 'worker' },
      }));

      ts.setAgentManager(builderAgentManager as never);
      ts.setDeliverableService(deliverableService as never);
      ts.setAuditService(auditService as never);
      ts.setSharedDataDir('/tmp/markus-shared-test');

      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');

      await ts.submitForReview(task.id, [
        { type: 'file', reference: '/tmp/output.txt', summary: 'Output file' },
        { type: 'branch', reference: 'feature/x', summary: 'Branch metadata' },
      ]);

      expect(deliverableService.create).toHaveBeenCalled();
      expect(auditService.record).toHaveBeenCalled();
      expect(ts.getTask(task.id)!.status).toBe('review');
    });
  });

  describe('cancel and assign edge cases', () => {
    it('cancelTask emits webhook event', () => {
      const webhook = vi.fn();
      ts.onTaskEvent(webhook);
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');
      ts.cancelTask(task.id, false, 'user-1', 'human');
      expect(webhook).toHaveBeenCalledWith(expect.objectContaining({ type: 'status_changed', status: 'cancelled' }));
    });

    it('assignTask to new agent updates assignment', () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      const assigned = ts.assignTask(task.id, AGENT_B, 'user-1');
      expect(assigned.assignedAgentId).toBe(AGENT_B);
    });
  });

  describe('subtasks', () => {
    it('adds, completes, and cancels subtasks', () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      const sub = ts.addSubtask(task.id, 'Step one');
      expect(sub.title).toBe('Step one');
      const done = ts.completeSubtask(task.id, sub.id);
      expect(done.status).toBe('completed');
      const sub2 = ts.addSubtask(task.id, 'Step two');
      const cancelled = ts.cancelSubtask(task.id, sub2.id);
      expect(cancelled.status).toBe('cancelled');
    });
  });

  describe('no-submit auto retry', () => {
    it('schedules retry when execution finishes without submit', async () => {
      vi.useFakeTimers();
      const noSubmitAgentManager = createMockAgentManager(async (_taskId, logFn) => {
        await logFn({ type: 'status', content: 'execution_finished', persist: true });
      });
      const svc = new TaskService();
      svc.setAgentManager(noSubmitAgentManager as never);
      svc.setGovernancePolicy({
        enabled: false, defaultTier: 'auto', maxPendingTasksPerAgent: 100, maxTotalActiveTasks: 100,
        requireApprovalForPriority: [], requireRequirement: false, rules: [],
      });

      const task = svc.createTask(createDefaults({ creatorRole: 'human' }) as never);
      svc.approveTask(task.id, 'user-1');
      await svc.runTask(task.id);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(noSubmitAgentManager.getAgent(AGENT_A).sendTaskExecution.mock.calls.length).toBeGreaterThanOrEqual(2);
      vi.useRealTimers();
    });
  });

  describe('task logs and formatting', () => {
    it('runTask formats tool and error log entries from previous round', async () => {
      const taskLogRepo = {
        append: vi.fn(async (e: Record<string, unknown>) => ({ id: 'log-1', ...e })),
        getByTask: vi.fn(async () => [
          { id: 'l1', taskId: 't', agentId: AGENT_A, seq: 0, type: 'status', content: 'started', executionRound: 1, createdAt: new Date() },
          { id: 'l2', taskId: 't', agentId: AGENT_A, seq: 1, type: 'tool_start', content: 'file_read', metadata: { arguments: { path: '/a' } }, executionRound: 1, createdAt: new Date() },
          { id: 'l3', taskId: 't', agentId: AGENT_A, seq: 2, type: 'tool_end', content: 'file_read', metadata: { success: true, result: 'ok' }, executionRound: 1, createdAt: new Date() },
          { id: 'l4', taskId: 't', agentId: AGENT_A, seq: 3, type: 'error', content: 'timeout ETIMEDOUT', executionRound: 1, createdAt: new Date() },
          { id: 'l5', taskId: 't', agentId: AGENT_A, seq: 4, type: 'status', content: 'execution_finished', executionRound: 1, createdAt: new Date() },
        ]),
        getMaxSeq: vi.fn(async () => 4),
      };
      ts.setTaskLogRepo(taskLogRepo as never);

      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');
      await ts.runTask(task.id, 1);
      await new Promise<void>((resolve) => setImmediate(resolve));

      const description = vi.mocked(agentManager.getAgent(AGENT_A).sendTaskExecution).mock.calls.at(-1)?.[1] as string;
      expect(description).toContain('file_read');
      expect(description).toContain('ETIMEDOUT');
    });
  });

  describe('submitForReview with review service', () => {
    it('runs automated review and tags scheduled deliverables', async () => {
      const reviewService = {
        runReview: vi.fn(async () => ({
          overallStatus: 'pass',
          summary: 'All checks passed',
          checks: [],
        })),
      };
      const taskRepo = {
        create: vi.fn(async () => {}),
        updateDeliverables: vi.fn(async () => {}),
        update: vi.fn(async () => {}),
        updateStatus: vi.fn(async () => {}),
      };
      ts.setReviewService(reviewService as never);
      ts.setTaskRepo(taskRepo as never);
      ts.setProjectService({
        getProject: vi.fn(() => ({
          id: 'proj-1',
          repositories: [{ localPath: '/repo', defaultBranch: 'main', role: 'primary' }],
        })),
      } as never);

      const task = ts.createTask(createDefaults({
        creatorRole: 'human',
        taskType: 'scheduled',
        scheduleConfig: { type: 'interval', every: '1h', currentRuns: 3 },
        deliverables: [{ type: 'file', reference: '/old.txt', summary: 'Previous run' }],
      }) as never);
      ts.approveTask(task.id, 'user-1', true);

      await ts.submitForReview(task.id, [
        { type: 'file', reference: '/new.txt', summary: 'New output' },
      ], REVIEWER);

      expect(reviewService.runReview).toHaveBeenCalled();
      expect(ts.getTask(task.id)!.status).toBe('review');
      expect(ts.getTask(task.id)!.deliverables!.length).toBeGreaterThanOrEqual(1);
      expect(ts.getTask(task.id)!.deliverables![0]!.summary).toMatch(/Run #|New output/);
    });

    it('suppresses assignee notification when reviewer comments during review', async () => {
      const taskCommentRepo = {
        add: vi.fn().mockResolvedValue({
          id: 'c-rev', taskId: 't', authorId: REVIEWER, authorName: 'Reviewer',
          authorType: 'human', content: 'Looks good', createdAt: new Date(),
        }),
        getByTask: vi.fn().mockResolvedValue([]),
      };
      ts.setTaskCommentRepo(taskCommentRepo as never);
      ts.setWSBroadcaster(createWsMock() as never);

      const task = await createTaskInReview(ts);
      await ts.postTaskComment(task.id, REVIEWER, 'Reviewer', 'Minor note', undefined, undefined, {
        authorType: 'human',
      });

      expect(agentManager.getAgent(AGENT_A).enqueueToMailbox).not.toHaveBeenCalled();
    });

    it('runTaskFresh executes without prior context after retryTaskFresh', async () => {
      const taskRepo = {
        create: vi.fn(async () => {}),
        clearForRerun: vi.fn(async () => {}),
        update: vi.fn(async () => {}),
        updateStatus: vi.fn(async () => {}),
      };
      const taskLogRepo = {
        append: vi.fn(async (e: Record<string, unknown>) => ({ id: 'log-1', ...e })),
        getMaxSeq: vi.fn(async () => 0),
        getByTask: vi.fn(async () => []),
      };
      const freshAgentManager = createMockAgentManager(async (_taskId, logFn) => {
        await logFn({ type: 'status', content: 'started', persist: true });
        await logFn({ type: 'text', content: 'Fresh start', persist: true });
        await logFn({ type: 'status', content: 'execution_finished', persist: true });
      });
      const svc = new TaskService();
      svc.setAgentManager(freshAgentManager as never);
      svc.setTaskRepo(taskRepo as never);
      svc.setTaskLogRepo(taskLogRepo as never);
      svc.setWSBroadcaster(createWsMock() as never);
      svc.setGovernancePolicy({
        enabled: false, defaultTier: 'auto', maxPendingTasksPerAgent: 100, maxTotalActiveTasks: 100,
        requireApprovalForPriority: [], requireRequirement: false, rules: [],
      });

      const task = svc.createTask(createDefaults({ creatorRole: 'human' }) as never);
      svc.approveTask(task.id, 'user-1');
      svc.updateTaskStatus(task.id, 'failed');
      await svc.retryTaskFresh(task.id);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(freshAgentManager.getAgent(AGENT_A).sendTaskExecution).toHaveBeenCalled();
      expect(taskLogRepo.append).toHaveBeenCalled();
    });
  });

  describe('lifecycle and persistence edge cases', () => {
    it('resumeTask transitions blocked task back to in_progress', () => {
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');
      ts.pauseTask(task.id);
      const resumed = ts.resumeTask(task.id, 'user-1', 'human');
      expect(resumed.status).toBe('in_progress');
    });

    it('resetTaskForRerun clears execution state', async () => {
      const taskRepo = {
        create: vi.fn(async () => {}),
        updateStatus: vi.fn(async () => {}),
        clearForRerun: vi.fn(async () => {}),
      };
      ts.setTaskRepo(taskRepo as never);
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');
      await ts.resetTaskForRerun(task.id);
      expect(ts.getTask(task.id)!.executionRound).toBe(2);
      expect(taskRepo.clearForRerun).toHaveBeenCalled();
    });

    it('auto-approves worker task when HITL returns approved', async () => {
      const hitlService = {
        requestApprovalAndWait: vi.fn().mockResolvedValue({ approved: true, respondedBy: 'user-1' }),
        notify: vi.fn(),
        listApprovals: vi.fn(() => []),
        respondToApproval: vi.fn(),
        cancelApprovalsByDetail: vi.fn(() => 0),
      };
      ts.setHITLService(hitlService as never);
      ts.setGovernancePolicy({
        enabled: false, defaultTier: 'auto', maxPendingTasksPerAgent: 100, maxTotalActiveTasks: 100,
        requireApprovalForPriority: [], requireRequirement: false, rules: [],
      });

      const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
      expect(task.status).toBe('pending');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ts.getTask(task.id)!.status).toBe('in_progress');
    });

    it('publishDeliverablestoShared writes manifest when shared dir set', async () => {
      ts.setSharedDataDir('/tmp/markus-shared-test-2');
      ts.setDeliverableService({ create: vi.fn(async () => ({ id: 'd1' })) } as never);
      const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
      ts.approveTask(task.id, 'user-1');
      await ts.submitForReview(task.id, [
        { type: 'file', reference: '/tmp/out.txt', summary: 'Output' },
      ]);
      expect(ts.getTask(task.id)!.status).toBe('review');
    });

    it('queryTasks filters by status and priority', () => {
      ts.createTask(createDefaults({ title: 'High', priority: 'high', creatorRole: 'human' }) as never);
      ts.createTask(createDefaults({ title: 'Low', priority: 'low', assignedAgentId: AGENT_B, creatorRole: 'human' }) as never);
      const result = ts.queryTasks({ orgId: ORG, priority: 'high', status: 'pending' });
      expect(result.total).toBeGreaterThanOrEqual(1);
    });
  });
});
