import { eq, and } from 'drizzle-orm';
import type { Database } from '../db.js';
import { externalAgentRegistrations, gatewayMessageQueue } from '../schema.js';

export interface ExternalAgentRow {
  id: string;
  externalAgentId: string;
  orgId: string;
  agentName: string;
  markusAgentId: string | null;
  capabilities: unknown;
  openClawConfig: string | null;
  connected: boolean;
  lastSyncStatus: string | null;
  lastHeartbeat: Date | null;
  registeredAt: Date;
  updatedAt: Date;
}

export interface GatewayMessageRow {
  id: string;
  targetAgentId: string;
  fromAgentId: string;
  fromAgentName: string | null;
  content: string;
  delivered: boolean;
  createdAt: Date;
}

export class ExternalAgentRepo {
  constructor(private db: Database) {}

  async register(data: {
    id: string;
    externalAgentId: string;
    orgId: string;
    agentName: string;
    markusAgentId?: string;
    capabilities?: string[];
    openClawConfig?: string;
  }): Promise<ExternalAgentRow> {
    const [row] = await this.db.insert(externalAgentRegistrations).values({
      id: data.id,
      externalAgentId: data.externalAgentId,
      orgId: data.orgId,
      agentName: data.agentName,
      markusAgentId: data.markusAgentId ?? null,
      capabilities: data.capabilities ?? [],
      openClawConfig: data.openClawConfig ?? null,
    }).returning();
    return row as ExternalAgentRow;
  }

  async findByExternalId(externalAgentId: string, orgId: string): Promise<ExternalAgentRow | undefined> {
    const [row] = await this.db.select()
      .from(externalAgentRegistrations)
      .where(and(
        eq(externalAgentRegistrations.externalAgentId, externalAgentId),
        eq(externalAgentRegistrations.orgId, orgId),
      ));
    return row as ExternalAgentRow | undefined;
  }

  async listByOrg(orgId: string): Promise<ExternalAgentRow[]> {
    return await this.db.select()
      .from(externalAgentRegistrations)
      .where(eq(externalAgentRegistrations.orgId, orgId)) as ExternalAgentRow[];
  }

  async listAll(): Promise<ExternalAgentRow[]> {
    return await this.db.select().from(externalAgentRegistrations) as ExternalAgentRow[];
  }

  async updateHeartbeat(id: string, status?: string): Promise<void> {
    await this.db.update(externalAgentRegistrations).set({
      lastHeartbeat: new Date(),
      connected: true,
      ...(status ? { lastSyncStatus: status } : {}),
      updatedAt: new Date(),
    }).where(eq(externalAgentRegistrations.id, id));
  }

  async disconnect(id: string): Promise<void> {
    await this.db.update(externalAgentRegistrations).set({
      connected: false,
      updatedAt: new Date(),
    }).where(eq(externalAgentRegistrations.id, id));
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(externalAgentRegistrations)
      .where(eq(externalAgentRegistrations.id, id))
      .returning();
    return result.length > 0;
  }

  // ── Message Queue ──────────────────────────────────────────────────────────

  async enqueueMessage(data: {
    id: string;
    targetAgentId: string;
    fromAgentId: string;
    fromAgentName?: string;
    content: string;
  }): Promise<void> {
    await this.db.insert(gatewayMessageQueue).values({
      id: data.id,
      targetAgentId: data.targetAgentId,
      fromAgentId: data.fromAgentId,
      fromAgentName: data.fromAgentName ?? null,
      content: data.content,
    });
  }

  async drainMessages(targetAgentId: string): Promise<GatewayMessageRow[]> {
    const rows = await this.db.select()
      .from(gatewayMessageQueue)
      .where(and(
        eq(gatewayMessageQueue.targetAgentId, targetAgentId),
        eq(gatewayMessageQueue.delivered, false),
      ));

    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      for (const id of ids) {
        await this.db.update(gatewayMessageQueue).set({ delivered: true })
          .where(eq(gatewayMessageQueue.id, id));
      }
    }

    return rows as GatewayMessageRow[];
  }
}
