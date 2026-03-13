import { eq } from 'drizzle-orm';
import type { Database } from '../db.js';
import { users } from '../schema.js';

export interface User {
  id: string;
  orgId: string;
  name: string;
  email: string | null;
  role: string;
  teamId: string | null;
  passwordHash: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export class UserRepo {
  constructor(private db: Database) {}

  async create(data: {
    id: string;
    orgId: string;
    name: string;
    email?: string;
    role?: string;
    teamId?: string;
    passwordHash?: string;
  }): Promise<User> {
    const [row] = await this.db
      .insert(users)
      .values({
        id: data.id,
        orgId: data.orgId,
        name: data.name,
        email: data.email ?? null,
        role: data.role ?? 'member',
        teamId: data.teamId ?? null,
        passwordHash: data.passwordHash ?? null,
      })
      .returning();
    return row!;
  }

  async upsert(data: {
    id: string;
    orgId: string;
    name: string;
    email?: string;
    role?: string;
    teamId?: string;
    passwordHash?: string;
  }): Promise<void> {
    const updateSet: Record<string, unknown> = {
      name: data.name,
      role: data.role ?? 'member',
      teamId: data.teamId ?? null,
    };
    if (data.passwordHash) updateSet['passwordHash'] = data.passwordHash;
    if (data.email) updateSet['email'] = data.email;

    await this.db
      .insert(users)
      .values({
        id: data.id,
        orgId: data.orgId,
        name: data.name,
        email: data.email ?? null,
        role: data.role ?? 'member',
        teamId: data.teamId ?? null,
        passwordHash: data.passwordHash ?? null,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: updateSet,
      });
  }

  async updateTeamId(id: string, teamId: string | null): Promise<void> {
    await this.db.update(users).set({ teamId }).where(eq(users.id, id));
  }

  async clearTeamReferences(teamId: string): Promise<void> {
    await this.db.update(users).set({ teamId: null }).where(eq(users.teamId, teamId));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(users).where(eq(users.id, id));
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return row ?? null;
  }

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ?? null;
  }

  async listByOrg(orgId: string): Promise<User[]> {
    return this.db.select().from(users).where(eq(users.orgId, orgId));
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, id));
  }

  async updateProfile(
    id: string,
    data: { name?: string; email?: string; role?: string }
  ): Promise<User | null> {
    await this.db
      .update(users)
      .set({
        ...(data.name ? { name: data.name } : {}),
        ...(data.email ? { email: data.email } : {}),
        ...(data.role ? { role: data.role } : {}),
      })
      .where(eq(users.id, id));
    return this.findById(id);
  }

  async countByOrg(orgId: string): Promise<number> {
    const rows = await this.db.select({ id: users.id }).from(users).where(eq(users.orgId, orgId));
    return rows.length;
  }
}
