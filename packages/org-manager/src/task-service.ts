import {
  createLogger,
  taskId,
  type Task,
  type SubTask,
  type SubTaskStatus,
  type TaskStatus,
  type TaskPriority,
  type TaskType,
  type ScheduleConfig,
  type TaskGovernancePolicy,
  type ApprovalTier,
  type TaskDeliverable,
  type BuilderArtifactType,
  manifestFilename,
  type PackageType,
  type TaskQueryOptions,
  type TaskQueryResult,
  type TaskSortField,
} from '@markus/shared';
import type { AgentManager, TaskWorkspace, ReviewService, ReviewReport } from '@markus/core';
import type { WSBroadcaster } from './ws-server.js';
import type { TaskRepo, TaskLogRepo, TaskLogRow, TaskLogType, TaskCommentRepo, TaskCommentRow, RequirementCommentRepo } from '@markus/storage';
import type { HITLService } from './hitl-service.js';
import type { AuditService } from './audit-service.js';
import type { DeliverableService } from './deliverable-service.js';
import type { OrganizationService } from './org-service.js';
import type { ProjectService } from './project-service.js';
import type { RequirementService } from './requirement-service.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const log = createLogger('task-service');

/** Format a Date as local time with timezone, e.g. "2026-03-17 22:45:59 (Asia/Shanghai, UTC+08:00)" */
function formatLocalTimestamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = d.getTimezoneOffset();
  const sign = offset <= 0 ? '+' : '-';
  const absH = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const absM = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${dateStr} (${tz}, UTC${sign}${absH}:${absM})`;
}

export interface CreateTaskRequest {
  orgId: string;
  title: string;
  description: string;
  priority?: TaskPriority;
  assignedAgentId: string;
  reviewerAgentId: string;
  dueAt?: string;
  blockedBy?: string[];
  timeoutMs?: number;
  requirementId?: string;
  projectId?: string;
  createdBy?: string;
  creatorRole?: 'worker' | 'manager' | 'human';
  approvedVia?: string;
  planReportId?: string;
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
  private executionStreamRepo?: { append(data: { sourceType: string; sourceId: string; agentId: string; seq: number; type: string; content: string; metadata?: unknown; executionRound?: number }): unknown };
  private hitlService?: HITLService;
  /** Cancel tokens for active task executions — keyed by taskId */
  private taskCancelTokens = new Map<string, { cancelled: boolean }>();
  /** Tasks currently being reviewed — prevents duplicate review notifications */
  private activeReviews = new Set<string>();
  private webhooks: TaskWebhook[] = [];
  private timeoutCheckInterval?: ReturnType<typeof setInterval>;
  private projectService?: ProjectService;
  private requirementService?: RequirementService;
  private reviewService?: ReviewService;
  private taskCommentRepo?: TaskCommentRepo;
  private requirementCommentRepo?: RequirementCommentRepo;
  private auditService?: AuditService;
  private deliverableService?: DeliverableService;
  private sharedDataDir?: string;
  private orgService?: OrganizationService;

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

  setExecutionStreamRepo(repo: { append(data: { sourceType: string; sourceId: string; agentId: string; seq: number; type: string; content: string; metadata?: unknown; executionRound?: number }): unknown }): void {
    this.executionStreamRepo = repo;
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

  setReviewService(rs: ReviewService): void {
    this.reviewService = rs;
  }

  setTaskCommentRepo(repo: TaskCommentRepo): void {
    this.taskCommentRepo = repo;
  }

  setRequirementCommentRepo(repo: RequirementCommentRepo): void {
    this.requirementCommentRepo = repo;
  }

  /** Post a structured comment on a task (used by agent tools) */
  async postTaskComment(taskId: string, authorId: string, authorName: string, content: string, mentions?: string[]): Promise<{ id: string }> {
    if (!this.taskCommentRepo) throw new Error('Task comment repo not available');
    const comment = await this.taskCommentRepo.add({
      taskId,
      authorId,
      authorName,
      authorType: 'agent',
      content,
      mentions: mentions ?? [],
    });
    this.ws?.broadcast({
      type: 'task:comment',
      payload: {
        taskId,
        comment: {
          id: comment.id,
          taskId: comment.taskId,
          authorId: comment.authorId,
          authorName: comment.authorName,
          authorType: comment.authorType,
          content: comment.content,
          attachments: comment.attachments,
          mentions: comment.mentions,
          createdAt: comment.createdAt instanceof Date ? comment.createdAt.toISOString() : comment.createdAt,
        },
      },
      timestamp: new Date().toISOString(),
    });
    // Notify mentioned agents — they can use task_comment tool to reply
    if (mentions && mentions.length > 0 && this.agentManager) {
      const task = this.tasks.get(taskId);
      const taskTitle = task?.title ?? taskId;
      for (const mentionedId of mentions) {
        try {
          const agent = this.agentManager.getAgent(mentionedId);
          if (agent) {
            const notif = `You were mentioned by ${authorName} in a comment on task "${taskTitle}":\n\n${content}\n\nIf you want to reply, use the task_comment tool with task_id "${taskId}". (Task ID: ${taskId})`;
            agent.handleMessage(notif, undefined, { name: authorName, role: 'user' }, { ephemeral: true, maxHistory: 5, scenario: 'a2a' })
              .catch(() => {});
          }
        } catch { /* agent not found */ }
      }
    }
    return { id: comment.id };
  }

  /** Post a structured comment on a requirement (used by agent tools) */
  async postRequirementComment(requirementId: string, authorId: string, authorName: string, content: string, mentions?: string[]): Promise<{ id: string }> {
    if (!this.requirementCommentRepo) throw new Error('Requirement comment repo not available');
    const comment = await this.requirementCommentRepo.add({
      requirementId,
      authorId,
      authorName,
      authorType: 'agent',
      content,
      mentions: mentions ?? [],
    });
    this.ws?.broadcast({
      type: 'requirement:comment',
      payload: {
        requirementId,
        comment: {
          id: comment.id,
          requirementId: comment.requirementId,
          authorId: comment.authorId,
          authorName: comment.authorName,
          authorType: comment.authorType,
          content: comment.content,
          attachments: comment.attachments,
          mentions: comment.mentions,
          createdAt: comment.createdAt instanceof Date ? comment.createdAt.toISOString() : comment.createdAt,
        },
      },
      timestamp: new Date().toISOString(),
    });
    // Notify mentioned agents — they can use requirement_comment tool to reply
    if (mentions && mentions.length > 0 && this.agentManager) {
      for (const mentionedId of mentions) {
        try {
          const agent = this.agentManager.getAgent(mentionedId);
          if (agent) {
            const notif = `You were mentioned by ${authorName} in a comment on requirement "${requirementId}":\n\n${content}\n\nIf you want to reply, use the requirement_comment tool with requirement_id "${requirementId}". (Requirement ID: ${requirementId})`;
            agent.handleMessage(notif, undefined, { name: authorName, role: 'user' }, { ephemeral: true, maxHistory: 5, scenario: 'a2a' })
              .catch(() => {});
          }
        } catch { /* agent not found */ }
      }
    }
    return { id: comment.id };
  }

  setAuditService(audit: AuditService): void {
    this.auditService = audit;
  }

  setDeliverableService(ds: DeliverableService): void {
    this.deliverableService = ds;
  }

  setOrgService(os: OrganizationService): void {
    this.orgService = os;
  }

  setSharedDataDir(dir: string): void {
    this.sharedDataDir = dir;
    mkdirSync(join(dir, 'tasks'), { recursive: true });
    mkdirSync(join(dir, 'knowledge'), { recursive: true });

    // Seed USER.md if it doesn't exist (OpenClaw-inspired shared user profile)
    const userMdPath = join(dir, 'USER.md');
    if (!existsSync(userMdPath)) {
      writeFileSync(userMdPath, [
        '# About the Owner',
        '',
        '- Name:',
        '- What to call them:',
        '- Timezone:',
        '',
        '## Context',
        '',
        '(What do they care about? What projects are they working on? What annoys them?',
        'Build this over time. The Secretary agent maintains this file.)',
        '',
      ].join('\n'));
    }
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
  private static readonly MAX_IN_PROGRESS_RETRIES = 8;
  private static readonly RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
  private taskRetryErrors = new Map<string, { lastError: string; consecutiveCount: number }>();

  private static isNetworkError(errorContent: string): boolean {
    const lower = errorContent.toLowerCase();
    return lower.includes('econnreset') ||
      lower.includes('econnrefused') ||
      lower.includes('etimedout') ||
      lower.includes('fetch failed') ||
      lower.includes('aborterror') ||
      lower.includes('aborted') ||
      lower.includes('socket hang up') ||
      lower.includes('network');
  }

  private shouldRetryTask(taskId: string, errorContent: string, retryAttempt: number, cancelled: boolean): { shouldRetry: boolean; reason: string } {
    if (cancelled) return { shouldRetry: false, reason: 'cancelled' };

    const currentTask = this.tasks.get(taskId);
    if (!currentTask || currentTask.status !== 'in_progress') {
      return { shouldRetry: retryAttempt < TaskService.MAX_TASK_RETRIES, reason: 'not in_progress' };
    }

    // Hard cap on total retries even for in_progress tasks
    if (retryAttempt >= TaskService.MAX_IN_PROGRESS_RETRIES) {
      return { shouldRetry: false, reason: `exceeded max retries (${TaskService.MAX_IN_PROGRESS_RETRIES})` };
    }

    // Track consecutive identical errors (normalized)
    const normalizedError = errorContent.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '').trim().slice(0, 200);
    const tracker = this.taskRetryErrors.get(taskId);
    if (tracker && tracker.lastError === normalizedError) {
      tracker.consecutiveCount++;
    } else {
      this.taskRetryErrors.set(taskId, { lastError: normalizedError, consecutiveCount: 1 });
    }

    const updated = this.taskRetryErrors.get(taskId)!;
    // Allow more retries for network errors (transient), fewer for other errors
    const maxConsecutive = TaskService.isNetworkError(errorContent) ? 5 : 3;
    if (updated.consecutiveCount > maxConsecutive) {
      return { shouldRetry: false, reason: `same error repeated ${updated.consecutiveCount} times` };
    }

    return { shouldRetry: true, reason: 'transient error' };
  }

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
   * Format previous execution context for the agent prompt.
   * Groups by execution round and interleaves comments chronologically
   * so the agent sees user feedback exactly where it occurred.
   */
  private formatPreviousExecutionContext(logs: TaskLogRow[], comments: TaskCommentRow[] = [], task?: Task): string {
    if (logs.length === 0 && comments.length === 0) return '';

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

    // First pass: collect files and errors across all entries
    const filesRead = new Set<string>();
    const filesWritten = new Set<string>();
    const collectedErrors: string[] = [];
    const seenRounds = new Set<number>();

    for (const item of timeline) {
      if (item.kind !== 'log') continue;
      const entry = item.entry as TaskLogRow;
      if ((entry as any).executionRound) seenRounds.add((entry as any).executionRound);
      if (entry.type === 'tool_start') {
        const meta = entry.metadata as Record<string, unknown> | null;
        const args = meta?.arguments as Record<string, unknown> | undefined;
        if (args) {
          const path = (args['path'] ?? args['file'] ?? args['filePath'] ?? args['filename']) as string | undefined;
          if (path) {
            if (entry.content === 'file_read' || entry.content === 'read_file') filesRead.add(path);
            else if (entry.content === 'file_write' || entry.content === 'write_file') filesWritten.add(path);
          }
        }
      } else if (entry.type === 'error') {
        collectedErrors.push(entry.content);
      }
    }

    const totalRounds = seenRounds.size || 1;

    // Check for revision rejection — extract the latest revision reason from comments
    const revisionComments = comments
      .filter(c => c.content.startsWith('**Revision Requested'))
      .sort((a, b) => {
        const ta = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt as any).getTime();
        const tb = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt as any).getTime();
        return tb - ta;
      });
    const latestRevision = revisionComments[0];

    const lines: string[] = [];
    lines.push('## Previous Execution Context');
    lines.push('');

    // Current time context — helps the agent understand temporal relationships
    const now = new Date();
    lines.push(`**Current time:** ${formatLocalTimestamp(now)}`);

    // Current round context
    const currentExecutionRound = task?.executionRound ?? (totalRounds + 1);
    lines.push(`**Current execution round:** #${currentExecutionRound} (starting now)`);
    if (totalRounds > 0) {
      lines.push(`**Previous rounds:** ${totalRounds} round(s) of execution history exist below`);
    }
    lines.push('');

    // Scheduled task context — explain what this task is and why it's running again
    const isScheduledTask = task?.taskType === 'scheduled' && task?.scheduleConfig;
    if (isScheduledTask) {
      const config = task!.scheduleConfig!;
      lines.push('### Scheduled Task Context');
      lines.push('');
      lines.push('This is a **recurring scheduled task** that runs automatically on a schedule.');
      if (config.every) {
        lines.push(`- **Schedule:** Every ${config.every}`);
      } else if (config.cron) {
        lines.push(`- **Schedule:** Cron \`${config.cron}\``);
      }
      if (config.timezone) {
        lines.push(`- **Timezone:** ${config.timezone}`);
      }
      lines.push(`- **Total runs so far:** ${config.currentRuns ?? 0}`);
      if (config.lastRunAt) {
        lines.push(`- **Last run:** ${config.lastRunAt}`);
      }
      if (config.maxRuns !== undefined) {
        lines.push(`- **Max runs:** ${config.maxRuns}`);
      }
      lines.push('');

      // Determine the nature of this new round for scheduled tasks
      // Look at the last round's terminal status to decide context
      const lastRoundLogs = logs.filter(l => (l as any).executionRound === (currentExecutionRound - 1));
      const lastRoundTerminal = lastRoundLogs.find(l =>
        l.type === 'status' && ['completed', 'failed', 'cancelled', 'execution_finished'].includes(l.content)
      );
      const lastRoundStatus = lastRoundTerminal?.content;

      if (lastRoundStatus === 'completed' || lastRoundStatus === 'execution_finished') {
        lines.push('**This is a new scheduled run.** The previous round completed successfully.');
        lines.push('You should execute the task fresh with up-to-date information. Reference previous rounds for continuity but do NOT simply repeat them — produce a new, current result.');
      } else if (lastRoundStatus === 'failed') {
        lines.push('**⚠ The previous round FAILED.** This is a new scheduled run, but you should learn from the previous failure.');
        lines.push('Review the error details from the previous round below and use a different approach to avoid the same failure.');
      } else if (lastRoundStatus === 'cancelled') {
        lines.push('**The previous round was cancelled.** This is a new scheduled run.');
        lines.push('Execute the task fresh. The cancellation may have been intentional.');
      } else {
        lines.push('**This is a new scheduled run.** Execute the task and produce current, up-to-date results.');
      }
      lines.push('');
    }

    if (latestRevision) {
      lines.push('### 🔴 REVISION REQUIRED — Your previous work was REJECTED by the reviewer');
      lines.push('');
      lines.push('**Reviewer feedback:**');
      const rawReason = latestRevision.content.replace(/^\*\*Revision Requested[^*]*\*\*\s*/, '');
      lines.push(`> ${rawReason.replace(/\n/g, '\n> ')}`);
      lines.push('');
      lines.push('**You MUST address the reviewer\'s feedback above before doing anything else.**');
      lines.push('Review the previous execution details below to understand what was done, then fix the issues identified by the reviewer.');
      lines.push('');
    } else if (!isScheduledTask && totalRounds > 1) {
      lines.push(`This task has been through ${totalRounds} execution rounds. Below are the task notes and execution details.`);
    } else if (!isScheduledTask) {
      lines.push('This task was previously worked on. Below is the execution context.');
    }
    lines.push('**CRITICAL: Pay close attention to human comments — they contain instructions, feedback, and accumulated knowledge.**');
    lines.push('');

    // Task notes
    if (task?.notes?.length) {
      const recentNotes = task.notes.slice(-20);
      lines.push('### Task Notes (accumulated knowledge)');
      if (task.notes.length > 20) {
        lines.push(`_(showing most recent 20 of ${task.notes.length} notes)_`);
      }
      for (const note of recentNotes) {
        lines.push(`- ${note.slice(0, 800)}`);
      }
      lines.push('');
    }

    // Execution timeline — comments interleaved chronologically
    const MAX_ROUNDS_TO_SHOW = 3;
    const roundsSorted = [...seenRounds].sort((a, b) => a - b);
    const roundsToShow = roundsSorted.length > MAX_ROUNDS_TO_SHOW
      ? roundsSorted.slice(-MAX_ROUNDS_TO_SHOW) : roundsSorted;
    const showFromRound = roundsToShow.length > 0 ? roundsToShow[0]! : 1;

    if (totalRounds > 1 && roundsToShow.length < roundsSorted.length) {
      lines.push(`_(showing last ${roundsToShow.length} of ${totalRounds} execution rounds)_`);
      lines.push('');
    }

    let currentRound = 0;
    let inRound = false;

    for (const item of timeline) {
      // Comments are always shown inline at their chronological position
      if (item.kind === 'comment') {
        const c = item.entry as TaskCommentRow;
        const time = c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt);
        // Only show comments from the rounds we're displaying (or after them)
        if (currentRound >= showFromRound || !inRound) {
          lines.push(`💬 **${c.authorName}** (${time}): ${c.content}`);
          const attachments = (Array.isArray(c.attachments) ? c.attachments : []) as Array<{ type?: string; name?: string; url?: string }>;
          for (const att of attachments) {
            if (att.type === 'image') lines.push(`  [Image: ${att.name ?? 'attachment'}]`);
          }
          lines.push('');
        }
        continue;
      }

      const entry = item.entry as TaskLogRow;
      const entryRound = (entry as any).executionRound ?? 1;

      // Round boundary detection
      if (entry.type === 'status' && (entry.content === 'started' || entry.content === 'resumed')) {
        if (entryRound !== currentRound) {
          if (inRound) lines.push('');
          currentRound = entryRound;
          if (currentRound >= showFromRound) {
            const entryTime = entry.createdAt instanceof Date
              ? entry.createdAt : new Date(entry.createdAt as any);
            const timeStr = formatLocalTimestamp(entryTime);
            if (totalRounds > 1) {
              lines.push(`### Execution Round #${currentRound} (started ${timeStr})`);
            } else {
              lines.push(`### Execution Details (started ${timeStr})`);
            }
          }
        }
        inRound = true;
        if (currentRound >= showFromRound && entry.content === 'resumed') {
          lines.push('[resumed after transient error]');
        }
        continue;
      }

      // Skip entries from older rounds we're not showing
      if (currentRound < showFromRound) continue;

      if (entry.type === 'status') {
        const statusTime = entry.createdAt instanceof Date
          ? entry.createdAt : new Date(entry.createdAt as any);
        const statusTimeStr = formatLocalTimestamp(statusTime);
        if (entry.content === 'execution_finished' || entry.content === 'completed') {
          lines.push(`[execution finished at ${statusTimeStr}]`);
        } else if (entry.content === 'failed' || entry.content === 'cancelled') {
          lines.push(`[${entry.content} at ${statusTimeStr}]`);
        }
        lines.push('');
        continue;
      }

      if (entry.type === 'text') {
        const text = entry.content.length > 800 ? entry.content.slice(0, 800) + '…' : entry.content;
        lines.push(text);
        lines.push('');
      } else if (entry.type === 'tool_start') {
        const meta = entry.metadata as Record<string, unknown> | null;
        const args = meta?.arguments as Record<string, unknown> | undefined;
        const argStr = args ? ` (${JSON.stringify(args)})` : '';
        lines.push(`→ Calling: ${entry.content}${argStr}`);
      } else if (entry.type === 'tool_end') {
        const meta = entry.metadata as Record<string, unknown> | null;
        const ok = meta?.success !== false;
        const result = meta?.result ? ` → ${String(meta.result)}` : '';
        lines.push(`  ${ok ? '✓' : '✗'} ${entry.content}${result}`);
      } else if (entry.type === 'error') {
        lines.push(`[ERROR] ${entry.content}`);
        lines.push('');
      }
    }

    // File access summary
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

    // Error guidance
    const recentErrors = collectedErrors.slice(-10);
    if (recentErrors.length > 0) {
      const guidance = TaskService.analyzeErrorPatterns(recentErrors);
      if (guidance.length > 0) {
        lines.push('### ⚠ Error Guidance — MUST READ');
        lines.push('Based on the errors shown above, you MUST use a different approach to avoid these failures.');
        lines.push('');
        lines.push('**Specific guidance:**');
        for (const g of guidance) lines.push(`- ${g}`);
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

    // Cancel any currently running execution for this task before starting a new one
    const existing = this.taskCancelTokens.get(taskId);
    if (existing) existing.cancelled = true;

    const cancelToken = { cancelled: false };
    this.taskCancelTokens.set(taskId, cancelToken);

    this.updateTaskStatus(taskId, 'in_progress');

    // Load previous execution history + comments so the agent can resume
    let prevContext = '';
    let prevComments: TaskCommentRow[] = [];
    if (this.taskLogRepo) {
      try {
        const prevLogs = await this.taskLogRepo.getByTask(taskId);
        if (this.taskCommentRepo) {
          try { prevComments = await this.taskCommentRepo.getByTask(taskId); } catch { /* ignore */ }
        }
        prevContext = this.formatPreviousExecutionContext(prevLogs, prevComments, task);
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
          lines.push('**Deliverables (review these for background context):**');
          for (const d of depTask.deliverables) {
            const refInfo = d.type === 'file' ? ` — File: \`${d.reference}\` (use \`file_read\` to inspect)` :
                            d.type === 'branch' ? ` [branch: ${d.reference}]` :
                            d.reference ? ` — ref: \`${d.reference}\`` : '';
            lines.push(`- ${d.summary ?? '(no summary)'}${refInfo}`);
          }
        }
        depSections.push(lines.join('\n'));
      }
      if (depSections.length > 0) {
        dependencyContext = [
          '## ⚠ Dependency Tasks — READ THESE FIRST',
          '',
          '**This task depends on the output of the following tasks.** Before you begin any work:',
          '1. Read through each dependency task\'s notes and deliverables below carefully.',
          '2. If deliverables include file paths, use `file_read` to review their full content — these artifacts provide essential background knowledge and context for your current task.',
          '3. Use `task_get` with each dependency task ID to check for any additional details or recent updates not shown here.',
          '4. Only after you have reviewed all dependency outputs should you start working on your own task.',
          '',
          ...depSections,
          '',
          '---',
          '',
        ].join('\n');
      }
    }

    // Build goal ancestry context: show the requirement and project that spawned this task
    let goalContext = '';
    if (task.requirementId && this.requirementService) {
      const req = this.requirementService.getRequirement(task.requirementId);
      if (req) {
        const goalLines: string[] = ['## Goal Context'];
        if (task.projectId && this.projectService) {
          const project = this.projectService.getProject(task.projectId);
          if (project) {
            goalLines.push(`**Project:** ${project.name} — ${project.description.slice(0, 300)}`);
          }
        }
        goalLines.push(`**Requirement:** ${req.title}`);
        if (req.description) {
          goalLines.push(`**Requirement Description:** ${req.description.slice(0, 500)}`);
        }
        goalLines.push('');
        goalLines.push('Keep this goal context in mind. Your task should directly advance this requirement.');
        goalLines.push('', '---', '');
        goalContext = goalLines.join('\n');
      }
    }

    // Include task notes even when there's no previous execution context — keep last 20
    let notesSection = '';
    if (!prevContext && task.notes?.length) {
      const recentNotes = task.notes.slice(-20);
      const noteLines: string[] = ['## Task Notes'];
      if (task.notes.length > 20) {
        noteLines.push(`_(showing most recent 20 of ${task.notes.length} notes)_`);
      }
      noteLines.push(...recentNotes.map(n => `- ${n.slice(0, 800)}`), '', '---', '');
      notesSection = noteLines.join('\n');
    }

    // For first-run scheduled tasks (no prevContext), include schedule awareness
    let scheduleSection = '';
    if (!prevContext && task.taskType === 'scheduled' && task.scheduleConfig) {
      const config = task.scheduleConfig;
      const schedLines: string[] = [
        '## Scheduled Task Info',
        '',
        `**Current time:** ${formatLocalTimestamp(new Date())}`,
        `**Execution round:** #${task.executionRound ?? 1}`,
      ];
      if (config.every) schedLines.push(`**Schedule:** Every ${config.every}`);
      else if (config.cron) schedLines.push(`**Schedule:** Cron \`${config.cron}\``);
      if (config.timezone) schedLines.push(`**Timezone:** ${config.timezone}`);
      schedLines.push(`**Run #:** ${config.currentRuns ?? 1}`);
      schedLines.push('', 'This task runs on a recurring schedule. Produce fresh, up-to-date results for each run.', '', '---', '');
      scheduleSection = schedLines.join('\n');
    }

    // Add explicit retry notice so agent knows to continue, not restart
    let retryNotice = '';
    if (_retryAttempt > 0 && prevContext) {
      retryNotice = [
        '## ⚠ RETRY — CONTINUE FROM WHERE YOU LEFT OFF',
        '',
        `**Current time:** ${formatLocalTimestamp(new Date())}`,
        `**Retry attempt:** ${_retryAttempt + 1}`,
        '',
        'Your previous attempt was interrupted by a transient error (network issue, timeout, etc.).',
        '**You MUST NOT start over.** Review the execution details below and continue from where you stopped.',
        '- Do NOT re-read files you already read in the previous attempt',
        '- Do NOT redo work that was already completed',
        '- Pick up exactly where the previous attempt was interrupted',
        '',
        '---',
        '',
      ].join('\n');
    }

    // Include existing subtasks so the agent knows what was already decomposed
    let subtaskSection = '';
    if (task.subtasks.length > 0) {
      const done = task.subtasks.filter(s => s.status === 'completed').length;
      const subLines: string[] = [
        '## Subtasks',
        `Progress: ${done}/${task.subtasks.length} completed`,
        '',
      ];
      for (const sub of task.subtasks) {
        const check = sub.status === 'completed' ? '✓' : sub.status === 'cancelled' ? '✗' : '☐';
        subLines.push(`- ${check} **${sub.title}** (subtask_id: \`${sub.id}\`, status: ${sub.status})`);
      }
      subLines.push('', 'Use `subtask_complete` with `task_id` + `subtask_id` to mark pending subtasks done. Do NOT use `task_update` for subtasks.', '', '---', '');
      subtaskSection = subLines.join('\n');
    }

    const taskDescription = prevContext
      ? `${retryNotice}${prevContext}${goalContext}${dependencyContext}${subtaskSection}${task.title}\n\n${task.description}`
      : `${scheduleSection}${notesSection}${goalContext}${dependencyContext}${subtaskSection}${task.title}\n\n${task.description}`;

    // Workspace management is delegated to the agent — the agent creates and
    // manages its own worktree/branch during execution. Task-service only
    // passes project context so the agent knows which repo to work in.
    let taskWorkspace: TaskWorkspace | undefined;
    if (task.projectId) {
      const project = this.projectService?.getProject(task.projectId);
      const repo = project?.repositories?.find(r => r.role === 'primary' && r.localPath) ?? project?.repositories?.find(r => r.localPath);
      if (repo?.localPath) {
        taskWorkspace = {
          worktreePath: repo.localPath,
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
      }
    }

    const agentId = task.assignedAgentId;
    const taskLogRepo = this.taskLogRepo;
    const ws = this.ws;
    const executionRound = task.executionRound ?? 1;
    const isRetry = _retryAttempt > 0;

    // Ensure the task row exists in DB before writing any child rows (task_logs).
    // createTask() fire-and-forgets the DB insert which can silently fail (e.g. FK
    // on assignedAgentId), leaving logs unable to reference the task.
    if (this.taskRepo) {
      try {
        await this.taskRepo.ensureExists({
          id: task.id,
          orgId: task.orgId,
          title: task.title,
          description: task.description,
          priority: task.priority,
          status: task.status,
          assignedAgentId: task.assignedAgentId,
          reviewerAgentId: task.reviewerAgentId,
          executionRound: task.executionRound,
          requirementId: task.requirementId,
          projectId: task.projectId,
          createdBy: task.createdBy,
          blockedBy: task.blockedBy,
          dueAt: task.dueAt ? new Date(task.dueAt) : undefined,
          taskType: task.taskType,
          scheduleConfig: task.scheduleConfig as Record<string, unknown> | undefined,
          subtasks: task.subtasks,
        });
      } catch (err) {
        log.warn('Failed to ensure task exists in DB before execution', { taskId, error: String(err) });
      }
    }

    // Continuous seq: load max seq from existing logs to avoid collisions across retries
    let seq = 0;
    if (this.executionStreamRepo) {
      try {
        const maxSeq = (this.executionStreamRepo as any).getMaxSeq('task', taskId);
        if (typeof maxSeq === 'number' && maxSeq >= 0) seq = maxSeq + 1;
      } catch { /* fall through */ }
    }
    if (seq === 0 && taskLogRepo) {
      try {
        const maxSeq = await taskLogRepo.getMaxSeq(taskId);
        seq = maxSeq + 1;
      } catch { /* start from 0 on error */ }
    }

    // On retry, the agent session already has the full taskPrompt (which includes
    // prevContext with comments). Only a short "continue" message is appended, so
    // NEW comments posted between attempts would be missed. Inject them here.
    // On fresh execution, comments are already in prevContext — skip to avoid duplication.
    if (isRetry && prevComments.length > 0) {
      const humanComments = prevComments.filter(c =>
        c.authorType === 'human' || c.authorType === 'owner'
      );
      if (humanComments.length > 0) {
        const sessionId = `task_${taskId}_r${executionRound}`;
        const recentFeedback = humanComments.slice(-3);
        const feedbackLines = recentFeedback.map(c => {
          const ts = c.createdAt instanceof Date
            ? c.createdAt.toISOString().slice(0, 19).replace('T', ' ')
            : String(c.createdAt);
          return `**${c.authorName}** (${ts}):\n${c.content}`;
        });
        agent.injectUserMessage(sessionId, [
          '⚠ **USER FEEDBACK — YOU MUST ADDRESS THIS BEFORE CONTINUING:**',
          '',
          ...feedbackLines,
          '',
          'Read the feedback above carefully. Adjust your approach and work based on this feedback.',
        ].join('\n'));
      }
    }

    // Fire and forget — runs concurrently
    void agent
      .executeTask(
        taskId,
        taskDescription,
        async entry => {
          // On retry, rewrite 'started' to 'resumed' so UI doesn't create new round
          if (isRetry && entry.type === 'status' && entry.content === 'started') {
            entry = { ...entry, content: 'resumed' };
          }
          // Broadcast real-time delta via WS (not persisted)
          if (!entry.persist) {
            const ts = new Date().toISOString();
            ws?.broadcast({
              type: 'execution:log:delta',
              payload: { sourceType: 'task', sourceId: taskId, agentId, text: entry.content },
              timestamp: ts,
            });
            ws?.broadcast({
              type: 'task:log:delta',
              payload: { taskId, agentId, text: entry.content },
              timestamp: ts,
            });
            return;
          }

          // Persist structured log entries to DB
          const currentSeq = seq++;
          const createdAt = new Date().toISOString();
          const logEntry = {
            taskId,
            agentId,
            seq: currentSeq,
            type: entry.type as TaskLogType,
            content: entry.content,
            metadata: entry.metadata,
            executionRound,
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
          if (this.executionStreamRepo) {
            try {
              this.executionStreamRepo.append({ sourceType: 'task', sourceId: taskId, agentId, seq: currentSeq, type: entry.type, content: entry.content, metadata: entry.metadata, executionRound });
            } catch (err) {
              log.warn('Failed to persist execution stream log', { taskId, error: String(err) });
            }
          }

          // Broadcast unified execution:log event
          ws?.broadcast({
            type: 'execution:log',
            payload: {
              id: savedId, sourceType: 'task', sourceId: taskId,
              agentId, seq: currentSeq, type: entry.type,
              content: entry.content, metadata: entry.metadata,
              executionRound, createdAt,
            },
            timestamp: createdAt,
          });
          // Legacy event for backward compat
          ws?.broadcast({
            type: 'task:log',
            payload: {
              taskId, agentId, id: savedId, seq: currentSeq,
              logType: entry.type, content: entry.content,
              metadata: entry.metadata, executionRound, createdAt,
            },
            timestamp: createdAt,
          });

          // Handle task completion/failure from log events
          if (entry.type === 'status') {
            if (entry.content === 'completed' || entry.content === 'execution_finished') {
              const currentTask = this.tasks.get(taskId);
              const alreadyTerminal = currentTask && ['review', 'completed', 'failed', 'cancelled', 'archived'].includes(currentTask.status);
              // Only task_submit_review (→ submitForReview) can transition to review.
              // If execution finished but agent didn't submit, auto-retry so the agent
              // gets another chance to call task_submit_review.
              if (!alreadyTerminal && currentTask && currentTask.status === 'in_progress') {
                const nextAttempt = _retryAttempt + 1;
                if (nextAttempt < TaskService.MAX_IN_PROGRESS_RETRIES) {
                  const delayMs = TaskService.RETRY_DELAYS_MS[Math.min(_retryAttempt, TaskService.RETRY_DELAYS_MS.length - 1)] ?? 300_000;
                  log.warn(`Task execution finished without task_submit_review — auto-retrying in ${delayMs / 1000}s (attempt ${nextAttempt})`, { taskId });
                  this.addTaskNote(taskId,
                    `[System] Execution finished but agent did not call task_submit_review. Auto-retrying (attempt ${nextAttempt}).`,
                    'system'
                  );
                  setTimeout(() => {
                    const current = this.tasks.get(taskId);
                    if (!current || current.status !== 'in_progress') return;
                    this.runTask(taskId, nextAttempt).catch(e =>
                      log.error('No-submit retry invocation failed', { taskId, error: String(e) })
                    );
                  }, delayMs);
                } else {
                  log.error(`Task execution finished without task_submit_review after ${nextAttempt} attempts — marking failed`, { taskId });
                  this.addTaskNote(taskId,
                    `[System] Execution finished without task_submit_review after ${nextAttempt} attempts. Task marked as failed.`,
                    'system'
                  );
                  this.taskRetryErrors.delete(taskId);
                  this.updateTaskStatus(taskId, 'failed');
                }
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
            } else if (entry.content === 'started' || entry.content === 'resumed') {
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
            const nextAttempt = _retryAttempt + 1;
            const retryDecision = this.shouldRetryTask(taskId, entry.content, _retryAttempt, cancelToken.cancelled);
            if (retryDecision.shouldRetry) {
              const delayMs = TaskService.RETRY_DELAYS_MS[Math.min(_retryAttempt, TaskService.RETRY_DELAYS_MS.length - 1)] ?? 300_000;
              const retryMsg = `Attempt ${nextAttempt} failed. Retrying in ${delayMs / 1000}s… (${retryDecision.reason})`;
              log.warn(retryMsg, { taskId, attempt: nextAttempt, error: entry.content });
              const noticeSeq = seq++;
              const noticeEntry = {
                taskId,
                agentId,
                seq: noticeSeq,
                type: 'error' as TaskLogType,
                content: retryMsg,
                executionRound,
              };
              taskLogRepo?.append(noticeEntry).catch(() => {});
              if (this.executionStreamRepo) {
                try { this.executionStreamRepo.append({ sourceType: 'task', sourceId: taskId, agentId, seq: noticeSeq, type: 'error', content: retryMsg, executionRound }); } catch { /* best effort */ }
              }
              ws?.broadcast({
                type: 'task:log',
                payload: {
                  taskId,
                  agentId,
                  logType: 'error',
                  content: retryMsg,
                  executionRound,
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
              const failMsg = `Task failed after ${nextAttempt} attempts: ${retryDecision.reason}`;
              log.error(failMsg, { taskId });
              this.taskRetryErrors.delete(taskId);
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
        taskWorkspace,
        executionRound
      )
      .catch(err => {
        log.error('Task execution promise rejected', { taskId, error: String(err) });
        if (!cancelToken.cancelled) {
          const retryDecision = this.shouldRetryTask(taskId, String(err), _retryAttempt, false);
          if (retryDecision.shouldRetry) {
            const delayMs = TaskService.RETRY_DELAYS_MS[Math.min(_retryAttempt, TaskService.RETRY_DELAYS_MS.length - 1)] ?? 300_000;
            const nextAttempt = _retryAttempt + 1;
            log.warn(`Retrying task in ${delayMs / 1000}s (attempt ${nextAttempt}, ${retryDecision.reason})`, { taskId });
            setTimeout(() => {
              const current = this.tasks.get(taskId);
              if (!current || current.status !== 'in_progress') return;
              this.runTask(taskId, nextAttempt).catch(e =>
                log.error('Retry invocation failed', { taskId, error: String(e) })
              );
            }, delayMs);
          } else {
            log.error(`Task failed permanently: ${retryDecision.reason}`, { taskId });
            this.taskRetryErrors.delete(taskId);
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
        const rawSubtasks = (row as any).subtasks;
        const subtasks: SubTask[] = Array.isArray(rawSubtasks) ? rawSubtasks as SubTask[] : [];
        const migrateStatus = (s: string): TaskStatus => {
          const map: Record<string, TaskStatus> = {
            pending_approval: 'pending',
            assigned: 'in_progress',
            revision: 'in_progress',
            accepted: 'completed',
          };
          return (map[s] ?? s) as TaskStatus;
        };
        const migrated = migrateStatus(row.status);
        const needsMigration = migrated !== row.status;
        const task: Task = {
          id: row.id,
          orgId: row.orgId,
          title: row.title,
          description: row.description ?? '',
          status: migrated,
          priority: (row.priority ?? 'medium') as TaskPriority,
          executionMode: (row.executionMode as Task['executionMode']) ?? undefined,
          assignedAgentId: row.assignedAgentId ?? (row as any).assigned_agent_id ?? '',
          reviewerAgentId: (row as any).reviewerAgentId ?? (row as any).reviewer_agent_id ?? '',
          executionRound: (row as any).executionRound ?? (row as any).execution_round ?? 1,
          requirementId: (row as any).requirementId ?? undefined,
          subtasks,
          blockedBy,
          result: (row.result as Task['result']) ?? undefined,
          deliverables: Array.isArray((row as any).deliverables) ? ((row as any).deliverables as Task['deliverables']) : undefined,
          notes: Array.isArray(row.notes) ? (row.notes as string[]) : undefined,
          createdAt:
            row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
          updatedAt:
            row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
          projectId: row.projectId ?? undefined,
          createdBy: (row as any).createdBy ?? undefined,
          updatedBy: (row as any).updatedBy ?? undefined,
          startedAt: toIso((row as any).startedAt),
          completedAt: toIso((row as any).completedAt),
          dueAt: toIso(row.dueAt),
          taskType: ((row as any).taskType ?? (row as any).task_type ?? 'standard') as Task['taskType'],
          scheduleConfig: ((row as any).scheduleConfig ?? (row as any).schedule_config ?? undefined) as Task['scheduleConfig'],
        };
        this.tasks.set(task.id, task);
        if (needsMigration && this.taskRepo) {
          this.taskRepo.updateStatus(task.id, migrated)
            .catch(err => log.warn('Failed to persist migrated status', { taskId: task.id, from: row.status, to: migrated, error: String(err) }));
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
   */
  async resumeInProgressTasks(): Promise<void> {
    const inProgressTasks = [...this.tasks.values()].filter(t => t.status === 'in_progress');
    if (inProgressTasks.length === 0) return;

    log.info(`Resuming ${inProgressTasks.length} in_progress task(s) after restart`);

    for (const task of inProgressTasks) {
      try {
        await this.runTask(task.id);
        log.info(`Resumed task execution after restart`, { taskId: task.id, title: task.title });
      } catch (err) {
        log.warn(`Failed to resume task on startup`, {
          taskId: task.id,
          title: task.title,
          error: String(err),
        });
        this.updateTaskStatus(task.id, 'failed');
      }
    }
  }

  createTask(request: CreateTaskRequest): Task {
    // ── Validate assignedAgentId / reviewerAgentId exist ──
    if (!request.assignedAgentId) {
      throw new Error('Task creation failed: assignedAgentId is required');
    }
    if (!request.reviewerAgentId) {
      throw new Error('Task creation failed: reviewerAgentId is required');
    }
    if (this.agentManager) {
      if (!this.agentManager.hasAgent(request.assignedAgentId)) {
        throw new Error(`Task creation failed: assigned agent not found: ${request.assignedAgentId}`);
      }
      if (!this.agentManager.hasAgent(request.reviewerAgentId)) {
        throw new Error(`Task creation failed: reviewer agent not found: ${request.reviewerAgentId}`);
      }
    }

    // ── Governance: check task limits ──
    const limitCheck = this.checkTaskLimits(request);
    if (!limitCheck.allowed) {
      throw new Error(`Task creation blocked by governance: ${limitCheck.reason}`);
    }

    // ── Governance: enforce requirement linkage for top-level tasks ──
    if (this.governancePolicy?.requireRequirement) {
      if (!request.requirementId) {
        throw new Error(
          'Task creation blocked: top-level tasks must reference an approved requirement (requirementId). ' +
          'Use requirement_propose to suggest work, then create tasks after user approval.'
        );
      }
    }

    // ── Auto-inherit projectId from the linked requirement ──
    if (request.requirementId && this.requirementService) {
      const req = this.requirementService.getRequirement(request.requirementId);
      if (req) {
        if (!request.projectId && req.projectId) {
          request.projectId = req.projectId;
        }
      }
    }

    const scheduleConfig = request.scheduleConfig
      ? { ...request.scheduleConfig, currentRuns: 0, nextRunAt: computeInitialNextRun(request.scheduleConfig) }
      : undefined;

    const task: Task = {
      id: taskId(),
      orgId: request.orgId,
      title: request.title,
      description: request.description,
      status: 'pending',
      priority: request.priority ?? 'medium',
      assignedAgentId: request.assignedAgentId,
      reviewerAgentId: request.reviewerAgentId,
      executionRound: 1,
      requirementId: request.requirementId,
      subtasks: [],
      blockedBy: request.blockedBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dueAt: request.dueAt,
      timeoutMs: request.timeoutMs,
      projectId: request.projectId,
      createdBy: request.createdBy,
      approvedVia: undefined,
      planReportId: request.planReportId,
      taskType: request.taskType ?? 'standard',
      scheduleConfig,
    };

    this.tasks.set(task.id, task);

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
          reviewerAgentId: task.reviewerAgentId,
          executionRound: task.executionRound,
          requirementId: task.requirementId,
          projectId: task.projectId,
          createdBy: task.createdBy,
          blockedBy: task.blockedBy,
          dueAt: task.dueAt ? new Date(task.dueAt) : undefined,
          taskType: task.taskType,
          scheduleConfig: task.scheduleConfig as Record<string, unknown> | undefined,
        })
        .catch(err => log.warn('Failed to persist task to DB', { error: String(err) }));
    }

    // ── Link task to its requirement (auto-transitions approved → in_progress) ──
    if (task.requirementId && this.requirementService) {
      this.requirementService.linkTask(task.requirementId, task.id);
    }

    this.ws?.broadcastTaskUpdate(task.id, task.status, { title: task.title, assignedAgentId: task.assignedAgentId });
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
      assignedTo: task.assignedAgentId,
      reviewer: task.reviewerAgentId,
    });

    // Request HITL approval
    if (this.hitlService) {
      const creatorName = request.createdBy ?? 'unknown agent';
      this.hitlService.requestApprovalAndWait({
        agentId: request.createdBy ?? 'system',
        agentName: creatorName,
        type: 'custom',
        title: `Task approval: ${task.title}`,
        description: `Agent "${creatorName}" wants to create task "${task.title}" (priority: ${task.priority}).`,
        details: { taskId: task.id, priority: task.priority },
      }).then(approved => {
        const current = this.tasks.get(task.id);
        if (!current || current.status !== 'pending') return;
        if (approved) {
          this.approveTask(task.id);
        } else {
          this.rejectTask(task.id);
        }
      }).catch(err => {
        log.error('HITL approval flow error, auto-rejecting task', { taskId: task.id, error: String(err) });
        const current = this.tasks.get(task.id);
        if (current?.status === 'pending') {
          this.rejectTask(task.id);
        }
      });
    }

    return task;
  }

  /** Approve a pending task and transition it to normal flow.
   * Uses the task's current assignedAgentId (the human reviewer may have changed it).
   * Optionally resolves the associated HITL promise to prevent double-fire. */
  approveTask(taskIdStr: string): Task {
    const task = this.tasks.get(taskIdStr);
    if (!task) throw new Error(`Task not found: ${taskIdStr}`);
    if (task.status !== 'pending') {
      throw new Error(`Task ${taskIdStr} is in ${task.status} status, cannot approve`);
    }

    if (this.hitlService) {
      const pending = this.hitlService.listApprovals('pending');
      const hitl = pending.find(a => (a.details as Record<string, unknown>)?.['taskId'] === taskIdStr);
      if (hitl) this.hitlService.respondToApproval(hitl.id, true, 'direct');
    }

    task.approvedVia = 'human';
    const hasBlockers = task.blockedBy && task.blockedBy.length > 0 && !this.areBlockersSatisfied(task);
    const targetStatus: TaskStatus = hasBlockers ? 'blocked' : 'in_progress';
    return this.updateTaskStatus(taskIdStr, targetStatus, undefined, true);
  }

  rejectTask(taskIdStr: string): Task {
    const task = this.tasks.get(taskIdStr);
    if (!task) throw new Error(`Task not found: ${taskIdStr}`);
    if (task.status !== 'pending') {
      throw new Error(`Task ${taskIdStr} is in ${task.status} status, cannot reject`);
    }

    if (this.hitlService) {
      const pending = this.hitlService.listApprovals('pending');
      const hitl = pending.find(a => (a.details as Record<string, unknown>)?.['taskId'] === taskIdStr);
      if (hitl) this.hitlService.respondToApproval(hitl.id, false, 'direct');
    }

    return this.updateTaskStatus(taskIdStr, 'rejected', undefined, true);
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /**
   * THE single entry point for all task status transitions.
   * All side effects (auto-start, cancel execution, notify reviewer,
   * check dependents, broadcast) are centralized here.
   *
   * @param _internal - bypass the pending guard (used by approve/reject)
   * @param _skipAutoStart - suppress auto-start when entering in_progress
   *                         (used by retryTaskFresh which starts runTaskFresh instead)
   */
  private static readonly VALID_STATUSES: ReadonlySet<string> = new Set([
    'pending', 'in_progress', 'blocked', 'review', 'completed', 'failed', 'rejected', 'cancelled', 'archived',
  ]);

  updateTaskStatus(id: string, status: TaskStatus, updatedBy?: string, _internal = false, _skipAutoStart = false): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    // Guard: reject invalid status values (e.g. LLM hallucinated "accepted")
    if (!TaskService.VALID_STATUSES.has(status)) {
      throw new Error(`Invalid task status "${status}". Valid values: ${[...TaskService.VALID_STATUSES].join(', ')}`);
    }

    // Guard: pending can only be changed via approveTask/rejectTask
    if (!_internal && task.status === 'pending' && status !== 'pending') {
      throw new Error(`Task ${id} is pending approval. Use the approve or reject endpoint.`);
    }

    // Guard: completed only from review
    if (status === 'completed' && task.status !== 'review') {
      throw new Error(`Task ${id} cannot be completed from "${task.status}". Must go through review first.`);
    }

    // Guard: blocked → in_progress requires all blockers satisfied
    if (status === 'in_progress' && task.status === 'blocked') {
      if (!this.areBlockersSatisfied(task)) {
        throw new Error(`Task ${id} is blocked by unfinished dependencies`);
      }
    }

    const prevStatus = task.status;
    if (prevStatus === status) return task;

    const now = new Date().toISOString();
    task.status = status;
    task.updatedAt = now;
    if (updatedBy) task.updatedBy = updatedBy;

    // ── Entering in_progress ──
    if (status === 'in_progress' && !task.startedAt) {
      task.startedAt = now;
    }

    // ── Entering terminal state ──
    if (status === 'completed' || status === 'failed' || status === 'rejected' || status === 'cancelled' || status === 'archived') {
      if (!task.completedAt) task.completedAt = now;
    }

    // ── Leaving in_progress: cancel running execution ──
    if (prevStatus === 'in_progress' && status !== 'in_progress') {
      this.taskRetryErrors.delete(id);
      const token = this.taskCancelTokens.get(id);
      if (token) {
        token.cancelled = true;
        this.taskCancelTokens.delete(id);
        log.info(`Cancelled running execution for task ${id} (status → ${status})`);
      }
    }

    // ── Leaving review: clear active review guard ──
    if (prevStatus === 'review' && status !== 'review') {
      this.activeReviews.delete(id);
    }

    // ── Persist to DB ──
    if (this.taskRepo) {
      this.taskRepo
        .updateStatus(id, status, updatedBy)
        .catch(err => log.warn('Failed to persist task status to DB', { error: String(err) }));
    }

    // ── Side effect: auto-start execution when entering in_progress ──
    if (
      !_skipAutoStart &&
      status === 'in_progress' &&
      prevStatus !== 'in_progress' &&
      task.assignedAgentId &&
      this.agentManager
    ) {
      const activeToken = this.taskCancelTokens.get(id);
      if (!activeToken || activeToken.cancelled) {
        log.info(`Auto-starting task execution`, { taskId: id });
        setImmediate(() => {
          this.runTask(id).catch(err =>
            log.warn('Auto-start runTask failed', { taskId: id, error: String(err) })
          );
        });
      }
    }

    // ── Side effect: notify reviewer when entering review ──
    if (status === 'review' && prevStatus !== 'review' && task.reviewerAgentId) {
      this.notifyReviewer(task, task.reviewerAgentId);
    }

    // ── Side effect: check dependent tasks on terminal ──
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'archived') {
      this.checkDependentTasks(task);

      // Check if the linked requirement is now fully completed
      if (task.requirementId && this.requirementService) {
        const taskStatuses = new Map<string, string>();
        for (const [tid, t] of this.tasks) {
          taskStatuses.set(tid, t.status);
        }
        this.requirementService.checkCompletion(task.requirementId, taskStatuses);
      }
    }

    // ── Broadcast + events ──
    this.ws?.broadcastTaskUpdate(id, status, { title: task.title });
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

    log.info(`Task status updated: ${task.title}`, { id, status, prevStatus });
    return task;
  }

  cancelTask(id: string, cascade: boolean, updatedBy?: string): Task {
    const task = this.updateTaskStatus(id, 'cancelled', updatedBy);
    if (cascade) {
      this.cascadeCancelDependents(task);
    }
    return task;
  }

  getDependentTaskCount(id: string): number {
    let count = 0;
    const visited = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [, task] of this.tasks) {
        if (task.status !== 'blocked' || !task.blockedBy?.includes(current)) continue;
        if (visited.has(task.id)) continue;
        visited.add(task.id);
        count++;
        queue.push(task.id);
      }
    }
    return count;
  }

  assignTask(id: string, agentId: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.assignedAgentId = agentId;
    task.updatedAt = new Date().toISOString();

    if (this.taskRepo) {
      this.taskRepo.assign(id, agentId)
        .catch(err => log.warn('Failed to persist task assignment to DB', { error: String(err) }));
    }

    this.ws?.broadcastTaskUpdate(id, task.status, { title: task.title, assignedAgentId: agentId });
    log.info(`Task assigned`, { taskId: id, agentId });
    return task;
  }

  addTaskNote(id: string, note: string, author?: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const now = new Date();
    if (!task.notes) task.notes = [];
    const authorTag = author ? ` by ${author}` : '';
    task.notes.push(`[${formatLocalTimestamp(now)}${authorTag}] ${note}`);
    task.updatedAt = now.toISOString();

    if (this.taskRepo) {
      this.taskRepo
        .update(id, { notes: task.notes })
        .catch(err => log.warn('Failed to persist task note to DB', { error: String(err) }));
    }

    log.info(`Task note added`, { taskId: id, author, note: note.slice(0, 80) });
  }

  listTasks(filters?: {
    orgId?: string;
    status?: TaskStatus;
    assignedAgentId?: string;
    priority?: TaskPriority;
    projectId?: string;
    requirementId?: string;
  }): Task[] {
    let result = [...this.tasks.values()];
    if (filters?.orgId) result = result.filter(t => t.orgId === filters.orgId);
    if (filters?.status) result = result.filter(t => t.status === filters.status);
    if (filters?.assignedAgentId)
      result = result.filter(t => t.assignedAgentId === filters.assignedAgentId);
    if (filters?.priority) result = result.filter(t => t.priority === filters.priority);
    if (filters?.projectId) result = result.filter(t => t.projectId === filters.projectId);
    if (filters?.requirementId) result = result.filter(t => t.requirementId === filters.requirementId);
    return result;
  }

  queryTasks(opts?: TaskQueryOptions): TaskQueryResult {
    let result = [...this.tasks.values()];

    // ── Filters ──
    if (opts?.orgId) result = result.filter(t => t.orgId === opts.orgId);
    if (opts?.status) result = result.filter(t => t.status === opts.status);
    if (opts?.assignedAgentId) result = result.filter(t => t.assignedAgentId === opts.assignedAgentId);
    if (opts?.priority) result = result.filter(t => t.priority === opts.priority);
    if (opts?.projectId) result = result.filter(t => t.projectId === opts.projectId);
    if (opts?.requirementId) result = result.filter(t => t.requirementId === opts.requirementId);

    // ── Search (case-insensitive substring match on title + description) ──
    if (opts?.search) {
      const q = opts.search.toLowerCase();
      result = result.filter(
        t => t.title?.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q),
      );
    }

    const total = result.length;

    // ── Sort ──
    const sortBy: TaskSortField = opts?.sortBy ?? 'updatedAt';
    const sortOrder = opts?.sortOrder ?? 'desc';
    const priorityRank: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    const statusRank: Record<string, number> = {
      in_progress: 0, blocked: 1, review: 2, pending: 3,
      completed: 4, failed: 5, rejected: 6, cancelled: 7, archived: 8,
    };

    result.sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'priority':
          cmp = (priorityRank[a.priority] ?? 99) - (priorityRank[b.priority] ?? 99);
          break;
        case 'status':
          cmp = (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99);
          break;
        case 'title':
          cmp = a.title.localeCompare(b.title);
          break;
        case 'createdAt':
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case 'updatedAt':
        default:
          cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          break;
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });

    // ── Pagination ──
    const pageSize = Math.min(Math.max(opts?.pageSize ?? 20, 1), 100);
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const page = Math.min(Math.max(opts?.page ?? 1, 1), totalPages);
    const start = (page - 1) * pageSize;
    const paged = result.slice(start, start + pageSize);

    return { tasks: paged, total, page, pageSize, totalPages };
  }

  getTasksByAgent(agentId: string): Task[] {
    return [...this.tasks.values()].filter(t => t.assignedAgentId === agentId);
  }

  getTaskBoard(orgId: string, filters?: { projectId?: string }): Record<TaskStatus, Task[]> {
    const board: Record<TaskStatus, Task[]> = {
      pending: [],
      in_progress: [],
      blocked: [],
      review: [],
      completed: [],
      failed: [],
      rejected: [],
      cancelled: [],
      archived: [],
    };

    for (const task of this.tasks.values()) {
      if (task.orgId !== orgId) continue;
      if (filters?.projectId && task.projectId !== filters.projectId) continue;
      const bucket = board[task.status];
      if (bucket) {
        bucket.push(task);
      } else {
        (board.pending as Task[]).push(task);
      }
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
      in_progress: 0,
      blocked: 0,
      review: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
      cancelled: 0,
      archived: 0,
    };
    for (const t of tasks) statusCounts[t.status]++;

    const agentMap = new Map<string, { active: number; completed: number }>();
    for (const t of tasks) {
      if (!t.assignedAgentId) continue;
      const entry = agentMap.get(t.assignedAgentId) ?? { active: 0, completed: 0 };
      if (t.status === 'in_progress') entry.active++;
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
    data: { title?: string; description?: string; priority?: TaskPriority; projectId?: string | null; requirementId?: string | null; blockedBy?: string[]; reviewerAgentId?: string },
    updatedBy?: string
  ): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (data.title !== undefined) task.title = data.title;
    if (data.description !== undefined) task.description = data.description;
    if (data.priority !== undefined) task.priority = data.priority;
    if (data.projectId !== undefined) task.projectId = data.projectId ?? undefined;
    if (data.requirementId !== undefined) task.requirementId = data.requirementId ?? undefined;
    if (data.reviewerAgentId !== undefined) task.reviewerAgentId = data.reviewerAgentId;

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
      const persistData = updatedBy ? { ...rest, updatedBy } : rest;
      if (Object.keys(persistData).length > 0) {
        this.taskRepo
          .update(id, persistData)
          .catch(err => log.warn('Failed to persist task update to DB', { error: String(err) }));
      }
    }

    this.ws?.broadcastTaskUpdate(id, task.status, { title: task.title });

    return task;
  }

  private reevaluateBlockedStatus(task: Task): void {
    const shouldBeBlocked = task.blockedBy?.length && !this.areBlockersSatisfied(task);
    if (task.status === 'blocked' && !shouldBeBlocked) {
      this.updateTaskStatus(task.id, 'in_progress', undefined, true);
    } else if (task.status === 'in_progress' && shouldBeBlocked) {
      this.updateTaskStatus(task.id, 'blocked', undefined, true);
    }
  }

  /** Tasks cannot be deleted — use cancel instead to preserve audit trail. */

  // ── Subtask operations (embedded within a task) ─────────────────────────────

  private subtaskId(): string {
    return `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  addSubtask(taskId: string, title: string): SubTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const sub: SubTask = {
      id: this.subtaskId(),
      title,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    task.subtasks.push(sub);
    task.updatedAt = new Date().toISOString();
    this.persistSubtasks(task);
    this.ws?.broadcastTaskUpdate(taskId, task.status, { title: task.title });
    return sub;
  }

  completeSubtask(taskId: string, subtaskId: string): SubTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const sub = task.subtasks.find(s => s.id === subtaskId);
    if (!sub) throw new Error(`Subtask not found: ${subtaskId}`);
    sub.status = 'completed';
    sub.completedAt = new Date().toISOString();
    task.updatedAt = new Date().toISOString();
    this.persistSubtasks(task);
    this.ws?.broadcastTaskUpdate(taskId, task.status, { title: task.title });
    return sub;
  }

  cancelSubtask(taskId: string, subtaskId: string): SubTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const sub = task.subtasks.find(s => s.id === subtaskId);
    if (!sub) throw new Error(`Subtask not found: ${subtaskId}`);
    sub.status = 'cancelled';
    sub.completedAt = new Date().toISOString();
    task.updatedAt = new Date().toISOString();
    this.persistSubtasks(task);
    this.ws?.broadcastTaskUpdate(taskId, task.status, { title: task.title });
    return sub;
  }

  deleteSubtask(taskId: string, subtaskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    task.subtasks = task.subtasks.filter(s => s.id !== subtaskId);
    task.updatedAt = new Date().toISOString();
    this.persistSubtasks(task);
    this.ws?.broadcastTaskUpdate(taskId, task.status, { title: task.title });
  }

  private persistSubtasks(task: Task): void {
    if (this.taskRepo) {
      (this.taskRepo as any).updateSubtasks?.(task.id, task.subtasks)
        ?.catch?.((err: Error) => log.warn('Failed to persist subtasks to DB', { taskId: task.id, error: String(err) }));
    }
  }

  /**
   * When a task reaches a terminal state (completed / failed / cancelled),
   * check blocked dependents and unblock any whose blockers are all resolved.
   */
  private checkDependentTasks(finishedTask: Task): void {
    for (const [, task] of this.tasks) {
      if (task.status !== 'blocked' || !task.blockedBy?.length) continue;
      if (!task.blockedBy.includes(finishedTask.id)) continue;

      if (this.areBlockersSatisfied(task)) {
        log.info(`Unblocking task ${task.id} (dependency ${finishedTask.id} resolved)`);
        this.updateTaskStatus(task.id, 'in_progress', undefined, true);
      }
    }
  }

  /**
   * Cascade-cancel all blocked dependents of a cancelled task, recursively.
   */
  private cascadeCancelDependents(cancelledTask: Task): void {
    for (const [, task] of this.tasks) {
      if (task.status !== 'blocked' || !task.blockedBy?.length) continue;
      if (!task.blockedBy.includes(cancelledTask.id)) continue;

      log.info(`Cascade-cancelling task ${task.id} (dependency ${cancelledTask.id} was cancelled)`);
      task.notes = [...(task.notes ?? []), `Auto-cancelled: dependency "${cancelledTask.title}" (${cancelledTask.id}) was cancelled`];
      if (this.taskRepo) {
        this.taskRepo.update(task.id, { notes: task.notes })
          .catch(err => log.warn('Failed to persist cascade-cancel notes', { error: String(err) }));
      }
      this.updateTaskStatus(task.id, 'cancelled', undefined, true);
      this.cascadeCancelDependents(task);
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
    maxTotalActiveTasks: 0,
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

  async submitForReview(taskId: string, deliverables: TaskDeliverable[], reviewerAgentId?: string): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'in_progress') {
      throw new Error(`Task ${taskId} is in ${task.status} status, cannot submit for review`);
    }

    // Run automated review checks if ReviewService is available
    let reviewReport: ReviewReport | undefined;
    if (this.reviewService) {
      try {
        let repoPath: string | undefined;
        let baseBranch: string | undefined;
        if (task.projectId) {
          const project = this.projectService?.getProject(task.projectId);
          const repo = project?.repositories?.find(r => r.role === 'primary' && r.localPath) ?? project?.repositories?.find(r => r.localPath);
          if (repo?.localPath) {
            repoPath = repo.localPath;
            baseBranch = repo.defaultBranch;
          }
        }

        reviewReport = await this.reviewService.runReview({
          taskId: task.id,
          agentId: task.assignedAgentId,
          description: deliverables.map(d => d.summary ?? '').join('\n'),
          worktreePath: repoPath,
          baseBranch,
        });

        log.info('Automated review completed for task submission', {
          taskId, overallStatus: reviewReport.overallStatus, summary: reviewReport.summary,
        });
      } catch (err) {
        log.warn('Automated review failed, proceeding with submission', { taskId, error: String(err) });
      }
    }

    if (task.taskType === 'scheduled' && task.deliverables?.length) {
      const runLabel = `Run #${task.scheduleConfig?.currentRuns ?? '?'} @ ${new Date().toISOString()}`;
      const tagged = deliverables.map(d => ({
        ...d,
        summary: `[${runLabel}] ${d.summary ?? ''}`,
      }));
      task.deliverables = [...tagged, ...task.deliverables];
    } else {
      task.deliverables = deliverables;
    }
    task.updatedAt = new Date().toISOString();

    if (reviewerAgentId) {
      task.reviewerAgentId = reviewerAgentId;
    }

    // Persist deliverables (and reviewerAgentId if changed) to DB
    if (this.taskRepo) {
      this.taskRepo.updateDeliverables(task.id, task.deliverables)
        .catch(err => log.warn('Failed to persist deliverables to DB', { taskId: task.id, error: String(err) }));
      if (reviewerAgentId) {
        this.taskRepo.update(task.id, { reviewerAgentId })
          .catch(err => log.warn('Failed to persist reviewer change to DB', { taskId: task.id, error: String(err) }));
      }
    }

    // Persist each task deliverable as a standalone Deliverable entity (skip branch — it's task metadata)
    if (this.deliverableService && deliverables.length > 0) {
      const builderMode = this.detectBuilderMode(task.assignedAgentId);

      for (const d of deliverables) {
        if (d.type === 'branch') continue;

        let artifactType: BuilderArtifactType | undefined;
        let artifactData: Record<string, unknown> | undefined;
        let reference = d.reference;

        if (builderMode && d.reference) {
          // Builder agents write files directly via file_write — check the artifact directory
          const dirMap = { agent: 'agents', team: 'teams', skill: 'skills' } as const;
          const artBase = join(homedir(), '.markus', 'builder-artifacts', dirMap[builderMode]);
          const ref = d.reference;
          if (ref.startsWith(artBase) && existsSync(ref)) {
            const mfPath = join(ref, manifestFilename(builderMode as PackageType));
            if (existsSync(mfPath)) {
              artifactType = builderMode;
              try { artifactData = JSON.parse(readFileSync(mfPath, 'utf-8')); } catch { /* ignore */ }
              reference = ref;
            }
          }
        }

        this.deliverableService.create({
          type: d.type === 'directory' ? 'directory' : 'file',
          title: d.summary.slice(0, 200) || d.reference,
          summary: d.summary,
          reference,
          taskId: task.id,
          agentId: task.assignedAgentId,
          projectId: task.projectId,
          requirementId: task.requirementId,
          artifactType,
          artifactData,
          diffStats: d.diffStats,
          testResults: d.testResults,
        }).catch(err => log.warn('Failed to create deliverable entity', { taskId: task.id, error: String(err) }));
      }
    }

    // Publish deliverables to shared workspace so reviewers and other agents can access them
    if (this.sharedDataDir) {
      this.publishDeliverablestoShared(task, deliverables);
    }

    // Reviewer access to workspace is handled by the agent — the reviewer agent
    // reads deliverables and code via its own tools, not via worktree grants.

    if (reviewReport) {
      task.notes = task.notes ?? [];
      task.notes.push(`[${formatLocalTimestamp()} by System] Automated review: ${reviewReport.overallStatus} — ${reviewReport.summary}`);
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

    // Transition to review — updateTaskStatus handles persistence, WS broadcast,
    // event emission, and reviewer notification
    this.updateTaskStatus(task.id, 'review');

    log.info(`Task submitted for review: ${task.title}`, { id: task.id });
    return task;
  }

  /**
   * Send a review notification to the specified reviewer agent with full task context.
   */
  private notifyReviewer(task: Task, reviewerAgentId: string): void {
    if (!this.agentManager || !this.agentManager.hasAgent(reviewerAgentId)) {
      log.warn('Reviewer agent not found, cannot notify', { taskId: task.id, reviewerAgentId });
      return;
    }
    if (reviewerAgentId === task.assignedAgentId) {
      log.warn('Reviewer is the same as assignee, skipping notification', { taskId: task.id, reviewerAgentId });
      return;
    }

    // Prevent duplicate review sessions for the same task
    if (this.activeReviews.has(task.id)) {
      log.debug('Review notification already active for task, skipping duplicate', { taskId: task.id, reviewerAgentId });
      return;
    }
    this.activeReviews.add(task.id);

    try {
      const assigneeName = task.assignedAgentId
        ? (this.agentManager.hasAgent(task.assignedAgentId)
          ? this.agentManager.getAgent(task.assignedAgentId).config.name
          : task.assignedAgentId)
        : 'unknown';

      // Build rich context for the reviewer
      const parts: string[] = [];
      parts.push(`[REVIEW REQUEST — ACTION REQUIRED] Task "${task.title}" (ID: ${task.id}) has been submitted for your review by ${assigneeName}.`);
      parts.push('');
      parts.push(`**Description:** ${task.description}`);

      if (task.deliverables && task.deliverables.length > 0) {
        const files = task.deliverables.filter(d => d.type !== 'branch');
        if (files.length > 0) {
          parts.push('');
          parts.push('**Deliverables:**');
          for (const d of files.slice(0, 10)) {
            parts.push(`- [${d.type}] ${d.reference}${d.summary ? ` — ${d.summary}` : ''}`);
          }
          if (files.length > 10) parts.push(`  ... and ${files.length - 10} more`);
        }
        const branch = task.deliverables.find(d => d.type === 'branch');
        if (branch) {
          parts.push(`**Branch:** ${branch.reference}`);
          if (branch.summary) parts.push(`**Summary:** ${branch.summary}`);
        }
      }

      // Include subtask status if any
      if (task.subtasks.length > 0) {
        const done = task.subtasks.filter(s => s.status === 'completed').length;
        parts.push('');
        parts.push(`**Subtasks:** ${done}/${task.subtasks.length} completed`);
        for (const sub of task.subtasks) {
          const check = sub.status === 'completed' ? '✓' : sub.status === 'cancelled' ? '✗' : '☐';
          parts.push(`- ${check} ${sub.title} (subtask_id: \`${sub.id}\`, status: ${sub.status})`);
        }
      }

      // Include recent notes
      if (task.notes && task.notes.length > 0) {
        parts.push('');
        parts.push('**Recent Notes:**');
        for (const note of task.notes.slice(-3)) {
          parts.push(`> ${note}`);
        }
      }

      // Include git branch and repo context so the reviewer can diff, merge, or create PRs
      if (task.projectId && this.projectService) {
        const project = this.projectService.getProject(task.projectId);
        const repo = project?.repositories?.find(r => r.role === 'primary' && r.localPath) ?? project?.repositories?.find(r => r.localPath);
        if (repo?.localPath) {
          const branchName = `task/${task.id}`;
          const worktreePath = `${repo.localPath}/.worktrees/task-${task.id}`;
          parts.push('');
          parts.push('**Git Context:**');
          parts.push(`- Repository: \`${repo.localPath}\``);
          parts.push(`- Task branch: \`${branchName}\``);
          parts.push(`- Base branch: \`${repo.defaultBranch}\``);
          parts.push(`- Worktree: \`${worktreePath}\``);
          parts.push(`- To see changes: \`cd ${repo.localPath} && git diff ${repo.defaultBranch}...${branchName}\``);
        }
      }

      parts.push('');
      parts.push(`Please review immediately. Use \`task_get\` with task_id "${task.id}" to inspect deliverable files, then either:`);
      parts.push(`- **Approve**: Review the code, merge the branch (via \`git merge\` or \`gh pr create\` + \`gh pr merge\`), then \`task_update\` with status "completed" and a review note`);
      parts.push(`- **Reject**: \`task_update\` with status "in_progress" and a note explaining what needs to change — this sends the task back for revision with a new execution round`);
      parts.push('');
      parts.push(`CRITICAL: You MUST ONLY review this specific task (ID: ${task.id}). Do NOT change the status of any other task.`);

      const reviewMessage = parts.join('\n');
      const reviewerAgent = this.agentManager.getAgent(reviewerAgentId);
      reviewerAgent.handleMessage(
        reviewMessage,
        task.assignedAgentId ?? 'system',
        { name: assigneeName, role: 'worker' },
      ).then(() => {
        this.activeReviews.delete(task.id);
      }).catch(err => {
        this.activeReviews.delete(task.id);
        log.warn('Failed to notify reviewer about review', { taskId: task.id, reviewerAgentId, error: String(err) });
      });
      log.info('Notified reviewer about review', { taskId: task.id, reviewerAgentId });
    } catch (err) {
      this.activeReviews.delete(task.id);
      log.warn('Failed to notify reviewer about review', { taskId: task.id, reviewerAgentId, error: String(err) });
    }
  }

  // Worktree path derivation removed — agents manage their own workspaces.
  // The review service receives repo path and branch info directly.

  private detectBuilderMode(agentId?: string): BuilderArtifactType | undefined {
    if (!agentId || !this.agentManager) return undefined;
    try {
      const agents = this.agentManager.listAgents();
      const info = agents.find(a => a.id === agentId);
      if (!info) return undefined;
      const r = info.role.toLowerCase();
      if (r === 'agent father' || r === 'agent-father') return 'agent';
      if (r === 'team factory' || r === 'team-factory') return 'team';
      if (r === 'skill architect' || r === 'skill-architect') return 'skill';
      // Also detect via building skills (any agent with a building skill can produce artifacts)
      const agent = this.agentManager.getAgent(agentId);
      const skills = agent.config.skills;
      if (skills.includes('agent-building')) return 'agent';
      if (skills.includes('team-building')) return 'team';
      if (skills.includes('skill-building')) return 'skill';
    } catch { /* ignore */ }
    return undefined;
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
      // For file types without a physical path, write the summary as a file
      if (d.type === 'file' && d.summary && !existsSync(d.reference)) {
        const safeName = d.reference.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
        writeFileSync(join(taskSharedDir, `${safeName}.md`), d.summary);
      }
    }

    log.info('Deliverables published to shared workspace', { taskId: task.id, dir: taskSharedDir });
  }

  /**
   * Managers can only review tasks from their own team members or tasks they created.
   * Human reviewers are unrestricted.
   */
  private isReviewerAllowedForTask(reviewerId: string, task: Task): boolean {
    if (!this.agentManager || !this.orgService) return true;
    if (!this.agentManager.hasAgent(reviewerId)) return true;

    if (task.createdBy === reviewerId) return true;

    if (!task.assignedAgentId) return true;

    const teams = this.orgService.listTeams(task.orgId);
    for (const team of teams) {
      if (team.managerId === reviewerId && team.memberAgentIds.includes(task.assignedAgentId)) {
        return true;
      }
    }

    return false;
  }

  private assertReviewerAllowed(reviewerId: string, task: Task): void {
    if (!this.isReviewerAllowedForTask(reviewerId, task)) {
      const reviewerName = this.agentManager?.hasAgent(reviewerId)
        ? this.agentManager.getAgent(reviewerId).config.name
        : reviewerId;
      throw new Error(
        `Agent "${reviewerName}" (${reviewerId}) is not allowed to review task "${task.title}". ` +
        `Managers can only review tasks from their own team members or tasks they created/assigned.`
      );
    }
  }

  acceptTask(taskId: string, reviewerAgentId?: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'review') {
      throw new Error(`Task ${taskId} is in ${task.status} status, cannot accept`);
    }

    if (reviewerAgentId && task.assignedAgentId && reviewerAgentId === task.assignedAgentId) {
      throw new Error(`Agent ${reviewerAgentId} cannot accept their own task.`);
    }
    if (reviewerAgentId) {
      this.assertReviewerAllowed(reviewerAgentId, task);
    }

    // Transition to completed — updateTaskStatus handles all side effects
    this.updateTaskStatus(task.id, 'completed', reviewerAgentId);

    this.auditService?.record({
      orgId: task.orgId,
      agentId: reviewerAgentId,
      type: 'task_review_accepted',
      action: 'accept_task',
      detail: `Task "${task.title}" accepted and completed`,
      taskId: task.id,
      projectId: task.projectId,
      success: true,
      metadata: { workerAgentId: task.assignedAgentId },
    });

    if (task.assignedAgentId && this.agentManager) {
      this.triggerPostTaskReflection(task);
    }

    log.info(`Task accepted and completed: ${task.title}`, { id: task.id });
    return task;
  }

  private reflectionCountByAgent = new Map<string, { date: string; count: number }>();

  private isReflectionRateLimited(agentId: string): boolean {
    const today = new Date().toISOString().slice(0, 10);
    const entry = this.reflectionCountByAgent.get(agentId);
    if (!entry || entry.date !== today) {
      this.reflectionCountByAgent.set(agentId, { date: today, count: 1 });
      return false;
    }
    if (entry.count >= 5) return true;
    entry.count++;
    return false;
  }

  private triggerPostTaskReflection(task: Task): void {
    const agent = this.agentManager?.getAgent(task.assignedAgentId);
    if (!agent) return;

    if (this.isReflectionRateLimited(task.assignedAgentId)) {
      log.debug('Skipping reflection — daily limit reached', { agentId: task.assignedAgentId });
      return;
    }

    const hadRevisions = (task.executionRound ?? 1) > 1;

    const prompt = hadRevisions
      ? [
          '[SELF-EVOLUTION — Post-Task Reflection (Revision)]',
          '',
          `Task "${task.title}" (ID: ${task.id}) was completed after ${task.executionRound} execution rounds.`,
          'This means the task required revision — something in your initial approach needed correction.',
          '',
          'Follow the **self-evolution** skill instructions to extract lessons:',
          '1. What went wrong in earlier rounds? What feedback or error caused the revision?',
          '2. What did you change in the successful round?',
          '3. What is the generalizable lesson?',
          '',
          'Save each lesson using `memory_save` with tags `["lesson", ...]`.',
          'If you now have 3+ unsaved lessons, also consolidate into long-term memory via `memory_update_longterm` with section `"lessons-learned"`.',
        ].join('\n')
      : [
          '[SELF-EVOLUTION — Post-Task Reflection (Success)]',
          '',
          `Task "${task.title}" (ID: ${task.id}) was completed successfully on the first attempt.`,
          '',
          'Briefly reflect on what made this task go well:',
          '1. Were there tools, patterns, or approaches that proved especially effective?',
          '2. Is there a reusable technique or SOP worth remembering for similar future tasks?',
          '',
          'If you identify a meaningful insight, save it using `memory_save` with tags `["lesson", "best-practice", ...]`.',
          'If nothing noteworthy stands out, it is fine to skip saving.',
        ].join('\n');

    void agent.handleMessage(prompt, undefined, undefined, {
      ephemeral: true,
      maxHistory: 10,
    }).catch(err => {
      log.warn('Post-task reflection failed', { taskId: task.id, error: String(err) });
    });
  }

  async requestRevision(taskId: string, reason: string, author?: string): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'review') {
      throw new Error(`Task ${taskId} is in ${task.status} status, cannot request revision`);
    }

    if (author) {
      this.assertReviewerAllowed(author, task);
    }

    const by = author || 'Reviewer';
    const now = new Date();
    task.executionRound = (task.executionRound ?? 1) + 1;
    task.notes = task.notes ?? [];
    task.notes.push(`[${formatLocalTimestamp(now)} by ${by}] Revision requested (round ${task.executionRound}): ${reason}`);

    if (this.taskRepo) {
      (this.taskRepo as any).updateExecutionRound?.(task.id, task.executionRound)
        ?.catch?.((err: Error) => log.warn('Failed to persist execution round', { taskId: task.id, error: String(err) }));
      this.taskRepo.update(task.id, { notes: task.notes })
        .catch(err => log.warn('Failed to persist revision notes', { error: String(err) }));
    }

    // Await comment persistence so runTask can read it when building context
    if (this.taskCommentRepo) {
      try {
        await this.taskCommentRepo.add({
          taskId: task.id,
          authorId: 'system',
          authorName: 'Review System',
          authorType: 'system',
          content: `**Revision Requested (Round ${task.executionRound})**\n\n${reason}`,
        });
      } catch (err) {
        log.warn('Failed to persist revision comment', { taskId: task.id, error: String(err) });
      }
    }

    this.auditService?.record({
      orgId: task.orgId,
      agentId: task.assignedAgentId,
      type: 'task_review_revision_requested',
      action: 'request_revision',
      detail: `Revision requested for task "${task.title}" (round ${task.executionRound}): ${reason.slice(0, 200)}`,
      taskId: task.id,
      projectId: task.projectId,
      success: true,
      metadata: { reason, executionRound: task.executionRound },
    });

    // Transition directly to in_progress (auto re-execute)
    this.updateTaskStatus(task.id, 'in_progress');
    log.info(`Revision requested, auto-restarting task: ${task.title}`, { id: task.id, reason, round: task.executionRound });
    return task;
  }

  archiveTask(taskId: string): Task {
    return this.updateTaskStatus(taskId, 'archived');
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
      t => t.orgId === orgId && ['pending', 'blocked', 'in_progress'].includes(t.status)
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
          this.addTaskNote(dup.id, `Auto-cancelled: duplicate of task ${keeper.id} ("${keeper.title}")`, 'System');
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

    // Stale pending tasks (waiting > 48h)
    const staleAssigned = allTasks
      .filter(t => {
        if (t.status !== 'pending') return false;
        const age = now - new Date(t.updatedAt).getTime();
        return age > 48 * 60 * 60 * 1000;
      })
      .map(t => ({ id: t.id, title: t.title, assignedAgentId: t.assignedAgentId, assignedSinceHours: Math.round((now - new Date(t.updatedAt).getTime()) / 3600000) }));

    // Agent workload
    const agentLoad = new Map<string, { active: number; total: number }>();
    for (const t of allTasks) {
      if (!t.assignedAgentId) continue;
      const entry = agentLoad.get(t.assignedAgentId) ?? { active: 0, total: 0 };
      entry.total++;
      if (['in_progress', 'blocked', 'review'].includes(t.status)) entry.active++;
      agentLoad.set(t.assignedAgentId, entry);
    }

    return {
      totalTasks: allTasks.length,
      statusCounts,
      duplicateGroups: duplicateGroups.length,
      duplicateDetails: duplicateGroups,
      staleBlocked,
      staleAssigned,
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

  /**
   * Advance the schedule config for a task run (increment currentRuns,
   * set lastRunAt, compute nextRunAt). Used by both ScheduledTaskRunner
   * and the run-now API endpoint to keep schedule state consistent.
   */
  async advanceScheduleConfig(taskIdStr: string): Promise<void> {
    const task = this.tasks.get(taskIdStr);
    if (!task?.scheduleConfig) return;
    const config = task.scheduleConfig;
    const updatedConfig: ScheduleConfig = {
      ...config,
      currentRuns: (config.currentRuns ?? 0) + 1,
      lastRunAt: new Date().toISOString(),
      nextRunAt: computeNextRunFromConfig(config),
    };
    await this.updateScheduleConfig(taskIdStr, updatedConfig);
  }

  /**
   * Retry a task with a completely fresh start — new execution round, new session,
   * NO previous execution context. Used when the user explicitly wants to discard
   * the previous attempt and start clean.
   */
  async retryTaskFresh(taskIdStr: string): Promise<Task> {
    const task = this.tasks.get(taskIdStr);
    if (!task) throw new Error(`Task not found: ${taskIdStr}`);
    if (!['in_progress', 'failed', 'blocked', 'review'].includes(task.status)) {
      throw new Error(`Cannot retry task in ${task.status} status`);
    }

    // Cancel any running execution before transitioning
    const existing = this.taskCancelTokens.get(taskIdStr);
    if (existing) existing.cancelled = true;

    task.executionRound = (task.executionRound ?? 1) + 1;
    task.result = undefined;
    task.startedAt = undefined;
    task.completedAt = undefined;
    task.notes = task.notes ?? [];
    task.notes.push(`[${formatLocalTimestamp(new Date())}] Fresh retry requested (round ${task.executionRound}) — starting without previous execution context`);

    if (this.taskRepo) {
      (this.taskRepo as any).clearForRerun?.(task.id, task.executionRound)
        ?.catch?.((err: Error) => log.warn('Failed to persist fresh retry reset', { taskId: task.id, error: String(err) }));
      this.taskRepo.update(task.id, { notes: task.notes })
        .catch(err => log.warn('Failed to persist retry notes', { error: String(err) }));
    }

    // Transition via updateTaskStatus (skip auto-start; we'll start runTaskFresh instead)
    this.updateTaskStatus(taskIdStr, 'in_progress', undefined, true, true);

    // Start execution WITHOUT previous context
    if (this.agentManager) {
      setImmediate(() => {
        this.runTaskFresh(task.id).catch(err =>
          log.warn('Failed to start fresh retry', { taskId: task.id, error: String(err) })
        );
      });
    }
    return task;
  }

  /**
   * Run a task without loading any previous execution context.
   * Only the task's own description, notes, and dependency context are included.
   */
  private async runTaskFresh(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!task.assignedAgentId) throw new Error(`Task ${taskId} has no assigned agent`);
    if (!this.agentManager) throw new Error('AgentManager not set');

    const agent = this.agentManager.getAgent(task.assignedAgentId);
    const executionRound = task.executionRound ?? 1;

    const cancelToken = { cancelled: false };
    this.taskCancelTokens.set(taskId, cancelToken);

    // Build dependency context (same as runTask)
    let dependencyContext = '';
    if (task.blockedBy?.length) {
      const depSections: string[] = [];
      for (const depId of task.blockedBy) {
        const depTask = this.tasks.get(depId);
        if (!depTask) continue;
        const lines: string[] = [`### Dependency: ${depTask.title} (ID: ${depId}, status: ${depTask.status})`];
        if (depTask.description) lines.push(`**Description:** ${depTask.description.slice(0, 300)}`);
        if (depTask.notes?.length) {
          lines.push('**Notes (most recent first):**');
          for (const note of depTask.notes.slice(-5).reverse()) lines.push(`- ${note.slice(0, 500)}`);
        }
        if (depTask.deliverables?.length) {
          lines.push('**Deliverables (review these for background context):**');
          for (const d of depTask.deliverables) {
            const refInfo = d.type === 'file' ? ` — File: \`${d.reference}\` (use \`file_read\` to inspect)` :
                            d.type === 'branch' ? ` [branch: ${d.reference}]` :
                            d.reference ? ` — ref: \`${d.reference}\`` : '';
            lines.push(`- ${d.summary ?? '(no summary)'}${refInfo}`);
          }
        }
        depSections.push(lines.join('\n'));
      }
      if (depSections.length > 0) {
        dependencyContext = [
          '## ⚠ Dependency Tasks — READ THESE FIRST', '',
          ...depSections, '', '---', '',
        ].join('\n');
      }
    }

    // Build goal ancestry context (same as runTask)
    let goalContext = '';
    if (task.requirementId && this.requirementService) {
      const req = this.requirementService.getRequirement(task.requirementId);
      if (req) {
        const goalLines: string[] = ['## Goal Context'];
        if (task.projectId && this.projectService) {
          const project = this.projectService.getProject(task.projectId);
          if (project) {
            goalLines.push(`**Project:** ${project.name} — ${project.description.slice(0, 300)}`);
          }
        }
        goalLines.push(`**Requirement:** ${req.title}`);
        if (req.description) {
          goalLines.push(`**Requirement Description:** ${req.description.slice(0, 500)}`);
        }
        goalLines.push('');
        goalLines.push('Keep this goal context in mind. Your task should directly advance this requirement.');
        goalLines.push('', '---', '');
        goalContext = goalLines.join('\n');
      }
    }

    // Notes section only (no previous execution context)
    let notesSection = '';
    if (task.notes?.length) {
      const recentNotes = task.notes.slice(-20);
      const noteLines: string[] = ['## Task Notes'];
      noteLines.push(...recentNotes.map(n => `- ${n.slice(0, 800)}`), '', '---', '');
      notesSection = noteLines.join('\n');
    }

    // Include existing subtasks so the agent knows what was already decomposed
    let subtaskSection = '';
    if (task.subtasks.length > 0) {
      const done = task.subtasks.filter(s => s.status === 'completed').length;
      const subLines: string[] = [
        '## Subtasks',
        `Progress: ${done}/${task.subtasks.length} completed`,
        '',
      ];
      for (const sub of task.subtasks) {
        const check = sub.status === 'completed' ? '✓' : sub.status === 'cancelled' ? '✗' : '☐';
        subLines.push(`- ${check} **${sub.title}** (subtask_id: \`${sub.id}\`, status: ${sub.status})`);
      }
      subLines.push('', 'Use `subtask_complete` with `task_id` + `subtask_id` to mark pending subtasks done. Do NOT use `task_update` for subtasks.', '', '---', '');
      subtaskSection = subLines.join('\n');
    }

    const freshRetryHeader = [
      '## Fresh Retry',
      '',
      `**Current time:** ${formatLocalTimestamp(new Date())}`,
      `**Execution round:** #${executionRound}`,
      '',
      'This is a fresh retry — previous execution context has been discarded.',
      'Start the task from scratch using only the description, notes, and dependency context below.',
      '',
      '---',
      '',
    ].join('\n');

    const taskDescription = `${freshRetryHeader}${notesSection}${goalContext}${dependencyContext}${subtaskSection}${task.title}\n\n${task.description}`;

    // Ensure task row exists in DB before writing child rows (task_logs)
    if (this.taskRepo) {
      try {
        await this.taskRepo.ensureExists({
          id: task.id,
          orgId: task.orgId,
          title: task.title,
          description: task.description,
          priority: task.priority,
          status: task.status,
          assignedAgentId: task.assignedAgentId,
          reviewerAgentId: task.reviewerAgentId,
          executionRound: task.executionRound,
          requirementId: task.requirementId,
          projectId: task.projectId,
          createdBy: task.createdBy,
          blockedBy: task.blockedBy,
          dueAt: task.dueAt ? new Date(task.dueAt) : undefined,
          taskType: task.taskType,
          scheduleConfig: task.scheduleConfig as Record<string, unknown> | undefined,
          subtasks: task.subtasks,
        });
      } catch (err) {
        log.warn('Failed to ensure task exists in DB before fresh retry', { taskId, error: String(err) });
      }
    }

    const taskLogRepo = this.taskLogRepo;
    const ws = this.ws;
    let seq = 0;
    if (this.executionStreamRepo) {
      try {
        const maxSeq = (this.executionStreamRepo as any).getMaxSeq('task', taskId);
        if (typeof maxSeq === 'number' && maxSeq >= 0) seq = maxSeq + 1;
      } catch { /* fall through */ }
    }
    if (seq === 0 && taskLogRepo) {
      try {
        const maxSeq = await taskLogRepo.getMaxSeq(taskId);
        seq = maxSeq + 1;
      } catch { /* start from 0 */ }
    }

    void agent
      .executeTask(
        taskId,
        taskDescription,
        async entry => {
          if (!entry.persist) {
            const ts = new Date().toISOString();
            ws?.broadcast({ type: 'execution:log:delta', payload: { sourceType: 'task', sourceId: taskId, agentId: task.assignedAgentId, text: entry.content }, timestamp: ts });
            ws?.broadcast({ type: 'task:log:delta', payload: { taskId, agentId: task.assignedAgentId, text: entry.content }, timestamp: ts });
            return;
          }
          const currentSeq = seq++;
          const createdAt = new Date().toISOString();
          let savedId: string | undefined;
          if (taskLogRepo) {
            try {
              const saved = await taskLogRepo.append({ taskId, agentId: task.assignedAgentId, seq: currentSeq, type: entry.type as TaskLogType, content: entry.content, metadata: entry.metadata, executionRound });
              savedId = saved.id;
            } catch (err) { log.warn('Failed to persist task log', { taskId, error: String(err) }); }
          }
          if (this.executionStreamRepo) {
            try {
              this.executionStreamRepo.append({ sourceType: 'task', sourceId: taskId, agentId: task.assignedAgentId, seq: currentSeq, type: entry.type, content: entry.content, metadata: entry.metadata, executionRound });
            } catch (err) { log.warn('Failed to persist execution stream log', { taskId, error: String(err) }); }
          }
          if (ws) {
            ws.broadcast({ type: 'execution:log', payload: { id: savedId, sourceType: 'task', sourceId: taskId, agentId: task.assignedAgentId, seq: currentSeq, type: entry.type, content: entry.content, metadata: entry.metadata, executionRound, createdAt }, timestamp: createdAt });
            ws.broadcast({ type: 'task:log', payload: { taskId, agentId: task.assignedAgentId, logId: savedId, logType: entry.type, content: entry.content, metadata: entry.metadata, executionRound, createdAt }, timestamp: createdAt });
          }
          if (entry.type === 'status' && (entry.content === 'execution_finished' || entry.content === 'completed')) {
            const currentTask = this.tasks.get(taskId);
            const alreadyTerminal = currentTask && ['review', 'completed', 'failed', 'cancelled', 'archived'].includes(currentTask.status);
            if (!alreadyTerminal && currentTask && currentTask.status === 'in_progress') {
              const delayMs = TaskService.RETRY_DELAYS_MS[0] ?? 10_000;
              log.warn(`Fresh retry finished without task_submit_review — auto-retrying in ${delayMs / 1000}s`, { taskId });
              this.addTaskNote(taskId,
                `[System] Fresh retry finished without task_submit_review. Auto-retrying.`,
                'system'
              );
              setTimeout(() => {
                const current = this.tasks.get(taskId);
                if (!current || current.status !== 'in_progress') return;
                this.runTask(taskId, 1).catch(e =>
                  log.error('Fresh no-submit retry invocation failed', { taskId, error: String(e) })
                );
              }, delayMs);
            }
          } else if (entry.type === 'error') {
            const retryDecision = this.shouldRetryTask(taskId, entry.content, 0, cancelToken.cancelled);
            if (!retryDecision.shouldRetry && !cancelToken.cancelled) {
              this.taskRetryErrors.delete(taskId);
              this.updateTaskStatus(taskId, 'failed');
            }
          }
        },
        cancelToken,
        undefined,
        executionRound
      )
      .catch(err => {
        log.error('Fresh retry execution rejected', { taskId, error: String(err) });
        if (!cancelToken.cancelled) {
          this.taskRetryErrors.delete(taskId);
          this.updateTaskStatus(taskId, 'failed');
        }
      });
  }

  /**
   * Inject a live comment into a running task's agent session.
   * The comment becomes a user message in the LLM context, so the agent
   * sees it on its next turn and can act on the feedback immediately.
   *
   * For completed tasks, triggers an asynchronous post-task conversation
   * where the agent reads the comment, replies, and records the exchange.
   */
  injectCommentIntoRunningTask(taskId: string, authorName: string, content: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const terminalStatuses = new Set(['completed', 'accepted', 'archived']);
    if (terminalStatuses.has(task.status)) {
      void this.handlePostTaskComment(taskId, task, authorName, content);
      return;
    }

    if (task.status !== 'in_progress') return;
    if (!task.assignedAgentId || !this.agentManager) return;

    try {
      const agent = this.agentManager.getAgent(task.assignedAgentId);
      const round = task.executionRound ?? 1;
      const sessionId = `task_${taskId}_r${round}`;
      const injectedMessage = [
        `⚡ **LIVE COMMENT from ${authorName}** (just posted while you are working):`,
        '',
        content,
        '',
        '**IMPORTANT: Address this comment in your current work. It may contain new instructions, corrections, or feedback that you must follow.**',
      ].join('\n');
      agent.injectUserMessage(sessionId, injectedMessage);
      log.info('Injected live comment into agent session', { taskId, sessionId, authorName });
    } catch (err) {
      log.warn('Failed to inject comment into agent session', { taskId, error: String(err) });
    }
  }

  /**
   * Handle a user comment on a completed task by continuing the agent's
   * original task session with full streaming visibility. The agent has
   * full execution context and all tools — the process is logged as
   * execution entries identical to normal task runs.
   */
  private async handlePostTaskComment(
    taskId: string,
    task: Task,
    authorName: string,
    content: string,
  ): Promise<void> {
    if (!task.assignedAgentId || !this.agentManager) {
      log.debug('Cannot handle post-task comment — no agent assigned or agent manager unavailable', { taskId });
      return;
    }

    let agent;
    try {
      agent = this.agentManager.getAgent(task.assignedAgentId);
    } catch {
      log.debug('Cannot handle post-task comment — agent not found', { taskId, agentId: task.assignedAgentId });
      return;
    }

    const agentId = task.assignedAgentId;
    const round = task.executionRound ?? 1;
    const taskSessionId = `task_${taskId}_r${round}`;
    const taskLogRepo = this.taskLogRepo;
    const ws = this.ws;

    let seq = 0;
    if (taskLogRepo) {
      try {
        const maxSeq = await taskLogRepo.getMaxSeq(taskId);
        seq = maxSeq + 1;
      } catch { /* start from current */ }
    }

    const prompt = [
      `[POST-TASK COMMENT from ${authorName}]`,
      '',
      content,
      '',
      `(This task "${task.title}" is already ${task.status}. You have full context from your execution above.`,
      'Respond to the comment. If the feedback contains something worth remembering, save it to memory.',
      'You have all your tools available — take action if appropriate.)',
    ].join('\n');

    try {
      log.info('Triggering post-task agent reply', { taskId, taskSessionId, agentId, authorName });

      const reply = await agent.respondInSession(taskSessionId, prompt, entry => {
        if (!entry.persist) {
          const ts = new Date().toISOString();
          ws?.broadcast({ type: 'execution:log:delta', payload: { sourceType: 'task', sourceId: taskId, agentId, text: entry.content }, timestamp: ts });
          ws?.broadcast({ type: 'task:log:delta', payload: { taskId, agentId, text: entry.content }, timestamp: ts });
          return;
        }

        const currentSeq = seq++;
        const createdAt = new Date().toISOString();
        let savedId: string | undefined;

        taskLogRepo?.append({ taskId, agentId, seq: currentSeq, type: entry.type as TaskLogType, content: entry.content, metadata: entry.metadata, executionRound: round }).catch(err =>
          log.warn('Failed to persist post-task log', { taskId, error: String(err) })
        );
        if (this.executionStreamRepo) {
          try {
            this.executionStreamRepo.append({ sourceType: 'task', sourceId: taskId, agentId, seq: currentSeq, type: entry.type, content: entry.content, metadata: entry.metadata, executionRound: round });
          } catch { /* best effort */ }
        }

        ws?.broadcast({ type: 'execution:log', payload: { id: savedId ?? `tmp_${taskId}_${currentSeq}`, sourceType: 'task', sourceId: taskId, agentId, seq: currentSeq, type: entry.type, content: entry.content, metadata: entry.metadata, executionRound: round, createdAt }, timestamp: createdAt });
        ws?.broadcast({ type: 'task:log', payload: { taskId, agentId, log: { taskId, agentId, seq: currentSeq, type: entry.type, content: entry.content, metadata: entry.metadata, executionRound: round, id: savedId ?? `tmp_${taskId}_${currentSeq}`, createdAt } }, timestamp: createdAt });
      });

      const cleanReply = reply.trim();
      if (!cleanReply) {
        log.warn('Agent returned empty reply for post-task comment', { taskId });
        return;
      }

      if (this.taskCommentRepo) {
        const agentComment = await this.taskCommentRepo.add({
          taskId,
          authorId: agentId,
          authorName: agent.config.name ?? agentId,
          authorType: 'agent',
          content: cleanReply,
        });

        ws?.broadcast({
          type: 'task:comment',
          payload: {
            taskId,
            comment: {
              id: agentComment.id,
              taskId: agentComment.taskId,
              authorId: agentComment.authorId,
              authorName: agentComment.authorName,
              authorType: agentComment.authorType,
              content: agentComment.content,
              attachments: agentComment.attachments,
              createdAt: agentComment.createdAt instanceof Date
                ? agentComment.createdAt.toISOString()
                : agentComment.createdAt,
            },
          },
          timestamp: new Date().toISOString(),
        });
      }

      log.info('Post-task agent reply saved', { taskId, replyLength: cleanReply.length });
    } catch (err) {
      log.warn('Post-task comment reply failed', { taskId, error: String(err) });
    }
  }

  async resetTaskForRerun(taskIdStr: string): Promise<void> {
    const task = this.tasks.get(taskIdStr);
    if (!task) return;

    task.executionRound = (task.executionRound ?? 1) + 1;
    task.result = undefined;
    task.startedAt = undefined;
    task.completedAt = undefined;

    if (this.taskRepo) {
      (this.taskRepo as any).clearForRerun?.(task.id, task.executionRound)
        ?.catch?.((err: Error) => log.warn('Failed to persist rerun reset', { taskId: task.id, error: String(err) }));
    }

    // Transition to in_progress — auto-start is handled by updateTaskStatus
    this.updateTaskStatus(taskIdStr, 'in_progress', undefined, true);
    log.info('Scheduled task reset for rerun', { taskId: task.id, title: task.title, round: task.executionRound });
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

const INTERVAL_MULTIPLIERS: Record<string, number> = {
  ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
};

function parseInterval(shorthand: string): number {
  const match = shorthand.match(/^(\d+)(ms|s|m|h|d|w)$/);
  if (!match) return 0;
  return parseInt(match[1]!, 10) * (INTERVAL_MULTIPLIERS[match[2]!] ?? 0);
}

function estimateCronInterval(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return 3_600_000;
  const [minute, hour] = parts;
  if (minute !== '*' && hour === '*') return 3_600_000;
  if (minute !== '*' && hour !== '*') return 86_400_000;
  return 3_600_000;
}

/**
 * Compute the next run timestamp from a schedule config.
 * Returns undefined for one-shot (`runAt`) or unrecognised configs.
 */
export function computeNextRunFromConfig(config: ScheduleConfig): string | undefined {
  if (config.runAt) return undefined;
  if (config.every) {
    const ms = parseInterval(config.every);
    if (ms > 0) return new Date(Date.now() + ms).toISOString();
  }
  if (config.cron) {
    const ms = estimateCronInterval(config.cron);
    if (ms > 0) return new Date(Date.now() + ms).toISOString();
  }
  return undefined;
}
