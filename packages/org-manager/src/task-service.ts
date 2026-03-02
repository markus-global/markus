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
  /** Cancel tokens for active task executions — keyed by taskId */
  private taskCancelTokens = new Map<string, { cancelled: boolean }>();

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

  private static readonly MAX_TASK_RETRIES = 3;
  private static readonly RETRY_DELAYS_MS = [10_000, 30_000, 60_000];

  /**
   * Format previous execution logs into a context block so the agent can resume
   * from where it left off instead of starting fresh.
   */
  private formatPreviousExecutionContext(logs: import('@markus/storage').TaskLogRow[]): string {
    if (logs.length === 0) return '';

    const lines: string[] = [];
    lines.push('## Previous Execution History');
    lines.push('This task was previously worked on and paused/interrupted. Below is a record of what was already done.');
    lines.push('**Continue from where the work stopped — do NOT repeat steps that are already marked as completed.**');
    lines.push('');

    let runIndex = 0;
    let inRun = false;

    for (const entry of logs) {
      if (entry.type === 'status' && entry.content === 'started') {
        runIndex++;
        lines.push(`### Run ${runIndex}`);
        inRun = true;
        continue;
      }
      if (entry.type === 'status') {
        lines.push(`[${entry.content}]`);
        lines.push('');
        inRun = false;
        continue;
      }
      if (!inRun) continue;

      if (entry.type === 'text') {
        // Truncate long reasoning to avoid bloating context too much
        const text = entry.content.length > 600
          ? entry.content.slice(0, 600) + '…'
          : entry.content;
        lines.push(text);
        lines.push('');
      } else if (entry.type === 'tool_start') {
        const args = (entry.metadata as Record<string, unknown> | null)?.arguments;
        const argStr = args ? ` (${JSON.stringify(args).slice(0, 120)})` : '';
        lines.push(`→ Calling: ${entry.content}${argStr}`);
      } else if (entry.type === 'tool_end') {
        const meta = entry.metadata as Record<string, unknown> | null;
        const ok = meta?.success !== false;
        const result = meta?.result ? ` → ${String(meta.result).slice(0, 200)}` : '';
        lines.push(`  ${ok ? '✓' : '✗'} ${entry.content}${result}`);
      } else if (entry.type === 'error') {
        lines.push(`[ERROR] ${entry.content}`);
        lines.push('');
      }
    }

    // If the last run didn't finish, add a note about where it stopped
    if (inRun) {
      lines.push('[interrupted — work was not completed]');
      lines.push('');
    }

    lines.push('---');
    lines.push('');
    return lines.join('\n');
  }

  /**
   * Start executing a task with its assigned agent — fire-and-forget.
   * Returns immediately; execution runs concurrently via async.
   * @param _retryAttempt - internal retry counter, do not pass from outside
   */
  async runTask(taskId: string, _retryAttempt = 0): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!task.assignedAgentId) throw new Error(`Task ${taskId} has no assigned agent`);
    if (!this.agentManager) throw new Error('AgentManager not set');

    const agent = this.agentManager.getAgent(task.assignedAgentId);

    // Cancel any currently running execution for this task before starting a new one
    const existing = this.taskCancelTokens.get(taskId);
    if (existing) existing.cancelled = true;

    const cancelToken = { cancelled: false };
    this.taskCancelTokens.set(taskId, cancelToken);

    this.updateTaskStatus(taskId, 'in_progress');

    // Load previous execution history so the agent can resume from where it left off
    let prevContext = '';
    if (this.taskLogRepo) {
      try {
        const prevLogs = await this.taskLogRepo.getByTask(taskId);
        prevContext = this.formatPreviousExecutionContext(prevLogs);
      } catch (err) {
        log.warn('Failed to load previous task logs for context', { taskId, error: String(err) });
      }
    }

    const taskDescription = prevContext
      ? `${prevContext}${task.title}\n\n${task.description}`
      : `${task.title}\n\n${task.description}`;

    let seq = 0;
    const agentId = task.assignedAgentId;
    const taskLogRepo = this.taskLogRepo;
    const ws = this.ws;

    // Fire and forget — runs concurrently
    void agent.executeTask(taskId, taskDescription, async (entry) => {
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
        // Retry on transient failures (network / LLM timeout); give up after MAX_TASK_RETRIES
        const nextAttempt = _retryAttempt + 1;
        if (!cancelToken.cancelled && nextAttempt <= TaskService.MAX_TASK_RETRIES) {
          const delayMs = TaskService.RETRY_DELAYS_MS[_retryAttempt] ?? 60_000;
          const retryMsg = `Attempt ${_retryAttempt + 1}/${TaskService.MAX_TASK_RETRIES} failed. Retrying in ${delayMs / 1000}s…`;
          log.warn(retryMsg, { taskId, error: entry.content });
          // Append a visible retry notice to the execution log
          const noticeEntry = { taskId, agentId, seq: seq++, type: 'error' as import('@markus/storage').TaskLogType, content: retryMsg };
          taskLogRepo?.append(noticeEntry).catch(() => {});
          ws?.broadcast({
            type: 'task:log',
            payload: { taskId, agentId, logType: 'error', content: retryMsg, createdAt: new Date().toISOString() },
            timestamp: new Date().toISOString(),
          });
          setTimeout(() => {
            const current = this.tasks.get(taskId);
            if (!current || current.status !== 'in_progress') return;
            this.runTask(taskId, nextAttempt).catch(e =>
              log.error('Retry invocation failed', { taskId, error: String(e) })
            );
          }, delayMs);
        } else if (!cancelToken.cancelled) {
          this.updateTaskStatus(taskId, 'failed');
        }
        const agentState = agent.getState();
        ws?.broadcast({
          type: 'agent:update',
          payload: { agentId, status: agentState.status, activeTaskCount: agentState.activeTaskCount },
          timestamp: new Date().toISOString(),
        });
      }
    }, cancelToken).catch(err => {
      // Promise-level rejection (rare — usually executeTask catches internally)
      log.error('Task execution promise rejected', { taskId, error: String(err) });
      if (!cancelToken.cancelled) {
        const nextAttempt = _retryAttempt + 1;
        if (nextAttempt <= TaskService.MAX_TASK_RETRIES) {
          const delayMs = TaskService.RETRY_DELAYS_MS[_retryAttempt] ?? 60_000;
          log.warn(`Retrying task in ${delayMs / 1000}s (attempt ${_retryAttempt + 1}/${TaskService.MAX_TASK_RETRIES})`, { taskId });
          setTimeout(() => {
            const current = this.tasks.get(taskId);
            if (!current || current.status !== 'in_progress') return;
            this.runTask(taskId, nextAttempt).catch(e =>
              log.error('Retry invocation failed', { taskId, error: String(e) })
            );
          }, delayMs);
        } else {
          this.updateTaskStatus(taskId, 'failed');
        }
      }
    }).finally(() => {
      // Clean up cancel token after execution ends
      if (this.taskCancelTokens.get(taskId) === cancelToken) {
        this.taskCancelTokens.delete(taskId);
      }
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

  /**
   * Resume execution for all tasks that are currently in_progress.
   * Call this after agents have been loaded and started (on server startup).
   * Tasks without an assigned agent are reset to pending.
   */
  async resumeInProgressTasks(): Promise<void> {
    const inProgressTasks = [...this.tasks.values()].filter(t => t.status === 'in_progress');
    if (inProgressTasks.length === 0) return;

    log.info(`Resuming ${inProgressTasks.length} in_progress task(s) after restart`);

    for (const task of inProgressTasks) {
      if (!task.assignedAgentId) {
        // No agent — reset to pending so it can be assigned later
        task.status = 'pending';
        if (this.taskRepo) {
          this.taskRepo.updateStatus(task.id, 'pending').catch(err =>
            log.warn('Failed to reset unassigned in_progress task', { taskId: task.id, error: String(err) })
          );
        }
        log.info(`Reset unassigned in_progress task to pending`, { taskId: task.id, title: task.title });
        continue;
      }

      try {
        await this.runTask(task.id);
        log.info(`Resumed task execution after restart`, { taskId: task.id, title: task.title });
      } catch (err) {
        log.warn(`Failed to resume task on startup`, { taskId: task.id, title: task.title, error: String(err) });
        // Reset to assigned so user can manually retry
        task.status = 'assigned';
        if (this.taskRepo) {
          this.taskRepo.updateStatus(task.id, 'assigned').catch(() => {});
        }
      }
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

    const prevStatus = task.status;
    task.status = status;
    task.updatedAt = new Date().toISOString();

    // If moving away from in_progress, cancel any running execution
    if (prevStatus === 'in_progress' && status !== 'in_progress') {
      const token = this.taskCancelTokens.get(id);
      if (token) {
        token.cancelled = true;
        this.taskCancelTokens.delete(id);
        log.info(`Cancelled running execution for task ${id} (status → ${status})`);
      }
    }

    // Persist to DB
    if (this.taskRepo) {
      this.taskRepo.updateStatus(id, status).catch(err => log.warn('Failed to persist task status to DB', { error: String(err) }));
    }

    // Auto-start execution when a task transitions to in_progress but has no active runner.
    // This covers the case where an agent's heartbeat calls task_update(in_progress) —
    // the token is not yet set, so we know runTask() hasn't been invoked for this transition.
    if (status === 'in_progress' && prevStatus !== 'in_progress' && task.assignedAgentId && this.agentManager) {
      const activeToken = this.taskCancelTokens.get(id);
      if (!activeToken || activeToken.cancelled) {
        log.info(`Auto-starting task execution (triggered by status change to in_progress)`, { taskId: id });
        setImmediate(() => {
          this.runTask(id).catch(err =>
            log.warn('Auto-start runTask failed', { taskId: id, error: String(err) })
          );
        });
      }
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

  getDashboard(orgId?: string): {
    statusCounts: Record<TaskStatus, number>;
    totalTasks: number;
    agentWorkload: Array<{ agentId: string; agentName?: string; activeTasks: number; completedTasks: number }>;
    recentActivity: Array<{ taskId: string; title: string; status: TaskStatus; updatedAt: string }>;
    averageCompletionTimeMs: number | null;
  } {
    const tasks = orgId
      ? [...this.tasks.values()].filter(t => t.orgId === orgId)
      : [...this.tasks.values()];

    const statusCounts: Record<TaskStatus, number> = {
      pending: 0, assigned: 0, in_progress: 0, blocked: 0,
      completed: 0, failed: 0, cancelled: 0,
    };
    for (const t of tasks) statusCounts[t.status]++;

    const agentMap = new Map<string, { active: number; completed: number }>();
    for (const t of tasks) {
      if (!t.assignedAgentId) continue;
      const entry = agentMap.get(t.assignedAgentId) ?? { active: 0, completed: 0 };
      if (t.status === 'in_progress' || t.status === 'assigned') entry.active++;
      if (t.status === 'completed') entry.completed++;
      agentMap.set(t.assignedAgentId, entry);
    }

    const agentWorkload = [...agentMap.entries()].map(([agentId, counts]) => {
      let agentName: string | undefined;
      try {
        const agents = this.agentManager?.listAgents() ?? [];
        agentName = agents.find(a => a.id === agentId)?.config?.name;
      } catch { /* ignore */ }
      return { agentId, agentName, activeTasks: counts.active, completedTasks: counts.completed };
    });

    const recentActivity = [...tasks]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 20)
      .map(t => ({ taskId: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt }));

    const completedTasks = tasks.filter(t => t.status === 'completed' && t.updatedAt && t.createdAt);
    let averageCompletionTimeMs: number | null = null;
    if (completedTasks.length > 0) {
      const totalMs = completedTasks.reduce((sum, t) => {
        return sum + (new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime());
      }, 0);
      averageCompletionTimeMs = Math.round(totalMs / completedTasks.length);
    }

    return {
      statusCounts,
      totalTasks: tasks.length,
      agentWorkload,
      recentActivity,
      averageCompletionTimeMs,
    };
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
