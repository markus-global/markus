import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkflowScheduler } from '../src/workflow-scheduler.js';

describe('WorkflowScheduler', () => {
  let workflowService: {
    listWorkflows: ReturnType<typeof vi.fn>;
    getWorkflow: ReturnType<typeof vi.fn>;
    buildDefaultRoleMapping: ReturnType<typeof vi.fn>;
  };
  let workflowRunner: {
    getActiveRuns: ReturnType<typeof vi.fn>;
    createRun: ReturnType<typeof vi.fn>;
  };
  let orgService: {
    listTeams: ReturnType<typeof vi.fn>;
    listOrgs: ReturnType<typeof vi.fn>;
    getStorage: ReturnType<typeof vi.fn>;
  };
  let scheduleRepo: {
    findAll: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let scheduler: WorkflowScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    workflowService = {
      listWorkflows: vi.fn(() => [{
        name: 'nightly',
        hasSchedule: true,
        schedule: { every: '1h' },
        params: [{ name: 'topic', default: 'news', auto_generate: true, auto_prompt: 'topic' }],
      }]),
      getWorkflow: vi.fn(() => ({
        name: 'nightly',
        params: [{ name: 'topic', default: 'news', auto_generate: true, auto_prompt: 'topic' }],
      })),
      buildDefaultRoleMapping: vi.fn(() => ({ planner: 'agent-1' })),
    };
    workflowRunner = {
      getActiveRuns: vi.fn(() => []),
      createRun: vi.fn(async () => ({ id: 'run-1', runNumber: 1 })),
    };
    orgService = {
      listTeams: vi.fn(() => [{ id: 'team-1', orgId: 'default' }]),
      listOrgs: vi.fn(() => [{ id: 'default' }]),
      getStorage: vi.fn(() => ({
        projectRepo: {
          listAll: vi.fn(async () => [{ id: 'proj-1', teamIds: ['team-1'] }]),
        },
      })),
    };
    scheduleRepo = {
      findAll: vi.fn(async () => [{
        team_id: 'team-1',
        workflow_name: 'nightly',
        schedule: JSON.stringify({ every: '1h' }),
        next_run_at: '2026-06-15T11:00:00.000Z',
        total_runs: 0,
        last_run_at: null,
        paused: 0,
        last_role_mapping: JSON.stringify({}),
        updated_at: '2026-06-15T10:00:00.000Z',
      }]),
      upsert: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };

    scheduler = new WorkflowScheduler(
      workflowService as never,
      workflowRunner as never,
      orgService as never,
      60_000,
    );
    scheduler.setScheduleRepo(scheduleRepo);
    scheduler.setParamGenerator(async () => 'generated-topic');
  });

  afterEach(async () => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('loads from DB and triggers due scheduled runs', async () => {
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(scheduleRepo.findAll).toHaveBeenCalled();
    expect(workflowRunner.createRun).toHaveBeenCalled();
    expect(scheduleRepo.upsert).toHaveBeenCalled();
  });

  it('skips when active run exists', async () => {
    workflowRunner.getActiveRuns.mockReturnValue([{ workflowName: 'nightly' }]);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(workflowRunner.createRun).not.toHaveBeenCalled();
  });

  it('pauses when max_runs reached', async () => {
    scheduleRepo.findAll.mockResolvedValue([{
      team_id: 'team-1',
      workflow_name: 'nightly',
      schedule: JSON.stringify({ every: '1h', max_runs: 1 }),
      next_run_at: '2026-06-15T11:00:00.000Z',
      total_runs: 1,
      last_run_at: '2026-06-15T10:00:00.000Z',
      paused: 0,
      last_role_mapping: JSON.stringify({}),
      updated_at: '2026-06-15T10:00:00.000Z',
    }]);
    workflowService.listWorkflows.mockReturnValue([]);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(workflowRunner.createRun).not.toHaveBeenCalled();
  });

  it('handles missing template and missing project', async () => {
    workflowService.getWorkflow.mockReturnValue(null);
    orgService.getStorage.mockReturnValue({ projectRepo: { listAll: vi.fn(async () => []) } });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(workflowRunner.createRun).not.toHaveBeenCalled();
  });

  it('handles DB load failure and refresh errors', async () => {
    scheduleRepo.findAll.mockRejectedValue(new Error('db down'));
    orgService.listTeams.mockImplementation(() => { throw new Error('refresh fail'); });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(scheduler.isRunning()).toBe(true);
  });

  it('computes cron and run_at schedules for new workflows', async () => {
    scheduleRepo.findAll.mockResolvedValue([]);
    workflowService.listWorkflows.mockReturnValue([
      { name: 'once', hasSchedule: true, schedule: { run_at: '2026-06-16T00:00:00.000Z' } },
      { name: 'cron', hasSchedule: true, schedule: { cron: '0 * * * *' } },
    ]);
    await scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
  });
});
