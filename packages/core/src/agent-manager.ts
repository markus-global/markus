import { createLogger, agentId as genAgentId, type AgentConfig, type IdentityContext, type HumanUser } from '@markus/shared';
import { Agent, type AgentToolHandler, type SandboxHandle, type AgentOptions } from './agent.js';
import type { OrgContext } from './context-engine.js';
import type { LLMRouter } from './llm/router.js';
import { RoleLoader } from './role-loader.js';
import { EventBus } from './events.js';
import { createBuiltinTools } from './tools/builtin.js';
import { MCPClientManager } from './tools/mcp-client.js';
import { createManagerTools } from './tools/manager.js';
import { createA2ATools } from './tools/a2a.js';
import { createStructuredA2ATools } from './tools/a2a-structured.js';
import { createAgentTaskTools, type AgentTaskContext } from './tools/task-tools.js';
import { createMemoryTools } from './tools/memory.js';
import type { SkillRegistry } from './skills/types.js';
import { SecurityGuard, type SecurityPolicy } from './security.js';
import { A2ABus } from '@markus/a2a';
import type { TemplateRegistry } from './templates/registry.js';
import type { TemplateInstantiateRequest } from './templates/types.js';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const log = createLogger('agent-manager');

export interface SandboxFactory {
  create(agentId: string, image?: string): Promise<SandboxHandle>;
  destroy(agentId: string): Promise<void>;
}

/** Minimal interface that AgentManager needs from TaskService */
export interface TaskServiceBridge {
  createTask(request: {
    orgId: string;
    title: string;
    description: string;
    priority?: string;
    assignedAgentId?: string;
    parentTaskId?: string;
  }): { id: string; title: string; status: string };
  listTasks(filters?: { orgId?: string; status?: string; assignedAgentId?: string }): Array<{
    id: string; title: string; description: string; status: string; priority: string; assignedAgentId?: string;
  }>;
  updateTaskStatus(id: string, status: string): { id: string; title: string; status: string };
  getTask(id: string): { id: string; title: string; description: string; status: string; priority: string; assignedAgentId?: string } | undefined;
  assignTask(id: string, agentId: string): { id: string; status: string };
  addTaskNote(id: string, note: string): void;
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
}

export class AgentManager {
  private agents = new Map<string, Agent>();
  private eventBus: EventBus;
  private llmRouter: LLMRouter;
  private roleLoader: RoleLoader;
  private dataDir: string;
  private sandboxFactory?: SandboxFactory;
  private mcpManager: MCPClientManager;
  private globalSecurityPolicy?: SecurityPolicy;
  private globalMcpServers?: Record<string, MCPServerConfig>;
  private skillRegistry?: SkillRegistry;
  private taskService?: TaskServiceBridge;
  private agentAuditCallback?: (agentId: string, event: { type: string; action: string; tokensUsed?: number; durationMs?: number; success: boolean; detail?: string }) => void;
  private escalationHandler?: (agentId: string, reason: string) => void;
  private a2aBus: A2ABus;
  private templateRegistry?: TemplateRegistry;
  private groupChatHandlers?: {
    sendGroupMessage: (channelKey: string, message: string, senderId: string, senderName: string) => Promise<string>;
    createGroupChat: (name: string, creatorId: string, creatorName: string, memberIds: string[]) => Promise<{ id: string; name: string }>;
    listGroupChats: () => Promise<Array<{ id: string; name: string; type: string; channelKey: string }>>;
  };

  constructor(options: {
    llmRouter: LLMRouter;
    roleLoader?: RoleLoader;
    dataDir?: string;
    eventBus?: EventBus;
    sandboxFactory?: SandboxFactory;
    securityPolicy?: SecurityPolicy;
    mcpServers?: Record<string, MCPServerConfig>;
    skillRegistry?: SkillRegistry;
    taskService?: TaskServiceBridge;
    templateRegistry?: TemplateRegistry;
  }) {
    this.llmRouter = options.llmRouter;
    this.roleLoader = options.roleLoader ?? new RoleLoader();
    this.dataDir = options.dataDir ?? join(process.cwd(), '.markus', 'agents');
    this.eventBus = options.eventBus ?? new EventBus();
    this.sandboxFactory = options.sandboxFactory;
    this.mcpManager = new MCPClientManager();
    this.globalSecurityPolicy = options.securityPolicy;
    this.globalMcpServers = options.mcpServers;
    this.skillRegistry = options.skillRegistry;
    this.taskService = options.taskService;
    this.a2aBus = new A2ABus();
    this.templateRegistry = options.templateRegistry;
    mkdirSync(this.dataDir, { recursive: true });
  }

  setTaskService(taskService: TaskServiceBridge): void {
    this.taskService = taskService;
  }

  async createAgent(request: CreateAgentRequest): Promise<Agent> {
    const id = genAgentId();
    const role = this.roleLoader.loadRole(request.roleName);
    const agentDataDir = join(this.dataDir, id);
    mkdirSync(agentDataDir, { recursive: true });

    const config: AgentConfig = {
      id,
      name: request.name,
      // Store the template folder name so agents can be restored on restart
      roleId: request.roleName,
      orgId: request.orgId ?? 'default',
      teamId: request.teamId,
      agentRole: request.agentRole ?? 'worker',
      skills: request.skills ?? role.defaultSkills,
      llmConfig: { primary: this.llmRouter.defaultProviderName },
      computeConfig: { type: 'docker' },
      channels: [],
      heartbeatIntervalMs: request.heartbeatIntervalMs ?? 30 * 60 * 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const security = new SecurityGuard(request.securityPolicy ?? this.globalSecurityPolicy);

    // Always inject builtin tools — this is the #1 requirement for agents to actually work
    const tools = request.tools ?? createBuiltinTools({ agentId: id, security });

    const agentOpts: AgentOptions = {
      config,
      role,
      llmRouter: this.llmRouter,
      dataDir: agentDataDir,
      tools,
      orgContext: request.orgContext,
    };

    const agent = new Agent(agentOpts);

    // Inject skill tools based on agent's configured skills
    if (this.skillRegistry && config.skills.length > 0) {
      const skillTools = this.skillRegistry.getToolsForSkills(config.skills);
      for (const tool of skillTools) {
        agent.registerTool(tool);
      }
      if (skillTools.length > 0) {
        log.info(`Skill tools injected for agent ${id}`, { skillCount: skillTools.length });
      }
    }

    // A2A tools — every agent can message colleagues
    const a2aContext: import('./tools/a2a.js').A2AContext = {
      selfId: id,
      selfName: config.name,
      listColleagues: () => this.listAgents().map(a => {
        try {
          const ag = this.getAgent(a.id);
          return { ...a, skills: ag.config.skills };
        } catch { return { ...a, skills: [] }; }
      }),
      sendMessage: async (targetId: string, message: string, fromId: string, fromName: string) => {
        const target = this.getAgent(targetId);
        return target.handleMessage(message, fromId, { name: fromName, role: config.agentRole ?? 'worker' }, {
          ephemeral: true,
          maxHistory: 15,
        });
      },
      ...(this.groupChatHandlers ? {
        sendGroupMessage: this.groupChatHandlers.sendGroupMessage,
        createGroupChat: (name: string, memberIds: string[]) => this.groupChatHandlers!.createGroupChat(name, id, config.name, memberIds),
        listGroupChats: this.groupChatHandlers.listGroupChats,
      } : {}),
    };
    for (const tool of createA2ATools(a2aContext)) agent.registerTool(tool);
    for (const tool of createStructuredA2ATools(a2aContext)) agent.registerTool(tool);

    // Memory tools — every agent can save/search/list memories
    for (const tool of createMemoryTools({ agentId: id, agentName: config.name, memory: agent.getMemory() })) {
      agent.registerTool(tool);
    }

    // Register agent on A2A bus for structured message delivery
    this.a2aBus.registerAgent(id, async (envelope) => {
      const summary = `[A2A:${envelope.type}] from=${envelope.from}: ${JSON.stringify(envelope.payload).slice(0, 200)}`;
      await agent.handleMessage(summary, envelope.from, { name: envelope.from, role: 'worker' }, {
        ephemeral: true,
        maxHistory: 10,
      });
    });

    // Task tools — every agent can create/list/update tasks
    if (this.taskService) {
      const ts = this.taskService;
      const orgId = config.orgId;
      const taskCtx: AgentTaskContext = {
        agentId: id,
        agentName: config.name,
        createTask: async (params) => {
          return ts.createTask({
            orgId,
            title: params.title,
            description: params.description,
            priority: params.priority,
            assignedAgentId: params.assignedAgentId,
            parentTaskId: params.parentTaskId,
          });
        },
        listTasks: async (filter) => {
          return ts.listTasks({
            orgId,
            status: filter?.status,
            assignedAgentId: filter?.assignedToMe ? id : undefined,
          });
        },
        updateTaskStatus: async (taskId, status) => {
          return ts.updateTaskStatus(taskId, status);
        },
        getTask: async (taskId) => {
          return ts.getTask(taskId) ?? null;
        },
        assignTask: async (taskId, agentId) => {
          return ts.assignTask(taskId, agentId);
        },
        addTaskNote: async (taskId, note) => {
          ts.addTaskNote(taskId, note);
        },
      };
      for (const tool of createAgentTaskTools(taskCtx)) {
        agent.registerTool(tool);
      }

      // Wire tasks fetcher so system prompt shows this agent's assigned tasks
      agent.setTasksFetcher(() => {
        try {
          return ts.listTasks({ orgId, assignedAgentId: id }).map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
          }));
        } catch {
          return [];
        }
      });

      log.info(`Task tools injected for agent ${id}`);
    }

    // If this is a manager agent, inject manager-specific tools
    if (request.agentRole === 'manager') {
      const managerTools = createManagerTools({
        listAgents: () => this.listAgents().map(a => {
          try {
            const ag = this.getAgent(a.id);
            return { ...a, skills: ag.config.skills };
          } catch { return { ...a, skills: [] }; }
        }),
        delegateMessage: async (targetId, message, _from) => {
          const target = this.getAgent(targetId);
          return target.handleMessage(message, id, { name: config.name, role: 'manager' });
        },
        createTask: (title, description, assignedAgentId, priority) => {
          // Use real TaskService if available, otherwise fall back to temp ID
          if (this.taskService) {
            const task = this.taskService.createTask({
              orgId: config.orgId,
              title,
              description,
              priority: priority ?? 'medium',
              assignedAgentId,
            });
            return task.id;
          }
          return `task_${Date.now()}`;
        },
        getTeamStatus: () => this.listAgents().map(a => {
          try {
            const ag = this.getAgent(a.id);
            const state = ag.getState();
            return { ...a, currentTask: state.currentTaskId, tokensUsedToday: state.tokensUsedToday };
          } catch { return { ...a, tokensUsedToday: 0 }; }
        }),
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
          log.info(`MCP server ${serverName} tools registered for agent ${id}`, { toolCount: mcpTools.length });
        } catch (error) {
          log.warn(`Failed to connect MCP server ${serverName} for agent ${id}`, { error: String(error) });
        }
      }
    }

    if (this.agentAuditCallback) {
      const cb = this.agentAuditCallback;
      agent.setAuditCallback((event) => cb(id, event));
    }
    if (this.escalationHandler) {
      agent.setEscalationCallback(this.escalationHandler);
    }

    this.agents.set(id, agent);
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
  }): Promise<Agent> {
    const id = row.id;
    // Try loading role by: 1) roleId (template folder name for new agents),
    // 2) roleName (display name stored by older agents), 3) display-name→folder lookup
    const role = (() => {
      // Try roleId first (it stores the folder name for agents hired after this fix)
      try { return this.roleLoader.loadRole(row.roleId); } catch { /* try next */ }
      // Try roleName directly (might be a folder name for some agents)
      try { return this.roleLoader.loadRole(row.roleName); } catch { /* try next */ }
      // Last resort: find by matching display name across available roles
      const available = this.roleLoader.listAvailableRoles();
      for (const templateName of available) {
        try {
          const candidate = this.roleLoader.loadRole(templateName);
          if (candidate.name.toLowerCase() === row.roleName.toLowerCase()) return candidate;
        } catch { /* skip */ }
      }
      throw new Error(`Role not found: ${row.roleName} (roleId: ${row.roleId})`);
    })();
    const agentDataDir = join(this.dataDir, id);
    mkdirSync(agentDataDir, { recursive: true });

    const config: AgentConfig = {
      id,
      name: row.name,
      roleId: row.roleId,
      orgId: row.orgId,
      teamId: row.teamId ?? undefined,
      agentRole: (row.agentRole as 'manager' | 'worker') ?? 'worker',
      skills: Array.isArray(row.skills) ? (row.skills as string[]) : role.defaultSkills,
      llmConfig: (row.llmConfig as AgentConfig['llmConfig']) ?? { primary: 'anthropic' },
      computeConfig: { type: 'docker' },
      channels: [],
      heartbeatIntervalMs: row.heartbeatIntervalMs ?? 30 * 60 * 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const security = new SecurityGuard(this.globalSecurityPolicy);
    const tools = createBuiltinTools({ agentId: id, security });

    const agent = new Agent({ config, role, llmRouter: this.llmRouter, dataDir: agentDataDir, tools });

    if (this.skillRegistry && config.skills.length > 0) {
      for (const tool of this.skillRegistry.getToolsForSkills(config.skills)) {
        agent.registerTool(tool);
      }
    }

    const a2aCtx = {
      selfId: id,
      selfName: config.name,
      listColleagues: () => this.listAgents().map(a => {
        try {
          const ag = this.getAgent(a.id);
          return { ...a, skills: ag.config.skills };
        } catch { return { ...a, skills: [] }; }
      }),
      sendMessage: async (targetId: string, message: string, fromId: string, fromName: string) => {
        const target = this.getAgent(targetId);
        return target.handleMessage(message, fromId, { name: fromName, role: config.agentRole ?? 'worker' }, {
          ephemeral: true,
          maxHistory: 15,
        });
      },
    };
    for (const tool of createA2ATools(a2aCtx)) agent.registerTool(tool);
    for (const tool of createStructuredA2ATools(a2aCtx)) agent.registerTool(tool);

    for (const tool of createMemoryTools({ agentId: id, agentName: config.name, memory: agent.getMemory() })) {
      agent.registerTool(tool);
    }

    this.a2aBus.registerAgent(id, async (envelope) => {
      const summary = `[A2A:${envelope.type}] from=${envelope.from}: ${JSON.stringify(envelope.payload).slice(0, 200)}`;
      await agent.handleMessage(summary, envelope.from, { name: envelope.from, role: 'worker' }, {
        ephemeral: true,
        maxHistory: 10,
      });
    });

    if (this.taskService) {
      const ts = this.taskService;
      const orgId = config.orgId;
      const taskCtx: AgentTaskContext = {
        agentId: id,
        agentName: config.name,
        createTask: async (params) => ts.createTask({ orgId, ...params }),
        listTasks: async (filter) => ts.listTasks({ orgId, status: filter?.status, assignedAgentId: filter?.assignedToMe ? id : undefined }),
        updateTaskStatus: async (taskId, status) => ts.updateTaskStatus(taskId, status),
        getTask: async (taskId) => ts.getTask(taskId) ?? null,
        assignTask: async (taskId, agentId) => ts.assignTask(taskId, agentId),
        addTaskNote: async (taskId, note) => { ts.addTaskNote(taskId, note); },
      };
      for (const tool of createAgentTaskTools(taskCtx)) agent.registerTool(tool);
      agent.setTasksFetcher(() => {
        try {
          return ts.listTasks({ orgId, assignedAgentId: id }).map(t => ({
            id: t.id, title: t.title, description: t.description, status: t.status, priority: t.priority,
          }));
        } catch { return []; }
      });
    }

    if (config.agentRole === 'manager') {
      const managerTools = createManagerTools({
        listAgents: () => this.listAgents().map(a => {
          try { const ag = this.getAgent(a.id); return { ...a, skills: ag.config.skills }; }
          catch { return { ...a, skills: [] }; }
        }),
        delegateMessage: async (targetId, message) => {
          const target = this.getAgent(targetId);
          return target.handleMessage(message, id, { name: config.name, role: 'manager' });
        },
        createTask: (title, description, assignedAgentId, priority) => {
          if (this.taskService) {
            return this.taskService.createTask({ orgId: config.orgId, title, description, priority: priority ?? 'medium', assignedAgentId }).id;
          }
          return `task_${Date.now()}`;
        },
        getTeamStatus: () => this.listAgents().map(a => {
          try {
            const ag = this.getAgent(a.id);
            const state = ag.getState();
            return { ...a, currentTask: state.currentTaskId, tokensUsedToday: state.tokensUsedToday };
          } catch { return { ...a, tokensUsedToday: 0 }; }
        }),
      });
      for (const tool of managerTools) agent.registerTool(tool);
    }

    if (this.agentAuditCallback) {
      const cb = this.agentAuditCallback;
      agent.setAuditCallback((event) => cb(id, event));
    }
    if (this.escalationHandler) {
      agent.setEscalationCallback(this.escalationHandler);
    }

    this.agents.set(id, agent);
    this.eventBus.emit('agent:created', { agentId: id, name: row.name });
    log.info(`Agent restored: ${row.name} (${id})`);
    return agent;
  }

  async startAgent(agentId: string): Promise<void> {
    const agent = this.getAgent(agentId);

    // Auto-create sandbox if factory is available
    if (this.sandboxFactory && !agent.getState().containerId) {
      try {
        const sandbox = await this.sandboxFactory.create(agentId);
        agent.setSandbox(sandbox);
        log.info(`Sandbox created for agent ${agentId}`);
      } catch (error) {
        log.warn(`Failed to create sandbox for agent ${agentId}, running without isolation`, {
          error: String(error),
        });
      }
    }

    await agent.start();
  }

  async stopAgent(agentId: string): Promise<void> {
    const agent = this.getAgent(agentId);
    await agent.stop();

    if (this.sandboxFactory) {
      try {
        await this.sandboxFactory.destroy(agentId);
      } catch {
        // sandbox may already be gone
      }
    }
  }

  async removeAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      await agent.stop();
      this.a2aBus.unregisterAgent(agentId);
      if (this.sandboxFactory) {
        try { await this.sandboxFactory.destroy(agentId); } catch { /* ignore */ }
      }
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

  setAuditCallback(cb: (agentId: string, event: { type: string; action: string; tokensUsed?: number; durationMs?: number; success: boolean; detail?: string }) => void): void {
    this.agentAuditCallback = cb;
    for (const [id, agent] of this.agents) {
      agent.setAuditCallback((event) => cb(id, event));
    }
  }

  setEscalationHandler(handler: (agentId: string, reason: string) => void): void {
    this.escalationHandler = handler;
    for (const [, agent] of this.agents) {
      agent.setEscalationCallback(handler);
    }
  }

  listAgents(): Array<{ id: string; name: string; role: string; status: string; agentRole: string; skills: string[]; activeTaskCount: number; teamId?: string }> {
    return [...this.agents.values()].map((a) => {
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
      };
    });
  }

  listAvailableRoles(): string[] {
    return this.roleLoader.listAvailableRoles();
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  setSandboxFactory(factory: SandboxFactory): void {
    this.sandboxFactory = factory;
  }

  getA2ABus(): A2ABus {
    return this.a2aBus;
  }

  setTemplateRegistry(registry: TemplateRegistry): void {
    this.templateRegistry = registry;
  }

  getTemplateRegistry(): TemplateRegistry | undefined {
    return this.templateRegistry;
  }

  setGroupChatHandlers(handlers: {
    sendGroupMessage: (channelKey: string, message: string, senderId: string, senderName: string) => Promise<string>;
    createGroupChat: (name: string, creatorId: string, creatorName: string, memberIds: string[]) => Promise<{ id: string; name: string }>;
    listGroupChats: () => Promise<Array<{ id: string; name: string; type: string; channelKey: string }>>;
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

    return this.createAgent({
      name: request.name,
      roleName: template.roleId,
      orgId: request.orgId,
      teamId: request.teamId,
      agentRole: template.agentRole,
      skills: request.overrides?.skills ?? template.skills,
      heartbeatIntervalMs: request.overrides?.heartbeatIntervalMs ?? template.heartbeatIntervalMs,
    });
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
        manager: managerAgent && managerAgent.id !== agent.id
          ? { id: managerAgent.id, name: managerAgent.config.name }
          : undefined,
      };

      agent.setIdentityContext(identity);
    }

    log.info(`Refreshed identity contexts for ${orgAgents.length} agents in org ${orgId}`);
  }
}
