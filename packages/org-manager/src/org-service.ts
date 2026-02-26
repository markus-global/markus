import type { Organization, Team, TeamInfo, TeamMemberInfo, RoleTemplate, HumanUser, HumanRole } from '@markus/shared';
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

    // Only persist users with an email address to DB — emailless users are synthetic
    // in-memory sentinels (e.g. the default 'Owner') and must not pollute auth user count.
    if (this.storage && opts?.email) {
      this.storage.userRepo.upsert({ id: user.id, orgId, name, email: opts.email, role }).catch((error) => {
        log.warn('Failed to persist user to DB', { error: String(error) });
      });
    }

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

      if (this.storage) {
        this.storage.userRepo.delete(userId).catch((error) => {
          log.warn('Failed to delete user from DB', { error: String(error) });
        });
      }

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

  async createTeam(orgId: string, name: string, description?: string): Promise<Team> {
    const org = this.orgs.get(orgId);
    if (!org) throw new Error(`Organization not found: ${orgId}`);

    const team: Team = {
      id: generateId('team'),
      orgId,
      name,
      description,
      memberAgentIds: [],
      humanMemberIds: [],
    };
    this.teams.set(team.id, team);

    if (this.storage) {
      try {
        await this.storage.teamRepo.create({ id: team.id, orgId, name, description });
      } catch (error) {
        log.warn('Failed to persist team to DB', { error: String(error) });
      }
    }

    log.info(`Team created: ${name}`, { orgId, teamId: team.id });
    return team;
  }

  async updateTeam(teamId: string, data: { name?: string; description?: string; managerId?: string | null; managerType?: 'human' | 'agent' | null }): Promise<Team> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    if (data.name !== undefined) team.name = data.name;
    if (data.description !== undefined) team.description = data.description;
    if ('managerId' in data) team.managerId = data.managerId ?? undefined;
    if ('managerType' in data) team.managerType = (data.managerType as 'human' | 'agent' | undefined) ?? undefined;

    if (this.storage) {
      try {
        await this.storage.teamRepo.update(teamId, {
          name: data.name,
          description: data.description,
          managerId: 'managerId' in data ? (data.managerId ?? null) : undefined,
          managerType: 'managerType' in data ? (data.managerType ?? null) : undefined,
        });
      } catch (error) {
        log.warn('Failed to update team in DB', { error: String(error) });
      }
    }

    return team;
  }

  async deleteTeam(teamId: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) return;
    // Unassign all agents from this team
    for (const agentId of team.memberAgentIds) {
      try {
        const agent = this.agentManager.getAgent(agentId);
        if (agent.config.teamId === teamId) agent.config.teamId = undefined;
      } catch { /* agent may not exist */ }
    }
    // Unassign all humans
    for (const userId of (team.humanMemberIds ?? [])) {
      const user = this.humans.get(userId);
      if (user && user.teamId === teamId) user.teamId = undefined;
    }
    this.teams.delete(teamId);

    if (this.storage) {
      try {
        await this.storage.teamRepo.delete(teamId);
      } catch (error) {
        log.warn('Failed to delete team from DB', { error: String(error) });
      }
    }

    log.info(`Team deleted: ${teamId}`);
  }

  addMemberToTeam(teamId: string, memberId: string, memberType: 'human' | 'agent'): void {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    if (memberType === 'agent') {
      if (!team.memberAgentIds.includes(memberId)) team.memberAgentIds.push(memberId);
      try {
        const agent = this.agentManager.getAgent(memberId);
        agent.config.teamId = teamId;
      } catch { /* agent may not exist */ }
    } else {
      if (!team.humanMemberIds) team.humanMemberIds = [];
      if (!team.humanMemberIds.includes(memberId)) team.humanMemberIds.push(memberId);
      const user = this.humans.get(memberId);
      if (user) {
        user.teamId = teamId;
        if (this.storage) {
          this.storage.userRepo.updateTeamId(memberId, teamId).catch((error) => {
            log.warn('Failed to update user teamId in DB', { error: String(error) });
          });
        }
      }
    }
  }

  removeMemberFromTeam(teamId: string, memberId: string): void {
    const team = this.teams.get(teamId);
    if (!team) return;
    team.memberAgentIds = team.memberAgentIds.filter(id => id !== memberId);
    team.humanMemberIds = (team.humanMemberIds ?? []).filter(id => id !== memberId);
    // If this member was the manager, clear it
    if (team.managerId === memberId) {
      team.managerId = undefined;
      team.managerType = undefined;
    }
    try {
      const agent = this.agentManager.getAgent(memberId);
      if (agent.config.teamId === teamId) agent.config.teamId = undefined;
    } catch { /* ok */ }
    const user = this.humans.get(memberId);
    if (user && user.teamId === teamId) {
      user.teamId = undefined;
      if (this.storage) {
        this.storage.userRepo.updateTeamId(memberId, null).catch((error) => {
          log.warn('Failed to clear user teamId in DB', { error: String(error) });
        });
      }
    }
  }

  listTeamsWithMembers(orgId: string): TeamInfo[] {
    const teamsForOrg = [...this.teams.values()].filter(t => t.orgId === orgId);
    return teamsForOrg.map(team => {
      const members: TeamMemberInfo[] = [];

      for (const agentId of team.memberAgentIds) {
        try {
          const agent = this.agentManager.getAgent(agentId);
          const state = agent.getState();
          members.push({
            id: agentId,
            name: agent.config.name,
            type: 'agent',
            role: agent.role.name,
            agentRole: agent.config.agentRole ?? 'worker',
            status: state.status,
            teamId: team.id,
          });
        } catch { /* skip removed agents */ }
      }

      for (const userId of (team.humanMemberIds ?? [])) {
        const user = this.humans.get(userId);
        if (user) {
          members.push({
            id: userId,
            name: user.name,
            type: 'human',
            role: user.role,
            teamId: team.id,
          });
        }
      }

      let managerName: string | undefined;
      if (team.managerId) {
        if (team.managerType === 'agent') {
          try { managerName = this.agentManager.getAgent(team.managerId).config.name; } catch { /* ok */ }
        } else {
          managerName = this.humans.get(team.managerId)?.name;
        }
      }

      return {
        id: team.id,
        orgId: team.orgId,
        name: team.name,
        description: team.description,
        managerId: team.managerId,
        managerType: team.managerType,
        managerName,
        members,
      };
    });
  }

  /** Returns ungrouped agents and humans (not in any team) */
  listUngroupedMembers(orgId: string): TeamMemberInfo[] {
    const allTeams = [...this.teams.values()].filter(t => t.orgId === orgId);
    const agentIdsInTeams = new Set(allTeams.flatMap(t => t.memberAgentIds));
    const humanIdsInTeams = new Set(allTeams.flatMap(t => t.humanMemberIds ?? []));

    const ungrouped: TeamMemberInfo[] = [];

    for (const a of this.agentManager.listAgents()) {
      try {
        const agent = this.agentManager.getAgent(a.id);
        if (agent.config.orgId !== orgId && orgId !== 'default') continue;
        if (!agentIdsInTeams.has(a.id)) {
          const state = agent.getState();
          ungrouped.push({
            id: a.id, name: a.name, type: 'agent',
            role: agent.role.name, agentRole: agent.config.agentRole ?? 'worker',
            status: state.status,
          });
        }
      } catch { /* ok */ }
    }

    for (const user of this.humans.values()) {
      if (user.orgId !== orgId) continue;
      if (!humanIdsInTeams.has(user.id)) {
        ungrouped.push({
          id: user.id, name: user.name, type: 'human', role: user.role,
        });
      }
    }

    return ungrouped;
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
          roleId: agent.config.roleId,  // template folder name (e.g. 'developer')
          roleName: agent.role.name,    // display name (e.g. 'Software Developer')
          agentRole: agent.config.agentRole ?? 'worker',
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
      if (team && !team.memberAgentIds.includes(agent.id)) {
        team.memberAgentIds.push(agent.id);
      }
    }

    if (request.agentRole === 'manager' && org) {
      org.managerAgentId = agent.id;
    }

    this.refreshIdentityContextsForOrg(request.orgId);

    // Onboard = always online. Auto-start the agent immediately.
    try {
      await this.agentManager.startAgent(agent.id);
      log.info(`Agent onboarded: ${request.name} (auto-started)`, { orgId: request.orgId, agentId: agent.id, agentRole: request.agentRole ?? 'worker' });
    } catch (error) {
      log.warn(`Agent created but auto-start failed: ${request.name}`, { error: String(error) });
    }

    return agent;
  }

  /** Alias for hireAgent — onboard semantics */
  async onboardAgent(request: CreateAgentRequest & { orgId: string }) {
    return this.hireAgent(request);
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
    log.info(`Agent offboarded: ${agentId}`);
  }

  /** Alias for fireAgent — offboard semantics */
  async offboardAgent(agentId: string): Promise<void> {
    return this.fireAgent(agentId);
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

  /**
   * Restore all persisted data (teams, agents, users) from the database.
   * Should be called once during server startup after the org is created.
   */
  async loadFromDB(orgId: string): Promise<void> {
    if (!this.storage) return;

    log.info('Loading data from DB...', { orgId });

    // 1. Restore teams
    try {
      const teamRows = await this.storage.teamRepo.findByOrgId(orgId);
      for (const row of teamRows) {
        if (this.teams.has(row.id)) continue; // already loaded
        const team: Team = {
          id: row.id,
          orgId: row.orgId,
          name: row.name,
          description: row.description ?? undefined,
          memberAgentIds: [],
          humanMemberIds: [],
          managerId: row.managerId ?? undefined,
          managerType: (row.managerType as 'human' | 'agent' | undefined) ?? undefined,
        };
        this.teams.set(team.id, team);
      }
      log.info(`Restored ${teamRows.length} teams from DB`);
    } catch (error) {
      log.warn('Failed to restore teams from DB', { error: String(error) });
    }

    // 2. Restore agents
    try {
      const agentRows = await this.storage.agentRepo.findByOrgId(orgId);
      let restoredCount = 0;
      for (const row of agentRows) {
        if (this.agentManager.hasAgent(row.id)) continue; // already loaded
        try {
          await this.agentManager.restoreAgent(row);
          restoredCount++;

          // Re-add to team membership
          if (row.teamId) {
            const team = this.teams.get(row.teamId);
            if (team && !team.memberAgentIds.includes(row.id)) {
              team.memberAgentIds.push(row.id);
            }
          }

          // Auto-start restored agents
          try {
            await this.agentManager.startAgent(row.id);
          } catch (startErr) {
            log.warn(`Failed to auto-start restored agent ${row.id}`, { error: String(startErr) });
          }
        } catch (agentErr) {
          log.warn(`Failed to restore agent ${row.id}`, { error: String(agentErr) });
        }
      }
      log.info(`Restored ${restoredCount} agents from DB`);
    } catch (error) {
      log.warn('Failed to restore agents from DB', { error: String(error) });
    }

    // 3. Restore human users (skip default owner which is already seeded)
    try {
      const userRows = await this.storage.userRepo.listByOrg(orgId);
      let restoredCount = 0;
      for (const row of userRows) {
        if (this.humans.has(row.id)) continue; // already loaded (e.g. default owner)
        const user: HumanUser = {
          id: row.id,
          name: row.name,
          email: row.email ?? undefined,
          role: row.role as HumanRole,
          orgId: row.orgId,
          teamId: row.teamId ?? undefined,
          createdAt: row.createdAt.toISOString(),
        };
        this.humans.set(user.id, user);

        // Re-add to team membership
        if (row.teamId) {
          const team = this.teams.get(row.teamId);
          if (team && !team.humanMemberIds?.includes(row.id)) {
            if (!team.humanMemberIds) team.humanMemberIds = [];
            team.humanMemberIds.push(row.id);
          }
        }
        restoredCount++;
      }
      log.info(`Restored ${restoredCount} users from DB`);
    } catch (error) {
      log.warn('Failed to restore users from DB', { error: String(error) });
    }

    this.refreshIdentityContextsForOrg(orgId);
    log.info('Data restored from DB successfully', { orgId });
  }

  /**
   * Seed a default team ("My Team") for a fresh organization.
   * Creates the team, adds the owner as a human member, and hires a Secretary agent
   * as the team manager. Skips if any teams already exist for the org.
   */
  async seedDefaultTeam(orgId: string, ownerUserId: string): Promise<void> {
    const existing = this.listTeams(orgId);
    if (existing.length > 0) return; // Already has teams — nothing to seed

    log.info('Seeding default team for org', { orgId });

    try {
      // Create the default team
      const team = await this.createTeam(orgId, 'My Team', 'Your primary team — you and your personal AI Secretary.');

      // Add the owner as a human member
      const owner = this.humans.get(ownerUserId);
      if (owner) {
        this.addMemberToTeam(team.id, ownerUserId, 'human');
      }

      // Hire a Secretary agent as manager of this team
      const secretary = await this.hireAgent({
        name: 'Secretary',
        roleName: 'secretary',
        orgId,
        teamId: team.id,
        agentRole: 'manager',
      });

      // Set the secretary as the team manager
      await this.updateTeam(team.id, {
        managerId: secretary.id,
        managerType: 'agent',
      });

      log.info('Default team seeded', {
        teamId: team.id,
        secretaryId: secretary.id,
      });
    } catch (error) {
      log.warn('Failed to seed default team', { error: String(error) });
    }
  }
}
