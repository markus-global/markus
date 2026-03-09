export { getDb, closeDb, type Database } from './db.js';
export { runMigrations } from './migrate.js';
export * from './schema.js';
export { AgentRepo } from './repos/agent-repo.js';
export { OrgRepo } from './repos/org-repo.js';
export { TaskRepo } from './repos/task-repo.js';
export { MessageRepo } from './repos/message-repo.js';
export { MemoryRepo } from './repos/memory-repo.js';
export { ChatSessionRepo, type ChatSession, type ChatMessage } from './repos/chat-session-repo.js';
export { ChannelMessageRepo, type ChannelMsg } from './repos/channel-message-repo.js';
export { UserRepo, type User } from './repos/user-repo.js';
export { TeamRepo, type TeamRow } from './repos/team-repo.js';
export { TaskLogRepo, type TaskLogRow, type TaskLogType } from './repos/task-log-repo.js';
export { TaskCommentRepo, type TaskCommentRow } from './repos/task-comment-repo.js';
export { AgentKnowledgeRepo, type KnowledgeRow } from './repos/agent-knowledge-repo.js';
export { RequirementRepo } from './repos/requirement-repo.js';
export { ExternalAgentRepo, type ExternalAgentRow, type GatewayMessageRow } from './repos/external-agent-repo.js';
export {
  MarketplaceTemplateRepo,
  type MarketplaceTemplateRow,
} from './repos/marketplace-template-repo.js';
export { MarketplaceSkillRepo, type MarketplaceSkillRow } from './repos/marketplace-skill-repo.js';
export {
  MarketplaceRatingRepo,
  type MarketplaceRatingRow,
} from './repos/marketplace-rating-repo.js';

// SQLite storage: zero-dependency alternative to PostgreSQL
export {
  openSqlite,
  closeSqlite,
  SqliteOrgRepo,
  SqliteAgentRepo,
  SqliteTaskRepo,
  SqliteTaskLogRepo,
  SqliteRequirementRepo,
  SqliteProjectRepo,
  SqliteIterationRepo,
  SqliteMessageRepo,
  SqliteMemoryRepo,
  SqliteChatSessionRepo,
  SqliteChannelMessageRepo,
  SqliteUserRepo,
  SqliteTeamRepo,
  SqliteMarketplaceTemplateRepo,
  SqliteMarketplaceSkillRepo,
  SqliteMarketplaceRatingRepo,
  SqliteAgentKnowledgeRepo,
  SqliteTaskCommentRepo,
} from './sqlite-storage.js';
