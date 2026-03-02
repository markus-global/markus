import { createLogger } from '@markus/shared';
import type {
  OrgRepo, TaskRepo, TaskLogRepo, AgentRepo, TeamRepo,
  MessageRepo, MemoryRepo, ChatSessionRepo, ChannelMessageRepo, UserRepo,
  MarketplaceTemplateRepo, MarketplaceSkillRepo, MarketplaceRatingRepo,
} from '@markus/storage';

const log = createLogger('storage-bridge');

/**
 * Optional storage bridge: when a DATABASE_URL is configured, initializes
 * the database and provides access to repositories.
 * Falls back gracefully to in-memory mode when no database is available.
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
}

export async function initStorage(databaseUrl?: string): Promise<StorageBridge | null> {
  const url = databaseUrl ?? process.env['DATABASE_URL'];
  if (!url) {
    log.info('No DATABASE_URL configured, running in memory-only mode');
    return null;
  }

  try {
    const storage = await import('@markus/storage');
    const db = storage.getDb(url);
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
    };
    log.info('Database storage initialized');
    return bridge;
  } catch (error) {
    log.warn('Failed to initialize database storage, falling back to memory-only mode', {
      error: String(error),
    });
    return null;
  }
}
