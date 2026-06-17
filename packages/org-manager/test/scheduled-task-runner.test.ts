import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ScheduledTaskRunner } from '../src/scheduled-task-runner.js';

describe('ScheduledTaskRunner', () => {
  let taskService: {
    listScheduledTasks: ReturnType<typeof vi.fn>;
    advanceScheduleConfig: ReturnType<typeof vi.fn>;
    resetTaskForRerun: ReturnType<typeof vi.fn>;
    getTask: ReturnType<typeof vi.fn>;
    runTask: ReturnType<typeof vi.fn>;
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

  it('start/stop lifecycle', () => {
    expect(runner.isRunning()).toBe(false);
    runner.start();
    expect(runner.isRunning()).toBe(true);
    runner.start();
    runner.stop();
    expect(runner.isRunning()).toBe(false);
  });
});
