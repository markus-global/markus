import { TaskExecutor } from '../src/concurrent/task-executor.js';
import { AgentStateManager } from '../src/concurrent/state-manager.js';
import { TaskPriority, TaskStatus } from '../src/concurrent/task-queue.js';

describe('AgentStateManager', () => {
  let executor: TaskExecutor;
  let manager: AgentStateManager;

  beforeEach(() => {
    executor = new TaskExecutor({ agentId: 'agent-test', maxConcurrentTasks: 2 });
    manager = new AgentStateManager('agent-test', executor);
  });

  it('initializes with idle state', () => {
    const state = manager.getState();
    expect(state.agentId).toBe('agent-test');
    expect(state.status).toBe('idle');
    expect(state.activeTaskCount).toBe(0);
    expect(state.activeTaskIds).toEqual([]);
    expect(state.tokensUsedToday).toBe(0);
  });

  it('tracks tokens used', () => {
    manager.updateTokensUsed(100);
    manager.updateTokensUsed(50);
    expect(manager.getTokensUsed()).toBe(150);
    manager.resetTokensUsed();
    expect(manager.getTokensUsed()).toBe(0);
  });

  it('updates state via updateState', () => {
    const listener = vi.fn();
    manager.addStateListener(listener);
    manager.updateState({ status: 'working', containerId: 'container-1' });
    const state = manager.getState();
    expect(state.status).toBe('working');
    expect(state.containerId).toBe('container-1');
    expect(listener).toHaveBeenCalled();
  });

  it('tracks concurrent tasks when progress events fire', async () => {
    const listener = vi.fn();
    manager.addStateListener(listener);

    let release!: () => void;
    const blocker = new Promise<void>((r) => { release = r; });

    const execPromise = executor.executeChatTask('task-a', async () => {
      executor.updateProgress('task-a', 25, 'working');
      await blocker;
      return 'done';
    });

    await vi.waitFor(() => {
      const state = manager.getState();
      expect(state.activeTaskCount).toBeGreaterThanOrEqual(1);
    });

    const state = manager.getState();
    expect(state.activeTaskIds).toContain('task-a');
    expect(state.currentTaskId).toBe('task-a');

    release();
    await execPromise;

    expect(executor.getRunningTasks()).toHaveLength(0);
    expect(manager.getTaskInfo('task-a')?.status).toBe(TaskStatus.COMPLETED);
  });

  it('prefers HIGH priority task as currentTaskId on progress', async () => {
    let releaseLow!: () => void;
    let releaseHigh!: () => void;
    const blockLow = new Promise<void>((r) => { releaseLow = r; });
    const blockHigh = new Promise<void>((r) => { releaseHigh = r; });

    const lowPromise = executor.executeHeartbeatTask('low-task', async () => {
      executor.updateProgress('low-task', 10);
      await blockLow;
      return 'low';
    });
    const highPromise = executor.executeChatTask('high-task', async () => {
      executor.updateProgress('high-task', 10);
      await blockHigh;
      return 'high';
    }, { priority: TaskPriority.HIGH });

    await vi.waitFor(() => {
      expect(executor.getRunningTasks().length).toBeGreaterThanOrEqual(2);
    });

    await vi.waitFor(() => {
      expect(manager.getState().currentTaskId).toBe('high-task');
    });

    releaseLow();
    releaseHigh();
    await Promise.all([lowPromise, highPromise]);
  });

  it('getTaskInfo returns task details', async () => {
    await executor.executeTaskTask('info-1', async () => 'result');
    const info = manager.getTaskInfo('info-1');
    expect(info).toBeDefined();
    expect(info!.id).toBe('info-1');
    expect(info!.status).toBe(TaskStatus.COMPLETED);
    expect(info!.result).toBe('result');
  });

  it('getAllTaskInfo lists all tasks', async () => {
    await executor.executeTaskTask('all-1', async () => 'a');
    await executor.executeTaskTask('all-2', async () => 'b');
    const all = manager.getAllTaskInfo();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map((t) => t.id)).toContain('all-1');
  });

  it('getRunningTaskInfo returns only running tasks', async () => {
    let release!: () => void;
    const block = new Promise<void>((r) => { release = r; });

    const promise = executor.executeTaskTask('running-1', async () => {
      await block;
      return 'x';
    });

    await vi.waitFor(() => {
      expect(manager.getRunningTaskInfo().length).toBeGreaterThanOrEqual(1);
    });

    release();
    await promise;

    await vi.waitFor(() => {
      expect(manager.getRunningTaskInfo()).toHaveLength(0);
    });
  });

  it('getStatusSummary matches executor summary shape', async () => {
    const summary = manager.getStatusSummary();
    expect(summary.agentId).toBe('agent-test');
    expect(summary.isBusy).toBe(false);
    expect(summary.queueStats).toBeDefined();
    expect(summary.currentTasks).toEqual([]);
  });

  it('removes state listener', () => {
    const listener = vi.fn();
    const remove = manager.addStateListener(listener);
    remove();
    manager.updateState({ status: 'paused' });
    expect(listener).not.toHaveBeenCalled();
  });
});
