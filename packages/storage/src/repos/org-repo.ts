import { eq } from 'drizzle-orm';
import type { Database } from '../db.js';
import { organizations, teams } from '../schema.js';

export class OrgRepo {
  constructor(private db: Database) {}

  async createOrg(data: { id: string; name: string; ownerId: string; plan?: string; maxAgents?: number }) {
    const [row] = await this.db.insert(organizations).values({
      id: data.id,
      name: data.name,
      ownerId: data.ownerId,
      plan: data.plan ?? 'free',
      maxAgents: data.maxAgents ?? 5,
    }).returning();
    return row!;
  }

  async findOrgById(id: string) {
    const [row] = await this.db.select().from(organizations).where(eq(organizations.id, id));
    return row;
  }

  async listOrgs() {
    return this.db.select().from(organizations);
  }

  async createTeam(data: { id: string; orgId: string; name: string; description?: string }) {
    const [row] = await this.db.insert(teams).values(data).returning();
    return row!;
  }

  async listTeams(orgId: string) {
    return this.db.select().from(teams).where(eq(teams.orgId, orgId));
  }
}
