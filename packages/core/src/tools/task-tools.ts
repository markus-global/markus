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
    assignedAgentId?: string;
    priority?: string;
    parentTaskId?: string;
    requirementId?: string;
    projectId?: string;
    iterationId?: string;
    blockedBy?: string[];
  }) => Promise<{ id: string; title: string; status: string }>;
  /** List tasks — defaults to tasks assigned to this agent */
  listTasks: (filter?: { assignedToMe?: boolean; status?: string; requirementId?: string; projectId?: string }) => Promise<
    Array<{
      id: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      assignedAgentId?: string;
      requirementId?: string;
    }>
  >;
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
  addTaskNote?: (taskId: string, note: string) => Promise<void>;
  /** Submit task deliverables for review */
  submitForReview?: (
    taskId: string,
    summary: string,
    branchName?: string,
    testResults?: string,
    knownIssues?: string
  ) => Promise<{ id: string; status: string }>;
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
  }) => Promise<
    Array<{
      id: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      source: string;
      taskIds: string[];
    }>
  >;
  /** Update a requirement's status (cancel, reject, etc.) */
  updateRequirementStatus?: (
    id: string,
    status: string,
    reason?: string
  ) => Promise<{ id: string; title: string; status: string }>;
}

export function createAgentTaskTools(ctx: AgentTaskContext): AgentToolHandler[] {
  return [
    {
      name: 'task_create',
      description: [
        'Create a new task in the team task board.',
        'Top-level tasks MUST reference an approved requirement_id.',
        'Subtasks (with parent_task_id) inherit the requirement from their parent.',
        'If you want to propose new work, use requirement_propose instead.',
        'IMPORTANT: assigned_agent_id is required in almost all cases — call team_list first to find the right agent.',
        'Only omit assigned_agent_id when it is genuinely unclear who should own the task, and provide reason_unassigned explaining why.',
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
            description: 'Agent ID to assign this task to. REQUIRED in almost all cases. Call team_list first to find the right agent by role/skills. Only omit if it is genuinely unclear who should own this — and then you MUST provide reason_unassigned.',
          },
          reason_unassigned: {
            type: 'string',
            description: 'Required when assigned_agent_id is omitted. Explain why no specific agent can be assigned at this time (e.g. "Waiting for new hire", "Requires cross-team decision"). Do not use vague reasons.',
          },
          parent_task_id: {
            type: 'string',
            description: 'Optional: parent task ID if this is a subtask',
          },
          project_id: {
            type: 'string',
            description: 'Project ID this task belongs to. Typically inherited from the requirement.',
          },
          iteration_id: {
            type: 'string',
            description: 'Iteration ID this task belongs to (optional).',
          },
          blocked_by: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of task IDs that must complete before this task can start. Use this to express dependencies between tasks.',
          },
        },
        required: ['title', 'description'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const assignedAgentId = args['assigned_agent_id'] as string | undefined;
          const reasonUnassigned = args['reason_unassigned'] as string | undefined;

          // Enforce: unassigned tasks must have an explicit reason
          if (!assignedAgentId && !reasonUnassigned) {
            return JSON.stringify({
              status: 'error',
              error: 'assigned_agent_id is required. If you genuinely cannot assign this task yet, provide reason_unassigned explaining why. Call team_list first to find the right agent.',
            });
          }

          const task = await ctx.createTask({
            title: args['title'] as string,
            description: args['description'] as string,
            priority: args['priority'] as string | undefined,
            assignedAgentId,
            parentTaskId: args['parent_task_id'] as string | undefined,
            requirementId: args['requirement_id'] as string | undefined,
            projectId: args['project_id'] as string | undefined,
            iterationId: args['iteration_id'] as string | undefined,
            blockedBy: args['blocked_by'] as string[] | undefined,
          });
          log.info(`Task created by agent ${ctx.agentId}`, { taskId: task.id, title: task.title, assignedAgentId, reasonUnassigned });
          if (task.status === 'pending_approval') {
            return JSON.stringify({
              status: 'pending_approval',
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
        'List tasks from the team task board.',
        'By default shows tasks assigned to you. Use filters to see all tasks or by status.',
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
              'assigned',
              'in_progress',
              'blocked',
              'completed',
              'failed',
              'cancelled',
            ],
            description: 'Filter by status (optional)',
          },
          requirement_id: {
            type: 'string',
            description: 'Filter tasks by requirement ID. Use this to see all tasks under a specific requirement.',
          },
          project_id: {
            type: 'string',
            description: 'Filter tasks by project ID. Use this to see all tasks in a project.',
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const requirementId = args['requirement_id'] as string | undefined;
          const projectId = args['project_id'] as string | undefined;
          // When filtering by requirement or project, default assigned_to_me to false
          const assignedToMeDefault = !requirementId && !projectId;
          const assignedToMe = args['assigned_to_me'] !== undefined
            ? (args['assigned_to_me'] as boolean)
            : assignedToMeDefault;
          const tasks = await ctx.listTasks({
            assignedToMe,
            status: args['status'] as string | undefined,
            requirementId,
            projectId,
          });
          return JSON.stringify({
            status: 'success',
            tasks,
            count: tasks.length,
            summary: tasks.map(t => `[${t.status}] ${t.id}: ${t.title} (${t.priority})${t.requirementId ? ` req:${t.requirementId}` : ''}`).join('\n'),
          });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },

    {
      name: 'task_update',
      description: [
        'Update the status of a task, optionally adding a progress note.',
        'Worker lifecycle: assigned → in_progress → (submit via task_submit_review when done).',
        'Reviewer lifecycle: review → accepted (approve) or revision (request changes) → completed (after all revisions resolved).',
        'IMPORTANT: Workers MUST NOT set status to "completed" directly.',
        'When your work is done, use task_submit_review instead — a reviewer must verify before the task closes.',
        'Always include a progress note explaining what changed.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to update' },
          status: {
            type: 'string',
            enum: ['in_progress', 'blocked', 'revision', 'accepted', 'completed', 'failed', 'cancelled'],
            description: 'New status. Workers: use only in_progress/blocked/failed/cancelled. Reviewers: use accepted/revision/completed.',
          },
          note: {
            type: 'string',
            description:
              'Optional progress note — brief summary of what was done, what is blocked, or next steps',
          },
        },
        required: ['task_id', 'status'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const task = await ctx.updateTaskStatus(
            args['task_id'] as string,
            args['status'] as string
          );
          const note = args['note'] as string | undefined;
          if (note && ctx.addTaskNote) {
            await ctx.addTaskNote(task.id, `[${ctx.agentName}] ${note}`).catch(() => {});
          }
          log.info(`Task updated by agent ${ctx.agentId}`, {
            taskId: task.id,
            status: task.status,
          });
          return JSON.stringify({
            status: 'success',
            task,
            message: `Task "${task.title}" updated to ${task.status}${note ? ` — note recorded` : ''}`,
          });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },

    {
      name: 'task_get',
      description: 'Get detailed information about a specific task by its ID.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to look up' },
        },
        required: ['task_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const task = await ctx.getTask(args['task_id'] as string);
          if (!task) {
            return JSON.stringify({ status: 'error', error: `Task not found: ${args['task_id']}` });
          }
          return JSON.stringify({ status: 'success', task });
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
                  `[${ctx.agentName}] ${args['note'] as string}`
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

    ...(ctx.submitForReview
      ? [
          {
            name: 'task_submit_review',
            description: [
              'Submit your completed work for review.',
              'Provide a summary of changes, the branch name with your commits, and any test results.',
              'The task enters review status and a reviewer will evaluate your deliverables.',
              'After calling this tool, you MUST notify the team: use agent_send_message to inform the reviewer and the project manager,',
              'and use agent_broadcast_status to let all colleagues know you have submitted work and are now available.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: 'The task ID to submit for review' },
                summary: { type: 'string', description: 'What was done and why (2-5 sentences)' },
                branch_name: {
                  type: 'string',
                  description: 'Git branch containing your changes (optional)',
                },
                test_results: { type: 'string', description: 'Test execution results (optional)' },
                known_issues: {
                  type: 'string',
                  description: 'Any known issues or follow-up items (optional)',
                },
              },
              required: ['task_id', 'summary'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const result = await ctx.submitForReview!(
                  args['task_id'] as string,
                  args['summary'] as string,
                  args['branch_name'] as string | undefined,
                  args['test_results'] as string | undefined,
                  args['known_issues'] as string | undefined
                );
                return JSON.stringify({
                  status: 'success',
                  taskId: result.id,
                  taskStatus: result.status,
                  message: 'Work submitted for review. A reviewer will evaluate your deliverables.',
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
            ].join(' '),
            inputSchema: {
              type: 'object',
              properties: {
                status: {
                  type: 'string',
                  enum: [
                    'draft',
                    'pending_review',
                    'approved',
                    'in_progress',
                    'completed',
                    'rejected',
                    'cancelled',
                  ],
                  description: 'Filter by status (default: shows approved and in_progress)',
                },
                project_id: {
                  type: 'string',
                  description: 'Optional: filter by project',
                },
              },
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const reqs = await ctx.listRequirements!({
                  status: args['status'] as string | undefined,
                  projectId: args['project_id'] as string | undefined,
                });
                return JSON.stringify({
                  status: 'success',
                  requirements: reqs,
                  count: reqs.length,
                  summary: reqs
                    .map(
                      r =>
                        `[${r.status}] ${r.id}: ${r.title} (${r.priority}, ${r.source}, ${r.taskIds.length} tasks)`
                    )
                    .join('\n'),
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
  ];
}
