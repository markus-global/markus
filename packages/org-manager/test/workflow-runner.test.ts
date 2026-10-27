import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowRunner, parseDurationMs } from '../src/workflow-runner.js';
import type { WorkflowTemplate } from '@markus/shared';

const TEMPLATE: WorkflowTemplate = {
  name: 'demo-wf',
  displayName: 'Demo Workflow',
  description: 'Demo',
  version: '1.0.0',
  params: [{ name: 'topic', type: 'string', required: true }],
  steps: [
    { id: 's1', name: 'Plan', role: 'planner', prompt: 'Plan {{topic}}', type: 'agent_task' },
    { id: 's2', name: 'Build', role: 'builder', prompt: 'Build {{topic}}', type: 'agent_task', depends_on: ['s1'], retry_count: 1 },
  ],
};

function createMocks() {
  const tasks = new Map<string, Record<string, unknown>>();
  let taskCounter = 0;

  const requirementService = {
    createRequirement: vi.fn((req: Record<string, unknown>) => ({
      id: 'req-1',
      ...req,
      status: 'in_progress',
    })),
  };

  const taskService = {
    createTask: vi.fn((opts: Record<string, unknown>) => {
      const task = {
        id: `task-${++taskCounter}`,
        status: 'pending',
        title: opts.title,
        assignedAgentId: opts.assignedAgentId,
        ...opts,
      };
      tasks.set(task.id, task);
      return task;
    }),
    getTask: vi.fn((id: string) => tasks.get(id)),
    cancelTask: vi.fn((id: string) => {
      const task = tasks.get(id);
      if (task) task.status = 'cancelled';
    }),
    pauseTask: vi.fn((id: string) => {
      const task = tasks.get(id);
      if (task) task.status = 'paused';
    }),
    resumeTask: vi.fn((id: string) => {
      const task = tasks.get(id);
      if (task) task.status = 'pending';
    }),
    updateTaskStatus: vi.fn((id: string, status: string) => {
      const task = tasks.get(id);
      if (task) task.status = status;
    }),
    _tasks: tasks,
  };

  const orgService = {
    getTeam: vi.fn(() => ({
      id: 'team-1',
      orgId: 'org-1',
      name: 'Core',
      memberAgentIds: ['agent-planner', 'agent-builder'],
      managerId: 'agent-planner',
    })),
    getAgentManager: vi.fn(() => ({
      getAgent: vi.fn(() => ({ enqueueToMailbox: vi.fn() })),
      listAgents: vi.fn(() => []),
    })),
  };

  const runRepo = {
    create: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(null),
    findByTeamAndWorkflow: vi.fn().mockResolvedValue([]),
    findByRequirementId: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getNextRunNumber: vi.fn().mockResolvedValue(1),
    findRunning: vi.fn().mockResolvedValue([]),
    findAllRunning: vi.fn().mockResolvedValue([]),
  };

  const wsBroadcast = vi.fn();

  return { requirementService, taskService, orgService, runRepo, wsBroadcast };
}

describe('WorkflowRunner', () => {
  let runner: WorkflowRunner;
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
    runner = new WorkflowRunner(
      mocks.requirementService as never,
      mocks.taskService as never,
      mocks.orgService as never,
    );
    runner.setRunRepo(mocks.runRepo);
    runner.setWSBroadcaster({ broadcast: mocks.wsBroadcast } as never);
  });

  describe('createRun', () => {
    it('creates requirement, tasks, and run record', async () => {
      const run = await runner.createRun(
        'team-1',
        TEMPLATE,
        { topic: 'auth' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      );

      expect(run.status).toBe('running');
      expect(run.runNumber).toBe(1);
      expect(run.taskIds).toHaveLength(2);
      expect(mocks.requirementService.createRequirement).toHaveBeenCalledWith(expect.objectContaining({
        source: 'workflow',
        projectId: 'proj-1',
      }));
      expect(mocks.taskService.createTask).toHaveBeenCalledTimes(2);
      expect(mocks.runRepo.create).toHaveBeenCalled();
      expect(mocks.wsBroadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'workflow:run_started' }));
    });

    it('throws when required param missing', async () => {
      await expect(runner.createRun(
        'team-1',
        TEMPLATE,
        {},
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      )).rejects.toThrow(/Required parameter "topic"/);
    });

    it('cleans up tasks on failure', async () => {
      mocks.taskService.createTask
        .mockImplementationOnce((opts: Record<string, unknown>) => ({
          id: 'task-1', status: 'pending', ...opts,
        }))
        .mockImplementationOnce(() => { throw new Error('task create failed'); });

      await expect(runner.createRun(
        'team-1',
        TEMPLATE,
        { topic: 'auth' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      )).rejects.toThrow(/task create failed/);

      expect(mocks.taskService.cancelTask).toHaveBeenCalledWith('task-1', false, 'system', 'system');
    });
  });

  describe('cancelRun', () => {
    it('cancels running workflow and tasks', async () => {
      const run = await runner.createRun(
        'team-1',
        TEMPLATE,
        { topic: 'auth' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      );

      const cancelled = await runner.cancelRun(run.id, 'user-1');
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.completedAt).toBeDefined();
      expect(mocks.runRepo.updateStatus).toHaveBeenCalledWith(run.id, 'cancelled', expect.any(String));
    });

    it('throws when cancelling completed run', async () => {
      const run = await runner.createRun(
        'team-1',
        TEMPLATE,
        { topic: 'auth' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      );
      run.status = 'completed';
      await expect(runner.cancelRun(run.id)).rejects.toThrow(/already completed/);
    });
  });

  /**
 * P0 (2026-10-27) — the four structural guarantees:
 *   1. a workflow task carries its (run, step) identity from birth;
 *   2. a run snapshots the template it started with;
 *   3. a team cannot exceed its concurrent-run quota;
 *   4. `steps[].timeout` is actually enforced (it used to be stored and ignored).
 */
describe('P0 guards', () => {
  it('writes structural identity onto every step task', async () => {
    const run = await runner.createRun(
      'team-1',
      TEMPLATE,
      { topic: 'auth' },
      { planner: 'agent-planner', builder: 'agent-builder' },
      'proj-1',
    );

    const created = mocks.taskService.createTask.mock.calls.map(c => c[0] as Record<string, unknown>);
    expect(created).toHaveLength(2);
    for (const req of created) {
      expect(req['workflowRunId']).toBe(run.id);
      expect(typeof req['workflowStepId']).toBe('string');
      // the legacy in-band marker must be gone from new rows
      expect(String(req['notes'])).not.toMatch(/step:/);
    }
    expect(new Set(created.map(r => r['workflowStepId']))).toEqual(new Set(['s1', 's2']));
  });

  it('snapshots the template (version + hash + definition) into the run', async () => {
    const run = await runner.createRun(
      'team-1',
      TEMPLATE,
      { topic: 'auth' },
      { planner: 'agent-planner', builder: 'agent-builder' },
      'proj-1',
    );
    expect(run.templateVersion).toBe(TEMPLATE.version);
    expect(run.templateHash).toMatch(/^[0-9a-f]{16}$/);
    expect(run.templateSnapshot?.steps.map(s => s.id)).toEqual(['s1', 's2']);

    // the snapshot is what gets persisted, so history survives a template edit
    const persisted = mocks.runRepo.create.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(String(persisted['template_snapshot'])).toContain('"s1"');
  });

  it('refuses a run beyond the team quota, with no side effects', async () => {
    runner.setMaxConcurrentRunsPerTeam(1);
    await runner.createRun(
      'team-1',
      TEMPLATE,
      { topic: 'auth' },
      { planner: 'agent-planner', builder: 'agent-builder' },
      'proj-1',
    );

    const before = mocks.taskService.createTask.mock.calls.length;
    await expect(
      runner.createRun(
        'team-1',
        TEMPLATE,
        { topic: 'auth2' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      ),
    ).rejects.toThrow(/limit 1/);

    // rejected before creating a requirement/tasks/run row
    expect(mocks.taskService.createTask.mock.calls.length).toBe(before);
    expect(mocks.requirementService.createRequirement).toHaveBeenCalledTimes(1);
  });

  it('fails a step that blows its timeout', async () => {
    const timedTemplate: WorkflowTemplate = {
      ...TEMPLATE,
      steps: [{ id: 's1', name: 'Slow', role: 'planner', prompt: 'Do {{topic}}', type: 'agent_task', timeout: '1s' }],
    };
    const run = await runner.createRun(
      'team-1',
      timedTemplate,
      { topic: 'auth' },
      { planner: 'agent-planner' },
      'proj-1',
    );

    const taskId = run.taskIds[0]!;
    const task = mocks.taskService._tasks.get(taskId)!;
    task.status = 'in_progress';
    task.startedAt = new Date(Date.now() - 5_000).toISOString();

    const enforced = await runner.enforceTimeouts();

    expect(enforced).toBe(1);
    expect(mocks.taskService.updateTaskStatus).toHaveBeenCalledWith(
      taskId, 'failed', 'system', false, false, 'system', expect.stringContaining('timed out'),
    );
  });

  it('leaves a step inside its timeout alone', async () => {
    const timedTemplate: WorkflowTemplate = {
      ...TEMPLATE,
      steps: [{ id: 's1', name: 'Slow', role: 'planner', prompt: 'Do {{topic}}', type: 'agent_task', timeout: '1h' }],
    };
    const run = await runner.createRun(
      'team-1',
      timedTemplate,
      { topic: 'auth' },
      { planner: 'agent-planner' },
      'proj-1',
    );
    const task = mocks.taskService._tasks.get(run.taskIds[0]!)!;
    task.status = 'in_progress';
    task.startedAt = new Date().toISOString();

    expect(await runner.enforceTimeouts()).toBe(0);
    expect(mocks.taskService.updateTaskStatus).not.toHaveBeenCalled();
  });
});

describe('parseDurationMs', () => {
  it('parses the documented shorthand and rejects nonsense', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('15m')).toBe(900_000);
    expect(parseDurationMs('2h')).toBe(7_200_000);
    expect(parseDurationMs('1d')).toBe(86_400_000);
    expect(parseDurationMs('250')).toBe(250);
    expect(parseDurationMs('soon')).toBeNull();
    expect(parseDurationMs(undefined)).toBeNull();
    expect(parseDurationMs('0s')).toBeNull();
  });
});

describe('onTaskStatusChange', () => {    it('marks run completed when all tasks complete', async () => {
      const run = await runner.createRun(
        'team-1',
        TEMPLATE,
        { topic: 'auth' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      );

      for (const taskId of run.taskIds) {
        mocks.taskService._tasks.get(taskId)!.status = 'completed';
      }
      const lastTask = mocks.taskService.getTask(run.taskIds[1]) as Record<string, unknown>;
      await runner.onTaskStatusChange(lastTask as never);

      expect(runner.getRun(run.id)?.status).toBe('completed');
      expect(mocks.runRepo.updateStatus).toHaveBeenCalledWith(run.id, 'completed', expect.any(String));
    });

    it('retries failed step when retry_count configured', async () => {
      const run = await runner.createRun(
        'team-1',
        TEMPLATE,
        { topic: 'auth' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      );

      const failedTaskId = run.taskIds[1]!;
      mocks.taskService._tasks.get(failedTaskId)!.status = 'failed';
      const failedTask = mocks.taskService.getTask(failedTaskId) as Record<string, unknown>;

      await runner.onTaskStatusChange(failedTask as never);
      expect(mocks.taskService.updateTaskStatus).toHaveBeenCalledWith(
        failedTaskId, 'pending', 'system', true, false, 'system', expect.stringContaining('auto-retry'),
      );
      expect(runner.getRun(run.id)?.status).toBe('running');
    });

    it('marks run failed when a task fails without retries left', async () => {
      const singleStepTemplate: WorkflowTemplate = {
        ...TEMPLATE,
        steps: [{ id: 's1', name: 'Only', role: 'planner', prompt: 'Do {{topic}}', type: 'agent_task' }],
      };
      const run = await runner.createRun(
        'team-1',
        singleStepTemplate,
        { topic: 'auth' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      );

      const taskId = run.taskIds[0]!;
      mocks.taskService._tasks.get(taskId)!.status = 'failed';
      await runner.onTaskStatusChange(mocks.taskService.getTask(taskId) as never);

      expect(runner.getRun(run.id)?.status).toBe('failed');
    });

    /**
     * The run status is a *projection* of its tasks, so it has to be recomputed
     * on every task change — not only while the run still says `running`.
     * The old guard latched the first terminal verdict forever: a step that
     * failed once and then completed on retry left the run reading
     * "失败 · 9/9 个任务完成" in the Work page.
     */
    it('re-derives a failed run when its retried step completes', async () => {
      const singleStepTemplate: WorkflowTemplate = {
        ...TEMPLATE,
        steps: [{ id: 's1', name: 'Only', role: 'planner', prompt: 'Do {{topic}}', type: 'agent_task' }],
      };
      const run = await runner.createRun(
        'team-1',
        singleStepTemplate,
        { topic: 'auth' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      );

      const taskId = run.taskIds[0]!;
      mocks.taskService._tasks.get(taskId)!.status = 'failed';
      await runner.onTaskStatusChange(mocks.taskService.getTask(taskId) as never);
      expect(runner.getRun(run.id)?.status).toBe('failed');

      // the same task is retried and finishes
      mocks.taskService._tasks.get(taskId)!.status = 'completed';
      await runner.onTaskStatusChange(mocks.taskService.getTask(taskId) as never);

      expect(runner.getRun(run.id)?.status).toBe('completed');
    });

    /** `cancelled` is a human decision, never a projection. */
    it('does not resurrect a cancelled run from a task update', async () => {
      const run = await runner.createRun(
        'team-1',
        TEMPLATE,
        { topic: 'auth' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      );
      await runner.cancelRun(run.id, 'user-1');

      for (const taskId of run.taskIds) {
        mocks.taskService._tasks.get(taskId)!.status = 'completed';
      }
      await runner.onTaskStatusChange(mocks.taskService.getTask(run.taskIds[0]!) as never);

      expect(runner.getRun(run.id)?.status).toBe('cancelled');
    });

    /** Historical rows are healed on read, so old drift cannot survive in the UI. */
    it('heals a stale terminal status when runs are listed', async () => {
      const bare = new WorkflowRunner(
        mocks.requirementService as never,
        mocks.taskService as never,
        mocks.orgService as never,
      );
      const run = await bare.createRun(
        'team-1',
        TEMPLATE,
        { topic: 'auth' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      );
      for (const taskId of run.taskIds) {
        mocks.taskService._tasks.get(taskId)!.status = 'completed';
      }
      // simulate a row written while the ratchet still existed
      const stored = bare.getRun(run.id)!;
      stored.status = 'failed';
      stored.completedAt = new Date().toISOString();

      const listed = await bare.listRuns('team-1', TEMPLATE.name);
      expect(listed.find(r => r.id === run.id)?.status).toBe('completed');
    });
  });

  describe('pause and resume', () => {
    it('pauses and resumes a run', async () => {
      const run = await runner.createRun(
        'team-1',
        TEMPLATE,
        { topic: 'auth' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      );

      mocks.taskService._tasks.get(run.taskIds[0]!)!.status = 'in_progress';
      mocks.taskService._tasks.get(run.taskIds[1]!)!.status = 'pending';

      const paused = await runner.pauseRun(run.id, 'user-1');
      expect(paused.status).toBe('paused');

      mocks.taskService._tasks.get(run.taskIds[1]!)!.status = 'blocked';
      const resumed = await runner.resumeRun(run.id, 'user-1');
      expect(resumed.status).toBe('running');
    });
  });

  describe('queries and persistence', () => {
    it('lists runs and resolves by requirement', async () => {
      const run = await runner.createRun(
        'team-1',
        TEMPLATE,
        { topic: 'auth' },
        { planner: 'agent-planner', builder: 'agent-builder' },
        'proj-1',
      );

      expect(runner.getRun(run.id)?.id).toBe(run.id);
      expect(runner.getRunByRequirement('req-1')?.id).toBe(run.id);
      expect(runner.getActiveRuns('team-1')).toHaveLength(1);

      mocks.runRepo.findByTeamAndWorkflow.mockResolvedValue([{
        id: run.id,
        team_id: run.teamId,
        workflow_name: run.workflowName,
        run_number: run.runNumber,
        requirement_id: run.requirementId,
        task_ids: JSON.stringify(run.taskIds),
        params: JSON.stringify(run.params),
        role_mapping: JSON.stringify({ planner: 'agent-planner', builder: 'agent-builder' }),
        status: run.status,
        triggered_by: 'manual',
        project_id: run.projectId ?? null,
        started_at: run.startedAt,
        completed_at: null,
      }]);
      const listed = await runner.listRuns('team-1', 'demo-wf');
      expect(listed.some(r => r.id === run.id)).toBe(true);
    });

    it('loads runs from DB on getRunAsync', async () => {
      mocks.runRepo.findById.mockResolvedValue({
        id: 'run-db',
        team_id: 'team-1',
        workflow_name: 'demo-wf',
        run_number: 2,
        requirement_id: 'req-db',
        task_ids: JSON.stringify(['task-x']),
        params: JSON.stringify({ topic: 'loaded' }),
        role_mapping: JSON.stringify({ planner: 'agent-planner' }),
        status: 'running',
        triggered_by: 'manual',
        project_id: 'proj-1',
        started_at: new Date().toISOString(),
        completed_at: null,
      });

      const loaded = await runner.getRunAsync('run-db');
      expect(loaded?.runNumber).toBe(2);
      expect(runner.getRun('run-db')?.workflowName).toBe('demo-wf');
    });

    it('loads all running runs from DB', async () => {
      mocks.runRepo.findAllRunning.mockResolvedValue([{
        id: 'run-active',
        team_id: 'team-1',
        workflow_name: 'demo-wf',
        run_number: 1,
        requirement_id: 'req-active',
        task_ids: JSON.stringify([]),
        params: JSON.stringify({}),
        role_mapping: JSON.stringify({}),
        status: 'running',
        triggered_by: 'manual',
        project_id: 'proj-1',
        started_at: new Date().toISOString(),
        completed_at: null,
      }]);
      await runner.loadFromDB();
      expect(runner.getActiveRuns('team-1')).toHaveLength(1);
    });
  });
});
