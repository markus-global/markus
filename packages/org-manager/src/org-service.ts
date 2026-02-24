import type { Organization, Team, RoleTemplate, HumanUser, HumanRole } from '@markus/shared';
import { createLogger, orgId, generateId } from '@markus/shared';
import { AgentManager, RoleLoader, type CreateAgentRequest } from '@markus/core';
import type { StorageBridge } from './storage-bridge.js';

const log = createLogger('org-service');

export class OrganizationService {
  private orgs = new Map<string, Organization>();
  private teams = new Map<string, Team>();
  private humans = new Map<string, HumanUser>();
  private agentManager: AgentManager;
  private roleLoader: RoleLoader;
  private storage?: StorageBridge;

  constructor(agentManager: AgentManager, roleLoader?: RoleLoader, storage?: StorageBridge) {
    this.agentManager = agentManager;
    this.roleLoader = roleLoader ?? new RoleLoader();
    this.storage = storage;
  }

  // ─── Human User Management ───

  addHumanUser(orgId: string, name: string, role: HumanRole, opts?: { id?: string; email?: string }): HumanUser {
    const org = this.orgs.get(orgId);
    if (!org) throw new Error(`Organization not found: ${orgId}`);

    const user: HumanUser = {
      id: opts?.id ?? generateId('user'),
      name,
      email: opts?.email,
      role,
      orgId,
      createdAt: new Date().toISOString(),
    };
    this.humans.set(user.id, user);
    this.refreshIdentityContextsForOrg(orgId);
    log.info(`Human user added: ${name} (${role})`, { orgId, userId: user.id });
    return user;
  }

  getHumanUser(userId: string): HumanUser | undefined {
    return this.humans.get(userId);
  }

  listHumanUsers(orgId: string): HumanUser[] {
    return [...this.humans.values()].filter(h => h.orgId === orgId);
  }

  removeHumanUser(userId: string): void {
    const user = this.humans.get(userId);
    if (user) {
      this.humans.delete(userId);
      this.refreshIdentityContextsForOrg(user.orgId);
      log.info(`Human user removed: ${user.name}`);
    }
  }

  resolveHumanIdentity(senderId?: string): { id: string; name: string; role: string } | undefined {
    if (!senderId) return undefined;
    const user = this.humans.get(senderId);
    if (user) return { id: user.id, name: user.name, role: user.role };
    return undefined;
  }

  // ─── Message Routing ───

  /**
   * Given a message, determine which agent should handle it.
   * Priority: explicit @mention > channel binding > manager fallback
   */
  routeMessage(orgId: string, opts: { targetAgentId?: string; channelId?: string; text?: string }): string | undefined {
    if (opts.targetAgentId) return opts.targetAgentId;

    const org = this.orgs.get(orgId);
    if (!org) return undefined;

    if (org.managerAgentId) return org.managerAgentId;

    const agents = this.agentManager.listAgents().filter(a => {
      try {
        const agent = this.agentManager.getAgent(a.id);
        return agent.config.orgId === orgId;
      } catch { return false; }
    });
    return agents[0]?.id;
  }

  async createOrganization(name: string, ownerId: string, explicitId?: string): Promise<Organization> {
    const id = explicitId ?? orgId();
    const org: Organization = {
      id,
      name,
      ownerId,
      plan: 'free',
      maxAgents: 5,
      createdAt: new Date().toISOString(),
    };

    this.orgs.set(org.id, org);

    if (this.storage) {
      try {
        await this.storage.orgRepo.createOrg({ id, name, ownerId });
      } catch (error) {
        log.warn('Failed to persist org to DB (may already exist)', { error: String(error) });
      }
    }

    log.info(`Organization created: ${name}`, { id: org.id });
    return org;
  }

  getOrganization(id: string): Organization | undefined {
    return this.orgs.get(id);
  }

  getDefaultOrganization(): Organization | undefined {
    return this.orgs.get('default') ?? [...this.orgs.values()][0];
  }

  listOrganizations(): Organization[] {
    return [...this.orgs.values()];
  }

  createTeam(orgId: string, name: string, description?: string): Team {
    const org = this.orgs.get(orgId);
    if (!org) throw new Error(`Organization not found: ${orgId}`);

    const team: Team = {
      id: generateId('team'),
      orgId,
      name,
      description,
      memberAgentIds: [],
    };
    this.teams.set(team.id, team);
    log.info(`Team created: ${name}`, { orgId, teamId: team.id });
    return team;
  }

  getTeam(teamId: string): Team | undefined {
    return this.teams.get(teamId);
  }

  listTeams(orgId: string): Team[] {
    return [...this.teams.values()].filter((t) => t.orgId === orgId);
  }

  async hireAgent(request: CreateAgentRequest & { orgId: string }) {
    let org = this.orgs.get(request.orgId);
    if (!org && request.orgId === 'default') {
      org = this.getDefaultOrganization();
    }
    if (!org) throw new Error(`Organization not found: ${request.orgId}`);

    const currentAgents = this.agentManager.listAgents();
    if (currentAgents.length >= org.maxAgents) {
      throw new Error(`Agent limit reached (${org.maxAgents}) for organization ${org.name}`);
    }

    const agent = await this.agentManager.createAgent(request);

    // Persist agent to DB
    if (this.storage) {
      try {
        await this.storage.agentRepo.create({
          id: agent.id,
          name: agent.config.name,
          orgId: org.id,
          teamId: request.teamId,
          roleId: agent.config.roleId,
          roleName: agent.role.name,
          skills: agent.config.skills,
          llmConfig: agent.config.llmConfig,
          computeConfig: agent.config.computeConfig,
          heartbeatIntervalMs: agent.config.heartbeatIntervalMs,
        });
      } catch (error) {
        log.warn('Failed to persist agent to DB', { error: String(error) });
      }
    }

    if (request.teamId) {
      const team = this.teams.get(request.teamId);
      if (team) {
        team.memberAgentIds.push(agent.id);
      }
    }

    if (request.agentRole === 'manager' && org) {
      org.managerAgentId = agent.id;
    }

    this.refreshIdentityContextsForOrg(request.orgId);
    log.info(`Agent hired: ${request.name}`, { orgId: request.orgId, agentId: agent.id, agentRole: request.agentRole ?? 'worker' });
    return agent;
  }

  async fireAgent(agentId: string): Promise<void> {
    const agentInfo = this.agentManager.listAgents().find(a => a.id === agentId);
    await this.agentManager.removeAgent(agentId);

    for (const org of this.orgs.values()) {
      if (org.managerAgentId === agentId) {
        org.managerAgentId = undefined;
      }
    }

    if (this.storage) {
      try {
        await this.storage.agentRepo.delete(agentId);
      } catch (error) {
        log.warn('Failed to remove agent from DB', { error: String(error) });
      }
    }

    for (const team of this.teams.values()) {
      team.memberAgentIds = team.memberAgentIds.filter((id) => id !== agentId);
    }

    const orgIdToRefresh = agentInfo ? this.findAgentOrgId(agentId) : undefined;
    if (orgIdToRefresh) this.refreshIdentityContextsForOrg(orgIdToRefresh);
    log.info(`Agent fired: ${agentId}`);
  }

  getManagerAgent(orgId: string): string | undefined {
    return this.orgs.get(orgId)?.managerAgentId;
  }

  private findAgentOrgId(agentId: string): string | undefined {
    try {
      const agent = this.agentManager.getAgent(agentId);
      return agent.config.orgId;
    } catch {
      return undefined;
    }
  }

  private refreshIdentityContextsForOrg(targetOrgId: string): void {
    const org = this.orgs.get(targetOrgId);
    if (!org) return;
    const humans = this.listHumanUsers(targetOrgId);
    this.agentManager.refreshIdentityContexts(targetOrgId, org.name, humans);
  }

  listAvailableRoles(): string[] {
    return this.roleLoader.listAvailableRoles();
  }

  getRoleDetails(roleName: string): RoleTemplate {
    return this.roleLoader.loadRole(roleName);
  }

  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  getStorage(): StorageBridge | undefined {
    return this.storage;
  }
}
