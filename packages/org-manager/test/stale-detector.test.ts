import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StaleDetector } from '../src/stale-detector.js';

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Stale task',
    status: 'in_progress',
    updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    assignedAgentId: 'agent-1',
    reviewerId: undefined,
    ...overrides,
  };
}

describe('StaleDetector', () => {
  let taskService: { listTasks: ReturnType<typeof vi.fn> };
  let onStaleItems: ReturnType<typeof vi.fn>;
  let detector: StaleDetector;

  beforeEach(() => {
    taskService = { listTasks: vi.fn(() => []) };
    onStaleItems = vi.fn();
    detector = new StaleDetector(taskService as never, {
      maxInProgressMs: 24 * 60 * 60 * 1000,
      maxReviewWaitMs: 12 * 60 * 60 * 1000,
      maxAssignedUnstartedMs: 4 * 60 * 60 * 1000,
      maxBranchDivergenceCommits: 100,
    }, onStaleItems);
  });

  describe('scan', () => {
    it('detects stuck in_progress tasks', async () => {
      taskService.listTasks.mockReturnValue([createTask()]);
      const items = await detector.scan();
      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe('stuck_task');
      expect(items[0]?.taskId).toBe('task-1');
    });

    it('detects stale review tasks', async () => {
      taskService.listTasks.mockReturnValue([createTask({
        status: 'review',
        updatedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
        reviewerId: 'agent-reviewer',
      })]);
      const items = await detector.scan();
      expect(items.some(i => i.type === 'review_stale')).toBe(true);
    });

    it('detects unstarted pending tasks', async () => {
      taskService.listTasks.mockReturnValue([createTask({
        status: 'pending',
        updatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      })]);
      const items = await detector.scan();
      expect(items.some(i => i.type === 'unstarted_task')).toBe(true);
    });

    it('returns empty when tasks are fresh', async () => {
      taskService.listTasks.mockReturnValue([createTask({
        updatedAt: new Date().toISOString(),
      })]);
      const items = await detector.scan();
      expect(items).toHaveLength(0);
    });

    it('does not re-notify the same stale task on consecutive scans', async () => {
      taskService.listTasks.mockReturnValue([createTask()]);
      const first = await detector.scan();
      expect(first).toHaveLength(1);
      const second = await detector.scan();
      expect(second).toHaveLength(0);
    });

    it('re-notifies a task only after it recovers and becomes stale again', async () => {
      // First scan: stale → notified once
      taskService.listTasks.mockReturnValue([createTask()]);
      const first = await detector.scan();
      expect(first).toHaveLength(1);

      // Task recovers (fresh) → no notification, memory cleared
      taskService.listTasks.mockReturnValue([createTask({
        updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      })]);
      const recovered = await detector.scan();
      expect(recovered).toHaveLength(0);

      // Task becomes stale again (new stale episode) → notified again
      taskService.listTasks.mockReturnValue([createTask({
        updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      })]);
      const again = await detector.scan();
      expect(again).toHaveLength(1);
    });

    it('notifies different stale types of the same task independently', async () => {
      // in_progress stale
      taskService.listTasks.mockReturnValue([createTask()]);
      const first = await detector.scan();
      expect(first.some(i => i.type === 'stuck_task')).toBe(true);

      // now in review stale (different type, not yet notified)
      taskService.listTasks.mockReturnValue([createTask({
        status: 'review',
        updatedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
        reviewerId: 'agent-reviewer',
      })]);
      const second = await detector.scan();
      expect(second.some(i => i.type === 'review_stale')).toBe(true);

      // repeat review scan → no duplicate
      const third = await detector.scan();
      expect(third).toHaveLength(0);
    });
  });

  describe('start and stop', () => {
    it('invokes callback when stale items found', async () => {
      vi.useFakeTimers();
      taskService.listTasks.mockReturnValue([createTask()]);
      detector.start(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(onStaleItems).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ type: 'stuck_task' }),
      ]));
      detector.stop();
      vi.useRealTimers();
    });
  });
});
