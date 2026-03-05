import type { AgentToolHandler } from '../agent.js';

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
  }) => Promise<{ id: string; status: string }>;
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

    ...(ctx.knowledgeContribute
      ? [
          {
            name: 'knowledge_contribute',
            description:
              'Contribute knowledge to the project or organization knowledge base. Use this when you discover information that other agents working on the same project should know — architectural decisions, coding patterns, API details, gotchas, troubleshooting tips.',
            inputSchema: {
              type: 'object',
              properties: {
                scope: {
                  type: 'string',
                  enum: ['project', 'org'],
                  description:
                    'Where to save: "project" for current project, "org" for organization-wide',
                },
                category: {
                  type: 'string',
                  enum: [
                    'architecture',
                    'convention',
                    'api',
                    'decision',
                    'gotcha',
                    'troubleshooting',
                    'dependency',
                    'process',
                    'reference',
                  ],
                  description: 'Category of knowledge',
                },
                title: { type: 'string', description: 'Clear, searchable title' },
                content: {
                  type: 'string',
                  description:
                    'Detailed knowledge content. Include context, rationale, and examples.',
                },
                importance: {
                  type: 'number',
                  description: 'Importance 0-100: 80+ critical, 50-79 useful, <50 nice-to-know',
                },
                tags: { type: 'string', description: 'Comma-separated tags for discoverability' },
                supersedes: {
                  type: 'string',
                  description: 'Optional: ID of knowledge entry this replaces',
                },
              },
              required: ['scope', 'category', 'title', 'content'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const result = await ctx.knowledgeContribute!({
                  scope: args['scope'] as string,
                  category: args['category'] as string,
                  title: args['title'] as string,
                  content: args['content'] as string,
                  importance: args['importance'] as number | undefined,
                  tags: args['tags'] as string | undefined,
                  supersedes: args['supersedes'] as string | undefined,
                });
                return JSON.stringify({
                  status: 'success',
                  knowledgeId: result.id,
                  knowledgeStatus: result.status,
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.knowledgeSearch
      ? [
          {
            name: 'knowledge_search',
            description:
              'Search the knowledge base. By default searches your current project. Use scope to search organization-wide or your personal memory.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search keywords or question' },
                scope: {
                  type: 'string',
                  enum: ['personal', 'project', 'org', 'all'],
                  description: 'Search scope (default: project)',
                },
                category: { type: 'string', description: 'Filter by category (optional)' },
                limit: { type: 'number', description: 'Max results (default: 10)' },
              },
              required: ['query'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const results = await ctx.knowledgeSearch!(
                  args['query'] as string,
                  args['scope'] as string | undefined,
                  args['category'] as string | undefined,
                  args['limit'] as number | undefined
                );
                return JSON.stringify({ status: 'success', count: results.length, results });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.knowledgeBrowse
      ? [
          {
            name: 'knowledge_browse',
            description:
              'Browse the project knowledge base by category. Use this to understand what knowledge exists about a topic area.',
            inputSchema: {
              type: 'object',
              properties: {
                category: {
                  type: 'string',
                  description: 'Category to browse (omit for all categories with counts)',
                },
                scope: {
                  type: 'string',
                  enum: ['project', 'org'],
                  description: 'Scope (default: project)',
                },
              },
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const result = await ctx.knowledgeBrowse!(
                  args['category'] as string | undefined,
                  args['scope'] as string | undefined
                );
                return JSON.stringify({ status: 'success', result });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.knowledgeFlagOutdated
      ? [
          {
            name: 'knowledge_flag_outdated',
            description:
              'Flag a knowledge entry as outdated. Use when you find information that is no longer accurate.',
            inputSchema: {
              type: 'object',
              properties: {
                knowledge_id: { type: 'string', description: 'The knowledge entry ID' },
                reason: { type: 'string', description: 'Why this is outdated' },
              },
              required: ['knowledge_id', 'reason'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                await ctx.knowledgeFlagOutdated!(
                  args['knowledge_id'] as string,
                  args['reason'] as string
                );
                return JSON.stringify({
                  status: 'success',
                  message: 'Knowledge entry flagged as outdated',
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
