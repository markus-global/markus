import type { AgentToolHandler } from '../agent.js';
import { createLogger } from '@markus/shared';

const log = createLogger('task-tools');

export interface AgentTaskContext {
  agentId: string;
  agentName: string;
  /** Create a new task; returns the created task id */
  createTask: (params: {
    title: string;
    description: string;
    assignedAgentId: string;
    reviewerAgentId: string;
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
  /** Update task fields (description, blockedBy, etc.) — works even for pending tasks */
  updateTaskFields?: (taskId: string, fields: { description?: string; blockedBy?: string[] }) => Promise<{ id: string; title: string; status: string }>;
  /** Cancel a pending task (calls rejectTask under the hood) */
  cancelPendingTask?: (taskId: string) => Promise<{ id: string; title: string; status: string }>;
  /** Add a subtask to a task */
  addSubtask?: (taskId: string, title: string) => Promise<{ id: string; title: string; status: string }>;
  /** Complete a subtask */
  completeSubtask?: (taskId: string, subtaskId: string) => Promise<{ id: string; title: string; status: string }>;
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
  /** Submit completed work for review — system auto-fills task_id, reviewer, and branch */
  submitForReview?: (
    summary: string,
    deliverables?: Array<{ type?: string; reference: string; summary: string }>,
    knownIssues?: string
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
  /** Post a structured comment on a task (with @mention support) */
  postTaskComment?: (taskId: string, content: string, mentions?: string[]) => Promise<{ id: string }>;
  /** Post a structured comment on a requirement (with @mention support) */
  postRequirementComment?: (requirementId: string, content: string, mentions?: string[]) => Promise<{ id: string }>;
}

export function createAgentTaskTools(ctx: AgentTaskContext): AgentToolHandler[] {
  return [
    {
      name: 'task_create',
      description: [
        'Create a new task in the team task board.',
        'Tasks MUST reference an approved requirement_id.',
        'If you want to propose new work, use requirement_propose instead.',
        'IMPORTANT: assigned_agent_id and reviewer_agent_id are REQUIRED — every task must have an assignee and an independent reviewer. Call agent_list_colleagues or team_list first to pick both.',
        'CRITICAL: When creating multiple tasks for a complex goal, you MUST use `blocked_by` to express ALL dependency relationships between them.',
        'Think carefully about the execution order — a task that needs output from another task MUST list that task ID in its `blocked_by` array.',
        'Tasks without dependencies will execute in parallel; tasks with `blocked_by` will wait for their prerequisites to complete first.',
        'Use subtask_create to break a task into smaller steps within a single task.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, clear task title' },
          description: {
            type: 'string',
            description: 'Detailed description of what needs to be done and why',
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
          reviewer_agent_id: {
            type: 'string',
            description:
              'Agent ID who will review deliverables when execution finishes (must differ from the assignee when both are agents). Call agent_list_colleagues (or team_list for managers) to choose a reviewer.',
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
        required: ['title', 'description', 'assigned_agent_id', 'reviewer_agent_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const assignedAgentId = args['assigned_agent_id'] as string | undefined;
          const reviewerAgentId = args['reviewer_agent_id'] as string | undefined;

          if (!assignedAgentId) {
            return JSON.stringify({
              status: 'error',
              error: 'assigned_agent_id is required. Every task must have a responsible person. Call team_list first to find the right agent by role/skills, then set assigned_agent_id.',
            });
          }
          if (!reviewerAgentId?.trim()) {
            return JSON.stringify({
              status: 'error',
              error: 'reviewer_agent_id is required. Every task must have a designated reviewer for when execution finishes. Call team_list to pick a reviewer (e.g. delegator or team manager).',
            });
          }
          if (reviewerAgentId === assignedAgentId) {
            return JSON.stringify({
              status: 'error',
              error: 'reviewer_agent_id must differ from assigned_agent_id — choose an independent reviewer via team_list.',
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
            reviewerAgentId,
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
        'Update a PARENT TASK — add a progress note, change status, update description, modify blocked_by dependencies, or a combination.',
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
          description: {
            type: 'string',
            description: 'Updated task description (optional). Can be used on any task including pending tasks.',
          },
          blocked_by: {
            type: 'array',
            items: { type: 'string' },
            description: 'Update the list of task IDs that block this task. Only the task creator can modify this field. Pass an empty array to clear all blockers.',
          },
        },
        required: ['task_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const taskId = args['task_id'] as string;
          const newStatus = args['status'] as string | undefined;
          const note = args['note'] as string | undefined;
          const description = args['description'] as string | undefined;
          const blockedBy = args['blocked_by'] as string[] | undefined;

          // Permission check: only task creator can modify blocked_by
          if (blockedBy !== undefined) {
            const existing = ctx.getTask ? await ctx.getTask(taskId) : null;
            const createdBy = (existing as Record<string, unknown> | null)?.['createdBy'] as string | undefined;
            if (createdBy && createdBy !== ctx.agentId) {
              return JSON.stringify({
                status: 'denied',
                error: 'Only the task creator can modify blocked_by. You are not the creator of this task.',
              });
            }
          }

          // Handle field updates first — works for any status including pending
          if ((description !== undefined || blockedBy !== undefined) && ctx.updateTaskFields) {
            await ctx.updateTaskFields(taskId, {
              ...(description !== undefined ? { description } : {}),
              ...(blockedBy !== undefined ? { blockedBy } : {}),
            });
          }

          if (newStatus) {
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
              message: `Task "${task.title}" updated to ${task.status}${note ? ` — note recorded` : ''}${description !== undefined ? ' — description updated' : ''}${blockedBy !== undefined ? ' — blocked_by updated' : ''}`,
            });
          } else {
            // No status change — note, description, and/or blocked_by update
            if (!note && description === undefined && blockedBy === undefined) {
              return JSON.stringify({ status: 'error', error: 'Provide at least a status, a note, a description, or blocked_by.' });
            }
            if (note && ctx.addTaskNote) {
              await ctx.addTaskNote(taskId, note, ctx.agentName);
            }
            const task = ctx.getTask ? await ctx.getTask(taskId) : null;
            log.info(`Task updated by agent ${ctx.agentId}`, { taskId, hasNote: !!note, hasDescription: description !== undefined, hasBlockedBy: blockedBy !== undefined });
            return JSON.stringify({
              status: 'success',
              task,
              message: `Task "${task?.title ?? taskId}" updated${note ? ' — note recorded' : ''}${description !== undefined ? ' — description updated' : ''}${blockedBy !== undefined ? ' — blocked_by updated' : ''}`,
            });
          }
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },

    {
      name: 'task_get',
      description: 'Get detailed information about a specific task by its ID. By default returns the latest 10 notes and 10 deliverables. Set full=true to get everything.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to look up' },
          full: { type: 'boolean', description: 'If true, return all notes and deliverables. Default false (latest 10 each).' },
        },
        required: ['task_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const task = await ctx.getTask(args['task_id'] as string);
          if (!task) {
            return JSON.stringify({ status: 'error', error: `Task not found: ${args['task_id']}` });
          }
          const full = args['full'] === true;
          const taskObj = task as Record<string, unknown>;
          if (!full) {
            const notes = taskObj['notes'] as string[] | undefined;
            if (notes && notes.length > 10) {
              taskObj['notes'] = notes.slice(-10);
              taskObj['_notesTruncated'] = { total: notes.length, showing: 10, hint: 'Use full=true to see all' };
            }
            const deliverables = taskObj['deliverables'] as unknown[] | undefined;
            if (deliverables && deliverables.length > 10) {
              taskObj['deliverables'] = deliverables.slice(0, 10);
              taskObj['_deliverablesTruncated'] = { total: deliverables.length, showing: 10, hint: 'Use full=true to see all' };
            }
          }
          return JSON.stringify({ status: 'success', task: taskObj });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },

    ...(ctx.addTaskNote
      ? [
          {
            name: 'task_note',
            description:
              'Add a progress note or comment to a task without changing its status. Use this to log intermediate findings, decisions, or observations while working on a task.',
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
                title: { type: 'string', description: 'Clear, action-oriented subtask title (e.g. "Research competitor pricing", not "research")' },
              },
              required: ['task_id', 'title'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const sub = await ctx.addSubtask!(args['task_id'] as string, args['title'] as string);
                return JSON.stringify({ status: 'success', subtask: sub });
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
                const result = await ctx.completeSubtask!(args['task_id'] as string, args['subtask_id'] as string);
                return JSON.stringify({ status: 'success', subtask: result });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
          {
            name: 'subtask_list',
            description: 'List all subtasks of a task with their IDs and statuses. Call this to get subtask IDs before using subtask_complete. Also useful to check progress on a decomposed task.',
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
              'Submit your completed work for review. You MUST call this when your task is done — execution is NOT considered complete without it.',
              'The system auto-fills task_id, reviewer, and branch from your current execution context.',
              'Provide a summary and list all deliverables (files or directories) you produced.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                summary: {
                  type: 'string',
                  description: 'What was accomplished and why (2-5 sentences). Include key decisions, results, and any test outcomes.',
                },
                deliverables: {
                  type: 'array',
                  description: 'All artifacts produced. Each item needs a type, reference, and summary.',
                  items: {
                    type: 'object',
                    properties: {
                      type: {
                        type: 'string',
                        enum: ['file', 'directory'],
                        description: 'file = any file-based content (source, config, docs, reports, etc.), directory = folder of files',
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

                const result = await ctx.submitForReview!(
                  summary,
                  parsedDeliverables,
                  args['known_issues'] as string | undefined,
                );
                return JSON.stringify({
                  status: 'success',
                  taskId: result.id,
                  taskStatus: result.status,
                  message: `Work submitted for review. ${parsedDeliverables?.length ? `${parsedDeliverables.length} deliverable(s) recorded.` : 'No deliverables recorded — consider adding them next time.'}`,
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
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
              'Use this when you identify work that should be done but no approved requirement exists.',
              'The proposal will be reviewed by a human user who decides whether to approve or reject it.',
              'Do NOT create tasks directly — propose a requirement first and wait for approval.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: 'Clear, concise title describing what is needed',
                },
                description: {
                  type: 'string',
                  description:
                    'Detailed explanation of what needs to be done, why, and expected outcome',
                },
                priority: {
                  type: 'string',
                  enum: ['low', 'medium', 'high', 'urgent'],
                  description: 'Suggested priority (default: medium)',
                },
                project_id: {
                  type: 'string',
                  description: 'Optional: project this requirement belongs to',
                },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional: tags to categorize this requirement',
                },
              },
              required: ['title', 'description'],
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
                  description: 'Filter by status (default: shows in_progress)',
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
                const reqs = await ctx.listRequirements!({
                  status: args['status'] as string | undefined,
                  projectId: args['project_id'] as string | undefined,
                  createdBy: args['mine_only'] ? ctx.agentId : undefined,
                });
                return JSON.stringify({
                  status: 'success',
                  count: reqs.length,
                  requirements: reqs.map(r => ({
                    id: r.id,
                    title: r.title,
                    status: r.status,
                    priority: r.priority,
                    source: r.source,
                    createdBy: r.createdBy,
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

    ...(ctx.updateRequirementStatus
      ? [
          {
            name: 'requirement_update_status',
            description: [
              'Update the status of a requirement (需求). Supports: cancelled, rejected.',
              'WARNING: Only use this when absolutely necessary or when explicitly instructed by a human administrator.',
              'Do NOT change the status of existing requirements without a very strong reason.',
              'Valid reasons include: the requirement is no longer relevant, it duplicates another requirement,',
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
                  enum: ['cancelled', 'rejected'],
                  description: 'New status. Use "cancelled" to cancel a requirement, or "rejected" to reject a proposed requirement.',
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
                const req = await ctx.updateRequirementStatus!(
                  args['requirement_id'] as string,
                  args['status'] as string,
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

    // ── Comment tools (structured comments with @mention support) ──

    ...(ctx.postTaskComment
      ? [
          {
            name: 'task_comment',
            description: [
              'Post a structured comment on a task. Use this for discussion, questions, feedback, or coordination with other agents and humans.',
              'Supports @mentions — include agent IDs in the mentions array to notify them.',
              'Mentioned agents will receive your comment and can reply.',
              'Use this instead of task_note when you want interactive dialogue rather than a one-way progress log.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: 'The task ID to comment on' },
                content: { type: 'string', description: 'The comment text. You can reference agents with @name in the text for readability.' },
                mentions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of agent IDs to notify about this comment. Use agent_list_colleagues to find IDs.',
                },
              },
              required: ['task_id', 'content'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const taskId = args['task_id'] as string;
                const content = args['content'] as string;
                const mentions = (args['mentions'] as string[] | undefined) ?? [];
                const result = await ctx.postTaskComment!(taskId, content, mentions);
                return JSON.stringify({
                  status: 'success',
                  commentId: result.id,
                  message: `Comment posted on task ${taskId}${mentions.length > 0 ? ` (notified ${mentions.length} agent(s))` : ''}`,
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
              'Supports @mentions to notify other agents. Use this to coordinate on requirement planning,',
              'ask questions about scope, or provide updates on progress.',
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
              },
              required: ['requirement_id', 'content'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const requirementId = args['requirement_id'] as string;
                const content = args['content'] as string;
                const mentions = (args['mentions'] as string[] | undefined) ?? [];
                const result = await ctx.postRequirementComment!(requirementId, content, mentions);
                return JSON.stringify({
                  status: 'success',
                  commentId: result.id,
                  message: `Comment posted on requirement ${requirementId}${mentions.length > 0 ? ` (notified ${mentions.length} agent(s))` : ''}`,
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
