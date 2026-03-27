import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
  index,
} from 'drizzle-orm/pg-core';

export const agentStatusEnum = pgEnum('agent_status', [
  'idle',
  'working',
  'paused',
  'offline',
  'error',
]);
export const taskStatusEnum = pgEnum('task_status', [
  'pending_approval',
  'in_progress',
  'blocked',
  'review',
  'completed',
  'failed',
  'cancelled',
  'archived',
]);
export const taskPriorityEnum = pgEnum('task_priority', ['low', 'medium', 'high', 'urgent']);
export const messagePlatformEnum = pgEnum('message_platform', [
  'feishu',
  'whatsapp',
  'slack',
  'telegram',
  'webui',
  'internal',
]);
export const messageDirectionEnum = pgEnum('message_direction', ['inbound', 'outbound']);

export const organizations = pgTable('organizations', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ownerId: varchar('owner_id', { length: 255 }).notNull(),
  plan: varchar('plan', { length: 32 }).notNull().default('free'),
  maxAgents: integer('max_agents').notNull().default(5),
  settings: jsonb('settings').default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const teams = pgTable('teams', {
  id: varchar('id', { length: 64 }).primaryKey(),
  orgId: varchar('org_id', { length: 64 })
    .notNull()
    .references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  leadAgentId: varchar('lead_agent_id', { length: 64 }),
  managerId: varchar('manager_id', { length: 64 }),
  managerType: varchar('manager_type', { length: 16 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const agents = pgTable('agents', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  orgId: varchar('org_id', { length: 64 })
    .notNull()
    .references(() => organizations.id),
  teamId: varchar('team_id', { length: 64 }).references(() => teams.id),
  roleId: varchar('role_id', { length: 64 }).notNull(),
  roleName: varchar('role_name', { length: 255 }).notNull(),
  status: agentStatusEnum('status').notNull().default('offline'),
  skills: jsonb('skills').default([]),
  llmConfig: jsonb('llm_config').default({}),
  computeConfig: jsonb('compute_config').default({}),
  channels: jsonb('channels').default([]),
  agentRole: varchar('agent_role', { length: 16 }).notNull().default('worker'),
  heartbeatIntervalMs: integer('heartbeat_interval_ms').notNull().default(1800000),
  containerId: varchar('container_id', { length: 128 }),
  tokensUsedToday: integer('tokens_used_today').notNull().default(0),
  activeTaskIds: jsonb('active_task_ids').default([]),
  profile: jsonb('profile'),
  lastHeartbeat: timestamp('last_heartbeat'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: varchar('id', { length: 64 }).primaryKey(),
  orgId: varchar('org_id', { length: 64 })
    .notNull()
    .references(() => organizations.id),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description').notNull().default(''),
  status: taskStatusEnum('status').notNull().default('pending_approval'),
  priority: taskPriorityEnum('priority').notNull().default('medium'),
  executionMode: varchar('execution_mode', { length: 32 }),
  assignedAgentId: varchar('assigned_agent_id', { length: 64 }).notNull().references(() => agents.id),
  reviewerAgentId: varchar('reviewer_agent_id', { length: 64 }).notNull(),
  executionRound: integer('execution_round').notNull().default(1),
  subtasks: jsonb('subtasks').default([]),
  requirementId: varchar('requirement_id', { length: 64 }),
  blockedBy: jsonb('blocked_by').default([]),
  result: jsonb('result'),
  deliverables: jsonb('deliverables'),
  notes: jsonb('notes').default([]),
  projectId: varchar('project_id', { length: 64 }),
  createdBy: varchar('created_by', { length: 128 }),
  updatedBy: varchar('updated_by', { length: 128 }),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  taskType: varchar('task_type', { length: 16 }).notNull().default('standard'),
  scheduleConfig: jsonb('schedule_config'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  dueAt: timestamp('due_at'),
});

export const messages = pgTable('messages', {
  id: varchar('id', { length: 64 }).primaryKey(),
  platform: messagePlatformEnum('platform').notNull(),
  direction: messageDirectionEnum('direction').notNull(),
  channelId: varchar('channel_id', { length: 255 }).notNull(),
  senderId: varchar('sender_id', { length: 255 }).notNull(),
  senderName: varchar('sender_name', { length: 255 }),
  agentId: varchar('agent_id', { length: 64 }).references(() => agents.id),
  content: jsonb('content').notNull(),
  replyToId: varchar('reply_to_id', { length: 255 }),
  threadId: varchar('thread_id', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const memories = pgTable('memories', {
  id: varchar('id', { length: 64 }).primaryKey(),
  agentId: varchar('agent_id', { length: 64 })
    .notNull()
    .references(() => agents.id),
  type: varchar('type', { length: 32 }).notNull(),
  content: text('content').notNull(),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const agentChannelBindings = pgTable('agent_channel_bindings', {
  id: varchar('id', { length: 64 }).primaryKey(),
  agentId: varchar('agent_id', { length: 64 })
    .notNull()
    .references(() => agents.id),
  platform: varchar('platform', { length: 32 }).notNull(),
  channelId: varchar('channel_id', { length: 255 }).notNull(),
  role: varchar('role', { length: 32 }).notNull().default('member'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ─── Chat persistence ────────────────────────────────────────────────────────

/** A conversation session between a user and an agent */
export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    agentId: varchar('agent_id', { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    userId: varchar('user_id', { length: 255 }), // null = anonymous
    title: varchar('title', { length: 255 }), // auto-generated from first message
    createdAt: timestamp('created_at').notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at').notNull().defaultNow(),
  },
  t => [index('idx_chat_sessions_agent').on(t.agentId, t.lastMessageAt)]
);

/** Individual messages within a chat session */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    sessionId: varchar('session_id', { length: 64 })
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    agentId: varchar('agent_id', { length: 64 }).notNull(),
    role: varchar('role', { length: 32 }).notNull(), // user / assistant / tool
    content: text('content').notNull(),
    /** Stores interleaved segments (text + tool calls) for assistant messages */
    metadata: jsonb('metadata'),
    tokensUsed: integer('tokens_used').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  t => [index('idx_chat_messages_session').on(t.sessionId, t.createdAt)]
);

/** Messages in the web UI channels (Messages tab) */
export const channelMessages = pgTable(
  'channel_messages',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    orgId: varchar('org_id', { length: 64 }).notNull(),
    channel: varchar('channel', { length: 128 }).notNull(),
    senderId: varchar('sender_id', { length: 255 }).notNull(),
    senderType: varchar('sender_type', { length: 16 }).notNull(), // human / agent
    senderName: varchar('sender_name', { length: 255 }).notNull(),
    text: text('text').notNull(),
    mentions: jsonb('mentions').notNull().default([]),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  t => [index('idx_channel_messages_channel').on(t.channel, t.createdAt)]
);

/** Structured execution logs for each task run — persisted for audit and live display */
export const taskLogs = pgTable(
  'task_logs',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    taskId: varchar('task_id', { length: 64 })
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    agentId: varchar('agent_id', { length: 64 }).notNull(),
    seq: integer('seq').notNull().default(0),
    /** 'status' | 'text' | 'tool_start' | 'tool_end' | 'error' */
    type: varchar('type', { length: 32 }).notNull(),
    content: text('content').notNull().default(''),
    metadata: jsonb('metadata').default({}),
    executionRound: integer('execution_round').notNull().default(1),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  t => [index('idx_task_logs_task').on(t.taskId, t.seq)]
);

/** Human/agent comments on tasks — interleaved with execution logs for timeline view */
export const taskComments = pgTable(
  'task_comments',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    taskId: varchar('task_id', { length: 64 })
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    authorId: varchar('author_id', { length: 128 }).notNull(),
    authorName: varchar('author_name', { length: 255 }).notNull(),
    authorType: varchar('author_type', { length: 16 }).notNull(), // 'human' | 'agent'
    content: text('content').notNull(),
    attachments: jsonb('attachments').default([]), // [{type:'image', url:'...', name:'...'}]
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  t => [index('idx_task_comments_task').on(t.taskId, t.createdAt)]
);

/** Agent knowledge base entries for enhanced memory */
export const agentKnowledge = pgTable(
  'agent_knowledge',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    agentId: varchar('agent_id', { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    orgId: varchar('org_id', { length: 64 }).notNull(),
    category: varchar('category', { length: 64 }).notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    content: text('content').notNull(),
    tags: jsonb('tags').notNull().default([]),
    source: varchar('source', { length: 128 }).notNull().default('agent'),
    metadata: jsonb('metadata').default({}),
    importance: integer('importance').notNull().default(50), // 0-100
    accessCount: integer('access_count').notNull().default(0),
    lastAccessedAt: timestamp('last_accessed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => [
    index('idx_agent_knowledge_agent').on(t.agentId, t.category),
    index('idx_agent_knowledge_org').on(t.orgId),
  ]
);

// ─── Deliverables (产出物) ───────────────────────────────────────────────────

export const deliverables = pgTable(
  'deliverables',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    type: varchar('type', { length: 32 }).notNull().default('text'),
    title: varchar('title', { length: 512 }).notNull(),
    summary: text('summary').notNull().default(''),
    reference: text('reference').notNull().default(''),
    tags: jsonb('tags').notNull().default([]),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    taskId: varchar('task_id', { length: 64 }),
    agentId: varchar('agent_id', { length: 64 }),
    projectId: varchar('project_id', { length: 64 }),
    requirementId: varchar('requirement_id', { length: 64 }),
    artifactType: varchar('artifact_type', { length: 16 }),
    artifactData: jsonb('artifact_data'),
    diffStats: jsonb('diff_stats'),
    testResults: jsonb('test_results'),
    accessCount: integer('access_count').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => [
    index('idx_deliverables_project').on(t.projectId),
    index('idx_deliverables_agent').on(t.agentId),
    index('idx_deliverables_task').on(t.taskId),
    index('idx_deliverables_status').on(t.status),
  ]
);

// ─── Marketplace ─────────────────────────────────────────────────────────────

export const templateSourceEnum = pgEnum('template_source', ['official', 'community', 'custom']);
export const marketplaceStatusEnum = pgEnum('marketplace_status', [
  'draft',
  'pending_review',
  'published',
  'rejected',
  'archived',
]);

/** Community-contributed and official agent templates stored in DB */
export const marketplaceTemplates = pgTable(
  'marketplace_templates',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description').notNull(),
    source: templateSourceEnum('source').notNull().default('community'),
    status: marketplaceStatusEnum('status').notNull().default('draft'),
    version: varchar('version', { length: 32 }).notNull().default('1.0.0'),
    authorId: varchar('author_id', { length: 64 }),
    authorName: varchar('author_name', { length: 255 }).notNull(),
    roleId: varchar('role_id', { length: 64 }).notNull(),
    agentRole: varchar('agent_role', { length: 16 }).notNull().default('worker'),
    skills: jsonb('skills').notNull().default([]),
    llmProvider: varchar('llm_provider', { length: 64 }),
    tags: jsonb('tags').notNull().default([]),
    category: varchar('category', { length: 64 }).notNull(),
    icon: varchar('icon', { length: 16 }),
    heartbeatIntervalMs: integer('heartbeat_interval_ms'),
    starterTasks: jsonb('starter_tasks').default([]),
    config: jsonb('config').default({}),
    downloadCount: integer('download_count').notNull().default(0),
    avgRating: integer('avg_rating').notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    publishedAt: timestamp('published_at'),
  },
  t => [
    index('idx_mkt_templates_source').on(t.source, t.status),
    index('idx_mkt_templates_category').on(t.category),
    index('idx_mkt_templates_author').on(t.authorId),
  ]
);

/** Community-contributed and official skills stored in DB */
export const marketplaceSkills = pgTable(
  'marketplace_skills',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description').notNull(),
    source: templateSourceEnum('source').notNull().default('community'),
    status: marketplaceStatusEnum('status').notNull().default('draft'),
    version: varchar('version', { length: 32 }).notNull().default('1.0.0'),
    authorId: varchar('author_id', { length: 64 }),
    authorName: varchar('author_name', { length: 255 }).notNull(),
    category: varchar('category', { length: 64 }).notNull(),
    tags: jsonb('tags').notNull().default([]),
    tools: jsonb('tools').notNull().default([]),
    readme: text('readme'),
    requiredPermissions: jsonb('required_permissions').default([]),
    requiredEnv: jsonb('required_env').default([]),
    config: jsonb('config').default({}),
    downloadCount: integer('download_count').notNull().default(0),
    avgRating: integer('avg_rating').notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    publishedAt: timestamp('published_at'),
  },
  t => [
    index('idx_mkt_skills_source').on(t.source, t.status),
    index('idx_mkt_skills_category').on(t.category),
  ]
);

/** User ratings and reviews for templates and skills */
export const marketplaceRatings = pgTable(
  'marketplace_ratings',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    targetType: varchar('target_type', { length: 16 }).notNull(), // 'template' | 'skill'
    targetId: varchar('target_id', { length: 64 }).notNull(),
    userId: varchar('user_id', { length: 64 }).notNull(),
    rating: integer('rating').notNull(), // 1-5
    review: text('review'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => [
    index('idx_mkt_ratings_target').on(t.targetType, t.targetId),
    index('idx_mkt_ratings_user').on(t.userId),
  ]
);

/** Users for authentication */
export const users = pgTable('users', {
  id: varchar('id', { length: 64 }).primaryKey(),
  orgId: varchar('org_id', { length: 64 })
    .notNull()
    .references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).unique(),
  role: varchar('role', { length: 32 }).notNull().default('member'), // owner/admin/member/guest
  teamId: varchar('team_id', { length: 64 }),
  passwordHash: varchar('password_hash', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at'),
});

// ─── Requirements ────────────────────────────────────────────────────────────

export const requirementStatusEnum = pgEnum('requirement_status', [
  'draft',
  'pending_review',
  'approved',
  'in_progress',
  'completed',
  'rejected',
  'cancelled',
]);

export const requirementSourceEnum = pgEnum('requirement_source', ['user', 'agent']);

export const requirements = pgTable(
  'requirements',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    orgId: varchar('org_id', { length: 64 })
      .notNull()
      .references(() => organizations.id),
    projectId: varchar('project_id', { length: 64 }),
    title: varchar('title', { length: 500 }).notNull(),
    description: text('description').notNull().default(''),
    status: requirementStatusEnum('status').notNull().default('draft'),
    priority: taskPriorityEnum('priority').notNull().default('medium'),
    source: requirementSourceEnum('source').notNull().default('user'),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    approvedBy: varchar('approved_by', { length: 128 }),
    approvedAt: timestamp('approved_at'),
    rejectedReason: text('rejected_reason'),
    tags: jsonb('tags').default([]),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => [
    index('idx_requirements_org').on(t.orgId),
    index('idx_requirements_project').on(t.projectId),
    index('idx_requirements_status').on(t.status),
  ]
);

// ─── Governance: Projects ─────────────────────────────────────────────────────

export const projects = pgTable(
  'projects',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    orgId: varchar('org_id', { length: 64 })
      .notNull()
      .references(() => organizations.id),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    repositories: jsonb('repositories').default([]),
    teamIds: jsonb('team_ids').default([]),
    governancePolicy: jsonb('governance_policy'),
    archivePolicy: jsonb('archive_policy'),
    reportSchedule: jsonb('report_schedule'),
    onboardingConfig: jsonb('onboarding_config'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => [index('idx_projects_org').on(t.orgId)]
);

// ─── Governance: Project Knowledge Base ──────────────────────────────────────

export const projectKnowledge = pgTable(
  'project_knowledge',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    scope: varchar('scope', { length: 16 }).notNull(),
    scopeId: varchar('scope_id', { length: 64 }).notNull(),
    category: varchar('category', { length: 32 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    content: text('content').notNull(),
    tags: jsonb('tags').default([]),
    source: varchar('source', { length: 64 }).notNull(),
    importance: integer('importance').notNull().default(50),
    status: varchar('status', { length: 16 }).notNull().default('draft'),
    verifiedBy: varchar('verified_by', { length: 64 }),
    supersedes: varchar('supersedes', { length: 64 }),
    accessCount: integer('access_count').notNull().default(0),
    lastAccessedAt: timestamp('last_accessed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => [index('idx_pk_scope').on(t.scope, t.scopeId, t.category)]
);

// ─── Governance: Reports ─────────────────────────────────────────────────────

export const reports = pgTable(
  'reports',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    type: varchar('type', { length: 16 }).notNull(),
    scope: varchar('scope', { length: 16 }).notNull(),
    scopeId: varchar('scope_id', { length: 64 }).notNull(),
    periodStart: timestamp('period_start').notNull(),
    periodEnd: timestamp('period_end').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('generating'),
    metrics: jsonb('metrics'),
    taskSummary: jsonb('task_summary'),
    costSummary: jsonb('cost_summary'),
    highlights: text('highlights'),
    blockers: text('blockers'),
    learnings: text('learnings'),
    upcomingPlan: jsonb('upcoming_plan'),
    generatedAt: timestamp('generated_at').notNull().defaultNow(),
    generatedBy: varchar('generated_by', { length: 64 }).notNull(),
    reviewedBy: varchar('reviewed_by', { length: 64 }),
    reviewedAt: timestamp('reviewed_at'),
  },
  t => [
    index('idx_reports_scope').on(t.scope, t.scopeId, t.type),
    index('idx_reports_period').on(t.periodStart, t.periodEnd),
  ]
);

export const reportFeedback = pgTable(
  'report_feedback',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    reportId: varchar('report_id', { length: 64 })
      .notNull()
      .references(() => reports.id),
    authorId: varchar('author_id', { length: 64 }).notNull(),
    authorName: varchar('author_name', { length: 255 }).notNull(),
    type: varchar('type', { length: 16 }).notNull(),
    anchor: jsonb('anchor'),
    content: text('content').notNull(),
    priority: varchar('priority', { length: 16 }).notNull().default('normal'),
    disclosure: jsonb('disclosure').notNull(),
    actions: jsonb('actions').default([]),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  t => [index('idx_report_feedback_report').on(t.reportId)]
);

// ─── Governance: System Announcements ────────────────────────────────────────

export const systemAnnouncements = pgTable(
  'system_announcements',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    orgId: varchar('org_id', { length: 64 })
      .notNull()
      .references(() => organizations.id),
    type: varchar('type', { length: 32 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    content: text('content').notNull(),
    priority: varchar('priority', { length: 16 }).notNull().default('normal'),
    createdBy: varchar('created_by', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at'),
    targetScope: varchar('target_scope', { length: 16 }).notNull().default('all'),
    targetIds: jsonb('target_ids'),
    acknowledged: jsonb('acknowledged').default([]),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  t => [index('idx_announcements_org').on(t.orgId)]
);

// ─── External Agent Gateway ─────────────────────────────────────────────────

export const externalAgentRegistrations = pgTable(
  'external_agent_registrations',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    externalAgentId: varchar('external_agent_id', { length: 255 }).notNull(),
    orgId: varchar('org_id', { length: 64 }).notNull(),
    agentName: varchar('agent_name', { length: 255 }).notNull(),
    markusAgentId: varchar('markus_agent_id', { length: 64 }),
    capabilities: jsonb('capabilities').default([]),
    openClawConfig: text('openclaw_config'),
    connected: boolean('connected').notNull().default(false),
    lastSyncStatus: varchar('last_sync_status', { length: 16 }),
    lastHeartbeat: timestamp('last_heartbeat'),
    registeredAt: timestamp('registered_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => [
    index('idx_ext_agent_org').on(t.orgId),
    index('idx_ext_agent_external_id').on(t.externalAgentId, t.orgId),
  ]
);

export const gatewayMessageQueue = pgTable(
  'gateway_message_queue',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    targetAgentId: varchar('target_agent_id', { length: 64 }).notNull(),
    fromAgentId: varchar('from_agent_id', { length: 64 }).notNull(),
    fromAgentName: varchar('from_agent_name', { length: 255 }),
    content: text('content').notNull(),
    delivered: boolean('delivered').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  t => [
    index('idx_gw_msg_target').on(t.targetAgentId, t.delivered),
  ]
);
