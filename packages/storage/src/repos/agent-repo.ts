import { eq } from 'drizzle-orm';
import type { Database } from '../db.js';
import { agents } from '../schema.js';

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

  async delete(id: string): Promise<void> {
    await this.db.delete(agents).where(eq(agents.id, id));
  }
}
