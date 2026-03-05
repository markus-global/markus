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
  }) => Promise<{ id: string; title: string; status: string }>;
  /** List tasks — defaults to tasks assigned to this agent */
  listTasks: (filter?: { assignedToMe?: boolean; status?: string }) => Promise<
    Array<{
      id: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      assignedAgentId?: string;
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
            description: 'Optional: agent ID to assign this task to. Omit to leave unassigned.',
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
        },
        required: ['title', 'description'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const task = await ctx.createTask({
            title: args['title'] as string,
            description: args['description'] as string,
            priority: args['priority'] as string | undefined,
            assignedAgentId: args['assigned_agent_id'] as string | undefined,
            parentTaskId: args['parent_task_id'] as string | undefined,
            requirementId: args['requirement_id'] as string | undefined,
            projectId: args['project_id'] as string | undefined,
            iterationId: args['iteration_id'] as string | undefined,
          });
          log.info(`Task created by agent ${ctx.agentId}`, { taskId: task.id, title: task.title });
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
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const assignedToMe = (args['assigned_to_me'] as boolean) ?? true;
          const tasks = await ctx.listTasks({
            assignedToMe,
            status: args['status'] as string | undefined,
          });
          return JSON.stringify({
            status: 'success',
            tasks,
            count: tasks.length,
            summary: tasks.map(t => `[${t.status}] ${t.id}: ${t.title} (${t.priority})`).join('\n'),
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
        'Use this to advance your assigned task through its lifecycle:',
        'assigned → in_progress → completed (or blocked/failed).',
        'Always update task status when you start, finish, or get blocked on a task.',
        'Include a progress note to explain what was done or why the status changed.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to update' },
          status: {
            type: 'string',
            enum: ['in_progress', 'blocked', 'completed', 'failed', 'cancelled'],
            description: 'New status for the task',
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
            description:
              'Submit your completed work for review. Provide a summary of changes, the branch name with your commits, and any test results. The task will enter review status and a reviewer will evaluate your work.',
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
  ];
}
