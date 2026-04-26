import {
  createLogger,
  agentId as genAgentId,
  generateId,
  stripInternalBlocks,
  type AgentConfig,
  type AgentProfile,
  type AgentActivity,
  type IdentityContext,
  type HumanUser,
  type SystemAnnouncement,
  type PathAccessPolicy,
  type RoleTemplate,
  type RoleCategory,
  saveConfig,
} from '@markus/shared';
import { Agent, type AgentToolHandler, type AgentOptions } from './agent.js';
import type { OrgContext } from './context-engine.js';
import type { LLMRouter } from './llm/router.js';
import { RoleLoader } from './role-loader.js';
import { EventBus } from './events.js';
import { createBuiltinTools } from './tools/builtin.js';
import { MCPClientManager } from './tools/mcp-client.js';
import { BrowserSessionManager } from './tools/browser-session.js';
import { createManagerTools } from './tools/manager.js';
import { createHubTools } from './tools/hub-tools.js';
import { createA2ATools, type A2AContext } from './tools/a2a.js';
import { createStructuredA2ATools } from './tools/a2a-structured.js';
import { createAgentTaskTools, type AgentTaskContext } from './tools/task-tools.js';
import { createProjectTools, type ProjectServiceBridge, type KnowledgeServiceBridge, type DeliverableServiceBridge, type ProjectToolsContext } from './tools/project-tools.js';
import { createMemoryTools } from './tools/memory.js';
import { createSettingsTools } from './tools/settings.js';
import { createRecallTool, type RecallCallbacks } from './tools/recall.js';
import { SemanticMemorySearch, OpenAIEmbeddingProvider, LocalVectorStore } from './memory/semantic-search.js';
import type { SkillRegistry } from './skills/types.js';
import { SecurityGuard, type SecurityPolicy } from './security.js';
import { DelegationManager, type TaskDelegation } from '@markus/a2a';
import type { TemplateRegistry } from './templates/registry.js';
import type { TemplateInstantiateRequest } from './templates/types.js';
import { join } from 'node:path';
import { mkdirSync, readFileSync, existsSync, copyFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const log = createLogger('agent-manager');

/**
 * Resolve the task ID for submitForReview.
 * Prefers the agent's getCurrentTaskId() — which reads from the per-task
 * AsyncLocalStorage context when available, making it safe for concurrent
 * task executions. Falls back to the first active task whose status is
 * still 'in_progress'.
 */
function resolveCurrentTaskId(
  agentObj: Agent | undefined,
  ts: { getTask(id: string): { status: string } | undefined },
  agentId: string,
): string {
  const activeTasks = agentObj?.getActiveTasks?.() ?? [];
  if (activeTasks.length === 0) throw new Error('No active task — cannot submit for review.');

  const currentId = agentObj?.getCurrentTaskId?.();
  if (currentId && activeTasks.some(t => t.taskId === currentId)) {
    const currentTask = ts.getTask(currentId);
    if (currentTask?.status === 'in_progress') return currentId;
    log.warn('Agent currentTaskId is no longer in_progress, searching activeTasks for a valid candidate', {
      agentId, currentTaskId: currentId, actualStatus: currentTask?.status,
    });
  }

  for (const t of activeTasks) {
    const task = ts.getTask(t.taskId);
    if (task?.status === 'in_progress') return t.taskId;
  }

  // Last resort: clean up stale entries and throw
  for (const t of activeTasks) {
    const task = ts.getTask(t.taskId);
    if (task && ['completed', 'failed', 'cancelled', 'archived'].includes(task.status)) {
      log.warn('Removing stale task from agent activeTasks', { agentId, taskId: t.taskId, status: task.status });
      agentObj?.removeActiveTask(t.taskId);
    }
  }
  throw new Error(`No in_progress task found for agent ${agentId} — cannot submit for review. Active task IDs: [${activeTasks.map(t => t.taskId).join(', ')}]`);
}

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
    createdBy?: string;
  }): Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    source: string;
    createdBy?: string;
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
  updateRequirement(
    id: string,
    data: { title?: string; description?: string; priority?: string; tags?: string[] }
  ): { id: string; title: string; status: string };
  resubmitRequirement(
    id: string,
    updates?: { title?: string; description?: string; priority?: string; tags?: string[] }
  ): { id: string; title: string; status: string };
  getRequirement(id: string): {
    id: string; title: string; description: string; status: string;
    priority: string; source: string; createdBy?: string;
    approvedBy?: string; approvedAt?: string; rejectedReason?: string;
    taskIds: string[]; tags?: string[]; createdAt: string; updatedAt: string;
  } | undefined;
}

export interface TaskServiceBridge {
  createTask(request: {
    orgId: string;
    title: string;
    description: string;
    priority?: string;
    assignedAgentId: string;
    reviewerAgentId: string;
    requirementId?: string;
    projectId?: string;
    blockedBy?: string[];
    createdBy?: string;
    creatorRole?: string;
    taskType?: string;
    notes?: string;
    acceptanceCriteria?: string;
    deadline?: string;
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
    updatedAt: string;
    assignedAgentId?: string;
    requirementId?: string;
  }>;
  queryTasks(opts?: {
    orgId?: string;
    status?: string;
    assignedAgentId?: string;
    priority?: string;
    projectId?: string;
    requirementId?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: string;
    page?: number;
    pageSize?: number;
  }): {
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
  };
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
        reviewerAgentId?: string;
        subtasks?: Array<{ id: string; title: string; status: string }>;
      }
    | undefined;
  assignTask(id: string, agentId: string, updatedBy?: string): { id: string; status: string };
  addTaskNote(id: string, note: string, author?: string): void;
  updateTask(id: string, data: { description?: string; blockedBy?: string[] }, updatedBy?: string): { id: string; title: string; status: string };
  rejectTask(id: string, userId?: string): { id: string; title: string; status: string };
  addSubtask(taskId: string, title: string): { id: string; title: string; status: string };
  completeSubtask(taskId: string, subtaskId: string): { id: string; title: string; status: string };
  getSubtasks?(taskId: string): Array<{ id: string; title: string; status: string }>;
  submitForReview(taskId: string, deliverables: Array<{ type: string; reference: string; summary: string; diffStats?: unknown; testResults?: unknown }>, reviewerAgentId?: string): Promise<{ id: string; status: string }>;
  requestRevision(taskId: string, reason: string, author?: string): Promise<{ id: string; title: string; status: string }>;
  findDuplicateTasks?(orgId: string): Array<{ group: string; tasks: Array<{ id: string; title: string; status: string; createdAt: string }> }>;
  cleanupDuplicateTasks?(orgId: string): { cancelledIds: string[]; count: number };
  getTaskBoardHealth?(orgId: string): Record<string, unknown>;
  postTaskComment?(taskId: string, authorId: string, authorName: string, content: string, mentions?: string[], activityId?: string): Promise<{ id: string; comment?: Record<string, unknown> }>;
  postRequirementComment?(requirementId: string, authorId: string, authorName: string, content: string, mentions?: string[], activityId?: string): Promise<{ id: string; comment?: Record<string, unknown> }>;
  getRequirementComments?(requirementId: string): Array<{ id: string; authorId: string; authorName: string; content: string; createdAt: string }>;
  getTaskComments?(taskId: string): Promise<Array<{ id: string; authorId: string; authorName: string; content: string; createdAt: string }>>;
  updateScheduleFields?(taskId: string, fields: { every?: string; cron?: string; maxRuns?: number; timezone?: string }): Promise<{ id: string; title: string; status: string }>;
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CreateAgentRequest {
  name: string;
  roleName?: string;
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
  /** When true, skip copying template role files (caller will provide custom files) */
  skipTemplateCopy?: boolean;
}

export interface RoleFileStatus {
  file: string;
  status: 'identical' | 'modified' | 'added_in_template' | 'agent_only';
}

export interface RoleUpdateStatus {
  agentId: string;
  roleId: string;
  templateId: string;
  hasTemplate: boolean;
  isUpToDate: boolean;
  files: RoleFileStatus[];
}

export interface RoleFileDiff {
  file: string;
  agentContent: string | null;
  templateContent: string | null;
}

export interface RoleSyncResult {
  agentId: string;
  success: boolean;
  error?: string;
  synced: string[];
}

export class AgentManager {
  private agents = new Map<string, Agent>();
  private eventBus: EventBus;
  private llmRouter: LLMRouter;
  private roleLoader: RoleLoader;
  private dataDir: string;
  private sharedDataDir?: string;
  private mcpManager: MCPClientManager;
  private browserSessionManager: BrowserSessionManager;
  private remoteDebuggingPort = 0;
  private globalSecurityPolicy?: SecurityPolicy;
  private globalMcpServers?: Record<string, MCPServerConfig>;
  private skillRegistry?: SkillRegistry;
  private skillSearcher?: (query: string) => Promise<Array<{ name: string; description: string; source: string; slug?: string; author?: string; githubRepo?: string; githubSkillPath?: string }>>;
  private skillInstaller?: (request: Record<string, unknown>) => Promise<{ installed: boolean; name: string; method: string }>;
  private userApprovalRequester?: (opts: {
    agentId: string; agentName: string; title: string; description: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean; priority?: string; relatedTaskId?: string;
  }) => Promise<{ approved: boolean; comment?: string; selectedOption?: string }>;
  private userNotifier?: (opts: { type: string; title: string; body: string; priority?: string; actionType?: string; actionTarget?: string; metadata?: Record<string, unknown> }) => void;
  private taskService?: TaskServiceBridge;
  private projectService?: ProjectServiceBridge;
  private knowledgeService?: KnowledgeServiceBridge;
  private deliverableService?: DeliverableServiceBridge;
  private webUiBaseUrl?: string;
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
    request: { toolName: string; toolArgs: Record<string, unknown>; reason: string; taskId?: string }
  ) => Promise<{ approved: boolean; comment?: string }>;
  private stateChangeHandler?: (
    agentId: string,
    state: { status: string; tokensUsedToday: number; activeTaskIds: string[]; lastError?: string; lastErrorAt?: string; currentActivity?: AgentActivity }
  ) => void;
  private activityCallbacks?: {
    onStart: (activity: AgentActivity & { agentId: string }) => void;
    onLog: (data: { activityId: string; agentId: string; seq: number; type: string; content: string; metadata?: Record<string, unknown> }) => void;
    onEnd: (activityId: string, summary: { endedAt: string; totalTokens: number; totalTools: number; success: boolean }) => void;
  };
  private recallCallbacks?: RecallCallbacks;
  private delegationManager: DelegationManager;
  private _maxToolIterations = Infinity;
  private templateRegistry?: TemplateRegistry;
  private builderService?: { listArtifacts: (type?: 'agent' | 'team' | 'skill') => Array<{ type: string; name: string; description?: string }>; installArtifact: (type: 'agent' | 'team' | 'skill', name: string) => Promise<{ type: string; installed: unknown }> };
  private hubClient?: { search: (opts?: { type?: string; query?: string }) => Promise<Array<{ id: string; name: string; type: string; description: string; author: string; version?: string; downloads?: number }>>; downloadAndInstall: (itemId: string) => Promise<{ type: string; installed: unknown }> };
  private teamUpdater?: (teamId: string, data: { name?: string; description?: string }) => Promise<{ id: string; name: string; description?: string }>;
  private agentConfigPersister?: (agentId: string, data: Record<string, unknown>) => Promise<void>;

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
    getChannelMessages?: (
      channelKey: string,
      limit: number,
      before?: string
    ) => Promise<{ messages: Array<{ senderName: string; senderType: string; text: string; createdAt: string }>; hasMore: boolean }>;
  };

  private buildKnowledgeCallbacks(agentId: string, orgId: string): Pick<
    ProjectToolsContext,
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

  private buildDeliverableCallbacks(agentId: string, projectId?: string): Pick<
    ProjectToolsContext,
    'deliverableCreate' | 'deliverableSearch' | 'deliverableList' | 'deliverableUpdate'
  > {
    if (!this.deliverableService) return {};
    const ds = this.deliverableService;
    return {
      deliverableCreate: async (opts) => {
        const tags = opts.tags?.split(',').map(t => t.trim()).filter(Boolean);
        return ds.create({
          type: opts.type,
          title: opts.title,
          summary: opts.summary,
          reference: opts.reference,
          tags,
          agentId,
          projectId,
        });
      },
      deliverableSearch: async (opts) => {
        return ds.search({
          query: opts.query,
          projectId: opts.projectId,
          agentId: opts.agentId,
          type: opts.type,
          limit: opts.limit,
        }).results;
      },
      deliverableList: async (opts) => {
        return ds.search({
          projectId: opts.projectId,
          agentId: opts.agentId,
          type: opts.type,
          status: opts.status,
          limit: opts.limit,
        }).results;
      },
      deliverableUpdate: async (id, data) => {
        const tags = data.tags?.split(',').map(t => t.trim()).filter(Boolean);
        return ds.update(id, {
          title: data.title,
          summary: data.summary,
          reference: data.reference,
          status: data.status,
          tags,
        });
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
    this.browserSessionManager = new BrowserSessionManager();
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

    this.delegationManager = new DelegationManager();
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
          reviewerAgentId: envelope.from,
          createdBy: envelope.from,
          creatorRole: 'manager',
          notes: delegation.context,
          acceptanceCriteria: delegation.expectedOutput,
          deadline: delegation.deadline,
        });
        log.info('Delegation created real task', {
          taskId: task.id,
          delegatedTo: envelope.to,
          from: envelope.from,
          status: task.status,
        });
      } else {
        // No task service — send as a direct message to the agent
        await targetAgent.sendMessage(
          `[Delegated Task from ${envelope.from}]\nTitle: ${delegation.title}\nDescription: ${delegation.description}\nPriority: ${delegation.priority}`,
          envelope.from,
          { name: envelope.from, role: 'manager' },
          { sourceType: 'a2a_message', sessionId: `sys_${envelope.from}_${Date.now()}` }
        );
      }
    });
    this.templateRegistry = options.templateRegistry;
    mkdirSync(this.dataDir, { recursive: true });
  }

  get maxToolIterations(): number {
    return this._maxToolIterations;
  }

  set maxToolIterations(value: number) {
    this._maxToolIterations = value <= 0 ? Infinity : value;
  }

  setBrowserBringToFront(value: boolean): void {
    this.browserSessionManager.bringToFront = value;
  }

  setBrowserAutoCloseTabs(value: boolean): void {
    this.browserSessionManager.autoCloseTabs = value;
  }

  setBrowserRemoteDebuggingPort(port: number): void {
    this.remoteDebuggingPort = port;
  }

  /**
   * When remoteDebuggingPort is configured, replace --autoConnect with
   * --browserUrl so that the chrome-devtools MCP server reuses a persistent
   * debugging connection instead of requesting a new permission each time.
   */
  private enrichChromeDevtoolsConfig(
    serverName: string,
    config: { command: string; args?: string[]; env?: Record<string, string> },
  ): { command: string; args?: string[]; env?: Record<string, string> } {
    if (serverName !== 'chrome-devtools' || this.remoteDebuggingPort <= 0) return config;
    const args = [...(config.args ?? [])];
    const autoIdx = args.indexOf('--autoConnect');
    if (autoIdx !== -1) args.splice(autoIdx, 1);
    if (!args.includes('--browserUrl') && !args.includes('--browser-url')) {
      args.push('--browserUrl', `http://127.0.0.1:${this.remoteDebuggingPort}`);
    }
    return { ...config, args };
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

  setDeliverableService(deliverableService: DeliverableServiceBridge): void {
    this.deliverableService = deliverableService;
  }

  setWebUiBaseUrl(url: string): void {
    this.webUiBaseUrl = url.replace(/\/+$/, '');
  }

  setSkillSearcher(cb: (query: string) => Promise<Array<{ name: string; description: string; source: string; slug?: string; author?: string; githubRepo?: string; githubSkillPath?: string }>>): void {
    this.skillSearcher = cb;
  }

  setSkillInstaller(cb: (request: Record<string, unknown>) => Promise<{ installed: boolean; name: string; method: string }>): void {
    this.skillInstaller = cb;
  }

  setUserApprovalRequester(cb: (opts: {
    agentId: string; agentName: string; title: string; description: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean; priority?: string; relatedTaskId?: string;
  }) => Promise<{ approved: boolean; comment?: string; selectedOption?: string }>): void {
    this.userApprovalRequester = cb;
    for (const info of this.listAgents()) {
      try { this.getAgent(info.id).setUserApprovalRequester(cb); } catch { /* skip */ }
    }
  }

  setUserNotifier(cb: (opts: { type: string; title: string; body: string; priority?: string; actionType?: string; actionTarget?: string; metadata?: Record<string, unknown> }) => void): void {
    this.userNotifier = cb;
    for (const info of this.listAgents()) {
      try { this.getAgent(info.id).setUserNotifier(cb); } catch { /* skip */ }
    }
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
  private static readonly BUILDER_ROLES = new Set(['agent-father', 'team-factory', 'skill-architect']);

  buildPathPolicy(agentId: string, workspacePath: string, roleDir?: string, teamDataDir?: string, builderArtifactsDir?: string): PathAccessPolicy {
    // Block writes to other agents' directories only.
    // The agent's own directory is excluded from the deny list.
    const agentOwnDir = join(this.dataDir, agentId);
    const denyWritePaths: string[] = [];
    if (existsSync(this.dataDir)) {
      for (const entry of readdirSync(this.dataDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== agentId) {
          denyWritePaths.push(join(this.dataDir, entry.name));
        }
      }
    }

    const policy: PathAccessPolicy = {
      primaryWorkspace: workspacePath,
      denyWritePaths: denyWritePaths.length ? denyWritePaths : undefined,
    };
    if (this.sharedDataDir) {
      policy.sharedWorkspace = this.sharedDataDir;
    }
    if (roleDir) {
      policy.roleDir = roleDir;
    }
    if (teamDataDir) {
      policy.teamDataDir = teamDataDir;
    }
    if (builderArtifactsDir) {
      policy.builderArtifactsDir = builderArtifactsDir;
    }
    return policy;
  }

  async createAgent(request: CreateAgentRequest): Promise<Agent> {
    if (!request.name?.trim()) throw new Error('Agent name is required');
    const id = genAgentId();
    const roleName = request.roleName || 'custom';
    const isCustomRole = roleName === 'custom';

    const role: RoleTemplate = isCustomRole
      ? {
          id: generateId('role'),
          name: request.name,
          description: '',
          category: 'custom' as RoleCategory,
          systemPrompt: `# ${request.name}\n\nYou are ${request.name}.`,
          defaultSkills: [],
          heartbeatChecklist: '',
          defaultPolicies: [],
          builtIn: false,
        }
      : this.roleLoader.loadRole(roleName);

    const agentDataDir = join(this.dataDir, id);
    mkdirSync(agentDataDir, { recursive: true });

    const agentRoleDir = join(agentDataDir, 'role');
    mkdirSync(agentRoleDir, { recursive: true });

    if (!isCustomRole && !request.skipTemplateCopy) {
      const templateDir = this.roleLoader.resolveTemplateDir(roleName);
      if (templateDir) {
        for (const file of ['ROLE.md', 'HEARTBEAT.md', 'POLICIES.md', 'CONTEXT.md']) {
          const src = join(templateDir, file);
          if (existsSync(src)) copyFileSync(src, join(agentRoleDir, file));
        }
      }
    }

    const heartbeatPath = join(agentRoleDir, 'HEARTBEAT.md');
    if (!existsSync(heartbeatPath)) {
      writeFileSync(heartbeatPath, [
        '# Heartbeat Checklist',
        '',
        '- [ ] Check mailbox for new messages and respond to urgent items',
        '- [ ] Review assigned tasks — update progress, unblock if possible',
        '- [ ] Check team announcements for new information',
        '- [ ] Scan recent channel messages for anything requiring attention',
      ].join('\n'), 'utf-8');
    }

    const config: AgentConfig = {
      id,
      name: request.name,
      roleId: roleName,
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

    // Team managers get write access to team data dir for announcements/norms
    const teamDataDir = (request.teamId && request.agentRole === 'manager')
      ? join(homedir(), '.markus', 'teams', request.teamId)
      : undefined;

    const builderArtifactsDir = join(homedir(), '.markus', 'builder-artifacts');

    const pathPolicy = this.buildPathPolicy(id, workspacePath, agentRoleDir, teamDataDir, builderArtifactsDir);

    const basePolicy = request.securityPolicy ?? this.globalSecurityPolicy;
    const security = new SecurityGuard({
      ...basePolicy,
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
      maxToolIterations: this._maxToolIterations,
    };

    const agent = new Agent(agentOpts);

    // Inject always-on builtin skill instructions into every agent (text only, no MCP)
    if (this.skillRegistry) {
      const builtinInstructions = this.skillRegistry.getBuiltinInstructions();
      for (const [skillName, instructions] of builtinInstructions) {
        agent.injectSkillInstructions(skillName, instructions);
      }
      if (builtinInstructions.size > 0) {
        log.info(`Always-on builtin skills injected for agent ${id}`, { skills: [...builtinInstructions.keys()] });
      }
      agent.setAvailableSkillCatalog(this.skillRegistry.getSkillCatalog());
    }

    // Inject explicitly assigned skill instructions and connect skill MCP servers
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
        if (!agent.hasSkillInstructions(skillName)) {
          agent.injectSkillInstructions(skillName, instructions);
        }
      }

      // Connect MCP servers declared by explicitly assigned skills
      for (const skillName of config.skills) {
        const skill = this.skillRegistry.get(skillName);
        if (skill?.manifest.mcpServers) {
          const isolated = skill.manifest.isolation === 'per-agent';
          for (const [serverName, rawServerConfig] of Object.entries(skill.manifest.mcpServers)) {
            try {
              const serverConfig = this.enrichChromeDevtoolsConfig(serverName, rawServerConfig);
              let mcpTools: AgentToolHandler[];
              if (isolated) {
                await this.mcpManager.connectServerScoped(serverName, serverConfig, id);
                mcpTools = this.mcpManager.getToolHandlersScoped(serverName, id);
                mcpTools = this.browserSessionManager.wrapToolHandlers(mcpTools, id);
              } else {
                await this.mcpManager.connectServer(serverName, serverConfig);
                mcpTools = this.mcpManager.getToolHandlers(serverName);
              }
              const toolNames: string[] = [];
              for (const tool of mcpTools) {
                agent.registerTool(tool);
                toolNames.push(tool.name);
              }
              agent.activateTools(toolNames);
              log.info(`Skill ${skillName} MCP server ${serverName} connected for agent ${id}`, {
                toolCount: mcpTools.length, isolated,
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
    agent.setSkillMcpActivator(async (skillName, mcpServers) => {
      let tools: AgentToolHandler[] = [];
      const skill = this.skillRegistry?.get(skillName);
      const isolated = skill?.manifest.isolation === 'per-agent';
      for (const [serverName, rawSrvConfig] of Object.entries(mcpServers)) {
        const srvConfig = this.enrichChromeDevtoolsConfig(serverName, rawSrvConfig);
        if (isolated) {
          await this.mcpManager.connectServerScoped(serverName, srvConfig, id);
          tools.push(...this.mcpManager.getToolHandlersScoped(serverName, id));
        } else {
          await this.mcpManager.connectServer(serverName, srvConfig);
          tools.push(...this.mcpManager.getToolHandlers(serverName));
        }
      }
      if (isolated) {
        tools = this.browserSessionManager.wrapToolHandlers(tools, id);
      }
      return tools;
    });

    // Set skill search/install callbacks (injected by org-manager layer)
    if (this.skillSearcher) agent.setSkillSearcher(this.skillSearcher);
    if (this.skillInstaller) agent.setSkillInstaller(this.skillInstaller);
    if (this.userApprovalRequester) agent.setUserApprovalRequester(this.userApprovalRequester);
    if (this.userNotifier) agent.setUserNotifier(this.userNotifier);

    // A2A tools — every agent can message colleagues (all agents visible for cross-team)
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
      sendMessage: async (targetId: string, message: string, fromId: string, fromName: string, priority?: number) => {
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
        const reply = await target.sendMessage(
          message,
          fromId,
          { name: fromName, role: config.agentRole ?? 'worker' },
          {
            sourceType: 'a2a_message',
            sessionId: `a2a_${targetId}_${Date.now()}`,
            scenario: 'a2a',
            priority: priority as 0 | 1 | 2 | 3 | 4 | undefined,
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
            getChannelMessages: this.groupChatHandlers.getChannelMessages,
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

    // Recall tool — agents can query their own execution history
    if (this.recallCallbacks) {
      agent.registerTool(createRecallTool({ agentId: id, ...this.recallCallbacks }));
    }

    // Settings tools — agents can list providers and switch models via chat
    for (const tool of createSettingsTools({
      llmRouter: this.llmRouter,
      persistConfig: (updates) => { try { saveConfig(updates); } catch { /* best effort */ } },
    })) {
      agent.registerTool(tool);
    }

    if (this.semanticSearch) {
      agent.getContextEngine().setSemanticSearch(this.semanticSearch);
      agent.setSemanticSearch(this.semanticSearch);
    }

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
            reviewerAgentId: params.reviewerAgentId,
            requirementId: params.requirementId,
            projectId: params.projectId,
            blockedBy: params.blockedBy,
            taskType: params.taskType,
            scheduleConfig: params.scheduleConfig,
            createdBy: id,
            creatorRole: 'worker',
          });
        },
        listTasks: async filter => {
          return ts.queryTasks({
            orgId,
            status: filter?.status as any,
            assignedAgentId: filter?.assignedToMe ? id : undefined,
            priority: filter?.priority as any,
            requirementId: filter?.requirementId,
            projectId: filter?.projectId,
            search: filter?.search,
            sortBy: filter?.sortBy as any,
            sortOrder: filter?.sortOrder as any,
            page: filter?.page,
            pageSize: filter?.pageSize,
          });
        },
        updateTaskStatus: async (taskId, status) => {
          return ts.updateTaskStatus(taskId, status, id);
        },
        requestRevision: async (taskId, reason) => {
          return ts.requestRevision(taskId, reason, id);
        },
        getTask: async taskId => {
          return ts.getTask(taskId) ?? null;
        },
        assignTask: async (taskId, agentId) => {
          return ts.assignTask(taskId, agentId, id);
        },
        addTaskNote: async (taskId, note, author) => {
          ts.addTaskNote(taskId, note, author);
        },
        updateTaskFields: async (taskId, fields) => {
          const task = ts.updateTask(taskId, fields, id);
          return { id: task.id, title: task.title, status: task.status };
        },
        updateScheduleConfig: async (taskId, config) => {
          if (!ts.updateScheduleFields) throw new Error('Schedule editing not supported');
          const task = await ts.updateScheduleFields(taskId, config);
          return { id: task.id, title: task.title, status: task.status };
        },
        cancelPendingTask: async (taskId) => {
          const task = ts.rejectTask(taskId, id);
          return { id: task.id, title: task.title, status: task.status };
        },
        addSubtask: async (taskId, title) => {
          return ts.addSubtask(taskId, title);
        },
        completeSubtask: async (taskId, subtaskId) => {
          return ts.completeSubtask(taskId, subtaskId);
        },
        getSubtasks: async (taskId) => {
          const task = ts.getTask(taskId);
          return task?.subtasks ?? [];
        },
        submitForReview: async (summary, inputDeliverables, knownIssues) => {
          const taskId = resolveCurrentTaskId(this.agents.get(id), ts, id);
          const task = ts.getTask(taskId);
          if (!task) throw new Error(`Task not found: ${taskId}`);
          const reviewerAgentId = (task as Record<string, unknown>).reviewerAgentId as string | undefined;
          const _validTypes = new Set(['file', 'directory']);
          const deliverables: Array<{ type: string; reference: string; summary: string }> = [{
            type: 'branch', reference: `task/${taskId}`,
            summary: `${summary}${knownIssues ? `\n\nKnown issues: ${knownIssues}` : ''}`,
          }];
          if (Array.isArray(inputDeliverables)) {
            for (const d of inputDeliverables) {
              if (d?.reference) {
                deliverables.push({
                  type: _validTypes.has(d.type ?? '') ? d.type! : 'file',
                  reference: d.reference, summary: d.summary || String(d.reference),
                });
              }
            }
          }
          return ts.submitForReview(taskId, deliverables, reviewerAgentId);
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
                createdBy: filter?.createdBy,
              });
            }
          : undefined,
        getRequirement: this.requirementService
          ? async (reqId) => {
              const req = this.requirementService!.getRequirement(reqId);
              if (!req) return null;
              const comments = ts.getRequirementComments?.(reqId) ?? [];
              return { ...req, comments };
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
        updateRequirement: this.requirementService
          ? async (reqId, data) => {
              return this.requirementService!.updateRequirement(reqId, data);
            }
          : undefined,
        resubmitRequirement: this.requirementService
          ? async (reqId, updates) => {
              return this.requirementService!.resubmitRequirement(reqId, updates);
            }
          : undefined,
        getTaskComments: ts.getTaskComments
          ? async (taskId) => ts.getTaskComments!(taskId)
          : undefined,
        postTaskComment: ts.postTaskComment
          ? async (taskId, content, mentions, activityId) => ts.postTaskComment!(taskId, id, config.name, content, mentions, activityId)
          : undefined,
        postRequirementComment: ts.postRequirementComment
          ? async (reqId, content, mentions, activityId) => ts.postRequirementComment!(reqId, id, config.name, content, mentions, activityId)
          : undefined,
        getCurrentActivityId: () => agent.getCurrentActivityId(),
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

    // Project tools — every agent can list/view/create/update projects
    if (this.projectService) {
      const ah = this.approvalHandler;
      for (const tool of createProjectTools({
        agentId: id,
        orgId: config.orgId,
        webUiBaseUrl: this.webUiBaseUrl,
        projectService: this.projectService,
        requestApproval: ah ? (req) => ah(id, req) : undefined,
        ...this.buildKnowledgeCallbacks(id, config.orgId),
        ...this.buildDeliverableCallbacks(id, config.orgId),
      })) {
        agent.registerTool(tool);
      }
    }

    // If this is a manager agent, inject manager-specific tools (scoped to own team)
    if (request.agentRole === 'manager') {
      const myTeamId = config.teamId;
      const filterByTeam = <T extends { teamId?: string }>(list: T[]): T[] =>
        myTeamId ? list.filter(a => a.teamId === myTeamId) : list;
      const managerTools = createManagerTools({
        listAgents: () =>
          filterByTeam(this.listAgents()).map(a => {
            try {
              const ag = this.getAgent(a.id);
              return { ...a, skills: ag.config.skills };
            } catch {
              return { ...a, skills: [] };
            }
          }),
        delegateMessage: async (targetId, message, _from) => {
          const target = this.getAgent(targetId);
          const reply = await target.sendMessage(message, id, { name: config.name, role: 'manager' }, { sourceType: 'a2a_message' });
          return stripInternalBlocks(reply);
        },
        getTeamStatus: () =>
          filterByTeam(this.listAgents()).map(a => {
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
        hireFromTemplate: this.templateRegistry
          ? async (templateId: string, name: string, skills?: string[]) => {
              const newAgent = await this.createAgentFromTemplate({
                templateId,
                name,
                orgId: config.orgId ?? 'default',
                teamId: config.teamId,
                overrides: skills ? { skills } : undefined,
              });
              await this.startAgent(newAgent.id);
              return { id: newAgent.id, name: newAgent.config.name, role: newAgent.role.name };
            }
          : undefined,
        listTemplates: this.templateRegistry
          ? () => this.templateRegistry!.list().map(t => ({
              id: t.id, name: t.name, description: t.description, roleId: t.roleId, category: t.category ?? 'general',
            }))
          : undefined,
        installArtifact: this.builderService
          ? (type: 'agent' | 'team' | 'skill', name: string) => this.builderService!.installArtifact(type, name)
          : undefined,
        listArtifacts: this.builderService
          ? (type?: 'agent' | 'team' | 'skill') => this.builderService!.listArtifacts(type)
          : undefined,
        updateTeam: this.teamUpdater
          ? async (teamId: string, data: { name?: string; description?: string }) => this.teamUpdater!(teamId, data)
          : undefined,
        updateAgentConfig: async (agentId: string, data: { name?: string }) => {
          const targetAgent = this.getAgent(agentId);
          if (data.name !== undefined) {
            (targetAgent.config as unknown as Record<string, unknown>).name = data.name;
          }
          if (this.agentConfigPersister) {
            await this.agentConfigPersister(agentId, data);
          }
          return { id: agentId, name: targetAgent.config.name };
        },
      });
      for (const tool of managerTools) {
        agent.registerTool(tool);
      }

      // Hub tools for agents with building skills (Secretary)
      const BUILDING_SKILLS = new Set(['agent-building', 'team-building', 'skill-building']);
      const hasBuilderSkill = config.skills?.some((s: string) => BUILDING_SKILLS.has(s));
      if (hasBuilderSkill && this.hubClient) {
        const hubTools = createHubTools({
          searchHub: (opts) => this.hubClient!.search(opts),
          downloadAndInstall: (itemId) => this.hubClient!.downloadAndInstall(itemId),
        });
        for (const tool of hubTools) agent.registerTool(tool);
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
    if (this.activityCallbacks) {
      agent.setActivityCallbacks(this.activityCallbacks);
    }
    this.forwardAgentEvents(agent);

    if (config.teamId) {
      agent.setTeamDataDir(join(homedir(), '.markus', 'teams', config.teamId));
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
    } else if (row.roleId === 'custom') {
      role = {
        id: generateId('role'),
        name: row.name,
        description: '',
        category: 'custom' as RoleCategory,
        systemPrompt: `# ${row.name}\n\nYou are ${row.name}.`,
        defaultSkills: [],
        heartbeatChecklist: '',
        defaultPolicies: [],
        builtIn: false,
      };
    } else {
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

    const teamDataDir = (config.teamId && config.agentRole === 'manager')
      ? join(homedir(), '.markus', 'teams', config.teamId)
      : undefined;

    const builderArtifactsDir = join(homedir(), '.markus', 'builder-artifacts');

    const pathPolicy = this.buildPathPolicy(id, workspacePath, agentRoleDir, teamDataDir, builderArtifactsDir);

    const basePolicy = this.globalSecurityPolicy;
    const security = new SecurityGuard({
      ...basePolicy,
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
      maxToolIterations: this._maxToolIterations,
    });

    // Inject always-on builtin skill instructions into every agent (text only, no MCP)
    if (this.skillRegistry) {
      const builtinInstructions = this.skillRegistry.getBuiltinInstructions();
      for (const [skillName, instructions] of builtinInstructions) {
        agent.injectSkillInstructions(skillName, instructions);
      }
      agent.setAvailableSkillCatalog(this.skillRegistry.getSkillCatalog());
    }

    // Inject explicitly assigned skill instructions and connect skill MCP servers
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
        if (!agent.hasSkillInstructions(skillName)) {
          agent.injectSkillInstructions(skillName, instructions);
        }
      }

      // Connect MCP servers declared by explicitly assigned skills (background, non-blocking).
      // Connections complete asynchronously and register tools when ready.
      // This avoids blocking startup for slow MCP processes (e.g. npx chrome-devtools).
      const mcpConnections: Array<Promise<void>> = [];
      for (const skillName of config.skills) {
        const skill = this.skillRegistry.get(skillName);
        if (skill?.manifest.mcpServers) {
          const isolated = skill.manifest.isolation === 'per-agent';
          for (const [serverName, rawServerConfig] of Object.entries(skill.manifest.mcpServers)) {
            mcpConnections.push((async () => {
              try {
                const serverConfig = this.enrichChromeDevtoolsConfig(serverName, rawServerConfig);
                let mcpTools: AgentToolHandler[];
                if (isolated) {
                  await this.mcpManager.connectServerScoped(serverName, serverConfig, id);
                  mcpTools = this.mcpManager.getToolHandlersScoped(serverName, id);
                  mcpTools = this.browserSessionManager.wrapToolHandlers(mcpTools, id);
                } else {
                  await this.mcpManager.connectServer(serverName, serverConfig);
                  mcpTools = this.mcpManager.getToolHandlers(serverName);
                }
                const toolNames: string[] = [];
                for (const tool of mcpTools) {
                  agent.registerTool(tool);
                  toolNames.push(tool.name);
                }
                agent.activateTools(toolNames);
                log.info(`Skill ${skillName} MCP server ${serverName} restored for agent ${id}`, {
                  toolCount: mcpTools.length, isolated,
                });
              } catch (error) {
                log.warn(`Failed to restore skill ${skillName} MCP server ${serverName} for agent ${id}`, {
                  error: String(error),
                });
              }
            })());
          }
        }
      }
      void Promise.all(mcpConnections);
    }

    // Set skill MCP activator callback for runtime activation via discover_tools
    agent.setSkillMcpActivator(async (skillName, mcpServers) => {
      let tools: AgentToolHandler[] = [];
      const skill = this.skillRegistry?.get(skillName);
      const isolated = skill?.manifest.isolation === 'per-agent';
      for (const [serverName, rawSrvConfig] of Object.entries(mcpServers)) {
        const srvConfig = this.enrichChromeDevtoolsConfig(serverName, rawSrvConfig);
        if (isolated) {
          await this.mcpManager.connectServerScoped(serverName, srvConfig, id);
          tools.push(...this.mcpManager.getToolHandlersScoped(serverName, id));
        } else {
          await this.mcpManager.connectServer(serverName, srvConfig);
          tools.push(...this.mcpManager.getToolHandlers(serverName));
        }
      }
      if (isolated) {
        tools = this.browserSessionManager.wrapToolHandlers(tools, id);
      }
      return tools;
    });

    // Set skill search/install callbacks (injected by org-manager layer)
    if (this.skillSearcher) agent.setSkillSearcher(this.skillSearcher);
    if (this.skillInstaller) agent.setSkillInstaller(this.skillInstaller);
    if (this.userApprovalRequester) agent.setUserApprovalRequester(this.userApprovalRequester);
    if (this.userNotifier) agent.setUserNotifier(this.userNotifier);

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
      sendMessage: async (targetId: string, message: string, fromId: string, fromName: string, priority?: number) => {
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
        return target.sendMessage(
          message,
          fromId,
          { name: fromName, role: config.agentRole ?? 'worker' },
          {
            sourceType: 'a2a_message',
            sessionId: `a2a_${targetId}_${Date.now()}`,
            scenario: 'a2a',
            priority: priority as 0 | 1 | 2 | 3 | 4 | undefined,
          }
        );
      },
      delegateTask: async (targetId: string, delegation: TaskDelegation) =>
        this.delegationManager.delegateTask(id, delegation, targetId),
      ...(this.groupChatHandlers
        ? {
            sendGroupMessage: this.groupChatHandlers.sendGroupMessage,
            createGroupChat: (name: string, memberIds: string[]) =>
              this.groupChatHandlers!.createGroupChat(name, id, config.name, memberIds),
            listGroupChats: this.groupChatHandlers.listGroupChats,
            getChannelMessages: this.groupChatHandlers.getChannelMessages,
          }
        : {}),
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

    if (this.recallCallbacks) {
      agent.registerTool(createRecallTool({ agentId: id, ...this.recallCallbacks }));
    }

    for (const tool of createSettingsTools({
      llmRouter: this.llmRouter,
      persistConfig: (updates) => { try { saveConfig(updates); } catch { /* best effort */ } },
    })) {
      agent.registerTool(tool);
    }

    if (this.semanticSearch) {
      agent.getContextEngine().setSemanticSearch(this.semanticSearch);
      agent.setSemanticSearch(this.semanticSearch);
    }

    if (this.taskService) {
      const ts = this.taskService;
      const orgId = config.orgId;
      const taskCtx: AgentTaskContext = {
        agentId: id,
        agentName: config.name,
        createTask: async params => ts.createTask({ orgId, ...params, createdBy: id, creatorRole: 'worker' }),
        listTasks: async filter =>
          ts.queryTasks({
            orgId,
            status: filter?.status as any,
            assignedAgentId: filter?.assignedToMe ? id : undefined,
            priority: filter?.priority as any,
            requirementId: filter?.requirementId,
            projectId: filter?.projectId,
            search: filter?.search,
            sortBy: filter?.sortBy as any,
            sortOrder: filter?.sortOrder as any,
            page: filter?.page,
            pageSize: filter?.pageSize,
          }),
        updateTaskStatus: async (taskId, status) => ts.updateTaskStatus(taskId, status, id),
        requestRevision: async (taskId, reason) => ts.requestRevision(taskId, reason, id),
        getTask: async taskId => ts.getTask(taskId) ?? null,
        assignTask: async (taskId, agentId) => ts.assignTask(taskId, agentId, id),
        addTaskNote: async (taskId, note, author) => {
          ts.addTaskNote(taskId, note, author);
        },
        updateTaskFields: async (taskId, fields) => {
          const task = ts.updateTask(taskId, fields, id);
          return { id: task.id, title: task.title, status: task.status };
        },
        updateScheduleConfig: async (taskId, config) => {
          if (!ts.updateScheduleFields) throw new Error('Schedule editing not supported');
          const task = await ts.updateScheduleFields(taskId, config);
          return { id: task.id, title: task.title, status: task.status };
        },
        cancelPendingTask: async (taskId) => {
          const task = ts.rejectTask(taskId, id);
          return { id: task.id, title: task.title, status: task.status };
        },
        addSubtask: async (taskId, title) => {
          return ts.addSubtask(taskId, title);
        },
        completeSubtask: async (taskId, subtaskId) => {
          return ts.completeSubtask(taskId, subtaskId);
        },
        getSubtasks: async (taskId) => {
          const task = ts.getTask(taskId);
          return task?.subtasks ?? [];
        },
        submitForReview: async (summary, inputDeliverables, knownIssues) => {
          const taskId = resolveCurrentTaskId(this.agents.get(id), ts, id);
          const task = ts.getTask(taskId);
          if (!task) throw new Error(`Task not found: ${taskId}`);
          const reviewerAgentId = (task as Record<string, unknown>).reviewerAgentId as string | undefined;
          const _validTypes = new Set(['file', 'directory']);
          const deliverables: Array<{ type: string; reference: string; summary: string }> = [{
            type: 'branch', reference: `task/${taskId}`,
            summary: `${summary}${knownIssues ? `\n\nKnown issues: ${knownIssues}` : ''}`,
          }];
          if (Array.isArray(inputDeliverables)) {
            for (const d of inputDeliverables) {
              if (d?.reference) {
                deliverables.push({
                  type: _validTypes.has(d.type ?? '') ? d.type! : 'file',
                  reference: d.reference, summary: d.summary || String(d.reference),
                });
              }
            }
          }
          return ts.submitForReview(taskId, deliverables, reviewerAgentId);
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
                createdBy: filter?.createdBy,
              });
            }
          : undefined,
        getRequirement: this.requirementService
          ? async (reqId) => {
              const req = this.requirementService!.getRequirement(reqId);
              if (!req) return null;
              const comments = ts.getRequirementComments?.(reqId) ?? [];
              return { ...req, comments };
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
        updateRequirement: this.requirementService
          ? async (reqId, data) => {
              return this.requirementService!.updateRequirement(reqId, data);
            }
          : undefined,
        resubmitRequirement: this.requirementService
          ? async (reqId, updates) => {
              return this.requirementService!.resubmitRequirement(reqId, updates);
            }
          : undefined,
        getTaskComments: ts.getTaskComments
          ? async (taskId) => ts.getTaskComments!(taskId)
          : undefined,
        postTaskComment: ts.postTaskComment
          ? async (taskId, content, mentions) => ts.postTaskComment!(taskId, id, config.name, content, mentions)
          : undefined,
        postRequirementComment: ts.postRequirementComment
          ? async (reqId, content, mentions) => ts.postRequirementComment!(reqId, id, config.name, content, mentions)
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
      const ah2 = this.approvalHandler;
      for (const tool of createProjectTools({
        agentId: id,
        orgId: config.orgId,
        webUiBaseUrl: this.webUiBaseUrl,
        projectService: this.projectService,
        requestApproval: ah2 ? (req) => ah2(id, req) : undefined,
        ...this.buildKnowledgeCallbacks(id, config.orgId),
        ...this.buildDeliverableCallbacks(id, config.orgId),
      })) {
        agent.registerTool(tool);
      }
    }

    if (config.agentRole === 'manager') {
      const restoredTeamId = config.teamId;
      const filterByTeamRestored = <T extends { teamId?: string }>(list: T[]): T[] =>
        restoredTeamId ? list.filter(a => a.teamId === restoredTeamId) : list;
      const managerTools = createManagerTools({
        listAgents: () =>
          filterByTeamRestored(this.listAgents()).map(a => {
            try {
              const ag = this.getAgent(a.id);
              return { ...a, skills: ag.config.skills };
            } catch {
              return { ...a, skills: [] };
            }
          }),
        delegateMessage: async (targetId, message) => {
          const target = this.getAgent(targetId);
          const reply = await target.sendMessage(message, id, { name: config.name, role: 'manager' }, { sourceType: 'a2a_message' });
          return stripInternalBlocks(reply);
        },
        getTeamStatus: () =>
          filterByTeamRestored(this.listAgents()).map(a => {
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
        hireFromTemplate: this.templateRegistry
          ? async (templateId: string, name: string, skills?: string[]) => {
              const newAgent = await this.createAgentFromTemplate({
                templateId,
                name,
                orgId: config.orgId ?? 'default',
                teamId: config.teamId,
                overrides: skills ? { skills } : undefined,
              });
              await this.startAgent(newAgent.id);
              return { id: newAgent.id, name: newAgent.config.name, role: newAgent.role.name };
            }
          : undefined,
        listTemplates: this.templateRegistry
          ? () => this.templateRegistry!.list().map(t => ({
              id: t.id, name: t.name, description: t.description, roleId: t.roleId, category: t.category ?? 'general',
            }))
          : undefined,
        installArtifact: this.builderService
          ? (type: 'agent' | 'team' | 'skill', name: string) => this.builderService!.installArtifact(type, name)
          : undefined,
        listArtifacts: this.builderService
          ? (type?: 'agent' | 'team' | 'skill') => this.builderService!.listArtifacts(type)
          : undefined,
        updateTeam: this.teamUpdater
          ? async (teamId: string, data: { name?: string; description?: string }) => this.teamUpdater!(teamId, data)
          : undefined,
        updateAgentConfig: async (agentId: string, data: { name?: string }) => {
          const targetAgent = this.getAgent(agentId);
          if (data.name !== undefined) {
            (targetAgent.config as unknown as Record<string, unknown>).name = data.name;
          }
          if (this.agentConfigPersister) {
            await this.agentConfigPersister(agentId, data);
          }
          return { id: agentId, name: targetAgent.config.name };
        },
      });
      for (const tool of managerTools) agent.registerTool(tool);

      const BUILDING_SKILLS_R = new Set(['agent-building', 'team-building', 'skill-building']);
      const hasBuilderSkillR = config.skills?.some((s: string) => BUILDING_SKILLS_R.has(s));
      if (hasBuilderSkillR && this.hubClient) {
        const hubTools = createHubTools({
          searchHub: (opts) => this.hubClient!.search(opts),
          downloadAndInstall: (itemId) => this.hubClient!.downloadAndInstall(itemId),
        });
        for (const tool of hubTools) agent.registerTool(tool);
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
    if (this.activityCallbacks) {
      agent.setActivityCallbacks(this.activityCallbacks);
    }
    this.forwardAgentEvents(agent);

    if (config.teamId) {
      agent.setTeamDataDir(join(homedir(), '.markus', 'teams', config.teamId));
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

  async startAgent(agentId: string, options?: { initialHeartbeatDelayMs?: number; startAsPaused?: boolean }): Promise<void> {
    const agent = this.getAgent(agentId);
    await agent.start(options);
  }

  async stopAgent(agentId: string): Promise<void> {
    const agent = this.getAgent(agentId);
    await agent.stop();
  }

  async removeAgent(agentId: string, opts?: { purgeFiles?: boolean }): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      try { await agent.stop(); } catch { /* proceed with removal even if stop fails */ }
      this.browserSessionManager.cleanupAgent(agentId);
      await this.mcpManager.disconnectAllForScope(agentId);
      this.delegationManager.unregisterAgentCard(agentId);
      this.agents.delete(agentId);
      this.eventBus.emit('agent:removed', { agentId });
    }

    if (opts?.purgeFiles) {
      const agentDir = join(this.dataDir, agentId);
      if (existsSync(agentDir)) {
        try {
          rmSync(agentDir, { recursive: true, force: true });
          log.info(`Agent data directory purged: ${agentDir}`);
        } catch (err) {
          log.warn('Failed to purge agent data directory', { agentId, error: String(err) });
        }
      }
    }

    log.info(`Agent removed: ${agentId}`, { purgeFiles: !!opts?.purgeFiles });
  }

  /** Remove orphaned agent directories that have no matching DB record */
  purgeOrphanedAgentDirs(knownAgentIds: Set<string>): { removed: string[]; failed: string[] } {
    const removed: string[] = [];
    const failed: string[] = [];
    if (!existsSync(this.dataDir)) return { removed, failed };
    for (const entry of readdirSync(this.dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'vector-store') continue;
      if (knownAgentIds.has(entry.name)) continue;
      const dirPath = join(this.dataDir, entry.name);
      try {
        rmSync(dirPath, { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        failed.push(entry.name);
      }
    }
    if (removed.length > 0) log.info(`Purged ${removed.length} orphaned agent directories`);
    return { removed, failed };
  }

  getAgent(agentId: string): Agent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    return agent;
  }

  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
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
      request: { toolName: string; toolArgs: Record<string, unknown>; reason: string; taskId?: string }
    ) => Promise<{ approved: boolean; comment?: string }>
  ): void {
    this.approvalHandler = handler;
    for (const [id, agent] of this.agents) {
      agent.setApprovalCallback(
        async (req: { toolName: string; toolArgs: Record<string, unknown>; reason: string; taskId?: string }) =>
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
    // Wrap handler to also sync AgentCard status in DelegationManager
    this.stateChangeHandler = (agentId, state) => {
      handler(agentId, state);
      this.delegationManager.updateAgentStatus(agentId, state.status);
    };
    for (const [, agent] of this.agents) {
      agent.setStateChangeCallback(this.stateChangeHandler);
    }
  }

  /**
   * Forward events from an agent's private EventBus to the manager's
   * EventBus so that external listeners (e.g. start.ts WS broadcasts) receive them.
   *
   * Each Agent creates its own EventBus. Without forwarding, events emitted by
   * the agent, its mailbox, and its attention controller would never reach the
   * manager-level bus where start.ts registers WS broadcast handlers.
   */
  private forwardAgentEvents(agent: Agent): void {
    const FORWARDED_EVENTS = [
      'agent:activity-log',
      'agent:activity_log',
      'agent:started',
      'agent:stopped',
      'agent:paused',
      'agent:resumed',
      'agent:focus-changed',
      'agent:message',
      'task:completed',
      'task:failed',
      'mailbox:new-item',
      'attention:decision',
      'attention:state-changed',
      'attention:triage',
    ] as const;
    const agentBus = agent.getEventBus();
    for (const eventName of FORWARDED_EVENTS) {
      agentBus.on(eventName, (payload: unknown) => {
        this.eventBus.emit(eventName, payload);
      });
    }
  }

  setActivityCallbacks(cbs: {
    onStart: (activity: AgentActivity & { agentId: string }) => void;
    onLog: (data: { activityId: string; agentId: string; seq: number; type: string; content: string; metadata?: Record<string, unknown> }) => void;
    onEnd: (activityId: string, summary: { endedAt: string; totalTokens: number; totalTools: number; success: boolean; summary?: string; keywords?: string }) => void;
  }): void {
    this.activityCallbacks = cbs;
    for (const [, agent] of this.agents) {
      agent.setActivityCallbacks(cbs);
    }
  }

  setRecallCallbacks(cbs: RecallCallbacks): void {
    this.recallCallbacks = cbs;
    for (const [id, agent] of this.agents) {
      agent.registerTool(createRecallTool({ agentId: id, ...cbs }));
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
    mailboxDepth?: number;
    attentionState?: string;
    modelSupportsVision?: boolean;
  }> {
    return [...this.agents.values()].map(a => {
      const state = a.getState();
      let mailboxDepth: number | undefined;
      let attentionState: string | undefined;
      try {
        mailboxDepth = a.getMailbox().depth;
        attentionState = a.getAttentionController().getState();
      } catch { /* mailbox may not be initialized */ }
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
        mailboxDepth,
        attentionState,
        modelSupportsVision: a.getModelSupportsVision(),
      };
    });
  }

  listAvailableRoles(): string[] {
    return this.roleLoader.listAvailableRoles();
  }

  getEventBus(): EventBus {
    return this.eventBus;
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

  setBuilderService(service: { listArtifacts: (type?: 'agent' | 'team' | 'skill') => Array<{ type: string; name: string; description?: string }>; installArtifact: (type: 'agent' | 'team' | 'skill', name: string) => Promise<{ type: string; installed: unknown }> }): void {
    this.builderService = service;
  }

  setTeamUpdater(updater: (teamId: string, data: { name?: string; description?: string }) => Promise<{ id: string; name: string; description?: string }>): void {
    this.teamUpdater = updater;
  }

  setAgentConfigPersister(persister: (agentId: string, data: Record<string, unknown>) => Promise<void>): void {
    this.agentConfigPersister = persister;
  }

  setHubClient(client: { search: (opts?: { type?: string; query?: string }) => Promise<Array<{ id: string; name: string; type: string; description: string; author: string; version?: string; downloads?: number }>>; downloadAndInstall: (itemId: string) => Promise<{ type: string; installed: unknown }> }): void {
    this.hubClient = client;
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
    getChannelMessages?: (
      channelKey: string,
      limit: number,
      before?: string
    ) => Promise<{ messages: Array<{ senderName: string; senderType: string; text: string; createdAt: string }>; hasMore: boolean }>;
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

  async startAgentsByIds(
    ids: string[],
    options?: { staggerHeartbeats?: boolean },
  ): Promise<{ success: string[]; failed: Array<{ id: string; error: string }> }> {
    const stagger = options?.staggerHeartbeats ?? true;
    const success: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      try {
        let initialHeartbeatDelayMs: number | undefined;
        if (stagger && ids.length > 1) {
          const agent = this.getAgent(id);
          const intervalMs = agent.config.heartbeatIntervalMs || 30 * 60 * 1000;
          initialHeartbeatDelayMs = Math.floor((i / ids.length) * intervalMs);
        }
        await this.startAgent(id, { initialHeartbeatDelayMs });
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
        agent.pause(reason);
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
    for (const [id, agent] of this.agents) {
      try {
        agent.pause(reason);
      } catch (err) {
        log.warn('Failed to pause agent', { agentId: id, error: String(err) });
      }
    }
    this.globalPaused = true;
    this.eventBus.emit('system:pause-all', { reason });
    log.info('All agents paused', { reason });
  }

  async resumeAllAgents(): Promise<void> {
    for (const [id, agent] of this.agents) {
      try {
        if (agent.getState().status === 'paused') {
          agent.resume();
        }
      } catch (err) {
        log.warn('Failed to resume agent', { agentId: id, error: String(err) });
      }
    }
    this.globalPaused = false;
    this.emergencyMode = false;
    this.eventBus.emit('system:resume-all', {});
    log.info('All agents resumed');
  }

  async emergencyStop(): Promise<void> {
    for (const [id, agent] of this.agents) {
      try {
        agent.cancelActiveStream();
        await agent.stop();
      } catch (err) {
        log.warn('Failed to stop agent during emergency', { agentId: id, error: String(err) });
      }
    }
    this.emergencyMode = true;
    this.globalPaused = true;
    this.eventBus.emit('system:emergency-stop', {});
    log.warn('EMERGENCY STOP — all agents stopped');
  }

  isGlobalPaused(): boolean {
    return this.globalPaused;
  }

  setGlobalPaused(paused: boolean): void {
    this.globalPaused = paused;
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

  // ─── Role Template Versioning & Sync ──────────────────────────────────────

  private static readonly ROLE_FILES = ['ROLE.md', 'HEARTBEAT.md', 'POLICIES.md', 'CONTEXT.md'] as const;

  checkRoleUpdate(agentId: string): RoleUpdateStatus {
    const agent = this.getAgent(agentId);
    const { roleId } = agent.config;
    const agentRoleDir = join(this.dataDir, agentId, 'role');

    // Skip comparison for agents with custom roles (e.g. installed from builder artifacts)
    const originPath = join(agentRoleDir, '.role-origin.json');
    if (existsSync(originPath)) {
      try {
        const origin = JSON.parse(readFileSync(originPath, 'utf-8'));
        if (origin.customRole) {
          return { agentId, roleId, templateId: roleId, hasTemplate: false, isUpToDate: true, files: [] };
        }
      } catch { /* ignore malformed file */ }
    }

    const templateDir = this.roleLoader.resolveTemplateDir(roleId);

    if (!templateDir) {
      return { agentId, roleId, templateId: roleId, hasTemplate: false, isUpToDate: true, files: [] };
    }

    // Fallback heuristic: if the ROLE.md title (first # heading) differs from the
    // template's, this is a custom-built agent — skip template comparison.
    const agentRolePath = join(agentRoleDir, 'ROLE.md');
    const templateRolePath = join(templateDir, 'ROLE.md');
    if (existsSync(agentRolePath) && existsSync(templateRolePath)) {
      const headingOf = (text: string) => text.match(/^#\s+(.+)/m)?.[1]?.trim();
      const agentTitle = headingOf(readFileSync(agentRolePath, 'utf-8'));
      const templateTitle = headingOf(readFileSync(templateRolePath, 'utf-8'));
      if (agentTitle && templateTitle && agentTitle !== templateTitle) {
        return { agentId, roleId, templateId: roleId, hasTemplate: false, isUpToDate: true, files: [] };
      }
    }

    const files: RoleFileStatus[] = [];
    let allIdentical = true;

    for (const file of AgentManager.ROLE_FILES) {
      const tPath = join(templateDir, file);
      const aPath = join(agentRoleDir, file);
      const tExists = existsSync(tPath);
      const aExists = existsSync(aPath);

      if (!tExists && !aExists) continue;

      if (tExists && !aExists) {
        files.push({ file, status: 'added_in_template' });
        allIdentical = false;
      } else if (!tExists && aExists) {
        files.push({ file, status: 'agent_only' });
      } else {
        const tContent = readFileSync(tPath, 'utf-8');
        const aContent = readFileSync(aPath, 'utf-8');
        if (tContent === aContent) {
          files.push({ file, status: 'identical' });
        } else {
          files.push({ file, status: 'modified' });
          allIdentical = false;
        }
      }
    }

    return { agentId, roleId, templateId: roleId, hasTemplate: true, isUpToDate: allIdentical, files };
  }

  getRoleFileDiff(agentId: string, fileName: string): RoleFileDiff {
    const agent = this.getAgent(agentId);
    const { roleId } = agent.config;
    const templateDir = this.roleLoader.resolveTemplateDir(roleId);
    const agentRoleDir = join(this.dataDir, agentId, 'role');

    const aPath = join(agentRoleDir, fileName);
    const tPath = templateDir ? join(templateDir, fileName) : null;

    return {
      file: fileName,
      agentContent: existsSync(aPath) ? readFileSync(aPath, 'utf-8') : null,
      templateContent: tPath && existsSync(tPath) ? readFileSync(tPath, 'utf-8') : null,
    };
  }

  syncRoleFromTemplate(agentId: string, fileNames?: string[]): RoleSyncResult {
    const agent = this.getAgent(agentId);
    const { roleId } = agent.config;
    const templateDir = this.roleLoader.resolveTemplateDir(roleId);

    if (!templateDir) {
      return { agentId, success: false, error: `No template found for roleId: ${roleId}`, synced: [] };
    }

    const agentRoleDir = join(this.dataDir, agentId, 'role');
    mkdirSync(agentRoleDir, { recursive: true });

    const filesToSync = fileNames ?? [...AgentManager.ROLE_FILES];
    const synced: string[] = [];

    for (const file of filesToSync) {
      const src = join(templateDir, file);
      if (existsSync(src)) {
        copyFileSync(src, join(agentRoleDir, file));
        synced.push(file);
      }
    }

    agent.reloadRole();

    log.info('Synced agent role from template', { agentId, roleId, synced });
    return { agentId, success: true, synced };
  }

  checkAllRoleUpdates(): RoleUpdateStatus[] {
    const results: RoleUpdateStatus[] = [];
    for (const [agentId] of this.agents) {
      try {
        results.push(this.checkRoleUpdate(agentId));
      } catch {
        /* skip agents that fail to check */
      }
    }
    return results;
  }

  // ─── System Announcements ────────────────────────────────────────────────

  private announcements: SystemAnnouncement[] = [];

  broadcastAnnouncement(announcement: SystemAnnouncement): void {
    this.announcements.push(announcement);

    for (const [, agent] of this.agents) {
      if (agent.getState().status !== 'offline') {
        agent.enqueueToMailbox('system_event', {
          summary: `[Announcement] ${announcement.title}`.slice(0, 100),
          content: JSON.stringify(announcement),
        }, {
          metadata: { senderId: 'system', senderName: 'System' },
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
   * Colleagues are scoped to the agent's own team; other teams are listed for cross-team awareness.
   */
  refreshIdentityContexts(
    orgId: string,
    orgName: string,
    humans: HumanUser[],
    teams?: Array<{ id: string; name: string; description?: string; memberAgentIds: string[] }>,
    projects?: Array<{ id: string; name: string; description: string; status: string; teamIds: string[] }>,
  ): void {
    const orgAgents = [...this.agents.values()].filter(a => a.config.orgId === orgId);

    const resolvedProjects = projects ?? (this.projectService
      ? this.projectService.listProjects(orgId)
      : []);

    const agentTeamMap = new Map<string, string>();
    for (const t of teams ?? []) {
      for (const aid of t.memberAgentIds) agentTeamMap.set(aid, t.id);
    }

    for (const agent of orgAgents) {
      const myTeamId = agent.config.teamId ?? agentTeamMap.get(agent.id);
      const myTeam = teams?.find(t => t.id === myTeamId);

      const sameTeamAgents = myTeamId
        ? orgAgents.filter(a => a.id !== agent.id && (a.config.teamId === myTeamId || agentTeamMap.get(a.id) === myTeamId))
        : orgAgents.filter(a => a.id !== agent.id);

      const colleagues = sameTeamAgents.map(a => ({
        id: a.id,
        name: a.config.name,
        role: a.role.name,
        type: 'agent' as const,
        skills: a.config.skills,
        status: a.getState().status,
      }));

      const teamManager = sameTeamAgents.find(a => a.config.agentRole === 'manager');

      const otherTeams = (teams ?? [])
        .filter(t => t.id !== myTeamId)
        .map(t => ({
          id: t.id,
          name: t.name,
          members: t.memberAgentIds
            .map(aid => {
              try {
                const a = this.getAgent(aid);
                return { id: a.id, name: a.config.name, role: a.role.name };
              } catch { return null; }
            })
            .filter((m): m is { id: string; name: string; role: string } => m !== null),
        }))
        .filter(t => t.members.length > 0);

      const teamProjects = myTeamId && resolvedProjects.length > 0
        ? resolvedProjects
            .filter(p => p.teamIds.includes(myTeamId))
            .map(p => ({ id: p.id, name: p.name, description: p.description, status: p.status }))
        : undefined;

      const identity: IdentityContext = {
        self: {
          id: agent.id,
          name: agent.config.name,
          role: agent.role.name,
          agentRole: agent.config.agentRole,
          skills: agent.config.skills,
        },
        organization: { id: orgId, name: orgName },
        team: myTeam ? { id: myTeam.id, name: myTeam.name, description: myTeam.description } : undefined,
        colleagues,
        otherTeams: otherTeams.length > 0 ? otherTeams : undefined,
        humans: humans.map(h => ({ id: h.id, name: h.name, role: h.role })),
        manager:
          teamManager && teamManager.id !== agent.id
            ? { id: teamManager.id, name: teamManager.config.name }
            : undefined,
        teamProjects: teamProjects && teamProjects.length > 0 ? teamProjects : undefined,
      };

      agent.setIdentityContext(identity);
    }

    log.info(`Refreshed identity contexts for ${orgAgents.length} agents in org ${orgId}`);
  }
}
