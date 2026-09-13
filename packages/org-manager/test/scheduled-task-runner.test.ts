import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ScheduledTaskRunner } from '../src/scheduled-task-runner.js';

describe('ScheduledTaskRunner', () => {
  let taskService: {
    listScheduledTasks: ReturnType<typeof vi.fn>;
    advanceScheduleConfig: ReturnType<typeof vi.fn>;
    resetTaskForRerun: ReturnType<typeof vi.fn>;
    getTask: ReturnType<typeof vi.fn>;
    runTask: ReturnType<typeof vi.fn>;
    isAssignedAgentOnline: ReturnType<typeof vi.fn>;
    reclaimStuckScheduledTask: ReturnType<typeof vi.fn>;
  };
  let runner: ScheduledTaskRunner;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    taskService = {
      listScheduledTasks: vi.fn(() => []),
      advanceScheduleConfig: vi.fn(async () => {}),
      resetTaskForRerun: vi.fn(async () => {}),
      getTask: vi.fn(() => null),
      runTask: vi.fn(async () => {}),
      isAssignedAgentOnline: vi.fn(() => true),
      reclaimStuckScheduledTask: vi.fn(() => false),
    };
    runner = new ScheduledTaskRunner(taskService as never, 60_000);
  });

  afterEach(() => {
    runner.stop();
    vi.useRealTimers();
  });

  it('fires due completed tasks immediately after startup grace', async () => {
    taskService.listScheduledTasks.mockReturnValue([
      {
        id: 'sched-1', title: 'Daily', status: 'completed',
        scheduleConfig: { nextRunAt: '2026-06-15T11:00:00.000Z', currentRuns: 0 },
      },
    ]);
    taskService.getTask.mockReturnValue({ id: 'sched-1', status: 'in_progress' });

    runner.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(taskService.advanceScheduleConfig).toHaveBeenCalledWith('sched-1');
    expect(taskService.resetTaskForRerun).toHaveBeenCalledWith('sched-1');
    expect(taskService.runTask).toHaveBeenCalledWith('sched-1');
  });

  it('staggers overdue tasks during startup phase', async () => {
    taskService.listScheduledTasks.mockReturnValue([
      {
        id: 'overdue-1', title: 'Overdue', status: 'completed',
        scheduleConfig: { nextRunAt: '2026-06-14T12:00:00.000Z' },
      },
    ]);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(taskService.advanceScheduleConfig).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(taskService.advanceScheduleConfig).toHaveBeenCalled();
  });

  it('skips paused, maxRuns, and active-status tasks', async () => {
    taskService.listScheduledTasks.mockReturnValue([
      { id: 'paused', status: 'completed', scheduleConfig: { nextRunAt: '2026-06-15T11:00:00.000Z', paused: true } },
      { id: 'maxed', status: 'completed', scheduleConfig: { nextRunAt: '2026-06-15T11:00:00.000Z', maxRuns: 1, currentRuns: 1 } },
      { id: 'pending', status: 'pending', scheduleConfig: { nextRunAt: '2026-06-15T11:00:00.000Z' } },
      { id: 'future', status: 'completed', scheduleConfig: { nextRunAt: '2026-06-16T12:00:00.000Z' } },
    ]);

    runner.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(taskService.advanceScheduleConfig).not.toHaveBeenCalled();
  });

  it('does not re-fire a one-shot (runAt) task after its schedule has been consumed', async () => {
    // Regression: a one-shot task whose runAt already fired has nextRunAt
    // consumed to undefined by advanceScheduleConfig. It must NOT be treated
    // as "already due" and re-dispatched on every poll — that caused an
    // infinite rerun loop (completed → reset → in_progress → ...).
    taskService.listScheduledTasks.mockReturnValue([
      {
        id: 'one-shot-done', title: 'OneShot', status: 'completed',
        assignedAgentId: 'agt-1',
        scheduleConfig: {
          runAt: '2026-06-15T11:00:00.000Z',
          currentRuns: 1,
          lastRunAt: '2026-06-15T11:00:00.000Z',
          // nextRunAt deliberately absent (consumed by the first fire)
        },
      },
    ]);
    taskService.getTask.mockReturnValue({ id: 'one-shot-done', status: 'in_progress' });

    runner.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(taskService.advanceScheduleConfig).not.toHaveBeenCalled();
    expect(taskService.resetTaskForRerun).not.toHaveBeenCalled();
    expect(taskService.runTask).not.toHaveBeenCalled();
  });

  it('still fires a one-shot (runAt) task whose runAt arrived and is not yet consumed', async () => {
    // First fire of a one-shot task must keep working: nextRunAt === runAt has
    // elapsed, so the runner dispatches exactly once.
    taskService.listScheduledTasks.mockReturnValue([
      {
        id: 'one-shot-first', title: 'OneShotFirst', status: 'completed',
        assignedAgentId: 'agt-1',
        scheduleConfig: { runAt: '2026-06-15T11:00:00.000Z', nextRunAt: '2026-06-15T11:00:00.000Z', currentRuns: 0 },
      },
    ]);
    taskService.getTask.mockReturnValue({ id: 'one-shot-first', status: 'in_progress' });

    runner.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(taskService.advanceScheduleConfig).toHaveBeenCalledWith('one-shot-first');
    expect(taskService.resetTaskForRerun).toHaveBeenCalledWith('one-shot-first');
    expect(taskService.runTask).toHaveBeenCalledWith('one-shot-first');
  });

  it('handles unexpected status and runTask errors', async () => {
    taskService.listScheduledTasks.mockReturnValue([
      { id: 'weird', title: 'Weird', status: 'draft', scheduleConfig: { nextRunAt: '2026-06-15T11:00:00.000Z' } },
    ]);
    taskService.getTask.mockReturnValue({ id: 'weird', status: 'in_progress' });
    taskService.runTask.mockRejectedValue(new Error('busy'));

    runner.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(taskService.resetTaskForRerun).toHaveBeenCalled();
  });

  it('does not fire a due task when its assigned agent is offline (skips round, no schedule advance)', async () => {
    taskService.listScheduledTasks.mockReturnValue([
      {
        id: 'sched-offline', title: 'Daily', status: 'completed',
        assignedAgentId: 'agt-down',
        scheduleConfig: { nextRunAt: '2026-06-15T11:00:00.000Z', currentRuns: 0 },
      },
    ]);
    taskService.isAssignedAgentOnline.mockReturnValue(false);

    runner.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(taskService.isAssignedAgentOnline).toHaveBeenCalledWith('sched-offline');
    // Must NOT dispatch or advance the schedule while the agent is offline —
    // otherwise the round would strand in in_progress with an unconsumed mailbox.
    expect(taskService.advanceScheduleConfig).not.toHaveBeenCalled();
    expect(taskService.resetTaskForRerun).not.toHaveBeenCalled();
    expect(taskService.runTask).not.toHaveBeenCalled();
  });

  it('reclaims a scheduled task stuck in in_progress with an offline agent', async () => {
    taskService.listScheduledTasks.mockReturnValue([
      {
        id: 'sched-stuck', title: 'Stuck', status: 'in_progress',
        assignedAgentId: 'agt-down',
        scheduleConfig: { nextRunAt: '2026-06-15T11:00:00.000Z' },
      },
    ]);
    taskService.isAssignedAgentOnline.mockReturnValue(false);
    taskService.reclaimStuckScheduledTask.mockReturnValue(true);

    runner.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(taskService.reclaimStuckScheduledTask).toHaveBeenCalledWith('sched-stuck');
    expect(taskService.runTask).not.toHaveBeenCalled();
  });

  it('start/stop lifecycle', () => {
    expect(runner.isRunning()).toBe(false);
    runner.start();
    expect(runner.isRunning()).toBe(true);
    runner.start();
    runner.stop();
    expect(runner.isRunning()).toBe(false);
  });
});
