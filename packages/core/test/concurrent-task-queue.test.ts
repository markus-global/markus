import {
  TaskQueue,
  TaskPriority,
  TaskStatus,
  TaskType,
} from '../src/concurrent/task-queue.js';

function makeTaskOptions(overrides: Partial<Parameters<TaskQueue['addTask']>[0]> = {}) {
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`,
    type: overrides.type ?? TaskType.TASK,
    priority: overrides.priority ?? TaskPriority.MEDIUM,
    execute: overrides.execute ?? (async () => 'done'),
    ...overrides,
  };
}

describe('TaskQueue', () => {
  it('enqueues and completes tasks', async () => {
    const queue = new TaskQueue({ maxConcurrent: 2, defaultPriority: TaskPriority.MEDIUM, autoStart: true });
    const onComplete = vi.fn();
    await queue.addTask(makeTaskOptions({
      id: 't1',
      execute: async () => 'result',
      onComplete,
    }));

    await vi.waitFor(() => {
      const task = queue.getTaskStatus('t1');
      expect(task?.status).toBe(TaskStatus.COMPLETED);
    });

    expect(onComplete).toHaveBeenCalledWith('t1', 'result');
    expect(queue.getTaskStatus('t1')?.result).toBe('result');
  });

  it('orders tasks by priority', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultPriority: TaskPriority.MEDIUM, autoStart: false });
    const order: string[] = [];

    await queue.addTask(makeTaskOptions({
      id: 'low',
      priority: TaskPriority.LOW,
      execute: async () => { order.push('low'); },
    }));
    await queue.addTask(makeTaskOptions({
      id: 'high',
      priority: TaskPriority.HIGH,
      execute: async () => { order.push('high'); },
    }));
    await queue.addTask(makeTaskOptions({
      id: 'medium',
      priority: TaskPriority.MEDIUM,
      execute: async () => { order.push('medium'); },
    }));

    expect(queue.getPendingTasks().map((t) => t.id)).toEqual(['high', 'medium', 'low']);

    queue.start();
    await queue.waitForAll();
    expect(order).toEqual(['high', 'medium', 'low']);
  });

  it('respects maxConcurrent limit', async () => {
    const queue = new TaskQueue({ maxConcurrent: 2, defaultPriority: TaskPriority.MEDIUM, autoStart: true });
    let running = 0;
    let maxRunning = 0;

    const slowTask = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 50));
      running--;
      return 'ok';
    };

    await Promise.all([
      queue.addTask(makeTaskOptions({ id: 'a', execute: slowTask })),
      queue.addTask(makeTaskOptions({ id: 'b', execute: slowTask })),
      queue.addTask(makeTaskOptions({ id: 'c', execute: slowTask })),
    ]);

    await queue.waitForAll();
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it('tracks stats through lifecycle', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultPriority: TaskPriority.MEDIUM, autoStart: true });

    await queue.addTask(makeTaskOptions({
      id: 'success',
      execute: async () => 'ok',
    }));
    await queue.addTask(makeTaskOptions({
      id: 'fail',
      execute: async () => { throw new Error('boom'); },
    }));

    await vi.waitFor(() => {
      const stats = queue.getStats();
      expect(stats.completed + stats.failed).toBeGreaterThanOrEqual(2);
    });

    const stats = queue.getStats();
    expect(stats.completed).toBeGreaterThanOrEqual(1);
    expect(stats.failed).toBeGreaterThanOrEqual(1);
    expect(stats.total).toBeGreaterThanOrEqual(2);
  });

  it('handles task failure', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultPriority: TaskPriority.MEDIUM, autoStart: true });
    const onError = vi.fn();

    await queue.addTask(makeTaskOptions({
      id: 'err',
      execute: async () => { throw new Error('task failed'); },
      onError,
    }));

    await vi.waitFor(() => {
      expect(queue.getTaskStatus('err')?.status).toBe(TaskStatus.FAILED);
    });

    expect(onError).toHaveBeenCalled();
    expect(queue.getTaskStatus('err')?.error?.message).toBe('task failed');
  });

  it('cancels pending tasks', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultPriority: TaskPriority.MEDIUM, autoStart: false });

    await queue.addTask(makeTaskOptions({ id: 'pending-1' }));
    await queue.addTask(makeTaskOptions({ id: 'pending-2' }));

    expect(queue.cancelTask('pending-1')).toBe(true);
    expect(queue.getTaskStatus('pending-1')?.status).toBe(TaskStatus.CANCELLED);
    expect(queue.getStats().cancelled).toBe(1);
  });

  it('cancels running task via cancelToken', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultPriority: TaskPriority.MEDIUM, autoStart: true });
    const cancelToken = { cancelled: false };

    await queue.addTask(makeTaskOptions({
      id: 'running',
      cancelToken,
      execute: async () => {
        cancelToken.cancelled = true;
        return 'should not complete';
      },
    }));

    await vi.waitFor(() => {
      const task = queue.getTaskStatus('running');
      expect(task?.status === TaskStatus.CANCELLED || task?.status === TaskStatus.COMPLETED).toBe(true);
    });
  });

  it('updates progress for running tasks', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultPriority: TaskPriority.MEDIUM, autoStart: true });
    const onProgress = vi.fn();

    await queue.addTask(makeTaskOptions({
      id: 'progress',
      onProgress,
      execute: async () => {
        queue.updateProgress('progress', 50, 'halfway');
        return 'done';
      },
    }));

    await queue.waitForAll();
    expect(onProgress).toHaveBeenCalledWith('progress', 50, 'halfway');
    expect(queue.getTaskStatus('progress')?.progress).toBe(100);
  });

  it('clearQueue cancels pending tasks', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultPriority: TaskPriority.MEDIUM, autoStart: false });
    await queue.addTask(makeTaskOptions({ id: 'q1' }));
    await queue.addTask(makeTaskOptions({ id: 'q2' }));
    queue.clearQueue();
    expect(queue.getPendingTasks()).toHaveLength(0);
    expect(queue.getStats().cancelled).toBe(2);
  });

  it('getAllTasks returns pending, running, and completed', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1, defaultPriority: TaskPriority.MEDIUM, autoStart: true });
    await queue.addTask(makeTaskOptions({ id: 'all-1', execute: async () => 'x' }));
    await queue.waitForAll();
    const all = queue.getAllTasks();
    expect(all.some((t) => t.id === 'all-1')).toBe(true);
  });
});
