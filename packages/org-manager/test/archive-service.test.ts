import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ArchiveService } from '../src/archive-service.js';

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

describe('ArchiveService', () => {
  let taskService: {
    listTasks: ReturnType<typeof vi.fn>;
    getTaskComments: ReturnType<typeof vi.fn>;
    getRequirementComments: ReturnType<typeof vi.fn>;
    archiveTask: ReturnType<typeof vi.fn>;
  };
  let projectService: { getProject: ReturnType<typeof vi.fn> };
  let requirementService: {
    listRequirements: ReturnType<typeof vi.fn>;
    updateRequirementStatus: ReturnType<typeof vi.fn>;
  };
  let service: ArchiveService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    taskService = {
      listTasks: vi.fn(() => []),
      getTaskComments: vi.fn(async () => []),
      getRequirementComments: vi.fn(() => []),
      archiveTask: vi.fn(),
    };
    projectService = { getProject: vi.fn(() => null) };
    requirementService = {
      listRequirements: vi.fn(() => []),
      updateRequirementStatus: vi.fn(),
    };

    service = new ArchiveService(taskService as never, projectService as never);
    service.setRequirementService(requirementService as never);
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  it('archives old completed tasks without recent comments', async () => {
    taskService.listTasks.mockReturnValue([
      { id: 't1', status: 'completed', projectId: 'p1', completedAt: daysAgo(40), updatedAt: daysAgo(40) },
      { id: 't2', status: 'pending', updatedAt: daysAgo(40) },
    ]);
    projectService.getProject.mockReturnValue({ archivePolicy: { autoArchiveAfterDays: 30 } });

    const result = await service.runArchiveScan();
    expect(result.archivedTasks).toBe(1);
    expect(taskService.archiveTask).toHaveBeenCalledWith('t1');
  });

  it('skips tasks with recent comments', async () => {
    taskService.listTasks.mockReturnValue([
      { id: 't1', status: 'completed', updatedAt: daysAgo(40), completedAt: daysAgo(40) },
    ]);
    taskService.getTaskComments.mockResolvedValue([{ createdAt: daysAgo(2) }]);

    const result = await service.runArchiveScan();
    expect(result.archivedTasks).toBe(0);
    expect(taskService.archiveTask).not.toHaveBeenCalled();
  });

  it('archives old requirements', async () => {
    requirementService.listRequirements.mockReturnValue([
      { id: 'r1', status: 'completed', updatedAt: daysAgo(40) },
    ]);

    const result = await service.runArchiveScan();
    expect(result.archivedRequirements).toBe(1);
    expect(requirementService.updateRequirementStatus).toHaveBeenCalledWith('r1', 'archived');
  });

  it('uses terminal threshold for failed tasks', async () => {
    taskService.listTasks.mockReturnValue([
      { id: 't1', status: 'failed', updatedAt: daysAgo(40) },
    ]);

    const result = await service.runArchiveScan();
    expect(result.archivedTasks).toBe(1);
  });

  it('handles archive errors gracefully', async () => {
    taskService.listTasks.mockReturnValue([
      { id: 't1', status: 'completed', updatedAt: daysAgo(40), completedAt: daysAgo(40) },
    ]);
    taskService.archiveTask.mockImplementation(() => { throw new Error('fail'); });

    const result = await service.runArchiveScan();
    expect(result.archivedTasks).toBe(0);
  });

  it('start and stop lifecycle', async () => {
    taskService.listTasks.mockReturnValue([]);
    service.start(1000);
    await vi.advanceTimersByTimeAsync(0);
    service.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(taskService.listTasks).toHaveBeenCalled();
  });
});
