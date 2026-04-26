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
    offset?: number;
    limit?: number;
  }): { results: Array<{ id: string; type: string; title: string; summary: string; reference: string; status: string; tags: string[]; agentId?: string; projectId?: string; taskId?: string; updatedAt?: string }>; total: number };
  update(id: string, data: {
    title?: string;
    summary?: string;
    reference?: string;
    status?: string;
    type?: string;
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
    teamIds: string[];
  }>;
  getProject(id: string): {
    id: string;
    name: string;
    description: string;
    status: string;
    repositories: Array<{ localPath: string; defaultBranch: string; role: string }>;
    teamIds: string[];
    governancePolicy?: { enabled: boolean; defaultTier: string };
  } | undefined;
  createProject?(opts: {
    orgId: string;
    name: string;
    description: string;
    createdBy?: string;
  }): { id: string; name: string; status: string };
  updateProject?(id: string, data: {
    name?: string;
    description?: string;
    status?: string;
  }): { id: string; name: string; status: string };
}

export interface ProjectToolsContext {
  agentId: string;
  orgId: string;
  webUiBaseUrl?: string;
  projectService?: ProjectServiceBridge;
  requestApproval?: (request: { toolName: string; toolArgs: Record<string, unknown>; reason: string }) => Promise<{ approved: boolean; comment?: string }>;
  getProjectInfo?: (projectId?: string) => Promise<{
    id: string;
    name: string;
    description: string;
    status: string;
    repositories: Array<{ localPath: string; defaultBranch: string; role: string }>;
    teamIds: string[];
    governancePolicy?: { enabled: boolean; defaultTier: string };
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
    reference?: string;
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
                  projects: projects.map(p => ({
                    id: p.id,
                    name: p.name,
                    description: p.description,
                    status: p.status,
                    teamIds: p.teamIds,
                  })),
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
          {
            name: 'get_project',
            description:
              'Get detailed information about a specific project including repositories, teams, and governance policy.',
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
                return JSON.stringify({
                  status: 'success',
                  project: {
                    id: project.id,
                    name: project.name,
                    description: project.description,
                    status: project.status,
                    repoCount: project.repositories?.length ?? 0,
                    teamIds: project.teamIds ?? [],
                    governance: project.governancePolicy?.enabled ? project.governancePolicy.defaultTier : 'none',
                  },
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
          ...(ctx.projectService?.createProject
            ? [
                {
                  name: 'create_project',
                  description:
                    'Create a new project in the organization. Requires user approval before execution.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'Project name' },
                      description: { type: 'string', description: 'What this project is about' },
                    },
                    required: ['name', 'description'],
                  },
                  async execute(args: Record<string, unknown>): Promise<string> {
                    try {
                      const name = args['name'] as string;
                      const description = args['description'] as string;
                      if (ctx.requestApproval) {
                        const { approved, comment } = await ctx.requestApproval({
                          toolName: 'create_project',
                          toolArgs: { name, description },
                          reason: `Agent wants to create project "${name}"`,
                        });
                        if (!approved) return JSON.stringify({ status: 'rejected', reason: comment || 'User denied project creation' });
                      }
                      const project = ctx.projectService!.createProject!({
                        orgId: ctx.orgId,
                        name,
                        description,
                        createdBy: ctx.agentId,
                      });
                      return JSON.stringify({ status: 'success', project: { id: project.id, name: project.name, status: project.status } });
                    } catch (error) {
                      return JSON.stringify({ status: 'error', error: String(error) });
                    }
                  },
                } as AgentToolHandler,
              ]
            : []),
          ...(ctx.projectService?.updateProject
            ? [
                {
                  name: 'update_project',
                  description:
                    'Update an existing project (name, description, or status). Requires user approval before execution.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      project_id: { type: 'string', description: 'The project ID to update' },
                      name: { type: 'string', description: 'New project name (optional)' },
                      description: { type: 'string', description: 'New description (optional)' },
                      status: { type: 'string', enum: ['active', 'paused', 'archived'], description: 'New status (optional)' },
                    },
                    required: ['project_id'],
                  },
                  async execute(args: Record<string, unknown>): Promise<string> {
                    try {
                      const projectId = args['project_id'] as string;
                      const data: { name?: string; description?: string; status?: string } = {};
                      if (args['name']) data.name = args['name'] as string;
                      if (args['description']) data.description = args['description'] as string;
                      if (args['status']) data.status = args['status'] as string;
                      if (ctx.requestApproval) {
                        const { approved, comment } = await ctx.requestApproval({
                          toolName: 'update_project',
                          toolArgs: { project_id: projectId, ...data },
                          reason: `Agent wants to update project ${projectId}`,
                        });
                        if (!approved) return JSON.stringify({ status: 'rejected', reason: comment || 'User denied project update' });
                      }
                      const project = ctx.projectService!.updateProject!(projectId, data);
                      return JSON.stringify({ status: 'success', project: { id: project.id, name: project.name, status: project.status } });
                    } catch (error) {
                      return JSON.stringify({ status: 'error', error: String(error) });
                    }
                  },
                } as AgentToolHandler,
              ]
            : []),
        ]
      : []),
    ...(ctx.getProjectInfo
      ? [
          {
            name: 'project_info',
            description:
              'Get details about your current project: repositories, governance rules, and team composition. Call this when you need to understand your working context.',
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
                return JSON.stringify({
                  status: 'success',
                  project: {
                    id: info.id,
                    name: info.name,
                    description: info.description,
                    status: info.status,
                    repositories: info.repositories?.map(r => ({ path: r.localPath, branch: r.defaultBranch })),
                    teamCount: info.teamIds?.length ?? 0,
                    governance: info.governancePolicy?.enabled ? info.governancePolicy.defaultTier : 'none',
                  },
                });
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
              'Register a deliverable (file, directory, or artifact) that has already been created on disk. Write the actual content to a file FIRST using shell_execute or other file tools, then call this to track it. If the reference path already exists as a deliverable, the existing record is updated instead of creating a duplicate.',
            inputSchema: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['file', 'directory'],
                  description: 'file = any file-based content (docs, reports, code, etc.), directory = folder of files',
                },
                title: { type: 'string', description: 'Clear, searchable title' },
                summary: {
                  type: 'string',
                  description: 'Brief summary describing what this deliverable contains and why it matters (not the full content — the actual content lives in the referenced file)',
                },
                reference: {
                  type: 'string',
                  description: 'Path to the file or directory that contains the actual content (must already exist)',
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
                const resp: Record<string, unknown> = {
                  status: 'success',
                  deliverableId: result.id,
                  deliverableType: result.type,
                  deliverableStatus: result.status,
                };
                if (ctx.webUiBaseUrl) {
                  resp.accessUrl = `${ctx.webUiBaseUrl}/#deliverables`;
                }
                return JSON.stringify(resp);
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
                project_id: { type: 'string', description: 'Filter by project ID (optional)' },
                agent_id: { type: 'string', description: 'Filter by agent ID (optional)' },
                type: {
                  type: 'string',
                  enum: ['file', 'directory'],
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
                  projectId: (args['project_id'] ?? args['projectId']) as string | undefined,
                  agentId: (args['agent_id'] ?? args['agentId']) as string | undefined,
                  type: args['type'] as string | undefined,
                  limit: args['limit'] as number | undefined,
                });
                return JSON.stringify({
                  status: 'success',
                  count: results.length,
                  results: results.map(d => ({
                    id: d.id, type: d.type, title: d.title,
                    summary: d.summary, reference: d.reference,
                    status: d.status, tags: d.tags,
                  })),
                });
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
                project_id: { type: 'string', description: 'Filter by project ID' },
                agent_id: { type: 'string', description: 'Filter by agent ID' },
                type: {
                  type: 'string',
                  enum: ['file', 'directory'],
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
                  projectId: (args['project_id'] ?? args['projectId']) as string | undefined,
                  agentId: (args['agent_id'] ?? args['agentId']) as string | undefined,
                  type: args['type'] as string | undefined,
                  status: args['status'] as string | undefined,
                  limit: args['limit'] as number | undefined,
                });
                return JSON.stringify({
                  status: 'success',
                  count: results.length,
                  results: results.map(d => ({
                    id: d.id, type: d.type, title: d.title,
                    summary: d.summary, reference: d.reference,
                    status: d.status, tags: d.tags,
                    updatedAt: d.updatedAt,
                  })),
                });
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
              "Update a deliverable's metadata: status, title, summary, or tags. This only changes the registry record — to update the actual file content, modify the file directly first, then call this to update the summary.",
            inputSchema: {
              type: 'object',
              properties: {
                deliverable_id: { type: 'string', description: 'The deliverable ID' },
                title: { type: 'string', description: 'New title (optional)' },
                summary: { type: 'string', description: 'Updated brief summary (optional — not the full file content)' },
                reference: { type: 'string', description: 'Updated file path or URL (optional)' },
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
                    reference: args['reference'] as string | undefined,
                    status: args['status'] as string | undefined,
                    tags: args['tags'] as string | undefined,
                  }
                );
                if (!result) return JSON.stringify({ status: 'error', error: 'Deliverable not found' });
                const resp: Record<string, unknown> = { status: 'success', deliverableId: result.id, deliverableStatus: result.status };
                if (ctx.webUiBaseUrl) {
                  resp.accessUrl = `${ctx.webUiBaseUrl}/#deliverables`;
                }
                return JSON.stringify(resp);
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),
  ];
}
