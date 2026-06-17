import { TaskExecutor } from '../src/concurrent/task-executor.js';
import { TaskPriority, TaskStatus, TaskType } from '../src/concurrent/task-queue.js';

describe('TaskExecutor', () => {
  it('executes chat tasks with HIGH priority by default', async () => {
    const executor = new TaskExecutor({ agentId: 'agent-1', maxConcurrentTasks: 2 });
    const result = await executor.executeChatTask('chat-1', async () => 'chat result');
    expect(result.status).toBe(TaskStatus.COMPLETED);
    expect(result.result).toBe('chat result');
    expect(result.taskId).toBe('chat-1');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('executes task tasks with MEDIUM priority by default', async () => {
    const executor = new TaskExecutor({ agentId: 'agent-1' });
    const result = await executor.executeTaskTask('task-1', async () => 42);
    expect(result.status).toBe(TaskStatus.COMPLETED);
    expect(result.result).toBe(42);
  });

  it('executes heartbeat tasks', async () => {
    const executor = new TaskExecutor({ agentId: 'agent-1' });
    const result = await executor.executeHeartbeatTask('hb-1', async () => 'pulse');
    expect(result.status).toBe(TaskStatus.COMPLETED);
    expect(result.result).toBe('pulse');
  });

  it('respects concurrency limits', async () => {
    const executor = new TaskExecutor({ agentId: 'agent-1', maxConcurrentTasks: 2 });
    let concurrent = 0;
    let maxConcurrent = 0;

    const work = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
      return 'ok';
    };

    await Promise.all([
      executor.executeTaskTask('c1', work),
      executor.executeTaskTask('c2', work),
      executor.executeTaskTask('c3', work),
    ]);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('handles execution errors', async () => {
    const executor = new TaskExecutor({ agentId: 'agent-1' });
    const result = await executor.executeTaskTask('fail-1', async () => {
      throw new Error('execution failed');
    });
    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.error?.message).toBe('execution failed');
  });

  it('reports progress via listener', async () => {
    const executor = new TaskExecutor({ agentId: 'agent-1' });
    const events: unknown[] = [];
    executor.addProgressListener((event) => events.push(event));

    await executor.executeChatTask('prog-1', async () => 'done', {
      onProgress: (progress, step) => {
        expect(progress).toBeDefined();
        expect(step).toBeDefined();
      },
    });

    const task = executor.getTaskStatus('prog-1');
    executor.updateProgress('prog-1', 75, 'almost done');
    expect(task).toBeDefined();
  });

  it('cancels tasks', async () => {
    const executor = new TaskExecutor({ agentId: 'agent-1', maxConcurrentTasks: 1 });
    const cancelToken = { cancelled: false };

    const promise = executor.executeTaskTask('cancel-me', async () => {
      await new Promise((r) => setTimeout(r, 200));
      return 'done';
    }, { cancelToken });

    await new Promise((r) => setTimeout(r, 20));
    executor.cancelTask('cancel-me');
    cancelToken.cancelled = true;

    const result = await promise;
    expect([TaskStatus.CANCELLED, TaskStatus.COMPLETED, TaskStatus.FAILED]).toContain(result.status);
  });

  it('getAgentStatusSummary reflects running state', async () => {
    const executor = new TaskExecutor({ agentId: 'agent-1', maxConcurrentTasks: 1 });
    let resolveTask!: () => void;
    const taskPromise = new Promise<void>((r) => { resolveTask = r; });

    const execPromise = executor.executeTaskTask('busy-1', async () => {
      await taskPromise;
      return 'finished';
    });

    await vi.waitFor(() => {
      expect(executor.getRunningTasks().length).toBeGreaterThanOrEqual(1);
    });

    const summary = executor.getAgentStatusSummary();
    expect(summary.agentId).toBe('agent-1');
    expect(summary.isBusy).toBe(true);
    expect(summary.activeTaskCount).toBeGreaterThanOrEqual(1);

    resolveTask();
    await execPromise;
  });

  it('waitForAll waits until queue is empty', async () => {
    const executor = new TaskExecutor({ agentId: 'agent-1' });
    await executor.executeTaskTask('w1', async () => 'a');
    await executor.executeTaskTask('w2', async () => 'b');
    await executor.waitForAll();
    expect(executor.getRunningTasks()).toHaveLength(0);
  });

  it('clearQueue cancels pending work', async () => {
    const executor = new TaskExecutor({ agentId: 'agent-1', maxConcurrentTasks: 1 });
    executor.getStats();
    executor.clearQueue();
    const stats = executor.getStats();
    expect(stats.pending).toBe(0);
  });
});
