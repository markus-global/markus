const BASE = '/api';

export interface SubagentProgressEvent {
  eventType: 'started' | 'tool_start' | 'tool_end' | 'thinking' | 'iteration' | 'completed' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AgentToolEvent {
  tool: string;
  phase: 'start' | 'end' | 'output' | 'subagent_progress';
  success?: boolean;
  arguments?: unknown;
  result?: string;
  error?: string;
  durationMs?: number;
  output?: string;
  subagentEvent?: SubagentProgressEvent;
}

export interface StreamCommitEvent {
  type: 'thinking_commit' | 'text_commit';
  content: string;
  createdAt: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email?: string;
  role: string;
  orgId: string;
  avatarUrl?: string;
}

export interface ChatSessionInfo {
  id: string;
  agentId: string;
  userId: string | null;
  title: string | null;
  isMain?: boolean;
  createdAt: string;
  lastMessageAt: string;
}

export type StoredSegment =
  | { type: 'text'; content: string; thinking?: string; createdAt?: string }
  | { type: 'tool'; tool: string; status: 'done' | 'error' | 'stopped'; arguments?: unknown; result?: string; error?: string; durationMs?: number; createdAt?: string };

export interface ChatMessageInfo {
  id: string;
  sessionId: string;
  agentId: string;
  role: string;
  content: string;
  metadata?: { segments?: StoredSegment[]; images?: string[]; isError?: boolean; isStopped?: boolean; activityLog?: boolean; activityType?: string; outcome?: string; mailboxItemId?: string; taskId?: string; requirementId?: string } | null;
  tokensUsed: number;
  createdAt: string;
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

export interface ChannelMessageInfo {
  id: string;
  channel: string;
  senderId: string;
  senderType: string;
  senderName: string;
  text: string;
  mentions: string[];
  metadata?: ChannelMsgMetadata | null;
  replyToId?: string;
  replyToSender?: string;
  replyToText?: string;
  createdAt: string;
}


export interface GroupChatInfo {
  id: string;
  name: string;
  type: 'team' | 'custom';
  channelKey: string;
  teamId?: string;
  creatorId?: string;
  creatorName?: string;
  memberCount?: number;
  members?: Array<{ id: string; name: string; type: 'human' | 'agent' }>;
}

// ─── Governance types ────────────────────────────────────────────────

export interface AnnouncementInfo {
  id: string;
  type: string;
  title: string;
  message?: string;
  priority: string;
  createdBy: string;
  createdAt: string;
  targetScope: string;
  acknowledged: string[];
}

export interface StorageBreakdownItem { name: string; path: string; size: number; description: string }
export interface StorageAgentItem { id: string; name: string; size: number; subItems: Array<{ name: string; size: number }> }
export interface StorageInfo {
  dataDir: string;
  totalSize: number;
  breakdown: StorageBreakdownItem[];
  agents: StorageAgentItem[];
  database: { path: string; size: number };
}

export interface OrphanInfo {
  orphanAgents: Array<{ id: string; path: string; size: number }>;
  orphanTeams: Array<{ id: string; path: string; size: number }>;
  totalOrphanSize: number;
}

export interface PurgeResult {
  purgedAgents: string[];
  purgedTeams: string[];
  freedBytes: number;
  failures: string[];
}

export interface GovernancePolicyInfo {
  defaultApprovalTier: string;
  maxTasksPerAgent?: number;
  requireRequirement?: boolean;
  rules?: Array<{ condition: string; approvalTier: string }>;
}

export interface ApprovalInfo {
  id: string;
  agentId: string;
  agentName: string;
  type: string;
  title: string;
  description: string;
  details: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedAt: string;
  respondedAt?: string;
  respondedBy?: string;
  responseComment?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  allowFreeform?: boolean;
  selectedOption?: string;
}

export interface CodeReviewCheckInfo {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
  details?: string;
  durationMs?: number;
}

export interface CodeReviewInfo {
  id: string;
  taskId?: string;
  agentId?: string;
  createdAt: string;
  checks: CodeReviewCheckInfo[];
  overallStatus: 'pass' | 'fail' | 'warn';
  summary: string;
}

export interface NotificationInfo {
  id: string;
  targetUserId: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  read: boolean;
  actionType?: string;
  actionTarget?: string;
  actionUrl?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectInfo {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  status: string;
  repositories?: Array<{ url: string; defaultBranch: string; localPath?: string }>;
  teamIds: string[];
  governancePolicy?: GovernancePolicyInfo;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEntryInfo {
  id: string;
  scope: string;
  scopeId: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  importance: number;
  status: string;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
  filePath?: string;
  verifiedBy?: string;
}

export interface DeliverableInfo {
  id: string;
  type: 'file' | 'directory';
  title: string;
  summary: string;
  reference: string;
  tags: string[];
  status: 'active' | 'verified' | 'outdated';
  taskId?: string;
  agentId?: string;
  projectId?: string;
  requirementId?: string;
  artifactType?: 'agent' | 'team' | 'skill';
  artifactData?: Record<string, unknown>;
  diffStats?: { filesChanged: number; additions: number; deletions: number };
  testResults?: { passed: number; failed: number; skipped: number };
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReportMetricsInfo {
  tasksCompleted: number;
  tasksFailed: number;
  tasksCreated: number;
  tasksInProgress: number;
  tasksBlocked: number;
  avgCompletionTimeMs: number;
  totalTokensUsed: number;
  estimatedCost: number;
  knowledgeContributions: number;
}

export interface ReportInfo {
  id: string;
  type: string;
  scope: string;
  scopeId?: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  metrics?: ReportMetricsInfo;
  taskSummary?: {
    completed: Array<{ id: string; title: string; agent: string; durationMs: number }>;
    inProgress: Array<{ id: string; title: string; agent: string; startedAt: string }>;
    blocked: Array<{ id: string; title: string; agent: string; reason?: string }>;
  };
  costSummary?: {
    totalTokens: number;
    totalEstimatedCost: number;
    byAgent: Array<{ agentId: string; tokens: number; cost: number }>;
    trend: string;
  };
  highlights?: string[];
  blockers?: string[];
  plan?: { status: string; items?: Array<{ title: string; priority: string; assignee?: string }> } | null;
  generatedAt: string;
  generatedBy: string;
}

export interface ReportFeedbackInfo {
  id: string;
  reportId: string;
  authorId: string;
  authorName: string;
  type: string;
  content: string;
  priority: string;
  disclosure?: { scope: string };
  actions?: Array<{ type: string; [key: string]: unknown }>;
  createdAt: string;
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',  // send cookies
    ...opts,
    body: opts?.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json() as { error?: string; message?: string };
      detail = body.error ?? body.message ?? '';
    } catch { /* ignore parse failures */ }
    throw new Error(detail || `API error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export type AgentActivityType = 'task' | 'heartbeat' | 'chat' | 'a2a' | 'internal' | 'respond_in_session';

export interface AgentActivityInfo {
  id: string;
  type: AgentActivityType;
  label: string;
  taskId?: string;
  heartbeatName?: string;
  startedAt: string;
}

export interface AgentActivityLogEntry {
  seq: number;
  type: 'status' | 'text' | 'tool_start' | 'tool_end' | 'error' | 'llm_request' | 'subagent_start' | 'subagent_progress' | 'subagent_end';
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ActivitySummary {
  id: string;
  type: AgentActivityType;
  label: string;
  taskId?: string;
  heartbeatName?: string;
  startedAt: string;
  logCount: number;
}

export interface ActivityRecord {
  id: string;
  agentId: string;
  type: AgentActivityType;
  label: string;
  taskId?: string | null;
  startedAt: string;
  endedAt?: string | null;
  totalTokens: number;
  totalTools: number;
  success: boolean;
  createdAt: string;
}

export interface AgentMindState {
  attentionState: string;
  currentFocus?: {
    mailboxItemId: string;
    type: string;
    label: string;
    startedAt: string;
    taskId?: string;
  };
  mailboxDepth: number;
  queuedItems: Array<{ id: string; sourceType: string; priority: number; summary: string; queuedAt: string }>;
  deferredItems: Array<{ id: string; sourceType: string; summary: string; deferredUntil?: string }>;
  recentDecisions: Array<{
    id: string;
    agentId: string;
    decisionType: string;
    mailboxItemId: string;
    context: Record<string, unknown>;
    reasoning: string;
    createdAt: string;
  }>;
  lastTriage?: {
    reasoning: string;
    processedItemId: string;
    deferredItemIds: string[];
    droppedItemIds: string[];
    timestamp: string;
  };
}

export interface MailboxHistoryDecision {
  id: string;
  decisionType: string;
  reasoning: string;
  createdAt: string;
}

export interface MailboxHistoryActivity {
  id: string;
  type: string;
  label: string;
  startedAt: string;
  endedAt?: string | null;
  totalTokens: number;
  totalTools: number;
  success: boolean;
}

export interface EnrichedMailboxItem {
  id: string;
  agentId: string;
  sourceType: string;
  priority: number;
  status: string;
  payload: { summary?: string; content?: string; taskId?: string; [key: string]: unknown };
  metadata: Record<string, unknown>;
  queuedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  deferredUntil?: string | null;
  mergedInto?: string | null;
  decisions?: MailboxHistoryDecision[];
  activity?: MailboxHistoryActivity | null;
}

export interface AgentMailboxResponse {
  queued: Array<{ id: string; sourceType: string; priority: number; status: string; summary: string; queuedAt: string }>;
  queueDepth: number;
  history: EnrichedMailboxItem[];
}

export interface AgentDecisionsResponse {
  recent: Array<{ id: string; decisionType: string; mailboxItemId: string; reasoning: string; createdAt: string; context: Record<string, unknown> }>;
  persisted: Array<Record<string, unknown>>;
}

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  status: string;
  skills: string[];
  activeTaskCount?: number;
  agentRole?: 'manager' | 'worker';
  teamId?: string;
  lastError?: string;
  lastErrorAt?: string;
  currentTaskId?: string;
  currentActivity?: AgentActivityInfo;
  mailboxDepth?: number;
  attentionState?: string;
  modelSupportsVision?: boolean;
  avatarUrl?: string;
}

export interface HumanUserInfo {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  orgId: string;
  email?: string;
  teamId?: string;
  avatarUrl?: string;
  hasJoined?: boolean;
}

export interface RoleInfo {
  id: string;
  name: string;
  description: string;
  category: string;
}

export interface TeamMemberInfo {
  id: string;
  name: string;
  type: 'human' | 'agent';
  role: string;
  agentRole?: 'manager' | 'worker';
  status?: string;
  teamId?: string;
  currentTaskId?: string;
  avatarUrl?: string;
}

export interface ExternalAgentInfo {
  externalAgentId: string;
  agentName: string;
  orgId: string;
  capabilities: string[];
  connected: boolean;
  markusAgentId?: string;
  lastHeartbeat?: string;
  registeredAt: string;
}

export interface TeamInfo {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  managerId?: string;
  managerType?: 'human' | 'agent';
  managerName?: string;
  members: TeamMemberInfo[];
}

export interface TaskInfo {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignedAgentId: string;
  reviewerAgentId: string;
  executionRound?: number;
  subtasks?: Array<{ id: string; title: string; status: string; createdAt?: string; completedAt?: string }>;
  blockedBy?: string[];
  notes?: string[];
  deliverables?: Array<{
    type: string;
    reference: string;
    summary: string;
  }>;
  projectId?: string;
  requirementId?: string;
  createdBy?: string;
  updatedBy?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  result?: string;
  taskType?: string;
  scheduleConfig?: {
    cron?: string;
    every?: string;
    timezone?: string;
    runAt?: string;
    maxRuns?: number;
    currentRuns?: number;
    lastRunAt?: string;
    nextRunAt?: string;
    paused?: boolean;
  };
}

export interface DeliverableItem {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  projectId?: string;
  requirementId?: string;
  assignedAgentId?: string;
  updatedAt?: string;
  deliverables: Array<{ type: string; reference: string; summary: string }>;
}

export interface RequirementInfo {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  source: string;
  createdBy: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedReason?: string;
  taskIds: string[];
  tags?: string[];
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskLogEntry {
  id: string;
  taskId: string;
  agentId: string;
  seq: number;
  /** 'status' | 'text' | 'tool_start' | 'tool_end' | 'error' */
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
  executionRound?: number;
  createdAt: string;
}

export interface RoundSummary {
  round: number;
  logCount: number;
  toolCount: number;
  firstAt: string;
  lastAt: string;
  status: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  authorType: string;
  content: string;
  attachments?: Array<{ type: string; url: string; name: string }>;
  mentions?: string[];
  activityId?: string;
  replyTo?: string;
  replyToAuthor?: string;
  replyToContent?: string;
  createdAt: string;
}

export interface RequirementComment {
  id: string;
  requirementId: string;
  authorId: string;
  authorName: string;
  authorType: string;
  content: string;
  attachments?: Array<{ type: string; url: string; name: string }>;
  mentions?: string[];
  activityId?: string;
  replyTo?: string;
  replyToAuthor?: string;
  replyToContent?: string;
  createdAt: string;
}

export interface AgentToolInfo {
  name: string;
  description: string;
}

export interface AgentHeartbeatInfo {
  running: boolean;
  uptimeMs: number;
  intervalMs: number;
  lastHeartbeat?: string;
  lastSummary?: string;
  lastSummaryAt?: string;
  nextRunAt?: string;
}

export interface RoleFileStatus {
  file: string;
  status: 'identical' | 'modified' | 'added_in_template' | 'agent_only';
}

export interface RoleUpdateStatus {
  agentId: string;
  roleId: string;
  templateId: string;
  hasTemplate: boolean;
  isUpToDate: boolean;
  files: RoleFileStatus[];
}

export interface AgentConfigInfo {
  llmConfig: { modelMode?: 'default' | 'custom'; primary: string; fallback?: string; maxTokensPerRequest?: number; maxTokensPerDay?: number };
  computeConfig: { type: string; image?: string; cpu?: number; memoryMb?: number };
  channels: Array<{ platform: string; channelId: string; role: string }>;
  heartbeatIntervalMs: number;
  orgId: string;
  teamId?: string;
  createdAt: string;
}

export interface AgentMemorySummary {
  entries: Array<{ type: string; content: string; timestamp: string; importance?: number }>;
  sessions: Array<{ id: string; agentId: string; messageCount: number; createdAt: string; updatedAt: string }>;
  dailyLog: string | null;
  recentDailyLogs: string | null;
  longTermMemory: string | null;
}

export interface AvailableSkillInfo {
  name: string;
  description: string;
  category: string;
  builtIn: boolean;
  alwaysOn: boolean;
}

export interface AgentDetail {
  id: string;
  name: string;
  role: string;
  roleDescription?: string;
  agentRole: string;
  skills: string[];
  availableSkills?: AvailableSkillInfo[];
  activeTaskCount?: number;
  activeTaskIds?: string[];
  avatarUrl?: string;
  proficiency?: Record<string, { uses: number; successes: number; lastUsed?: string }>;
  config?: AgentConfigInfo;
  tools?: AgentToolInfo[];
  heartbeat?: AgentHeartbeatInfo;
  state: {
    status: string;
    tokensUsedToday: number;
    activeTaskCount?: number;
    activeTaskIds?: string[];
    currentTaskId?: string;
    containerId?: string;
    lastHeartbeat?: string;
    lastError?: string;
    lastErrorAt?: string;
  };
}

export interface TeamTemplateInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  members: Array<{ templateId?: string; roleName?: string; name?: string; count?: number; role?: 'manager' | 'worker'; skills?: string[] }>;
  tags?: string[];
  category?: string;
}

export interface OpsDashboard {
  period: string;
  generatedAt: string;
  systemHealth: {
    overallScore: number;
    activeAgents: number;
    totalAgents: number;
    criticalAgents: Array<{ id: string; name: string; score: number }>;
    totalTokenCost: number;
    totalInteractions: number;
  };
  taskKPI: {
    totalTasks: number;
    statusCounts: Record<string, number>;
    successRate: number;
    blockedCount: number;
    averageCompletionTimeMs: number;
    recentActivity: Array<{ taskId: string; title: string; status: string; updatedAt: string }>;
  };
  agentEfficiency: Array<{
    agentId: string;
    agentName: string;
    role: string;
    agentRole: string;
    status: string;
    healthScore: number;
    tokenUsage: { input: number; output: number; cost: number };
    taskMetrics: { completed: number; failed: number; cancelled: number; averageCompletionTimeMs: number };
    averageResponseTimeMs: number;
    errorRate: number;
    totalInteractions: number;
  }>;
}

export interface AgentMetrics {
  healthScore: number;
  tokenUsage: { input: number; output: number; cost: number };
  taskMetrics: { completed: number; failed: number; cancelled: number; averageCompletionTimeMs: number };
  averageResponseTimeMs: number;
  errorRate: number;
  totalInteractions: number;
}

export interface AgentUsageInfo {
  agentId: string;
  agentName: string;
  role: string;
  status: string;
  tokensUsedToday: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
  toolCalls: number;
  messages: number;
  estimatedCost: number;
}

export const api = {
  agents: {
    list: () => request<{ agents: AgentInfo[] }>('/agents').then(d => ({ ...d, agents: d.agents.filter(a => a.name) })),
    get: (id: string) => request<AgentDetail>(`/agents/${id}`),
    create: (name: string, roleName?: string, agentRole?: 'manager' | 'worker', teamId?: string) =>
      request('/agents', { method: 'POST', body: JSON.stringify({ name, ...(roleName ? { roleName } : {}), agentRole, teamId }) }),
    start: (id: string) => request(`/agents/${id}/start`, { method: 'POST' }),
    stop: (id: string) => request(`/agents/${id}/stop`, { method: 'POST' }),
    remove: (id: string, opts?: { purgeFiles?: boolean }) =>
      request(`/agents/${id}${opts?.purgeFiles ? '?purgeFiles=true' : ''}`, { method: 'DELETE' }),
    updateConfig: (id: string, patch: Record<string, unknown>) =>
      request<{ ok: boolean; config: AgentConfigInfo }>(`/agents/${id}/config`, { method: 'PATCH', body: JSON.stringify(patch) }),
    getMemory: (id: string) => request<AgentMemorySummary>(`/agents/${id}/memory`),
    getMemorySession: (id: string, sessionId: string) =>
      request<{ id: string; agentId: string; startedAt: string; lastActivityAt: string; messages: Array<{ role: string; content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }>; toolCallId?: string }> }>(
        `/agents/${id}/memory/sessions/${encodeURIComponent(sessionId)}`
      ),
    updateDailyMemory: (id: string, content: string) =>
      request<{ ok: boolean }>(`/agents/${id}/memory/daily`, { method: 'PUT', body: JSON.stringify({ content }) }),
    updateLongTermMemory: (id: string, key: string, content: string) =>
      request<{ ok: boolean }>(`/agents/${id}/memory/longterm`, { method: 'PUT', body: JSON.stringify({ key, content }) }),
    getFiles: (id: string) => request<{ files: Array<{ name: string; content: string }> }>(`/agents/${id}/files`),
    getFilesMap: (id: string) => request<{ filesMap: Record<string, string> }>(`/agents/${id}/files`),
    updateFile: (id: string, filename: string, content: string) =>
      request<{ ok: boolean }>(`/agents/${id}/files/${encodeURIComponent(filename)}`, { method: 'PUT', body: JSON.stringify({ content }) }),
    updateSystemPrompt: (id: string, systemPrompt: string) =>
      request<{ ok: boolean }>(`/agents/${id}/system-prompt`, { method: 'PUT', body: JSON.stringify({ systemPrompt }) }),
    roleStatus: (id: string) =>
      request<RoleUpdateStatus>(`/agents/${id}/role-status`),
    roleDiff: (id: string, file = 'ROLE.md') =>
      request<{ file: string; agentContent: string | null; templateContent: string | null }>(`/agents/${id}/role-diff?file=${encodeURIComponent(file)}`),
    roleSync: (id: string, files?: string[]) =>
      request<{ agentId: string; success: boolean; error?: string; synced: string[] }>(`/agents/${id}/role-sync`, { method: 'POST', body: JSON.stringify(files ? { files } : {}) }),
    roleSmartSync: (id: string, file: string) =>
      request<{ success: boolean; mergedContent: string; explanation: string; error?: string }>(`/agents/${id}/role-smart-sync`, { method: 'POST', body: JSON.stringify({ file }) }),
    roleUpdates: () =>
      request<{ total: number; staleCount: number; stale: RoleUpdateStatus[] }>('/agents/role-updates'),
    addSkill: (id: string, skillName: string) =>
      request<{ ok: boolean; skills: string[] }>(`/agents/${id}/skills`, { method: 'POST', body: JSON.stringify({ skillName }) }),
    removeSkill: (id: string, skillName: string) =>
      request<{ ok: boolean; skills: string[] }>(`/agents/${id}/skills/${encodeURIComponent(skillName)}`, { method: 'DELETE' }),
    getHeartbeat: (id: string) => request<AgentHeartbeatInfo>(`/agents/${id}/heartbeat`),
    triggerHeartbeat: (id: string) => request<{ status: string; message: string }>(`/agents/${id}/heartbeat/trigger`, { method: 'POST' }),
    getRecentActivities: (id: string) => request<{ activities: ActivitySummary[] }>(`/agents/${id}/recent-activities`),
    getActivityLogs: (id: string, activityId: string) =>
      request<{ logs: AgentActivityLogEntry[]; activity?: AgentActivityInfo }>(`/agents/${id}/activity-logs?activityId=${encodeURIComponent(activityId)}`),
    getActivities: (id: string, opts?: { type?: string; limit?: number; before?: string }) => {
      const params = new URLSearchParams();
      if (opts?.type) params.set('type', opts.type);
      if (opts?.limit) params.set('limit', String(opts.limit));
      if (opts?.before) params.set('before', opts.before);
      const qs = params.toString();
      return request<{ activities: ActivityRecord[] }>(`/agents/${id}/activities${qs ? '?' + qs : ''}`);
    },
    getMindState: (id: string) => request<AgentMindState>(`/agents/${id}/mind`),
    getMailbox: (id: string, opts?: { limit?: number; offset?: number; category?: string; sourceType?: string; status?: string }) => {
      const params = new URLSearchParams();
      if (opts?.limit) params.set('limit', String(opts.limit));
      if (opts?.offset) params.set('offset', String(opts.offset));
      if (opts?.category) params.set('category', opts.category);
      if (opts?.sourceType) params.set('sourceType', opts.sourceType);
      if (opts?.status) params.set('status', opts.status);
      const qs = params.toString();
      return request<AgentMailboxResponse>(`/agents/${id}/mailbox${qs ? '?' + qs : ''}`);
    },
    getDecisions: (id: string, limit = 50) =>
      request<AgentDecisionsResponse>(`/agents/${id}/decisions?limit=${limit}`),
    message: (id: string, text: string, images?: string[], sessionId?: string | null, fileNames?: string[]) =>
      request<{ reply: string; sessionId?: string }>(`/agents/${id}/message`, { method: 'POST', body: JSON.stringify({ text, images, fileNames, sessionId: sessionId ?? undefined }) }),
    messageStream: (id: string, text: string, onChunk: (chunk: string) => void, onActivity?: (event: AgentToolEvent) => void, signal?: AbortSignal, images?: string[], sessionId?: string | null, isRetry?: boolean, isResume?: boolean, onCommit?: (event: StreamCommitEvent) => void, fileNames?: string[]): Promise<{ content: string; sessionId?: string; segments?: StoredSegment[] }> => {
      return new Promise(async (resolve, reject) => {
        let fullContent = '';
        let resultSessionId: string | undefined;
        let resultSegments: StoredSegment[] | undefined;
        try {
          const res = await fetch(`${BASE}/agents/${id}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ text, stream: true, images, fileNames, sessionId: sessionId ?? undefined, isRetry: isRetry || undefined, isResume: isResume || undefined }),
            signal,
          });
          if (!res.ok) { reject(new Error(`API error: ${res.status}`)); return; }
          const reader = res.body?.getReader();
          if (!reader) { reject(new Error('No reader')); return; }
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              try {
                const event = JSON.parse(trimmed.slice(6)) as { type: string; text?: string; content?: string; thinking?: string; tool?: string; phase?: 'start' | 'end'; success?: boolean; arguments?: unknown; result?: string; error?: string; durationMs?: number; toolCall?: { id?: string; name?: string }; sessionId?: string };
                if (event.type === 'text_delta' && event.text) {
                  fullContent += event.text;
                  onChunk(event.text);
                } else if (event.type === 'thinking_delta' && event.thinking) {
                  onChunk?.(`<think>${event.thinking}</think>`);
                } else if (event.type === 'done') {
                  fullContent = event.content ?? fullContent;
                  if (event.sessionId) resultSessionId = event.sessionId;
                  const doneSegments = (event as Record<string, unknown>).segments as StoredSegment[] | undefined;
                  if (doneSegments?.length) resultSegments = doneSegments;
                } else if (event.type === 'error') {
                  const errEvent = event as { type: string; message?: string; error?: string; sessionId?: string };
                  if (errEvent.sessionId) resultSessionId = errEvent.sessionId;
                  const err = new Error(errEvent.message ?? errEvent.error ?? 'Unknown stream error');
                  (err as Error & { sessionId?: string }).sessionId = errEvent.sessionId;
                  reject(err);
                  reader.cancel().catch(() => {});
                  return;
                } else if (event.type === 'thinking_commit' && event.thinking) {
                  onCommit?.({ type: 'thinking_commit', content: event.thinking, createdAt: (event as Record<string, unknown>).createdAt as string ?? new Date().toISOString() });
                } else if (event.type === 'text_commit' && event.text) {
                  onCommit?.({ type: 'text_commit', content: event.text, createdAt: (event as Record<string, unknown>).createdAt as string ?? new Date().toISOString() });
                } else if (event.type === 'tool_call_start' && event.toolCall?.name) {
                  onActivity?.({ tool: event.toolCall.name, phase: 'start' });
                } else if (event.type === 'agent_tool' && event.tool && event.phase) {
                  if (event.phase === 'start') onActivity?.({ tool: event.tool, phase: 'start', arguments: event.arguments });
                  else if (event.phase === 'end') onActivity?.({ tool: event.tool, phase: 'end', success: event.success, arguments: event.arguments, result: event.result, error: event.error, durationMs: event.durationMs });
                } else if (event.type === 'tool_output' && event.tool) {
                  onActivity?.({ tool: event.tool, phase: 'output', output: event.text });
                } else if (event.type === 'subagent_progress' && event.tool) {
                  onActivity?.({ tool: event.tool, phase: 'subagent_progress', subagentEvent: (event as Record<string, unknown>).subagentEvent as SubagentProgressEvent });
                }
              } catch { /* skip */ }
            }
          }
          resolve({ content: fullContent, sessionId: resultSessionId, segments: resultSegments });
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') { resolve({ content: fullContent, sessionId: resultSessionId, segments: resultSegments }); }
          else { reject(err); }
        }
      });
    },
  },
  roles: {
    list: () => request<{ roles: RoleInfo[] }>('/roles'),
  },
  teams: {
    list: (orgId?: string) => request<{ teams: TeamInfo[]; ungrouped: TeamMemberInfo[] }>(`/teams?orgId=${orgId ?? 'default'}`),
    create: (name: string, description?: string) =>
      request<{ team: TeamInfo }>('/teams', { method: 'POST', body: JSON.stringify({ name, description }) }),
    update: (id: string, data: { name?: string; description?: string; managerId?: string; managerType?: 'human' | 'agent' }) =>
      request<{ team: TeamInfo }>(`/teams/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string, deleteMembers?: boolean, opts?: { purgeFiles?: boolean }) =>
      request(`/teams/${id}?deleteMembers=${deleteMembers ? 'true' : 'false'}${opts?.purgeFiles ? '&purgeFiles=true' : ''}`, { method: 'DELETE' }),
    addMember: (teamId: string, memberId: string, memberType: 'human' | 'agent') =>
      request(`/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ memberId, memberType }) }),
    removeMember: (teamId: string, memberId: string) =>
      request(`/teams/${teamId}/members/${memberId}`, { method: 'DELETE' }),
    startAll: (teamId: string) =>
      request<{ success: string[]; failed: Array<{ id: string; error: string }> }>(`/teams/${teamId}/start`, { method: 'POST' }),
    stopAll: (teamId: string) =>
      request<{ success: string[]; failed: Array<{ id: string; error: string }> }>(`/teams/${teamId}/stop`, { method: 'POST' }),
    pauseAll: (teamId: string, reason?: string) =>
      request<{ success: string[]; failed: Array<{ id: string; error: string }> }>(`/teams/${teamId}/pause`, { method: 'POST', body: JSON.stringify({ reason }) }),
    resumeAll: (teamId: string) =>
      request<{ success: string[]; failed: Array<{ id: string; error: string }> }>(`/teams/${teamId}/resume`, { method: 'POST' }),
    status: (teamId: string) =>
      request<{ agents: Array<{ id: string; name: string; status: string; role?: string }> }>(`/teams/${teamId}/status`),
    getFiles: (teamId: string) =>
      request<{ files: string[] }>(`/teams/${teamId}/files`),
    getFile: (teamId: string, filename: string) =>
      request<{ filename: string; content: string }>(`/teams/${teamId}/files/${encodeURIComponent(filename)}`),
    updateFile: (teamId: string, filename: string, content: string) =>
      request<{ ok: boolean }>(`/teams/${teamId}/files/${encodeURIComponent(filename)}`, { method: 'PUT', body: JSON.stringify({ content }) }),
    exportTeam: (teamId: string) =>
      request<{ path: string; config: Record<string, unknown> }>(`/teams/${teamId}/export`, { method: 'POST' }),
    getFilesMap: (teamId: string) =>
      request<{ files: Record<string, string>; team: { id: string; name: string; description: string } }>(`/teams/${teamId}/export`),
  },
  externalAgents: {
    list: (orgId?: string) => request<{ agents: ExternalAgentInfo[] }>(`/external-agents?orgId=${orgId ?? 'default'}`),
  },
  tasks: {
    list: (filters?: {
      assignedAgentId?: string;
      status?: string;
      projectId?: string;
      requirementId?: string;
      priority?: string;
      search?: string;
      sortBy?: string;
      sortOrder?: string;
      page?: number;
      pageSize?: number;
    }) => {
      const params = new URLSearchParams();
      if (filters?.assignedAgentId) params.set('assignedAgentId', filters.assignedAgentId);
      if (filters?.status) params.set('status', filters.status);
      if (filters?.projectId) params.set('projectId', filters.projectId);
      if (filters?.requirementId) params.set('requirementId', filters.requirementId);
      if (filters?.priority) params.set('priority', filters.priority);
      if (filters?.search) params.set('search', filters.search);
      if (filters?.sortBy) params.set('sortBy', filters.sortBy);
      if (filters?.sortOrder) params.set('sortOrder', filters.sortOrder);
      if (filters?.page !== null && filters?.page !== undefined) params.set('page', String(filters.page));
      if (filters?.pageSize !== null && filters?.pageSize !== undefined) params.set('pageSize', String(filters.pageSize));
      const qs = params.toString();
      return request<{ tasks: TaskInfo[]; total: number; page: number; pageSize: number; totalPages: number }>(`/tasks${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}`),
    create: (title: string, description: string, assignedAgentId: string, reviewerAgentId: string, priority?: string, projectId?: string, blockedBy?: string[], requirementId?: string, taskType?: string, scheduleConfig?: { every?: string; cron?: string }) =>
      request<{ task: TaskInfo }>('/tasks', { method: 'POST', body: JSON.stringify({ title, description, assignedAgentId, reviewerAgentId, priority, projectId, blockedBy, requirementId, taskType, scheduleConfig }) }),
    update: (id: string, data: { title?: string; description?: string; priority?: string; projectId?: string | null; requirementId?: string | null; blockedBy?: string[]; reviewerAgentId?: string }) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    updateStatus: (id: string, status: string) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status }) }),
    assign: (id: string, agentId: string | null) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ assignedAgentId: agentId }) }),
    approve: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}/approve`, { method: 'POST' }),
    reject: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}/reject`, { method: 'POST' }),
    cancel: (id: string, cascade = false) => request<{ task: TaskInfo }>(`/tasks/${id}/cancel`, { method: 'POST', body: JSON.stringify({ cascade }) }),
    getDependentCount: (id: string) => request<{ count: number }>(`/tasks/${id}/dependents`),
    board: (filters?: { projectId?: string }) => {
      const params = new URLSearchParams();
      if (filters?.projectId) params.set('projectId', filters.projectId);
      const qs = params.toString();
      return request<{ board: Record<string, TaskInfo[]> }>(`/taskboard${qs ? `?${qs}` : ''}`);
    },
    listSubtasks: (taskId: string) => request<{ subtasks: Array<{ id: string; title: string; status: string; createdAt?: string; completedAt?: string }> }>(`/tasks/${taskId}/subtasks`),
    createSubtask: (taskId: string, title: string) =>
      request<{ subtask: { id: string; title: string; status: string } }>(`/tasks/${taskId}/subtasks`, { method: 'POST', body: JSON.stringify({ title }) }),
    completeSubtask: (taskId: string, subtaskId: string) =>
      request<{ subtask: { id: string; title: string; status: string } }>(`/tasks/${taskId}/subtasks/${subtaskId}/complete`, { method: 'POST' }),
    cancelSubtask: (taskId: string, subtaskId: string) =>
      request<{ subtask: { id: string; title: string; status: string } }>(`/tasks/${taskId}/subtasks/${subtaskId}/cancel`, { method: 'POST' }),
    deleteSubtask: (taskId: string, subtaskId: string) =>
      request(`/tasks/${taskId}/subtasks/${subtaskId}`, { method: 'DELETE' }),
    run: (id: string) => request<{ status: string; taskId: string }>(`/tasks/${id}/run`, { method: 'POST' }),
    getLogs: (id: string, round?: number) => request<{ logs: TaskLogEntry[] }>(`/tasks/${id}/logs${round !== null && round !== undefined ? `?round=${round}` : ''}`),
    getLogsSummary: (id: string) => request<{ rounds: RoundSummary[] }>(`/tasks/${id}/logs/summary`),
    accept: (id: string, reviewerId?: string) => request<{ task: TaskInfo }>(`/tasks/${id}/accept`, { method: 'POST', body: JSON.stringify({ reviewerAgentId: reviewerId ?? 'human' }) }),
    revision: (id: string, reason: string, reviewerId?: string) => request<{ task: TaskInfo }>(`/tasks/${id}/revision`, { method: 'POST', body: JSON.stringify({ reason, reviewerAgentId: reviewerId ?? 'human' }) }),
    archive: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}/archive`, { method: 'POST' }),
    pause: (id: string) => request<{ status: string; taskId: string }>(`/tasks/${id}/pause`, { method: 'POST' }),
    resume: (id: string) => request<{ status: string; taskId: string }>(`/tasks/${id}/resume`, { method: 'POST' }),
    retry: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}/retry`, { method: 'POST' }),
    getComments: (id: string) => request<{ comments: TaskComment[] }>(`/tasks/${id}/comments`),
    addComment: (id: string, content: string, authorName?: string, attachments?: Array<{ type: string; url: string; name: string }>, authorId?: string, mentions?: string[], replyTo?: string) =>
      request<{ comment: TaskComment }>(`/tasks/${id}/comments`, { method: 'POST', body: JSON.stringify({ content, authorId: authorId ?? 'human', authorName: authorName ?? 'User', authorType: 'human', attachments, mentions, replyTo }) }),
    pauseSchedule: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}/schedule/pause`, { method: 'POST' }),
    resumeSchedule: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}/schedule/resume`, { method: 'POST' }),
    runNow: (id: string) => request<{ status: string; taskId: string }>(`/tasks/${id}/schedule/run-now`, { method: 'POST' }),
    updateSchedule: (id: string, config: { every?: string; cron?: string; maxRuns?: number; timezone?: string }) =>
      request<{ task: TaskInfo }>(`/tasks/${id}/schedule`, { method: 'PUT', body: JSON.stringify(config) }),
    deliverables: (projectId?: string) => {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      return request<{ items: DeliverableItem[] }>(`/tasks/deliverables${qs}`);
    },
  },
  files: {
    preview: (filePath: string) =>
      request<{ type: string; name: string; content: string; mimeType?: string }>(`/files/preview?path=${encodeURIComponent(filePath)}`),
    reveal: (filePath: string) =>
      request<{ ok: boolean; path: string }>('/files/reveal', { method: 'POST', body: JSON.stringify({ path: filePath }) }),
    check: (paths: string[]) =>
      request<{ results: Record<string, { exists: boolean; isFile: boolean; type: string }> }>('/files/check', { method: 'POST', body: JSON.stringify({ paths }) }),
  },
  requirements: {
    list: (filters?: { orgId?: string; status?: string; source?: string; projectId?: string }) => {
      const params = new URLSearchParams();
      if (filters?.orgId) params.set('orgId', filters.orgId);
      if (filters?.status) params.set('status', filters.status);
      if (filters?.source) params.set('source', filters.source);
      if (filters?.projectId) params.set('projectId', filters.projectId);
      const qs = params.toString();
      return request<{ requirements: RequirementInfo[] }>(`/requirements${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<{ requirement: RequirementInfo }>(`/requirements/${id}`),
    create: (data: { title: string; description: string; priority?: string; projectId?: string; tags?: string[] }) =>
      request<{ requirement: RequirementInfo }>('/requirements', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { title?: string; description?: string; priority?: string; tags?: string[] }) =>
      request<{ requirement: RequirementInfo }>(`/requirements/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    updateStatus: (id: string, status: string) =>
      request<{ requirement: RequirementInfo }>(`/requirements/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
    approve: (id: string) =>
      request<{ requirement: RequirementInfo }>(`/requirements/${id}/approve`, { method: 'POST' }),
    reject: (id: string, reason: string) =>
      request<{ requirement: RequirementInfo }>(`/requirements/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
    cancel: (id: string) => request<{ requirement: RequirementInfo }>(`/requirements/${id}/cancel`, { method: 'POST' }),
    delete: (id: string) => request(`/requirements/${id}`, { method: 'DELETE' }),
    getComments: (id: string) => request<{ comments: RequirementComment[] }>(`/requirements/${id}/comments`),
    addComment: (id: string, content: string, authorName?: string, authorId?: string, mentions?: string[], replyTo?: string) =>
      request<{ comment: RequirementComment }>(`/requirements/${id}/comments`, { method: 'POST', body: JSON.stringify({ content, authorId: authorId ?? 'human', authorName: authorName ?? 'User', authorType: 'human', mentions, replyTo }) }),
  },
  users: {
    list: (orgId?: string) => request<{ users: HumanUserInfo[] }>(`/users?orgId=${orgId ?? 'default'}`),
    create: (name: string, role: string, orgId?: string, email?: string, password?: string, teamId?: string) =>
      request<{ user: HumanUserInfo; inviteToken?: string; teamError?: string }>('/users', { method: 'POST', body: JSON.stringify({ name, role, orgId, email, password, teamId }) }),
    update: (id: string, data: { name?: string; role?: string; email?: string }) =>
      request<{ user: HumanUserInfo }>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    resetPassword: (id: string, password: string) =>
      request<{ ok: boolean }>(`/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) }),
    reinvite: (id: string) =>
      request<{ inviteToken: string }>(`/users/${id}/reinvite`, { method: 'POST' }),
    remove: (id: string) => request(`/users/${id}`, { method: 'DELETE' }),
  },
  teamTemplates: {
    list: (q?: string) => {
      const params = q ? `?q=${encodeURIComponent(q)}` : '';
      return request<{ templates: TeamTemplateInfo[] }>(`/team-templates${params}`);
    },
    get: (id: string) => request<{ template: TeamTemplateInfo }>(`/team-templates/${id}`),
  },
  ops: {
    dashboard: (period: '1h' | '24h' | '7d' = '24h') =>
      request<OpsDashboard>(`/ops/dashboard?period=${period}`),
  },
  agentMetrics: (id: string, period: '1h' | '24h' | '7d' = '24h') =>
    request<AgentMetrics>(`/agents/${id}/metrics?period=${period}`),
  usage: {
    summary: (orgId = 'default', period?: string) => {
      const params = new URLSearchParams({ orgId });
      if (period) params.set('period', period);
      return request<{
        usage: { orgId: string; period: string; llmTokens: number; toolCalls: number; messages: number; storageBytes: number };
        plan: { orgId: string; tier: string; limits: { maxAgents: number; maxTokensPerMonth: number; maxToolCallsPerDay: number; maxMessagesPerDay: number; maxStorageBytes: number } };
      }>(`/usage?${params}`);
    },
    agents: (orgId = 'default') =>
      request<{ agents: AgentUsageInfo[] }>(`/usage/agents?orgId=${orgId}`),
  },
  health: () => request<{ status: string; version: string; agents: number; latestVersion?: string; updateAvailable?: boolean }>('/health'),
  system: {
    openPath: (path: string) =>
      request<{ ok: boolean }>('/system/open-path', { method: 'POST', body: JSON.stringify({ path }) }),
    storage: () => request<StorageInfo>('/system/storage'),
    orphans: () => request<OrphanInfo>('/system/storage/orphans'),
    purgeOrphans: (ids?: string[]) => request<PurgeResult>('/system/storage/orphans', {
      method: 'DELETE',
      body: ids ? JSON.stringify({ ids }) : undefined,
    }),
  },
  settings: {
    getLlm: () => request<{ defaultProvider: string; providers: Record<string, { model: string; configured: boolean }> }>('/settings/llm'),
    getAgent: () => request<{ maxToolIterations: number }>('/settings/agent'),
    updateAgent: (settings: { maxToolIterations?: number }) =>
      request<{ maxToolIterations: number }>('/settings/agent', { method: 'POST', body: JSON.stringify(settings) }),
    getBrowser: () => request<{ bringToFront: boolean; remoteDebuggingPort: number; autoCloseTabs: boolean }>('/settings/browser'),
    updateBrowser: (settings: { bringToFront?: boolean; remoteDebuggingPort?: number; autoCloseTabs?: boolean }) =>
      request<{ bringToFront: boolean; remoteDebuggingPort: number; autoCloseTabs: boolean }>('/settings/browser', { method: 'POST', body: JSON.stringify(settings) }),
  },
  skills: {
    list: () => request<{ skills: Array<{ name: string; version: string; description?: string; author?: string; category?: string; tags?: string[]; tools?: Array<{ name: string; description: string }>; requiredPermissions?: string[]; type: 'builtin' | 'filesystem' | 'imported'; sourcePath?: string; agentIds: string[] }> }>('/skills'),
    builtin: () => request<{ skills: Array<{ name: string; version: string; description?: string; author?: string; category?: string; tags: string[]; hasMcpServers: boolean; hasInstructions: boolean; requiredPermissions: string[]; installed: boolean; installedVersion?: string | null }> }>('/skills/builtin'),
    registry: (source?: string) => request<{ skills: Array<{ name: string; description: string; category: string; source: string; sourceUrl: string; author: string; addedAt?: string }>; source: string; cached: boolean }>(`/skills/registry${source ? `?source=${source}` : ''}`),
    registrySkillhub: (opts?: { q?: string; category?: string; page?: number; limit?: number; sort?: string }) => {
      const params = new URLSearchParams();
      if (opts?.q) params.set('q', opts.q);
      if (opts?.category) params.set('category', opts.category);
      if (opts?.page) params.set('page', String(opts.page));
      if (opts?.limit) params.set('limit', String(opts.limit));
      if (opts?.sort) params.set('sort', opts.sort);
      const qs = params.toString();
      return request<{ skills: Array<{ slug: string; name: string; description: string; description_zh?: string; version: string; homepage: string; tags: string[]; downloads: number; stars: number; installs: number; score: number }>; total: number; page: number; limit: number; categories: string[]; featured: string[]; cached: boolean }>(`/skills/registry/skillhub${qs ? `?${qs}` : ''}`);
    },
    registrySkillssh: (q?: string) =>
      request<{ skills: Array<{ name: string; author: string; repo: string; installs: string; url: string; description?: string }>; cached: boolean }>(`/skills/registry/skillssh${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    import: (name: string, sourceUrl?: string, description?: string, category?: string) =>
      request('/skills/import', { method: 'POST', body: JSON.stringify({ name, sourceUrl, description, category }) }),
    install: (opts: { name: string; source?: string; slug?: string; sourceUrl?: string; description?: string; category?: string; version?: string; githubRepo?: string; githubSkillPath?: string }) =>
      request<{ installed: boolean; name: string; path: string; method: string }>('/skills/install', { method: 'POST', body: JSON.stringify(opts) }),
    uninstall: (name: string) =>
      request<{ deleted: boolean; name: string; path: string }>(`/skills/installed/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    getFilesMap: (name: string) =>
      request<{ files: Record<string, string> }>(`/skills/${encodeURIComponent(name)}/files`),
  },
  // marketplace object removed — publishing now goes through Markus Hub
  builder: {
    artifacts: {
      list: () =>
        request<{ artifacts: Array<{ type: string; name: string; meta: Record<string, unknown>; path: string; updatedAt: string }> }>('/builder/artifacts'),
      get: (type: string, name: string) =>
        request<{ type: string; name: string; path: string; files: Record<string, string> }>(`/builder/artifacts/${type}s/${encodeURIComponent(name)}`),
      save: (mode: 'agent' | 'team' | 'skill', artifact: Record<string, unknown>) =>
        request<{ type: string; name: string; path: string }>('/builder/artifacts/save', { method: 'POST', body: JSON.stringify({ mode, artifact }) }),
      import: (type: 'agent' | 'team' | 'skill', name: string, files: Record<string, string>, source?: { type: string; hubItemId?: string; url?: string }) =>
        request<{ type: string; name: string; path: string }>('/builder/artifacts/import', { method: 'POST', body: JSON.stringify({ type, name, files, source }) }),
      install: (type: string, name: string) =>
        request<Record<string, unknown>>(`/builder/artifacts/${type}s/${encodeURIComponent(name)}/install`, { method: 'POST' }),
      uninstall: (type: string, name: string) =>
        request<{ uninstalled: boolean; removedAgents?: string[]; removedTeamId?: string }>(`/builder/artifacts/${type}s/${encodeURIComponent(name)}/uninstall`, { method: 'POST' }),
      delete: (type: string, name: string) =>
        request<{ deleted: boolean }>(`/builder/artifacts/${type}s/${encodeURIComponent(name)}`, { method: 'DELETE' }),
      installed: () =>
        request<{ installed: Record<string, { agentId?: string; agentIds?: string[]; teamId?: string }> }>('/builder/artifacts/installed'),
    },
  },
  auth: {
    login: (email: string, password: string) =>
      request<{ user: AuthUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    logout: () => request('/auth/logout', { method: 'POST' }),
    me: () => request<{ user: AuthUser }>('/auth/me'),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<{ ok: boolean }>('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
    updateProfile: (name: string, email: string) =>
      request<{ user: AuthUser }>('/auth/profile', { method: 'PUT', body: JSON.stringify({ name, email }) }),
    setup: (token: string, password: string) =>
      request<{ ok: boolean; email: string }>('/auth/setup', { method: 'POST', body: JSON.stringify({ token, password }) }),
    inviteInfo: (token: string) =>
      request<{ name: string; email: string }>(`/auth/invite-info?token=${encodeURIComponent(token)}`),
    uploadAvatar: (image: string, type: 'user' | 'agent' = 'user', id?: string) =>
      request<{ avatarUrl: string }>('/avatars/upload', { method: 'POST', body: JSON.stringify({ image, type, id }) }),
  },
  sessions: {
    listByAgent: (agentId: string, limit = 20) =>
      request<{ sessions: ChatSessionInfo[] }>(`/agents/${agentId}/sessions?limit=${limit}`),
    getMessages: (sessionId: string, limit = 50, before?: string) =>
      request<{ messages: ChatMessageInfo[]; hasMore: boolean }>(
        `/sessions/${sessionId}/messages?limit=${limit}${before ? `&before=${before}` : ''}`
      ),
    delete: (sessionId: string) => request(`/sessions/${sessionId}`, { method: 'DELETE' }),
  },
  channels: {
    getMessages: (channel: string, limit = 50, before?: string) =>
      request<{ messages: ChannelMessageInfo[]; hasMore: boolean }>(
        `/channels/${encodeURIComponent(channel)}/messages?limit=${limit}${before ? `&before=${before}` : ''}`
      ),
    sendMessage: (channel: string, data: { text: string; senderId?: string; senderName?: string; mentions?: string[]; targetAgentId?: string; orgId?: string; humanOnly?: boolean; replyToId?: string }) =>
      request<{ userMessage: ChannelMessageInfo | null; agentMessage: ChannelMessageInfo | null }>(
        `/channels/${encodeURIComponent(channel)}/messages`,
        { method: 'POST', body: JSON.stringify(data) }
      ),
  },
  // ─── Governance ────────────────────────────────────────────────────
  governance: {
    getSystemStatus: () =>
      request<{ globalPaused: boolean; emergencyMode: boolean }>('/system/status'),
    pauseAll: (reason?: string) =>
      request<{ status: string; message: string }>('/system/pause-all', { method: 'POST', body: JSON.stringify({ reason }) }),
    resumeAll: () =>
      request<{ status: string; message: string }>('/system/resume-all', { method: 'POST' }),
    emergencyStop: (reason?: string) =>
      request<{ status: string; message: string }>('/system/emergency-stop', { method: 'POST', body: JSON.stringify({ reason }) }),

    getAnnouncements: () =>
      request<{ announcements: AnnouncementInfo[] }>('/system/announcements'),
    createAnnouncement: (data: { title: string; message: string; priority: string; scope: string }) =>
      request<{ announcement: AnnouncementInfo }>('/system/announcements', { method: 'POST', body: JSON.stringify(data) }),

    getPolicy: () =>
      request<{ policy: GovernancePolicyInfo | null }>('/governance/policy'),
    setPolicy: (policy: GovernancePolicyInfo) =>
      request<{ policy: GovernancePolicyInfo }>('/governance/policy', { method: 'PUT', body: JSON.stringify(policy) }),
  },

  // ─── Approvals & Notifications ─────────────────────────────────────
  approvals: {
    list: (status?: string) => {
      const qs = status ? `?status=${status}` : '';
      return request<{ approvals: ApprovalInfo[] }>(`/approvals${qs}`);
    },
    respond: (id: string, approved: boolean, respondedBy?: string, comment?: string, selectedOption?: string) =>
      request<{ approval: ApprovalInfo }>(`/approvals/${id}`, { method: 'POST', body: JSON.stringify({ approved, respondedBy, comment, selectedOption }) }),
  },
  notifications: {
    list: (userId?: string, unread?: boolean, opts?: { type?: string; limit?: number; offset?: number }) => {
      const params = new URLSearchParams();
      if (userId) params.set('userId', userId);
      if (unread) params.set('unread', 'true');
      if (opts?.type) params.set('type', opts.type);
      if (opts?.limit) params.set('limit', String(opts.limit));
      if (opts?.offset) params.set('offset', String(opts.offset));
      return request<{ notifications: NotificationInfo[]; totalCount?: number; unreadCount?: number }>(`/notifications?${params}`);
    },
    markRead: (id: string) => request<{ success: boolean }>(`/notifications/${id}`, { method: 'POST' }),
    markAllRead: (userId: string) => request<{ success: boolean; count: number }>('/notifications/mark-all-read', { method: 'POST', body: JSON.stringify({ userId }) }),
  },

  // ─── Projects ──────────────────────────────────────────────────────
  projects: {
    list: (orgId?: string) => {
      const qs = orgId ? `?orgId=${orgId}` : '';
      return request<{ projects: ProjectInfo[] }>(`/projects${qs}`);
    },
    get: (id: string) => request<{ project: ProjectInfo }>(`/projects/${id}`),
    create: (data: Partial<ProjectInfo>) =>
      request<{ project: ProjectInfo }>('/projects', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<ProjectInfo>) =>
      request<{ project: ProjectInfo }>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<{ deleted: boolean }>(`/projects/${id}`, { method: 'DELETE' }),

  },

  // ─── Knowledge (legacy, redirects to deliverables) ──────────────────
  knowledge: {
    search: (query: string, scope?: string, category?: string) => {
      const params = new URLSearchParams();
      if (query) params.set('query', query);
      if (scope) params.set('scope', scope);
      if (category) params.set('category', category);
      return request<{ results: KnowledgeEntryInfo[] }>(`/knowledge/search?${params}`);
    },
    contribute: (data: Partial<KnowledgeEntryInfo>) =>
      request<{ entry: KnowledgeEntryInfo }>('/knowledge', { method: 'POST', body: JSON.stringify(data) }),
    flagOutdated: (id: string, reason: string) =>
      request<{ status: string }>(`/knowledge/${id}/flag-outdated`, { method: 'POST', body: JSON.stringify({ reason }) }),
    verify: (id: string) =>
      request<{ status: string }>(`/knowledge/${id}/verify`, { method: 'POST', body: JSON.stringify({ verifiedBy: 'human' }) }),
    remove: (id: string) =>
      request<{ status: string }>(`/knowledge/${id}`, { method: 'DELETE' }),
  },

  // ─── Deliverables (unified) ──────────────────────────────────────────
  deliverables: {
    search: (opts?: { q?: string; projectId?: string; agentId?: string; taskId?: string; type?: string; status?: string; artifactType?: string; offset?: number; limit?: number }) => {
      const params = new URLSearchParams();
      if (opts?.q) params.set('q', opts.q);
      if (opts?.projectId) params.set('projectId', opts.projectId);
      if (opts?.agentId) params.set('agentId', opts.agentId);
      if (opts?.taskId) params.set('taskId', opts.taskId);
      if (opts?.type) params.set('type', opts.type);
      if (opts?.status) params.set('status', opts.status);
      if (opts?.artifactType) params.set('artifactType', opts.artifactType);
      if (opts?.offset) params.set('offset', String(opts.offset));
      if (opts?.limit) params.set('limit', String(opts.limit));
      return request<{ results: DeliverableInfo[]; total: number }>(`/deliverables?${params}`);
    },
    create: (data: Partial<DeliverableInfo>) =>
      request<{ deliverable: DeliverableInfo }>('/deliverables', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<DeliverableInfo>) =>
      request<{ deliverable: DeliverableInfo }>(`/deliverables/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id: string) =>
      request<{ status: string }>(`/deliverables/${id}`, { method: 'DELETE' }),
    verify: (id: string) =>
      request<{ deliverable: DeliverableInfo }>(`/deliverables/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'verified' }) }),
  },

  // ─── Code Reviews ──────────────────────────────────────────────────
  codeReviews: {
    list: (taskId?: string, limit = 20) => {
      const params = new URLSearchParams();
      if (taskId) params.set('taskId', taskId);
      params.set('limit', String(limit));
      return request<{ reports: CodeReviewInfo[] }>(`/reviews?${params}`);
    },
    get: (id: string) => request<{ report: CodeReviewInfo }>(`/reviews/${id}`),
    run: (data: { taskId?: string; agentId?: string; description?: string }) =>
      request<CodeReviewInfo>('/reviews', { method: 'POST', body: JSON.stringify(data) }),
  },

  // ─── Reports ───────────────────────────────────────────────────────
  reports: {
    list: () => request<{ reports: ReportInfo[] }>('/reports'),
    get: (id: string) => request<{ report: ReportInfo }>(`/reports/${id}`),
    generate: (data: { period: string; scope: string; orgId?: string; projectId?: string }) =>
      request<{ report: ReportInfo }>('/reports/generate', { method: 'POST', body: JSON.stringify(data) }),
    approvePlan: (reportId: string, data: { approvedBy: string; comments?: string }) =>
      request<{ report: ReportInfo }>(`/reports/${reportId}/plan/approve`, { method: 'POST', body: JSON.stringify(data) }),
    rejectPlan: (reportId: string, data: { rejectedBy: string; reason: string }) =>
      request<{ report: ReportInfo }>(`/reports/${reportId}/plan/reject`, { method: 'POST', body: JSON.stringify(data) }),
    addFeedback: (reportId: string, data: { author: string; type: string; content: string; targetAgentIds?: string[]; actions?: Record<string, unknown>[] }) =>
      request<{ feedback: ReportFeedbackInfo }>(`/reports/${reportId}/feedback`, { method: 'POST', body: JSON.stringify(data) }),
    getFeedback: (reportId: string) =>
      request<{ feedback: ReportFeedbackInfo[] }>(`/reports/${reportId}/feedback`),
  },
  executionLogs: {
    get: (sourceType: string, sourceId: string) =>
      request<{ logs: ExecutionStreamEntryAPI[] }>(`/execution-logs?sourceType=${encodeURIComponent(sourceType)}&sourceId=${encodeURIComponent(sourceId)}`),
  },
  groupChats: {
    list: () => request<{ chats: GroupChatInfo[] }>('/group-chats'),
    create: (data: { name: string; memberIds: string[]; memberTypes?: Record<string, string>; memberNames?: Record<string, string>; creatorId?: string; creatorName?: string }) =>
      request<{ chat: GroupChatInfo }>('/group-chats', { method: 'POST', body: JSON.stringify(data) }),
    getById: (id: string) => request<{ chat: GroupChatInfo }>(`/group-chats/${id}`),
    update: (id: string, data: { name: string }) =>
      request<{ ok: boolean }>(`/group-chats/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) => request<{ ok: boolean }>(`/group-chats/${id}`, { method: 'DELETE' }),
    addMember: (id: string, memberId: string, memberType: string, memberName: string) =>
      request<{ ok: boolean }>(`/group-chats/${id}/members`, { method: 'POST', body: JSON.stringify({ memberId, memberType, memberName }) }),
    removeMember: (id: string, memberId: string) =>
      request<{ ok: boolean }>(`/group-chats/${id}/members/${memberId}`, { method: 'DELETE' }),
  },
};

export interface ExecutionStreamEntryAPI {
  id: string;
  sourceType: string;
  sourceId: string;
  agentId: string;
  seq: number;
  type: 'status' | 'text' | 'tool_start' | 'tool_end' | 'error' | 'subagent_start' | 'subagent_progress' | 'subagent_end';
  content: string;
  metadata?: Record<string, unknown>;
  executionRound?: number;
  createdAt: string;
}

export function taskLogToStreamEntry(e: TaskLogEntry): ExecutionStreamEntryAPI {
  return {
    id: e.id, sourceType: 'task', sourceId: e.taskId, agentId: e.agentId,
    seq: e.seq, type: e.type as ExecutionStreamEntryAPI['type'],
    content: e.content, metadata: e.metadata, executionRound: e.executionRound,
    createdAt: e.createdAt,
  };
}

export function activityLogToStreamEntry(e: AgentActivityLogEntry, activityId: string, agentId: string): ExecutionStreamEntryAPI | null {
  if (e.type === 'llm_request') return null;
  return {
    id: `alog_${activityId}_${e.seq}`, sourceType: 'activity', sourceId: activityId, agentId,
    seq: e.seq, type: e.type as ExecutionStreamEntryAPI['type'],
    content: e.content, metadata: e.metadata,
    createdAt: e.createdAt,
  };
}

export interface WSEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

type WSEventHandler = (event: WSEvent) => void;

class WSClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<WSEventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set to true by disconnect() to suppress auto-reconnect from the onclose handler */
  private intentionalClose = false;
  private currentUserId: string | undefined;

  connect(userId?: string): void {
    if (userId !== undefined) this.currentUserId = userId;

    // Guard against duplicate connections in CONNECTING or OPEN state
    if (this.ws && (
      this.ws.readyState === WebSocket.CONNECTING ||
      this.ws.readyState === WebSocket.OPEN
    )) {
      // If userId changed, reconnect with the new userId
      if (userId !== undefined && this.ws.url && !this.ws.url.includes(`userId=${userId}`)) {
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
      } else {
        return;
      }
    }

    this.intentionalClose = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const userParam = this.currentUserId ? `?userId=${encodeURIComponent(this.currentUserId)}` : '';
    const wsUrl = `${protocol}//${window.location.host}/ws${userParam}`;

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onmessage = (e) => {
      // Ignore events from a stale connection that was superseded
      if (this.ws !== ws) return;
      try {
        const event = JSON.parse(e.data as string) as WSEvent;
        const typeHandlers = this.handlers.get(event.type);
        if (typeHandlers) {
          for (const handler of typeHandlers) handler(event);
        }
        const allHandlers = this.handlers.get('*');
        if (allHandlers) {
          for (const handler of allHandlers) handler(event);
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onclose = () => {
      if (this.intentionalClose) return;
      this.reconnectTimer = setTimeout(() => this.connect(this.currentUserId), 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  on(type: string, handler: WSEventHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }
}

export const wsClient = new WSClient();

// ── Markus Hub API Client ────────────────────────────────────────────────────

let HUB_URL = (window as unknown as Record<string, string>).__MARKUS_HUB_URL__ ?? 'https://markus.global';

// Fetch hub URL from server config (overrides default if available),
// and sync existing Hub token to backend for agent tool access.
request<{ hubUrl: string }>('/settings/hub')
  .then(r => {
    if (r.hubUrl) HUB_URL = r.hubUrl;
    const existingToken = localStorage.getItem('markus_hub_token');
    if (existingToken) {
      request('/settings/hub-token', { method: 'POST', body: JSON.stringify({ token: existingToken }) }).catch(() => {});
    }
  })
  .catch(() => {});

const HUB_TOKEN_KEY = 'markus_hub_token';
const HUB_USER_KEY = 'markus_hub_user';

export interface HubUser {
  id: string;
  username: string;
  displayName?: string;
}

export interface HubItem {
  id: string;
  itemType: 'agent' | 'team' | 'skill';
  name: string;
  slug?: string;
  description: string;
  version: string;
  category: string;
  tags: string[];
  icon?: string;
  downloadCount: number;
  avgRating: string;
  ratingCount: number;
  createdAt: string;
  author: { id: string; username: string; displayName?: string };
  config?: Record<string, unknown>;
  readme?: string;
}

export function getHubToken(): string | null {
  return localStorage.getItem(HUB_TOKEN_KEY);
}

export function getHubUser(): HubUser | null {
  try {
    const raw = localStorage.getItem(HUB_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearHubAuth(): void {
  localStorage.removeItem(HUB_TOKEN_KEY);
  localStorage.removeItem(HUB_USER_KEY);
  syncHubTokenToBackend(null);
}

function saveHubAuth(token: string, user: HubUser): void {
  localStorage.setItem(HUB_TOKEN_KEY, token);
  localStorage.setItem(HUB_USER_KEY, JSON.stringify(user));
  syncHubTokenToBackend(token);
}

function syncHubTokenToBackend(token: string | null): void {
  request('/settings/hub-token', { method: 'POST', body: JSON.stringify({ token }) }).catch(() => {});
}

/**
 * Open Hub login/register page as a popup window.
 * Uses a session-based polling mechanism:
 * 1. Generate a random sessionId, open Hub /auth/connect?session=xxx
 * 2. User logs in on the Hub page → Hub stores result for this session
 * 3. Markus polls /api/auth/connect-status?session=xxx until token arrives
 * Resolves once the token is received and saved; rejects if popup is closed without auth.
 */
let _hubAuthPromise: Promise<void> | null = null;
export function ensureHubAuth(): Promise<void> {
  if (getHubToken()) return Promise.resolve();
  if (_hubAuthPromise) return _hubAuthPromise;

  const sessionId = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  _hubAuthPromise = new Promise<void>((resolve, reject) => {
    const url = `${HUB_URL}/auth/connect?session=${encodeURIComponent(sessionId)}`;
    const w = 460, h = 580;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
    const popup = window.open(url, 'markus_hub_auth', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);

    let settled = false;
    const cleanup = () => {
      clearInterval(pollTimer);
      clearInterval(closedTimer);
      _hubAuthPromise = null;
    };

    const pollTimer = setInterval(async () => {
      if (settled) return;
      try {
        const data = await request<{ ready?: boolean; token?: string; user?: HubUser }>(
          `/hub/auth/connect-status?session=${encodeURIComponent(sessionId)}`
        );
        if (data.ready && data.token && data.user) {
          settled = true;
          saveHubAuth(data.token, data.user);
          cleanup();
          popup?.close();
          resolve();
        }
      } catch { /* Hub might be offline, keep polling */ }
    }, 1500);

    const closedTimer = setInterval(() => {
      if (settled) return;
      if (popup?.closed) {
        settled = true;
        cleanup();
        if (getHubToken()) { resolve(); } else { reject(new Error('Hub login cancelled')); }
      }
    }, 500);
  });

  return _hubAuthPromise;
}

async function hubRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getHubToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init?.headers as Record<string, string> };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/hub${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  const data = await res.json();
  if (res.status === 401 && token) {
    clearHubAuth();
  }
  if (!res.ok) throw new Error(data.error ?? `Hub HTTP ${res.status}`);
  return data as T;
}

export const hubApi = {
  getUrl: () => HUB_URL,
  isAuthenticated: () => !!getHubToken(),
  getUser: getHubUser,
  logout: () => { clearHubAuth(); },
  /** Open Hub popup for login/register. Resolves when auth is complete. */
  ensureAuth: ensureHubAuth,
  login: async (email: string, password: string) => {
    const data = await hubRequest<{ user: HubUser; token: string }>('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    saveHubAuth(data.token, data.user);
    return data;
  },
  register: async (username: string, email: string, password: string) => {
    const data = await hubRequest<{ user: HubUser; token: string }>('/auth/register', {
      method: 'POST', body: JSON.stringify({ username, email, password }),
    });
    saveHubAuth(data.token, data.user);
    return data;
  },
  search: (opts?: { type?: string; q?: string; category?: string; sort?: string; page?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.type) params.set('type', opts.type);
    if (opts?.q) params.set('q', opts.q);
    if (opts?.category) params.set('category', opts.category);
    if (opts?.sort) params.set('sort', opts.sort);
    if (opts?.page) params.set('page', String(opts.page));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return hubRequest<{ items: HubItem[]; total: number }>(`/items${qs ? `?${qs}` : ''}`);
  },
  getItem: (id: string) => hubRequest<{ item: HubItem }>(`/items/${id}`),
  download: async (id: string) => {
    await ensureHubAuth();
    try {
      return await hubRequest<{ config: unknown; name: string; itemType: string; version: string; files?: Record<string, string> }>(`/items/${id}/download`, { method: 'POST' });
    } catch (e) {
      if (!getHubToken()) { await ensureHubAuth(); return hubRequest<{ config: unknown; name: string; itemType: string; version: string; files?: Record<string, string> }>(`/items/${id}/download`, { method: 'POST' }); }
      throw e;
    }
  },
  publish: async (data: { itemType: string; name: string; slug?: string; description: string; category?: string; tags?: string[]; config: unknown; files?: Record<string, string>; readme?: string }) => {
    await ensureHubAuth();
    try {
      return await hubRequest<{ id: string; name: string; slug: string; updated?: boolean }>('/items', { method: 'POST', body: JSON.stringify(data) });
    } catch (e) {
      if (!getHubToken()) { await ensureHubAuth(); return hubRequest<{ id: string; name: string; slug: string; updated?: boolean }>('/items', { method: 'POST', body: JSON.stringify(data) }); }
      throw e;
    }
  },
  publishViaProxy: async (payload: { itemType: string; name: string; slug?: string; description: string; category?: string; tags?: string[]; config?: unknown; files?: Record<string, string>; readme?: string }) => {
    await ensureHubAuth();
    try {
      return await hubRequest<{ id?: string; name?: string; slug?: string; error?: string; updated?: boolean }>('/items', { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      if (!getHubToken()) { await ensureHubAuth(); return hubRequest<{ id?: string; name?: string; slug?: string; error?: string; updated?: boolean }>('/items', { method: 'POST', body: JSON.stringify(payload) }); }
      throw e;
    }
  },
  myItems: async () => {
    if (!getHubToken()) return { items: [] as Array<{ id: string; itemType: string; name: string; slug: string; description: string; version: string; updatedAt: string }> };
    return hubRequest<{ items: Array<{ id: string; itemType: string; name: string; slug: string; description: string; version: string; updatedAt: string }> }>('/items/mine');
  },
  deleteItem: async (id: string) => {
    await ensureHubAuth();
    return hubRequest<{ ok: boolean }>(`/items/${id}`, { method: 'DELETE' });
  },
};

/** Convert a string to kebab-case slug. Must match the server-side kebab() in @markus/shared. */
export function kebab(s: string, fallback?: string): string {
  const result = s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
  if (result) return result;
  if (fallback) return fallback;
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return `pkg-${Math.abs(hash).toString(36)}`;
}
