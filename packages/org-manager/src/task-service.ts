import {
  createLogger,
  taskId,
  type Task,
  type TaskStatus,
  type TaskPriority,
  type TaskType,
  type ScheduleConfig,
  type TaskGovernancePolicy,
  type ApprovalTier,
  type TaskDeliverable,
} from '@markus/shared';
import type { AgentManager, WorkspaceManager, TaskWorkspace, ReviewService, ReviewReport } from '@markus/core';
import type { WSBroadcaster } from './ws-server.js';
import type { TaskRepo, TaskLogRepo, TaskLogRow, TaskLogType, TaskCommentRepo, TaskCommentRow } from '@markus/storage';
import type { HITLService } from './hitl-service.js';
import type { AuditService } from './audit-service.js';
import type { ProjectService } from './project-service.js';
import type { RequirementService } from './requirement-service.js';
import { mkdirSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  blockedBy?: string[];
  timeoutMs?: number;
  // Governance fields
  requirementId?: string;
  projectId?: string;
  iterationId?: string;
  createdBy?: string;
  creatorRole?: 'worker' | 'manager' | 'human';
  approvedVia?: string;
  planReportId?: string;
  reviewerAgentId?: string;
  // Scheduling fields
  taskType?: TaskType;
  scheduleConfig?: ScheduleConfig;
}

export type TaskEventType =
  | 'created'
  | 'status_changed'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'unblocked';
export interface TaskEvent {
  type: TaskEventType;
  taskId: string;
  taskTitle: string;
  orgId: string;
  status: TaskStatus;
  previousStatus?: TaskStatus;
  agentId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export type TaskWebhook = (event: TaskEvent) => void | Promise<void>;

export class TaskService {
  private tasks = new Map<string, Task>();
  private agentManager?: AgentManager;
  private ws?: WSBroadcaster;
  private taskRepo?: TaskRepo;
  private taskLogRepo?: TaskLogRepo;
  private hitlService?: HITLService;
  /** Cancel tokens for active task executions — keyed by taskId */
  private taskCancelTokens = new Map<string, { cancelled: boolean }>();
  private webhooks: TaskWebhook[] = [];
  private timeoutCheckInterval?: ReturnType<typeof setInterval>;
  private projectService?: ProjectService;
  private requirementService?: RequirementService;
  private workspaceManager?: WorkspaceManager;
  private reviewService?: ReviewService;
  private taskCommentRepo?: TaskCommentRepo;
  private auditService?: AuditService;
  private sharedDataDir?: string;

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

  setHITLService(hitl: HITLService): void {
    this.hitlService = hitl;
  }

  setProjectService(ps: ProjectService): void {
    this.projectService = ps;
  }

  setRequirementService(rs: RequirementService): void {
    this.requirementService = rs;
  }

  setWorkspaceManager(wm: WorkspaceManager): void {
    this.workspaceManager = wm;
  }

  setReviewService(rs: ReviewService): void {
    this.reviewService = rs;
  }

  setTaskCommentRepo(repo: TaskCommentRepo): void {
    this.taskCommentRepo = repo;
  }

  setAuditService(audit: AuditService): void {
    this.auditService = audit;
  }

  setSharedDataDir(dir: string): void {
    this.sharedDataDir = dir;
    mkdirSync(join(dir, 'tasks'), { recursive: true });
    mkdirSync(join(dir, 'knowledge'), { recursive: true });
  }

  getSharedDataDir(): string | undefined {
    return this.sharedDataDir;
  }

  onTaskEvent(webhook: TaskWebhook): void {
    this.webhooks.push(webhook);
  }

  startTimeoutChecker(intervalMs = 30_000): void {
    if (this.timeoutCheckInterval) return;
    this.timeoutCheckInterval = setInterval(() => this.checkTimeouts(), intervalMs);
  }

  stopTimeoutChecker(): void {
    if (this.timeoutCheckInterval) {
      clearInterval(this.timeoutCheckInterval);
      this.timeoutCheckInterval = undefined;
    }
  }

  private static readonly MAX_TASK_RETRIES = 3;
  private static readonly RETRY_DELAYS_MS = [10_000, 30_000, 60_000];

  /**
   * Analyze error messages from previous attempts and produce actionable guidance
   * so the agent can avoid repeating the same mistakes.
   */
  private static analyzeErrorPatterns(errors: string[]): string[] {
    const guidance: string[] = [];
    const seen = new Set<string>();
    const addOnce = (key: string, msg: string) => {
      if (!seen.has(key)) { seen.add(key); guidance.push(msg); }
    };

    for (const err of errors) {
      const lower = err.toLowerCase();

      if (lower.includes('unterminated string in json') || lower.includes('unexpected end of json')) {
        addOnce('json_truncation',
          'Previous attempts failed due to JSON truncation (content too long for a single tool call). ' +
          'Break large content into MULTIPLE smaller tool calls instead of one giant call. ' +
          'For file_write, write in sections or use shorter content per call. ' +
          'For code generation, generate one function/section at a time.');
      }
      if (lower.includes('syntaxerror') && lower.includes('json')) {
        addOnce('json_syntax',
          'JSON syntax errors occurred — ensure all strings are properly escaped (especially newlines, quotes, and backslashes within content). ' +
          'Avoid embedding large multi-line code blocks directly in JSON string values.');
      }
      if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
        addOnce('timeout',
          'Previous attempts timed out. Reduce the scope of operations — process smaller batches, use pagination, or break the work into simpler steps.');
      }
      if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
        addOnce('rate_limit',
          'Rate limits were hit. Add delays between API calls and reduce the frequency of requests.');
      }
      if (lower.includes('enoent') || lower.includes('no such file') || lower.includes('not found')) {
        addOnce('file_not_found',
          'File or path not found errors occurred. Verify paths exist before operating on them (use list_directory or file_read to check).');
      }
      if (lower.includes('permission denied') || lower.includes('eacces')) {
        addOnce('permission',
          'Permission denied errors occurred. Check file permissions and ensure you are operating within the allowed workspace.');
      }
      if (lower.includes('out of memory') || lower.includes('heap')) {
        addOnce('oom',
          'Memory errors occurred. Process data in smaller chunks and avoid loading large files entirely into memory.');
      }
    }

    // Generic guidance if no specific pattern matched
    if (guidance.length === 0 && errors.length > 0) {
      guidance.push(
        'The same errors have occurred multiple times. Carefully analyze the error messages above and use a fundamentally different approach — ' +
        'do not simply retry the same steps that already failed.'
      );
    }

    // If multiple runs failed with the same error, emphasize the need for a different strategy
    if (errors.length >= 2) {
      const uniqueErrors = new Set(errors.map(e => e.slice(0, 100)));
      if (uniqueErrors.size === 1) {
        guidance.push(
          'IMPORTANT: The EXACT same error occurred across multiple attempts. Simply retrying will NOT work. ' +
          'You MUST change your approach — e.g., produce smaller outputs, split into multiple steps, or use a different tool/strategy.'
        );
      }
    }

    return guidance;
  }

  /**
   * Format previous execution logs AND human comments into a chronological
   * context block so the agent can resume from where it left off.
   * Comments and logs are interleaved by timestamp for a conversation-like view.
   */
  private formatPreviousExecutionContext(logs: TaskLogRow[], comments: TaskCommentRow[] = []): string {
    if (logs.length === 0 && comments.length === 0) return '';

    // Merge logs and comments into a unified timeline sorted by createdAt
    type TimelineEntry =
      | { kind: 'log'; entry: TaskLogRow }
      | { kind: 'comment'; entry: TaskCommentRow };

    const timeline: TimelineEntry[] = [
      ...logs.map(entry => ({ kind: 'log' as const, entry })),
      ...comments.map(entry => ({ kind: 'comment' as const, entry })),
    ];
    timeline.sort((a, b) => {
      const ta = a.entry.createdAt instanceof Date ? a.entry.createdAt.getTime() : new Date(a.entry.createdAt as any).getTime();
      const tb = b.entry.createdAt instanceof Date ? b.entry.createdAt.getTime() : new Date(b.entry.createdAt as any).getTime();
      return ta - tb;
    });

    const lines: string[] = [];
    lines.push('## Previous Execution History');
    lines.push(
      'This task was previously worked on and paused/interrupted. Below is a chronological record of execution and human comments.'
    );
    lines.push(
      '**CRITICAL: Continue from where the work stopped. Do NOT repeat steps already completed (✓). Do NOT re-read files that were already read. Pay close attention to human comments — they may contain new instructions or feedback.**'
    );
    lines.push('');

    let runIndex = 0;
    let inRun = false;
    const filesRead = new Set<string>();
    const filesWritten = new Set<string>();
    const collectedErrors: Array<{ run: number; content: string }> = [];

    for (const item of timeline) {
      if (item.kind === 'comment') {
        const c = item.entry as TaskCommentRow;
        const time = c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt);
        lines.push(`### 💬 Comment by ${c.authorName} (${time})`);
        lines.push(c.content);
        const attachments = (Array.isArray(c.attachments) ? c.attachments : []) as Array<{ type?: string; name?: string; url?: string }>;
        for (const att of attachments) {
          if (att.type === 'image') {
            lines.push(`[Image: ${att.name ?? 'attachment'}]`);
          }
        }
        lines.push('');
        continue;
      }

      // kind === 'log'
      const entry = item.entry as TaskLogRow;

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
        const text = entry.content.length > 800 ? entry.content.slice(0, 800) + '…' : entry.content;
        lines.push(text);
        lines.push('');
      } else if (entry.type === 'tool_start') {
        const meta = entry.metadata as Record<string, unknown> | null;
        const args = meta?.arguments as Record<string, unknown> | undefined;
        const argStr = args ? ` (${JSON.stringify(args).slice(0, 200)})` : '';
        lines.push(`→ Calling: ${entry.content}${argStr}`);

        if (args) {
          const path = (args['path'] ?? args['file'] ?? args['filePath'] ?? args['filename']) as string | undefined;
          if (path) {
            if (entry.content === 'file_read' || entry.content === 'read_file') {
              filesRead.add(path);
            } else if (entry.content === 'file_write' || entry.content === 'write_file') {
              filesWritten.add(path);
            }
          }
        }
      } else if (entry.type === 'tool_end') {
        const meta = entry.metadata as Record<string, unknown> | null;
        const ok = meta?.success !== false;
        const result = meta?.result ? ` → ${String(meta.result).slice(0, 400)}` : '';
        lines.push(`  ${ok ? '✓' : '✗'} ${entry.content}${result}`);
      } else if (entry.type === 'error') {
        lines.push(`[ERROR] ${entry.content}`);
        lines.push('');
        collectedErrors.push({ run: runIndex, content: entry.content });
      }
    }

    if (inRun) {
      lines.push('[interrupted — work was not completed]');
      lines.push('');
    }

    if (filesRead.size > 0 || filesWritten.size > 0) {
      lines.push('### Files Already Accessed');
      if (filesRead.size > 0) {
        lines.push('**Files already read (do NOT re-read these):**');
        for (const f of filesRead) lines.push(`- ${f}`);
        lines.push('');
      }
      if (filesWritten.size > 0) {
        lines.push('**Files already written/created:**');
        for (const f of filesWritten) lines.push(`- ${f}`);
        lines.push('');
      }
    }

    // Build explicit error analysis so the agent avoids repeating the same mistakes
    if (collectedErrors.length > 0) {
      lines.push('### ⚠ Errors from Previous Attempts — MUST READ');
      lines.push(`The previous ${collectedErrors.length} attempt(s) failed with the following errors. You MUST use a different approach to avoid these exact failures.`);
      lines.push('');
      for (const err of collectedErrors) {
        lines.push(`- **Run ${err.run}**: ${err.content}`);
      }
      lines.push('');
      // Provide specific guidance based on error patterns
      const guidance = TaskService.analyzeErrorPatterns(collectedErrors.map(e => e.content));
      if (guidance.length > 0) {
        lines.push('**Specific guidance to avoid these errors:**');
        for (const g of guidance) {
          lines.push(`- ${g}`);
        }
        lines.push('');
      }
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

    // Enforce single-task constraint: one task at a time per agent
    const agentState = agent.getState();
    if (agentState.status === 'working' && agentState.activeTaskIds?.length) {
      const otherTaskId = agentState.activeTaskIds.find(id => id !== taskId);
      if (otherTaskId) {
        const otherTask = this.tasks.get(otherTaskId);
        throw new Error(
          `Agent "${agent.config.name}" is already working on "${otherTask?.title ?? otherTaskId}". ` +
            `An agent can only execute one task at a time.`
        );
      }
    }

    // Cancel any currently running execution for this task before starting a new one
    const existing = this.taskCancelTokens.get(taskId);
    if (existing) existing.cancelled = true;

    const cancelToken = { cancelled: false };
    this.taskCancelTokens.set(taskId, cancelToken);

    this.updateTaskStatus(taskId, 'in_progress');

    // Load previous execution history + comments so the agent can resume
    let prevContext = '';
    if (this.taskLogRepo) {
      try {
        const prevLogs = await this.taskLogRepo.getByTask(taskId);
        let prevComments: TaskCommentRow[] = [];
        if (this.taskCommentRepo) {
          try { prevComments = await this.taskCommentRepo.getByTask(taskId); } catch { /* ignore */ }
        }
        prevContext = this.formatPreviousExecutionContext(prevLogs, prevComments);
      } catch (err) {
        log.warn('Failed to load previous task logs for context', { taskId, error: String(err) });
      }
    }

    // Build dependency context: include notes/deliverables from tasks this one depends on
    let dependencyContext = '';
    if (task.blockedBy?.length) {
      const depSections: string[] = [];
      for (const depId of task.blockedBy) {
        const depTask = this.tasks.get(depId);
        if (!depTask) continue;
        const lines: string[] = [`### Dependency: ${depTask.title} (ID: ${depId}, status: ${depTask.status})`];
        if (depTask.description) {
          lines.push(`**Description:** ${depTask.description.slice(0, 300)}`);
        }
        if (depTask.notes?.length) {
          lines.push('**Notes (most recent first):**');
          for (const note of depTask.notes.slice(-5).reverse()) {
            lines.push(`- ${note.slice(0, 500)}`);
          }
        }
        if (depTask.deliverables?.length) {
          lines.push('**Deliverables:**');
          for (const d of depTask.deliverables) {
            lines.push(`- ${d.summary ?? '(no summary)'}${d.type === 'branch' ? ` [branch: ${d.reference}]` : ''}`);
          }
        }
        depSections.push(lines.join('\n'));
      }
      if (depSections.length > 0) {
        dependencyContext = [
          '## Dependency Tasks (completed prerequisites)',
          'This task depends on the following completed tasks. Review their outputs before starting — they contain context and artifacts you will need.',
          '',
          ...depSections,
          '',
          '---',
          '',
        ].join('\n');
      }
    }

    const taskDescription = prevContext
      ? `${prevContext}${dependencyContext}${task.title}\n\n${task.description}`
      : `${dependencyContext}${task.title}\n\n${task.description}`;

    // Create git worktree for project-bound tasks
    let taskWorkspace: TaskWorkspace | undefined;
    if (task.projectId) {
      const project = this.projectService?.getProject(task.projectId);
      const repo = project?.repositories?.find(r => r.role === 'primary' && r.localPath) ?? project?.repositories?.find(r => r.localPath);
      if (repo?.localPath && this.workspaceManager) {
        try {
          const worktreePath = await this.workspaceManager.createWorktreeForTask(task, [repo]);
          taskWorkspace = {
            worktreePath,
            branch: `task/${task.id}`,
            baseBranch: repo.defaultBranch,
            projectContext: project ? {
              project: {
                id: project.id,
                name: project.name,
                description: project.description,
                status: project.status,
              },
              repositories: project.repositories?.map(r => ({
                localPath: r.localPath,
                defaultBranch: r.defaultBranch,
                role: r.role,
              })),
            } : undefined,
          };
          log.info('Task workspace created via worktree', { taskId, worktreePath, branch: taskWorkspace.branch });
        } catch (err) {
          log.warn('Failed to create worktree for task, falling back to agent default workspace', {
            taskId, projectId: task.projectId, error: String(err),
          });
        }
      }
    }

    let seq = 0;
    const agentId = task.assignedAgentId;
    const taskLogRepo = this.taskLogRepo;
    const ws = this.ws;

    // Fire and forget — runs concurrently
    void agent
      .executeTask(
        taskId,
        taskDescription,
        async entry => {
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
            type: entry.type as TaskLogType,
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
            if (entry.content === 'completed' || entry.content === 'execution_finished') {
              const currentTask = this.tasks.get(taskId);
              const inReviewPipeline = currentTask && ['review', 'revision', 'accepted'].includes(currentTask.status);
              if (!inReviewPipeline) {
                this.updateTaskStatus(taskId, 'completed');
              }
              // Also broadcast agent status update
              const agentState = agent.getState();
              ws?.broadcast({
                type: 'agent:update',
                payload: {
                  agentId,
                  status: agentState.status,
                  activeTaskCount: agentState.activeTaskCount,
                },
                timestamp: new Date().toISOString(),
              });
            } else if (entry.content === 'started') {
              const agentState = agent.getState();
              ws?.broadcast({
                type: 'agent:update',
                payload: {
                  agentId,
                  status: agentState.status,
                  activeTaskCount: agentState.activeTaskCount,
                },
                timestamp: new Date().toISOString(),
              });
            }
          } else if (entry.type === 'error') {
            // Retry on transient failures. While the task is in_progress, retry indefinitely;
            // otherwise fall back to MAX_TASK_RETRIES limit.
            const nextAttempt = _retryAttempt + 1;
            const currentTask = this.tasks.get(taskId);
            const isInProgress = currentTask?.status === 'in_progress';
            const shouldRetry = !cancelToken.cancelled && (isInProgress || nextAttempt <= TaskService.MAX_TASK_RETRIES);
            if (shouldRetry) {
              const delayMs = TaskService.RETRY_DELAYS_MS[Math.min(_retryAttempt, TaskService.RETRY_DELAYS_MS.length - 1)] ?? 60_000;
              const retryMsg = isInProgress
                ? `Attempt ${nextAttempt} failed (task still in_progress — will keep retrying). Retrying in ${delayMs / 1000}s…`
                : `Attempt ${_retryAttempt + 1}/${TaskService.MAX_TASK_RETRIES} failed. Retrying in ${delayMs / 1000}s…`;
              log.warn(retryMsg, { taskId, attempt: nextAttempt, error: entry.content });
              const noticeEntry = {
                taskId,
                agentId,
                seq: seq++,
                type: 'error' as TaskLogType,
                content: retryMsg,
              };
              taskLogRepo?.append(noticeEntry).catch(() => {});
              ws?.broadcast({
                type: 'task:log',
                payload: {
                  taskId,
                  agentId,
                  logType: 'error',
                  content: retryMsg,
                  createdAt: new Date().toISOString(),
                },
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
              payload: {
                agentId,
                status: agentState.status,
                activeTaskCount: agentState.activeTaskCount,
              },
              timestamp: new Date().toISOString(),
            });
          }
        },
        cancelToken,
        taskWorkspace
      )
      .catch(err => {
        // Promise-level rejection (rare — usually executeTask catches internally)
        log.error('Task execution promise rejected', { taskId, error: String(err) });
        if (!cancelToken.cancelled) {
          const nextAttempt = _retryAttempt + 1;
          const currentTask = this.tasks.get(taskId);
          const isInProgress = currentTask?.status === 'in_progress';
          const shouldRetry = isInProgress || nextAttempt <= TaskService.MAX_TASK_RETRIES;
          if (shouldRetry) {
            const delayMs = TaskService.RETRY_DELAYS_MS[Math.min(_retryAttempt, TaskService.RETRY_DELAYS_MS.length - 1)] ?? 60_000;
            log.warn(
              `Retrying task in ${delayMs / 1000}s (attempt ${nextAttempt}${isInProgress ? ', task in_progress — unlimited retries' : `/${TaskService.MAX_TASK_RETRIES}`})`,
              { taskId }
            );
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
      })
      .finally(() => {
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
        const toIso = (v: unknown): string | undefined => {
          if (!v) return undefined;
          return v instanceof Date ? v.toISOString() : String(v);
        };
        const rawBlockedBy = (row as any).blockedBy;
        const blockedBy = Array.isArray(rawBlockedBy) && rawBlockedBy.length > 0
          ? rawBlockedBy as string[]
          : undefined;
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
          requirementId: (row as any).requirementId ?? undefined,
          subtaskIds: [],
          blockedBy,
          result: (row.result as Task['result']) ?? undefined,
          deliverables: Array.isArray((row as any).deliverables) ? ((row as any).deliverables as Task['deliverables']) : undefined,
          notes: Array.isArray(row.notes) ? (row.notes as string[]) : undefined,
          createdAt:
            row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
          updatedAt:
            row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
          projectId: row.projectId ?? undefined,
          iterationId: row.iterationId ?? undefined,
          createdBy: (row as any).createdBy ?? undefined,
          updatedBy: (row as any).updatedBy ?? undefined,
          startedAt: toIso((row as any).startedAt),
          completedAt: toIso((row as any).completedAt),
          dueAt: toIso(row.dueAt),
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
          this.taskRepo
            .updateStatus(task.id, 'pending')
            .catch(err =>
              log.warn('Failed to reset unassigned in_progress task', {
                taskId: task.id,
                error: String(err),
              })
            );
        }
        log.info(`Reset unassigned in_progress task to pending`, {
          taskId: task.id,
          title: task.title,
        });
        continue;
      }

      try {
        await this.runTask(task.id);
        log.info(`Resumed task execution after restart`, { taskId: task.id, title: task.title });
      } catch (err) {
        log.warn(`Failed to resume task on startup`, {
          taskId: task.id,
          title: task.title,
          error: String(err),
        });
        // Reset to assigned so user can manually retry
        task.status = 'assigned';
        if (this.taskRepo) {
          this.taskRepo.updateStatus(task.id, 'assigned').catch(() => {});
        }
      }
    }
  }

  createTask(request: CreateTaskRequest): Task {
    // ── Governance: check task limits ──
    const limitCheck = this.checkTaskLimits(request);
    if (!limitCheck.allowed) {
      throw new Error(`Task creation blocked by governance: ${limitCheck.reason}`);
    }

    // ── Governance: enforce requirement linkage for top-level tasks ──
    if (!request.parentTaskId && this.governancePolicy?.requireRequirement) {
      if (!request.requirementId) {
        throw new Error(
          'Task creation blocked: top-level tasks must reference an approved requirement (requirementId). ' +
          'Use requirement_propose to suggest work, then create tasks after user approval.'
        );
      }
    }

    // ── Auto-inherit projectId/iterationId from the linked requirement ──
    if (request.requirementId && this.requirementService) {
      const req = this.requirementService.getRequirement(request.requirementId);
      if (req) {
        if (!request.projectId && req.projectId) {
          request.projectId = req.projectId;
        }
        if (!request.iterationId && req.iterationId) {
          request.iterationId = req.iterationId;
        }
      }
    }

    // ── Auto-inherit projectId from parent task for subtasks ──
    if (request.parentTaskId && !request.projectId) {
      const parent = this.tasks.get(request.parentTaskId);
      if (parent) {
        request.projectId = parent.projectId;
        if (!request.iterationId) request.iterationId = parent.iterationId;
        if (!request.requirementId) request.requirementId = parent.requirementId;
      }
    }

    // ── Governance: determine approval tier ──
    const approvalTier = this.determineApprovalTier(
      request,
      request.creatorRole === 'human' ? undefined : request.creatorRole
    );
    const needsApproval = approvalTier !== 'auto';

    let assignedAgentId = request.assignedAgentId;

    if (!assignedAgentId && request.autoAssign && this.agentManager) {
      assignedAgentId = this.autoAssignAgent(request.requiredSkills);
    }

    const hasBlockers = request.blockedBy && request.blockedBy.length > 0;
    let initialStatus: TaskStatus;
    if (needsApproval) {
      initialStatus = 'pending_approval';
    } else if (hasBlockers) {
      initialStatus = 'blocked';
    } else {
      initialStatus = assignedAgentId ? 'assigned' : 'pending';
    }

    const scheduleConfig = request.scheduleConfig
      ? { ...request.scheduleConfig, currentRuns: 0, nextRunAt: computeInitialNextRun(request.scheduleConfig) }
      : undefined;

    const task: Task = {
      id: taskId(),
      orgId: request.orgId,
      title: request.title,
      description: request.description,
      status: initialStatus,
      priority: request.priority ?? 'medium',
      assignedAgentId: assignedAgentId,
      parentTaskId: request.parentTaskId,
      requirementId: request.requirementId,
      subtaskIds: [],
      blockedBy: request.blockedBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dueAt: request.dueAt,
      timeoutMs: request.timeoutMs,
      projectId: request.projectId,
      iterationId: request.iterationId,
      createdBy: request.createdBy,
      approvedVia: needsApproval ? undefined : (request.approvedVia ?? 'auto'),
      planReportId: request.planReportId,
      reviewerAgentId: request.reviewerAgentId,
      taskType: request.taskType ?? 'standard',
      scheduleConfig,
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
      this.taskRepo
        .create({
          id: task.id,
          orgId: task.orgId,
          title: task.title,
          description: task.description,
          priority: task.priority,
          status: task.status,
          assignedAgentId: task.assignedAgentId,
          parentTaskId: task.parentTaskId,
          requirementId: task.requirementId,
          projectId: task.projectId,
          iterationId: task.iterationId,
          createdBy: task.createdBy,
          blockedBy: task.blockedBy,
          dueAt: task.dueAt ? new Date(task.dueAt) : undefined,
          taskType: task.taskType,
          scheduleConfig: task.scheduleConfig as Record<string, unknown> | undefined,
        })
        .catch(err => log.warn('Failed to persist task to DB', { error: String(err) }));
    }

    this.ws?.broadcastTaskUpdate(task.id, task.status, { title: task.title, assignedAgentId });
    this.emitTaskEvent({
      type: 'created',
      taskId: task.id,
      taskTitle: task.title,
      orgId: task.orgId,
      status: task.status,
      agentId: task.assignedAgentId,
      timestamp: task.createdAt,
    });
    log.info(`Task created: ${task.title}`, {
      id: task.id,
      status: task.status,
      approvalTier,
      assignedTo: assignedAgentId,
    });

    // ── Governance: request approval asynchronously if needed ──
    if (needsApproval && this.hitlService) {
      const creatorName = request.createdBy ?? 'unknown agent';
      this.hitlService.requestApprovalAndWait({
        agentId: request.createdBy ?? 'system',
        agentName: creatorName,
        type: 'custom',
        title: `Task approval (${approvalTier}): ${task.title}`,
        description: `Agent "${creatorName}" wants to create task "${task.title}" (priority: ${task.priority}). Approval tier: ${approvalTier}.`,
        details: { taskId: task.id, approvalTier, priority: task.priority },
      }).then(approved => {
        const current = this.tasks.get(task.id);
        if (!current || current.status !== 'pending_approval') {
          // Task was already approved or rejected via another path (e.g. direct API call)
          return;
        }
        if (approved) {
          // Use the task's current assignedAgentId — the human may have changed it during review
          this.approveTask(task.id, approvalTier);
        } else {
          this.rejectTask(task.id);
        }
      }).catch(err => {
        log.error('HITL approval flow error, auto-rejecting task', { taskId: task.id, error: String(err) });
        const current = this.tasks.get(task.id);
        if (current?.status === 'pending_approval') {
          this.rejectTask(task.id);
        }
      });
    }

    return task;
  }

  /** Approve a pending_approval task and transition it to normal flow.
   * Uses the task's current assignedAgentId (the human reviewer may have changed it).
   * Optionally resolves the associated HITL promise to prevent double-fire. */
  approveTask(taskIdStr: string, approvalTier?: string): Task {
    const task = this.tasks.get(taskIdStr);
    if (!task) throw new Error(`Task not found: ${taskIdStr}`);
    if (task.status !== 'pending_approval') {
      throw new Error(`Task ${taskIdStr} is in ${task.status} status, cannot approve`);
    }

    // Resolve the HITL promise if one is pending, so the .then() handler skips
    if (this.hitlService) {
      const pending = this.hitlService.listApprovals('pending');
      const hitl = pending.find(a => (a.details as Record<string, unknown>)?.['taskId'] === taskIdStr);
      if (hitl) this.hitlService.respondToApproval(hitl.id, true, 'direct');
    }

    const finalAssignee = task.assignedAgentId;
    const hasBlockers = task.blockedBy && task.blockedBy.length > 0;
    const shouldAutoStart = !hasBlockers && !!finalAssignee;
    task.status = hasBlockers ? 'blocked' : finalAssignee ? 'in_progress' : 'pending';
    task.approvedVia = approvalTier ?? 'human';
    task.updatedAt = new Date().toISOString();
    if (shouldAutoStart && !task.startedAt) {
      task.startedAt = task.updatedAt;
    }

    if (this.taskRepo) {
      this.taskRepo.updateStatus(task.id, task.status)
        .catch(err => log.warn('Failed to persist approved task status to DB', { taskId: task.id, error: String(err) }));
    }

    this.ws?.broadcastTaskUpdate(task.id, task.status, { title: task.title, assignedAgentId: finalAssignee });
    this.emitTaskEvent({
      type: 'status_changed',
      taskId: task.id,
      taskTitle: task.title,
      orgId: task.orgId,
      status: task.status,
      previousStatus: 'pending_approval',
      agentId: finalAssignee,
      timestamp: task.updatedAt,
    });
    log.info(`Task approved: ${task.title}`, { id: task.id, status: task.status, approvedVia: task.approvedVia });

    // Auto-start execution when approved with an assigned agent and no blockers
    if (shouldAutoStart && this.agentManager) {
      const activeToken = this.taskCancelTokens.get(task.id);
      if (!activeToken || activeToken.cancelled) {
        log.info('Auto-starting task execution after approval', { taskId: task.id, agentId: finalAssignee });
        setImmediate(() => {
          this.runTask(task.id).catch(err =>
            log.warn('Auto-start after approval failed', { taskId: task.id, error: String(err) })
          );
        });
      }
    }

    return task;
  }

  /** Reject a pending_approval task and transition it to cancelled. */
  rejectTask(taskIdStr: string): Task {
    const task = this.tasks.get(taskIdStr);
    if (!task) throw new Error(`Task not found: ${taskIdStr}`);
    if (task.status !== 'pending_approval') {
      throw new Error(`Task ${taskIdStr} is in ${task.status} status, cannot reject`);
    }

    // Resolve the HITL promise so the .then() handler skips
    if (this.hitlService) {
      const pending = this.hitlService.listApprovals('pending');
      const hitl = pending.find(a => (a.details as Record<string, unknown>)?.['taskId'] === taskIdStr);
      if (hitl) this.hitlService.respondToApproval(hitl.id, false, 'direct');
    }

    task.status = 'cancelled';
    task.updatedAt = new Date().toISOString();
    task.completedAt = task.updatedAt;

    this.ws?.broadcastTaskUpdate(task.id, task.status, { title: task.title });
    this.emitTaskEvent({
      type: 'status_changed',
      taskId: task.id,
      taskTitle: task.title,
      orgId: task.orgId,
      status: task.status,
      previousStatus: 'pending_approval',
      timestamp: task.updatedAt,
    });
    log.info(`Task rejected: ${task.title}`, { id: task.id });
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  updateTaskStatus(id: string, status: TaskStatus, updatedBy?: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    // pending_approval is a locked state — only approveTask() / rejectTask() can exit it
    if (task.status === 'pending_approval') {
      throw new Error(`Task ${id} is pending approval. Use the approve or reject endpoint to change its status.`);
    }

    // Prevent starting a blocked task
    if (status === 'in_progress' && task.status === 'blocked') {
      if (!this.areBlockersSatisfied(task)) {
        throw new Error(`Task ${id} is blocked by unfinished dependencies`);
      }
    }

    const prevStatus = task.status;
    const now = new Date().toISOString();
    task.status = status;
    task.updatedAt = now;
    if (updatedBy) task.updatedBy = updatedBy;

    if (status === 'in_progress' && !task.startedAt) {
      task.startedAt = now;
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      task.completedAt = now;
      // Revoke reviewer's worktree access when task is finalized
      if (task.reviewerAgentId && task.projectId && this.agentManager) {
        const worktreePath = this.getTaskWorktreePath(task);
        if (worktreePath) {
          this.agentManager.revokeReviewAccess(task.reviewerAgentId, worktreePath);
        }
      }
    }

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
      this.taskRepo
        .updateStatus(id, status, updatedBy)
        .catch(err => log.warn('Failed to persist task status to DB', { error: String(err) }));
    }

    // Auto-start execution when a task transitions to in_progress but has no active runner.
    if (
      status === 'in_progress' &&
      prevStatus !== 'in_progress' &&
      task.assignedAgentId &&
      this.agentManager
    ) {
      const activeToken = this.taskCancelTokens.get(id);
      if (!activeToken || activeToken.cancelled) {
        log.info(`Auto-starting task execution (triggered by status change to in_progress)`, {
          taskId: id,
        });
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
      this.checkDependentTasks(task);
    }

    // Emit task event
    const eventType: TaskEventType =
      status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'status_changed';
    this.emitTaskEvent({
      type: eventType,
      taskId: id,
      taskTitle: task.title,
      orgId: task.orgId,
      status,
      previousStatus: prevStatus,
      agentId: task.assignedAgentId,
      timestamp: task.updatedAt,
    });

    // Auto-transition accepted → completed
    if (status === 'accepted') {
      setImmediate(() => {
        try {
          this.updateTaskStatus(id, 'completed');
          log.info(`Task auto-completed after acceptance: ${task.title}`, { id });
        } catch (err) {
          log.warn('Failed to auto-complete accepted task', { taskId: id, error: String(err) });
        }
      });
    }

    log.info(`Task status updated: ${task.title}`, { id, status });
    return task;
  }

  assignTask(id: string, agentId: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status === 'pending_approval') {
      // While awaiting approval, only update the proposed assignee — status stays pending_approval.
      // The human reviewer can see and adjust the assignee before clicking Approve.
      task.assignedAgentId = agentId;
      task.updatedAt = new Date().toISOString();
      if (this.taskRepo) {
        this.taskRepo.assign(id, agentId).catch(err => log.warn('Failed to persist proposed assignee', { error: String(err) }));
      }
      log.info(`Proposed assignee updated (pending_approval)`, { taskId: id, agentId });
      return task;
    }
    task.assignedAgentId = agentId;
    task.status = 'assigned';
    task.updatedAt = new Date().toISOString();

    // Persist to DB
    if (this.taskRepo) {
      this.taskRepo
        .assign(id, agentId)
        .catch(err => log.warn('Failed to persist task assignment to DB', { error: String(err) }));
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
      this.taskRepo
        .assign(id, null)
        .catch(err =>
          log.warn('Failed to persist task unassignment to DB', { error: String(err) })
        );
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
      this.taskRepo
        .update(id, { notes: task.notes })
        .catch(err => log.warn('Failed to persist task note to DB', { error: String(err) }));
    }

    log.info(`Task note added`, { taskId: id, note: note.slice(0, 80) });
  }

  listTasks(filters?: {
    orgId?: string;
    status?: TaskStatus;
    assignedAgentId?: string;
    priority?: TaskPriority;
    projectId?: string;
    iterationId?: string;
    requirementId?: string;
  }): Task[] {
    let result = [...this.tasks.values()];
    if (filters?.orgId) result = result.filter(t => t.orgId === filters.orgId);
    if (filters?.status) result = result.filter(t => t.status === filters.status);
    if (filters?.assignedAgentId)
      result = result.filter(t => t.assignedAgentId === filters.assignedAgentId);
    if (filters?.priority) result = result.filter(t => t.priority === filters.priority);
    if (filters?.projectId) result = result.filter(t => t.projectId === filters.projectId);
    if (filters?.iterationId) result = result.filter(t => t.iterationId === filters.iterationId);
    if (filters?.requirementId) result = result.filter(t => t.requirementId === filters.requirementId);
    return result;
  }

  getTasksByAgent(agentId: string): Task[] {
    return [...this.tasks.values()].filter(t => t.assignedAgentId === agentId);
  }

  getTaskBoard(orgId: string, filters?: { projectId?: string; iterationId?: string }): Record<TaskStatus, Task[]> {
    const board: Record<TaskStatus, Task[]> = {
      pending: [],
      pending_approval: [],
      assigned: [],
      in_progress: [],
      blocked: [],
      review: [],
      revision: [],
      accepted: [],
      completed: [],
      failed: [],
      cancelled: [],
      archived: [],
    };

    for (const task of this.tasks.values()) {
      if (task.orgId !== orgId) continue;
      if (filters?.projectId && task.projectId !== filters.projectId) continue;
      if (filters?.iterationId && task.iterationId !== filters.iterationId) continue;
      board[task.status].push(task);
    }

    return board;
  }

  getDashboard(orgId?: string): {
    statusCounts: Record<TaskStatus, number>;
    totalTasks: number;
    agentWorkload: Array<{
      agentId: string;
      agentName?: string;
      activeTasks: number;
      completedTasks: number;
    }>;
    recentActivity: Array<{ taskId: string; title: string; status: TaskStatus; updatedAt: string }>;
    averageCompletionTimeMs: number | null;
  } {
    const tasks = orgId
      ? [...this.tasks.values()].filter(t => t.orgId === orgId)
      : [...this.tasks.values()];

    const statusCounts: Record<TaskStatus, number> = {
      pending: 0,
      pending_approval: 0,
      assigned: 0,
      in_progress: 0,
      blocked: 0,
      review: 0,
      revision: 0,
      accepted: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      archived: 0,
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
        agentName = agents.find(a => a.id === agentId)?.name;
      } catch {
        /* ignore */
      }
      return { agentId, agentName, activeTasks: counts.active, completedTasks: counts.completed };
    });

    const recentActivity = [...tasks]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 20)
      .map(t => ({ taskId: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt }));

    const completedTasks = tasks.filter(
      t => t.status === 'completed' && t.updatedAt && t.createdAt
    );
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
    const idleAgents = agents.filter(a => a.status === 'idle');

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
      const score = requiredSkills.reduce(
        (acc, skill) => acc + (agentSkills.includes(skill) ? 1 : 0),
        0
      );

      if (score > bestScore) {
        bestScore = score;
        bestId = a.id;
      }
    }

    return bestId ?? idleAgents[0]?.id;
  }

  updateTask(
    id: string,
    data: { title?: string; description?: string; priority?: TaskPriority; projectId?: string | null; iterationId?: string | null; blockedBy?: string[] },
    updatedBy?: string
  ): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (data.title !== undefined) task.title = data.title;
    if (data.description !== undefined) task.description = data.description;
    if (data.priority !== undefined) task.priority = data.priority;
    if (data.projectId !== undefined) task.projectId = data.projectId ?? undefined;
    if (data.iterationId !== undefined) task.iterationId = data.iterationId ?? undefined;

    if (data.blockedBy !== undefined) {
      task.blockedBy = data.blockedBy;
      if (this.taskRepo && 'updateBlockedBy' in this.taskRepo) {
        (this.taskRepo as any).updateBlockedBy(id, data.blockedBy)
          .catch((err: unknown) => log.warn('Failed to persist blockedBy to DB', { error: String(err) }));
      }
      this.reevaluateBlockedStatus(task);
    }

    task.updatedAt = new Date().toISOString();
    if (updatedBy) task.updatedBy = updatedBy;

    if (this.taskRepo) {
      const { blockedBy: _bb, ...rest } = data;
      if (Object.keys(rest).length > 0) {
        this.taskRepo
          .update(id, rest)
          .catch(err => log.warn('Failed to persist task update to DB', { error: String(err) }));
      }
    }

    this.ws?.broadcastTaskUpdate(id, task.status, { title: task.title });

    return task;
  }

  private reevaluateBlockedStatus(task: Task): void {
    if (!task.blockedBy?.length) {
      if (task.status === 'blocked') {
        const newStatus = task.assignedAgentId ? 'assigned' : 'pending';
        task.status = newStatus;
        if (this.taskRepo) {
          this.taskRepo.updateStatus(task.id, newStatus).catch(err =>
            log.warn('Failed to persist unblocked status', { taskId: task.id, error: String(err) })
          );
        }
      }
      return;
    }
    if (this.areBlockersSatisfied(task)) {
      if (task.status === 'blocked') {
        const newStatus = task.assignedAgentId ? 'assigned' : 'pending';
        task.status = newStatus;
        if (this.taskRepo) {
          this.taskRepo.updateStatus(task.id, newStatus).catch(err =>
            log.warn('Failed to persist unblocked status', { taskId: task.id, error: String(err) })
          );
        }
      }
    } else {
      if (task.status === 'pending' || task.status === 'assigned') {
        task.status = 'blocked';
        if (this.taskRepo) {
          this.taskRepo.updateStatus(task.id, 'blocked').catch(err =>
            log.warn('Failed to persist blocked status', { taskId: task.id, error: String(err) })
          );
        }
      }
    }
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
      this.taskRepo
        .delete(id)
        .catch(err => log.warn('Failed to delete task from DB', { error: String(err) }));
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

    const allSubDone = parent.subtaskIds.every(subId => {
      const sub = this.tasks.get(subId);
      return sub && (sub.status === 'completed' || sub.status === 'cancelled');
    });

    if (allSubDone && parent.subtaskIds.length > 0) {
      this.updateTaskStatus(parent.id, 'completed');
    }
  }

  /**
   * When a task completes, check if any other tasks were blocked by it
   * and unblock them if all their dependencies are satisfied.
   */
  private checkDependentTasks(completedTask: Task): void {
    for (const [, task] of this.tasks) {
      if (task.status !== 'blocked' || !task.blockedBy?.length) continue;
      if (!task.blockedBy.includes(completedTask.id)) continue;

      if (this.areBlockersSatisfied(task)) {
        const newStatus = task.assignedAgentId ? 'assigned' : 'pending';
        log.info(`Unblocking task ${task.id} (dependency ${completedTask.id} completed)`);
        task.status = newStatus;
        task.updatedAt = new Date().toISOString();
        if (this.taskRepo) {
          this.taskRepo.updateStatus(task.id, newStatus).catch(err =>
            log.warn('Failed to persist unblocked task status', { taskId: task.id, error: String(err) })
          );
        }
        this.ws?.broadcastTaskUpdate(task.id, newStatus, { title: task.title });
        this.emitTaskEvent({
          type: 'unblocked',
          taskId: task.id,
          taskTitle: task.title,
          orgId: task.orgId,
          status: newStatus,
          previousStatus: 'blocked',
          agentId: task.assignedAgentId,
          timestamp: task.updatedAt,
        });
      }
    }
  }

  private areBlockersSatisfied(task: Task): boolean {
    if (!task.blockedBy?.length) return true;
    return task.blockedBy.every(blockerId => {
      const blocker = this.tasks.get(blockerId);
      return blocker && (blocker.status === 'completed' || blocker.status === 'cancelled');
    });
  }

  private checkTimeouts(): void {
    const now = Date.now();
    for (const [, task] of this.tasks) {
      if (task.status !== 'in_progress') continue;
      if (!task.timeoutMs || !task.startedAt) continue;

      const elapsed = now - new Date(task.startedAt).getTime();
      if (elapsed > task.timeoutMs) {
        log.warn(`Task ${task.id} timed out after ${elapsed}ms (limit: ${task.timeoutMs}ms)`);
        this.updateTaskStatus(task.id, 'failed');
        this.emitTaskEvent({
          type: 'timeout',
          taskId: task.id,
          taskTitle: task.title,
          orgId: task.orgId,
          status: 'failed',
          previousStatus: 'in_progress',
          agentId: task.assignedAgentId,
          timestamp: new Date().toISOString(),
          metadata: { reason: 'timeout', elapsedMs: elapsed, timeoutMs: task.timeoutMs },
        });
      }
    }
  }

  private emitTaskEvent(event: TaskEvent): void {
    for (const webhook of this.webhooks) {
      try {
        const result = webhook(event);
        if (result instanceof Promise) {
          result.catch(err => log.warn('Task webhook error', { error: String(err) }));
        }
      } catch (err) {
        log.warn('Task webhook error (sync)', { error: String(err) });
      }
    }
  }

  // ─── Governance: Task Approval ─────────────────────────────────────────────

  private governancePolicy: TaskGovernancePolicy = {
    enabled: true,
    defaultTier: 'human',
    maxPendingTasksPerAgent: 10,
    maxTotalActiveTasks: 20,
    requireApprovalForPriority: ['critical', 'high'],
    requireRequirement: true,
    rules: [],
  };

  setGovernancePolicy(policy: TaskGovernancePolicy): void {
    this.governancePolicy = policy;
    log.info('Governance policy updated', {
      enabled: policy.enabled,
      defaultTier: policy.defaultTier,
    });
  }

  getGovernancePolicy(): TaskGovernancePolicy {
    return this.governancePolicy;
  }

  determineApprovalTier(
    request: CreateTaskRequest,
    creatorRole?: 'worker' | 'manager'
  ): ApprovalTier {
    const policy = this.governancePolicy;

    // Human-created tasks and pre-approved plan tasks always skip governance
    if (request.creatorRole === 'human') return 'auto';
    if (request.approvedVia === 'plan_approval') return 'auto';

    // Safe default when no policy is configured: agent-created tasks require human approval
    if (!policy?.enabled) {
      if (request.creatorRole === 'worker' || request.creatorRole === 'manager') {
        return 'human';
      }
      return 'auto';
    }

    if (request.priority && policy.requireApprovalForPriority.includes(request.priority)) {
      return 'human';
    }

    for (const rule of policy.rules) {
      const cond = rule.condition;
      if (cond.creatorRole && cond.creatorRole !== creatorRole) continue;
      if (cond.priority && request.priority && !cond.priority.includes(request.priority)) continue;
      if (cond.titlePattern) {
        try {
          if (!new RegExp(cond.titlePattern, 'i').test(request.title)) continue;
        } catch {
          continue;
        }
      }
      return rule.tier;
    }

    return policy.defaultTier;
  }

  checkTaskLimits(request: CreateTaskRequest): { allowed: boolean; reason?: string } {
    const policy = this.governancePolicy;
    if (!policy?.enabled) return { allowed: true };

    if (policy.maxTotalActiveTasks > 0) {
      const activeTasks = [...this.tasks.values()].filter(
        t =>
          t.orgId === request.orgId &&
          !['completed', 'failed', 'cancelled', 'archived'].includes(t.status)
      );
      if (activeTasks.length >= policy.maxTotalActiveTasks) {
        return {
          allowed: false,
          reason: `Org-wide active task cap reached (${policy.maxTotalActiveTasks})`,
        };
      }
    }

    if (request.assignedAgentId && policy.maxPendingTasksPerAgent > 0) {
      const agentTasks = [...this.tasks.values()].filter(
        t =>
          t.assignedAgentId === request.assignedAgentId &&
          !['completed', 'failed', 'cancelled', 'archived'].includes(t.status)
      );
      if (agentTasks.length >= policy.maxPendingTasksPerAgent) {
        return {
          allowed: false,
          reason: `Agent task cap reached (${policy.maxPendingTasksPerAgent})`,
        };
      }
    }

    return { allowed: true };
  }

  // ─── Governance: Submit for Review ─────────────────────────────────────────

  async submitForReview(taskId: string, deliverables: TaskDeliverable[]): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'in_progress' && task.status !== 'revision') {
      throw new Error(`Task ${taskId} is in ${task.status} status, cannot submit for review`);
    }

    // Run automated review checks if ReviewService is available
    let reviewReport: ReviewReport | undefined;
    if (this.reviewService) {
      try {
        let worktreePath: string | undefined;
        let baseBranch: string | undefined;
        if (task.projectId && this.workspaceManager) {
          const project = this.projectService?.getProject(task.projectId);
          const repo = project?.repositories?.find(r => r.role === 'primary' && r.localPath) ?? project?.repositories?.find(r => r.localPath);
          if (repo?.localPath) {
            worktreePath = `${repo.localPath}/.worktrees/task-${task.id}`;
            baseBranch = repo.defaultBranch;
          }
        }

        reviewReport = await this.reviewService.runReview({
          taskId: task.id,
          agentId: task.assignedAgentId,
          description: deliverables.map(d => d.summary ?? '').join('\n'),
          worktreePath,
          baseBranch,
        });

        log.info('Automated review completed for task submission', {
          taskId, overallStatus: reviewReport.overallStatus, summary: reviewReport.summary,
        });
      } catch (err) {
        log.warn('Automated review failed, proceeding with submission', { taskId, error: String(err) });
      }
    }

    task.deliverables = deliverables;
    task.status = 'review';
    task.updatedAt = new Date().toISOString();

    // Persist deliverables to DB
    if (this.taskRepo) {
      this.taskRepo.updateDeliverables(task.id, deliverables)
        .catch(err => log.warn('Failed to persist deliverables to DB', { taskId: task.id, error: String(err) }));
    }

    // Publish deliverables to shared workspace so reviewers and other agents can access them
    if (this.sharedDataDir) {
      this.publishDeliverablestoShared(task, deliverables);
    }

    // Grant reviewer read-only access to the task's worktree
    if (task.reviewerAgentId && task.projectId && this.agentManager) {
      const worktreePath = this.getTaskWorktreePath(task);
      if (worktreePath) {
        this.agentManager.grantReviewAccess(task.reviewerAgentId, worktreePath);
      }
    }

    const broadcastPayload: Record<string, unknown> = { deliverables };
    if (reviewReport) {
      broadcastPayload['reviewReport'] = {
        id: reviewReport.id,
        overallStatus: reviewReport.overallStatus,
        summary: reviewReport.summary,
        checks: reviewReport.checks,
      };
    }
    this.ws?.broadcastTaskUpdate(task.id, task.status, broadcastPayload);

    this.emitTaskEvent({
      type: 'status_changed',
      taskId: task.id,
      taskTitle: task.title,
      orgId: task.orgId,
      status: 'review',
      previousStatus: 'in_progress',
      agentId: task.assignedAgentId,
      timestamp: task.updatedAt,
    });

    if (reviewReport) {
      task.notes = task.notes ?? [];
      task.notes.push(`[${task.updatedAt}] Automated review: ${reviewReport.overallStatus} — ${reviewReport.summary}`);
    }

    this.auditService?.record({
      orgId: task.orgId,
      agentId: task.assignedAgentId,
      type: 'task_submitted_for_review',
      action: 'submit_for_review',
      detail: `Task "${task.title}" submitted for review`,
      taskId: task.id,
      projectId: task.projectId,
      success: true,
      metadata: { deliverableCount: deliverables.length, reviewReportStatus: reviewReport?.overallStatus },
    });

    log.info(`Task submitted for review: ${task.title}`, { id: task.id });
    return task;
  }

  /**
   * Derive the git worktree path for a project-bound task.
   */
  private getTaskWorktreePath(task: Task): string | undefined {
    if (!task.projectId) return undefined;
    const project = this.projectService?.getProject(task.projectId);
    const repo = project?.repositories?.find(r => r.role === 'primary' && r.localPath) ?? project?.repositories?.find(r => r.localPath);
    if (!repo?.localPath) return undefined;
    return join(repo.localPath, '.worktrees', `task-${task.id}`);
  }

  /**
   * Copy deliverable files/summaries to the shared workspace so reviewers
   * and other agents can access them without needing the worker's workspace.
   */
  private publishDeliverablestoShared(task: Task, deliverables: TaskDeliverable[]): void {
    if (!this.sharedDataDir) return;
    const taskSharedDir = join(this.sharedDataDir, 'tasks', task.id);
    mkdirSync(taskSharedDir, { recursive: true });

    // Write a manifest with task metadata and deliverable summaries
    const manifest = {
      taskId: task.id,
      title: task.title,
      assignedAgentId: task.assignedAgentId,
      projectId: task.projectId,
      publishedAt: new Date().toISOString(),
      deliverables: deliverables.map(d => ({
        type: d.type,
        reference: d.reference,
        summary: d.summary,
        diffStats: d.diffStats,
        testResults: d.testResults,
      })),
    };
    writeFileSync(join(taskSharedDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // For file-type deliverables, try to copy the file to shared space
    for (const d of deliverables) {
      if (d.type === 'file' && d.reference) {
        const src = resolve(d.reference);
        if (existsSync(src)) {
          try {
            const destName = src.split('/').pop() ?? 'deliverable';
            cpSync(src, join(taskSharedDir, destName), { recursive: true });
          } catch (err) {
            log.warn('Failed to copy deliverable to shared space', { taskId: task.id, ref: d.reference, error: String(err) });
          }
        }
      }
      // For document/report types, write the summary as a file
      if ((d.type === 'document' || d.type === 'report') && d.summary) {
        const safeName = d.reference.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
        writeFileSync(join(taskSharedDir, `${safeName}.md`), d.summary);
      }
    }

    log.info('Deliverables published to shared workspace', { taskId: task.id, dir: taskSharedDir });
  }

  async acceptTask(taskId: string, reviewerAgentId?: string): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'review') {
      throw new Error(`Task ${taskId} is in ${task.status} status, cannot accept`);
    }

    // Enforce: reviewer must be different from the assigned worker
    if (reviewerAgentId && task.assignedAgentId && reviewerAgentId === task.assignedAgentId) {
      throw new Error(`Agent ${reviewerAgentId} cannot accept their own task. A different reviewer or human must approve the work.`);
    }

    task.status = 'accepted';
    task.reviewerAgentId = reviewerAgentId;
    task.updatedAt = new Date().toISOString();
    this.ws?.broadcastTaskUpdate(task.id, task.status, {});

    this.emitTaskEvent({
      type: 'status_changed',
      taskId: task.id,
      taskTitle: task.title,
      orgId: task.orgId,
      status: 'accepted',
      previousStatus: 'review',
      agentId: task.assignedAgentId,
      timestamp: task.updatedAt,
    });

    // Merge task branch and clean up worktree for project-bound tasks
    if (task.projectId && this.workspaceManager) {
      const project = this.projectService?.getProject(task.projectId);
      const repo = project?.repositories?.find(r => r.role === 'primary' && r.localPath) ?? project?.repositories?.find(r => r.localPath);
      if (repo?.localPath) {
        try {
          const result = await this.workspaceManager.mergeTaskBranch(repo.localPath, task.id, repo.defaultBranch);
          if (result.success) {
            await this.workspaceManager.removeWorktree(repo.localPath, task.id);
            await this.workspaceManager.deleteBranch(repo.localPath, task.id);
            log.info('Task branch merged and worktree cleaned up', {
              taskId, branch: `task/${task.id}`, target: repo.defaultBranch,
            });
          } else {
            log.warn('Task branch merge failed', {
              taskId, message: result.message, conflicts: result.conflicts,
            });
          }
        } catch (err) {
          log.error('Error merging task branch', { taskId, error: String(err) });
        }
      }
    }

    this.auditService?.record({
      orgId: task.orgId,
      agentId: reviewerAgentId,
      type: 'task_review_accepted',
      action: 'accept_task',
      detail: `Task "${task.title}" accepted by reviewer`,
      taskId: task.id,
      projectId: task.projectId,
      success: true,
      metadata: { workerAgentId: task.assignedAgentId },
    });

    log.info(`Task accepted: ${task.title}`, { id: task.id });

    // Auto-transition accepted → completed
    setImmediate(() => {
      try {
        this.updateTaskStatus(task.id, 'completed');
        log.info(`Task auto-completed after acceptance: ${task.title}`, { id: task.id });
      } catch (err) {
        log.warn('Failed to auto-complete accepted task', { taskId: task.id, error: String(err) });
      }
    });

    return task;
  }

  requestRevision(taskId: string, reason: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'review') {
      throw new Error(`Task ${taskId} is in ${task.status} status, cannot request revision`);
    }

    task.status = 'revision';
    task.notes = task.notes ?? [];
    task.notes.push(`[${new Date().toISOString()}] Revision requested: ${reason}`);
    task.updatedAt = new Date().toISOString();
    this.ws?.broadcastTaskUpdate(task.id, task.status, { reason });

    this.auditService?.record({
      orgId: task.orgId,
      agentId: task.assignedAgentId,
      type: 'task_review_revision_requested',
      action: 'request_revision',
      detail: `Revision requested for task "${task.title}": ${reason.slice(0, 200)}`,
      taskId: task.id,
      projectId: task.projectId,
      success: true,
      metadata: { reason },
    });

    if (this.taskCommentRepo) {
      this.taskCommentRepo.add({
        taskId: task.id,
        authorId: 'system',
        authorName: 'Review System',
        authorType: 'system',
        content: `**Revision Requested**\n\n${reason}`,
      }).catch(err => log.warn('Failed to persist revision comment', { taskId: task.id, error: String(err) }));
    }

    log.info(`Revision requested for task: ${task.title}`, { id: task.id, reason });
    return task;
  }

  archiveTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    task.status = 'archived';
    task.updatedAt = new Date().toISOString();
    log.info(`Task archived: ${task.title}`, { id: task.id });
    return task;
  }

  // ─── Duplicate Detection & Board Health ───────────────────────────────────

  private normalizeTitle(title: string): string {
    return title.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  private titlesAreSimilar(a: string, b: string): boolean {
    const na = this.normalizeTitle(a);
    const nb = this.normalizeTitle(b);
    if (na === nb) return true;

    // Containment: one title fully contains the other (meaningful overlap)
    const shorter = na.length <= nb.length ? na : nb;
    const longer = na.length <= nb.length ? nb : na;
    if (shorter.length >= 10 && longer.includes(shorter)) return true;

    // Levenshtein distance ratio — require > 0.85 similarity and minimum length
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen < 10) return na === nb;
    const dist = this.levenshteinDistance(na, nb);
    return 1 - dist / maxLen > 0.85;
  }

  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  /**
   * Find groups of suspected duplicate tasks among pending/assigned tasks.
   * Groups tasks by (requirementId, assignedAgentId) then compares titles.
   */
  findDuplicateTasks(orgId: string): Array<{
    group: string;
    tasks: Array<{ id: string; title: string; status: string; createdAt: string }>;
  }> {
    const candidates = [...this.tasks.values()].filter(
      t => t.orgId === orgId && ['pending', 'assigned', 'blocked'].includes(t.status)
    );

    // Group by (requirementId || 'none', assignedAgentId || 'unassigned')
    const groups = new Map<string, Task[]>();
    for (const task of candidates) {
      const key = `${task.requirementId ?? 'none'}:${task.assignedAgentId ?? 'unassigned'}`;
      const arr = groups.get(key) ?? [];
      arr.push(task);
      groups.set(key, arr);
    }

    const duplicateGroups: Array<{
      group: string;
      tasks: Array<{ id: string; title: string; status: string; createdAt: string }>;
    }> = [];

    for (const [groupKey, tasksInGroup] of groups) {
      if (tasksInGroup.length < 2) continue;

      // Find clusters of similar titles within this group
      const visited = new Set<string>();
      for (let i = 0; i < tasksInGroup.length; i++) {
        if (visited.has(tasksInGroup[i].id)) continue;
        const cluster: Task[] = [tasksInGroup[i]];
        visited.add(tasksInGroup[i].id);

        for (let j = i + 1; j < tasksInGroup.length; j++) {
          if (visited.has(tasksInGroup[j].id)) continue;
          if (this.titlesAreSimilar(tasksInGroup[i].title, tasksInGroup[j].title)) {
            cluster.push(tasksInGroup[j]);
            visited.add(tasksInGroup[j].id);
          }
        }

        if (cluster.length >= 2) {
          duplicateGroups.push({
            group: groupKey,
            tasks: cluster.map(t => ({
              id: t.id,
              title: t.title,
              status: t.status,
              createdAt: t.createdAt,
            })),
          });
        }
      }
    }

    return duplicateGroups;
  }

  /**
   * Auto-cancel duplicate pending/assigned tasks.
   * Keeps the oldest task in each duplicate group and cancels the rest.
   */
  cleanupDuplicateTasks(orgId: string): { cancelledIds: string[]; count: number } {
    const groups = this.findDuplicateTasks(orgId);
    const cancelledIds: string[] = [];

    for (const group of groups) {
      // Sort by createdAt ascending — keep the oldest
      const sorted = [...group.tasks].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      const keeper = sorted[0];
      for (let i = 1; i < sorted.length; i++) {
        const dup = sorted[i];
        try {
          this.addTaskNote(dup.id, `[System] Auto-cancelled: duplicate of task ${keeper.id} ("${keeper.title}")`);
          this.updateTaskStatus(dup.id, 'cancelled');
          cancelledIds.push(dup.id);
          log.info(`Auto-cancelled duplicate task`, { cancelledId: dup.id, keeperId: keeper.id });
        } catch (err) {
          log.warn('Failed to cancel duplicate task', { taskId: dup.id, error: String(err) });
        }
      }
    }

    return { cancelledIds, count: cancelledIds.length };
  }

  /**
   * Get a health summary of the task board for manager review.
   */
  getTaskBoardHealth(orgId: string): Record<string, unknown> {
    const allTasks = [...this.tasks.values()].filter(t => t.orgId === orgId);
    const now = Date.now();

    const statusCounts: Record<string, number> = {};
    for (const t of allTasks) {
      statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
    }

    // Duplicates
    const duplicateGroups = this.findDuplicateTasks(orgId);

    // Stale blocked tasks (blocked > 24h)
    const staleBlocked = allTasks
      .filter(t => {
        if (t.status !== 'blocked') return false;
        const age = now - new Date(t.updatedAt).getTime();
        return age > 24 * 60 * 60 * 1000;
      })
      .map(t => ({ id: t.id, title: t.title, blockedSinceHours: Math.round((now - new Date(t.updatedAt).getTime()) / 3600000) }));

    // Stale assigned tasks (assigned > 48h without starting)
    const staleAssigned = allTasks
      .filter(t => {
        if (t.status !== 'assigned') return false;
        const age = now - new Date(t.updatedAt).getTime();
        return age > 48 * 60 * 60 * 1000;
      })
      .map(t => ({ id: t.id, title: t.title, assignedAgentId: t.assignedAgentId, assignedSinceHours: Math.round((now - new Date(t.updatedAt).getTime()) / 3600000) }));

    // Unassigned tasks
    const unassigned = allTasks
      .filter(t => !t.assignedAgentId && ['pending', 'blocked'].includes(t.status))
      .map(t => ({ id: t.id, title: t.title, status: t.status }));

    // Agent workload
    const agentLoad = new Map<string, { active: number; total: number }>();
    for (const t of allTasks) {
      if (!t.assignedAgentId) continue;
      const entry = agentLoad.get(t.assignedAgentId) ?? { active: 0, total: 0 };
      entry.total++;
      if (['assigned', 'in_progress', 'blocked'].includes(t.status)) entry.active++;
      agentLoad.set(t.assignedAgentId, entry);
    }

    return {
      totalTasks: allTasks.length,
      statusCounts,
      duplicateGroups: duplicateGroups.length,
      duplicateDetails: duplicateGroups,
      staleBlocked,
      staleAssigned,
      unassigned,
      agentWorkload: Object.fromEntries(agentLoad),
    };
  }

  // ── Scheduled Task Support ──

  listScheduledTasks(): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.taskType === 'scheduled');
  }

  async updateScheduleConfig(taskIdStr: string, config: ScheduleConfig): Promise<void> {
    const task = this.tasks.get(taskIdStr);
    if (!task) return;
    task.scheduleConfig = config;
    task.updatedAt = new Date().toISOString();
    if (this.taskRepo) {
      await this.taskRepo.update(taskIdStr, { scheduleConfig: config as unknown as Record<string, unknown> });
    }
  }

  async resetTaskForRerun(taskIdStr: string): Promise<void> {
    const task = this.tasks.get(taskIdStr);
    if (!task) return;
    const previousStatus = task.status;
    task.status = task.assignedAgentId ? 'assigned' : 'pending';
    task.result = undefined;
    task.startedAt = undefined;
    task.completedAt = undefined;
    task.updatedAt = new Date().toISOString();

    if (this.taskRepo) {
      await this.taskRepo.updateStatus(taskIdStr, task.status);
    }

    this.ws?.broadcastTaskUpdate(task.id, task.status, { title: task.title });
    this.emitTaskEvent({
      type: 'status_changed',
      taskId: task.id,
      taskTitle: task.title,
      orgId: task.orgId,
      status: task.status,
      previousStatus,
      agentId: task.assignedAgentId,
      timestamp: task.updatedAt,
      metadata: { reason: 'scheduled_rerun' },
    });
    log.info('Scheduled task reset for rerun', { taskId: task.id, title: task.title });
  }
}

function computeInitialNextRun(config: ScheduleConfig): string | undefined {
  if (config.runAt) return config.runAt;

  if (config.every) {
    const match = config.every.match(/^(\d+)(ms|s|m|h|d|w)$/);
    if (match) {
      const value = parseInt(match[1]!, 10);
      const unit = match[2]!;
      const multipliers: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
      const ms = value * (multipliers[unit] ?? 0);
      if (ms > 0) return new Date(Date.now() + ms).toISOString();
    }
  }

  if (config.cron) {
    return new Date(Date.now() + 3_600_000).toISOString();
  }

  return undefined;
}
