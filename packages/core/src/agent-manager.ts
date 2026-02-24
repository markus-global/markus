import type { AgentConfig, IdentityContext, HumanUser } from '@markus/shared';
import { createLogger, agentId as genAgentId } from '@markus/shared';
import { Agent, type AgentToolHandler, type SandboxHandle, type AgentOptions } from './agent.js';
import type { OrgContext } from './context-engine.js';
import { LLMRouter } from './llm/router.js';
import { RoleLoader } from './role-loader.js';
import { EventBus } from './events.js';
import { createBuiltinTools } from './tools/builtin.js';
import { MCPClientManager } from './tools/mcp-client.js';
import { createManagerTools } from './tools/manager.js';
import type { SkillRegistry } from './skills/types.js';
import { SecurityGuard, type SecurityPolicy } from './security.js';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const log = createLogger('agent-manager');

export interface SandboxFactory {
  create(agentId: string, image?: string): Promise<SandboxHandle>;
  destroy(agentId: string): Promise<void>;
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

  constructor(options: {
    llmRouter: LLMRouter;
    roleLoader?: RoleLoader;
    dataDir?: string;
    eventBus?: EventBus;
    sandboxFactory?: SandboxFactory;
    securityPolicy?: SecurityPolicy;
    mcpServers?: Record<string, MCPServerConfig>;
    skillRegistry?: SkillRegistry;
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
    mkdirSync(this.dataDir, { recursive: true });
  }

  async createAgent(request: CreateAgentRequest): Promise<Agent> {
    const id = genAgentId();
    const role = this.roleLoader.loadRole(request.roleName);
    const agentDataDir = join(this.dataDir, id);
    mkdirSync(agentDataDir, { recursive: true });

    const config: AgentConfig = {
      id,
      name: request.name,
      roleId: role.id,
      orgId: request.orgId ?? 'default',
      teamId: request.teamId,
      agentRole: request.agentRole ?? 'worker',
      skills: request.skills ?? role.defaultSkills,
      llmConfig: { primary: 'anthropic' },
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

    // If this is a manager agent, inject manager-specific tools
    if (request.agentRole === 'manager') {
      const managerTools = createManagerTools({
        listAgents: () => this.listAgents().map(a => {
          try {
            const ag = this.getAgent(a.id);
            return { ...a, skills: ag.config.skills };
          } catch { return { ...a, skills: [] }; }
        }),
        delegateMessage: async (targetId, message, from) => {
          const target = this.getAgent(targetId);
          return target.handleMessage(message, id, { name: config.name, role: 'manager' });
        },
        createTask: (title, description, assignedAgentId, priority) => {
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

    this.agents.set(id, agent);
    this.eventBus.emit('agent:created', { agentId: id, name: request.name });
    log.info(`Agent created: ${request.name} (${id})`);

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

  listAgents(): Array<{ id: string; name: string; role: string; status: string; agentRole: string; skills: string[] }> {
    return [...this.agents.values()].map((a) => ({
      id: a.id,
      name: a.config.name,
      role: a.role.name,
      status: a.getState().status,
      agentRole: a.config.agentRole,
      skills: a.config.skills,
    }));
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
