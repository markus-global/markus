import type { Task, TaskStatus, TaskPriority } from '@markus/shared';
import { createLogger, taskId } from '@markus/shared';
import type { AgentManager } from '@markus/core';
import type { WSBroadcaster } from './ws-server.js';
import type { TaskRepo, TaskLogRepo } from '@markus/storage';

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
  private taskLogRepo?: TaskLogRepo;

  setAgentManager(am: AgentManager): void {
    this.agentManager = am;
  }

  setWSBroadcaster(ws: WSBroadcaster): void {
    this.ws = ws;
  }

  setTaskRepo(repo: TaskRepo): void {
    this.taskRepo = repo;
  }

  setTaskLogRepo(repo: TaskLogRepo): void {
    this.taskLogRepo = repo;
  }

  /**
   * Start executing a task with its assigned agent — fire-and-forget.
   * Returns immediately; execution runs concurrently via async.
   */
  async runTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!task.assignedAgentId) throw new Error(`Task ${taskId} has no assigned agent`);
    if (!this.agentManager) throw new Error('AgentManager not set');

    const agent = this.agentManager.getAgent(task.assignedAgentId);
    this.updateTaskStatus(taskId, 'in_progress');

    let seq = 0;
    const agentId = task.assignedAgentId;
    const taskLogRepo = this.taskLogRepo;
    const ws = this.ws;

    // Fire and forget — runs concurrently
    void agent.executeTask(taskId, `${task.title}\n\n${task.description}`, async (entry) => {
      // Broadcast real-time delta via WS (not persisted)
      if (!entry.persist) {
        ws?.broadcast({
          type: 'task:log:delta',
          payload: { taskId, agentId, text: entry.content },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Persist structured log entries to DB
      const logEntry = {
        taskId,
        agentId,
        seq: seq++,
        type: entry.type as import('@markus/storage').TaskLogType,
        content: entry.content,
        metadata: entry.metadata,
      };

      let savedId: string | undefined;
      if (taskLogRepo) {
        try {
          const row = await taskLogRepo.append(logEntry);
          savedId = row.id;
        } catch (err) {
          log.warn('Failed to persist task log', { taskId, error: String(err) });
        }
      }

      // Broadcast structured log event via WS
      ws?.broadcast({
        type: 'task:log',
        payload: {
          taskId,
          agentId,
          id: savedId,
          seq: logEntry.seq,
          logType: entry.type,
          content: entry.content,
          metadata: entry.metadata,
          createdAt: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });

      // Handle task completion/failure from log events
      if (entry.type === 'status') {
        if (entry.content === 'completed') {
          this.updateTaskStatus(taskId, 'completed');
          // Also broadcast agent status update
          const agentState = agent.getState();
          ws?.broadcast({
            type: 'agent:update',
            payload: { agentId, status: agentState.status, activeTaskCount: agentState.activeTaskCount },
            timestamp: new Date().toISOString(),
          });
        } else if (entry.content === 'started') {
          const agentState = agent.getState();
          ws?.broadcast({
            type: 'agent:update',
            payload: { agentId, status: agentState.status, activeTaskCount: agentState.activeTaskCount },
            timestamp: new Date().toISOString(),
          });
        }
      } else if (entry.type === 'error') {
        this.updateTaskStatus(taskId, 'failed');
        const agentState = agent.getState();
        ws?.broadcast({
          type: 'agent:update',
          payload: { agentId, status: agentState.status, activeTaskCount: agentState.activeTaskCount },
          timestamp: new Date().toISOString(),
        });
      }
    }).catch(err => {
      log.error('Task execution promise rejected', { taskId, error: String(err) });
      this.updateTaskStatus(taskId, 'failed');
    });
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
          executionMode: (row.executionMode as Task['executionMode']) ?? undefined,
          assignedAgentId: row.assignedAgentId ?? undefined,
          parentTaskId: row.parentTaskId ?? undefined,
          subtaskIds: [],
          result: (row.result as Task['result']) ?? undefined,
          notes: (Array.isArray(row.notes) ? row.notes as string[] : undefined),
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
          dueAt: row.dueAt instanceof Date ? row.dueAt.toISOString() : (row.dueAt ? String(row.dueAt) : undefined),
        };
        this.tasks.set(task.id, task);
      }

      // Reconstruct subtaskIds from parentTaskId relationships
      for (const task of this.tasks.values()) {
        if (task.parentTaskId) {
          const parent = this.tasks.get(task.parentTaskId);
          if (parent && !parent.subtaskIds.includes(task.id)) {
            parent.subtaskIds.push(task.id);
          }
        }
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

  unassignTask(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.assignedAgentId = undefined;
    if (task.status === 'assigned') task.status = 'pending';
    task.updatedAt = new Date().toISOString();

    if (this.taskRepo) {
      this.taskRepo.assign(id, null).catch(err => log.warn('Failed to persist task unassignment to DB', { error: String(err) }));
    }

    this.ws?.broadcastTaskUpdate(id, task.status, { title: task.title });
    log.info(`Task unassigned`, { taskId: id });
    return task;
  }

  addTaskNote(id: string, note: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const ts = new Date().toISOString();
    if (!task.notes) task.notes = [];
    task.notes.push(`[${ts}] ${note}`);
    task.updatedAt = ts;

    if (this.taskRepo) {
      this.taskRepo.update(id, { notes: task.notes }).catch(err => log.warn('Failed to persist task note to DB', { error: String(err) }));
    }

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

    if (this.taskRepo) {
      this.taskRepo.update(id, data).catch(err => log.warn('Failed to persist task update to DB', { error: String(err) }));
    }

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
