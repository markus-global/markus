import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LongTaskProgress } from '../src/long-task-progress.js';

describe('LongTaskProgress', () => {
  let progressUpdates: unknown[];
  let stageChanges: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    progressUpdates = [];
    stageChanges = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createProgress(stages = [
    { id: 's1', name: 'Stage 1', description: 'First', weight: 1, status: 'pending' as const, progress: 0 },
    { id: 's2', name: 'Stage 2', description: 'Second', weight: 2, status: 'pending' as const, progress: 0 },
  ]) {
    return new LongTaskProgress({
      taskId: 'task-1',
      taskName: 'Long Task',
      description: 'Test long task',
      stages,
      onProgressUpdate: (p) => progressUpdates.push(p),
      onStageChange: (s, prev) => stageChanges.push({ s, prev }),
      persistProgress: vi.fn(async () => {}),
    });
  }

  it('runs through stages and completes', async () => {
    const tracker = createProgress();
    await tracker.start();
    await tracker.updateStageProgress(50);
    await tracker.updateStageProgress(100);
    await tracker.completeStage(true);
    await tracker.completeStage(true);

    const status = tracker.getStatus();
    expect(status.overallProgress).toBeGreaterThan(0);
    expect(status.isComplete).toBe(true);
    expect(tracker.createSSEProgressEvent().type).toBe('long_task_progress');
    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(stageChanges.length).toBeGreaterThan(0);
  });

  it('handles pause, resume, cancel, and errors', async () => {
    const tracker = createProgress();
    await tracker.start();
    tracker.pause();
    expect(tracker.getStatus().isPaused).toBe(true);

    const resumePromise = tracker.updateStageProgress(10);
    tracker.resume();
    await resumePromise;

    await tracker.completeStage(false, 'failed step');
    await tracker.cancel('user cancelled');
    expect(tracker.getStatus().isCancelled).toBe(true);

    await expect(tracker.startStage(99)).rejects.toThrow();
    await expect(tracker.startStage(0)).rejects.toThrow('cancelled');
  });

  it('handles empty stages and no-op updates', async () => {
    const tracker = createProgress([]);
    await tracker.start();
    expect(tracker.getStatus().overallProgress).toBe(0);

    const single = createProgress([
      { id: 'only', name: 'Only', description: '', weight: 1, status: 'pending', progress: 0 },
    ]);
    await single.start();
    await single.updateStageProgress(10);
    tracker.pause();
    tracker.resume();
  });
});
