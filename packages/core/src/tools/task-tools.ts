import type { AgentToolHandler } from '../agent.js';
import { findUnknownArgs } from './tool-args.js';
import { createLogger, TASK_GET_NOTES_DEFAULT, TASK_GET_DELIVERABLES_DEFAULT, TASK_GET_STATUS_HISTORY_DEFAULT, REQUIREMENT_LIST_DEFAULT, ENTITY_COMMENTS_DEFAULT, type GoalConfig } from '@markus/shared';

const log = createLogger('task-tools');

export interface AgentTaskContext {
  agentId: string;
  agentName: string;
  /** Create a new task; returns the created task id */
  createTask: (params: {
    title: string;
    description: string;
    assignedAgentId: string;
    reviewerId: string;
    reviewerType?: 'agent' | 'human';
    priority?: string;
    requirementId?: string;
    projectId?: string;
    blockedBy?: string[];
    taskType?: string;
    scheduleConfig?: {
      cron?: string;
      every?: string;
      runAt?: string;
      timezone?: string;
      maxRuns?: number;
    };
  }) => Promise<{ id: string; title: string; status: string }>;
  /** List tasks with filtering, search, sorting and pagination */
  listTasks: (filter?: {
    assignedToMe?: boolean;
    status?: string;
    requirementId?: string;
    projectId?: string;
    priority?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: string;
    page?: number;
    pageSize?: number;
  }) => Promise<{
    tasks: Array<{
      id: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      updatedAt: string;
      assignedAgentId?: string;
      requirementId?: string;
    }>;
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>;
  /** Update a task's status (e.g. in_progress, blocked, completed, failed) */
  updateTaskStatus: (
    taskId: string,
    status: string
  ) => Promise<{ id: string; title: string; status: string }>;
  /**
   * Ask another agent a question and WAIT for the answer (blocking).
   * Implemented by the agent manager: it delivers the question as a peer query
   * and awaits the target's turn, so the reply comes back inside THIS turn.
   */
  askAgent?: (
    toAgentId: string,
    question: string,
    context: string | undefined,
    timeoutSeconds: number | undefined,
  ) => Promise<{
    status: 'answered' | 'timeout' | 'unavailable';
    agent?: { id: string; name?: string };
    answer?: string;
    elapsed_ms?: number;
    message?: string;
  }>;
  /**
   * Re-open a task's **creation gate** approval after a 打回 (changes requested).
   * Only valid while the task is still `pending` and has no active approval —
   * a 打回 performs zero state transition, so without this the task would be an
   * orphan with no way back into review.
   */
  requestTaskApproval?: (taskId: string) => Promise<{ taskId: string; approvalId: string }>;
  /** Get details of a specific task */
  getTask: (
    taskId: string
  ) => Promise<{
    id: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    assignedAgentId?: string;
  } | null>;
  /** Assign a task to an agent */
  assignTask?: (taskId: string, agentId: string) => Promise<{ id: string; status: string }>;
  /** Add a progress note to a task */
  addTaskNote?: (taskId: string, note: string, author?: string) => Promise<void>;
  /** Update task fields (description, blockedBy, reviewerId, requirementId, etc.) — works even for pending tasks */
  updateTaskFields?: (taskId: string, fields: { title?: string; description?: string; blockedBy?: string[]; reviewerId?: string; reviewerType?: 'agent' | 'human'; requirementId?: string | null }) => Promise<{ id: string; title: string; status: string }>;
  /** Update the schedule config for a scheduled task */
  updateScheduleConfig?: (taskId: string, config: { every?: string; cron?: string; maxRuns?: number; timezone?: string }) => Promise<{ id: string; title: string; status: string }>;
  /** Cancel a pending task (calls rejectTask under the hood) */
  cancelPendingTask?: (taskId: string) => Promise<{ id: string; title: string; status: string }>;
  /** Add a subtask to a task */
  addSubtask?: (taskId: string, title: string) => Promise<{ id: string; title: string; status: string }>;
  /** Complete a subtask */
  completeSubtask?: (taskId: string, subtaskId: string) => Promise<{ id: string; title: string; status: string }>;
  /** Cancel a subtask (marks as no longer applicable) */
  cancelSubtask?: (taskId: string, subtaskId: string) => Promise<{ id: string; title: string; status: string }>;
  /** Get subtasks of a task */
  getSubtasks?: (taskId: string) => Promise<Array<{ id: string; title: string; status: string }>>;
  /** Propose a requirement for user review */
  proposeRequirement?: (params: {
    title: string;
    description: string;
    priority?: string;
    projectId?: string;
    tags?: string[];
  }) => Promise<{ id: string; title: string; status: string }>;
  /** List requirements visible to this agent */
  listRequirements?: (filter?: {
    status?: string;
    projectId?: string;
    createdBy?: string;
  }) => Promise<
    Array<{
      id: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      source: string;
      createdBy?: string;
      taskIds: string[];
    }>
  >;
  /** Get a single requirement by ID with full details and comments */
  getRequirement?: (id: string) => Promise<{
    id: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    source: string;
    createdBy?: string;
    approvedBy?: string;
    approvedAt?: string;
    rejectedReason?: string;
    taskIds: string[];
    tags?: string[];
    createdAt: string;
    updatedAt: string;
    comments: Array<{
      id: string;
      authorId: string;
      authorName: string;
      content: string;
      createdAt: string;
    }>;
  } | null>;
  /** Submit completed work for review — system auto-fills task_id, reviewer, and branch when task_id is omitted */
  submitForReview?: (
    summary: string,
    deliverables?: Array<{ type?: string; reference: string; summary: string }>,
    knownIssues?: string,
    taskId?: string
  ) => Promise<{ id: string; status: string }>;
  /** Request revision on a task in review — increments execution round and restarts with fresh context */
  requestRevision?: (
    taskId: string,
    reason: string
  ) => Promise<{ id: string; title: string; status: string }>;
  /** Update a requirement's status (cancel, reject, etc.) */
  updateRequirementStatus?: (
    id: string,
    status: string,
    reason?: string
  ) => Promise<{ id: string; title: string; status: string }>;
  /** Update a requirement's fields (title, description, priority, tags) */
  updateRequirement?: (
    id: string,
    data: { title?: string; description?: string; priority?: string; tags?: string[]; projectId?: string | null }
  ) => Promise<{ id: string; title: string; status: string }>;
  /** Resubmit a rejected requirement for review, optionally updating fields */
  resubmitRequirement?: (
    id: string,
    updates?: { title?: string; description?: string; priority?: string; tags?: string[] }
  ) => Promise<{ id: string; title: string; status: string }>;
  /** Get structured comments on a task */
  getTaskComments?: (taskId: string) => Promise<Array<{ id: string; authorId: string; authorName: string; content: string; replyToId?: string; replyToAuthor?: string; replyToContent?: string; createdAt: string }>>;
  /** Post a structured comment on a task (with @mention and reply-to support) */
  postTaskComment?: (taskId: string, content: string, mentions?: string[], activityId?: string, replyToId?: string) => Promise<{ id: string }>;
  /** Post a structured comment on a requirement (with @mention and reply-to support) */
  postRequirementComment?: (requirementId: string, content: string, mentions?: string[], activityId?: string, replyToId?: string) => Promise<{ id: string }>;
  /** Returns the ID of the agent's currently executing activity (for traceability) */
  getCurrentActivityId?: () => string | undefined;
  /** Get status transition history for a task or requirement */
  getStatusHistory?: (entityType: 'task' | 'requirement', entityId: string) => Promise<Array<{ id: number; fromStatus: string; toStatus: string; changedById: string | null; changedByType: string; changedByName: string | null; reason: string | null; createdAt: string }>>;
  /** RequirementService for goal operations */
  requirementService?: {
    create(data: { title: string; description: string; source: string; createdBy: string; priority: string; orgId: string; status?: string }): Promise<{ id: string }>;
    enableGoalLoop(reqId: string, config: { completionCriteria: string; maxIterations?: number; autoResume?: boolean }): Promise<void>;
    disableGoalLoop(reqId: string): Promise<void>;
    getById(id: string): { id: string; title: string; status: string; taskIds: string[]; goalConfig?: GoalConfig } | undefined;
    getActiveGoals(orgId: string): Array<{ id: string; title: string; status: string; goalConfig?: GoalConfig }>;
  };
  orgId?: string;
}

/**
 * Reject tool arguments the schema does not declare.
 *
 * Why this exists (BUG-2, 2026-10-18): `task_update(task_id, requirement_id=R2)`
 * returned `{"status":"success"}` while changing nothing — the caller passed a
 * real field that the service layer supports but the tool layer did not know, and
 * it was dropped without a word. A silent no-op is the worst possible answer:
 * the caller believes the card changed and moves on. Every task/requirement tool
 * that writes state must fail loud on parameters it cannot honour.
 *
 * Returns the error payload (a JSON string) when unknown args are present, or
 * null when the call is clean.
 */
function rejectUnknownArgs(
  toolName: string,
  args: Record<string, unknown>,
  allowed: readonly string[]
): string | null {
  // Compare CANONICAL names: dispatch expands every call with both casing variants and
  // injects reserved `_`-prefixed context keys, so comparing raw spellings against a
  // bare snake_case whitelist rejects the platform's own decorations — which is exactly
  // how this guard once refused every multi-word argument in production (2026-10-18).
  // `findUnknownArgs` is the single owner of that contract (tools/tool-args.ts).
  const unknown = findUnknownArgs(args, allowed);
  if (unknown.length === 0) return null;
  return JSON.stringify({
    status: 'error',
    error:
      `${toolName} does not accept: ${unknown.join(', ')}. ` +
      `Accepted: ${allowed.join(', ')}. NOTHING was changed — retry with a supported field.`,
  });
}

/** Fields `task_update` can write (keep in sync with its inputSchema). */
const TASK_UPDATE_FIELDS = [
  'task_id',
  'status',
  'note',
  'title',
  'description',
  'blocked_by',
  'reviewer_id',
  'reviewer_type',
  'schedule',
  'requirement_id',
] as const;

/** Statuses an agent may set on a requirement (keep in sync with the tool schema). */
const REQUIREMENT_AGENT_STATUSES: readonly string[] = ['cancelled', 'rejected', 'completed'];

export function createAgentTaskTools(ctx: AgentTaskContext): AgentToolHandler[] {
  return [
    {
      name: 'task_create',
      description: [
        'Create a new task in the team task board.',
        'Tasks MUST reference an approved requirement_id.',
        'If you want to propose new work, use requirement_propose instead.',
        'IMPORTANT: assigned_agent_id and reviewer_id are REQUIRED — every task must have an assignee and a reviewer (agent or human). Call agent_list_colleagues or team_list first to pick both.',
        'CRITICAL: When creating multiple tasks for a complex goal, you MUST use `blocked_by` to express ALL dependency relationships between them.',
        'Think carefully about the execution order — a task that needs output from another task MUST list that task ID in its `blocked_by` array.',
        'Tasks without dependencies will execute in parallel; tasks with `blocked_by` will wait for their prerequisites to complete first.',
        'Use subtask_create to break a task into smaller steps within a single task.',
        'SPLITTING: cut cards by independently-reviewable seam (single execution point / entry / consumer / verification), NEVER by file or by layer — splitting by file makes the cards collide on the same edits. Prefer the smallest number of cards that each have one clear "done" statement in one screen.',
        'DO NOT open a new card merely to change a specification — update the existing card\'s title/description instead. Regression and acceptance are the reviewer\'s job, not a separate card. A card whose description must say "this version supersedes all previous versions" means the split was wrong.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description:
              'Short, clear task title in the user\'s language (match User locale / their recent messages — not English by default)',
          },
          description: {
            type: 'string',
            description:
              'Detailed description of what needs to be done and why, written in the user\'s language (same as title)',
          },
          requirement_id: {
            type: 'string',
            description: 'ID of the approved requirement this task fulfills. Required for top-level tasks.',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'urgent'],
            description: 'Task priority (default: medium)',
          },
          assigned_agent_id: {
            type: 'string',
            description: 'Agent ID to assign this task to. REQUIRED — every task must have a responsible person. Call agent_list_colleagues (or team_list for managers) to find the right agent.',
          },
          reviewer_id: {
            type: 'string',
            description:
              'ID of the reviewer (agent or human user) who will review deliverables when execution finishes. Must differ from the assignee when both are agents.',
          },
          reviewer_type: {
            type: 'string',
            enum: ['agent', 'human'],
            description: 'Whether the reviewer is an agent or a human user. Default: "agent". Set to "human" if reviewer_id is a human user ID.',
          },
          project_id: {
            type: 'string',
            description: 'Project ID this task belongs to. Typically inherited from the requirement.',
          },
          blocked_by: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of task IDs that MUST complete before this task can start. CRITICAL for multi-task workflows: if task B depends on output from task A, task B MUST include task A\'s ID here. Without this, tasks run in parallel and B will not have A\'s deliverables.',
          },
          task_type: {
            type: 'string',
            enum: ['standard', 'scheduled'],
            description: 'Task type. "standard" (default) for one-shot tasks, "scheduled" for recurring/cron tasks.',
          },
          schedule: {
            type: 'object',
            description: 'Schedule configuration (required when task_type is "scheduled"). Provide exactly one of: cron, every, or run_at.',
            properties: {
              cron: { type: 'string', description: 'Cron expression, e.g. "0 9 * * 1-5" for weekdays at 9am' },
              every: { type: 'string', description: 'Interval shorthand, e.g. "4h", "30m", "1d"' },
              run_at: { type: 'string', description: 'ISO timestamp for one-shot scheduled execution' },
              timezone: { type: 'string', description: 'IANA timezone (default: UTC)' },
              max_runs: { type: 'number', description: 'Maximum number of runs (omit for unlimited)' },
            },
          },
        },
        required: ['title', 'description', 'assigned_agent_id', 'reviewer_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const assignedAgentId = args['assigned_agent_id'] as string | undefined;
          const reviewerId = args['reviewer_id'] as string | undefined;
          const reviewerType = (args['reviewer_type'] as string | undefined) === 'human' ? 'human' as const : 'agent' as const;

          if (!assignedAgentId) {
            return JSON.stringify({
              status: 'error',
              error: 'assigned_agent_id is required. Every task must have a responsible agent. Call team_list first to find the right agent by role/skills.',
            });
          }
          if (!reviewerId?.trim()) {
            return JSON.stringify({
              status: 'error',
              error: 'reviewer_id is required. Every task must have a designated reviewer (agent or human). Call team_list to pick a reviewer.',
            });
          }
          if (reviewerType !== 'human' && reviewerId === assignedAgentId) {
            return JSON.stringify({
              status: 'error',
              error: 'reviewer_id must differ from assigned_agent_id when both are agents — choose an independent reviewer via team_list.',
            });
          }

          const taskType = (args['task_type'] as string | undefined) ?? 'standard';
          const scheduleRaw = args['schedule'] as Record<string, unknown> | undefined;
          const scheduleConfig = scheduleRaw ? {
            cron: scheduleRaw['cron'] as string | undefined,
            every: scheduleRaw['every'] as string | undefined,
            runAt: scheduleRaw['run_at'] as string | undefined,
            timezone: scheduleRaw['timezone'] as string | undefined,
            maxRuns: scheduleRaw['max_runs'] as number | undefined,
          } : undefined;

          if (taskType === 'scheduled' && !scheduleConfig) {
            return JSON.stringify({
              status: 'error',
              error: 'schedule configuration is required when task_type is "scheduled". Provide cron, every, or run_at.',
            });
          }

          const task = await ctx.createTask({
            title: args['title'] as string,
            description: args['description'] as string,
            priority: args['priority'] as string | undefined,
            assignedAgentId,
            reviewerId,
            reviewerType,
            requirementId: args['requirement_id'] as string | undefined,
            projectId: args['project_id'] as string | undefined,
            blockedBy: args['blocked_by'] as string[] | undefined,
            taskType,
            scheduleConfig,
          });
          log.info(`Task created by agent ${ctx.agentId}`, { taskId: task.id, title: task.title, assignedAgentId });
          if (task.status === 'pending') {
            return JSON.stringify({
              status: 'pending',
              task,
              message: `Task "${task.title}" (ID: ${task.id}) is awaiting approval. Do NOT start working on it. You will be notified when it is approved or rejected.`,
            });
          }
          return JSON.stringify({
            status: 'success',
            task,
            message: `Task created: "${task.title}" (ID: ${task.id})`,
          });
        } catch (error) {
          log.error('task_create failed', { error: String(error) });
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },

    {
      name: 'task_list',
      description: [
        'List tasks from the team task board with filtering, search, sorting and pagination.',
        'By default shows tasks assigned to you, sorted by updatedAt desc, 20 per page.',
        'Use search to find tasks by keyword in title/description.',
        'Use requirement_id to see all tasks belonging to a specific requirement.',
        'Use project_id to see all tasks in a project.',
        'Check this regularly to know what you should be working on.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          assigned_to_me: {
            type: 'boolean',
            description:
              'If true (default), only show tasks assigned to you. If false, show all tasks.',
          },
          status: {
            type: 'string',
            enum: [
              'pending',
              'in_progress',
              'blocked',
              'review',
              'completed',
              'failed',
              'rejected',
              'cancelled',
              'archived',
            ],
            description: 'Filter by status (optional)',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'urgent'],
            description: 'Filter by priority (optional)',
          },
          requirement_id: {
            type: 'string',
            description: 'Filter tasks by requirement ID.',
          },
          project_id: {
            type: 'string',
            description: 'Filter tasks by project ID.',
          },
          search: {
            type: 'string',
            description: 'Search keyword — matches against task title and description (case-insensitive).',
          },
          sort_by: {
            type: 'string',
            enum: ['createdAt', 'updatedAt', 'priority', 'status', 'title'],
            description: 'Field to sort by (default: updatedAt)',
          },
          sort_order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction (default: desc)',
          },
          page: {
            type: 'number',
            description: 'Page number, 1-based (default: 1)',
          },
          page_size: {
            type: 'number',
            description: 'Number of tasks per page, 1-100 (default: 20)',
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const requirementId = args['requirement_id'] as string | undefined;
          const projectId = args['project_id'] as string | undefined;
          const assignedToMeDefault = !requirementId && !projectId;
          const assignedToMe = args['assigned_to_me'] !== undefined
            ? (args['assigned_to_me'] as boolean)
            : assignedToMeDefault;
          const result = await ctx.listTasks({
            assignedToMe,
            status: args['status'] as string | undefined,
            priority: args['priority'] as string | undefined,
            requirementId,
            projectId,
            search: args['search'] as string | undefined,
            sortBy: args['sort_by'] as string | undefined,
            sortOrder: args['sort_order'] as string | undefined,
            page: args['page'] as number | undefined,
            pageSize: args['page_size'] as number | undefined,
          });
          return JSON.stringify({
            status: 'success',
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
            totalPages: result.totalPages,
            count: result.tasks.length,
            tasks: result.tasks.map(t => ({
              id: t.id,
              title: t.title,
              status: t.status,
              priority: t.priority,
              updatedAt: t.updatedAt,
              ...(t.assignedAgentId ? { assignedAgentId: t.assignedAgentId } : {}),
              ...(t.requirementId ? { requirementId: t.requirementId } : {}),
            })),
          });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },

    {
      name: 'task_update',
      description: [
        'Update a PARENT TASK — add a progress note, change status, update title/description, modify blocked_by dependencies, or a combination.',
        'This is the SINGLE SOURCE OF TRUTH for the task: if the objective, scope, acceptance criteria, or a frozen fact changes, update the title/description HERE. Never deliver a fact or goal change only as a comment — the next agent reads the card, not the thread.',
        'WARNING: This tool operates on the parent task, NOT on subtasks. To complete a subtask, use subtask_complete instead.',
        'You can call this with just a note (no status change) to record progress without affecting the task lifecycle.',
        'Task lifecycle is mostly automatic: after approval, tasks start executing automatically; when execution finishes, the system auto-transitions to review and notifies the reviewer; reviewer approval auto-completes the task; revision auto-restarts execution.',
        'IMPORTANT: Workers MUST NOT set status to "completed" — only the reviewer can approve completion.',
        'IMPORTANT: Workers MUST NOT set status to "review" directly — use task_submit_review instead.',
        'IMPORTANT: Do NOT set status to "cancelled" or "failed" unless truly abandoning the task.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to update' },
          status: {
            type: 'string',
            enum: [
              'in_progress',
              'blocked',
              'review',
              'completed',
              'failed',
              'cancelled',
            ],
            description:
              'New status (optional). Mostly automatic — workers rarely need to change status manually. Workers: use blocked when waiting on external input. Reviewers: review→completed to approve.',
          },
          note: {
            type: 'string',
            description:
              'Progress note — brief summary of what was done, what is blocked, or next steps. Highly recommended.',
          },
          title: {
            type: 'string',
            description: 'Updated task title (optional). Works on any task including pending ones — use it to revise a card after a 打回 (changes requested).',
          },
          description: {
            type: 'string',
            description: 'Updated task description (optional). Can be used on any task including pending tasks.',
          },
          blocked_by: {
            type: 'array',
            items: { type: 'string' },
            description: 'Update the list of task IDs that block this task. Only the task creator can modify this field. Pass an empty array to clear all blockers.',
          },
          reviewer_id: {
            type: 'string',
            description: 'New reviewer agent or human ID. Only the task creator or a manager can change the reviewer.',
          },
          reviewer_type: {
            type: 'string',
            enum: ['agent', 'human'],
            description: 'Whether the new reviewer is an agent or a human user. Required when changing reviewer_id.',
          },
          requirement_id: {
            type: 'string',
            description:
              'Move this task to a different requirement (需求) — e.g. when requirements are split, merged or archived. The target requirement must exist and be an active (approved) requirement; the move is recorded in the audit trail. Only the task creator can re-link a task. Use requirement_list / requirement_get to confirm the exact ID before passing it.',
          },
          schedule: {
            type: 'object',
            description: 'Update the schedule for a scheduled (recurring) task. Only works on tasks with taskType "scheduled". Set either "every" OR "cron", not both.',
            properties: {
              every: { type: 'string', description: 'Interval shorthand, e.g. "4h", "30m", "1d". Replaces any existing cron.' },
              cron: { type: 'string', description: 'Cron expression, e.g. "0 9 * * 1-5". Replaces any existing interval.' },
              max_runs: { type: 'number', description: 'Maximum number of runs (omit or 0 for unlimited).' },
              timezone: { type: 'string', description: 'IANA timezone, e.g. "Asia/Shanghai". Default UTC.' },
            },
          },
        },
        required: ['task_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const taskId = args['task_id'] as string;
          const newStatus = args['status'] as string | undefined;
          const note = args['note'] as string | undefined;
          const title = args['title'] as string | undefined;
          const description = args['description'] as string | undefined;
          const blockedBy = args['blocked_by'] as string[] | undefined;
          const reviewerId = args['reviewer_id'] as string | undefined;
          const reviewerType = args['reviewer_type'] as 'agent' | 'human' | undefined;
          const requirementId = args['requirement_id'] as string | undefined;

          // BUG-2 (2026-10-18): unknown parameters used to be dropped silently.
          const unknownArgError = rejectUnknownArgs('task_update', args, TASK_UPDATE_FIELDS);
          if (unknownArgError) return unknownArgError;

          // Permission check: only task creator can modify blocked_by, reviewer or requirement
          if (blockedBy !== undefined || reviewerId !== undefined || requirementId !== undefined) {
            const existing = ctx.getTask ? await ctx.getTask(taskId) : null;
            const createdBy = (existing as Record<string, unknown> | null)?.['createdBy'] as string | undefined;
            if (blockedBy !== undefined && createdBy && createdBy !== ctx.agentId) {
              return JSON.stringify({
                status: 'denied',
                error: 'Only the task creator can modify blocked_by. You are not the creator of this task.',
              });
            }
            if (reviewerId !== undefined && createdBy && createdBy !== ctx.agentId) {
              return JSON.stringify({
                status: 'denied',
                error: 'Only the task creator or a manager can change the reviewer.',
              });
            }
            if (requirementId !== undefined && createdBy && createdBy !== ctx.agentId) {
              return JSON.stringify({
                status: 'denied',
                error:
                  "Only the task creator can re-link a task to another requirement (moving someone else's card across requirements changes their governance chain). Ask the creator, or a human, to do it.",
              });
            }
          }

          // BUG-2 class (2026-10-18): if the write path is missing we must NOT fall
          // through to the success payload below — that is the same silent no-op.
          const wantsFieldUpdate =
            title !== undefined ||
            description !== undefined ||
            blockedBy !== undefined ||
            reviewerId !== undefined ||
            requirementId !== undefined;
          if (wantsFieldUpdate && !ctx.updateTaskFields) {
            return JSON.stringify({
              status: 'error',
              error:
                'This agent context cannot update task fields (updateTaskFields is unavailable). NOTHING was changed.',
            });
          }

          // Handle field updates first — works for any status including pending
          if (
            (title !== undefined ||
              description !== undefined ||
              blockedBy !== undefined ||
              reviewerId !== undefined ||
              requirementId !== undefined) &&
            ctx.updateTaskFields
          ) {
            await ctx.updateTaskFields(taskId, {
              ...(title !== undefined ? { title } : {}),
              ...(description !== undefined ? { description } : {}),
              ...(blockedBy !== undefined ? { blockedBy } : {}),
              ...(reviewerId !== undefined ? { reviewerId } : {}),
              ...(reviewerType !== undefined ? { reviewerType } : {}),
              ...(requirementId !== undefined ? { requirementId } : {}),
            });
          }

          // Handle schedule updates for scheduled tasks
          const schedule = args['schedule'] as Record<string, unknown> | undefined;
          if (schedule && ctx.updateScheduleConfig) {
            try {
              await ctx.updateScheduleConfig(taskId, {
                every: schedule['every'] as string | undefined,
                cron: schedule['cron'] as string | undefined,
                maxRuns: schedule['max_runs'] as number | undefined,
                timezone: schedule['timezone'] as string | undefined,
              });
            } catch (err) {
              return JSON.stringify({ status: 'error', error: `Failed to update schedule: ${err}` });
            }
          }

          if (newStatus) {
            // Terminal-state authority (T25, 2026-10-17): an agent can NOT reopen a
            // closed card. A stray `task_update` flipped completed → in_progress 94s
            // after approval and silently broke the card's blockedBy dependents.
            if (newStatus === 'in_progress') {
              const existing = ctx.getTask ? await ctx.getTask(taskId) : null;
              if (existing?.status === 'completed') {
                return JSON.stringify({
                  status: 'denied',
                  error:
                    'This task is already completed — an agent cannot reopen it. Rework goes through the reviewer BEFORE closure (request revision while the card is in review); after closure only a human can reopen it. If you found a real defect, ask the person who owns that area with agent_ask_agent — do not flip the status.',
                });
              }
            }

            if (newStatus === 'review') {
              const existing = ctx.getTask ? await ctx.getTask(taskId) : null;
              if (existing?.assignedAgentId === ctx.agentId) {
                return JSON.stringify({
                  status: 'denied',
                  error:
                    'Do NOT set status to "review" directly. Use the task_submit_review tool instead — it records your summary and deliverables for the reviewer.',
                });
              }
            }

            if (newStatus === 'completed') {
              const existing = ctx.getTask ? await ctx.getTask(taskId) : null;
              if (existing?.assignedAgentId === ctx.agentId) {
                return JSON.stringify({
                  status: 'denied',
                  error:
                    'You cannot complete your own task. When execution finishes, the task enters review automatically; the designated reviewer must set status to completed.',
                });
              }
            }

            // Handle cancel/fail with pending support for creators
            if (newStatus === 'cancelled' || newStatus === 'failed') {
              const existing = ctx.getTask ? await ctx.getTask(taskId) : null;

              if (existing?.status === 'pending') {
                const createdBy = (existing as Record<string, unknown>)['createdBy'] as string | undefined;
                if (newStatus === 'cancelled' && createdBy === ctx.agentId && ctx.cancelPendingTask) {
                  const task = await ctx.cancelPendingTask(taskId);
                  if (note && ctx.addTaskNote) {
                    await ctx.addTaskNote(task.id, note, ctx.agentName).catch(() => {});
                  }
                  log.info(`Pending task cancelled by creator ${ctx.agentId}`, { taskId: task.id });
                  return JSON.stringify({
                    status: 'success',
                    task,
                    message: `Task "${task.title}" cancelled (was pending approval)${note ? ' — note recorded' : ''}`,
                  });
                }
                return JSON.stringify({
                  status: 'denied',
                  error: 'Only the task creator can cancel a pending task.',
                });
              }

              // Prevent workers from accidentally cancelling/failing their own running task
              if (existing?.assignedAgentId === ctx.agentId && existing?.status === 'in_progress') {
                log.warn(`Agent ${ctx.agentId} attempted to set own running task to "${newStatus}"`, { taskId });
                return JSON.stringify({
                  status: 'denied',
                  error: `Setting your own running task to "${newStatus}" will immediately abort all ongoing work. If you truly need to stop, confirm by adding a note explaining why. Otherwise, continue working on the task.`,
                });
              }
            }

            // Route review→in_progress through requestRevision for proper round increment
            if (newStatus === 'in_progress' && ctx.requestRevision) {
              const existing = ctx.getTask ? await ctx.getTask(taskId) : null;
              if (existing?.status === 'review') {
                const reason = note || 'Revision requested';
                try {
                  const task = await ctx.requestRevision(taskId, reason);
                  log.info(`Task revision requested by agent ${ctx.agentId}`, { taskId: task.id, reason });
                  return JSON.stringify({
                    status: 'success',
                    task,
                    message: `Task "${task.title}" sent back for revision (new execution round) — reason: ${reason}`,
                  });
                } catch (err) {
                  return JSON.stringify({ status: 'error', error: String(err) });
                }
              }
            }

            let task: { id: string; title: string; status: string };
            try {
              task = await ctx.updateTaskStatus(taskId, newStatus);
            } catch (err) {
              return JSON.stringify({
                status: 'error',
                error: String(err),
              });
            }
            if (note && ctx.addTaskNote) {
              await ctx.addTaskNote(task.id, note, ctx.agentName).catch(() => {});
            }
            log.info(`Task updated by agent ${ctx.agentId}`, {
              taskId: task.id,
              status: task.status,
            });
            return JSON.stringify({
              status: 'success',
              task,
              message: `Task "${task.title}" updated to ${task.status}${note ? ` — note recorded` : ''}${title !== undefined ? ' — title updated' : ''}${description !== undefined ? ' — description updated' : ''}${blockedBy !== undefined ? ' — blocked_by updated' : ''}${requirementId !== undefined ? ` — moved to requirement ${requirementId}` : ''}${schedule ? ' — schedule updated' : ''}`,
            });
          } else {
            // No status change — note, title, description, and/or blocked_by update
            if (!note && title === undefined && description === undefined && blockedBy === undefined && !schedule && requirementId === undefined) {
              return JSON.stringify({ status: 'error', error: 'Provide at least a status, a note, a title, a description, blocked_by, requirement_id, or schedule.' });
            }
            if (note && ctx.addTaskNote) {
              await ctx.addTaskNote(taskId, note, ctx.agentName);
            }
            const task = ctx.getTask ? await ctx.getTask(taskId) : null;
            log.info(`Task updated by agent ${ctx.agentId}`, { taskId, hasNote: !!note, hasDescription: description !== undefined, hasBlockedBy: blockedBy !== undefined });
            return JSON.stringify({
              status: 'success',
              task,
              message: `Task "${task?.title ?? taskId}" updated${note ? ' — note recorded' : ''}${title !== undefined ? ' — title updated' : ''}${description !== undefined ? ' — description updated' : ''}${blockedBy !== undefined ? ' — blocked_by updated' : ''}${requirementId !== undefined ? ` — moved to requirement ${requirementId}` : ''}${schedule ? ' — schedule updated' : ''}`,
            });
          }
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },

    {
      name: 'task_get',
      description: `Get detailed information about a specific task by its ID. By default returns the latest ${TASK_GET_NOTES_DEFAULT} notes and ${TASK_GET_DELIVERABLES_DEFAULT} deliverables. Set full=true to get everything.`,
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to look up' },
          full: { type: 'boolean', description: `If true, return all notes and deliverables. Default false (latest ${TASK_GET_NOTES_DEFAULT} notes, ${TASK_GET_DELIVERABLES_DEFAULT} deliverables).` },
        },
        required: ['task_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const taskId = args['task_id'] as string;
          const task = await ctx.getTask(taskId);
          if (!task) {
            return JSON.stringify({ status: 'error', error: `Task not found: ${taskId}` });
          }
          const full = args['full'] === true;
          const taskObj = task as Record<string, unknown>;
          if (!full) {
            const notes = taskObj['notes'] as string[] | undefined;
            if (notes && notes.length > TASK_GET_NOTES_DEFAULT) {
              taskObj['notes'] = notes.slice(-TASK_GET_NOTES_DEFAULT);
              taskObj['_notesTruncated'] = { total: notes.length, showing: TASK_GET_NOTES_DEFAULT, hint: 'Use full=true to see all' };
            }
            const deliverables = taskObj['deliverables'] as unknown[] | undefined;
            if (deliverables && deliverables.length > TASK_GET_DELIVERABLES_DEFAULT) {
              taskObj['deliverables'] = deliverables.slice(0, TASK_GET_DELIVERABLES_DEFAULT);
              taskObj['_deliverablesTruncated'] = { total: deliverables.length, showing: TASK_GET_DELIVERABLES_DEFAULT, hint: 'Use full=true to see all' };
            }
          }
          if (ctx.getTaskComments) {
            try {
              const comments = await ctx.getTaskComments(taskId);
              if (!full && comments.length > ENTITY_COMMENTS_DEFAULT) {
                taskObj['comments'] = comments.slice(-ENTITY_COMMENTS_DEFAULT);
                taskObj['_commentsTruncated'] = { total: comments.length, showing: ENTITY_COMMENTS_DEFAULT, hint: 'Use full=true to see all' };
              } else {
                taskObj['comments'] = comments;
              }
            } catch { /* non-fatal */ }
          }
          if (ctx.getStatusHistory) {
            try {
              const history = await ctx.getStatusHistory('task', taskId);
              if (!full && history.length > TASK_GET_STATUS_HISTORY_DEFAULT) {
                taskObj['statusHistory'] = history.slice(-TASK_GET_STATUS_HISTORY_DEFAULT);
                taskObj['_statusHistoryTruncated'] = { total: history.length, showing: TASK_GET_STATUS_HISTORY_DEFAULT, hint: 'Use full=true to see all' };
              } else {
                taskObj['statusHistory'] = history;
              }
            } catch { /* non-fatal */ }
          }
          return JSON.stringify({ status: 'success', task: taskObj });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },

    ...(ctx.requestTaskApproval
      ? [
          {
            name: 'task_request_approval',
            description:
              'Re-initiate the creation-approval gate for a task you own after it was sent back (changes requested / 打回). A send-back performs no state transition: the task stays `pending`, the reviewer\'s feedback lands as a task comment, and this tool is the third step that re-opens the gate after you have revised the title/description with task_update. Fails with an actionable error when the task is not `pending` or already has an active approval.',
            inputSchema: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: 'The pending task whose creation approval should be re-initiated' },
              },
              required: ['task_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const result = await ctx.requestTaskApproval!(args['task_id'] as string);
                return JSON.stringify({
                  status: 'success',
                  message: 'Creation approval re-initiated — the reviewer has been asked to decide again.',
                  taskId: result.taskId,
                  approvalId: result.approvalId,
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.askAgent
      ? [
          {
            name: 'agent_ask_agent',
            description: [
              'Ask ONE other agent a question and WAIT for their answer. This call BLOCKS your turn — you get the answer back here and continue from it.',
              'Use it when you need a decision, a fact you cannot verify yourself, or a check from the agent who owns that area. Without the answer, continuing would be guessing.',
              'Ask a specific, answerable question and give them the context they need (task id, file:line, what you already ruled out). One question per call.',
              'Prefer this over asking in a task comment thread: a blocking answer comes back inside your turn, with no round-trip and no thread to re-read.',
              'If the answer is a judgement call about a frozen fact, ask the owner of that fact. If it is about priorities or scope, ask the human with request_user_input instead.',
              'Deadlock protection: an agent that is itself answering such a question cannot ask another agent (the tool is removed from their toolset for that turn) — they can still ask the human. So chains never nest.',
              'On timeout you may proceed on your best judgement and say explicitly which assumption you used.',
              'An EMPTY answer is still an answer — the agent had nothing to add. If that leaves you short, sharpen the question and ask again.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                agent_id: { type: 'string', description: 'Agent ID to ask (agent_list_colleagues to find it)' },
                question: { type: 'string', description: 'The single question, answerable in a paragraph' },
                context: { type: 'string', description: 'Optional: the facts they need — task id, file:line, what you already ruled out' },
                timeout_seconds: { type: 'number', description: 'Max wait in seconds (default 300, max 900)' },
              },
              required: ['agent_id', 'question'],
            },
            async execute(args: Record<string, unknown>) {
              try {
                const result = await ctx.askAgent!(
                  args['agent_id'] as string,
                  args['question'] as string,
                  args['context'] as string | undefined,
                  args['timeout_seconds'] as number | undefined,
                );
                // An empty reply is a legitimate answer (owner ruling 2026-10-18):
                // say so instead of making the caller treat it as a failure.
                if (result.status === 'answered' && !(result.answer ?? '').trim()) {
                  return JSON.stringify({
                    ...result,
                    message: 'The agent returned an EMPTY answer — that counts as answered (they had nothing to add). If you need more, sharpen the question and ask again.',
                  });
                }
                return JSON.stringify(result);
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.addTaskNote
      ? [
          {
            name: 'task_note',
            description:
              'Add a one-way progress note to a task\'s timeline log without changing its status. Use this to record intermediate findings, decisions, or milestones. It wakes nobody — if another agent must act, use task_comment with a mention; if a fact/goal changed, use task_update.',
            inputSchema: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: 'The task ID to add a note to' },
                note: { type: 'string', description: 'The note or progress update to add' },
              },
              required: ['task_id', 'note'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                await ctx.addTaskNote!(
                  args['task_id'] as string,
                  args['note'] as string,
                  ctx.agentName
                );
                return JSON.stringify({ status: 'success', message: 'Note added to task' });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.assignTask
      ? [
          {
            name: 'task_assign',
            description:
              'Assign a task to a specific agent. Use this when delegating work to team members.',
            inputSchema: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: 'The task ID to assign' },
                agent_id: { type: 'string', description: 'The agent ID to assign the task to' },
              },
              required: ['task_id', 'agent_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const result = await ctx.assignTask!(
                  args['task_id'] as string,
                  args['agent_id'] as string
                );
                return JSON.stringify({
                  status: 'success',
                  taskId: result.id,
                  taskStatus: result.status,
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.addSubtask
      ? [
          {
            name: 'subtask_create',
            description: [
              'Create a subtask under a task to break down complex work into trackable steps.',
              'Use this to decompose your current task into smaller, actionable items.',
              'Mark each subtask completed as you finish it — subtasks do not require separate review.',
              'When all subtasks are done, finish the parent task normally — execution completion triggers review automatically.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: 'The task ID to add this subtask to' },
                title: {
                  type: 'string',
                  description:
                    'Clear, action-oriented subtask title in the user\'s language (e.g. Chinese user → 「调研竞品定价」, not English-only)',
                },
              },
              required: ['task_id', 'title'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const { SUBTASK_SOFT_CAP } = await import('@markus/shared');
                const taskId = args['task_id'] as string;
                const sub = await ctx.addSubtask!(taskId, args['title'] as string);
                const subMeta = sub as unknown as { parentSubtaskCount?: number };
                const count = typeof subMeta.parentSubtaskCount === 'number'
                  ? subMeta.parentSubtaskCount
                  : undefined;
                const warning = count !== undefined && count >= SUBTASK_SOFT_CAP
                  ? `Subtask count (${count}) exceeds soft cap ${SUBTASK_SOFT_CAP} — prefer fewer, larger steps.`
                  : undefined;
                return JSON.stringify({
                  status: 'success',
                  subtask: sub,
                  ...(warning ? { warning } : {}),
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
          {
            name: 'subtask_complete',
            description: [
              'Mark a subtask as completed. This is the ONLY way to complete subtasks — do NOT use task_update for this.',
              'Requires both task_id (tsk_-prefixed parent task ID) and subtask_id (sub_-prefixed subtask ID).',
              'If you don\'t know the subtask_id, call subtask_list first to get IDs.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: 'The parent task ID (tsk_-prefixed). This is NOT the subtask ID.' },
                subtask_id: { type: 'string', description: 'The subtask ID to mark as completed (sub_-prefixed). Get this from subtask_list or subtask_create results.' },
              },
              required: ['task_id', 'subtask_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const taskId = args['task_id'] as string | undefined;
                const subtaskId = args['subtask_id'] as string | undefined;
                if (!taskId?.trim()) {
                  return JSON.stringify({
                    status: 'error',
                    error: 'task_id is required — provide the parent task ID (tsk_-prefixed). Use task_list to find your current task.',
                  });
                }
                if (!subtaskId?.trim()) {
                  return JSON.stringify({
                    status: 'error',
                    error: 'subtask_id is required — provide the subtask ID (sub_-prefixed). Call subtask_list with the parent task_id to get subtask IDs.',
                  });
                }
                const result = await ctx.completeSubtask!(taskId, subtaskId);
                return JSON.stringify({ status: 'success', subtask: result });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
          ...(ctx.cancelSubtask
            ? [
                {
                  name: 'subtask_cancel',
                  description: [
                    'Cancel a subtask that is no longer applicable. Use this when a subtask was created during planning but is no longer needed',
                    '(e.g., scope changed, approach changed, subtask merged with another).',
                    'Requires task_id, subtask_id, and a reason explaining why it is being cancelled.',
                    'IMPORTANT: task_submit_review will reject submission if any subtask is still pending — you must complete or cancel every subtask before submitting.',
                  ].join(' '),
                  inputSchema: {
                    type: 'object',
                    properties: {
                      task_id: { type: 'string', description: 'The parent task ID (tsk_-prefixed).' },
                      subtask_id: { type: 'string', description: 'The subtask ID to cancel (sub_-prefixed). Get this from subtask_list.' },
                      reason: { type: 'string', description: 'Why this subtask is no longer applicable.' },
                    },
                    required: ['task_id', 'subtask_id', 'reason'],
                  },
                  async execute(args: Record<string, unknown>): Promise<string> {
                    try {
                      const taskId = args['task_id'] as string | undefined;
                      const subtaskId = args['subtask_id'] as string | undefined;
                      const reason = args['reason'] as string | undefined;
                      if (!taskId?.trim()) {
                        return JSON.stringify({
                          status: 'error',
                          error: 'task_id is required — provide the parent task ID (tsk_-prefixed).',
                        });
                      }
                      if (!subtaskId?.trim()) {
                        return JSON.stringify({
                          status: 'error',
                          error: 'subtask_id is required — provide the subtask ID (sub_-prefixed). Call subtask_list to get IDs.',
                        });
                      }
                      if (!reason?.trim()) {
                        return JSON.stringify({
                          status: 'error',
                          error: 'reason is required — explain why this subtask is no longer applicable.',
                        });
                      }
                      const result = await ctx.cancelSubtask!(taskId, subtaskId);
                      return JSON.stringify({ status: 'success', subtask: result, reason: reason.trim() });
                    } catch (error) {
                      return JSON.stringify({ status: 'error', error: String(error) });
                    }
                  },
                } as AgentToolHandler,
              ]
            : []),
          {
            name: 'subtask_list',
            description: 'List all subtasks of a task with their IDs and statuses. Call this to get subtask IDs before using subtask_complete or subtask_cancel. Also useful to check progress on a decomposed task.',
            inputSchema: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: 'The task ID to list subtasks for' },
              },
              required: ['task_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const subtasks = await ctx.getSubtasks!(args['task_id'] as string);
                const done = subtasks.filter(s => s.status === 'completed').length;
                return JSON.stringify({
                  status: 'success',
                  progress: `${done}/${subtasks.length} completed`,
                  subtasks,
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.submitForReview
      ? [
          {
            name: 'task_submit_review',
            description: [
              'Submit your completed work for review. You MUST call this when your task execution is done — the round is NOT complete without it.',
              'Prefer calling from a task session: task_id is auto-filled from the execution context (ALS).',
              'Outside a task session you MUST pass task_id explicitly (the system does not guess from the board).',
              'Provide a summary plus the deliverables a human actually cares about — the final reports/documents/products/datasets you produced (usually one or a few, NOT one entry per file). Do NOT register every code/config/intermediate file you touched as its own deliverable; instead list the relevant code file paths inside the body of one markdown deliverable document.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                task_id: {
                  type: 'string',
                  description: 'Task ID (tsk_-prefixed). Optional inside an active task_execution session (auto-filled). REQUIRED outside that session — do not omit and expect the system to pick a board task.',
                },
                summary: {
                  type: 'string',
                  description: 'What was accomplished and why (2-5 sentences). Include key decisions, results, and any test outcomes.',
                },
                deliverables: {
                  type: 'array',
                  description: 'Human-facing deliverables only — the final reports, documents, products, or datasets a person would open and read (typically 1–3). Do NOT register each code/config/intermediate file separately; reference code changes by file path inside one markdown deliverable document instead. Each item needs a type, reference, and summary.',
                  items: {
                    type: 'object',
                    properties: {
                      type: {
                        type: 'string',
                        enum: ['file', 'directory'],
                        description: 'file = a human-facing file (report, doc, spreadsheet, dataset, product artifact); directory = a folder of such deliverables. Use the deliverable document itself, NOT each source/config file you touched.',
                      },
                      reference: {
                        type: 'string',
                        description: 'File path, directory path, URL, or inline text content depending on type',
                      },
                      summary: { type: 'string', description: 'Brief description of this deliverable' },
                    },
                    required: ['type', 'reference', 'summary'],
                  },
                },
                known_issues: {
                  type: 'string',
                  description: 'Any known issues, limitations, or follow-up items (optional)',
                },
              },
              required: ['summary'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const summary = args['summary'] as string;
                if (!summary || summary.trim().length === 0) {
                  return JSON.stringify({ status: 'error', error: 'summary is required — describe what you accomplished.' });
                }

                let parsedDeliverables: Array<{ type?: string; reference: string; summary: string }> | undefined;
                let rawDel = args['deliverables'];
                if (typeof rawDel === 'string') {
                  try { rawDel = JSON.parse(rawDel); } catch { /* leave as-is */ }
                }
                if (Array.isArray(rawDel)) {
                  parsedDeliverables = rawDel
                    .filter((d): d is Record<string, unknown> =>
                      d !== null && typeof d === 'object' && !Array.isArray(d)
                      && typeof (d as Record<string, unknown>).reference === 'string'
                      && ((d as Record<string, unknown>).reference as string).length > 0
                    )
                    .map(d => ({
                      type: typeof d.type === 'string' ? d.type : 'file',
                      reference: d.reference as string,
                      summary: typeof d.summary === 'string' && (d.summary as string).length > 0
                        ? d.summary as string
                        : String(d.reference),
                    }));
                }

                const explicitTaskId = args['task_id'] as string | undefined;
                const result = await ctx.submitForReview!(
                  summary,
                  parsedDeliverables,
                  args['known_issues'] as string | undefined,
                  explicitTaskId?.trim() || undefined,
                );
                return JSON.stringify({
                  status: 'success',
                  taskId: result.id,
                  taskStatus: result.status,
                  message: `Work submitted for review. ${parsedDeliverables?.length ? `${parsedDeliverables.length} deliverable(s) recorded.` : 'No human-facing deliverables recorded — if you produced a report/doc/product, add it next time (code paths go inside that doc, not as separate entries).'}`,
                });
              } catch (error) {
                const msg = String(error);
                if (msg.includes('No active task') || msg.includes('No in_progress task')) {
                  return JSON.stringify({
                    status: 'error',
                    error: 'Cannot submit for review: no active task found in your execution context. Provide task_id explicitly if you are working outside a task execution session. Use task_list to find the task ID.',
                  });
                }
                return JSON.stringify({ status: 'error', error: msg });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.proposeRequirement
      ? [
          {
            name: 'requirement_propose',
            description: [
              'Propose a new requirement (需求) for user review.',
              'Use this ONLY when the work genuinely needs the requirement→task lifecycle: it must continue asynchronously (the human will step away), involve another agent, need a formal review/audit trail, or span ≥2 modules / a data migration / a cross-team boundary.',
              'BEFORE proposing, ask whether it deserves a requirement at all. If one person can finish it in half a day, with no migration and no cross-team work, and no formal audit trail is needed, do NOT propose a requirement — just do the work in the conversation. Every requirement adds an approval round-trip and a notification storm; spend it only where it buys something.',
              'The proposal will be reviewed by a human user who decides whether to approve or reject it.',
              'Do NOT create tasks directly — propose a requirement first and wait for approval.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description:
                    'Clear, concise title in the user\'s language (match User locale / their messages — not English by default)',
                },
                description: {
                  type: 'string',
                  description:
                    'Detailed explanation of what needs to be done, why, and expected outcome — in the user\'s language',
                },
                priority: {
                  type: 'string',
                  enum: ['low', 'medium', 'high', 'urgent'],
                  description: 'Suggested priority (default: medium)',
                },
                project_id: {
                  type: 'string',
                  description: 'Project ID this requirement belongs to (required)',
                },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional: tags to categorize this requirement',
                },
              },
              required: ['title', 'description', 'project_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const req = await ctx.proposeRequirement!({
                  title: args['title'] as string,
                  description: args['description'] as string,
                  priority: args['priority'] as string | undefined,
                  projectId: args['project_id'] as string | undefined,
                  tags: args['tags'] as string[] | undefined,
                });
                log.info(`Requirement proposed by agent ${ctx.agentId}`, {
                  requirementId: req.id,
                  title: req.title,
                });
                return JSON.stringify({
                  status: 'success',
                  requirement: req,
                  message: `Requirement proposed: "${req.title}" (ID: ${req.id}). It will be reviewed by a human user. Do NOT create tasks for this until it is approved.`,
                });
              } catch (error) {
                log.error('requirement_propose failed', { error: String(error) });
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.listRequirements
      ? [
          {
            name: 'requirement_list',
            description: [
              'List requirements (需求) to see what work is authorized.',
              'Only tasks linked to approved requirements should be created.',
              'Use this to understand the current priorities and find requirements to work on.',
              'Set mine_only=true to see only requirements you proposed (useful during heartbeat to check your proposals).',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                status: {
                  type: 'string',
                  enum: [
                    'pending',
                    'in_progress',
                    'completed',
                    'rejected',
                    'cancelled',
                  ],
                  description: 'Filter by status (default: shows all statuses)',
                },
                project_id: {
                  type: 'string',
                  description: 'Optional: filter by project',
                },
                mine_only: {
                  type: 'boolean',
                  description: 'If true, only show requirements created by you',
                },
              },
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const allReqs = await ctx.listRequirements!({
                  status: args['status'] as string | undefined,
                  projectId: args['project_id'] as string | undefined,
                  createdBy: args['mine_only'] ? ctx.agentId : undefined,
                });
                const truncated = allReqs.length > REQUIREMENT_LIST_DEFAULT;
                const reqs = truncated ? allReqs.slice(0, REQUIREMENT_LIST_DEFAULT) : allReqs;
                return JSON.stringify({
                  status: 'success',
                  total: allReqs.length,
                  count: reqs.length,
                  ...(truncated ? { _truncated: { total: allReqs.length, showing: REQUIREMENT_LIST_DEFAULT, hint: 'Use status filter to narrow results' } } : {}),
                  requirements: reqs.map(r => ({
                    id: r.id,
                    title: r.title,
                    description: r.description?.slice(0, 300),
                    status: r.status,
                    priority: r.priority,
                    source: r.source,
                    createdBy: r.createdBy,
                    taskIds: r.taskIds,
                    taskCount: r.taskIds.length,
                  })),
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.getRequirement
      ? [
          {
            name: 'requirement_get',
            description: [
              'Get full details of a single requirement (需求) by ID.',
              'Returns description, status, linked tasks, comments, and metadata.',
              'Use this when you need the complete context for a requirement — requirement_list only returns summaries.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                requirement_id: {
                  type: 'string',
                  description: 'The requirement ID to look up',
                },
              },
              required: ['requirement_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const reqId = args['requirement_id'] as string;
                const req = await ctx.getRequirement!(reqId);
                if (!req) {
                  return JSON.stringify({ status: 'error', error: 'Requirement not found' });
                }
                const result: Record<string, unknown> = { ...req };
                const comments = result['comments'] as unknown[] | undefined;
                if (comments && comments.length > ENTITY_COMMENTS_DEFAULT) {
                  result['comments'] = comments.slice(-ENTITY_COMMENTS_DEFAULT);
                  result['_commentsTruncated'] = { total: comments.length, showing: ENTITY_COMMENTS_DEFAULT, hint: 'Most recent shown' };
                }
                if (ctx.getStatusHistory) {
                  try {
                    const history = await ctx.getStatusHistory('requirement', reqId);
                    if (history.length > TASK_GET_STATUS_HISTORY_DEFAULT) {
                      result['statusHistory'] = history.slice(-TASK_GET_STATUS_HISTORY_DEFAULT);
                      result['_statusHistoryTruncated'] = { total: history.length, showing: TASK_GET_STATUS_HISTORY_DEFAULT, hint: 'Use full=true to see all' };
                    } else {
                      result['statusHistory'] = history;
                    }
                  } catch { /* non-fatal */ }
                }
                return JSON.stringify({ status: 'success', requirement: result });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.updateRequirementStatus
      ? [
          {
            name: 'requirement_update_status',
            description: [
              'Update the status of a requirement (需求). Supports: cancelled, rejected, completed.',
              'WARNING: Only use this when absolutely necessary or when explicitly instructed by a human administrator.',
              'Do NOT change the status of existing requirements without a very strong reason.',
              'Valid reasons include: the requirement is no longer relevant, it duplicates another requirement,',
              'all of its tasks are done (status="completed"),',
              'or a human admin explicitly asked you to cancel/reject it.',
              'Always provide a clear reason explaining why the status change is needed.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                requirement_id: {
                  type: 'string',
                  description: 'The requirement ID to update',
                },
                status: {
                  type: 'string',
                  enum: ['cancelled', 'rejected', 'completed'],
                  description: 'New status. "completed" when all linked work is done, "cancelled" to abandon the requirement, or "rejected" to reject a proposed requirement.',
                },
                reason: {
                  type: 'string',
                  description: 'Required: clear explanation of why this status change is necessary',
                },
              },
              required: ['requirement_id', 'status', 'reason'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const unknownArgError = rejectUnknownArgs('requirement_update_status', args, [
                  'requirement_id',
                  'status',
                  'reason',
                ]);
                if (unknownArgError) return unknownArgError;
                // BUG-3b (2026-10-18): the schema enum was narrower than the
                // service's VALID_STATUSES, so callers followed the documented
                // contract and lost `completed`. Enforce the advertised set here
                // so an unsupported value fails loud instead of drifting.
                const requestedStatus = args['status'] as string;
                if (!REQUIREMENT_AGENT_STATUSES.includes(requestedStatus)) {
                  return JSON.stringify({
                    status: 'error',
                    error: `Unsupported requirement status "${requestedStatus}". This tool accepts: ${REQUIREMENT_AGENT_STATUSES.join(', ')}.`,
                  });
                }
                const req = await ctx.updateRequirementStatus!(
                  args['requirement_id'] as string,
                  requestedStatus,
                  args['reason'] as string
                );
                log.info(`Requirement status updated by agent ${ctx.agentId}`, {
                  requirementId: req.id,
                  newStatus: req.status,
                  reason: args['reason'],
                });
                return JSON.stringify({
                  status: 'success',
                  requirement: req,
                  message: `Requirement "${req.title}" (ID: ${req.id}) status changed to ${req.status}.`,
                });
              } catch (error) {
                log.error('requirement_update_status failed', { error: String(error) });
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.updateRequirement
      ? [
          {
            name: 'requirement_update',
            description: [
              'Update a requirement\'s fields (title, description, priority, or tags).',
              'Use this to refine requirement details, add missing information, or correct errors.',
              'Only provide the fields you want to change.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                requirement_id: {
                  type: 'string',
                  description: 'The requirement ID to update',
                },
                title: {
                  type: 'string',
                  description: 'Updated title (if changing)',
                },
                description: {
                  type: 'string',
                  description: 'Updated description (if changing)',
                },
                priority: {
                  type: 'string',
                  enum: ['low', 'medium', 'high', 'urgent'],
                  description: 'Updated priority (if changing)',
                },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Updated tags (if changing)',
                },
                project_id: {
                  type: 'string',
                  description:
                    'Correct the requirement\'s project reference (must be an existing project id). ' +
                    'This is the repair path for a requirement whose project_id is wrong or missing — ' +
                    'tasks inherit it, so fixing it here unblocks re-linking cards onto this requirement.',
                },
              },
              required: ['requirement_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                // BUG-3 (2026-10-18): `status` used to be accepted and silently
                // dropped. Point the caller at the tool that actually moves status.
                if (args['status'] !== undefined) {
                  return JSON.stringify({
                    status: 'error',
                    error:
                      'requirement_update does NOT change status — it only edits title/description/priority/tags. NOTHING was changed. Use requirement_update_status(requirement_id, status, reason) for status changes (e.g. status="completed").',
                  });
                }
                const unknownArgError = rejectUnknownArgs('requirement_update', args, [
                  'requirement_id',
                  'title',
                  'description',
                  'priority',
                  'tags',
                  'project_id',
                ]);
                if (unknownArgError) return unknownArgError;
                const data: { title?: string; description?: string; priority?: string; tags?: string[]; projectId?: string | null } = {};
                if (args['title']) data.title = args['title'] as string;
                if (args['description']) data.description = args['description'] as string;
                if (args['priority']) data.priority = args['priority'] as string;
                if (args['tags']) data.tags = args['tags'] as string[];
                // Empty string clears the reference; a non-empty id is validated by the service.
                if (args['project_id'] !== undefined) data.projectId = (args['project_id'] as string) || null;
                const req = await ctx.updateRequirement!(
                  args['requirement_id'] as string,
                  data
                );
                return JSON.stringify({
                  status: 'success',
                  requirement: req,
                  message: `Requirement "${req.title}" (ID: ${req.id}) updated successfully.`,
                });
              } catch (error) {
                log.error('requirement_update failed', { error: String(error) });
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.resubmitRequirement
      ? [
          {
            name: 'requirement_resubmit',
            description: [
              'Resubmit a rejected requirement for review.',
              'Use this after a requirement has been rejected — update the content to address the feedback and resubmit in one step.',
              'The requirement will return to pending status for human re-review.',
              'You can include updated title, description, priority, or tags to refine the proposal.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                requirement_id: {
                  type: 'string',
                  description: 'The rejected requirement ID to resubmit',
                },
                title: {
                  type: 'string',
                  description: 'Updated title (optional, provide if addressing feedback)',
                },
                description: {
                  type: 'string',
                  description: 'Updated description (optional, provide if addressing feedback)',
                },
                priority: {
                  type: 'string',
                  enum: ['low', 'medium', 'high', 'urgent'],
                  description: 'Updated priority (optional)',
                },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Updated tags (optional)',
                },
              },
              required: ['requirement_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const updates: { title?: string; description?: string; priority?: string; tags?: string[] } = {};
                if (args['title']) updates.title = args['title'] as string;
                if (args['description']) updates.description = args['description'] as string;
                if (args['priority']) updates.priority = args['priority'] as string;
                if (args['tags']) updates.tags = args['tags'] as string[];
                const hasUpdates = Object.keys(updates).length > 0;
                const req = await ctx.resubmitRequirement!(
                  args['requirement_id'] as string,
                  hasUpdates ? updates : undefined,
                );
                return JSON.stringify({
                  status: 'success',
                  requirement: req,
                  message: `Requirement "${req.title}" (ID: ${req.id}) has been resubmitted for review${hasUpdates ? ' with updates' : ''}.`,
                });
              } catch (error) {
                log.error('requirement_resubmit failed', { error: String(error) });
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    // ── Comment tools (structured comments with @mention support) ──

    ...(ctx.postTaskComment
      ? [
          {
            name: 'task_comment',
            description: [
              'Post a comment on a task — this is an EXECUTION RECORD, not a change request.',
              'Use it for: what I did, what I found, what is next, a status note others may need later.',
              'WRONG use of this tool (the #1 source of noise): announcing a fact/goal change, or restating what someone already wrote. If the goal, scope, or a frozen fact changes, edit the card with task_update (title/description) — a comment is not read by the next agent.',
              'To ask a specific agent to act, put their agent ID in mentions — that is the ONLY thing that wakes another agent. No mention ⇒ nobody is notified. Never mention for FYI.',
              'At most ONE open question per card: use agent_ask_agent to get the answer you need, then act on it — do not argue in the thread.',
              'One short comment; never one per point, never a follow-up just to acknowledge. If nothing is needed from anyone, write nothing (end_turn).',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: 'The task ID to comment on' },
                content: { type: 'string', description: 'The execution record: what you did / found / need next. Not for changing facts (use task_update) and not for restating what someone already said.' },
                mentions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Agent IDs you are ASKING TO ACT. This is the only wakeup signal — no mention means nobody is notified. Never mention for FYI. Use agent_list_colleagues to find IDs.',
                },
                reply_to_comment_id: {
                  type: 'string',
                  description: 'Optional. The ID of a specific comment you are replying to (from task_get comments). Creates a structural reply link visible in the UI.',
                },
              },
              required: ['task_id', 'content'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const taskId = args['task_id'] as string;
                const content = args['content'] as string | undefined;
                if (!content?.trim()) {
                  return JSON.stringify({ status: 'error', error: 'content is required and must be a non-empty string' });
                }
                const mentions = (args['mentions'] as string[] | undefined) ?? [];
                const replyToId = args['reply_to_comment_id'] as string | undefined;
                const activityId = ctx.getCurrentActivityId?.();
                const result = await ctx.postTaskComment!(taskId, content, mentions, activityId, replyToId);
                return JSON.stringify({
                  status: 'success',
                  commentId: result.id,
                  message: `Comment posted on task ${taskId}${mentions.length > 0 ? ` (notified ${mentions.length} agent(s))` : ''}${replyToId ? ` (replying to ${replyToId})` : ''}`,
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.postRequirementComment
      ? [
          {
            name: 'requirement_comment',
            description: [
              'Post a comment on a requirement for discussion, clarification, or status updates.',
              'Supports @mentions to notify other agents. Supports reply_to_comment_id to create a structural reply link.',
              'Use this to coordinate on requirement planning, ask questions about scope, or provide updates on progress.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                requirement_id: { type: 'string', description: 'The requirement ID to comment on' },
                content: { type: 'string', description: 'The comment text' },
                mentions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of agent IDs to notify about this comment',
                },
                reply_to_comment_id: {
                  type: 'string',
                  description: 'Optional. The ID of a specific comment you are replying to (from requirement_get comments). Creates a structural reply link visible in the UI.',
                },
              },
              required: ['requirement_id', 'content'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const requirementId = args['requirement_id'] as string;
                const content = args['content'] as string | undefined;
                if (!content?.trim()) {
                  return JSON.stringify({ status: 'error', error: 'content is required and must be a non-empty string' });
                }
                const mentions = (args['mentions'] as string[] | undefined) ?? [];
                const replyToId = args['reply_to_comment_id'] as string | undefined;
                const activityId = ctx.getCurrentActivityId?.();
                const result = await ctx.postRequirementComment!(requirementId, content, mentions, activityId, replyToId);
                return JSON.stringify({
                  status: 'success',
                  commentId: result.id,
                  message: `Comment posted on requirement ${requirementId}${mentions.length > 0 ? ` (notified ${mentions.length} agent(s))` : ''}${replyToId ? ` (replying to ${replyToId})` : ''}`,
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    // ── Goal Tools ────────────────────────────────────────────────────────────
    ...(ctx.requirementService
      ? [
          {
            name: 'goal_create',
            description: [
              'Create a new goal — a requirement with an automatic loop that drives progress.',
              'The goal will appear in your heartbeat patrol so you periodically assess progress,',
              'create follow-up tasks, and unblock work until completion criteria are met.',
            ].join(' '),
            inputSchema: {
              type: 'object' as const,
              properties: {
                title: {
                  type: 'string',
                  description: 'Goal title in the user\'s language (match User locale / their messages)',
                },
                description: {
                  type: 'string',
                  description: 'Detailed description of what needs to be achieved, in the user\'s language',
                },
                completion_criteria: {
                  type: 'string',
                  description:
                    'LLM-evaluable completion criteria — write in the user\'s language so humans can read them too',
                },
                max_iterations: { type: 'number', description: 'Safety limit on heartbeat iterations (default: 10)' },
                priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Priority (default: medium)' },
              },
              required: ['title', 'description', 'completion_criteria'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const title = args['title'] as string;
                const description = args['description'] as string;
                const completionCriteria = args['completion_criteria'] as string;
                const maxIterations = (args['max_iterations'] as number) ?? 10;
                const priority = (args['priority'] as string) ?? 'medium';
                if (!title || !description || !completionCriteria) {
                  return JSON.stringify({ status: 'error', error: 'title, description, and completion_criteria are required' });
                }
                const req = await ctx.requirementService!.create({
                  title,
                  description,
                  source: 'agent',
                  createdBy: ctx.agentId!,
                  priority,
                  orgId: ctx.orgId!,
                  status: 'in_progress',
                });
                await ctx.requirementService!.enableGoalLoop(req.id, {
                  completionCriteria,
                  maxIterations,
                  autoResume: true,
                });
                return JSON.stringify({
                  status: 'success',
                  goalId: req.id,
                  message: `Goal "${title}" created with ${maxIterations} max iterations. It will appear in your heartbeat patrol.`,
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
          {
            name: 'goal_update',
            description: 'Update goal configuration — modify criteria, iterations, or enable/disable the loop.',
            inputSchema: {
              type: 'object' as const,
              properties: {
                goal_id: { type: 'string', description: 'Requirement ID of the goal' },
                completion_criteria: { type: 'string', description: 'Updated completion criteria' },
                max_iterations: { type: 'number', description: 'Updated max iterations' },
                loop_enabled: { type: 'boolean', description: 'Enable or disable the goal loop' },
              },
              required: ['goal_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const goalId = args['goal_id'] as string;
                if (!goalId) return JSON.stringify({ status: 'error', error: 'goal_id is required' });
                if (args['loop_enabled'] === false) {
                  await ctx.requirementService!.disableGoalLoop(goalId);
                  return JSON.stringify({ status: 'success', message: `Goal loop disabled for ${goalId}` });
                }
                const updates: Record<string, unknown> = {};
                if (args['completion_criteria']) updates['completionCriteria'] = args['completion_criteria'];
                if (args['max_iterations']) updates['maxIterations'] = args['max_iterations'];
                if (Object.keys(updates).length > 0 || args['loop_enabled'] === true) {
                  const req = ctx.requirementService!.getById(goalId);
                  if (!req) return JSON.stringify({ status: 'error', error: 'Goal not found' });
                  await ctx.requirementService!.enableGoalLoop(goalId, {
                    completionCriteria: (updates['completionCriteria'] as string) ?? req.goalConfig?.completionCriteria ?? '',
                    maxIterations: (updates['maxIterations'] as number) ?? req.goalConfig?.maxIterations ?? 10,
                    autoResume: req.goalConfig?.autoResume ?? true,
                  });
                }
                return JSON.stringify({ status: 'success', message: `Goal ${goalId} updated` });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
          {
            name: 'goal_status',
            description: 'Get a summary of active goals and their progress.',
            inputSchema: {
              type: 'object' as const,
              properties: {
                goal_id: { type: 'string', description: 'Specific goal ID (optional — omit for all active goals)' },
              },
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const goalId = args['goal_id'] as string | undefined;
                if (goalId) {
                  const req = ctx.requirementService!.getById(goalId);
                  if (!req) return JSON.stringify({ status: 'error', error: 'Goal not found' });
                  return JSON.stringify({
                    status: 'success',
                    goal: {
                      id: req.id,
                      title: req.title,
                      reqStatus: req.status,
                      goalConfig: req.goalConfig,
                      taskIds: req.taskIds,
                    },
                  });
                }
                const goals = ctx.requirementService!.getActiveGoals(ctx.orgId!);
                return JSON.stringify({
                  status: 'success',
                  count: goals.length,
                  goals: goals.map(g => ({
                    id: g.id,
                    title: g.title,
                    status: g.status,
                    iteration: g.goalConfig?.currentIteration ?? 0,
                    maxIterations: g.goalConfig?.maxIterations ?? 0,
                    criteria: g.goalConfig?.completionCriteria ?? '',
                  })),
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),
  ];
}
