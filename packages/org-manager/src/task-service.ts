import type { Task, TaskStatus, TaskPriority } from '@markus/shared';
import { createLogger, taskId } from '@markus/shared';

const log = createLogger('task-service');

export interface CreateTaskRequest {
  orgId: string;
  title: string;
  description: string;
  priority?: TaskPriority;
  assignedAgentId?: string;
  parentTaskId?: string;
  dueAt?: string;
}

export class TaskService {
  private tasks = new Map<string, Task>();

  createTask(request: CreateTaskRequest): Task {
    const task: Task = {
      id: taskId(),
      orgId: request.orgId,
      title: request.title,
      description: request.description,
      status: request.assignedAgentId ? 'assigned' : 'pending',
      priority: request.priority ?? 'medium',
      assignedAgentId: request.assignedAgentId,
      parentTaskId: request.parentTaskId,
      subtaskIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dueAt: request.dueAt,
    };

    if (request.parentTaskId) {
      const parent = this.tasks.get(request.parentTaskId);
      if (parent) {
        parent.subtaskIds.push(task.id);
      }
    }

    this.tasks.set(task.id, task);
    log.info(`Task created: ${task.title}`, { id: task.id, status: task.status });
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  updateTaskStatus(id: string, status: TaskStatus): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.status = status;
    task.updatedAt = new Date().toISOString();
    log.info(`Task status updated: ${task.title}`, { id, status });
    return task;
  }

  assignTask(taskId: string, agentId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    task.assignedAgentId = agentId;
    task.status = 'assigned';
    task.updatedAt = new Date().toISOString();
    log.info(`Task assigned`, { taskId, agentId });
    return task;
  }

  listTasks(filters?: {
    orgId?: string;
    status?: TaskStatus;
    assignedAgentId?: string;
    priority?: TaskPriority;
  }): Task[] {
    let result = [...this.tasks.values()];
    if (filters?.orgId) result = result.filter((t) => t.orgId === filters.orgId);
    if (filters?.status) result = result.filter((t) => t.status === filters.status);
    if (filters?.assignedAgentId) result = result.filter((t) => t.assignedAgentId === filters.assignedAgentId);
    if (filters?.priority) result = result.filter((t) => t.priority === filters.priority);
    return result;
  }

  getTasksByAgent(agentId: string): Task[] {
    return [...this.tasks.values()].filter((t) => t.assignedAgentId === agentId);
  }

  getTaskBoard(orgId: string): Record<TaskStatus, Task[]> {
    const board: Record<TaskStatus, Task[]> = {
      pending: [],
      assigned: [],
      in_progress: [],
      blocked: [],
      completed: [],
      failed: [],
      cancelled: [],
    };

    for (const task of this.tasks.values()) {
      if (task.orgId === orgId) {
        board[task.status].push(task);
      }
    }

    return board;
  }
}
