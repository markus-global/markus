import { describe, it, expect } from 'vitest';
import { TaskService } from '../src/task-service.js';

describe('TaskService.getDashboard', () => {
  function createService(): TaskService {
    const svc = new TaskService();
    svc.setGovernancePolicy({
      enabled: true,
      defaultTier: 'auto',
      maxPendingTasksPerAgent: 100,
      maxTotalActiveTasks: 100,
      requireApprovalForPriority: [],
      requireRequirement: false,
      rules: [],
    });
    return svc;
  }

  it('returns empty dashboard when no tasks exist', () => {
    const svc = createService();
    const dashboard = svc.getDashboard();

    expect(dashboard.totalTasks).toBe(0);
    expect(dashboard.statusCounts.pending).toBe(0);
    expect(dashboard.statusCounts.completed).toBe(0);
    expect(dashboard.agentWorkload).toEqual([]);
    expect(dashboard.recentActivity).toEqual([]);
    expect(dashboard.averageCompletionTimeMs).toBeNull();
  });

  it('counts tasks by status correctly', () => {
    const svc = createService();

    svc.createTask({ orgId: 'org1', title: 'Task A', description: 'a', assignedAgentId: 'agent-a', reviewerId: 'agent-r' });
    svc.createTask({ orgId: 'org1', title: 'Task B', description: 'b', assignedAgentId: 'agent-b', reviewerId: 'agent-r' });
    const task3 = svc.createTask({ orgId: 'org1', title: 'Task C', description: 'c', assignedAgentId: 'agent-a', reviewerId: 'agent-r' });
    svc.updateTaskStatus(task3.id, 'in_progress');

    const dashboard = svc.getDashboard('org1');

    expect(dashboard.totalTasks).toBe(3);
    expect(dashboard.statusCounts.pending).toBe(0);
    expect(dashboard.statusCounts.in_progress).toBe(3);
  });

  it('tracks agent workload across tasks', () => {
    const svc = createService();

    const t1 = svc.createTask({ orgId: 'org1', title: 'T1', description: '', assignedAgentId: 'agent-a', reviewerId: 'agent-r' });
    svc.updateTaskStatus(t1.id, 'in_progress');

    const t2 = svc.createTask({ orgId: 'org1', title: 'T2', description: '', assignedAgentId: 'agent-a', reviewerId: 'agent-r' });
    svc.updateTaskStatus(t2.id, 'review');
    svc.updateTaskStatus(t2.id, 'completed');

    svc.createTask({ orgId: 'org1', title: 'T3', description: '', assignedAgentId: 'agent-b', reviewerId: 'agent-r' });

    const dashboard = svc.getDashboard('org1');

    expect(dashboard.agentWorkload.length).toBe(2);

    const agentA = dashboard.agentWorkload.find(w => w.agentId === 'agent-a');
    expect(agentA).toBeDefined();
    expect(agentA!.activeTasks).toBe(1);
    expect(agentA!.completedTasks).toBe(1);

    const agentB = dashboard.agentWorkload.find(w => w.agentId === 'agent-b');
    expect(agentB).toBeDefined();
    expect(agentB!.activeTasks).toBe(1);
    expect(agentB!.completedTasks).toBe(0);
  });

  it('returns recent activity with all tasks represented', () => {
    const svc = createService();

    svc.createTask({ orgId: 'org1', title: 'Task Alpha', description: '', assignedAgentId: 'agent-a', reviewerId: 'agent-r' });
    const t2 = svc.createTask({ orgId: 'org1', title: 'Task Beta', description: '', assignedAgentId: 'agent-b', reviewerId: 'agent-r' });
    svc.updateTaskStatus(t2.id, 'in_progress');

    const dashboard = svc.getDashboard('org1');

    expect(dashboard.recentActivity.length).toBe(2);
    const titles = dashboard.recentActivity.map(a => a.title);
    expect(titles).toContain('Task Alpha');
    expect(titles).toContain('Task Beta');
  });

  it('filters by orgId when provided', () => {
    const svc = createService();

    svc.createTask({ orgId: 'org1', title: 'Org1 Task', description: '', assignedAgentId: 'agent-a', reviewerId: 'agent-r' });
    svc.createTask({ orgId: 'org2', title: 'Org2 Task', description: '', assignedAgentId: 'agent-b', reviewerId: 'agent-r' });

    const dashboard1 = svc.getDashboard('org1');
    expect(dashboard1.totalTasks).toBe(1);
    expect(dashboard1.recentActivity[0].title).toBe('Org1 Task');

    const dashboardAll = svc.getDashboard();
    expect(dashboardAll.totalTasks).toBe(2);
  });

  it('calculates average completion time for completed tasks', () => {
    const svc = createService();

    const task = svc.createTask({ orgId: 'org1', title: 'Fast Task', description: '', assignedAgentId: 'agent-a', reviewerId: 'agent-r' });
    svc.updateTaskStatus(task.id, 'in_progress');
    svc.updateTaskStatus(task.id, 'review');
    svc.updateTaskStatus(task.id, 'completed');

    const dashboard = svc.getDashboard('org1');

    expect(dashboard.averageCompletionTimeMs).not.toBeNull();
    expect(dashboard.averageCompletionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('limits recent activity to 20 items', () => {
    const svc = createService();

    for (let i = 0; i < 30; i++) {
      svc.createTask({ orgId: 'org1', title: `Task ${i}`, description: '', assignedAgentId: 'agent-a', reviewerId: 'agent-r' });
    }

    const dashboard = svc.getDashboard('org1');
    expect(dashboard.recentActivity.length).toBe(20);
  });
});
