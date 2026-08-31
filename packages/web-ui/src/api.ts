const BASE = '/api';

import { createStreamWatchdog } from './lib/streamResilience.ts';

export interface SubagentProgressEvent {
  eventType: 'started' | 'tool_start' | 'tool_end' | 'thinking' | 'iteration' | 'completed' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AgentToolEvent {
  tool: string;
  phase: 'start' | 'end' | 'output' | 'subagent_progress' | 'heartbeat';
  success?: boolean;
  arguments?: unknown;
  result?: string;
  error?: string;
  durationMs?: number;
  output?: string;
  subagentEvent?: SubagentProgressEvent;
}

export interface StreamCommitEvent {
  type: 'thinking_commit' | 'text_commit' | 'session_start';
  /** Server-persisted user message id (session_start) — used to replace optimistic UI ids. */
  userMessageId?: string;
  content: string;
  createdAt: string;
  sessionId?: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email?: string;
  role: string;
  orgId: string;
  avatarUrl?: string;
  preferences?: { locale?: string; timezone?: string; [key: string]: unknown };
}

export interface ChatSessionInfo {
  id: string;
  agentId: string;
  userId: string | null;
  title: string | null;
  isMain?: boolean;
  metadata?: {
    modelOverride?: { provider: string; model: string };
    kind?: string;
    parentSessionId?: string;
    sourceMessageId?: string;
    sourceAgentId?: string;
    sourceExcerpt?: string;
    createdFrom?: string;
  } | null;
  createdAt: string;
  lastMessageAt: string;
}

export type StoredSegment =
  | { type: 'text'; content: string; thinking?: string; createdAt?: string }
  | { type: 'tool'; tool: string; status: 'running' | 'done' | 'error' | 'stopped'; arguments?: unknown; result?: string; error?: string; durationMs?: number; createdAt?: string; subagentLogs?: SubagentProgressEvent[] };

export interface ChatMessageInfo {
  id: string;
  sessionId: string;
  agentId: string;
  role: string;
  content: string;
  metadata?: { segments?: StoredSegment[]; images?: string[]; isError?: boolean; isStopped?: boolean; isStreaming?: boolean; emptyReply?: boolean; streamId?: string; activityLog?: boolean; activityType?: string; outcome?: string; mailboxItemId?: string; taskId?: string; requirementId?: string; notifyUser?: boolean; replyToId?: string; replyToSender?: string; replyToText?: string } | null;
  tokensUsed: number;
  createdAt: string;
}

export interface ChannelMsgMetadata {
  thinking?: string[];
  images?: string[];
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

export interface SearchResult {
  source: 'channel' | 'direct';
  id: string;
  text: string;
  senderName?: string;
  channel?: string;
  sessionId?: string;
  agentId?: string;
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
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  requestedAt: string;
  respondedAt?: string;
  respondedBy?: string;
  responseComment?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  allowFreeform?: boolean;
  selectedOption?: string;
  questions?: UserInputQuestion[];
  answers?: UserInputAnswer[];
}

export interface UserInputOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  id: string;
  prompt: string;
  inputType: 'choice' | 'text';
  options?: UserInputOption[];
  allowMultiple?: boolean;
  allowFreeform?: boolean;
}

export interface UserInputAnswer {
  questionId: string;
  selectedOptionIds?: string[];
  text?: string;
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
  /** Human user id who created the project, when known */
  createdBy?: string;
  governancePolicy?: GovernancePolicyInfo;
  /** 知识库绑定根目录（JSON 数组），见项目级知识库需求 */
  knowledgeBasePaths?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowInfo {
  name: string;
  displayName: string;
  description: string;
  version: string;
  roles: string[];
  hasSchedule: boolean;
  schedule?: { interval?: string; cron?: string };
  stepCount: number;
  params?: Array<{ name: string; label?: string; type?: string; default?: string; required?: boolean; options?: string[] }>;
}

export interface WorkflowTemplateInfo {
  name: string;
  displayName?: string;
  description: string;
  version: string;
  schedule?: { interval?: string; cron?: string };
  params?: Array<{ name: string; label?: string; type?: string; default?: string; required?: boolean; options?: string[] }>;
  steps: Array<{ id: string; name: string; role: string; depends_on?: string[]; prompt: string }>;
}

export interface WorkflowRoleCandidate {
  role: string;
  candidates: Array<{ agentId: string; agentName: string; roleName: string; agentRole: string; score: number }>;
  recommended?: string;
}

export interface WorkflowRunInfo {
  id: string;
  teamId: string;
  workflowName: string;
  runNumber: number;
  requirementId: string;
  taskIds: string[];
  params: Record<string, string>;
  roleMapping: Record<string, string>;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  triggeredBy: string;
  projectId?: string;
  startedAt: string;
  completedAt?: string;
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
  format?: string;
  tags: string[];
  status: 'active' | 'verified' | 'outdated';
  /** 'agent'（Agent 产出物，默认）| 'knowledge'（知识库文档） */
  source?: 'agent' | 'knowledge';
  /** 归属知识库根路径（source='knowledge' 时有效） */
  knowledgeRoot?: string | null;
  /** 扫描抽取的文本内容，供全文搜索 */
  content?: string | null;
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
  // 分享到 Hub 的字段（可空，向后兼容；见 DeliverableShare 设计文档）
  hubShareId?: string | null;
  shareStatus?: string | null;
  shareUrl?: string | null;
  shareVisibility?: string | null;
  /** 拒绝原因（Hub 拒绝时回填；客户端「已拒绝」徽标展示） */
  shareReason?: string | null;
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
    totalCu?: number;
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

export class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

const _dedupCache = new Map<string, { promise: Promise<unknown>; ts: number }>();
const DEDUP_TTL_MS = 3000;

export function invalidateApiCache(pathPrefix?: string) {
  if (!pathPrefix) { _dedupCache.clear(); return; }
  for (const key of _dedupCache.keys()) {
    if (key.startsWith(pathPrefix)) _dedupCache.delete(key);
  }
}

// ── Model Routing Types ──────────────────────────────────────────────────

export type ModelTier = 'base' | 'pro' | 'max';
export type ModelCapabilityTypeDTO =
  | 'text'
  | 'image_recognition' | 'image_generation' | 'audio_tts' | 'audio_stt'
  | 'video_generation';

export interface CapabilityModelAssignmentDTO {
  provider: string;
  model: string;
  fallback?: { provider: string; model: string };
}

export interface CapabilityRoutingConfigDTO {
  assignments: Partial<Record<ModelCapabilityTypeDTO, CapabilityModelAssignmentDTO>>;
}

// ── Model Catalog Types ───────────────────────────────────────────────────

export interface CatalogModelCapabilities {
  vision: boolean;
  functionCalling: boolean;
  reasoning: boolean;
  promptCaching: boolean;
  webSearch: boolean;
  audioInput: boolean;
  audioOutput: boolean;
}

export interface CatalogModel {
  id: string;
  provider: string;
  mode: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  inputCostPer1MTokens: number;
  outputCostPer1MTokens: number;
  cacheReadCostPer1MTokens?: number;
  cacheWriteCostPer1MTokens?: number;
  capabilities: CatalogModelCapabilities;
  deprecationDate?: string;
  tier?: ModelTier;
}

export interface CatalogStatus {
  totalModels: number;
  chatModels: number;
  providers: string[];
  lastUpdated: string | null;
  source: 'cache' | 'remote' | 'baseline' | 'supplements';
}

export interface ValidateKeyResponse {
  valid: boolean;
  error?: string;
  models: CatalogModel[];
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const method = opts?.method?.toUpperCase() ?? 'GET';
  const isGet = method === 'GET' && !opts?.body;
  if (isGet) {
    const cached = _dedupCache.get(path);
    if (cached && Date.now() - cached.ts < DEDUP_TTL_MS) return cached.promise as Promise<T>;
  } else {
    const basePath = path.replace(/\/[^/]+$/, '');
    for (const key of _dedupCache.keys()) {
      if (key === path || key.startsWith(basePath)) _dedupCache.delete(key);
    }
  }

  const promise = (async () => {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...opts,
      body: opts?.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
    });
    if (!res.ok) {
      let detail = '';
      let code: string | undefined;
      try {
        const body = await res.json() as { error?: string; message?: string; code?: string };
        detail = body.error ?? body.message ?? '';
        code = body.code;
      } catch { /* ignore parse failures */ }
      throw new ApiError(detail || `API error: ${res.status}`, code);
    }
    return res.json() as Promise<T>;
  })();

  if (isGet) {
    _dedupCache.set(path, { promise, ts: Date.now() });
    promise.catch(() => _dedupCache.delete(path));
  }
  return promise;
}

export interface RemotePeerInfo {
  peerId: string;
  transport: 'p2p' | 'relay' | 'connecting';
  connectedAt: number;
  lastActiveAt: number;
}

interface SearchKeyStatusEntry { configured: boolean; preview: string; enabled: boolean }

export interface SearchSettingsStatus {
  serper: SearchKeyStatusEntry;
  tavily: SearchKeyStatusEntry;
  bing: SearchKeyStatusEntry;
  google: SearchKeyStatusEntry;
  serpapi: SearchKeyStatusEntry;
  brave: SearchKeyStatusEntry;
  exa: SearchKeyStatusEntry;
  bocha: SearchKeyStatusEntry;
  markus: {
    available: boolean;
    enabled: boolean;
    /** Hosted search backend label (OpenRouter). */
    searchProvider?: string;
    markusProvider?: string;
    /** OpenRouter model id used for hosted retrieval (e.g. perplexity/sonar). */
    markusSearchModel?: string;
    language?: string;
  };
}

export interface RemoteStatus {
  enabled: boolean;
  connected: boolean;
  state: 'idle' | 'registering' | 'connecting' | 'connected' | 'disconnected';
  instanceId: string | null;
  remoteUrl: string | null;
  signalUrl: string | null;
  peerCount: number;
  peers: RemotePeerInfo[];
}

export type CodingToolName = 'claude-code' | 'codex' | 'cursor-agent';

export interface CodingToolConfigDTO {
  tool: CodingToolName;
  enabled?: boolean;
  binaryPath?: string;
  defaultArgs?: string[];
  timeoutMs?: number;
  defaultModel?: string;
  maxBudgetPerSessionUsd?: number;
  approvalRequired?: boolean;
  env?: Record<string, string>;
}

export interface CodingToolModelDTO {
  id: string;
  name: string;
  isDefault?: boolean;
}

export interface CodingToolModelsResponse {
  tool: string;
  models: CodingToolModelDTO[];
  source?: 'api' | 'cli' | 'static';
  hint?: string;
  error?: string;
}

export interface CodingToolsSettingsResponse {
  enabled: boolean;
  tools: Record<CodingToolName, CodingToolConfigDTO>;
}

export interface CodingToolDetection {
  name: CodingToolName;
  displayName: string;
  binaryName: string;
  available: boolean;
  version?: string;
  path?: string;
  installHint?: string;
  authenticated?: boolean;
  authHint?: string;
  authUser?: string;
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

/** OB-1：后端 /api/agents 在每个 agent 上派生的可读运行阶段（不改变 status 原始语义）。 */
export type AgentRuntimePhase =
  | 'idle'
  | 'thinking'
  | 'running'
  | 'waiting-dependency'
  | 'degraded'
  | 'blocked'
  | 'error'
  | 'offline';

export interface AgentRuntimeInfo {
  agentId: string;
  phase: AgentRuntimePhase;
  status: string;
  activityType?: string;
  activityLabel?: string;
  currentTaskId?: string;
  activeTaskIds: string[];
  blockingTaskIds: string[];
  /** 阻塞依赖明细：taskId + 标题 + 状态 —— 用于「卡在依赖 XX」一眼定位 */
  blockedBy: Array<{ taskId: string; title: string; status: string }>;
  startedAt?: string;
  runningMinutes?: number;
  lastHeartbeat?: string;
  lastActivityAt?: string;
  tokensUsedToday: number;
  lastError?: string;
  lastErrorAt?: string;
  /** OB-2：疑似卡死定位（stall-heartbeat / dead-dependency） */
  stall?: AgentRuntimeStall;
  /** OB-3：无真实任务却标记 processing 的遗留脏态判定（纯派生，供概览提示）。 */
  dirty?: { dirty: true; agentId: string; reason: string; criterion: 'no-live-task' | 'stale-activity' | 'no-heartbeat'; recovery: 'reconcile-idle' | 'trigger-heartbeat' | 'human-review'; suggestions: string[] } | { dirty: false; reason: string };
}

export interface AgentRuntimeStall {
  /** 是否长时间无活动 / 依赖失败阻塞 */
  stalled: boolean;
  /** 未卡死时的原因说明 */
  reason?: string;
  /** 命中判据：心跳停滞 / 依赖已死仍等待 */
  stallKind?: 'stale-heartbeat' | 'dead-dependency';
  /** 卡住的任务/依赖 id */
  stuckOnTaskId?: string;
  /** 卡住的定位标题 */
  stuckOnTitle?: string;
  /** 当前（被卡）任务 id */
  currentTaskId?: string;
  /** 最后活动时间（ISO） */
  lastActivityAt?: string;
  /** 最后活动距今分钟数 */
  lastActivityAgoMin?: number;
  /** 最近一次错误概要 */
  lastError?: string;
  /** 给前端/人工的可读定位 + 建议动作 */
  stuckReason?: string;
  suggestions?: string[];
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
  isDeliberating?: boolean;
  deliberationActivity?: {
    activityId: string;
    label: string;
    startedAt: string;
  };
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
    inlineCompletedIds?: string[];
    timestamp: string;
  };
  notebook?: Array<{
    key: string;
    text: string;
    updatedAt: number;
    managed: string;
  }>;
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
  statusCounts?: Record<string, number>;
  sourceTypeCounts?: Record<string, number>;
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
  /** True for the org-level Secretary (cannot be deleted / moved). */
  isOrgSecretary?: boolean;
  protected?: boolean;
  lastError?: string;
  lastErrorAt?: string;
  currentTaskId?: string;
  currentActivity?: AgentActivityInfo;
  /** OB-1：后端派生的可读运行阶段（phase/activityLabel/blockedBy/lastHeartbeat/…） */
  runtime?: AgentRuntimeInfo;
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
  avatarUrl?: string | null;  // teams icon from builder-artifacts or Hub
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
  reviewerId: string;
  reviewerType?: 'agent' | 'human';
  executionRound?: number;
  subtasks?: Array<{ id: string; title: string; status: string; createdAt?: string; completedAt?: string }>;
  blockedBy?: string[];
  notes?: string[];
  deliverables?: Array<{
    type: string;
    reference: string;
    summary: string;
    format?: string;
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

export interface GoalConfig {
  loopEnabled: boolean;
  completionCriteria: string;
  maxIterations: number;
  currentIteration: number;
  lastCheckedAt: string;
  autoResume: boolean;
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
  goalConfig?: GoalConfig;
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

export interface StatusTransitionInfo {
  id: number;
  fromStatus: string;
  toStatus: string;
  changedById: string | null;
  changedByType: 'human' | 'agent' | 'system';
  changedByName: string | null;
  reason: string | null;
  createdAt: string;
}

export interface AgentToolInfo {
  name: string;
  description: string;
}

export interface ScheduledWakeup {
  id: string;
  note?: string;
  wakeAt: string;
  recurringMs?: number;
  deliveryMode: 'in_session' | 'mailbox';
}

export interface PendingCallbackInfo {
  id: string;
  type: 'background_exec' | 'wakeup' | 'a2a_reply';
  label: string;
  correlationId?: string;
  registeredAt: string;
  timeoutAt: string;
}

export interface AgentHeartbeatInfo {
  running: boolean;
  uptimeMs: number;
  intervalMs: number;
  lastHeartbeat?: string;
  lastSummary?: string;
  lastSummaryAt?: string;
  nextRunAt?: string;
  /** Earliest of the next scheduled wakeup and the safety-net tick. */
  nextWakeAt?: string;
  wakeups?: ScheduledWakeup[];
  pendingCallbacks?: PendingCallbackInfo[];
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
  llmConfig: { modelMode?: 'default' | 'custom'; primary: string; defaultModel?: string; fallback?: string; maxTokensPerRequest?: number; maxTokensPerDay?: number };
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
  effectiveModel?: { provider?: string; model?: string; source: 'override' | 'custom' | 'global' };
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
  /** OB-1：后端派生的可读运行阶段（phase/activityLabel/blockedBy/…） */
  runtime?: {
    phase: AgentRuntimePhase;
    status: string;
    activityType?: string;
    activityLabel?: string;
    currentTaskId?: string;
    activeTaskIds: string[];
    blockingTaskIds: string[];
    blockedBy: Array<{ taskId: string; title: string; status: string }>;
    startedAt?: string;
    runningMinutes?: number;
    lastHeartbeat?: string;
    lastActivityAt?: string;
    tokensUsedToday: number;
    lastError?: string;
    lastErrorAt?: string;
    stall?: boolean;
    dirty?: boolean;
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
  icon?: string;
  announcements?: string;
  norms?: string;
  i18n?: Record<string, { displayName?: string; name?: string; description?: string; members?: Record<string, string> }>;
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
    stuckBlockedCount?: number;
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
  costToday: number;
  cuUsed?: number;
  cuUsedToday?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheHitRate?: number; // 0..1
  provider?: string;
}

export const api = {
  agents: {
    list: () => request<{ agents: AgentInfo[] }>('/agents').then(d => ({ ...d, agents: d.agents.filter(a => a.name) })),
    get: (id: string) => request<AgentDetail>(`/agents/${id}`),
    create: (name: string, roleName?: string, agentRole?: 'manager' | 'worker', teamId?: string) =>
      request('/agents', { method: 'POST', body: JSON.stringify({ name, ...(roleName ? { roleName } : {}), agentRole, teamId }) }),
    start: (id: string) => request(`/agents/${id}/start`, { method: 'POST' }),
    stop: (id: string) => request(`/agents/${id}/stop`, { method: 'POST' }),
    /** @deprecated Use stop() instead */
    pause: (id: string, _reason?: string) => request(`/agents/${id}/stop`, { method: 'POST' }),
    /** @deprecated Use start() instead */
    resume: (id: string) => request<{ status: string }>(`/agents/${id}/start`, { method: 'POST' }),
    cancelProcessing: (id: string) => request(`/agents/${id}/cancel-processing`, { method: 'POST' }),
    evolveFromMessage: (
      id: string,
      body: {
        parentSessionId: string;
        sourceMessageId?: string;
        sourceText?: string;
        userNote?: string;
      },
    ) =>
      request<{
        sessionId: string;
        agentId: string;
        seedPrompt: string;
        truncated: boolean;
        focusMarked: boolean;
        parentSessionId: string;
      }>(`/agents/${id}/evolve-from-message`, { method: 'POST', body: JSON.stringify(body) }),
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
    cancelWakeup: (id: string, wakeupId: string) => request<{ status: string; wakeupId: string }>(`/agents/${id}/wakeups/${wakeupId}`, { method: 'DELETE' }),
    getRecentActivities: (id: string) => request<{ activities: ActivitySummary[] }>(`/agents/${id}/recent-activities`),
    getActivityLogs: (id: string, activityId: string) =>
      request<{ logs: AgentActivityLogEntry[]; activity?: AgentActivityInfo }>(`/agents/${id}/activity-logs?activityId=${encodeURIComponent(activityId)}`),
    getActivities: (id: string, opts?: { type?: string; limit?: number; before?: string; taskId?: string }) => {
      const params = new URLSearchParams();
      if (opts?.type) params.set('type', opts.type);
      if (opts?.limit) params.set('limit', String(opts.limit));
      if (opts?.before) params.set('before', opts.before);
      if (opts?.taskId) params.set('taskId', opts.taskId);
      const qs = params.toString();
      return request<{ activities: ActivityRecord[] }>(`/agents/${id}/activities${qs ? '?' + qs : ''}`);
    },
    getMindState: (id: string) => request<AgentMindState>(`/agents/${id}/mind`),
    sendCommand: (id: string, command: string, args?: string) =>
      request<{ status: string; command: string }>(`/agents/${id}/command`, { method: 'POST', body: JSON.stringify({ command, args }) }),
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
    messageStream: (id: string, text: string, onChunk: (chunk: string) => void, onActivity?: (event: AgentToolEvent) => void, signal?: AbortSignal, images?: string[], sessionId?: string | null, isRetry?: boolean, isResume?: boolean, onCommit?: (event: StreamCommitEvent) => void, fileNames?: string[], replyTo?: { id: string; sender: string; text: string } | null, modelOverride?: { provider: string; model: string } | null): Promise<{ content: string; sessionId?: string; segments?: StoredSegment[]; merged?: boolean; cancelled?: boolean; emptyReply?: boolean }> => {
      return new Promise(async (resolve, reject) => {
        let fullContent = '';
        let resultSessionId: string | undefined;
        let resultSegments: StoredSegment[] | undefined;
        let watchdog: ReturnType<typeof createStreamWatchdog> | null = null;
        try {
          const res = await fetch(`${BASE}/agents/${id}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              text,
              stream: true,
              images,
              fileNames,
              sessionId: sessionId ?? undefined,
              isRetry: isRetry || undefined,
              isResume: isResume || undefined,
              replyTo: replyTo || undefined,
              ...(modelOverride?.provider && modelOverride?.model
                ? { provider: modelOverride.provider, model: modelOverride.model }
                : {}),
            }),
            signal,
          });
          if (!res.ok) { reject(new Error(`API error: ${res.status}`)); return; }
          const reader = res.body?.getReader();
          if (!reader) { reject(new Error('No reader')); return; }
          const decoder = new TextDecoder();
          let buffer = '';
          // 空转看门狗：若连接真正死亡（服务端每 15s 发 heartbeat，此处 60s 无任何数据），
          // 取消 reader 并优雅降级返回，避免「永久思考中」。见 lib/streamResilience.ts。
          if (signal) {
            watchdog = createStreamWatchdog({
              signal,
              onStall: () => {
                reader.cancel().catch(() => {});
              },
            });
          }
          while (true) {
            const { done, value } = await reader.read();
            watchdog?.bump();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              try {
                const event = JSON.parse(trimmed.slice(6)) as { type: string; text?: string; content?: string; thinking?: string; tool?: string; phase?: 'start' | 'end'; success?: boolean; arguments?: unknown; result?: string; error?: string; durationMs?: number; toolCall?: { id?: string; name?: string }; sessionId?: string };
                if (event.type === 'session_start' && event.sessionId) {
                  resultSessionId = event.sessionId;
                  const userMessageId = (event as { userMessageId?: string }).userMessageId;
                  onCommit?.({
                    type: 'session_start',
                    content: '',
                    createdAt: new Date().toISOString(),
                    sessionId: event.sessionId,
                    userMessageId,
                  });
                } else if (event.type === 'text_delta' && event.text) {
                  fullContent += event.text;
                  onChunk(event.text);
                } else if (event.type === 'thinking_delta' && event.thinking) {
                  onChunk?.(`<think>${event.thinking}</think>`);
                } else if (event.type === 'done') {
                  fullContent = event.content || fullContent;
                  if (event.sessionId) resultSessionId = event.sessionId;
                  const doneSegments = (event as Record<string, unknown>).segments as StoredSegment[] | undefined;
                  // Keep empty arrays too — distinguishes a real terminal `done` from soft disconnect.
                  if (doneSegments) resultSegments = doneSegments;
                  const merged = !!(event as Record<string, unknown>).merged;
                  const cancelled = !!(event as Record<string, unknown>).cancelled;
                  const emptyReply = !!(event as Record<string, unknown>).emptyReply;
                  resolve({
                    content: fullContent,
                    sessionId: resultSessionId,
                    segments: resultSegments,
                    merged,
                    cancelled,
                    emptyReply,
                  });
                  reader.cancel().catch(() => {});
                  watchdog?.stop();
                  return;
                } else if (event.type === 'error') {
                  const errEvent = event as { type: string; message?: string; error?: string; sessionId?: string };
                  if (errEvent.sessionId) resultSessionId = errEvent.sessionId;
                  const err = new Error(errEvent.message ?? errEvent.error ?? 'Unknown stream error');
                  (err as Error & { sessionId?: string }).sessionId = errEvent.sessionId;
                  reject(err);
                  reader.cancel().catch(() => {});
                  watchdog?.stop();
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
                } else if (event.type === 'heartbeat') {
                  onActivity?.({ tool: '', phase: 'heartbeat' });
                }
              } catch { /* skip */ }
            }
          }
          watchdog?.stop();
          resolve({ content: fullContent, sessionId: resultSessionId, segments: resultSegments });
        } catch (err) {
          watchdog?.stop();
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
    /** @deprecated Use stopAll() instead */
    pauseAll: (teamId: string, _reason?: string) =>
      request<{ success: string[]; failed: Array<{ id: string; error: string }> }>(`/teams/${teamId}/stop`, { method: 'POST' }),
    /** @deprecated Use startAll() instead */
    resumeAll: (teamId: string) =>
      request<{ success: string[]; failed: Array<{ id: string; error: string }> }>(`/teams/${teamId}/start`, { method: 'POST' }),
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
    create: (title: string, description: string, assignedAgentId: string, reviewerId: string, priority?: string, projectId?: string, blockedBy?: string[], requirementId?: string, taskType?: string, scheduleConfig?: { every?: string; cron?: string }, reviewerType?: 'agent' | 'human') =>
      request<{ task: TaskInfo }>('/tasks', { method: 'POST', body: JSON.stringify({ title, description, assignedAgentId, reviewerId, priority, projectId, blockedBy, requirementId, taskType, scheduleConfig, reviewerType }) }),
    update: (id: string, data: { title?: string; description?: string; priority?: string; projectId?: string | null; requirementId?: string | null; blockedBy?: string[]; reviewerId?: string; reviewerType?: 'agent' | 'human' }) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    updateStatus: (id: string, status: string) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status }) }),
    assign: (id: string, agentId: string | null) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ assignedAgentId: agentId }) }),
    approve: (id: string, runNow?: boolean) => request<{ task: TaskInfo }>(`/tasks/${id}/approve`, { method: 'POST', body: JSON.stringify({ runNow: runNow ?? undefined }) }),
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
    accept: (id: string, reviewerId?: string) => request<{ task: TaskInfo }>(`/tasks/${id}/accept`, { method: 'POST', body: JSON.stringify({ reviewerId: reviewerId ?? 'human' }) }),
    revision: (id: string, reason: string, reviewerId?: string) => request<{ task: TaskInfo }>(`/tasks/${id}/revision`, { method: 'POST', body: JSON.stringify({ reason, reviewerId: reviewerId ?? 'human' }) }),
    archive: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}/archive`, { method: 'POST' }),
    pause: (id: string) => request<{ status: string; taskId: string }>(`/tasks/${id}/pause`, { method: 'POST' }),
    resume: (id: string) => request<{ status: string; taskId: string }>(`/tasks/${id}/resume`, { method: 'POST' }),
    retry: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}/retry`, { method: 'POST' }),
    getComments: (id: string) => request<{ comments: TaskComment[] }>(`/tasks/${id}/comments`),
    getHistory: (id: string) => request<{ history: StatusTransitionInfo[] }>(`/tasks/${id}/history`),
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
      request<{
        type: string;
        name: string;
        content?: string;
        mimeType?: string;
        path?: string;
        size?: number;
        streamUrl?: string;
        extension?: string;
        format?: string;
      }>(`/files/preview?path=${encodeURIComponent(filePath)}`),
    streamUrl: (filePath: string) =>
      `${BASE}/files/stream?path=${encodeURIComponent(filePath)}`,
    reveal: (filePath: string) =>
      request<{ ok: boolean; path: string }>('/files/reveal', { method: 'POST', body: JSON.stringify({ path: filePath }) }),
    check: (paths: string[]) =>
      request<{ results: Record<string, { exists: boolean; isFile: boolean; type: string }> }>('/files/check', { method: 'POST', body: JSON.stringify({ paths }) }),
    write: (filePath: string, content: string) =>
      request<{ ok: boolean; path: string }>('/files/write', { method: 'POST', body: JSON.stringify({ path: filePath, content }) }),
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
    getHistory: (id: string) => request<{ history: StatusTransitionInfo[] }>(`/requirements/${id}/history`),
    addComment: (id: string, content: string, authorName?: string, attachments?: Array<{ type: string; url: string; name: string }>, authorId?: string, mentions?: string[], replyTo?: string) =>
      request<{ comment: RequirementComment }>(`/requirements/${id}/comments`, { method: 'POST', body: JSON.stringify({ content, authorId: authorId ?? 'human', authorName: authorName ?? 'User', authorType: 'human', attachments, mentions, replyTo }) }),
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
  cu: {
    status: () => request<{ available: boolean; cuCost: number; cuRemaining: number; cuLimit: number; cuUsedToday?: number; totalCuUsed?: number }>('/cu/status'),
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
  browser: {
    tabOwnership: () =>
      request<{ ownership: Array<{ pageId: number; agentId: string; agentName: string }> }>('/browser/tab-ownership'),
  },
  terminal: {
    sessionOwnership: () =>
      request<{ ownership: Array<{ terminalId: string; agentId: string; agentName: string }> }>('/terminal/session-ownership'),
  },
  settings: {
    getLlm: () => request<{ defaultProvider: string; providers: Record<string, { model: string; configured: boolean }> }>('/settings/llm'),
    /** Local preferred org name (markus.json). Applied to Hub org on connect. */
    getOrg: () => request<{ org: { id: string; name: string } }>('/settings/org'),
    updateOrg: (name: string) =>
      request<{ ok: boolean; org: { id: string; name: string } }>('/settings/org', {
        method: 'PUT',
        body: JSON.stringify({ name }),
      }),
    /** Re-fetch OpenRouter member key from Hub and configure the Markus provider. */
    syncOpenRouter: () =>
      request<{ ok: boolean; settings?: { defaultProvider: string; providers: Record<string, { model: string; configured: boolean }> } }>(
        '/settings/llm/sync-openrouter',
        { method: 'POST', body: JSON.stringify({}) },
      ),
    getRouting: () => request<{ capabilityRouting: CapabilityRoutingConfigDTO }>('/settings/llm/routing'),
    updateRouting: (data: {
      capabilityRouting?: Partial<CapabilityRoutingConfigDTO>;
      routingDefaultModel?: { provider: string; model: string } | null;
      defaultProvider?: string;
    }) =>
      request('/settings/llm', { method: 'POST', body: JSON.stringify(data) }),
    getAgent: () => request<{ maxToolIterations: number; cognitive: { enabled: boolean; maxDepth?: number; appraisalModel?: string; timeoutMs?: number } }>('/settings/agent'),
    updateAgent: (settings: { maxToolIterations?: number; cognitive?: { enabled?: boolean; maxDepth?: number; appraisalModel?: string; timeoutMs?: number } }) =>
      request<{ maxToolIterations: number; cognitive: { enabled: boolean; maxDepth?: number; appraisalModel?: string; timeoutMs?: number } }>('/settings/agent', { method: 'POST', body: JSON.stringify(settings) }),
    getBrowser: () => request<{ mode: 'embedded' | 'system-chrome'; bringToFront: boolean; remoteDebuggingPort: number; autoCloseTabs: boolean; autoClickAllowDialog: boolean; extensionBridgePort: number; extensionConnected: boolean }>('/settings/browser'),
    updateBrowser: (settings: { mode?: 'embedded' | 'system-chrome'; bringToFront?: boolean; remoteDebuggingPort?: number; autoCloseTabs?: boolean; autoClickAllowDialog?: boolean }) =>
      request<{ mode: 'embedded' | 'system-chrome'; bringToFront: boolean; remoteDebuggingPort: number; autoCloseTabs: boolean; autoClickAllowDialog: boolean; extensionBridgePort: number; extensionConnected: boolean }>('/settings/browser', { method: 'POST', body: JSON.stringify(settings) }),
    testAutoClick: () => request<{
      checkResult: { platform: string; supported: boolean; accessibilityPermission: boolean; chromeRunning: boolean; binaryAvailable: boolean };
      openedAccessibilitySettings: boolean;
      clickResult: 'success' | 'no_permission' | 'chrome_not_running' | 'unsupported' | 'error';
      pageLoaded: boolean;
      pageTitle?: string;
      error?: string;
    }>('/settings/browser/test-auto-click', { method: 'POST' }),
    downloadExtensionZip: () => {
      const url = `${BASE}/settings/browser/extension.zip`;
      const headers: Record<string, string> = {};
      const token = localStorage.getItem('markus_token');
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return fetch(url, { headers }).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      }).then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'markus-browser-extension.zip';
        a.click();
        URL.revokeObjectURL(a.href);
      });
    },
    openExtensionsPage: () => request<{ ok: boolean }>('/settings/browser/open-extensions-page', { method: 'POST' }),
    testConcurrentBrowserQuick: () => request<{
      connected: boolean;
      steps: Array<{ name: string; group: string; passed: boolean; durationMs: number; error?: string; detail?: string }>;
      totalDurationMs: number; passed: number; failed: number; summary: string;
    }>('/settings/browser/test-concurrent', { method: 'POST', body: JSON.stringify({ mode: 'quick' }) }),
    testConcurrentBrowserChaos: async (
      opts: { durationSec?: number; agents?: number },
      onEvent: (ev: { type: string; [k: string]: unknown }) => void,
    ): Promise<void> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = localStorage.getItem('markus_token');
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${BASE}/settings/browser/test-concurrent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'chaos', durationSec: opts.durationSec ?? 120, agents: opts.agents ?? 3 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); }
          else if (line.startsWith('data: ')) {
            try { onEvent({ type: currentEvent || 'unknown', ...JSON.parse(line.slice(6)) }); } catch { /* skip */ }
            currentEvent = '';
          }
        }
      }
    },
    stopConcurrentBrowserTest: () => request<{ ok: boolean }>('/settings/browser/test-concurrent', { method: 'DELETE' }),
    getSearch: () => request<SearchSettingsStatus>('/settings/search'),
    updateSearch: (keys: { serperApiKey?: string; tavilyApiKey?: string; bingApiKey?: string; googleSearchApiKey?: string; googleSearchCx?: string; serpApiKey?: string; braveApiKey?: string; exaApiKey?: string; bochaApiKey?: string; useMarkusHosted?: boolean; markusSearchModel?: string; serperEnabled?: boolean; tavilyEnabled?: boolean; bingEnabled?: boolean; googleEnabled?: boolean; serpapiEnabled?: boolean; braveEnabled?: boolean; exaEnabled?: boolean; bochaEnabled?: boolean; language?: string }) =>
      request<SearchSettingsStatus>('/settings/search', { method: 'POST', body: JSON.stringify(keys) }),
    testSearch: (provider: string, extra?: { apiKey?: string; cx?: string }) =>
      request<{ ok: boolean; latencyMs?: number; count?: number; sample?: { title: string; url: string }; error?: string }>(
        '/settings/search/test',
        { method: 'POST', body: JSON.stringify({ provider, ...extra }) },
      ),
    getRemote: () => request<RemoteStatus>('/settings/remote'),
    enableRemote: () => request<{ ok: boolean; status: RemoteStatus }>('/settings/remote/enable', { method: 'POST' }),
    disableRemote: () => request<{ ok: boolean }>('/settings/remote/disable', { method: 'POST' }),
    getFeishuIntegration: () => request<{
      appId?: string; appSecret?: string;
      enabled: boolean; connected: boolean;
      notifyChatId?: string;
      notifyOnApproval: boolean; notifyOnNotification: boolean; notifyPriority: string[];
    }>('/settings/integrations/feishu'),
    saveFeishuIntegration: (config: {
      appId: string; appSecret: string; enabled?: boolean;
      notifyChatId?: string;
      notifyOnApproval?: boolean; notifyOnNotification?: boolean; notifyPriority?: string[];
    }) => request<{
      appId?: string; connected: boolean; enabled: boolean;
    }>('/settings/integrations/feishu', { method: 'POST', body: JSON.stringify(config) }),
    testFeishuConnection: (creds: { appId: string; appSecret: string }) =>
      request<{ success: boolean; message?: string }>('/settings/integrations/feishu/test', { method: 'POST', body: JSON.stringify(creds) }),
    sendFeishuTestMessage: (data: { chatId: string }) =>
      request<{ success: boolean; message?: string }>('/settings/integrations/feishu/test-message', { method: 'POST', body: JSON.stringify(data) }),
    deleteFeishuIntegration: () => request<{ ok: boolean }>('/settings/integrations/feishu', { method: 'DELETE' }),
    listFeishuChats: () =>
      request<{ chats: Array<{ chatId: string; name: string; description?: string; avatar?: string }>; error?: string }>('/settings/integrations/feishu/chats'),
    registerFeishuApp: () =>
      request<{ success: boolean; appId?: string; connected?: boolean; userInfo?: { open_id?: string; tenant_brand?: string }; error?: string; message?: string }>('/settings/integrations/feishu/register', { method: 'POST' }),
    getFeishuRegisterStatus: () =>
      request<{ active: boolean; url?: string; expireIn?: number; status?: string; elapsed?: number }>('/settings/integrations/feishu/register/status'),
    getCodingTools: () => request<CodingToolsSettingsResponse>('/settings/coding-tools'),
    updateCodingTools: (data: { enabled?: boolean; tools?: Partial<Record<CodingToolName, CodingToolConfigDTO>> }) =>
      request<CodingToolsSettingsResponse>('/settings/coding-tools', { method: 'POST', body: JSON.stringify(data) }),
    detectCodingTools: () => request<{ tools: CodingToolDetection[] }>('/settings/coding-tools/detect'),
    detectCodingTool: (tool: CodingToolName) => request<CodingToolDetection>(`/settings/coding-tools/detect/${tool}`),
    authCodingTool: (tool: CodingToolName, method: 'cli_login' | 'api_key', apiKey?: string) =>
      request<{ success: boolean; method: string; authenticated?: boolean; error?: string; envVar?: string; output?: string }>(
        `/settings/coding-tools/${tool}/auth`,
        { method: 'POST', body: JSON.stringify({ method, apiKey }) },
      ),
    listCodingToolModels: (tool: CodingToolName) =>
      request<CodingToolModelsResponse>(`/settings/coding-tools/${tool}/models`),
    testCodingTool: (tool: CodingToolName) =>
      request<{ success: boolean; apiKeySource?: string | null; model?: string | null; detail?: string; error?: string; output?: string }>(
        `/settings/coding-tools/${tool}/test`,
        { method: 'POST' },
      ),
  },
  modelCatalog: {
    getByProvider: (provider: string) => request<{ provider: string; models: CatalogModel[] }>(`/models/catalog/${provider}`),
    getLive: (provider: string) => request<{ provider: string; models: CatalogModel[]; source: string }>(`/models/live/${provider}`),
    getAll: (provider?: string) => {
      const qs = provider ? `?provider=${provider}` : '';
      return request<{ models?: CatalogModel[]; providers?: Record<string, CatalogModel[]> }>(`/models/catalog${qs}`);
    },
    getStatus: () => request<CatalogStatus>('/models/catalog/status'),
    refresh: () => request<{ success: boolean; status: CatalogStatus }>('/models/catalog/refresh', { method: 'POST' }),
    validateKey: (provider: string, apiKey: string, baseUrl?: string) =>
      request<ValidateKeyResponse>('/models/validate-key', {
        method: 'POST',
        body: JSON.stringify({ provider, apiKey, baseUrl }),
      }),
  },
  skills: {
    list: () => request<{ skills: Array<{ name: string; version: string; description?: string; author?: string; category?: string; tags?: string[]; tools?: Array<{ name: string; description: string }>; requiredPermissions?: string[]; type: 'builtin' | 'filesystem' | 'imported'; sourcePath?: string; agentIds: string[] }> }>('/skills'),
    builtin: () => request<{ skills: Array<{ name: string; version: string; description?: string; author?: string; category?: string; tags: string[]; hasMcpServers: boolean; hasInstructions: boolean; requiredPermissions: string[]; installed: boolean; installedVersion?: string | null; updateAvailable?: boolean; i18n?: Record<string, { displayName?: string; description?: string }> }> }>('/skills/builtin'),
    /** Builtin template skills where the local copy is older than this Markus build. */
    updates: () => request<{
      updates: Array<{
        type: 'skill';
        name: string;
        displayName?: string;
        description?: string;
        installedVersion: string;
        availableVersion: string;
        localPath: string;
      }>;
      count: number;
    }>('/skills/updates'),
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
      import: (type: 'agent' | 'team' | 'skill', name: string, files: Record<string, string>, source?: { type: string; hubItemId?: string; url?: string }, version?: string) =>
        request<{ type: string; name: string; path: string }>('/builder/artifacts/import', { method: 'POST', body: JSON.stringify({ type, name, files, source, version }) }),
      install: (type: string, name: string) =>
        request<Record<string, unknown>>(`/builder/artifacts/${type}s/${encodeURIComponent(name)}/install`, { method: 'POST' }),
      uninstall: (type: string, name: string) =>
        request<{ uninstalled: boolean; removedAgents?: string[]; removedTeamId?: string }>(`/builder/artifacts/${type}s/${encodeURIComponent(name)}/uninstall`, { method: 'POST' }),
      delete: (type: string, name: string) =>
        request<{ deleted: boolean }>(`/builder/artifacts/${type}s/${encodeURIComponent(name)}`, { method: 'DELETE' }),
      /** Auto-convert legacy Chinese / invalid folder names to a valid English kebab-case slug. */
      ensureSlug: (type: string, name: string) =>
        request<{
          converted: boolean;
          type: string;
          previousName?: string;
          name: string;
          slug: string;
          displayName?: string;
          path: string;
        }>(`/builder/artifacts/${type}s/${encodeURIComponent(name)}/ensure-slug`, { method: 'POST' }),
      /**
       * Prefer a no-op when the folder name is already a valid slug (avoids depending on
       * a newly added ensure-slug route). Falls back to local slug if the API is missing.
       */
      ensureSlugSafe: async (type: string, name: string, displayName?: string) => {
        const local = toPackageSlug(name);
        if (local && local === name) {
          return { converted: false as const, type, name, slug: local, displayName, path: '' };
        }
        try {
          return await api.builder.artifacts.ensureSlug(type, name);
        } catch (err) {
          if (local) {
            return { converted: false as const, type, name: local, slug: local, displayName, path: '' };
          }
          throw err;
        }
      },
      installed: () =>
        request<{ installed: Record<string, { agentId?: string; agentIds?: string[]; teamId?: string }> }>('/builder/artifacts/installed'),
    },
  },
  auth: {
    status: () => request<{ initialized: boolean; hasOwner: boolean; hasMultipleUsers: boolean }>('/auth/status'),
    init: (name: string, email: string, password: string) =>
      request<{ user: AuthUser; needsOnboarding?: boolean }>('/auth/init', { method: 'POST', body: JSON.stringify({ name, email, password }) }),
    login: (email: string, password: string) =>
      request<{ user: AuthUser; needsOnboarding?: boolean }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    hubLogin: (hubToken: string, hubUser: { id: string; username: string; email?: string; displayName?: string; avatarUrl?: string }) =>
      request<{ user: AuthUser; needsOnboarding?: boolean; cloudAiReady?: boolean; cloudAiError?: string }>(
        '/auth/hub-login',
        { method: 'POST', body: JSON.stringify({ hubToken, hubUser }) },
      ),
    logout: () => request('/auth/logout', { method: 'POST' }),
    me: () => request<{ user: AuthUser }>('/auth/me'),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<{ ok: boolean }>('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
    updateProfile: (name: string, email: string) =>
      request<{ user: AuthUser }>('/auth/profile', { method: 'PUT', body: JSON.stringify({ name, email }) }),
    updatePreferences: (prefs: { locale?: string; timezone?: string }) =>
      request<{ ok: boolean; preferences: { locale?: string; timezone?: string } }>('/auth/me/preferences', { method: 'PUT', body: JSON.stringify(prefs) }),
    setup: (token: string, password: string) =>
      request<{ ok: boolean; email: string }>('/auth/setup', { method: 'POST', body: JSON.stringify({ token, password }) }),
    inviteInfo: (token: string) =>
      request<{ name: string; email: string }>(`/auth/invite-info?token=${encodeURIComponent(token)}`),
    uploadAvatar: (image: string, type: 'user' | 'agent' = 'user', id?: string) =>
      request<{ avatarUrl: string }>('/avatars/upload', { method: 'POST', body: JSON.stringify({ image, type, id }) }),
  },
  license: {
    get: () => request<{ plan: string; licenseKey?: string; validUntil?: string; isTrial?: boolean; isOffline?: boolean; features: string[]; limits: { maxAgents: number; maxTeams: number; maxToolCallsPerDay: number; maxUsers: number }; usage?: { agents: number; teams: number; toolCallsToday: number; users: number }; instanceId: string; hubUserId?: string; username?: string; orgId?: string; orgName?: string; maxSeats?: number; usedSeats?: number }>('/license'),
    refresh: () => request<{ plan: string; licenseKey?: string; validUntil?: string; isTrial?: boolean; isOffline?: boolean; features: string[]; limits: { maxAgents: number; maxTeams: number; maxToolCallsPerDay: number; maxUsers: number }; usage?: { agents: number; teams: number; toolCallsToday: number; users: number }; instanceId: string; hubUserId?: string; username?: string; orgId?: string; orgName?: string; maxSeats?: number; usedSeats?: number }>('/license/refresh', { method: 'POST' }),
    activate: (licenseKey: string) =>
      request<{ success: boolean; error?: string }>('/license/activate', { method: 'POST', body: JSON.stringify({ licenseKey }) }),
    trial: () =>
      request<{ success: boolean; error?: string }>('/license/trial', { method: 'POST' }),
  },
  sessions: {
    hasAny: () =>
      request<{ hasAny: boolean }>('/sessions/has-any'),
    listByAgent: (agentId: string, limit = 20) =>
      request<{ sessions: ChatSessionInfo[] }>(`/agents/${agentId}/sessions?limit=${limit}`),
    getMessages: (sessionId: string, limit = 50, before?: string) =>
      request<{ messages: ChatMessageInfo[]; hasMore: boolean }>(
        `/sessions/${sessionId}/messages?limit=${limit}${before ? `&before=${before}` : ''}`
      ),
    delete: (sessionId: string) => request(`/sessions/${sessionId}`, { method: 'DELETE' }),
    setModelOverride: (sessionId: string, override: { provider: string; model: string } | null) =>
      request<{ modelOverride: { provider: string; model: string } | null }>(
        `/sessions/${sessionId}/model-override`,
        {
          method: 'PUT',
          body: JSON.stringify(override ?? { provider: '', model: '' }),
        },
      ),
    streamStatus: (agentId: string, sessionId: string) =>
      request<{ active: boolean; streamId?: string; messageId?: string; lastSeq?: number; status?: string }>(
        `/agents/${agentId}/sessions/${sessionId}/stream/status`,
      ),
    /**
     * Reattach to an in-flight generation after page refresh.
     * Resolves on done/error; 204 means nothing active.
     */
    reattachStream: (
      agentId: string,
      sessionId: string,
      handlers: {
        onChunk?: (chunk: string) => void;
        onActivity?: (event: AgentToolEvent) => void;
        onCommit?: (event: StreamCommitEvent) => void;
        onSnapshot?: (snapshot: { content: string; segments: StoredSegment[] }) => void;
      },
      signal?: AbortSignal,
      afterSeq = 0,
    ): Promise<{ content: string; sessionId?: string; segments?: StoredSegment[]; attached: boolean }> => {
      return new Promise(async (resolve, reject) => {
        let fullContent = '';
        let resultSessionId: string | undefined = sessionId;
        let resultSegments: StoredSegment[] | undefined;
        let watchdog: ReturnType<typeof createStreamWatchdog> | null = null;
        try {
          const res = await fetch(
            `${BASE}/agents/${agentId}/sessions/${sessionId}/stream?afterSeq=${afterSeq}`,
            { method: 'GET', credentials: 'include', signal },
          );
          if (res.status === 204) {
            resolve({ content: '', sessionId, attached: false });
            return;
          }
          if (!res.ok) {
            reject(new Error(`API error: ${res.status}`));
            return;
          }
          const reader = res.body?.getReader();
          if (!reader) {
            reject(new Error('No reader'));
            return;
          }
          const decoder = new TextDecoder();
          let buffer = '';
          // 空转看门狗：重连时若连接再次死亡（无任何数据 60s），取消 reader，
          // 结束本次 attach（调用方据此清掉「思考中」），避免永久挂起。见 lib/streamResilience.ts。
          if (signal) {
            watchdog = createStreamWatchdog({
              signal,
              onStall: () => {
                reader.cancel().catch(() => {});
              },
            });
          }
          while (true) {
            const { done, value } = await reader.read();
            watchdog?.bump();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              try {
                const event = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
                const type = event.type as string;
                if (type === 'snapshot') {
                  const snapSegs = (event.segments as StoredSegment[] | undefined) ?? [];
                  const snapContent = typeof event.content === 'string' ? event.content : '';
                  fullContent = snapContent;
                  if (snapSegs.length) resultSegments = snapSegs;
                  handlers.onSnapshot?.({ content: snapContent, segments: snapSegs });
                } else if (type === 'text_delta' && typeof event.text === 'string') {
                  // Snapshot attach skips historical ring events; these are live deltas.
                  fullContent += event.text;
                  handlers.onChunk?.(event.text);
                } else if (type === 'thinking_delta' && typeof event.thinking === 'string') {
                  handlers.onChunk?.(`<think>${event.thinking}</think>`);
                } else if (type === 'done') {
                  fullContent = (event.content as string) || fullContent;
                  if (typeof event.sessionId === 'string') resultSessionId = event.sessionId;
                  const doneSegments = event.segments as StoredSegment[] | undefined;
                  if (doneSegments) resultSegments = doneSegments;
                  resolve({ content: fullContent, sessionId: resultSessionId, segments: resultSegments, attached: true });
                  reader.cancel().catch(() => {});
                  watchdog?.stop();
                  return;
                } else if (type === 'error') {
                  reject(new Error((event.message as string) ?? (event.error as string) ?? 'Stream error'));
                  reader.cancel().catch(() => {});
                  watchdog?.stop();
                  return;
                } else if (type === 'thinking_commit' && typeof event.thinking === 'string') {
                  handlers.onCommit?.({ type: 'thinking_commit', content: event.thinking, createdAt: (event.createdAt as string) ?? new Date().toISOString() });
                } else if (type === 'text_commit' && typeof event.text === 'string') {
                  handlers.onCommit?.({ type: 'text_commit', content: event.text, createdAt: (event.createdAt as string) ?? new Date().toISOString() });
                } else if (type === 'agent_tool' && event.tool && event.phase) {
                  if (event.phase === 'start') {
                    handlers.onActivity?.({ tool: event.tool as string, phase: 'start', arguments: event.arguments });
                  } else if (event.phase === 'end') {
                    handlers.onActivity?.({
                      tool: event.tool as string,
                      phase: 'end',
                      success: event.success as boolean | undefined,
                      arguments: event.arguments,
                      result: event.result as string | undefined,
                      error: event.error as string | undefined,
                      durationMs: event.durationMs as number | undefined,
                    });
                  }
                } else if (type === 'subagent_progress' && event.tool) {
                  handlers.onActivity?.({
                    tool: event.tool as string,
                    phase: 'subagent_progress',
                    subagentEvent: event.subagentEvent as SubagentProgressEvent,
                  });
                } else if (type === 'heartbeat') {
                  handlers.onActivity?.({ tool: '', phase: 'heartbeat' });
                }
              } catch { /* skip */ }
            }
          }
          // Stream ended without a terminal done/error (e.g. server closed early).
          watchdog?.stop();
          resolve({ content: fullContent, sessionId: resultSessionId, segments: resultSegments, attached: true });
        } catch (err) {
          watchdog?.stop();
          // Abort is not a successful attach — caller must not finalize the turn.
          reject(err);
        }
      });
    },
  },
  channels: {
    getMessages: (channel: string, limit = 50, before?: string) =>
      request<{ messages: ChannelMessageInfo[]; hasMore: boolean }>(
        `/channels/${encodeURIComponent(channel)}/messages?limit=${limit}${before ? `&before=${before}` : ''}`
      ),
    sendMessage: (channel: string, data: { text: string; senderId?: string; senderName?: string; mentions?: string[]; targetAgentId?: string; orgId?: string; humanOnly?: boolean; replyToId?: string; images?: string[]; fileNames?: string[] }) =>
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
    respond: (id: string, approved: boolean, respondedBy?: string, comment?: string, selectedOption?: string, answers?: UserInputAnswer[]) =>
      request<{ approval: ApprovalInfo }>(`/approvals/${id}`, { method: 'POST', body: JSON.stringify({ approved, respondedBy, comment, selectedOption, answers }) }),
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
    create: (opts: { title: string; body: string; type?: string; priority?: string; metadata?: Record<string, unknown> }) =>
      request<{ notification: NotificationInfo }>('/notifications', { method: 'POST', body: JSON.stringify(opts) }),
    markRead: (id: string) => request<{ success: boolean }>(`/notifications/${id}`, { method: 'POST' }),
    markAllRead: (userId: string) => request<{ success: boolean; count: number }>('/notifications/mark-all-read', { method: 'POST', body: JSON.stringify({ userId }) }),
  },

  // ─── Unread Tracking ───────────────────────────────────────────────
  unread: {
    getCounts: () => request<{ counts: Record<string, number>; sessionAgentMap: Record<string, string> }>('/unread'),
    markRead: (conversationKey: string, lastReadAt: string, lastReadId?: string) =>
      request<{ success: boolean }>('/unread/mark-read', { method: 'POST', body: JSON.stringify({ conversationKey, lastReadAt, lastReadId }) }),
    markAllRead: () =>
      request<{ success: boolean }>('/unread/mark-all-read', { method: 'POST' }),
  },

  // ─── Message Search ───────────────────────────────────────────────
  messages: {
    search: (query: string, opts?: { scope?: 'all' | 'channel' | 'direct'; channel?: string; limit?: number }) => {
      const params = new URLSearchParams({ q: query });
      if (opts?.scope) params.set('scope', opts.scope);
      if (opts?.channel) params.set('channel', opts.channel);
      if (opts?.limit) params.set('limit', String(opts.limit));
      return request<{ results: SearchResult[] }>(`/messages/search?${params}`);
    },
  },

  // ─── Activity Feed ────────────────────────────────────────────────
  activity: {
    list: (opts?: { limit?: number; type?: string }) => {
      const params = new URLSearchParams();
      if (opts?.limit) params.set('limit', String(opts.limit));
      if (opts?.type) params.set('type', opts.type);
      const qs = params.toString();
      return request<{ items: { id: string; type: string; title: string; body: string; timestamp: string; source: string; metadata?: Record<string, unknown> }[]; totalCount: number }>(`/activity${qs ? `?${qs}` : ''}`);
    },
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
    syncKnowledge: (id: string, knowledgeRoots?: string[]) =>
      request<{ projectId: string; roots: string[]; scanned: number; registered: number; updated: number; outdated: number; errors: string[] }>(`/projects/${id}/knowledge/sync`, { method: 'POST', body: JSON.stringify({ knowledgeRoots }) }),

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
    search: (opts?: { q?: string; projectId?: string; agentId?: string; taskId?: string; type?: string; status?: string; artifactType?: string; source?: 'agent' | 'knowledge'; offset?: number; limit?: number }) => {
      const params = new URLSearchParams();
      if (opts?.q) params.set('q', opts.q);
      if (opts?.projectId) params.set('projectId', opts.projectId);
      if (opts?.agentId) params.set('agentId', opts.agentId);
      if (opts?.taskId) params.set('taskId', opts.taskId);
      if (opts?.type) params.set('type', opts.type);
      if (opts?.status) params.set('status', opts.status);
      if (opts?.artifactType) params.set('artifactType', opts.artifactType);
      if (opts?.source) params.set('source', opts.source);
      if (opts?.offset) params.set('offset', String(opts.offset));
      if (opts?.limit) params.set('limit', String(opts.limit));
      return request<{ results: DeliverableInfo[]; total: number }>(`/deliverables?${params}`);
    },
    get: (id: string) =>
      request<{ deliverable: DeliverableInfo }>(`/deliverables/${id}`),
    create: (data: Partial<DeliverableInfo>) =>
      request<{ deliverable: DeliverableInfo }>('/deliverables', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<DeliverableInfo>) =>
      request<{ deliverable: DeliverableInfo }>(`/deliverables/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id: string) =>
      request<{ status: string }>(`/deliverables/${id}`, { method: 'DELETE' }),
    verify: (id: string) =>
      request<{ deliverable: DeliverableInfo }>(`/deliverables/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'verified' }) }),
    checkHealth: (agentId?: string) => {
      const params = new URLSearchParams();
      if (agentId) params.set('agentId', agentId);
      return request<{ missingFiles: string[] }>(`/deliverables/health?${params}`);
    },
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
  uploads: {
    /**
     * Upload files (base64 data URLs) to the server.
     * Returns server-managed URLs that can be used as attachment references.
     */
    upload: (files: Array<{ dataUrl: string; name: string }>, prefix?: string) =>
      request<{ files: Array<{ url: string; key: string; name: string }> }>('/uploads', {
        method: 'POST',
        body: JSON.stringify({ files, prefix }),
      }),
  },
  hubOrgs: {
    mine: () => hubRequest<{ orgs: Array<{ id: string; name: string; slug: string; role: string; memberCount: number; license: { id: string; plan: string; status: string; validUntil: string; maxSeats: number | null; isTrial?: boolean } | null }> }>('/orgs/mine'),
    get: (id: string) => hubRequest<{ org: { id: string; name: string; slug: string; ownerId: string; memberCount: number; role: string } }>(`/orgs/${id}`),
    update: (id: string, data: { name?: string }) => hubRequest<{ ok: boolean }>(`/orgs/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    create: (name: string) => hubRequest<{ id: string; name: string; slug: string }>('/orgs', { method: 'POST', body: JSON.stringify({ name }) }),
    members: (id: string) => hubRequest<{ members: Array<{ id: string; userId: string; role: string; status: string; joinedAt: string; username: string; email: string | null; displayName: string | null; avatarUrl: string | null }> }>(`/orgs/${id}/members`),
    invite: (id: string, data: { username?: string; email?: string; role?: string }) => hubRequest<{ ok: boolean; method: string }>(`/orgs/${id}/members`, { method: 'POST', body: JSON.stringify(data) }),
    removeMember: (orgId: string, userId: string) => hubRequest<{ ok: boolean }>(`/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
    updateMemberRole: (orgId: string, userId: string, role: string) => hubRequest<{ ok: boolean }>(`/orgs/${orgId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    invitations: () => hubRequest<{ invitations: Array<{ orgId: string; orgName: string; invitedBy: string }> }>('/orgs/invitations'),
    acceptInvitation: (orgId: string) => hubRequest<{ ok: boolean }>(`/orgs/${orgId}/members/accept`, { method: 'POST' }),
    leave: (orgId: string) => hubRequest<{ ok: boolean }>(`/orgs/${orgId}/leave`, { method: 'POST' }),
  },
  workflows: {
    list: (teamId: string) =>
      request<{ workflows: WorkflowInfo[] }>(`/teams/${teamId}/workflows`),
    get: (teamId: string, name: string) =>
      request<{ template: WorkflowTemplateInfo }>(`/teams/${teamId}/workflows/${encodeURIComponent(name)}`),
    create: (teamId: string, name: string, yaml: string) =>
      request<{ template: { name: string; displayName?: string; description: string; version: string; stepCount: number } }>(`/teams/${teamId}/workflows`, { method: 'POST', body: JSON.stringify({ name, yaml }) }),
    update: (teamId: string, name: string, yaml: string) =>
      request<{ template: { name: string; displayName?: string; description: string; version: string } }>(`/teams/${teamId}/workflows/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ yaml }) }),
    remove: (teamId: string, name: string) =>
      request<{ ok: boolean }>(`/teams/${teamId}/workflows/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    roles: (teamId: string, name: string) =>
      request<{ roles: WorkflowRoleCandidate[] }>(`/teams/${teamId}/workflows/${encodeURIComponent(name)}/roles`),
    listRuns: (teamId: string, name: string, limit?: number) =>
      request<{ runs: WorkflowRunInfo[] }>(`/teams/${teamId}/workflows/${encodeURIComponent(name)}/runs${limit ? `?limit=${limit}` : ''}`),
    startRun: (teamId: string, name: string, projectId: string, params?: Record<string, string>, roleMapping?: Record<string, string>) =>
      request<{ run: WorkflowRunInfo }>(`/teams/${teamId}/workflows/${encodeURIComponent(name)}/runs`, { method: 'POST', body: JSON.stringify({ projectId, params, roleMapping }) }),
    getRun: (runId: string) =>
      request<{ run: WorkflowRunInfo }>(`/workflow-runs/${runId}`),
    cancelRun: (runId: string) =>
      request<{ run: WorkflowRunInfo }>(`/workflow-runs/${runId}`, { method: 'DELETE' }),
    pauseRun: (runId: string) =>
      request<{ run: WorkflowRunInfo }>(`/workflow-runs/${runId}/pause`, { method: 'POST' }),
    resumeRun: (runId: string) =>
      request<{ run: WorkflowRunInfo }>(`/workflow-runs/${runId}/resume`, { method: 'POST' }),
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  private currentUserId: string | undefined;
  private reconnectAttempts = 0;
  /** ISO timestamp of the last received event, used for message recovery after reconnection */
  lastEventTimestamp: string | null = null;

  private static BACKOFF_BASE = 1000;
  private static BACKOFF_MAX = 30000;
  private static HEARTBEAT_INTERVAL = 25000;

  connect(userId?: string): void {
    if (userId !== undefined) this.currentUserId = userId;

    if (this.ws && (
      this.ws.readyState === WebSocket.CONNECTING ||
      this.ws.readyState === WebSocket.OPEN
    )) {
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
    const params = new URLSearchParams();
    if (this.currentUserId) params.set('userId', this.currentUserId);
    if (this.lastEventTimestamp) params.set('since', this.lastEventTimestamp);
    const qs = params.toString();
    const wsUrl = `${protocol}//${window.location.host}/ws${qs ? `?${qs}` : ''}`;

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.startHeartbeat(ws);
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      try {
        const event = JSON.parse(e.data as string) as WSEvent;
        if (event.timestamp) this.lastEventTimestamp = event.timestamp;
        if (event.type === 'pong') return;
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
      this.stopHeartbeat();
      if (this.intentionalClose) return;
      const delay = Math.min(
        WSClient.BACKOFF_BASE * Math.pow(2, this.reconnectAttempts),
        WSClient.BACKOFF_MAX,
      );
      this.reconnectAttempts++;
      this.reconnectTimer = setTimeout(() => this.connect(this.currentUserId), delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, WSClient.HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
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

let HUB_URL = typeof window !== 'undefined'
  ? (window as unknown as Record<string, string>).__MARKUS_HUB_URL__ ?? 'https://markus.global'
  : 'https://markus.global';
let _hubUrlReady: Promise<void> | null = null;

// Fetch hub URL from server config (overrides default if available),
// and sync existing Hub token to backend for agent tool access.
// Skip in preview/showcase mode (no backend available).
/** Fetch Hub identity for the current token and persist it (keeps UI in sync with billing). */
async function refreshHubUserFromToken(): Promise<HubUser | null> {
  if (!getHubToken()) return null;
  try {
    const data = await hubRequest<{ user: HubUser }>('/auth/me');
    if (data?.user?.id) {
      const token = getHubToken()!;
      saveHubAuth(token, data.user);
      return data.user;
    }
  } catch { /* token invalid — validateHubSession / hubRequest clear on 401 */ }
  return getHubUser();
}

async function refreshHubUrlFromSettings(): Promise<void> {
  if ((window as unknown as Record<string, boolean>).__MARKUS_PREVIEW__) return;
  try {
    const r = await request<{ hubUrl: string }>('/settings/hub');
    if (r.hubUrl) HUB_URL = r.hubUrl;
  } catch { /* keep default */ }
}

function ensureHubUrlLoaded(): Promise<void> {
  if (!_hubUrlReady) {
    _hubUrlReady = refreshHubUrlFromSettings().finally(() => { /* keep settled promise */ });
  }
  return _hubUrlReady;
}

if (!(window as unknown as Record<string, boolean>).__MARKUS_PREVIEW__) {
  _hubUrlReady = refreshHubUrlFromSettings()
    .then(async () => {
      const existingToken = localStorage.getItem('markus_hub_token');
      if (existingToken) {
        request('/settings/hub-token', { method: 'POST', body: JSON.stringify({ token: existingToken }) }).catch(() => {});
        // Token may exist without markus_hub_user (e.g. restored from disk only).
        // refreshHubUserFromToken → saveHubAuth already emits markus:hub-auth when state changes.
        void refreshHubUserFromToken();
      } else {
        try {
          const saved = await request<{ token: string | null }>('/settings/hub-token');
          if (saved.token) {
            localStorage.setItem('markus_hub_token', saved.token);
            await refreshHubUserFromToken();
          }
        } catch { /* backend may not support GET yet */ }
      }
    })
    .catch(() => {});
}

const HUB_TOKEN_KEY = 'markus_hub_token';
const HUB_USER_KEY = 'markus_hub_user';

export interface HubUser {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
}

export type HubVisibility = 'public' | 'org' | 'unlisted';
export type HubModerationStatus = 'pending' | 'approved' | 'rejected';

export interface HubItem {
  id: string;
  itemType: 'agent' | 'team' | 'skill';
  /** Skill facet: 'connector' = a skill whose value is the MCP servers it wires up. */
  subtype?: 'connector' | null;
  name: string;
  slug?: string;
  description: string;
  version: string;
  category: string;
  tags: string[];
  icon?: string;
  thumbnailUrl?: string;
  images?: Array<{ url: string; alt: string; order: number }>;
  priceCents?: number;
  currency?: string;
  donationsEnabled?: boolean;
  donationCount?: number;
  donationTotal?: number;
  purchasedByCurrentUser?: boolean;
  visibility?: HubVisibility;
  orgId?: string;
  moderationStatus?: HubModerationStatus;
  moderationNote?: string;
  pendingReview?: boolean;
  downloadCount: number;
  avgRating: string;
  ratingCount: number;
  /** curation signals */
  featured?: boolean;
  editorial?: string | null;
  trendingScore?: number;
  licenseAttribution?: string | null;
  createdAt: string;
  author: { id: string; username: string; displayName?: string; avatarUrl?: string };
  config?: Record<string, unknown>;
  readme?: string;
}

export interface HubMyItem {
  id: string;
  itemType: string;
  name: string;
  slug: string;
  description: string;
  version: string;
  visibility?: HubVisibility;
  orgId?: string;
  priceCents?: number;
  donationsEnabled?: boolean;
  moderationStatus?: HubModerationStatus;
  moderationNote?: string;
  pendingReview?: boolean;
  updatedAt: string;
}

export interface HubOrg {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export function getHubToken(): string | null {
  return localStorage.getItem(HUB_TOKEN_KEY);
}

/**
 * Restore Hub JWT from the desktop backend (`~/.markus/hub-token`) into
 * localStorage when the renderer cache is empty. Safe to call repeatedly.
 */
export async function restoreHubTokenFromBackend(): Promise<string | null> {
  const existing = getHubToken();
  if (existing) return existing;
  try {
    const saved = await request<{ token: string | null }>('/settings/hub-token');
    if (saved.token) {
      localStorage.setItem(HUB_TOKEN_KEY, saved.token);
      // Refresh user quietly — do not fire markus:hub-auth here (login already
      // does). Extra events caused Overview/claim-modal refresh loops.
      void refreshHubUserFromToken();
      return saved.token;
    }
  } catch { /* backend unavailable */ }
  return null;
}

export function getHubUser(): HubUser | null {
  try {
    const raw = localStorage.getItem(HUB_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * Whether the current Hub user can install a paid item without buying again.
 * Matches Hub detail semantics: purchase row OR author (authors never appear in /purchases/mine).
 */
export function ownsHubItem(item: HubItem, purchasedIds?: Set<string> | null): boolean {
  if (item.purchasedByCurrentUser) return true;
  if (purchasedIds?.has(item.id)) return true;
  const me = getHubUser();
  if (!me?.id) return false;
  const authorId = item.author?.id ?? (item as { authorId?: string }).authorId;
  return !!authorId && authorId === me.id;
}

export function clearHubAuth(): void {
  localStorage.removeItem(HUB_TOKEN_KEY);
  localStorage.removeItem(HUB_USER_KEY);
  syncHubTokenToBackend(null);
  window.dispatchEvent(new CustomEvent('markus:hub-auth'));
}

export function saveHubAuth(token: string, user: HubUser): void {
  const prevToken = localStorage.getItem(HUB_TOKEN_KEY);
  const prevUser = localStorage.getItem(HUB_USER_KEY);
  const nextUser = JSON.stringify(user);
  // Idempotent: validateHubSession → refreshHubUserFromToken used to re-save identical
  // auth and re-emit markus:hub-auth, which UserAccountMenu listened to with another
  // validate — flooding POST /settings/hub-token (~800/s) and starving the API server.
  if (prevToken === token && prevUser === nextUser) return;
  localStorage.setItem(HUB_TOKEN_KEY, token);
  localStorage.setItem(HUB_USER_KEY, nextUser);
  syncHubTokenToBackend(token);
  window.dispatchEvent(new CustomEvent('markus:hub-auth'));
}

function syncHubTokenToBackend(token: string | null): void {
  request('/settings/hub-token', { method: 'POST', body: JSON.stringify({ token }) }).catch(() => {});
}

/** Persist Hub connect OpenRouter member credentials (chat + search). */
async function syncOpenRouterCredentialsToBackend(opts: { openrouter?: OpenRouterConnect }): Promise<void> {
  if (!opts.openrouter?.key) return;
  await request('/settings/subscription-key', {
    method: 'POST',
    body: JSON.stringify({ openrouter: opts.openrouter }),
  }).catch(() => {});
}

// ── Hub sign-in handoff ──────────────────────────────────────────────────────
// Both flows share one server-side connect session that the app polls via
// /api/auth/connect-status (proxied through the local backend):
//   • Desktop (Electron): open the Hub connect page in the *system browser* and
//     let the OS route markus://auth back to the app. Polling is the built-in
//     fallback if the deep link is ever missed, so login always completes.
//   • Web: open a popup and poll (a plain browser has no OS deep-link handler).

interface OpenRouterConnect { key: string; baseUrl: string; modelsUrl: string }
interface ConnectStatus {
  ready?: boolean;
  token?: string;
  user?: HubUser;
  openrouter?: OpenRouterConnect;
}

async function fetchConnectStatus(sessionId: string): Promise<ConnectStatus | null> {
  try {
    return await request<ConnectStatus>(`/hub/auth/connect-status?session=${encodeURIComponent(sessionId)}&_t=${Date.now()}`);
  } catch { return null; }
}

async function applyHubConnect(data: ConnectStatus): Promise<void> {
  if (!data.token || !data.user) return;
  saveHubAuth(data.token, data.user);
  if (data.openrouter?.key) {
    await syncOpenRouterCredentialsToBackend({ openrouter: data.openrouter });
  }
  // Best-effort: push locally preferred org name (from onboarding) to Hub.
  void syncPreferredOrgNameToHub();
}

/** Rename the user's Hub org to match markus.json org.name when connected. */
export async function syncPreferredOrgNameToHub(): Promise<void> {
  if (!getHubToken()) return;
  try {
    const { org } = await request<{ org: { name: string } }>('/settings/org');
    const name = org?.name?.trim();
    if (!name || name === 'My Organization') return;
    const mine = await hubRequest<{ orgs: Array<{ id: string; name: string; role: string }> }>('/orgs/mine');
    const owned = (mine.orgs ?? []).find((o) => o.role === 'owner');
    if (!owned || owned.name === name) return;
    await hubRequest(`/orgs/${owned.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
  } catch {
    /* best effort — hub-login also syncs server-side */
  }
}

interface DesktopBridge {
  openExternal: (url: string) => void | Promise<unknown>;
  focusWindow?: () => void | Promise<unknown>;
  onDeepLinkAuth?: (cb: (d: { session?: string }) => void) => void;
  peekPendingDeepLinkAuth?: () => Promise<string | null>;
  consumePendingDeepLinkAuth?: () => Promise<string | null>;
  clearPendingDeepLinkAuth?: () => Promise<void> | void;
}
function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { markusDesktop?: DesktopBridge }).markusDesktop;
}

/**
 * Poll a known connect session until the Hub reports it ready (or timeout).
 * Used for the desktop cold-start case, where the app is launched by the
 * markus://auth deep link and adopts the session id it carries.
 * When the session is ready, always overwrite the local Hub token (stale tokens
 * must not short-circuit a fresh connect).
 */
export async function completeHubAuthFromSession(sessionId: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await fetchConnectStatus(sessionId);
    if (data?.ready && data.token && data.user) {
      await applyHubConnect(data);
      return true;
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  return false;
}

// Single global deep-link listener that forwards to whichever sign-in is active.
let _deepLinkAuthHandler: ((session: string) => void) | null = null;
desktopBridge()?.onDeepLinkAuth?.((d) => { _deepLinkAuthHandler?.(d?.session ?? ''); });

let _cancelDesktopHubAuth: (() => void) | null = null;

/** Cancel an in-flight desktop Hub sign-in (user clicked Cancel on Login). */
export function cancelHubAuth(): void {
  _cancelDesktopHubAuth?.();
  _hubAuthPromise = null;
}

function runDesktopHubAuth(sessionId: string, method: string | undefined, desktop: DesktopBridge): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let inFlight = false;
    const finish = (ok: boolean, err?: Error) => {
      if (settled) return;
      settled = true;
      _cancelDesktopHubAuth = null;
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      if (_deepLinkAuthHandler === onDeepLink) _deepLinkAuthHandler = null;
      if (ok) {
        void desktop.focusWindow?.();
        resolve();
      } else {
        reject(err);
      }
    };
    _cancelDesktopHubAuth = () => finish(false, new Error('Hub login cancelled'));
    const tryComplete = async () => {
      if (settled || inFlight) return;
      inFlight = true;
      try {
        const data = await fetchConnectStatus(sessionId);
        if (data?.ready && data.token && data.user) {
          await applyHubConnect(data);
          finish(true);
        }
      } finally {
        inFlight = false;
      }
    };
    // Deep-link accelerator: complete immediately when the OS routes the return
    // URL back. Ignore events for other sessions (a stale/overlapping sign-in).
    const onDeepLink = (session: string) => { if (!session || session === sessionId) void tryComplete(); };
    _deepLinkAuthHandler = onDeepLink;

    // Chromium throttles timers hard while the app is backgrounded (user is in
    // the system browser). Kick the poll as soon as Markus is focused again.
    const onFocus = () => { void tryComplete(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void tryComplete(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    let url = `${HUB_URL}/auth/connect?session=${encodeURIComponent(sessionId)}&redirect=${encodeURIComponent('markus://auth')}`;
    if (method) url += `&method=${encodeURIComponent(method)}`;
    void Promise.resolve(desktop.openExternal(url)).then(() => {
      void tryComplete();
    }).catch((err) => {
      finish(false, err instanceof Error ? err : new Error('Failed to open browser'));
    });

    const pollTimer = setInterval(() => { void tryComplete(); }, 1500);
    const timeoutTimer = setTimeout(() => finish(false, new Error('Hub login timed out')), 5 * 60_000);
  });
}

function runPopupHubAuth(sessionId: string, method?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let url = `${HUB_URL}/auth/connect?session=${encodeURIComponent(sessionId)}`;
    if (method) url += `&method=${encodeURIComponent(method)}`;
    const w = 460, h = 580;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
    const popup = window.open(url, 'markus_hub_auth', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);

    if (!popup) {
      reject(new Error('Popup blocked by browser. Please allow popups for this site.'));
      return;
    }

    let settled = false;
    let finalCheckTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      clearInterval(pollTimer);
      clearInterval(closedTimer);
      if (finalCheckTimer) clearInterval(finalCheckTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };

    const pollStatus = async () => {
      if (settled) return;
      const data = await fetchConnectStatus(sessionId);
      if (data?.ready && data.token && data.user) {
        settled = true;
        await applyHubConnect(data);
        cleanup();
        popup?.close();
        resolve();
      }
    };

    const pollTimer = setInterval(() => { void pollStatus(); }, 1500);

    const onVisible = () => { if (!settled && document.visibilityState === 'visible') void pollStatus(); };
    document.addEventListener('visibilitychange', onVisible);

    const closedTimer = setInterval(() => {
      if (settled) return;
      if (popup?.closed) {
        clearInterval(closedTimer);
        let retries = 0;
        finalCheckTimer = setInterval(async () => {
          if (settled) { clearInterval(finalCheckTimer!); return; }
          retries++;
          await pollStatus();
          if (retries >= 5 && !settled) {
            settled = true;
            cleanup();
            if (getHubToken()) resolve(); else reject(new Error('Hub login cancelled'));
          }
        }, 1000);
      }
    }, 500);
  });
}

export type EnsureHubAuthOpts = {
  /** Drop any cached Hub token and open a fresh sign-in (user-initiated reconnect). */
  force?: boolean;
  method?: string;
};

/**
 * Ensure a Hub session exists, launching the appropriate sign-in flow.
 * Desktop uses the system browser + markus://auth deep link; web uses a popup.
 * Resolves once the token is received and saved.
 *
 * With `{ force: true }`, clears a stale local token first — needed when the UI
 * shows "Connect" but localStorage still has an expired/invalid session (otherwise
 * this would no-op and the button would appear broken).
 */
let _hubAuthPromise: Promise<void> | null = null;
export function ensureHubAuth(methodOrOpts?: string | EnsureHubAuthOpts): Promise<void> {
  const opts: EnsureHubAuthOpts = typeof methodOrOpts === 'string'
    ? { method: methodOrOpts }
    : (methodOrOpts ?? {});

  if (opts.force) {
    // Cancel any in-flight non-forced auth and clear the stale session.
    _cancelDesktopHubAuth?.();
    _hubAuthPromise = null;
    if (getHubToken() || getHubUser()) clearHubAuth();
  } else if (getHubToken()) {
    return Promise.resolve();
  }
  if (_hubAuthPromise) return _hubAuthPromise;

  const sessionId = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const desktop = desktopBridge();
  const p = (async () => {
    // Avoid opening prod Hub while local/dev settings still loading.
    await ensureHubUrlLoaded();
    if (desktop) await runDesktopHubAuth(sessionId, opts.method, desktop);
    else await runPopupHubAuth(sessionId, opts.method);
  })();
  _hubAuthPromise = p;
  void p.catch(() => {}).finally(() => { if (_hubAuthPromise === p) _hubAuthPromise = null; });
  return p;
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
  if (!res.ok) {
    const err = new Error(data.error ?? `Hub HTTP ${res.status}`) as Error & {
      code?: string;
      retryAfterSeconds?: number;
      status?: number;
    };
    err.code = typeof data.code === 'string' ? data.code : undefined;
    err.retryAfterSeconds = typeof data.retryAfterSeconds === 'number' ? data.retryAfterSeconds : undefined;
    err.status = res.status;
    throw err;
  }
  return data as T;
}

/**
 * Probe whether the cached Hub token still works against the Hub API.
 * On 401, hubRequest already clears local auth.
 */
export async function validateHubSession(): Promise<boolean> {
  if (!getHubToken()) return false;
  try {
    // Probe only — do not refresh+saveHubAuth here (that re-emits hub-auth and can loop).
    await hubRequest('/user/plan');
    return true;
  } catch {
    return false;
  }
}

export const hubApi = {
  getUrl: () => HUB_URL,
  /** True when a Hub token is cached locally — not a live server check. Prefer validateHubSession(). */
  isAuthenticated: () => !!getHubToken(),
  getUser: getHubUser,
  logout: () => { clearHubAuth(); },
  /** Open Hub popup for login/register. Resolves when auth is complete. */
  ensureAuth: ensureHubAuth,
  validateSession: validateHubSession,
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
  search: (opts?: { type?: string; subtype?: string; q?: string; category?: string; sort?: string; page?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.type) params.set('type', opts.type);
    if (opts?.subtype) params.set('subtype', opts.subtype);
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
  uploadImage: async (file: File): Promise<{ url: string; thumbnailUrl: string } | null> => {
    await ensureHubAuth();
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/hub/upload`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Authorization': `Bearer ${getHubToken()}` },
        body: formData,
      });
      if (!res.ok) return null;
      return await res.json() as { url: string; thumbnailUrl: string };
    } catch { return null; }
  },
  uploadMediaBatch: async (files: Array<{ key?: string; filename: string; base64: string }>): Promise<{ files: Array<{ key?: string; filename: string; url: string }>; errors: Array<{ key?: string; filename: string; error: string }> }> => {
    await ensureHubAuth();
    try {
      const res = await fetch(`/api/hub/deliverables/media`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getHubToken()}`,
        },
        body: JSON.stringify({ files }),
      });
      if (!res.ok) return { files: [], errors: [{ filename: 'batch', error: `HTTP ${res.status}` }] };
      return await res.json() as { files: Array<{ filename: string; url: string }>; errors: Array<{ filename: string; error: string }> };
    } catch (err) {
      return { files: [], errors: [{ filename: 'batch', error: String(err) }] };
    }
  },
  publishViaProxy: async (payload: { itemType: string; name: string; slug?: string; description: string; category?: string; tags?: string[]; icon?: string; version?: string; config?: unknown; files?: Record<string, string>; readme?: string; thumbnailUrl?: string; images?: Array<{ url: string; alt: string; order: number }>; priceCents?: number; donationsEnabled?: boolean; visibility?: HubVisibility; orgId?: string }) => {
    await ensureHubAuth();
    try {
      return await hubRequest<{ id?: string; name?: string; slug?: string; error?: string; updated?: boolean; visibility?: HubVisibility; moderationStatus?: HubModerationStatus; pendingReview?: boolean }>('/items', { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      if (!getHubToken()) { await ensureHubAuth(); return hubRequest<{ id?: string; name?: string; slug?: string; error?: string; updated?: boolean; visibility?: HubVisibility; moderationStatus?: HubModerationStatus; pendingReview?: boolean }>('/items', { method: 'POST', body: JSON.stringify(payload) }); }
      throw e;
    }
  },
  updateItem: async (id: string, data: { priceCents?: number; donationsEnabled?: boolean; thumbnailUrl?: string; images?: Array<{ url: string; alt: string; order: number }> }) => {
    await ensureHubAuth();
    return hubRequest<{ ok: boolean }>(`/items/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  },
  myItems: async () => {
    if (!getHubToken()) return { items: [] as HubMyItem[] };
    return hubRequest<{ items: HubMyItem[] }>('/items/mine');
  },
  browseItems: async (opts?: { type?: string; orgId?: string; q?: string; page?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.type) params.set('type', opts.type);
    if (opts?.orgId) params.set('orgId', opts.orgId);
    if (opts?.q) params.set('q', opts.q);
    if (opts?.page) params.set('page', String(opts.page));
    if (opts?.limit) params.set('limit', String(opts.limit ?? 50));
    const qs = params.toString();
    return hubRequest<{ items: HubItem[]; total: number }>(`/items${qs ? `?${qs}` : ''}`);
  },
  myOrgs: async () => {
    if (!getHubToken()) return { memberships: [] as HubOrg[] };
    return hubRequest<{ orgs: Array<{ id: string; name: string; slug: string; role: string }> }>('/orgs/mine').then(data => ({
      memberships: (data.orgs ?? []).map(o => ({ id: o.id, name: o.name, slug: o.slug, role: o.role })),
    }));
  },
  deleteItem: async (id: string) => {
    await ensureHubAuth();
    return hubRequest<{ ok: boolean }>(`/items/${id}`, { method: 'DELETE' });
  },
  purchases: {
    checkout: (itemId: string) =>
      hubRequest<{ ok?: boolean; checkoutUrl?: string; sessionId?: string; alreadyOwned?: boolean }>('/purchases/checkout', { method: 'POST', body: JSON.stringify({ itemId }) }),
    payWithEarnings: (itemId: string) =>
      hubRequest<{ ok?: boolean; purchaseId?: string; alreadyOwned?: boolean }>('/purchases/pay-with-earnings', { method: 'POST', body: JSON.stringify({ itemId }) }),
    mine: () =>
      hubRequest<{ purchases: Array<{ id: string; itemId: string; amount: number; createdAt: string }> }>('/purchases/mine'),
  },
  creator: {
    getBalance: () =>
      hubRequest<{ availableBalance: number; totalEarnings: number }>('/creator/balance'),
  },
  user: {
    plan: () => hubRequest<{
      orgId?: string | null;
      planType: string; planStatus: string;
      monthlyQuotaCu: number; cuUsed: number; cuResetAt: string | null;
      bonusCu: number; purchasedCu: number; windowQuotaCu: number;
      windowCuUsed?: number;
      totalConsumedThisPeriod?: number;
      /** Progress total = used + wallet remaining (survives B/P burns). */
      creditsBudgetCu?: number;
      memberCuLimit?: number | null;
      memberCuUsed?: number;
    }>('/user/plan'),
    cuStats: (days = 30, granularity: 'day' | 'hour' = 'day') =>
      hubRequest<{ stats: Array<{ period: string; model: string | null; totalCu: number; totalInput: number; totalOutput: number; totalCached: number; requestCount: number }>; granularity: string; days: number }>(
        `/user/cu/stats?days=${days}&granularity=${granularity}`
      ),
    /** Status of the one-time free starter credit claim. */
    claimFreeCreditsStatus: () => hubRequest<{
      claimable: boolean;
      claimed: boolean;
      claimedAt?: string | null;
      amountCu: number;
      bonusCu?: number;
      monthlyQuotaCu?: number;
      minAccountAgeSeconds: number;
      retryAfterSeconds: number;
      isOwner?: boolean;
    }>('/user/claim-free-credits'),
    /** Claim one-time free starter credits (bonusCu). May return TOO_SOON. */
    claimFreeCredits: () => hubRequest<{
      ok: boolean;
      alreadyClaimed?: boolean;
      claimedAt?: string;
      bonusCu?: number;
      monthlyQuotaCu?: number;
      grantedCu?: number;
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
      minAccountAgeSeconds?: number;
    }>('/user/claim-free-credits', { method: 'POST' }),
  },
};

/** English kebab-case package / Hub slug (mirrors @markus/shared). */
export const PACKAGE_SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function isValidPackageSlug(s: string): boolean {
  return typeof s === 'string' && s.length >= 2 && s.length <= 64 && PACKAGE_SLUG_RE.test(s);
}

/** Normalize toward a package slug; null when input cannot become valid English kebab-case. */
export function toPackageSlug(s: string): string | null {
  const result = s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return isValidPackageSlug(result) ? result : null;
}

/** Ensure a valid slug; Chinese / invalid names become a stable `pkg-<hash>`. */
export function ensurePackageSlug(raw: string): { slug: string; converted: boolean } {
  const input = String(raw || '').trim();
  if (isValidPackageSlug(input)) return { slug: input, converted: false };
  const normalized = toPackageSlug(input);
  if (normalized) return { slug: normalized, converted: normalized !== input };
  return { slug: kebab(input || 'package'), converted: true };
}

/** Convert a string to a kebab-case slug. Must match the server-side kebab() in @markus/shared. */
export function kebab(s: string, fallback?: string): string {
  const normalized = toPackageSlug(s);
  if (normalized) return normalized;
  if (fallback) {
    const fb = toPackageSlug(fallback);
    if (fb) return fb;
    if (isValidPackageSlug(fallback)) return fallback;
  }
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return `pkg-${Math.abs(hash).toString(36)}`;
}
