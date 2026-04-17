import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  createLogger,
  orgId,
  generateId,
  HEARTBEAT_STARTUP_JITTER_MS,
  type Organization,
  type Team,
  type TeamInfo,
  type TeamMemberInfo,
  type RoleTemplate,
  type HumanUser,
  type HumanRole,
} from '@markus/shared';
import { RoleLoader, type AgentManager, type CreateAgentRequest, type SkillRegistry, discoverSkillsInDir, WELL_KNOWN_SKILL_DIRS } from '@markus/core';
import type { StorageBridge } from './storage-bridge.js';

const log = createLogger('org-service');

export class OrganizationService {
  private orgs = new Map<string, Organization>();
  private teams = new Map<string, Team>();
  private humans = new Map<string, HumanUser>();
  private agentManager: AgentManager;
  private pendingAgentStartIds: string[] = [];
  private roleLoader: RoleLoader;
  private storage?: StorageBridge;

  constructor(agentManager: AgentManager, roleLoader?: RoleLoader, storage?: StorageBridge) {
    this.agentManager = agentManager;
    this.roleLoader = roleLoader ?? new RoleLoader();
    this.storage = storage;
  }

  // ─── Human User Management ───

  addHumanUser(
    orgId: string,
    name: string,
    role: HumanRole,
    opts?: { id?: string; email?: string }
  ): HumanUser {
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
      this.storage.userRepo
        .upsert({ id: user.id, orgId, name, email: opts.email, role })
        .catch((error: unknown) => {
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
        this.storage.userRepo.delete(userId).catch((error: unknown) => {
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
  routeMessage(
    orgId: string,
    opts: { targetAgentId?: string; channelId?: string; text?: string }
  ): string | undefined {
    if (opts.targetAgentId) return opts.targetAgentId;

    const org = this.orgs.get(orgId);
    if (!org) return undefined;

    if (org.managerAgentId) return org.managerAgentId;

    const agents = this.agentManager.listAgents().filter(a => {
      try {
        const agent = this.agentManager.getAgent(a.id);
        return agent.config.orgId === orgId;
      } catch {
        return false;
      }
    });
    return agents[0]?.id;
  }

  async createOrganization(
    name: string,
    ownerId: string,
    explicitId?: string
  ): Promise<Organization> {
    const id = explicitId ?? orgId();
    const org: Organization = {
      id,
      name,
      ownerId,
      plan: 'free',
      maxAgents: -1,
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

  getTeamDataDir(teamId: string): string {
    return join(homedir(), '.markus', 'teams', teamId);
  }

  ensureTeamDataDir(teamId: string, announcements?: string, norms?: string): void {
    const dir = this.getTeamDataDir(teamId);
    mkdirSync(dir, { recursive: true });
    const annPath = join(dir, 'ANNOUNCEMENT.md');
    if (announcements) {
      writeFileSync(annPath, announcements, 'utf-8');
    } else if (!existsSync(annPath)) {
      writeFileSync(annPath, '', 'utf-8');
    }
    const normsPath = join(dir, 'NORMS.md');
    if (norms) {
      writeFileSync(normsPath, norms, 'utf-8');
    } else if (!existsSync(normsPath)) {
      writeFileSync(normsPath, '', 'utf-8');
    }
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

    this.ensureTeamDataDir(team.id);

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

  async updateTeam(
    teamId: string,
    data: {
      name?: string;
      description?: string;
      managerId?: string | null;
      managerType?: 'human' | 'agent' | null;
    }
  ): Promise<Team> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    if (data.name !== undefined) team.name = data.name;
    if (data.description !== undefined) team.description = data.description;
    if ('managerId' in data) team.managerId = data.managerId ?? undefined;
    if ('managerType' in data)
      team.managerType = (data.managerType as 'human' | 'agent' | undefined) ?? undefined;

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

  async deleteTeam(teamId: string, deleteMembers = false, opts?: { purgeFiles?: boolean }): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) return;

    if (deleteMembers) {
      for (const agentId of [...team.memberAgentIds]) {
        try { await this.fireAgent(agentId, { purgeFiles: opts?.purgeFiles }); } catch { /* already gone */ }
      }
      for (const userId of [...(team.humanMemberIds ?? [])]) {
        if (userId === 'default') continue; // never delete the default owner
        this.removeHumanUser(userId);
      }
    } else {
      for (const agentId of team.memberAgentIds) {
        try {
          const agent = this.agentManager.getAgent(agentId);
          if (agent.config.teamId === teamId) agent.config.teamId = undefined;
        } catch { /* agent may not exist */ }
      }
      for (const userId of team.humanMemberIds ?? []) {
        const user = this.humans.get(userId);
        if (user && user.teamId === teamId) user.teamId = undefined;
      }
    }

    // Bulk-clear ALL DB references to this team before deleting (avoids FK constraint failures)
    if (this.storage) {
      try { await this.storage.agentRepo.clearTeamReferences(teamId); } catch { /* best effort */ }
      try { await this.storage.userRepo.clearTeamReferences(teamId); } catch { /* best effort */ }
      try {
        await this.storage.teamRepo.delete(teamId);
      } catch (error) {
        log.error('Failed to delete team from DB', { teamId, error: String(error) });
      }
    }

    this.teams.delete(teamId);

    if (opts?.purgeFiles) {
      const teamDir = join(homedir(), '.markus', 'teams', teamId);
      if (existsSync(teamDir)) {
        try {
          rmSync(teamDir, { recursive: true, force: true });
          log.info(`Team data directory purged: ${teamDir}`);
        } catch (err) {
          log.warn('Failed to purge team data directory', { teamId, error: String(err) });
        }
      }
    }

    log.info(`Team deleted: ${teamId}`, { deleteMembers, purgeFiles: !!opts?.purgeFiles });
  }

  addMemberToTeam(teamId: string, memberId: string, memberType: 'human' | 'agent'): void {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    if (memberType === 'agent') {
      if (!team.memberAgentIds.includes(memberId)) team.memberAgentIds.push(memberId);
      try {
        const agent = this.agentManager.getAgent(memberId);
        agent.config.teamId = teamId;
      } catch {
        /* agent may not exist */
      }
      if (this.storage) {
        this.storage.agentRepo.updateTeamId(memberId, teamId).catch((error: unknown) => {
          log.warn('Failed to update agent teamId in DB', { error: String(error) });
        });
      }
    } else {
      if (!team.humanMemberIds) team.humanMemberIds = [];
      if (!team.humanMemberIds.includes(memberId)) team.humanMemberIds.push(memberId);
      const user = this.humans.get(memberId);
      if (user) {
        user.teamId = teamId;
        if (this.storage) {
          this.storage.userRepo.updateTeamId(memberId, teamId).catch((error: unknown) => {
            log.warn('Failed to update user teamId in DB', { error: String(error) });
          });
        }
      }
    }
  }

  removeMemberFromTeam(teamId: string, memberId: string): void {
    const team = this.teams.get(teamId);
    if (!team) return;
    const wasAgent = team.memberAgentIds.includes(memberId);
    team.memberAgentIds = team.memberAgentIds.filter(id => id !== memberId);
    team.humanMemberIds = (team.humanMemberIds ?? []).filter(id => id !== memberId);
    if (team.managerId === memberId) {
      team.managerId = undefined;
      team.managerType = undefined;
    }
    try {
      const agent = this.agentManager.getAgent(memberId);
      if (agent.config.teamId === teamId) agent.config.teamId = undefined;
    } catch {
      /* ok */
    }
    if (wasAgent && this.storage) {
      this.storage.agentRepo.updateTeamId(memberId, null).catch((error: unknown) => {
        log.warn('Failed to clear agent teamId in DB', { error: String(error) });
      });
    }
    const user = this.humans.get(memberId);
    if (user && user.teamId === teamId) {
      user.teamId = undefined;
      if (this.storage) {
        this.storage.userRepo.updateTeamId(memberId, null).catch((error: unknown) => {
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
            currentTaskId: state.activeTaskIds?.[0],
          });
        } catch {
          /* skip removed agents */
        }
      }

      for (const userId of team.humanMemberIds ?? []) {
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
          try {
            managerName = this.agentManager.getAgent(team.managerId).config.name;
          } catch {
            /* ok */
          }
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
            id: a.id,
            name: a.name,
            type: 'agent',
            role: agent.role.name,
            agentRole: agent.config.agentRole ?? 'worker',
            status: state.status,
            currentTaskId: state.activeTaskIds?.[0],
          });
        }
      } catch {
        /* ok */
      }
    }

    for (const user of this.humans.values()) {
      if (user.orgId !== orgId) continue;
      if (!humanIdsInTeams.has(user.id)) {
        ungrouped.push({
          id: user.id,
          name: user.name,
          type: 'human',
          role: user.role,
        });
      }
    }

    return ungrouped;
  }

  getTeam(teamId: string): Team | undefined {
    return this.teams.get(teamId);
  }

  listTeams(orgId: string): Team[] {
    return [...this.teams.values()].filter(t => t.orgId === orgId);
  }

  // ─── Team Batch Agent Control ─────────────────────────────────────────────

  async startTeamAgents(teamId: string): Promise<{ success: string[]; failed: Array<{ id: string; error: string }> }> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    return this.agentManager.startAgentsByIds(team.memberAgentIds);
  }

  async stopTeamAgents(teamId: string): Promise<{ success: string[]; failed: Array<{ id: string; error: string }> }> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    return this.agentManager.stopAgentsByIds(team.memberAgentIds);
  }

  pauseTeamAgents(teamId: string, reason?: string): { success: string[]; failed: Array<{ id: string; error: string }> } {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    return this.agentManager.pauseAgentsByIds(team.memberAgentIds, reason);
  }

  resumeTeamAgents(teamId: string): { success: string[]; failed: Array<{ id: string; error: string }> } {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    return this.agentManager.resumeAgentsByIds(team.memberAgentIds);
  }

  getTeamAgentStatuses(teamId: string): Array<{ id: string; name: string; status: string; role?: string }> {
    const team = this.teams.get(teamId);
    if (!team) return [];
    return team.memberAgentIds.map(agentId => {
      try {
        const agent = this.agentManager.getAgent(agentId);
        const state = agent.getState();
        return { id: agentId, name: agent.config.name, status: state.status, role: agent.config.agentRole };
      } catch {
        return { id: agentId, name: 'unknown', status: 'not_found' };
      }
    });
  }

  async hireAgent(request: CreateAgentRequest & { orgId: string }) {
    let org = this.orgs.get(request.orgId);
    if (!org && request.orgId === 'default') {
      org = this.getDefaultOrganization();
    }
    if (!org) throw new Error(`Organization not found: ${request.orgId}`);

    if (org.maxAgents > 0) {
      const currentAgents = this.agentManager.listAgents();
      if (currentAgents.length >= org.maxAgents) {
        throw new Error(`Agent limit reached (${org.maxAgents}) for organization ${org.name}`);
      }
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
          roleId: agent.config.roleId, // template folder name (e.g. 'developer')
          roleName: agent.role.name, // display name (e.g. 'Software Developer')
          agentRole: agent.config.agentRole ?? 'worker',
          skills: agent.config.skills,
          llmConfig: agent.config.llmConfig,
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
      if (this.storage?.orgRepo?.updateManagerAgentId) {
        this.storage.orgRepo.updateManagerAgentId(request.orgId, agent.id)
          .catch((err: unknown) => log.warn('Failed to persist managerAgentId', { error: String(err) }));
      }
    }

    this.refreshIdentityContextsForOrg(request.orgId);

    // Onboard = always online. Auto-start the agent immediately.
    try {
      await this.agentManager.startAgent(agent.id);
      log.info(`Agent onboarded: ${request.name} (auto-started)`, {
        orgId: request.orgId,
        agentId: agent.id,
        agentRole: request.agentRole ?? 'worker',
      });
    } catch (error) {
      log.warn(`Agent created but auto-start failed: ${request.name}`, { error: String(error) });
    }

    return agent;
  }

  /** Alias for hireAgent — onboard semantics */
  async onboardAgent(request: CreateAgentRequest & { orgId: string }) {
    return this.hireAgent(request);
  }

  /** Check whether an agent is the protected Secretary (cannot be deleted). */
  isProtectedAgent(agentId: string): boolean {
    try {
      const agent = this.agentManager.getAgent(agentId);
      return agent.role.name.toLowerCase() === 'secretary';
    } catch { return false; }
  }

  async fireAgent(agentId: string, opts?: { purgeFiles?: boolean }): Promise<void> {
    if (this.isProtectedAgent(agentId)) {
      throw new Error('The Secretary agent is a protected system agent and cannot be deleted.');
    }

    const agentInfo = this.agentManager.listAgents().find(a => a.id === agentId);
    await this.agentManager.removeAgent(agentId, { purgeFiles: opts?.purgeFiles });

    for (const org of this.orgs.values()) {
      if (org.managerAgentId === agentId) {
        org.managerAgentId = undefined;
        if (this.storage?.orgRepo?.updateManagerAgentId) {
          this.storage.orgRepo.updateManagerAgentId(org.id, null)
            .catch((err: unknown) => log.warn('Failed to clear managerAgentId', { error: String(err) }));
        }
      }
    }

    if (this.storage) {
      try {
        await this.storage.agentRepo.delete(agentId);
      } catch (error) {
        log.error('Failed to remove agent from DB', { agentId, error: String(error) });
      }
    }

    for (const team of this.teams.values()) {
      team.memberAgentIds = team.memberAgentIds.filter(id => id !== agentId);
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
    const teams = this.listTeams(targetOrgId).map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      memberAgentIds: t.memberAgentIds,
    }));
    this.agentManager.refreshIdentityContexts(targetOrgId, org.name, humans, teams);
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

    // 0. Restore org-level fields from DB
    try {
      const orgRow = this.storage.orgRepo.findOrgById?.(orgId);
      if (orgRow) {
        const org = this.orgs.get(orgId);
        if (org && orgRow.managerAgentId) {
          org.managerAgentId = orgRow.managerAgentId;
        }
      }
    } catch (error) {
      log.warn('Failed to restore org fields from DB', { error: String(error) });
    }

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

    // 2. Restore agent data (fast — no auto-start, just create agent objects)
    this.pendingAgentStartIds = [];
    try {
      const agentRows = await this.storage.agentRepo.findByOrgId(orgId);
      const toRestore = agentRows.filter((row: { id: string }) => !this.agentManager.hasAgent(row.id));
      const restorePromises = toRestore.map(async (row: typeof agentRows[number]) => {
          try {
            await this.agentManager.restoreAgent(row);
            this.pendingAgentStartIds.push(row.id);

            if (row.teamId) {
              const team = this.teams.get(row.teamId);
              if (team && !team.memberAgentIds.includes(row.id)) {
                team.memberAgentIds.push(row.id);
              }
            }
            return true;
          } catch (agentErr) {
            log.warn(`Failed to restore agent ${row.id}`, { error: String(agentErr) });
            return false;
          }
        });
      const results = await Promise.all(restorePromises);
      const restoredCount = results.filter(Boolean).length;
      log.info(`Restored ${restoredCount} agents from DB`);
    } catch (error) {
      log.warn('Failed to restore agents from DB', { error: String(error) });
    }

    // 3. Restore human users (merge DB data into existing in-memory users)
    try {
      const userRows = await this.storage.userRepo.listByOrg(orgId);
      let restoredCount = 0;
      for (const row of userRows) {
        const existing = this.humans.get(row.id);
        if (existing) {
          if (row.email) existing.email = row.email;
          if (row.teamId) {
            existing.teamId = row.teamId;
            const team = this.teams.get(row.teamId);
            if (team && !team.humanMemberIds?.includes(row.id)) {
              if (!team.humanMemberIds) team.humanMemberIds = [];
              team.humanMemberIds.push(row.id);
            }
          }
          continue;
        }
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
   * Start all restored agents in the background with staggered delays.
   * Call this AFTER the HTTP server is already listening and all handlers are wired.
   * Returns immediately — agents start asynchronously.
   */
  startRestoredAgentsInBackground(): Promise<void> {
    const ids = this.pendingAgentStartIds;
    this.pendingAgentStartIds = [];
    if (ids.length === 0) return Promise.resolve();

    const STAGGER_MS = 1_000;
    const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
    log.info(`Starting ${ids.length} restored agents in background (heartbeats will be staggered)...`);

    const startAll = async () => {
      let started = 0;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        try {
          const initialHeartbeatDelayMs = ids.length > 1
            ? Math.floor((i / ids.length) * DEFAULT_HEARTBEAT_INTERVAL_MS) + Math.floor(Math.random() * HEARTBEAT_STARTUP_JITTER_MS)
            : undefined;
          await this.agentManager.startAgent(id, { initialHeartbeatDelayMs });
          started++;
          if (started < ids.length) {
            await new Promise(r => setTimeout(r, STAGGER_MS));
          }
        } catch (err) {
          log.warn(`Failed to auto-start restored agent ${id}`, { error: String(err) });
        }
      }
      log.info(`Background agent startup complete: ${started}/${ids.length} agents started`);
    };

    const p = startAll().catch(err => {
      log.error('Background agent startup failed', { error: String(err) });
    });
    return p;
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
      const team = await this.createTeam(
        orgId,
        'My Team',
        'Your primary team — you and your personal AI Secretary.'
      );

      // Add the owner as a human member
      const owner = this.humans.get(ownerUserId);
      if (owner) {
        this.addMemberToTeam(team.id, ownerUserId, 'human');
      }

      // Hire a Secretary agent as manager of this team, with all building skills
      const secretary = await this.hireAgent({
        name: 'Secretary',
        roleName: 'secretary',
        orgId,
        teamId: team.id,
        agentRole: 'manager',
        skills: ['agent-building', 'team-building', 'skill-building'],
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

  private static readonly BUILDING_SKILLS = new Set(['agent-building', 'team-building', 'skill-building']);

  /**
   * Register dynamic context providers on any agent with a building skill
   * so they see the live list of available skills/roles at runtime.
   */
  registerBuilderContextProviders(skillRegistry?: SkillRegistry): void {
    const allAgents = this.agentManager.listAgents();

    for (const info of allAgents) {
      try {
        const agent = this.agentManager.getAgent(info.id);
        const hasBuilderSkill = agent.config.skills.some(s => OrganizationService.BUILDING_SKILLS.has(s));
        if (!hasBuilderSkill) continue;
        agent.addDynamicContextProvider(() => this.buildBuilderDynamicContext(skillRegistry), 'builder-context');
      } catch {
        log.warn(`Could not register dynamic context for builder: ${info.name}`);
      }
    }
  }

  buildBuilderDynamicContext(skillRegistry?: SkillRegistry): string {
    const parts: string[] = [];

    // Available skills
    const skillNames = new Set<string>();
    const skillEntries: Array<{ name: string; description: string; type: string }> = [];

    if (skillRegistry) {
      for (const s of skillRegistry.list()) {
        skillNames.add(s.name);
        skillEntries.push({ name: s.name, description: s.description ?? '', type: s.sourcePath ? 'installed' : 'builtin' });
      }
    }
    for (const dir of WELL_KNOWN_SKILL_DIRS) {
      for (const { manifest } of discoverSkillsInDir(dir)) {
        if (skillNames.has(manifest.name)) continue;
        skillNames.add(manifest.name);
        skillEntries.push({ name: manifest.name, description: manifest.description ?? '', type: 'installed' });
      }
    }

    if (skillEntries.length > 0) {
      parts.push('## Available Skills (live from system)');
      parts.push('');
      parts.push('**IMPORTANT**: Actively assign relevant skills to each agent. Do NOT default to empty `skills: []`.');
      parts.push('Review this table and assign skills that match the agent\'s purpose:');
      parts.push('');
      parts.push('| Skill ID | Description | Type |');
      parts.push('|----------|-------------|------|');
      for (const s of skillEntries) {
        parts.push(`| \`${s.name}\` | ${s.description.slice(0, 80)} | ${s.type} |`);
      }
      parts.push('');
      parts.push('Only use skill IDs from this table. Assign at least one skill to each agent when a match exists.');
    }

    // Available roles
    const roleNames = this.listAvailableRoles();
    if (roleNames.length > 0) {
      parts.push('');
      parts.push('## Available Role Templates (live from system)');
      parts.push('');
      parts.push('The `roleName` field must be one of:');
      parts.push('');
      for (const r of roleNames) {
        parts.push(`- \`${r}\``);
      }

      const templateDirs = this.roleLoader.getTemplateDirs();
      if (templateDirs.length > 0) {
        parts.push('');
        parts.push('**Tip**: You can read existing role templates for reference when writing custom ROLE.md files.');
        parts.push(`Use \`file_read\` to inspect any template, e.g.: \`file_read("${templateDirs[0]}/developer/ROLE.md")\``);
        parts.push('This is especially useful for understanding the level of detail and workflow guidance expected in a good ROLE.md.');
      }
    }

    // Platform capabilities — so builders write ROLE.md that leverages the system
    parts.push('');
    parts.push('## Platform Capabilities (reference when writing ROLE.md)');
    parts.push('');
    parts.push('When writing custom ROLE.md for agents, reference these platform capabilities where relevant:');
    parts.push('');
    parts.push('- **`spawn_subagent`** — Spawn lightweight in-process subagents for focused subtasks (deep analysis, research, boilerplate generation) without polluting the parent agent\'s context');
    parts.push('- **`background_exec`** — Run long-running commands (builds, test suites, deployments) in background with automatic completion notifications');
    parts.push('- **`shell_execute`** — Execute any shell command, including `git` (merge, diff, branch) and `gh` CLI (PRs, issues, releases) for Git/GitHub operations');
    parts.push('- **Workspace isolation** — Project-bound tasks get an isolated working directory (`task/<id>` branch). Agents work in isolation; the reviewer merges after approval.');
    parts.push('- **`web_search` / `web_fetch`** — Search the web and fetch page content for research, documentation lookup, and real-time information');
    parts.push('- **Task dependencies** — Use `blockedBy` to express dependencies between tasks. Blocked tasks auto-start when dependencies complete.');
    parts.push('- **Deliverables** — Use `deliverable_create` to register outputs (files, conventions, architecture decisions) as trackable artifacts');
    parts.push('- **Memory** — Use `memory_save` / `memory_search` for persistent knowledge across sessions');
    parts.push('');
    parts.push('Include workflow guidance in ROLE.md that tells the agent *when* and *how* to use these capabilities for their specific role.');

    return parts.join('\n');
  }
}
