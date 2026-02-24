import type { Organization, Team, RoleTemplate } from '@markus/shared';
import { createLogger, orgId, generateId } from '@markus/shared';
import { AgentManager, RoleLoader, type CreateAgentRequest } from '@markus/core';

const log = createLogger('org-service');

export class OrganizationService {
  private orgs = new Map<string, Organization>();
  private teams = new Map<string, Team>();
  private agentManager: AgentManager;
  private roleLoader: RoleLoader;

  constructor(agentManager: AgentManager, roleLoader?: RoleLoader) {
    this.agentManager = agentManager;
    this.roleLoader = roleLoader ?? new RoleLoader();
  }

  createOrganization(name: string, ownerId: string): Organization {
    const org: Organization = {
      id: orgId(),
      name,
      ownerId,
      plan: 'free',
      maxAgents: 5,
      createdAt: new Date().toISOString(),
    };
    this.orgs.set(org.id, org);
    log.info(`Organization created: ${name}`, { id: org.id });
    return org;
  }

  getOrganization(id: string): Organization | undefined {
    return this.orgs.get(id);
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
    const org = this.orgs.get(request.orgId);
    if (!org) throw new Error(`Organization not found: ${request.orgId}`);

    const currentAgents = this.agentManager.listAgents().filter(
      (a) => true, // in a full impl, filter by orgId
    );
    if (currentAgents.length >= org.maxAgents) {
      throw new Error(`Agent limit reached (${org.maxAgents}) for organization ${org.name}`);
    }

    const agent = await this.agentManager.createAgent(request);

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
}
