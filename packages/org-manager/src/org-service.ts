import type { Organization, Team, RoleTemplate } from '@markus/shared';
import { createLogger, orgId, generateId } from '@markus/shared';
import { AgentManager, RoleLoader, type CreateAgentRequest } from '@markus/core';
import type { StorageBridge } from './storage-bridge.js';

const log = createLogger('org-service');

export class OrganizationService {
  private orgs = new Map<string, Organization>();
  private teams = new Map<string, Team>();
  private agentManager: AgentManager;
  private roleLoader: RoleLoader;
  private storage?: StorageBridge;

  constructor(agentManager: AgentManager, roleLoader?: RoleLoader, storage?: StorageBridge) {
    this.agentManager = agentManager;
    this.roleLoader = roleLoader ?? new RoleLoader();
    this.storage = storage;
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

    log.info(`Agent hired: ${request.name}`, { orgId: request.orgId, agentId: agent.id });
    return agent;
  }

  async fireAgent(agentId: string): Promise<void> {
    await this.agentManager.removeAgent(agentId);

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

    log.info(`Agent fired: ${agentId}`);
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
