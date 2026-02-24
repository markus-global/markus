import { pgTable, varchar, text, timestamp, integer, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core';

export const agentStatusEnum = pgEnum('agent_status', ['idle', 'working', 'paused', 'offline', 'error']);
export const taskStatusEnum = pgEnum('task_status', ['pending', 'assigned', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']);
export const taskPriorityEnum = pgEnum('task_priority', ['low', 'medium', 'high', 'urgent']);
export const messagePlatformEnum = pgEnum('message_platform', ['feishu', 'whatsapp', 'slack', 'telegram', 'webui', 'internal']);
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
  orgId: varchar('org_id', { length: 64 }).notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  leadAgentId: varchar('lead_agent_id', { length: 64 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const agents = pgTable('agents', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  orgId: varchar('org_id', { length: 64 }).notNull().references(() => organizations.id),
  teamId: varchar('team_id', { length: 64 }).references(() => teams.id),
  roleId: varchar('role_id', { length: 64 }).notNull(),
  roleName: varchar('role_name', { length: 255 }).notNull(),
  status: agentStatusEnum('status').notNull().default('offline'),
  skills: jsonb('skills').default([]),
  llmConfig: jsonb('llm_config').default({}),
  computeConfig: jsonb('compute_config').default({}),
  channels: jsonb('channels').default([]),
  heartbeatIntervalMs: integer('heartbeat_interval_ms').notNull().default(1800000),
  containerId: varchar('container_id', { length: 128 }),
  tokensUsedToday: integer('tokens_used_today').notNull().default(0),
  lastHeartbeat: timestamp('last_heartbeat'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: varchar('id', { length: 64 }).primaryKey(),
  orgId: varchar('org_id', { length: 64 }).notNull().references(() => organizations.id),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description').notNull().default(''),
  status: taskStatusEnum('status').notNull().default('pending'),
  priority: taskPriorityEnum('priority').notNull().default('medium'),
  executionMode: varchar('execution_mode', { length: 32 }),
  assignedAgentId: varchar('assigned_agent_id', { length: 64 }).references(() => agents.id),
  parentTaskId: varchar('parent_task_id', { length: 64 }),
  result: jsonb('result'),
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
  agentId: varchar('agent_id', { length: 64 }).notNull().references(() => agents.id),
  type: varchar('type', { length: 32 }).notNull(),
  content: text('content').notNull(),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const agentChannelBindings = pgTable('agent_channel_bindings', {
  id: varchar('id', { length: 64 }).primaryKey(),
  agentId: varchar('agent_id', { length: 64 }).notNull().references(() => agents.id),
  platform: varchar('platform', { length: 32 }).notNull(),
  channelId: varchar('channel_id', { length: 255 }).notNull(),
  role: varchar('role', { length: 32 }).notNull().default('member'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
