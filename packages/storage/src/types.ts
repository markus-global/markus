/**
 * Shared type definitions for the storage layer.
 * These are the canonical row/record shapes returned by SQLite repos.
 */

// ─── Row types ─────────────────────────────────────────────────────────────────

export type TaskLogType = 'status' | 'text' | 'tool_start' | 'tool_end' | 'error';

export interface TaskRow {
  id: string;
  orgId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  executionMode: string | null;
  assignedAgentId: string;
  reviewerAgentId: string;
  executionRound: number;
  subtasks: unknown[];
  requirementId: string | null;
  blockedBy: string[];
  result: unknown;
  deliverables: unknown;
  notes: unknown;
  projectId: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  taskType: string;
  scheduleConfig: unknown;
  createdAt: Date | null;
  updatedAt: Date | null;
  dueAt: Date | null;
}

export interface TaskLogRow {
  id: string;
  taskId: string;
  agentId: string;
  seq: number;
  type: string;
  content: string;
  metadata: unknown;
  executionRound: number;
  createdAt: Date;
}

export interface TaskCommentRow {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  authorType: string;
  content: string;
  attachments: unknown;
  mentions: string[];
  activityId?: string | null;
  createdAt: Date;
}

export interface RequirementCommentRow {
  id: string;
  requirementId: string;
  authorId: string;
  authorName: string;
  authorType: string;
  content: string;
  attachments: unknown;
  mentions: string[];
  activityId?: string | null;
  createdAt: Date;
}

export interface DeliverableRow {
  id: string;
  type: string;
  title: string;
  summary: string;
  reference: string;
  tags: string[];
  status: string;
  taskId: string | null;
  agentId: string | null;
  projectId: string | null;
  requirementId: string | null;
  artifactType: string | null;
  artifactData: Record<string, unknown> | null;
  diffStats: Record<string, number> | null;
  testResults: Record<string, number> | null;
  accessCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChannelMsgMetadata {
  thinking?: string[];
  toolCalls?: Array<{
    tool: string;
    status: 'done' | 'error';
    arguments?: unknown;
    result?: string;
    durationMs?: number;
  }>;
}

export interface ChannelMsg {
  id: string;
  orgId: string;
  channel: string;
  senderId: string;
  senderType: string;
  senderName: string;
  text: string;
  mentions: string[];
  metadata?: ChannelMsgMetadata | null;
  replyToId?: string;
  createdAt: Date;
}

export interface ChatSession {
  id: string;
  agentId: string;
  userId: string | null;
  title: string | null;
  isMain: boolean;
  createdAt: Date;
  lastMessageAt: Date;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  agentId: string;
  role: string;
  content: string;
  metadata: unknown;
  tokensUsed: number;
  createdAt: Date;
}

export interface TeamRow {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  managerId: string | null;
  managerType: string | null;
  createdAt: Date;
}

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

export interface KnowledgeRow {
  id: string;
  agentId: string;
  orgId: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  metadata: Record<string, unknown>;
  importance: number;
  accessCount: number;
  lastAccessedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExternalAgentRow {
  id: string;
  externalAgentId: string;
  orgId: string;
  agentName: string;
  markusAgentId: string | null;
  capabilities: unknown;
  platform: string | null;
  platformConfig: string | null;
  agentCardUrl: string | null;
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

export interface MarketplaceTemplateRow {
  id: string;
  name: string;
  description: string;
  source: 'official' | 'community' | 'custom';
  status: 'draft' | 'pending_review' | 'published' | 'rejected' | 'archived';
  version: string;
  authorId: string | null;
  authorName: string;
  roleId: string;
  agentRole: string;
  skills: string[];
  llmProvider: string | null;
  tags: string[];
  category: string;
  icon: string | null;
  heartbeatIntervalMs: number | null;
  starterTasks: Array<{ title: string; description: string; priority: string }>;
  config: Record<string, unknown>;
  downloadCount: number;
  avgRating: number;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MarketplaceSkillRow {
  id: string;
  name: string;
  description: string;
  source: 'official' | 'community' | 'custom';
  status: 'draft' | 'pending_review' | 'published' | 'rejected' | 'archived';
  version: string;
  authorId: string | null;
  authorName: string;
  category: string;
  tags: string[];
  tools: Array<{ name: string; description: string }>;
  readme: string | null;
  requiredPermissions: string[];
  requiredEnv: string[];
  config: Record<string, unknown>;
  downloadCount: number;
  avgRating: number;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MarketplaceRatingRow {
  id: string;
  targetType: 'template' | 'skill';
  targetId: string;
  userId: string;
  rating: number;
  review: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupChat {
  id: string;
  orgId: string;
  name: string;
  channelKey: string;
  creatorId: string;
  creatorName: string;
  createdAt: Date;
}

export interface GroupChatMember {
  groupChatId: string;
  memberId: string;
  memberType: 'human' | 'agent';
  memberName: string;
  addedAt: Date;
}

// ─── Repo interfaces (structural contracts for dependency injection) ──────────

/** Contract for task persistence used by org-manager consumers */
export interface TaskRepo {
  create(data: Record<string, unknown>): Promise<unknown>;
  ensureExists(data: Record<string, unknown>): Promise<void>;
  listByOrg(orgId: string, filters?: Record<string, unknown>): TaskRow[];
  updateStatus(id: string, status: string, updatedBy?: string): Promise<void>;
  assign(id: string, agentId: string): Promise<void>;
  update(id: string, data: Record<string, unknown>): Promise<void>;
  updateDeliverables(id: string, deliverables: unknown): Promise<void>;
}

/** Contract for task log persistence */
export interface TaskLogRepo {
  append(data: Record<string, unknown>): Promise<TaskLogRow>;
  getByTask(taskId: string): TaskLogRow[];
  getMaxSeq(taskId: string): Promise<number>;
}

/** Contract for task comment persistence */
export interface TaskCommentRepo {
  add(data: Record<string, unknown>): Promise<TaskCommentRow>;
  getByTask(taskId: string): Promise<TaskCommentRow[]>;
}

/** Contract for requirement comment persistence */
export interface RequirementCommentRepo {
  add(data: Record<string, unknown>): Promise<RequirementCommentRow>;
  getByRequirement(requirementId: string): RequirementCommentRow[];
}

/** Contract for deliverable persistence */
export interface DeliverableRepo {
  create(data: Record<string, unknown>): Promise<unknown>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
  recordAccess(id: string): Promise<void>;
  listAll(limit?: number): Promise<DeliverableRow[]>;
  listTaskIdsWithDeliverables(): Promise<Set<string>>;
}
