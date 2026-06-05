import type { AgentToolHandler } from '../agent.js';

export interface WorkflowToolsContext {
  teamId: string;
  listWorkflows: () => Array<{
    name: string;
    displayName: string;
    description: string;
    version: string;
    roles: string[];
    hasSchedule: boolean;
    stepCount: number;
    params?: Array<{ name: string; label?: string; type?: string; default?: string; required?: boolean }>;
  }>;
  getWorkflow: (name: string) => unknown | null;
  runWorkflow: (name: string, params: Record<string, string>, projectId: string, roleMapping?: Record<string, string>) => Promise<{
    runId: string;
    runNumber: number;
    requirementId: string;
    taskIds: string[];
  }>;
  listRuns: (name: string, limit?: number) => Promise<Array<{
    id: string;
    runNumber: number;
    status: string;
    taskIds: string[];
    triggeredBy: string;
    startedAt: string;
    completedAt?: string;
  }>>;
  getActiveRuns: () => Array<{
    id: string;
    workflowName: string;
    runNumber: number;
    status: string;
    taskIds: string[];
    startedAt: string;
  }>;
  cancelRun: (runId: string) => Promise<void>;
  addWorkflow: (name: string, yaml: string) => void;
}

export function createWorkflowTools(ctx: WorkflowToolsContext): AgentToolHandler[] {
  return [
    {
      name: 'workflow_list',
      description: 'List all workflow templates available for your team. Shows names, descriptions, step counts, required roles, parameters, and schedule info.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<string> {
        try {
          const workflows = ctx.listWorkflows();
          if (workflows.length === 0) {
            return JSON.stringify({ workflows: [], message: 'No workflow templates found for this team.' });
          }
          return JSON.stringify({
            workflows: workflows.map(w => ({
              name: w.name,
              displayName: w.displayName,
              description: w.description,
              version: w.version,
              roles: w.roles,
              stepCount: w.stepCount,
              hasSchedule: w.hasSchedule,
              params: w.params?.map(p => ({ name: p.name, label: p.label, required: p.required, default: p.default })),
            })),
            count: workflows.length,
          });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },
    {
      name: 'workflow_run',
      description: 'Start a workflow run. This creates a requirement and a set of dependent tasks (DAG) based on the workflow template. Roles are auto-mapped to team members. Provide params as key-value pairs matching the template\'s parameter definitions.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The workflow template name to run.',
          },
          params: {
            type: 'object',
            description: 'Key-value pairs for the workflow parameters. Keys must match the template param names.',
            additionalProperties: { type: 'string' },
          },
          project_id: {
            type: 'string',
            description: 'The project ID to associate this run with.',
          },
          role_mapping: {
            type: 'object',
            description: 'Optional explicit mapping of role names to agent IDs. If omitted, roles are auto-resolved from team members.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['name', 'project_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const name = args['name'] as string;
        const params = (args['params'] as Record<string, string>) ?? {};
        const projectId = args['project_id'] as string;
        const roleMapping = args['role_mapping'] as Record<string, string> | undefined;

        try {
          const result = await ctx.runWorkflow(name, params, projectId, roleMapping);
          return JSON.stringify({
            status: 'success',
            run: result,
            message: `Workflow "${name}" run #${result.runNumber} started with ${result.taskIds.length} tasks.`,
          });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },
    {
      name: 'workflow_status',
      description: 'Check the status of workflow runs. Without a name, shows all active runs. With a name, shows recent run history for that workflow.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Workflow name to check history for. Omit to see all active runs.',
          },
          limit: {
            type: 'number',
            description: 'Number of recent runs to show (default: 5).',
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const name = args['name'] as string | undefined;
        const limit = (args['limit'] as number) ?? 5;

        try {
          if (!name) {
            const active = ctx.getActiveRuns();
            return JSON.stringify({
              activeRuns: active,
              count: active.length,
              message: active.length === 0 ? 'No active workflow runs.' : undefined,
            });
          }

          const runs = await ctx.listRuns(name, limit);
          return JSON.stringify({
            workflow: name,
            runs,
            count: runs.length,
          });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },
    {
      name: 'workflow_cancel',
      description: 'Cancel an active workflow run. This cancels all non-terminal tasks in the run.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: {
            type: 'string',
            description: 'The workflow run ID to cancel.',
          },
        },
        required: ['run_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const runId = args['run_id'] as string;
        try {
          await ctx.cancelRun(runId);
          return JSON.stringify({ status: 'success', message: `Workflow run ${runId} cancelled.` });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },
    {
      name: 'workflow_create',
      description: 'Add a new workflow template to your team. Provide the YAML content for the workflow definition.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The filename/identifier for the workflow (e.g. "content-publishing").',
          },
          yaml: {
            type: 'string',
            description: 'The full YAML content of the workflow template.',
          },
        },
        required: ['name', 'yaml'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const name = args['name'] as string;
        const yaml = args['yaml'] as string;
        try {
          ctx.addWorkflow(name, yaml);
          return JSON.stringify({ status: 'success', message: `Workflow "${name}" created.` });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },
  ];
}
