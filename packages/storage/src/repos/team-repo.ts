import { eq } from 'drizzle-orm';
import type { Database } from '../db.js';
import { teams } from '../schema.js';

export interface TeamRow {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  managerId: string | null;
  managerType: string | null;
  createdAt: Date;
}

export class TeamRepo {
  constructor(private db: Database) {}

  async create(data: {
    id: string;
    orgId: string;
    name: string;
    description?: string;
    managerId?: string;
    managerType?: string;
  }): Promise<TeamRow> {
    const [row] = await this.db.insert(teams).values({
      id: data.id,
      orgId: data.orgId,
      name: data.name,
      description: data.description ?? null,
      managerId: data.managerId ?? null,
      managerType: data.managerType ?? null,
    }).returning();
    return row as TeamRow;
  }

  async findById(id: string): Promise<TeamRow | undefined> {
    const [row] = await this.db.select().from(teams).where(eq(teams.id, id));
    return row as TeamRow | undefined;
  }

  async findByOrgId(orgId: string): Promise<TeamRow[]> {
    return await this.db.select().from(teams).where(eq(teams.orgId, orgId)) as TeamRow[];
  }

  async update(id: string, data: {
    name?: string;
    description?: string;
    managerId?: string | null;
    managerType?: string | null;
  }): Promise<void> {
    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates['name'] = data.name;
    if (data.description !== undefined) updates['description'] = data.description;
    if ('managerId' in data) updates['managerId'] = data.managerId;
    if ('managerType' in data) updates['managerType'] = data.managerType;
    if (Object.keys(updates).length > 0) {
      await this.db.update(teams).set(updates).where(eq(teams.id, id));
    }
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(teams).where(eq(teams.id, id));
  }
}
