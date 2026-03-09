import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskService, type TaskEvent } from '../src/task-service.js';

describe('TaskService - Dependencies & Timeouts', () => {
  let ts: TaskService;

  beforeEach(() => {
    ts = new TaskService();
    // Disable governance for unit tests so tasks don't require requirementId or approval
    ts.setGovernancePolicy({
      enabled: false,
      defaultTier: 'auto',
      maxPendingTasksPerAgent: 100,
      maxTotalActiveTasks: 100,
      requireApprovalForPriority: [],
      requireRequirement: false,
      rules: [],
    });
  });

  afterEach(() => {
    ts.stopTimeoutChecker();
  });

  describe('blockedBy dependencies', () => {
    it('creates a task as blocked when it has blockers', () => {
      const dep = ts.createTask({ orgId: 'org-1', title: 'Dependency', description: 'dep' });
      const task = ts.createTask({
        orgId: 'org-1',
        title: 'Blocked Task',
        description: 'needs dep',
        blockedBy: [dep.id],
      });

      expect(task.status).toBe('blocked');
      expect(task.blockedBy).toContain(dep.id);
    });

    it('unblocks a task when all dependencies complete', () => {
      const dep1 = ts.createTask({ orgId: 'org-1', title: 'Dep 1', description: '' });
      const dep2 = ts.createTask({ orgId: 'org-1', title: 'Dep 2', description: '' });
      const blocked = ts.createTask({
        orgId: 'org-1',
        title: 'Blocked',
        description: '',
        blockedBy: [dep1.id, dep2.id],
      });

      expect(blocked.status).toBe('blocked');

      ts.updateTaskStatus(dep1.id, 'completed');
      // Still blocked (dep2 not done)
      expect(ts.getTask(blocked.id)!.status).toBe('blocked');

      ts.updateTaskStatus(dep2.id, 'completed');
      // Now unblocked
      expect(ts.getTask(blocked.id)!.status).toBe('pending');
    });

    it('unblocks with assigned agent transitions to assigned status', () => {
      const dep = ts.createTask({ orgId: 'org-1', title: 'Dep', description: '' });
      const blocked = ts.createTask({
        orgId: 'org-1',
        title: 'Blocked',
        description: '',
        blockedBy: [dep.id],
        assignedAgentId: 'agent-1',
      });

      expect(blocked.status).toBe('blocked');

      ts.updateTaskStatus(dep.id, 'completed');
      expect(ts.getTask(blocked.id)!.status).toBe('assigned');
    });

    it('prevents starting a blocked task', () => {
      const dep = ts.createTask({ orgId: 'org-1', title: 'Dep', description: '' });
      const blocked = ts.createTask({
        orgId: 'org-1',
        title: 'Blocked',
        description: '',
        blockedBy: [dep.id],
      });

      expect(() => ts.updateTaskStatus(blocked.id, 'in_progress'))
        .toThrow('blocked by unfinished dependencies');
    });

    it('emits unblocked event', () => {
      const events: TaskEvent[] = [];
      ts.onTaskEvent(e => events.push(e));

      const dep = ts.createTask({ orgId: 'org-1', title: 'Dep', description: '' });
      ts.createTask({
        orgId: 'org-1',
        title: 'Blocked',
        description: '',
        blockedBy: [dep.id],
      });

      ts.updateTaskStatus(dep.id, 'completed');

      const unblocked = events.find(e => e.type === 'unblocked');
      expect(unblocked).toBeDefined();
      expect(unblocked!.previousStatus).toBe('blocked');
    });
  });

  describe('task events / webhooks', () => {
    it('emits created event', () => {
      const events: TaskEvent[] = [];
      ts.onTaskEvent(e => events.push(e));

      ts.createTask({ orgId: 'org-1', title: 'New Task', description: 'test' });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('created');
      expect(events[0].taskTitle).toBe('New Task');
    });

    it('emits completed event', () => {
      const events: TaskEvent[] = [];
      ts.onTaskEvent(e => events.push(e));

      const task = ts.createTask({ orgId: 'org-1', title: 'Task', description: 'test' });
      ts.updateTaskStatus(task.id, 'completed');

      const completed = events.find(e => e.type === 'completed');
      expect(completed).toBeDefined();
      expect(completed!.previousStatus).toBe('pending');
    });

    it('emits failed event', () => {
      const events: TaskEvent[] = [];
      ts.onTaskEvent(e => events.push(e));

      const task = ts.createTask({ orgId: 'org-1', title: 'Task', description: '' });
      ts.updateTaskStatus(task.id, 'failed');

      const failed = events.find(e => e.type === 'failed');
      expect(failed).toBeDefined();
    });

    it('handles webhook errors gracefully', () => {
      ts.onTaskEvent(() => { throw new Error('webhook broke'); });
      expect(() => ts.createTask({ orgId: 'org-1', title: 'Task', description: '' })).not.toThrow();
    });
  });

  describe('startedAt tracking', () => {
    it('sets startedAt when task moves to in_progress', () => {
      const task = ts.createTask({ orgId: 'org-1', title: 'Task', description: '' });
      expect(task.startedAt).toBeUndefined();

      ts.updateTaskStatus(task.id, 'in_progress');
      expect(ts.getTask(task.id)!.startedAt).toBeDefined();
    });
  });

  describe('timeout detection', () => {
    it('detects timed-out tasks', () => {
      const task = ts.createTask({
        orgId: 'org-1',
        title: 'Timeout Task',
        description: '',
        timeoutMs: 100,
      });

      // Manually set startedAt in the past
      const t = ts.getTask(task.id)!;
      t.status = 'in_progress';
      t.startedAt = new Date(Date.now() - 200).toISOString();

      const events: TaskEvent[] = [];
      ts.onTaskEvent(e => events.push(e));

      // Manually trigger the timeout check
      (ts as any).checkTimeouts();

      expect(ts.getTask(task.id)!.status).toBe('failed');
      const timeoutEvent = events.find(e => e.type === 'timeout');
      expect(timeoutEvent).toBeDefined();
      expect(timeoutEvent!.metadata?.reason).toBe('timeout');
    });

    it('does not timeout tasks without timeoutMs', () => {
      const task = ts.createTask({ orgId: 'org-1', title: 'No Timeout', description: '' });
      const t = ts.getTask(task.id)!;
      t.status = 'in_progress';
      t.startedAt = new Date(Date.now() - 999999).toISOString();

      (ts as any).checkTimeouts();
      expect(ts.getTask(task.id)!.status).toBe('in_progress');
    });
  });

  describe('parent auto-completion with dependencies', () => {
    it('auto-completes parent when all subtasks finish (including unblocked ones)', () => {
      const parent = ts.createTask({ orgId: 'org-1', title: 'Parent', description: '' });
      const sub1 = ts.createTask({
        orgId: 'org-1',
        title: 'Sub 1',
        description: '',
        parentTaskId: parent.id,
      });
      const sub2 = ts.createTask({
        orgId: 'org-1',
        title: 'Sub 2',
        description: '',
        parentTaskId: parent.id,
        blockedBy: [sub1.id],
      });

      expect(sub2.status).toBe('blocked');

      ts.updateTaskStatus(sub1.id, 'completed');
      expect(ts.getTask(sub2.id)!.status).toBe('pending');

      ts.updateTaskStatus(sub2.id, 'completed');
      expect(ts.getTask(parent.id)!.status).toBe('completed');
    });
  });

  describe('findDuplicateTasks', () => {
    it('finds tasks with identical titles in same requirement/agent scope', () => {
      ts.createTask({
        orgId: 'org-1',
        title: 'Implement login',
        description: 'first',
        requirementId: 'req-1',
        assignedAgentId: 'agent-1',
      });
      ts.createTask({
        orgId: 'org-1',
        title: 'Implement login',
        description: 'duplicate',
        requirementId: 'req-1',
        assignedAgentId: 'agent-1',
      });

      const groups = ts.findDuplicateTasks('org-1');
      expect(groups.length).toBe(1);
      expect(groups[0].tasks.length).toBe(2);
    });

    it('finds tasks with similar titles (containment)', () => {
      ts.createTask({
        orgId: 'org-1',
        title: 'Add user authentication',
        description: '',
        requirementId: 'req-1',
      });
      ts.createTask({
        orgId: 'org-1',
        title: 'add user authentication module',
        description: '',
        requirementId: 'req-1',
      });

      const groups = ts.findDuplicateTasks('org-1');
      expect(groups.length).toBe(1);
    });

    it('does not flag unrelated tasks as duplicates', () => {
      ts.createTask({ orgId: 'org-1', title: 'Setup database', description: '' });
      ts.createTask({ orgId: 'org-1', title: 'Design frontend UI', description: '' });

      const groups = ts.findDuplicateTasks('org-1');
      expect(groups.length).toBe(0);
    });

    it('ignores completed/cancelled tasks', () => {
      const t1 = ts.createTask({ orgId: 'org-1', title: 'Same title', description: '' });
      ts.createTask({ orgId: 'org-1', title: 'Same title', description: '' });
      ts.updateTaskStatus(t1.id, 'completed');

      const groups = ts.findDuplicateTasks('org-1');
      expect(groups.length).toBe(0);
    });
  });

  describe('cleanupDuplicateTasks', () => {
    it('cancels newer duplicates and keeps the oldest', () => {
      const t1 = ts.createTask({
        orgId: 'org-1',
        title: 'Build API',
        description: '',
        requirementId: 'req-1',
      });
      const t2 = ts.createTask({
        orgId: 'org-1',
        title: 'Build API',
        description: '',
        requirementId: 'req-1',
      });
      const t3 = ts.createTask({
        orgId: 'org-1',
        title: 'Build API',
        description: '',
        requirementId: 'req-1',
      });

      const result = ts.cleanupDuplicateTasks('org-1');
      expect(result.count).toBe(2);
      expect(result.cancelledIds).toContain(t2.id);
      expect(result.cancelledIds).toContain(t3.id);

      expect(ts.getTask(t1.id)!.status).toBe('pending');
      expect(ts.getTask(t2.id)!.status).toBe('cancelled');
      expect(ts.getTask(t3.id)!.status).toBe('cancelled');
    });

    it('returns empty when no duplicates', () => {
      ts.createTask({ orgId: 'org-1', title: 'Unique A', description: '' });
      ts.createTask({ orgId: 'org-1', title: 'Unique B', description: '' });

      const result = ts.cleanupDuplicateTasks('org-1');
      expect(result.count).toBe(0);
      expect(result.cancelledIds).toHaveLength(0);
    });
  });

  describe('getTaskBoardHealth', () => {
    it('returns board health summary with status counts', () => {
      ts.createTask({ orgId: 'org-1', title: 'Pending', description: '' });
      const t2 = ts.createTask({
        orgId: 'org-1',
        title: 'Assigned',
        description: '',
        assignedAgentId: 'agent-1',
      });
      const dep = ts.createTask({ orgId: 'org-1', title: 'Dep', description: '' });
      ts.createTask({
        orgId: 'org-1',
        title: 'Blocked',
        description: '',
        blockedBy: [dep.id],
      });

      const health = ts.getTaskBoardHealth('org-1') as any;
      expect(health.totalTasks).toBe(4);
      expect(health.statusCounts['pending']).toBe(2);
      expect(health.statusCounts['assigned']).toBe(1);
      expect(health.statusCounts['blocked']).toBe(1);
    });

    it('detects unassigned tasks', () => {
      ts.createTask({ orgId: 'org-1', title: 'Unassigned', description: '' });

      const health = ts.getTaskBoardHealth('org-1') as any;
      expect(health.unassigned.length).toBe(1);
      expect(health.unassigned[0].title).toBe('Unassigned');
    });

    it('reports duplicate groups count', () => {
      ts.createTask({ orgId: 'org-1', title: 'Dup Task', description: '' });
      ts.createTask({ orgId: 'org-1', title: 'Dup Task', description: '' });

      const health = ts.getTaskBoardHealth('org-1') as any;
      expect(health.duplicateGroups).toBe(1);
    });
  });
});
