import { eq } from 'drizzle-orm';
import type { Database } from '../db.js';
import { agents, tasks, messages, memories } from '../schema.js';

export interface AgentRow {
  id: string;
  name: string;
  orgId: string;
  teamId: string | null;
  roleId: string;
  roleName: string;
  agentRole: string;
  status: 'idle' | 'working' | 'paused' | 'offline' | 'error';
  skills: unknown;
  llmConfig: unknown;
  computeConfig: unknown;
  channels: unknown;
  heartbeatIntervalMs: number;
  containerId: string | null;
  tokensUsedToday: number;
  lastHeartbeat: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class AgentRepo {
  constructor(private db: Database) {}

  async create(data: {
    id: string;
    name: string;
    orgId: string;
    teamId?: string;
    roleId: string;
    roleName: string;
    agentRole?: string;
    skills?: string[];
    llmConfig?: unknown;
    computeConfig?: unknown;
    heartbeatIntervalMs?: number;
  }): Promise<AgentRow> {
    const [row] = await this.db.insert(agents).values({
      id: data.id,
      name: data.name,
      orgId: data.orgId,
      teamId: data.teamId ?? null,
      roleId: data.roleId,
      roleName: data.roleName,
      agentRole: data.agentRole ?? 'worker',
      skills: data.skills ?? [],
      llmConfig: data.llmConfig ?? {},
      computeConfig: data.computeConfig ?? {},
      heartbeatIntervalMs: data.heartbeatIntervalMs ?? 1800000,
    }).returning();
    return row as AgentRow;
  }

  async findById(id: string): Promise<AgentRow | undefined> {
    const [row] = await this.db.select().from(agents).where(eq(agents.id, id));
    return row as AgentRow | undefined;
  }

  async findByOrgId(orgId: string): Promise<AgentRow[]> {
    return await this.db.select().from(agents).where(eq(agents.orgId, orgId)) as AgentRow[];
  }

  async listAll(): Promise<AgentRow[]> {
    return await this.db.select().from(agents) as AgentRow[];
  }

  async updateStatus(id: string, status: AgentRow['status'], containerId?: string): Promise<void> {
    await this.db.update(agents).set({
      status,
      containerId: containerId ?? null,
      updatedAt: new Date(),
      ...(status === 'idle' || status === 'working' ? { lastHeartbeat: new Date() } : {}),
    }).where(eq(agents.id, id));
  }

  async updateTokens(id: string, tokensUsed: number): Promise<void> {
    const row = await this.findById(id);
    if (!row) return;
    await this.db.update(agents).set({
      tokensUsedToday: row.tokensUsedToday + tokensUsed,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));
  }

  async updateConfig(id: string, data: { name?: string; agentRole?: string; skills?: unknown; llmConfig?: unknown; computeConfig?: unknown; heartbeatIntervalMs?: number }): Promise<void> {
    const sets: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) sets.name = data.name;
    if (data.agentRole !== undefined) sets.agentRole = data.agentRole;
    if (data.skills !== undefined) sets.skills = data.skills;
    if (data.llmConfig !== undefined) sets.llmConfig = data.llmConfig;
    if (data.computeConfig !== undefined) sets.computeConfig = data.computeConfig;
    if (data.heartbeatIntervalMs !== undefined) sets.heartbeatIntervalMs = data.heartbeatIntervalMs;
    await this.db.update(agents).set(sets).where(eq(agents.id, id));
  }

  async updateTeamId(id: string, teamId: string | null): Promise<void> {
    await this.db.update(agents).set({ teamId, updatedAt: new Date() }).where(eq(agents.id, id));
  }

  async clearTeamReferences(teamId: string): Promise<void> {
    await this.db.update(agents).set({ teamId: null, updatedAt: new Date() }).where(eq(agents.teamId, teamId));
  }

  async delete(id: string): Promise<void> {
    // Fail any tasks assigned to this agent before deleting
    await this.db.update(tasks).set({ status: 'failed' }).where(eq(tasks.assignedAgentId, id));
    await this.db.update(messages).set({ agentId: null }).where(eq(messages.agentId, id));
    await this.db.delete(memories).where(eq(memories.agentId, id));
    await this.db.delete(agents).where(eq(agents.id, id));
  }
}
