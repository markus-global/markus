// Type definitions
export type {
  TaskRepo, TaskLogRepo, TaskCommentRepo, RequirementCommentRepo, DeliverableRepo,
  IntegrationRepo,
  PlatformInstanceRow, ChannelBindingRow, ChannelBindingScope,
  PlatformInstanceRepo, ChannelBindingRepo,
  TaskLogType, TaskLogRow,
  TaskCommentRow, RequirementCommentRow,
  ChannelMsg, ChannelMsgMetadata,
  ChatSession, ChatMessage,
  DeliverableRow, TeamRow, User,
  GroupChat, GroupChatMember,
  KnowledgeRow,
  ExternalAgentRow, GatewayMessageRow,
  MarketplaceTemplateRow, MarketplaceSkillRow, MarketplaceRatingRow,
} from './types.js';

// SQLite storage (sole backend)
export {
  openSqlite,
  closeSqlite,
  quickCheckDatabase,
  setBlobStoreForTests,
  runInTransaction,
  SqliteOrgRepo,
  SqliteAgentRepo,
  SqliteTaskRepo,
  SqliteTaskLogRepo,
  SqliteRequirementRepo,
  SqliteProjectRepo,
  SqliteMessageRepo,
  SqliteChatSessionRepo,
  SqliteChannelMessageRepo,
  SqliteUserRepo,
  SqliteTeamRepo,
  SqliteMarketplaceTemplateRepo,
  SqliteMarketplaceSkillRepo,
  SqliteMarketplaceRatingRepo,
  SqliteAgentKnowledgeRepo,
  SqliteTaskCommentRepo,
  SqliteRequirementCommentRepo,
  SqliteExternalAgentRepo,
  SqliteDeliverableRepo,
  SqliteActivityRepo,
  SqliteExecutionStreamRepo,
  SqliteMailboxRepo,
  SqliteDecisionRepo,
  SqliteNotificationRepo,
  SqliteApprovalRepo,
  SqliteGroupChatRepo,
  SqliteAuditRepo,
  SqliteStatusTransitionRepo,
  SqliteIntegrationRepo,
  SqlitePlatformInstanceRepo,
  SqliteChannelBindingRepo,
  migrateMessagingGateway,
  resolveInstanceConfig,
  SqliteReadCursorRepo,
  SqliteWorkflowRunRepo,
  SqliteWorkflowScheduleRepo,
  SqlitePendingCallbackRepo,
  migrateToExecutionStreamLogs,
  type SqliteExternalAgentRegistration,
  type ActivityRecord,
  type ActivityLogRecord,
  type ExecutionStreamRow,
  type MailboxItemRow,
  type DecisionRow,
  type IntegrationRow,
  type MessagingGatewayMigrationStats,
  type ResolvedInstanceConfig,
  type NotificationRow,
  type ApprovalRow,
  type StatusTransitionRow,
  type ReadCursorRow,
  type WorkflowRunRow,
  type WorkflowScheduleRow,
} from './sqlite-storage.js';

// 大字段外置 + 数据库维护（M1/M2/M4/M5）。唯一机制见 blob-store.ts。
export { BlobStore, defaultBlobRoot, isBlobRef, projectJsonForStorage, resolveJsonFromStorage } from './blob-store.js';
export { externalizeLargeFields, pruneTerminalMailboxItems, reclaimSpace, EXTERNALIZE_TARGETS } from './db-maintenance.js';
export type { ExternalizeOptions, ExternalizeResult, PruneOptions, PruneResult } from './db-maintenance.js';

// 附件（base64 出库）+ 后台数据迁移（升级零感知）
export {
  AttachmentStore, attachmentUrl, expandImageRefs, isAttachmentRef, isDataUrl,
} from './attachments-store.js';
export type { AttachmentRef } from './attachments-store.js';
export {
  MigrationRunner, DEFAULT_MIGRATIONS, migrateImagesToAttachments, migrateLargePayloadsToBlobs,
} from './migration-runner.js';
export type { Migration, MigrationProgress, MigrationRunnerOptions } from './migration-runner.js';
// 子进程健康探针：大库上 quick_check 是分钟级同步操作，绝不能跑在主进程里。
export { probeDatabaseHealthInChild } from './health-probe.js';
export type { HealthProbeResult, HealthProbeStatus } from './health-probe.js';
