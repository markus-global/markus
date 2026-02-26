import type { Task, TaskStatus, TaskPriority } from '@markus/shared';
import { createLogger, taskId } from '@markus/shared';
import type { AgentManager } from '@markus/core';
import type { WSBroadcaster } from './ws-server.js';
import type { TaskRepo } from '@markus/storage';

const log = createLogger('task-service');

export interface CreateTaskRequest {
  orgId: string;
  title: string;
  description: string;
  priority?: TaskPriority;
  assignedAgentId?: string;
  parentTaskId?: string;
  dueAt?: string;
  requiredSkills?: string[];
  autoAssign?: boolean;
}

export class TaskService {
  private tasks = new Map<string, Task>();
  private agentManager?: AgentManager;
  private ws?: WSBroadcaster;
  private taskRepo?: TaskRepo;

  setAgentManager(am: AgentManager): void {
    this.agentManager = am;
  }

  setWSBroadcaster(ws: WSBroadcaster): void {
    this.ws = ws;
  }

  setTaskRepo(repo: TaskRepo): void {
    this.taskRepo = repo;
  }

  /** Load tasks from DB into in-memory map (call once on startup) */
  async loadFromDB(orgId: string): Promise<void> {
    if (!this.taskRepo) return;
    try {
      const rows = await this.taskRepo.listByOrg(orgId);
      for (const row of rows) {
        const task: Task = {
          id: row.id,
          orgId: row.orgId,
          title: row.title,
          description: row.description ?? '',
          status: row.status as TaskStatus,
          priority: (row.priority ?? 'medium') as TaskPriority,
          assignedAgentId: row.assignedAgentId ?? undefined,
          parentTaskId: row.parentTaskId ?? undefined,
          subtaskIds: [],
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
          dueAt: row.dueAt instanceof Date ? row.dueAt.toISOString() : (row.dueAt ? String(row.dueAt) : undefined),
        };
        this.tasks.set(task.id, task);
      }
      log.info(`Loaded ${rows.length} tasks from DB for org ${orgId}`);
    } catch (err) {
      log.warn('Failed to load tasks from DB', { error: String(err) });
    }
  }

  createTask(request: CreateTaskRequest): Task {
    let assignedAgentId = request.assignedAgentId;

    if (!assignedAgentId && request.autoAssign && this.agentManager) {
      assignedAgentId = this.autoAssignAgent(request.requiredSkills);
    }

    const task: Task = {
      id: taskId(),
      orgId: request.orgId,
      title: request.title,
      description: request.description,
      status: assignedAgentId ? 'assigned' : 'pending',
      priority: request.priority ?? 'medium',
      assignedAgentId,
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

    // Persist to DB
    if (this.taskRepo) {
      this.taskRepo.create({
        id: task.id,
        orgId: task.orgId,
        title: task.title,
        description: task.description,
        priority: task.priority,
        assignedAgentId: task.assignedAgentId,
        parentTaskId: task.parentTaskId,
        dueAt: task.dueAt ? new Date(task.dueAt) : undefined,
      }).catch(err => log.warn('Failed to persist task to DB', { error: String(err) }));
    }

    this.ws?.broadcastTaskUpdate(task.id, task.status, { title: task.title, assignedAgentId });
    log.info(`Task created: ${task.title}`, { id: task.id, status: task.status, assignedTo: assignedAgentId });
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

    // Persist to DB
    if (this.taskRepo) {
      this.taskRepo.updateStatus(id, status).catch(err => log.warn('Failed to persist task status to DB', { error: String(err) }));
    }

    this.ws?.broadcastTaskUpdate(id, status, { title: task.title });

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      this.checkParentCompletion(task);
    }

    log.info(`Task status updated: ${task.title}`, { id, status });
    return task;
  }

  assignTask(id: string, agentId: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.assignedAgentId = agentId;
    task.status = 'assigned';
    task.updatedAt = new Date().toISOString();

    // Persist to DB
    if (this.taskRepo) {
      this.taskRepo.assign(id, agentId).catch(err => log.warn('Failed to persist task assignment to DB', { error: String(err) }));
    }

    this.ws?.broadcastTaskUpdate(id, 'assigned', { title: task.title, assignedAgentId: agentId });
    log.info(`Task assigned`, { taskId: id, agentId });
    return task;
  }

  addTaskNote(id: string, note: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const ts = new Date().toISOString();
    if (!task.notes) task.notes = [];
    task.notes.push(`[${ts}] ${note}`);
    task.updatedAt = ts;
    log.info(`Task note added`, { taskId: id, note: note.slice(0, 80) });
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

  private autoAssignAgent(requiredSkills?: string[]): string | undefined {
    if (!this.agentManager) return undefined;

    const agents = this.agentManager.listAgents();
    const idleAgents = agents.filter((a) => a.status === 'idle');

    if (idleAgents.length === 0) return undefined;

    if (!requiredSkills?.length) {
      return idleAgents[0]?.id;
    }

    // Score agents by skill match
    let bestId: string | undefined;
    let bestScore = 0;

    for (const a of idleAgents) {
      const agent = this.agentManager.getAgent(a.id);
      const agentSkills = agent.config.skills ?? [];
      const score = requiredSkills.reduce((acc, skill) =>
        acc + (agentSkills.includes(skill) ? 1 : 0), 0);

      if (score > bestScore) {
        bestScore = score;
        bestId = a.id;
      }
    }

    return bestId ?? idleAgents[0]?.id;
  }

  updateTask(id: string, data: { title?: string; description?: string; priority?: TaskPriority }): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (data.title !== undefined) task.title = data.title;
    if (data.description !== undefined) task.description = data.description;
    if (data.priority !== undefined) task.priority = data.priority;
    task.updatedAt = new Date().toISOString();
    return task;
  }

  deleteTask(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    // Remove from parent's subtaskIds
    if (task.parentTaskId) {
      const parent = this.tasks.get(task.parentTaskId);
      if (parent) {
        parent.subtaskIds = parent.subtaskIds.filter(sid => sid !== id);
      }
    }
    // Delete all child subtasks recursively
    for (const subId of [...(task.subtaskIds ?? [])]) {
      this.deleteTask(subId);
    }
    this.tasks.delete(id);
    if (this.taskRepo) {
      this.taskRepo.delete(id).catch(err => log.warn('Failed to delete task from DB', { error: String(err) }));
    }
  }

  listSubtasks(parentId: string): Task[] {
    const parent = this.tasks.get(parentId);
    if (!parent) return [];
    return (parent.subtaskIds ?? []).map(id => this.tasks.get(id)).filter((t): t is Task => !!t);
  }

  private checkParentCompletion(task: Task): void {
    if (!task.parentTaskId) return;
    const parent = this.tasks.get(task.parentTaskId);
    if (!parent) return;

    const allSubDone = parent.subtaskIds.every((subId) => {
      const sub = this.tasks.get(subId);
      return sub && (sub.status === 'completed' || sub.status === 'cancelled');
    });

    if (allSubDone && parent.subtaskIds.length > 0) {
      this.updateTaskStatus(parent.id, 'completed');
    }
  }
}
