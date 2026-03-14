import {
  createLogger,
  agentId as genAgentId,
  stripInternalBlocks,
  type AgentConfig,
  type AgentProfile,
  type AgentActivity,
  type IdentityContext,
  type HumanUser,
  type SystemAnnouncement,
  type TaskDeliverable,
  type PathAccessPolicy,
} from '@markus/shared';
import { Agent, type AgentToolHandler, type AgentOptions } from './agent.js';
import type { OrgContext } from './context-engine.js';
import type { LLMRouter } from './llm/router.js';
import { RoleLoader } from './role-loader.js';
import { EventBus } from './events.js';
import { createBuiltinTools } from './tools/builtin.js';
import { MCPClientManager } from './tools/mcp-client.js';
import { createManagerTools } from './tools/manager.js';
import { createA2ATools, type A2AContext } from './tools/a2a.js';
import { createStructuredA2ATools } from './tools/a2a-structured.js';
import { createAgentTaskTools, type AgentTaskContext } from './tools/task-tools.js';
import { createProjectTools, type ProjectServiceBridge, type KnowledgeServiceBridge } from './tools/project-tools.js';
import { createMemoryTools } from './tools/memory.js';
import { SemanticMemorySearch, OpenAIEmbeddingProvider, LocalVectorStore } from './memory/semantic-search.js';
import type { SkillRegistry } from './skills/types.js';
import { SecurityGuard, type SecurityPolicy } from './security.js';
import { A2ABus, DelegationManager, type TaskDelegation } from '@markus/a2a';
import type { TemplateRegistry } from './templates/registry.js';
import type { TemplateInstantiateRequest } from './templates/types.js';
import { join } from 'node:path';
import { mkdirSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { RoleTemplate } from '@markus/shared';

const log = createLogger('agent-manager');

/** Minimal interface that AgentManager needs from TaskService */
export interface RequirementServiceBridge {
  proposeRequirement(request: {
    orgId: string;
    title: string;
    description: string;
    priority?: string;
    source: string;
    createdBy: string;
    projectId?: string;
    tags?: string[];
  }): { id: string; title: string; status: string };
  listRequirements(filters?: {
    orgId?: string;
    status?: string;
    projectId?: string;
  }): Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    source: string;
    taskIds: string[];
  }>;
  updateRequirementStatus(
    id: string,
    status: string,
    userId?: string
  ): { id: string; title: string; status: string };
  rejectRequirement(
    id: string,
    userId: string,
    reason: string
  ): { id: string; title: string; status: string };
  cancelRequirement(id: string): { id: string; title: string; status: string };
}

export interface TaskServiceBridge {
  createTask(request: {
    orgId: string;
    title: string;
    description: string;
    priority?: string;
    assignedAgentId?: string;
    parentTaskId?: string;
    requirementId?: string;
    projectId?: string;
    iterationId?: string;
    blockedBy?: string[];
    createdBy?: string;
    creatorRole?: string;
    taskType?: string;
    scheduleConfig?: {
      cron?: string;
      every?: string;
      runAt?: string;
      timezone?: string;
      maxRuns?: number;
    };
  }): { id: string; title: string; status: string };
  listTasks(filters?: { orgId?: string; status?: string; assignedAgentId?: string; requirementId?: string; projectId?: string }): Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    assignedAgentId?: string;
    requirementId?: string;
  }>;
  updateTaskStatus(id: string, status: string, updatedBy?: string): { id: string; title: string; status: string };
  getTask(
    id: string
  ):
    | {
        id: string;
        title: string;
        description: string;
        status: string;
        priority: string;
        assignedAgentId?: string;
      }
    | undefined;
  assignTask(id: string, agentId: string): { id: string; status: string };
  addTaskNote(id: string, note: string): void;
  updateTask(id: string, data: { description?: string }, updatedBy?: string): { id: string; title: string; status: string };
  submitForReview(taskId: string, deliverables: TaskDeliverable[]): Promise<{ id: string; status: string }> | { id: string; status: string };
  findDuplicateTasks?(orgId: string): Array<{ group: string; tasks: Array<{ id: string; title: string; status: string; createdAt: string }> }>;
  cleanupDuplicateTasks?(orgId: string): { cancelledIds: string[]; count: number };
  getTaskBoardHealth?(orgId: string): Record<string, unknown>;
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CreateAgentRequest {
  name: string;
  roleName: string;
  orgId?: string;
  teamId?: string;
  agentRole?: 'manager' | 'worker';
  skills?: string[];
  heartbeatIntervalMs?: number;
  tools?: AgentToolHandler[];
  orgContext?: OrgContext;
  enableSandbox?: boolean;
  mcpServers?: Record<string, MCPServerConfig>;
  securityPolicy?: SecurityPolicy;
  profile?: AgentProfile;
  /** Override model config: when provided with modelMode 'custom', agent uses this provider */
  llmProvider?: string;
}

export class AgentManager {
  private agents = new Map<string, Agent>();
  private eventBus: EventBus;
  private llmRouter: LLMRouter;
  private roleLoader: RoleLoader;
  private dataDir: string;
  private sharedDataDir?: string;
  private mcpManager: MCPClientManager;
  private globalSecurityPolicy?: SecurityPolicy;
  private globalMcpServers?: Record<string, MCPServerConfig>;
  private skillRegistry?: SkillRegistry;
  private taskService?: TaskServiceBridge;
  private projectService?: ProjectServiceBridge;
  private knowledgeService?: KnowledgeServiceBridge;
  private semanticSearch?: SemanticMemorySearch;
  private requirementService?: RequirementServiceBridge;
  private agentAuditCallback?: (
    agentId: string,
    event: {
      type: string;
      action: string;
      tokensUsed?: number;
      durationMs?: number;
      success: boolean;
      detail?: string;
    }
  ) => void;
  private escalationHandler?: (agentId: string, reason: string) => void;
  private approvalHandler?: (
    agentId: string,
    request: { toolName: string; toolArgs: Record<string, unknown>; reason: string }
  ) => Promise<boolean>;
  private stateChangeHandler?: (
    agentId: string,
    state: { status: string; tokensUsedToday: number; activeTaskIds: string[]; lastError?: string; lastErrorAt?: string; currentActivity?: AgentActivity }
  ) => void;
  private a2aBus: A2ABus;
  private delegationManager: DelegationManager;
  private templateRegistry?: TemplateRegistry;
  private groupChatHandlers?: {
    sendGroupMessage: (
      channelKey: string,
      message: string,
      senderId: string,
      senderName: string
    ) => Promise<string>;
    createGroupChat: (
      name: string,
      creatorId: string,
      creatorName: string,
      memberIds: string[]
    ) => Promise<{ id: string; name: string }>;
    listGroupChats: () => Promise<
      Array<{ id: string; name: string; type: string; channelKey: string }>
    >;
  };

  private buildKnowledgeCallbacks(agentId: string, orgId: string): Pick<
    import('./tools/project-tools.js').ProjectToolsContext,
    'knowledgeContribute' | 'knowledgeSearch' | 'knowledgeBrowse' | 'knowledgeFlagOutdated'
  > {
    if (!this.knowledgeService) return {};
    const ks = this.knowledgeService;
    return {
      knowledgeContribute: async (opts) => {
        const scopeId = opts.scope === 'org' ? orgId : (opts.scope === 'project' ? orgId : agentId);
        const entry = ks.contribute({
          scope: opts.scope as 'project' | 'org',
          scopeId,
          category: opts.category as any,
          title: opts.title,
          content: opts.content,
          source: agentId,
          importance: opts.importance,
          tags: opts.tags?.split(',').map(t => t.trim()).filter(Boolean),
          supersedes: opts.supersedes,
        });
        return { id: entry.id, status: entry.status, filePath: ks.getEntryFilePath?.(entry.id) };
      },
      knowledgeSearch: async (query, scope, category, limit) => {
        const results = ks.search({ query, scope: scope as any, category: category as any, limit });
        return results.map(e => ({
          id: e.id, title: e.title, category: e.category,
          content: e.content, importance: e.importance,
          filePath: ks.getEntryFilePath?.(e.id),
        }));
      },
      knowledgeBrowse: async (category, scope) => {
        return ks.browse({
          scope: (scope ?? 'project') as 'project' | 'org',
          scopeId: orgId,
          category: category as any,
        });
      },
      knowledgeFlagOutdated: async (id, reason) => {
        ks.flagOutdated(id, reason);
      },
    };
  }

  constructor(options: {
    llmRouter: LLMRouter;
    roleLoader?: RoleLoader;
    dataDir?: string;
    sharedDataDir?: string;
    eventBus?: EventBus;
    securityPolicy?: SecurityPolicy;
    mcpServers?: Record<string, MCPServerConfig>;
    skillRegistry?: SkillRegistry;
    taskService?: TaskServiceBridge;
    templateRegistry?: TemplateRegistry;
  }) {
    this.llmRouter = options.llmRouter;
    this.roleLoader = options.roleLoader ?? new RoleLoader();
    this.dataDir = options.dataDir ?? join(homedir(), '.markus', 'agents');
    this.sharedDataDir = options.sharedDataDir;
    this.eventBus = options.eventBus ?? new EventBus();
    this.mcpManager = new MCPClientManager();
    this.globalSecurityPolicy = options.securityPolicy;
    this.globalMcpServers = options.mcpServers;
    this.skillRegistry = options.skillRegistry;
    this.taskService = options.taskService;

    const embeddingApiKey = process.env['OPENAI_API_KEY'] ?? process.env['EMBEDDING_API_KEY'];
    if (embeddingApiKey) {
      const embeddingProvider = new OpenAIEmbeddingProvider({
        apiKey: embeddingApiKey,
        baseUrl: process.env['EMBEDDING_BASE_URL'] ?? process.env['OPENAI_BASE_URL'],
        model: process.env['EMBEDDING_MODEL'],
      });
      const vectorStore = new LocalVectorStore(this.dataDir);
      this.semanticSearch = new SemanticMemorySearch(embeddingProvider, vectorStore);
      this.semanticSearch.initialize().then(ok => {
        if (ok) log.info('Semantic memory search initialized (LocalVectorStore)');
        else log.warn('Semantic memory search initialization failed');
      }).catch(err => {
        log.warn('Semantic memory search init error', { error: String(err) });
      });
    }

    this.a2aBus = new A2ABus();
    this.delegationManager = new DelegationManager(this.a2aBus);
    this.delegationManager.onDelegationReceived(async (envelope, delegation) => {
      const targetAgent = this.agents.get(envelope.to);
      if (!targetAgent) {
        log.warn('Delegation target agent not found', { to: envelope.to });
        return;
      }

      if (this.taskService) {
        const task = this.taskService.createTask({
          orgId: targetAgent.config.orgId,
          title: delegation.title,
          description: delegation.description,
          priority: delegation.priority ?? 'medium',
          assignedAgentId: envelope.to,
          createdBy: envelope.from,
          creatorRole: 'manager',
        });
        log.info('Delegation created real task', {
          taskId: task.id,
          delegatedTo: envelope.to,
          from: envelope.from,
          status: task.status,
        });
      } else {
        // No task service — send as a direct message to the agent
        await targetAgent.handleMessage(
          `[Delegated Task from ${envelope.from}]\nTitle: ${delegation.title}\nDescription: ${delegation.description}\nPriority: ${delegation.priority}`,
          envelope.from,
          { name: envelope.from, role: 'manager' },
          { ephemeral: true }
        );
      }
    });
    this.templateRegistry = options.templateRegistry;
    mkdirSync(this.dataDir, { recursive: true });
  }

  setTaskService(taskService: TaskServiceBridge): void {
    this.taskService = taskService;
  }

  setProjectService(projectService: ProjectServiceBridge): void {
    this.projectService = projectService;
  }

  setRequirementService(requirementService: RequirementServiceBridge): void {
    this.requirementService = requirementService;
  }

  setKnowledgeService(knowledgeService: KnowledgeServiceBridge): void {
    this.knowledgeService = knowledgeService;
  }

  getSharedDataDir(): string | undefined {
    return this.sharedDataDir;
  }

  getDataDir(): string {
    return this.dataDir;
  }

  /**
   * Build a PathAccessPolicy for an agent, including shared workspace
   * and any project repos as read-only paths.
   */
  buildPathPolicy(workspacePath: string, extraReadOnlyPaths?: string[], roleDir?: string): PathAccessPolicy {
    const policy: PathAccessPolicy = {
      primaryWorkspace: workspacePath,
      readOnlyPaths: extraReadOnlyPaths?.length ? [...extraReadOnlyPaths] : undefined,
    };
    if (this.sharedDataDir) {
      policy.sharedWorkspace = this.sharedDataDir;
    }
    if (roleDir) {
      policy.roleDir = roleDir;
    }
    return policy;
  }

  async createAgent(request: CreateAgentRequest): Promise<Agent> {
    const id = genAgentId();
    const role = this.roleLoader.loadRole(request.roleName);
    const agentDataDir = join(this.dataDir, id);
    mkdirSync(agentDataDir, { recursive: true });

    // Copy template role files to agent's own directory for per-agent evolution
    const agentRoleDir = join(agentDataDir, 'role');
    mkdirSync(agentRoleDir, { recursive: true });
    const templateDir = this.roleLoader.resolveTemplateDir(request.roleName);
    if (templateDir) {
      for (const file of ['ROLE.md', 'HEARTBEAT.md', 'POLICIES.md', 'CONTEXT.md']) {
        const src = join(templateDir, file);
        if (existsSync(src)) copyFileSync(src, join(agentRoleDir, file));
      }
    }

    const config: AgentConfig = {
      id,
      name: request.name,
      // Store the template folder name so agents can be restored on restart
      roleId: request.roleName,
      orgId: request.orgId ?? 'default',
      teamId: request.teamId,
      agentRole: request.agentRole ?? 'worker',
      skills: request.skills ?? role.defaultSkills,
      profile: request.profile,
      llmConfig: request.llmProvider
        ? { modelMode: 'custom' as const, primary: request.llmProvider }
        : { modelMode: 'default' as const, primary: this.llmRouter.defaultProviderName },
      channels: [],
      heartbeatIntervalMs: request.heartbeatIntervalMs ?? 30 * 60 * 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Determine workspace: profile.workspacePath or default per-agent directory
    const workspacePath = request.profile?.workspacePath ?? join(this.dataDir, id, 'workspace');
    mkdirSync(workspacePath, { recursive: true });

    const pathPolicy = this.buildPathPolicy(workspacePath, undefined, agentRoleDir);
    const securityAllowlist = [workspacePath, agentRoleDir];
    if (pathPolicy.sharedWorkspace) securityAllowlist.push(pathPolicy.sharedWorkspace);
    if (pathPolicy.readOnlyPaths) securityAllowlist.push(...pathPolicy.readOnlyPaths);

    const basePolicy = request.securityPolicy ?? this.globalSecurityPolicy;
    const security = new SecurityGuard({
      ...basePolicy,
      pathAllowlist: [...(basePolicy?.pathAllowlist ?? []), ...securityAllowlist],
    });
    const agentMeta = {
      agentId: id,
      agentName: request.name,
      teamName: request.teamId,
      orgId: request.orgId ?? 'default',
    };
    const tools = request.tools ?? createBuiltinTools({ agentId: id, agentMeta, security, workspacePath, pathPolicy });

    const agentOpts: AgentOptions = {
      config,
      role,
      llmRouter: this.llmRouter,
      dataDir: agentDataDir,
      tools,
      orgContext: request.orgContext,
      pathPolicy,
      skillRegistry: this.skillRegistry,
    };

    const agent = new Agent(agentOpts);

    // Inject skill instructions and connect skill MCP servers
    if (this.skillRegistry && config.skills.length > 0) {
      const missingSkills = config.skills.filter(s => !this.skillRegistry!.get(s));
      if (missingSkills.length > 0) {
        log.warn(`Agent ${config.name} (${id}) references skills not found in registry`, {
          missing: missingSkills,
          available: this.skillRegistry.list().map(s => s.name),
        });
      }
      const skillInstructions = this.skillRegistry.getInstructionsForSkills(config.skills);
      for (const [skillName, instructions] of skillInstructions) {
        agent.injectSkillInstructions(skillName, instructions);
      }
      if (skillInstructions.size > 0) {
        log.info(`Skill instructions injected for agent ${id}`, { skills: [...skillInstructions.keys()] });
      }

      // Connect MCP servers declared by skills and activate the tools
      for (const skillName of config.skills) {
        const skill = this.skillRegistry.get(skillName);
        if (skill?.manifest.mcpServers) {
          for (const [serverName, serverConfig] of Object.entries(skill.manifest.mcpServers)) {
            try {
              await this.mcpManager.connectServer(serverName, serverConfig);
              const mcpTools = this.mcpManager.getToolHandlers(serverName);
              const toolNames: string[] = [];
              for (const tool of mcpTools) {
                agent.registerTool(tool);
                toolNames.push(tool.name);
              }
              agent.activateTools(toolNames);
              log.info(`Skill ${skillName} MCP server ${serverName} connected for agent ${id}`, {
                toolCount: mcpTools.length,
              });
            } catch (error) {
              log.warn(`Failed to connect skill ${skillName} MCP server ${serverName} for agent ${id}`, {
                error: String(error),
              });
            }
          }
        }
      }
    }

    // Set skill MCP activator callback for runtime activation via discover_tools
    agent.setSkillMcpActivator(async (_skillName, mcpServers) => {
      const tools: AgentToolHandler[] = [];
      for (const [serverName, srvConfig] of Object.entries(mcpServers)) {
        await this.mcpManager.connectServer(serverName, srvConfig);
        tools.push(...this.mcpManager.getToolHandlers(serverName));
      }
      return tools;
    });

    // A2A tools — every agent can message colleagues
    const a2aContext: A2AContext = {
      selfId: id,
      selfName: config.name,
      listColleagues: () =>
        this.listAgents().map(a => {
          try {
            const ag = this.getAgent(a.id);
            return { ...a, skills: ag.config.skills };
          } catch {
            return { ...a, skills: [] };
          }
        }),
      sendMessage: async (targetId: string, message: string, fromId: string, fromName: string) => {
        // Lightweight path: informational broadcasts are stored directly,
        // skipping the expensive LLM call that would cause cascade amplification.
        try {
          const parsed = JSON.parse(message);
          if (parsed.type === 'status_broadcast') {
            const target = this.getAgent(targetId);
            const senderName = parsed.sender?.name ?? fromName;
            const payload = parsed.payload ?? {};
            target.getMemory().writeDailyLog(
              targetId,
              `[Status] ${senderName}: ${payload.status ?? 'unknown'}${payload.currentTask?.title ? ' — ' + payload.currentTask.title : ''}`
            );
            return `Status from ${senderName} noted.`;
          }
        } catch { /* not JSON — fall through to full LLM handling */ }

        const target = this.getAgent(targetId);
        const reply = await target.handleMessage(
          message,
          fromId,
          { name: fromName, role: config.agentRole ?? 'worker' },
          {
            ephemeral: true,
            maxHistory: 15,
          }
        );
        return stripInternalBlocks(reply);
      },
      delegateTask: async (targetId: string, delegation: TaskDelegation) =>
        this.delegationManager.delegateTask(id, delegation, targetId),
      ...(this.groupChatHandlers
        ? {
            sendGroupMessage: this.groupChatHandlers.sendGroupMessage,
            createGroupChat: (name: string, memberIds: string[]) =>
              this.groupChatHandlers!.createGroupChat(name, id, config.name, memberIds),
            listGroupChats: this.groupChatHandlers.listGroupChats,
          }
        : {}),
    };
    for (const tool of createA2ATools(a2aContext)) agent.registerTool(tool);
    for (const tool of createStructuredA2ATools(a2aContext)) agent.registerTool(tool);

    // Memory tools — every agent can save/search/list memories
    for (const tool of createMemoryTools({
      agentId: id,
      agentName: config.name,
      memory: agent.getMemory(),
      semanticSearch: this.semanticSearch,
    })) {
      agent.registerTool(tool);
    }

    if (this.semanticSearch) {
      agent.getContextEngine().setSemanticSearch(this.semanticSearch);
    }

    // Register agent on A2A bus for structured message delivery
    this.a2aBus.registerAgent(id, async envelope => {
      const summary = `[A2A:${envelope.type}] from=${envelope.from}: ${JSON.stringify(envelope.payload).slice(0, 200)}`;
      await agent.handleMessage(
        summary,
        envelope.from,
        { name: envelope.from, role: 'worker' },
        {
          ephemeral: true,
          maxHistory: 10,
        }
      );
    });

    // Task tools — every agent can create/list/update tasks
    if (this.taskService) {
      const ts = this.taskService;
      const orgId = config.orgId;
      const taskCtx: AgentTaskContext = {
        agentId: id,
        agentName: config.name,
        createTask: async params => {
          return ts.createTask({
            orgId,
            title: params.title,
            description: params.description,
            priority: params.priority,
            assignedAgentId: params.assignedAgentId,
            parentTaskId: params.parentTaskId,
            requirementId: params.requirementId,
            projectId: params.projectId,
            iterationId: params.iterationId,
            blockedBy: params.blockedBy,
            taskType: params.taskType,
            scheduleConfig: params.scheduleConfig,
            createdBy: id,
            creatorRole: 'worker',
          });
        },
        listTasks: async filter => {
          return ts.listTasks({
            orgId,
            status: filter?.status,
            assignedAgentId: filter?.assignedToMe ? id : undefined,
            requirementId: filter?.requirementId,
            projectId: filter?.projectId,
          });
        },
        updateTaskStatus: async (taskId, status) => {
          return ts.updateTaskStatus(taskId, status, id);
        },
        getTask: async taskId => {
          return ts.getTask(taskId) ?? null;
        },
        assignTask: async (taskId, agentId) => {
          return ts.assignTask(taskId, agentId);
        },
        addTaskNote: async (taskId, note) => {
          ts.addTaskNote(taskId, note);
        },
        updateTaskFields: async (taskId, fields) => {
          const task = ts.updateTask(taskId, fields, id);
          return { id: task.id, title: task.title, status: task.status };
        },
        submitForReview: async (taskId, summary, branchName, testResults, knownIssues, fileDeliverables) => {
          const deliverables: TaskDeliverable[] = [{
            type: 'branch',
            reference: branchName ?? `task/${taskId}`,
            summary,
            ...(testResults ? { testResults: { passed: 0, failed: 0, skipped: 0 } } : {}),
          }];
          if (knownIssues) {
            deliverables[0].summary += `\n\nKnown issues: ${knownIssues}`;
          }
          if (Array.isArray(fileDeliverables)) {
            for (const fd of fileDeliverables) {
              if (fd && typeof fd === 'object' && typeof fd.path === 'string' && fd.path) {
                deliverables.push({
                  type: (fd.type as TaskDeliverable['type']) ?? 'file',
                  reference: fd.path,
                  summary: typeof fd.summary === 'string' ? fd.summary : fd.path.split('/').pop() ?? '',
                });
              }
            }
          }
          return ts.submitForReview(taskId, deliverables);
        },
        proposeRequirement: this.requirementService
          ? async params => {
              return this.requirementService!.proposeRequirement({
                orgId,
                title: params.title,
                description: params.description,
                priority: params.priority,
                source: 'agent',
                createdBy: id,
                projectId: params.projectId,
                tags: params.tags,
              });
            }
          : undefined,
        listRequirements: this.requirementService
          ? async filter => {
              return this.requirementService!.listRequirements({
                orgId,
                status: filter?.status,
                projectId: filter?.projectId,
              });
            }
          : undefined,
        updateRequirementStatus: this.requirementService
          ? async (reqId, status, reason) => {
              if (status === 'rejected') {
                return this.requirementService!.rejectRequirement(reqId, id, reason ?? '');
              }
              if (status === 'cancelled') {
                return this.requirementService!.cancelRequirement(reqId);
              }
              return this.requirementService!.updateRequirementStatus(reqId, status, id);
            }
          : undefined,
      };
      for (const tool of createAgentTaskTools(taskCtx)) {
        agent.registerTool(tool);
      }

      // Wire tasks fetcher — show all org tasks so agents have full board visibility
      agent.setTasksFetcher(() => {
        try {
          return ts.listTasks({ orgId }).map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
            assignedAgentId: t.assignedAgentId,
            assignedAgentName: t.assignedAgentId
              ? this.agents.get(t.assignedAgentId)?.config.name
              : undefined,
          }));
        } catch {
          return [];
        }
      });

      log.info(`Task tools injected for agent ${id}`);
    }

    // Project tools — every agent can list/view projects
    if (this.projectService) {
      for (const tool of createProjectTools({
        agentId: id,
        orgId: config.orgId,
        projectService: this.projectService,
        ...this.buildKnowledgeCallbacks(id, config.orgId),
      })) {
        agent.registerTool(tool);
      }
    }

    // If this is a manager agent, inject manager-specific tools
    if (request.agentRole === 'manager') {
      const managerTools = createManagerTools({
        listAgents: () =>
          this.listAgents().map(a => {
            try {
              const ag = this.getAgent(a.id);
              return { ...a, skills: ag.config.skills };
            } catch {
              return { ...a, skills: [] };
            }
          }),
        delegateMessage: async (targetId, message, _from) => {
          const target = this.getAgent(targetId);
          const reply = await target.handleMessage(message, id, { name: config.name, role: 'manager' });
          return stripInternalBlocks(reply);
        },
        createTask: (params) => {
          if (this.taskService) {
            const task = this.taskService.createTask({
              orgId: config.orgId,
              title: params.title,
              description: params.description,
              priority: params.priority ?? 'medium',
              assignedAgentId: params.assignedAgentId,
              blockedBy: params.blockedBy,
              parentTaskId: params.parentTaskId,
              requirementId: params.requirementId,
              projectId: params.projectId,
              createdBy: id,
              creatorRole: 'manager',
            });
            return task.id;
          }
          return `task_${Date.now()}`;
        },
        getTeamStatus: () =>
          this.listAgents().map(a => {
            try {
              const ag = this.getAgent(a.id);
              const state = ag.getState();
              return {
                ...a,
                currentTask: state.currentTaskId,
                tokensUsedToday: state.tokensUsedToday,
              };
            } catch {
              return { ...a, tokensUsedToday: 0 };
            }
          }),
        findDuplicateTasks: this.taskService?.findDuplicateTasks
          ? (orgId: string) => this.taskService!.findDuplicateTasks!(orgId)
          : undefined,
        cleanupDuplicateTasks: this.taskService?.cleanupDuplicateTasks
          ? (orgId: string) => this.taskService!.cleanupDuplicateTasks!(orgId)
          : undefined,
        getTaskBoardHealth: this.taskService?.getTaskBoardHealth
          ? (orgId: string) => this.taskService!.getTaskBoardHealth!(orgId)
          : undefined,
      });
      for (const tool of managerTools) {
        agent.registerTool(tool);
      }
    }

    // Connect MCP servers and register their tools
    const mcpConfigs = request.mcpServers ?? this.globalMcpServers;
    if (mcpConfigs) {
      for (const [serverName, serverConfig] of Object.entries(mcpConfigs)) {
        try {
          await this.mcpManager.connectServer(serverName, serverConfig);
          const mcpTools = this.mcpManager.getToolHandlers(serverName);
          for (const tool of mcpTools) {
            agent.registerTool(tool);
          }
          log.info(`MCP server ${serverName} tools registered for agent ${id}`, {
            toolCount: mcpTools.length,
          });
        } catch (error) {
          log.warn(`Failed to connect MCP server ${serverName} for agent ${id}`, {
            error: String(error),
          });
        }
      }
    }

    if (this.agentAuditCallback) {
      const cb = this.agentAuditCallback;
      agent.setAuditCallback(event => cb(id, event));
    }
    if (this.escalationHandler) {
      agent.setEscalationCallback(this.escalationHandler);
    }
    if (this.approvalHandler) {
      const ah = this.approvalHandler;
      agent.setApprovalCallback(
        async (req: { toolName: string; toolArgs: Record<string, unknown>; reason: string }) =>
          ah(id, req)
      );
    }
    if (this.stateChangeHandler) {
      agent.setStateChangeCallback(this.stateChangeHandler);
    }

    this.agents.set(id, agent);
    this.delegationManager.registerAgentCard({
      agentId: id,
      name: config.name,
      role: role.name,
      capabilities: config.skills,
      skills: config.skills,
      status: 'idle',
    });
    this.eventBus.emit('agent:created', { agentId: id, name: request.name });
    log.info(`Agent created: ${request.name} (${id})`);

    return agent;
  }

  /**
   * Restore an agent from a persisted DB row, reusing its original ID.
   * Used on server startup to rebuild in-memory state from the database.
   */
  async restoreAgent(row: {
    id: string;
    name: string;
    orgId: string;
    teamId: string | null;
    roleId: string;
    roleName: string;
    agentRole: string;
    skills: unknown;
    llmConfig: unknown;
    heartbeatIntervalMs: number;
    profile?: unknown;
    tokensUsedToday?: number;
    activeTaskIds?: unknown;
  }): Promise<Agent> {
    const id = row.id;
    const agentDataDir = join(this.dataDir, id);
    mkdirSync(agentDataDir, { recursive: true });

    // Prefer agent's own role dir; fall back to template and migrate
    const agentRoleDir = join(agentDataDir, 'role');
    let role: RoleTemplate;
    if (existsSync(join(agentRoleDir, 'ROLE.md'))) {
      role = this.roleLoader.loadRole(agentRoleDir);
    } else {
      // Load from template (backward compat), then copy for future self-evolution
      role = (() => {
        try { return this.roleLoader.loadRole(row.roleId); } catch { /* try next */ }
        try { return this.roleLoader.loadRole(row.roleName); } catch { /* try next */ }
        const available = this.roleLoader.listAvailableRoles();
        for (const templateName of available) {
          try {
            const candidate = this.roleLoader.loadRole(templateName);
            if (candidate.name.toLowerCase() === row.roleName.toLowerCase()) return candidate;
          } catch { /* skip */ }
        }
        throw new Error(`Role not found: ${row.roleName} (roleId: ${row.roleId})`);
      })();
      // Migration: copy template files to agent's own role dir
      const templateDir = this.roleLoader.resolveTemplateDir(row.roleId)
        ?? this.roleLoader.resolveTemplateDir(row.roleName);
      if (templateDir) {
        mkdirSync(agentRoleDir, { recursive: true });
        for (const file of ['ROLE.md', 'HEARTBEAT.md', 'POLICIES.md', 'CONTEXT.md']) {
          const src = join(templateDir, file);
          if (existsSync(src)) copyFileSync(src, join(agentRoleDir, file));
        }
      }
    }

    const agentRole = (row.agentRole as 'manager' | 'worker') ?? 'worker';

    const config: AgentConfig = {
      id,
      name: row.name,
      roleId: row.roleId,
      orgId: row.orgId,
      teamId: row.teamId ?? undefined,
      agentRole,
      skills: Array.isArray(row.skills) ? (row.skills as string[]) : role.defaultSkills,
      profile: row.profile as AgentProfile | undefined,
      llmConfig: (() => {
        const raw = (row.llmConfig ?? {}) as Record<string, unknown>;
        return {
          modelMode: (raw.modelMode as 'default' | 'custom') ?? 'default',
          primary: (raw.primary as string) ?? 'anthropic',
          fallback: raw.fallback as string | undefined,
          maxTokensPerRequest: raw.maxTokensPerRequest as number | undefined,
          maxTokensPerDay: raw.maxTokensPerDay as number | undefined,
        };
      })(),
      channels: [],
      heartbeatIntervalMs: row.heartbeatIntervalMs ?? 30 * 60 * 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const workspacePath = config.profile?.workspacePath ?? join(this.dataDir, id, 'workspace');
    mkdirSync(workspacePath, { recursive: true });

    const pathPolicy = this.buildPathPolicy(workspacePath, undefined, agentRoleDir);
    const securityAllowlist = [workspacePath, agentRoleDir];
    if (pathPolicy.sharedWorkspace) securityAllowlist.push(pathPolicy.sharedWorkspace);
    if (pathPolicy.readOnlyPaths) securityAllowlist.push(...pathPolicy.readOnlyPaths);

    const basePolicy = this.globalSecurityPolicy;
    const security = new SecurityGuard({
      ...basePolicy,
      pathAllowlist: [...(basePolicy?.pathAllowlist ?? []), ...securityAllowlist],
    });
    const agentMeta = {
      agentId: id,
      agentName: row.name ?? 'unknown',
      teamName: row.teamId as string | undefined,
      orgId: (row.orgId as string) ?? 'default',
    };
    const tools = createBuiltinTools({ agentId: id, agentMeta, security, workspacePath, pathPolicy });

    const agent = new Agent({
      config,
      role,
      llmRouter: this.llmRouter,
      dataDir: agentDataDir,
      tools,
      pathPolicy,
      restoredState: { tokensUsedToday: row.tokensUsedToday ?? 0 },
      skillRegistry: this.skillRegistry,
    });

    if (this.skillRegistry && config.skills.length > 0) {
      const missingSkills = config.skills.filter(s => !this.skillRegistry!.get(s));
      if (missingSkills.length > 0) {
        log.warn(`Restored agent ${config.name} (${id}) references skills not found in registry`, {
          missing: missingSkills,
          available: this.skillRegistry.list().map(s => s.name),
        });
      }
      const skillInstructions = this.skillRegistry.getInstructionsForSkills(config.skills);
      for (const [skillName, instructions] of skillInstructions) {
        agent.injectSkillInstructions(skillName, instructions);
      }

      // Connect MCP servers declared by skills and activate the tools
      for (const skillName of config.skills) {
        const skill = this.skillRegistry.get(skillName);
        if (skill?.manifest.mcpServers) {
          for (const [serverName, serverConfig] of Object.entries(skill.manifest.mcpServers)) {
            try {
              await this.mcpManager.connectServer(serverName, serverConfig);
              const mcpTools = this.mcpManager.getToolHandlers(serverName);
              const toolNames: string[] = [];
              for (const tool of mcpTools) {
                agent.registerTool(tool);
                toolNames.push(tool.name);
              }
              agent.activateTools(toolNames);
              log.info(`Skill ${skillName} MCP server ${serverName} restored for agent ${id}`, {
                toolCount: mcpTools.length,
              });
            } catch (error) {
              log.warn(`Failed to restore skill ${skillName} MCP server ${serverName} for agent ${id}`, {
                error: String(error),
              });
            }
          }
        }
      }
    }

    // Set skill MCP activator callback for runtime activation via discover_tools
    agent.setSkillMcpActivator(async (_skillName, mcpServers) => {
      const tools: AgentToolHandler[] = [];
      for (const [serverName, srvConfig] of Object.entries(mcpServers)) {
        await this.mcpManager.connectServer(serverName, srvConfig);
        tools.push(...this.mcpManager.getToolHandlers(serverName));
      }
      return tools;
    });

    const a2aCtx = {
      selfId: id,
      selfName: config.name,
      listColleagues: () =>
        this.listAgents().map(a => {
          try {
            const ag = this.getAgent(a.id);
            return { ...a, skills: ag.config.skills };
          } catch {
            return { ...a, skills: [] };
          }
        }),
      sendMessage: async (targetId: string, message: string, fromId: string, fromName: string) => {
        // Lightweight path: informational broadcasts are stored directly,
        // skipping the expensive LLM call that would cause cascade amplification.
        try {
          const parsed = JSON.parse(message);
          if (parsed.type === 'status_broadcast') {
            const target = this.getAgent(targetId);
            const senderName = parsed.sender?.name ?? fromName;
            const payload = parsed.payload ?? {};
            target.getMemory().writeDailyLog(
              targetId,
              `[Status] ${senderName}: ${payload.status ?? 'unknown'}${payload.currentTask?.title ? ' — ' + payload.currentTask.title : ''}`
            );
            return `Status from ${senderName} noted.`;
          }
        } catch { /* not JSON — fall through to full LLM handling */ }

        const target = this.getAgent(targetId);
        return target.handleMessage(
          message,
          fromId,
          { name: fromName, role: config.agentRole ?? 'worker' },
          {
            ephemeral: true,
            maxHistory: 15,
          }
        );
      },
      delegateTask: async (targetId: string, delegation: TaskDelegation) =>
        this.delegationManager.delegateTask(id, delegation, targetId),
    };
    for (const tool of createA2ATools(a2aCtx)) agent.registerTool(tool);
    for (const tool of createStructuredA2ATools(a2aCtx)) agent.registerTool(tool);

    for (const tool of createMemoryTools({
      agentId: id,
      agentName: config.name,
      memory: agent.getMemory(),
      semanticSearch: this.semanticSearch,
    })) {
      agent.registerTool(tool);
    }

    if (this.semanticSearch) {
      agent.getContextEngine().setSemanticSearch(this.semanticSearch);
    }

    this.a2aBus.registerAgent(id, async envelope => {
      const summary = `[A2A:${envelope.type}] from=${envelope.from}: ${JSON.stringify(envelope.payload).slice(0, 200)}`;
      await agent.handleMessage(
        summary,
        envelope.from,
        { name: envelope.from, role: 'worker' },
        {
          ephemeral: true,
          maxHistory: 10,
        }
      );
    });

    if (this.taskService) {
      const ts = this.taskService;
      const orgId = config.orgId;
      const taskCtx: AgentTaskContext = {
        agentId: id,
        agentName: config.name,
        createTask: async params => ts.createTask({ orgId, ...params, createdBy: id, creatorRole: 'worker' }),
        listTasks: async filter =>
          ts.listTasks({
            orgId,
            status: filter?.status,
            assignedAgentId: filter?.assignedToMe ? id : undefined,
            requirementId: filter?.requirementId,
            projectId: filter?.projectId,
          }),
        updateTaskStatus: async (taskId, status) => ts.updateTaskStatus(taskId, status, id),
        getTask: async taskId => ts.getTask(taskId) ?? null,
        assignTask: async (taskId, agentId) => ts.assignTask(taskId, agentId),
        addTaskNote: async (taskId, note) => {
          ts.addTaskNote(taskId, note);
        },
        updateTaskFields: async (taskId, fields) => {
          const task = ts.updateTask(taskId, fields, id);
          return { id: task.id, title: task.title, status: task.status };
        },
        submitForReview: async (taskId, summary, branchName, testResults, knownIssues, fileDeliverables) => {
          const deliverables: TaskDeliverable[] = [{
            type: 'branch',
            reference: branchName ?? `task/${taskId}`,
            summary,
            ...(testResults ? { testResults: { passed: 0, failed: 0, skipped: 0 } } : {}),
          }];
          if (knownIssues) {
            deliverables[0].summary += `\n\nKnown issues: ${knownIssues}`;
          }
          if (Array.isArray(fileDeliverables)) {
            for (const fd of fileDeliverables) {
              if (fd && typeof fd === 'object' && typeof fd.path === 'string' && fd.path) {
                deliverables.push({
                  type: (fd.type as TaskDeliverable['type']) ?? 'file',
                  reference: fd.path,
                  summary: typeof fd.summary === 'string' ? fd.summary : fd.path.split('/').pop() ?? '',
                });
              }
            }
          }
          return ts.submitForReview(taskId, deliverables);
        },
        proposeRequirement: this.requirementService
          ? async params => {
              return this.requirementService!.proposeRequirement({
                orgId,
                title: params.title,
                description: params.description,
                priority: params.priority,
                source: 'agent',
                createdBy: id,
                projectId: params.projectId,
                tags: params.tags,
              });
            }
          : undefined,
        listRequirements: this.requirementService
          ? async filter => {
              return this.requirementService!.listRequirements({
                orgId,
                status: filter?.status,
                projectId: filter?.projectId,
              });
            }
          : undefined,
        updateRequirementStatus: this.requirementService
          ? async (reqId, status, reason) => {
              if (status === 'rejected') {
                return this.requirementService!.rejectRequirement(reqId, id, reason ?? '');
              }
              if (status === 'cancelled') {
                return this.requirementService!.cancelRequirement(reqId);
              }
              return this.requirementService!.updateRequirementStatus(reqId, status, id);
            }
          : undefined,
      };
      for (const tool of createAgentTaskTools(taskCtx)) agent.registerTool(tool);
      agent.setTasksFetcher(() => {
        try {
          return ts.listTasks({ orgId }).map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
            assignedAgentId: t.assignedAgentId,
            assignedAgentName: t.assignedAgentId
              ? this.agents.get(t.assignedAgentId)?.config.name
              : undefined,
          }));
        } catch {
          return [];
        }
      });
    }

    if (this.projectService) {
      for (const tool of createProjectTools({
        agentId: id,
        orgId: config.orgId,
        projectService: this.projectService,
        ...this.buildKnowledgeCallbacks(id, config.orgId),
      })) {
        agent.registerTool(tool);
      }
    }

    if (config.agentRole === 'manager') {
      const managerTools = createManagerTools({
        listAgents: () =>
          this.listAgents().map(a => {
            try {
              const ag = this.getAgent(a.id);
              return { ...a, skills: ag.config.skills };
            } catch {
              return { ...a, skills: [] };
            }
          }),
        delegateMessage: async (targetId, message) => {
          const target = this.getAgent(targetId);
          const reply = await target.handleMessage(message, id, { name: config.name, role: 'manager' });
          return stripInternalBlocks(reply);
        },
        createTask: (params) => {
          if (this.taskService) {
            return this.taskService.createTask({
              orgId: config.orgId,
              title: params.title,
              description: params.description,
              priority: params.priority ?? 'medium',
              assignedAgentId: params.assignedAgentId,
              blockedBy: params.blockedBy,
              parentTaskId: params.parentTaskId,
              requirementId: params.requirementId,
              projectId: params.projectId,
              createdBy: id,
              creatorRole: 'manager',
            }).id;
          }
          return `task_${Date.now()}`;
        },
        getTeamStatus: () =>
          this.listAgents().map(a => {
            try {
              const ag = this.getAgent(a.id);
              const state = ag.getState();
              return {
                ...a,
                currentTask: state.currentTaskId,
                tokensUsedToday: state.tokensUsedToday,
              };
            } catch {
              return { ...a, tokensUsedToday: 0 };
            }
          }),
        findDuplicateTasks: this.taskService?.findDuplicateTasks
          ? (orgId: string) => this.taskService!.findDuplicateTasks!(orgId)
          : undefined,
        cleanupDuplicateTasks: this.taskService?.cleanupDuplicateTasks
          ? (orgId: string) => this.taskService!.cleanupDuplicateTasks!(orgId)
          : undefined,
        getTaskBoardHealth: this.taskService?.getTaskBoardHealth
          ? (orgId: string) => this.taskService!.getTaskBoardHealth!(orgId)
          : undefined,
      });
      for (const tool of managerTools) agent.registerTool(tool);
    }

    if (this.agentAuditCallback) {
      const cb = this.agentAuditCallback;
      agent.setAuditCallback(event => cb(id, event));
    }
    if (this.escalationHandler) {
      agent.setEscalationCallback(this.escalationHandler);
    }
    if (this.approvalHandler) {
      const ah = this.approvalHandler;
      agent.setApprovalCallback(
        async (req: { toolName: string; toolArgs: Record<string, unknown>; reason: string }) =>
          ah(id, req)
      );
    }
    if (this.stateChangeHandler) {
      agent.setStateChangeCallback(this.stateChangeHandler);
    }

    this.agents.set(id, agent);
    this.delegationManager.registerAgentCard({
      agentId: id,
      name: config.name,
      role: role.name,
      capabilities: config.skills,
      skills: config.skills,
      status: 'idle',
    });
    this.eventBus.emit('agent:created', { agentId: id, name: row.name });
    log.info(`Agent restored: ${row.name} (${id})`, {
      profile: config.profile ? 'yes' : 'no',
      tokensUsedToday: row.tokensUsedToday ?? 0,
      activeTaskIds: Array.isArray(row.activeTaskIds) ? (row.activeTaskIds as string[]).length : 0,
    });
    return agent;
  }

  /**
   * Re-queue interrupted tasks for a restored agent.
   * Called after all agents are restored and started.
   */
  async rehydrateAgentTasks(agentId: string, activeTaskIds: string[]): Promise<void> {
    if (!this.taskService || activeTaskIds.length === 0) return;

    const agent = this.agents.get(agentId);
    if (!agent) return;

    for (const taskId of activeTaskIds) {
      try {
        const task = this.taskService.getTask(taskId);
        if (!task) {
          log.warn('Task not found during rehydration, skipping', { agentId, taskId });
          continue;
        }
        if (
          task.status === 'completed' ||
          task.status === 'cancelled' ||
          task.status === 'failed'
        ) {
          log.debug('Task already terminal, skipping rehydration', {
            agentId,
            taskId,
            status: task.status,
          });
          continue;
        }
        // Re-assign and the task service will handle execution
        log.info('Re-queuing interrupted task', { agentId, taskId, title: task.title });
        this.taskService.assignTask(taskId, agentId);
      } catch (error) {
        log.warn('Failed to rehydrate task', { agentId, taskId, error: String(error) });
      }
    }
  }

  async startAgent(agentId: string): Promise<void> {
    const agent = this.getAgent(agentId);
    await agent.start();
  }

  async stopAgent(agentId: string): Promise<void> {
    const agent = this.getAgent(agentId);
    await agent.stop();
  }

  async removeAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      try { await agent.stop(); } catch { /* proceed with removal even if stop fails */ }
      this.a2aBus.unregisterAgent(agentId);
      this.delegationManager.unregisterAgentCard(agentId);
      this.agents.delete(agentId);
      this.eventBus.emit('agent:removed', { agentId });
      log.info(`Agent removed: ${agentId}`);
    }
  }

  getAgent(agentId: string): Agent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    return agent;
  }

  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Grant a reviewer agent read-only access to a task's worktree.
   * Called when a task enters review and a reviewer is assigned.
   */
  grantReviewAccess(reviewerAgentId: string, worktreePath: string): void {
    if (!this.agents.has(reviewerAgentId)) return;
    const reviewer = this.getAgent(reviewerAgentId);
    reviewer.grantReadOnlyAccess(worktreePath);
    log.info('Granted reviewer access to worktree', { reviewerAgentId, worktreePath });
  }

  /**
   * Revoke a reviewer agent's read-only access to a task's worktree.
   * Called when a review is complete or the reviewer changes.
   */
  revokeReviewAccess(reviewerAgentId: string, worktreePath: string): void {
    if (!this.agents.has(reviewerAgentId)) return;
    const reviewer = this.getAgent(reviewerAgentId);
    reviewer.revokeReadOnlyAccess(worktreePath);
    log.info('Revoked reviewer access to worktree', { reviewerAgentId, worktreePath });
  }

  setAuditCallback(
    cb: (
      agentId: string,
      event: {
        type: string;
        action: string;
        tokensUsed?: number;
        durationMs?: number;
        success: boolean;
        detail?: string;
      }
    ) => void
  ): void {
    this.agentAuditCallback = cb;
    for (const [id, agent] of this.agents) {
      agent.setAuditCallback(event => cb(id, event));
    }
  }

  setEscalationHandler(handler: (agentId: string, reason: string) => void): void {
    this.escalationHandler = handler;
    for (const [, agent] of this.agents) {
      agent.setEscalationCallback(handler);
    }
  }

  setApprovalHandler(
    handler: (
      agentId: string,
      request: { toolName: string; toolArgs: Record<string, unknown>; reason: string }
    ) => Promise<boolean>
  ): void {
    this.approvalHandler = handler;
    for (const [id, agent] of this.agents) {
      agent.setApprovalCallback(
        async (req: { toolName: string; toolArgs: Record<string, unknown>; reason: string }) =>
          handler(id, req)
      );
    }
  }

  setStateChangeHandler(
    handler: (
      agentId: string,
      state: { status: string; tokensUsedToday: number; activeTaskIds: string[]; lastError?: string; lastErrorAt?: string; currentActivity?: AgentActivity }
    ) => void
  ): void {
    this.stateChangeHandler = handler;
    for (const [, agent] of this.agents) {
      agent.setStateChangeCallback(handler);
    }
  }

  listAgents(): Array<{
    id: string;
    name: string;
    role: string;
    status: string;
    agentRole: string;
    skills: string[];
    activeTaskCount: number;
    teamId?: string;
    lastError?: string;
    lastErrorAt?: string;
    currentTaskId?: string;
    currentActivity?: AgentActivity;
  }> {
    return [...this.agents.values()].map(a => {
      const state = a.getState();
      return {
        id: a.id,
        name: a.config.name,
        role: a.role.name,
        status: state.status,
        agentRole: a.config.agentRole,
        skills: a.config.skills,
        activeTaskCount: state.activeTaskCount ?? 0,
        teamId: a.config.teamId,
        lastError: state.lastError,
        lastErrorAt: state.lastErrorAt,
        currentTaskId: state.currentTaskId,
        currentActivity: state.currentActivity,
      };
    });
  }

  listAvailableRoles(): string[] {
    return this.roleLoader.listAvailableRoles();
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }


  getA2ABus(): A2ABus {
    return this.a2aBus;
  }

  getDelegationManager(): DelegationManager {
    return this.delegationManager;
  }

  setTemplateRegistry(registry: TemplateRegistry): void {
    this.templateRegistry = registry;
  }

  getTemplateRegistry(): TemplateRegistry | undefined {
    return this.templateRegistry;
  }

  setGroupChatHandlers(handlers: {
    sendGroupMessage: (
      channelKey: string,
      message: string,
      senderId: string,
      senderName: string
    ) => Promise<string>;
    createGroupChat: (
      name: string,
      creatorId: string,
      creatorName: string,
      memberIds: string[]
    ) => Promise<{ id: string; name: string }>;
    listGroupChats: () => Promise<
      Array<{ id: string; name: string; type: string; channelKey: string }>
    >;
  }): void {
    this.groupChatHandlers = handlers;
  }

  /**
   * Create an agent from a template with optional overrides.
   */
  async createAgentFromTemplate(request: TemplateInstantiateRequest): Promise<Agent> {
    if (!this.templateRegistry) throw new Error('Template registry not configured');
    const template = this.templateRegistry.get(request.templateId);
    if (!template) throw new Error(`Template not found: ${request.templateId}`);

    const llmProvider = request.overrides?.llmProvider ?? template.llmProvider;
    return this.createAgent({
      name: request.name,
      roleName: template.roleId,
      orgId: request.orgId,
      teamId: request.teamId,
      agentRole: template.agentRole,
      skills: request.overrides?.skills ?? template.skills,
      heartbeatIntervalMs: request.overrides?.heartbeatIntervalMs ?? template.heartbeatIntervalMs,
      llmProvider,
    });
  }

  // ─── Batch Agent Control ───────────────────────────────────────────────────

  async startAgentsByIds(ids: string[]): Promise<{ success: string[]; failed: Array<{ id: string; error: string }> }> {
    const success: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of ids) {
      try {
        await this.startAgent(id);
        success.push(id);
      } catch (err) {
        failed.push({ id, error: String(err) });
      }
    }
    return { success, failed };
  }

  async stopAgentsByIds(ids: string[]): Promise<{ success: string[]; failed: Array<{ id: string; error: string }> }> {
    const success: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of ids) {
      try {
        await this.stopAgent(id);
        success.push(id);
      } catch (err) {
        failed.push({ id, error: String(err) });
      }
    }
    return { success, failed };
  }

  pauseAgentsByIds(ids: string[], reason?: string): { success: string[]; failed: Array<{ id: string; error: string }> } {
    const success: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of ids) {
      try {
        const agent = this.getAgent(id);
        if (agent.getState().status !== 'offline') {
          agent.pause(reason);
        }
        success.push(id);
      } catch (err) {
        failed.push({ id, error: String(err) });
      }
    }
    return { success, failed };
  }

  resumeAgentsByIds(ids: string[]): { success: string[]; failed: Array<{ id: string; error: string }> } {
    const success: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of ids) {
      try {
        const agent = this.getAgent(id);
        if (agent.getState().status === 'paused') {
          agent.resume();
        }
        success.push(id);
      } catch (err) {
        failed.push({ id, error: String(err) });
      }
    }
    return { success, failed };
  }

  // ─── Global Agent Control ──────────────────────────────────────────────────

  private globalPaused = false;
  private emergencyMode = false;

  async pauseAllAgents(reason?: string): Promise<void> {
    for (const [, agent] of this.agents) {
      if (agent.getState().status !== 'offline') {
        agent.pause(reason);
      }
    }
    this.globalPaused = true;
    this.eventBus.emit('system:pause-all', { reason });
    log.info('All agents paused', { reason });
  }

  async resumeAllAgents(): Promise<void> {
    for (const [, agent] of this.agents) {
      if (agent.getState().status === 'paused') {
        agent.resume();
      }
    }
    this.globalPaused = false;
    this.emergencyMode = false;
    this.eventBus.emit('system:resume-all', {});
    log.info('All agents resumed');
  }

  async emergencyStop(): Promise<void> {
    for (const [, agent] of this.agents) {
      agent.cancelActiveStream();
      await agent.stop();
    }
    this.emergencyMode = true;
    this.globalPaused = true;
    this.eventBus.emit('system:emergency-stop', {});
    log.warn('EMERGENCY STOP — all agents stopped');
  }

  isGlobalPaused(): boolean {
    return this.globalPaused;
  }

  isEmergencyMode(): boolean {
    return this.emergencyMode;
  }

  clearEmergencyMode(): void {
    this.emergencyMode = false;
    this.globalPaused = false;
    log.info('Emergency mode cleared');
  }

  async shutdown(): Promise<void> {
    for (const [, agent] of this.agents) {
      try {
        await agent.stop();
      } catch { /* best effort */ }
    }
    log.info('AgentManager shutdown complete — all metrics flushed');
  }

  // ─── System Announcements ────────────────────────────────────────────────

  private announcements: SystemAnnouncement[] = [];

  broadcastAnnouncement(announcement: SystemAnnouncement): void {
    this.announcements.push(announcement);

    for (const [, agent] of this.agents) {
      if (agent.getState().status !== 'offline') {
        this.a2aBus.send({
          id: `a2a_ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          from: 'system',
          to: agent.id,
          type: 'announcement',
          timestamp: new Date().toISOString(),
          payload: announcement,
        });
      }
    }

    this.eventBus.emit('system:announcement', announcement);
    log.info('Announcement broadcast', { id: announcement.id, title: announcement.title });
  }

  getActiveAnnouncements(): SystemAnnouncement[] {
    const now = new Date().toISOString();
    return this.announcements.filter(a => !a.expiresAt || a.expiresAt > now);
  }

  acknowledgeAnnouncement(announcementId: string, agentId: string): void {
    const announcement = this.announcements.find(a => a.id === announcementId);
    if (announcement && !announcement.acknowledged.includes(agentId)) {
      announcement.acknowledged.push(agentId);
    }
  }

  /**
   * Rebuild and inject identity context for all agents in an organization.
   * Should be called after agents are added/removed or humans join/leave.
   */
  refreshIdentityContexts(orgId: string, orgName: string, humans: HumanUser[]): void {
    const orgAgents = [...this.agents.values()].filter(a => a.config.orgId === orgId);

    const managerAgent = orgAgents.find(a => a.config.agentRole === 'manager');

    for (const agent of orgAgents) {
      const colleagues = orgAgents
        .filter(a => a.id !== agent.id)
        .map(a => ({
          id: a.id,
          name: a.config.name,
          role: a.role.name,
          type: 'agent' as const,
          skills: a.config.skills,
          status: a.getState().status,
        }));

      const identity: IdentityContext = {
        self: {
          id: agent.id,
          name: agent.config.name,
          role: agent.role.name,
          agentRole: agent.config.agentRole,
          skills: agent.config.skills,
        },
        organization: { id: orgId, name: orgName },
        colleagues,
        humans: humans.map(h => ({ id: h.id, name: h.name, role: h.role })),
        manager:
          managerAgent && managerAgent.id !== agent.id
            ? { id: managerAgent.id, name: managerAgent.config.name }
            : undefined,
      };

      agent.setIdentityContext(identity);
    }

    log.info(`Refreshed identity contexts for ${orgAgents.length} agents in org ${orgId}`);
  }
}
