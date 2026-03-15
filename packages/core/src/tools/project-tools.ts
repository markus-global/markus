import type { AgentToolHandler } from '../agent.js';

export interface KnowledgeServiceBridge {
  contribute(opts: {
    scope: string;
    scopeId: string;
    category: string;
    title: string;
    content: string;
    source: string;
    importance?: number;
    tags?: string[];
    supersedes?: string;
  }): { id: string; status: string };
  search(opts: {
    query: string;
    scope?: string;
    scopeId?: string;
    category?: string;
    limit?: number;
  }): Array<{ id: string; title: string; category: string; content: string; importance: number; filePath?: string }>;
  browse(opts: {
    scope: string;
    scopeId: string;
    category?: string;
  }): Record<string, number> | Array<{ id: string; title: string; content: string }>;
  flagOutdated(id: string, reason: string): void;
  getEntryFilePath?(id: string): string | undefined;
}

export interface DeliverableServiceBridge {
  create(opts: {
    type: string;
    title: string;
    summary: string;
    reference?: string;
    tags?: string[];
    taskId?: string;
    agentId?: string;
    projectId?: string;
    requirementId?: string;
  }): Promise<{ id: string; type: string; title: string; status: string }>;
  search(opts: {
    query?: string;
    projectId?: string;
    agentId?: string;
    taskId?: string;
    type?: string;
    status?: string;
    limit?: number;
  }): Array<{ id: string; type: string; title: string; summary: string; reference: string; status: string; tags: string[]; agentId?: string; projectId?: string; taskId?: string; updatedAt?: string }>;
  update(id: string, data: {
    title?: string;
    summary?: string;
    status?: string;
    tags?: string[];
  }): Promise<{ id: string; status: string } | undefined>;
  list(opts: {
    projectId?: string;
    agentId?: string;
    type?: string;
    status?: string;
    limit?: number;
  }): Array<{ id: string; type: string; title: string; summary: string; reference: string; status: string; tags: string[]; agentId?: string; projectId?: string; taskId?: string; updatedAt?: string }>;
}

export interface ProjectServiceBridge {
  listProjects(orgId?: string): Array<{
    id: string;
    name: string;
    description: string;
    status: string;
    iterationModel: string;
    teamIds: string[];
  }>;
  getProject(id: string): {
    id: string;
    name: string;
    description: string;
    status: string;
    iterationModel: string;
    repositories: Array<{ localPath: string; defaultBranch: string; role: string }>;
    teamIds: string[];
    governancePolicy?: { enabled: boolean; defaultTier: string };
  } | undefined;
  getActiveIteration(projectId: string): {
    id: string;
    name: string;
    goal?: string;
    status: string;
    startDate?: string;
    endDate?: string;
  } | undefined;
  listIterations(projectId: string): Array<{
    id: string;
    name: string;
    status: string;
    goal?: string;
    startDate?: string;
    endDate?: string;
  }>;
}

export interface ProjectToolsContext {
  agentId: string;
  orgId: string;
  projectService?: ProjectServiceBridge;
  getProjectInfo?: (projectId?: string) => Promise<{
    id: string;
    name: string;
    description: string;
    status: string;
    iterationModel: string;
    repositories: Array<{ localPath: string; defaultBranch: string; role: string }>;
    teamIds: string[];
    governancePolicy?: { enabled: boolean; defaultTier: string };
    activeIteration?: { id: string; name: string; goal?: string; status: string; endDate?: string };
  } | null>;
  getIterationStatus?: (iterationId?: string) => Promise<{
    id: string;
    name: string;
    status: string;
    goal?: string;
    startDate?: string;
    endDate?: string;
    taskBreakdown: Record<string, number>;
    completionPercent: number;
    daysRemaining?: number;
    blockers: Array<{ taskId: string; title: string; reason: string }>;
  } | null>;
  knowledgeContribute?: (opts: {
    scope: string;
    category: string;
    title: string;
    content: string;
    importance?: number;
    tags?: string;
    supersedes?: string;
  }) => Promise<{ id: string; status: string; filePath?: string }>;
  knowledgeSearch?: (
    query: string,
    scope?: string,
    category?: string,
    limit?: number
  ) => Promise<
    Array<{ id: string; title: string; category: string; content: string; importance: number }>
  >;
  knowledgeBrowse?: (
    category?: string,
    scope?: string
  ) => Promise<Record<string, number> | Array<{ id: string; title: string; content: string }>>;
  knowledgeFlagOutdated?: (id: string, reason: string) => Promise<void>;

  deliverableCreate?: (opts: {
    type: string;
    title: string;
    summary: string;
    reference?: string;
    tags?: string;
  }) => Promise<{ id: string; type: string; title: string; status: string }>;
  deliverableSearch?: (opts: {
    query?: string;
    projectId?: string;
    agentId?: string;
    type?: string;
    limit?: number;
  }) => Promise<Array<{ id: string; type: string; title: string; summary: string; reference: string; status: string; tags: string[] }>>;
  deliverableList?: (opts: {
    projectId?: string;
    agentId?: string;
    type?: string;
    status?: string;
    limit?: number;
  }) => Promise<Array<{ id: string; type: string; title: string; summary: string; reference: string; status: string; tags: string[]; updatedAt?: string }>>;
  deliverableUpdate?: (id: string, data: {
    title?: string;
    summary?: string;
    status?: string;
    tags?: string;
  }) => Promise<{ id: string; status: string } | undefined>;
}

export function createProjectTools(ctx: ProjectToolsContext): AgentToolHandler[] {
  return [
    ...(ctx.projectService
      ? [
          {
            name: 'list_projects',
            description:
              'List all projects in the organization. Use this to discover available projects before taking action on a specific one.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
            async execute(): Promise<string> {
              try {
                const projects = ctx.projectService!.listProjects(ctx.orgId);
                return JSON.stringify({
                  status: 'success',
                  count: projects.length,
                  projects: projects.map(p => {
                    const activeIteration = ctx.projectService!.getActiveIteration(p.id);
                    return {
                      id: p.id, name: p.name, description: p.description,
                      status: p.status, iterationModel: p.iterationModel,
                      activeIteration: activeIteration
                        ? { id: activeIteration.id, name: activeIteration.name, goal: activeIteration.goal, status: activeIteration.status }
                        : null,
                    };
                  }),
                  hint: 'Use requirement_list with project_id to see requirements, then task_list with requirement_id for tasks.',
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
          {
            name: 'get_project',
            description:
              'Get detailed information about a specific project including repositories, teams, governance policy, and iteration model.',
            inputSchema: {
              type: 'object',
              properties: {
                project_id: {
                  type: 'string',
                  description: 'The project ID',
                },
              },
              required: ['project_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const projectId = args['project_id'] as string;
                const project = ctx.projectService!.getProject(projectId);
                if (!project) return JSON.stringify({ status: 'error', error: 'Project not found' });
                const activeIteration = ctx.projectService!.getActiveIteration(projectId);
                const iterations = ctx.projectService!.listIterations(projectId);
                return JSON.stringify({ status: 'success', project, activeIteration: activeIteration ?? null, iterations });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),
    ...(ctx.getProjectInfo
      ? [
          {
            name: 'project_info',
            description:
              'Get details about your current project: repositories, iteration status, governance rules, and team composition. Call this when you need to understand your working context.',
            inputSchema: {
              type: 'object',
              properties: {
                project_id: {
                  type: 'string',
                  description: 'Project ID (omit for your current project)',
                },
              },
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const info = await ctx.getProjectInfo!(args['project_id'] as string | undefined);
                if (!info) return JSON.stringify({ status: 'error', error: 'No project found' });
                return JSON.stringify({ status: 'success', project: info });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.getIterationStatus
      ? [
          {
            name: 'iteration_status',
            description:
              'Get the current iteration progress: tasks by status, completion percentage, days remaining, and blockers.',
            inputSchema: {
              type: 'object',
              properties: {
                iteration_id: {
                  type: 'string',
                  description: 'Iteration ID (omit for current active iteration)',
                },
              },
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const status = await ctx.getIterationStatus!(
                  args['iteration_id'] as string | undefined
                );
                if (!status)
                  return JSON.stringify({ status: 'error', error: 'No active iteration found' });
                return JSON.stringify({ status: 'success', iteration: status });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.deliverableCreate
      ? [
          {
            name: 'deliverable_create',
            description:
              'Publish a deliverable to the shared team repository. Use for files, documents, reports, research findings, conventions, architectural decisions, gotchas, or troubleshooting tips.',
            inputSchema: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['file', 'document', 'branch', 'report', 'directory', 'url', 'text'],
                  description: 'Type of deliverable',
                },
                title: { type: 'string', description: 'Clear, searchable title' },
                summary: {
                  type: 'string',
                  description: 'Detailed content or description (markdown supported)',
                },
                reference: {
                  type: 'string',
                  description: 'File path, URL, branch name, or directory path',
                },
                tags: { type: 'string', description: 'Comma-separated tags for discoverability' },
              },
              required: ['type', 'title', 'summary'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const result = await ctx.deliverableCreate!({
                  type: args['type'] as string,
                  title: args['title'] as string,
                  summary: args['summary'] as string,
                  reference: args['reference'] as string | undefined,
                  tags: args['tags'] as string | undefined,
                });
                return JSON.stringify({
                  status: 'success',
                  deliverableId: result.id,
                  deliverableType: result.type,
                  deliverableStatus: result.status,
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.deliverableSearch
      ? [
          {
            name: 'deliverable_search',
            description:
              'Search shared deliverables across the team. Search by query, project, type, or agent.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search keywords or question' },
                projectId: { type: 'string', description: 'Filter by project ID (optional)' },
                agentId: { type: 'string', description: 'Filter by agent ID (optional)' },
                type: {
                  type: 'string',
                  enum: ['file', 'document', 'branch', 'report', 'directory', 'url', 'text'],
                  description: 'Filter by deliverable type (optional)',
                },
                limit: { type: 'number', description: 'Max results (default: 20)' },
              },
              required: ['query'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const results = await ctx.deliverableSearch!({
                  query: args['query'] as string,
                  projectId: args['projectId'] as string | undefined,
                  agentId: args['agentId'] as string | undefined,
                  type: args['type'] as string | undefined,
                  limit: args['limit'] as number | undefined,
                });
                return JSON.stringify({ status: 'success', count: results.length, results });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.deliverableList
      ? [
          {
            name: 'deliverable_list',
            description:
              'List deliverables with optional filters (project, type, agent, status).',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'string', description: 'Filter by project ID' },
                agentId: { type: 'string', description: 'Filter by agent ID' },
                type: {
                  type: 'string',
                  enum: ['file', 'document', 'branch', 'report', 'directory', 'url', 'text'],
                  description: 'Filter by type',
                },
                status: {
                  type: 'string',
                  enum: ['active', 'verified', 'outdated'],
                  description: 'Filter by status (default: active)',
                },
                limit: { type: 'number', description: 'Max results (default: 50)' },
              },
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const results = await ctx.deliverableList!({
                  projectId: args['projectId'] as string | undefined,
                  agentId: args['agentId'] as string | undefined,
                  type: args['type'] as string | undefined,
                  status: args['status'] as string | undefined,
                  limit: args['limit'] as number | undefined,
                });
                return JSON.stringify({ status: 'success', count: results.length, results });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.deliverableUpdate
      ? [
          {
            name: 'deliverable_update',
            description:
              "Update a deliverable's status, title, summary, or tags.",
            inputSchema: {
              type: 'object',
              properties: {
                deliverable_id: { type: 'string', description: 'The deliverable ID' },
                title: { type: 'string', description: 'New title (optional)' },
                summary: { type: 'string', description: 'New summary/content (optional)' },
                status: {
                  type: 'string',
                  enum: ['active', 'verified', 'outdated'],
                  description: 'New status (optional)',
                },
                tags: { type: 'string', description: 'New comma-separated tags (optional)' },
              },
              required: ['deliverable_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const result = await ctx.deliverableUpdate!(
                  args['deliverable_id'] as string,
                  {
                    title: args['title'] as string | undefined,
                    summary: args['summary'] as string | undefined,
                    status: args['status'] as string | undefined,
                    tags: args['tags'] as string | undefined,
                  }
                );
                if (!result) return JSON.stringify({ status: 'error', error: 'Deliverable not found' });
                return JSON.stringify({ status: 'success', deliverableId: result.id, deliverableStatus: result.status });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),
  ];
}
