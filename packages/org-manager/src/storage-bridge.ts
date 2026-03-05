import { createLogger } from '@markus/shared';
import type {
  OrgRepo,
  TaskRepo,
  TaskLogRepo,
  AgentRepo,
  TeamRepo,
  MessageRepo,
  MemoryRepo,
  ChatSessionRepo,
  ChannelMessageRepo,
  UserRepo,
  MarketplaceTemplateRepo,
  MarketplaceSkillRepo,
  MarketplaceRatingRepo,
} from '@markus/storage';
import type { SqliteProjectRepo, SqliteIterationRepo, RequirementRepo } from '@markus/storage';
import { homedir } from 'node:os';
import { join } from 'node:path';

const log = createLogger('storage-bridge');

/**
 * Optional storage bridge: when a DATABASE_URL is configured, initializes
 * the database and provides access to repositories.
 *
 * Storage priority:
 * 1. PostgreSQL — if DATABASE_URL starts with "postgresql://" or "postgres://"
 * 2. SQLite — if DATABASE_URL starts with "sqlite:" or no DATABASE_URL at all
 *    Default path: ~/.markus/data.db
 *
 * Falls back gracefully to in-memory mode only if all backends fail.
 */
export interface StorageBridge {
  orgRepo: OrgRepo;
  taskRepo: TaskRepo;
  taskLogRepo: TaskLogRepo;
  agentRepo: AgentRepo;
  teamRepo: TeamRepo;
  messageRepo: MessageRepo;
  memoryRepo: MemoryRepo;
  chatSessionRepo: ChatSessionRepo;
  channelMessageRepo: ChannelMessageRepo;
  userRepo: UserRepo;
  marketplaceTemplateRepo: MarketplaceTemplateRepo;
  marketplaceSkillRepo: MarketplaceSkillRepo;
  marketplaceRatingRepo: MarketplaceRatingRepo;
  requirementRepo?: RequirementRepo | any;
  projectRepo?: any;
  iterationRepo?: any;
}

function isPostgresUrl(url: string): boolean {
  return url.startsWith('postgresql://') || url.startsWith('postgres://');
}

function resolveSqlitePath(url?: string): string {
  if (url?.startsWith('sqlite:')) {
    return url.slice('sqlite:'.length);
  }
  return join(homedir(), '.markus', 'data.db');
}

export async function initStorage(databaseUrl?: string): Promise<StorageBridge | null> {
  const url = databaseUrl ?? process.env['DATABASE_URL'];

  // If a PostgreSQL URL is explicitly provided, use PostgreSQL
  if (url && isPostgresUrl(url)) {
    return initPostgresStorage(url);
  }

  // Otherwise, use SQLite (zero-dependency, no Docker needed)
  return initSqliteStorage(url);
}

async function initPostgresStorage(url: string): Promise<StorageBridge | null> {
  try {
    const storage = await import('@markus/storage');
    const db = storage.getDb(url);

    // Health check: postgres.js uses lazy connections, so getDb() never throws.
    // We must run an actual query to verify the database is reachable.
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`SELECT 1`);

    const bridge: StorageBridge = {
      orgRepo: new storage.OrgRepo(db),
      taskRepo: new storage.TaskRepo(db),
      taskLogRepo: new storage.TaskLogRepo(db),
      agentRepo: new storage.AgentRepo(db),
      teamRepo: new storage.TeamRepo(db),
      messageRepo: new storage.MessageRepo(db),
      memoryRepo: new storage.MemoryRepo(db),
      chatSessionRepo: new storage.ChatSessionRepo(db),
      channelMessageRepo: new storage.ChannelMessageRepo(db),
      userRepo: new storage.UserRepo(db),
      marketplaceTemplateRepo: new storage.MarketplaceTemplateRepo(db),
      marketplaceSkillRepo: new storage.MarketplaceSkillRepo(db),
      marketplaceRatingRepo: new storage.MarketplaceRatingRepo(db),
      requirementRepo: new storage.RequirementRepo(db),
    };
    log.info('PostgreSQL storage initialized');
    return bridge;
  } catch (error) {
    log.warn('Failed to initialize PostgreSQL, falling back to SQLite', { error: String(error) });
    return initSqliteStorage();
  }
}

async function initSqliteStorage(url?: string): Promise<StorageBridge | null> {
  try {
    const storage = await import('@markus/storage');
    const dbPath = resolveSqlitePath(url);
    const db = storage.openSqlite(dbPath);

    const bridge: StorageBridge = {
      orgRepo: new storage.SqliteOrgRepo(db) as any,
      taskRepo: new storage.SqliteTaskRepo(db) as any,
      taskLogRepo: new storage.SqliteTaskLogRepo(db) as any,
      agentRepo: new storage.SqliteAgentRepo(db) as any,
      teamRepo: new storage.SqliteTeamRepo(db) as any,
      messageRepo: new storage.SqliteMessageRepo(db) as any,
      memoryRepo: new storage.SqliteMemoryRepo(db) as any,
      chatSessionRepo: new storage.SqliteChatSessionRepo(db) as any,
      channelMessageRepo: new storage.SqliteChannelMessageRepo(db) as any,
      userRepo: new storage.SqliteUserRepo(db) as any,
      marketplaceTemplateRepo: new storage.SqliteMarketplaceTemplateRepo(db) as any,
      marketplaceSkillRepo: new storage.SqliteMarketplaceSkillRepo(db) as any,
      marketplaceRatingRepo: new storage.SqliteMarketplaceRatingRepo(db) as any,
      requirementRepo: new storage.SqliteRequirementRepo(db) as any,
      projectRepo: new storage.SqliteProjectRepo(db),
      iterationRepo: new storage.SqliteIterationRepo(db),
    };
    log.info('SQLite storage initialized', { path: dbPath });
    return bridge;
  } catch (error) {
    log.warn('Failed to initialize SQLite storage, falling back to memory-only mode', {
      error: String(error),
    });
    return null;
  }
}
