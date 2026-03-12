const BASE = '/api';

export interface AgentToolEvent {
  tool: string;
  phase: 'start' | 'end';
  success?: boolean;
  arguments?: unknown;
  result?: string;
  error?: string;
  durationMs?: number;
}

export interface AuthUser {
  id: string;
  name: string;
  email?: string;
  role: string;
  orgId: string;
}

export interface ChatSessionInfo {
  id: string;
  agentId: string;
  userId: string | null;
  title: string | null;
  createdAt: string;
  lastMessageAt: string;
}

export type StoredSegment =
  | { type: 'text'; content: string }
  | { type: 'tool'; tool: string; status: 'done' | 'error'; arguments?: unknown; result?: string; error?: string; durationMs?: number };

export interface ChatMessageInfo {
  id: string;
  sessionId: string;
  agentId: string;
  role: string;
  content: string;
  metadata?: { segments?: StoredSegment[]; images?: string[]; isError?: boolean } | null;
  tokensUsed: number;
  createdAt: string;
}

export interface ChannelMessageInfo {
  id: string;
  channel: string;
  senderId: string;
  senderType: string;
  senderName: string;
  text: string;
  mentions: string[];
  createdAt: string;
}

export interface PromptVersionInfo {
  id: string;
  promptId: string;
  version: number;
  content: string;
  variables: string[];
  author: string;
  createdAt: string;
  changelog?: string;
}

export interface PromptTemplateInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  currentVersion: number;
  versions: PromptVersionInfo[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationResultInfo {
  id: string;
  promptId: string;
  version: number;
  testInput: string;
  output: string;
  score: number;
  latencyMs: number;
  tokenCount: number;
  evaluatedAt: string;
  evaluator?: string;
  notes?: string;
}

export interface ABTestInfo {
  id: string;
  name: string;
  promptId: string;
  variantA: number;
  variantB: number;
  splitRatio: number;
  status: 'draft' | 'running' | 'completed';
  metrics: {
    variantATrials: number;
    variantBTrials: number;
    variantAScores: number[];
    variantBScores: number[];
  };
  createdAt: string;
  completedAt?: string;
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

export interface GovernancePolicyInfo {
  defaultApprovalTier: string;
  maxTasksPerAgent?: number;
  requireRequirement?: boolean;
  rules?: Array<{ condition: string; approvalTier: string }>;
}

export interface ProjectInfo {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  status: string;
  iterationModel: string;
  repositories?: Array<{ url: string; defaultBranch: string; localPath?: string }>;
  teamIds: string[];
  governancePolicy?: GovernancePolicyInfo;
  createdAt: string;
  updatedAt: string;
}

export interface IterationInfo {
  id: string;
  projectId: string;
  name: string;
  status: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEntryInfo {
  id: string;
  scope: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  projectId?: string;
  importance: number;
  status: string;
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

export interface AgentActivityInfo {
  id: string;
  type: 'task' | 'heartbeat' | 'chat';
  label: string;
  taskId?: string;
  heartbeatName?: string;
  startedAt: string;
}

export interface AgentActivityLogEntry {
  seq: number;
  type: 'status' | 'text' | 'tool_start' | 'tool_end' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ActivitySummary {
  id: string;
  type: 'task' | 'heartbeat' | 'chat';
  label: string;
  taskId?: string;
  heartbeatName?: string;
  startedAt: string;
  logCount: number;
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
}

export interface HumanUserInfo {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  orgId: string;
  email?: string;
  teamId?: string;
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
  assignedAgentId?: string;
  parentTaskId?: string;
  subtaskIds?: string[];
  blockedBy?: string[];
  notes?: string[];
  projectId?: string;
  iterationId?: string;
  requirementId?: string;
  reviewerAgentId?: string;
  createdBy?: string;
  updatedBy?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  updatedAt?: string;
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
  iterationId?: string;
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
  createdAt: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  authorType: string;
  content: string;
  attachments?: Array<{ type: string; url: string; name: string }>;
  createdAt: string;
}

export interface AgentToolInfo {
  name: string;
  description: string;
}

export interface HeartbeatTaskStat {
  name: string;
  lastRun?: string;
  nextRun?: string;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  avgDurationMs?: number;
}

export interface AgentHeartbeatInfo {
  running: boolean;
  uptime: number;
  taskCount: number;
  activeTasks: number;
  failedTasks: number;
  lastHeartbeat?: string;
  taskStats: HeartbeatTaskStat[];
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

export interface AgentDetail {
  id: string;
  name: string;
  role: string;
  roleDescription?: string;
  agentRole: string;
  skills: string[];
  activeTaskCount?: number;
  activeTaskIds?: string[];
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
  members: Array<{ templateId: string; name?: string; count?: number; role?: 'manager' | 'worker' }>;
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
    list: () => request<{ agents: AgentInfo[] }>('/agents'),
    get: (id: string) => request<AgentDetail>(`/agents/${id}`),
    create: (name: string, roleName: string, agentRole?: 'manager' | 'worker', teamId?: string) =>
      request('/agents', { method: 'POST', body: JSON.stringify({ name, roleName, agentRole, teamId }) }),
    start: (id: string) => request(`/agents/${id}/start`, { method: 'POST' }),
    stop: (id: string) => request(`/agents/${id}/stop`, { method: 'POST' }),
    remove: (id: string) => request(`/agents/${id}`, { method: 'DELETE' }),
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
    updateFile: (id: string, filename: string, content: string) =>
      request<{ ok: boolean }>(`/agents/${id}/files/${encodeURIComponent(filename)}`, { method: 'PUT', body: JSON.stringify({ content }) }),
    updateSystemPrompt: (id: string, systemPrompt: string) =>
      request<{ ok: boolean }>(`/agents/${id}/system-prompt`, { method: 'PUT', body: JSON.stringify({ systemPrompt }) }),
    addSkill: (id: string, skillName: string) =>
      request<{ ok: boolean; skills: string[] }>(`/agents/${id}/skills`, { method: 'POST', body: JSON.stringify({ skillName }) }),
    removeSkill: (id: string, skillName: string) =>
      request<{ ok: boolean; skills: string[] }>(`/agents/${id}/skills/${encodeURIComponent(skillName)}`, { method: 'DELETE' }),
    getHeartbeat: (id: string) => request<AgentHeartbeatInfo>(`/agents/${id}/heartbeat`),
    getRecentActivities: (id: string) => request<{ activities: ActivitySummary[] }>(`/agents/${id}/recent-activities`),
    getActivityLogs: (id: string, activityId: string) =>
      request<{ logs: AgentActivityLogEntry[]; activity?: AgentActivityInfo }>(`/agents/${id}/activity-logs?activityId=${encodeURIComponent(activityId)}`),
    message: (id: string, text: string, images?: string[], sessionId?: string | null) =>
      request<{ reply: string; sessionId?: string }>(`/agents/${id}/message`, { method: 'POST', body: JSON.stringify({ text, images, sessionId: sessionId ?? undefined }) }),
    messageStream: (id: string, text: string, onChunk: (chunk: string) => void, onActivity?: (event: AgentToolEvent) => void, signal?: AbortSignal, images?: string[], sessionId?: string | null): Promise<{ content: string; sessionId?: string }> => {
      return new Promise(async (resolve, reject) => {
        let fullContent = '';
        let resultSessionId: string | undefined;
        try {
          const res = await fetch(`${BASE}/agents/${id}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ text, stream: true, images, sessionId: sessionId ?? undefined }),
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
                } else if (event.type === 'error') {
                  const errEvent = event as { type: string; message?: string; error?: string };
                  reject(new Error(errEvent.message ?? errEvent.error ?? 'Unknown stream error'));
                  reader.cancel().catch(() => {});
                  return;
                } else if (event.type === 'tool_call_start' && event.toolCall?.name) {
                  onActivity?.({ tool: event.toolCall.name, phase: 'start' });
                } else if (event.type === 'agent_tool' && event.tool && event.phase) {
                  if (event.phase === 'end') onActivity?.({ tool: event.tool, phase: 'end', success: event.success, arguments: event.arguments, result: event.result, error: event.error, durationMs: event.durationMs });
                }
              } catch { /* skip */ }
            }
          }
          resolve({ content: fullContent, sessionId: resultSessionId });
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') { resolve({ content: fullContent, sessionId: resultSessionId }); }
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
    delete: (id: string, deleteMembers?: boolean) =>
      request(`/teams/${id}`, { method: 'DELETE', body: JSON.stringify({ deleteMembers: deleteMembers ?? false }) }),
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
  },
  externalAgents: {
    list: (orgId?: string) => request<{ agents: ExternalAgentInfo[] }>(`/external-agents?orgId=${orgId ?? 'default'}`),
  },
  tasks: {
    list: (filters?: { assignedAgentId?: string; status?: string; projectId?: string; iterationId?: string }) => {
      const params = new URLSearchParams();
      if (filters?.assignedAgentId) params.set('assignedAgentId', filters.assignedAgentId);
      if (filters?.status) params.set('status', filters.status);
      if (filters?.projectId) params.set('projectId', filters.projectId);
      if (filters?.iterationId) params.set('iterationId', filters.iterationId);
      const qs = params.toString();
      return request<{ tasks: TaskInfo[] }>(`/tasks${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}`),
    create: (title: string, description: string, priority?: string, assignedAgentId?: string, autoAssign?: boolean, projectId?: string, iterationId?: string, blockedBy?: string[]) =>
      request('/tasks', { method: 'POST', body: JSON.stringify({ title, description, priority, assignedAgentId, autoAssign, projectId, iterationId, blockedBy }) }),
    update: (id: string, data: { title?: string; description?: string; priority?: string; projectId?: string | null; iterationId?: string | null; blockedBy?: string[] }) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    updateStatus: (id: string, status: string) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status }) }),
    assign: (id: string, agentId: string | null) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ assignedAgentId: agentId }) }),
    approve: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}/approve`, { method: 'POST' }),
    reject: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}/reject`, { method: 'POST' }),
    delete: (id: string) => request(`/tasks/${id}`, { method: 'DELETE' }),
    board: (filters?: { projectId?: string; iterationId?: string }) => {
      const params = new URLSearchParams();
      if (filters?.projectId) params.set('projectId', filters.projectId);
      if (filters?.iterationId) params.set('iterationId', filters.iterationId);
      const qs = params.toString();
      return request<{ board: Record<string, TaskInfo[]> }>(`/taskboard${qs ? `?${qs}` : ''}`);
    },
    listSubtasks: (parentId: string) => request<{ subtasks: TaskInfo[] }>(`/tasks/${parentId}/subtasks`),
    createSubtask: (parentId: string, title: string, description?: string, priority?: string) =>
      request<{ subtask: TaskInfo }>(`/tasks/${parentId}/subtasks`, { method: 'POST', body: JSON.stringify({ title, description: description ?? '', priority: priority ?? 'medium' }) }),
    run: (id: string) => request<{ status: string; taskId: string }>(`/tasks/${id}/run`, { method: 'POST' }),
    getLogs: (id: string) => request<{ logs: TaskLogEntry[] }>(`/tasks/${id}/logs`),
    accept: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}/accept`, { method: 'POST', body: JSON.stringify({ reviewerAgentId: 'human' }) }),
    revision: (id: string, reason: string) => request<{ task: TaskInfo }>(`/tasks/${id}/revision`, { method: 'POST', body: JSON.stringify({ reason, reviewerAgentId: 'human' }) }),
    archive: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}/archive`, { method: 'POST' }),
    pause: (id: string) => request<{ status: string; taskId: string }>(`/tasks/${id}/pause`, { method: 'POST' }),
    resume: (id: string) => request<{ status: string; taskId: string }>(`/tasks/${id}/resume`, { method: 'POST' }),
    getComments: (id: string) => request<{ comments: TaskComment[] }>(`/tasks/${id}/comments`),
    addComment: (id: string, content: string, authorName?: string, attachments?: Array<{ type: string; url: string; name: string }>) =>
      request<{ comment: TaskComment }>(`/tasks/${id}/comments`, { method: 'POST', body: JSON.stringify({ content, authorName: authorName ?? 'User', authorType: 'human', attachments }) }),
  },
  requirements: {
    list: (filters?: { orgId?: string; status?: string; source?: string; projectId?: string; iterationId?: string }) => {
      const params = new URLSearchParams();
      if (filters?.orgId) params.set('orgId', filters.orgId);
      if (filters?.status) params.set('status', filters.status);
      if (filters?.source) params.set('source', filters.source);
      if (filters?.projectId) params.set('projectId', filters.projectId);
      if (filters?.iterationId) params.set('iterationId', filters.iterationId);
      const qs = params.toString();
      return request<{ requirements: RequirementInfo[] }>(`/requirements${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<{ requirement: RequirementInfo }>(`/requirements/${id}`),
    create: (data: { title: string; description: string; priority?: string; projectId?: string; iterationId?: string; tags?: string[] }) =>
      request<{ requirement: RequirementInfo }>('/requirements', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { title?: string; description?: string; priority?: string; tags?: string[] }) =>
      request<{ requirement: RequirementInfo }>(`/requirements/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    updateStatus: (id: string, status: string) =>
      request<{ requirement: RequirementInfo }>(`/requirements/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
    approve: (id: string) =>
      request<{ requirement: RequirementInfo }>(`/requirements/${id}/approve`, { method: 'POST' }),
    reject: (id: string, reason: string) =>
      request<{ requirement: RequirementInfo }>(`/requirements/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
    delete: (id: string) => request(`/requirements/${id}`, { method: 'DELETE' }),
  },
  users: {
    list: (orgId?: string) => request<{ users: HumanUserInfo[] }>(`/users?orgId=${orgId ?? 'default'}`),
    create: (name: string, role: string, orgId?: string, email?: string, password?: string, teamId?: string) =>
      request<{ user: HumanUserInfo }>('/users', { method: 'POST', body: JSON.stringify({ name, role, orgId, email, password, teamId }) }),
    remove: (id: string) => request(`/users/${id}`, { method: 'DELETE' }),
  },
  message: {
    send: (text: string, opts?: { targetAgentId?: string; senderId?: string; stream?: boolean; orgId?: string }) =>
      request<{ reply: string; agentId: string }>('/message', {
        method: 'POST',
        body: JSON.stringify({ text, ...opts }),
      }),
    sendStream: (text: string, onChunk: (chunk: string) => void, opts?: { targetAgentId?: string; senderId?: string; orgId?: string; signal?: AbortSignal; images?: string[] }, onActivity?: (event: AgentToolEvent) => void): Promise<{ content: string; agentId: string }> => {
      return new Promise(async (resolve, reject) => {
        try {
          const { signal, ...restOpts } = opts ?? {};
          const res = await fetch(`${BASE}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ text, stream: true, ...restOpts }),
            signal,
          });
          if (!res.ok) { reject(new Error(`API error: ${res.status}`)); return; }
          const reader = res.body?.getReader();
          if (!reader) { reject(new Error('No reader')); return; }
          const decoder = new TextDecoder();
          let fullContent = '';
          let routedAgentId = '';
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
                const event = JSON.parse(trimmed.slice(6)) as { type: string; text?: string; content?: string; agentId?: string; thinking?: string; tool?: string; phase?: 'start' | 'end'; success?: boolean; arguments?: unknown; result?: string; error?: string; durationMs?: number; toolCall?: { id?: string; name?: string } };
                if (event.type === 'text_delta' && event.text) {
                  fullContent += event.text;
                  onChunk(event.text);
                } else if (event.type === 'thinking_delta' && event.thinking) {
                  onChunk(`<think>${event.thinking}</think>`);
                } else if (event.type === 'done') {
                  fullContent = event.content ?? fullContent;
                  routedAgentId = event.agentId ?? routedAgentId;
                } else if (event.type === 'error') {
                  const errEvent = event as { type: string; message?: string; error?: string };
                  reject(new Error(errEvent.message ?? errEvent.error ?? 'Unknown stream error'));
                  reader.cancel().catch(() => {});
                  return;
                } else if (event.type === 'tool_call_start' && event.toolCall?.name) {
                  onActivity?.({ tool: event.toolCall.name, phase: 'start' });
                } else if (event.type === 'agent_tool' && event.tool && event.phase) {
                  if (event.phase === 'end') onActivity?.({ tool: event.tool, phase: 'end', success: event.success, arguments: event.arguments, result: event.result, error: event.error, durationMs: event.durationMs });
                }
              } catch { /* skip */ }
            }
          }
          resolve({ content: fullContent, agentId: routedAgentId });
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') { resolve({ content: fullContent, agentId: routedAgentId }); }
          else { reject(err); }
        }
      });
    },
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
  health: () => request<{ status: string; version: string; agents: number }>('/health'),
  settings: {
    getLlm: () => request<{ defaultProvider: string; providers: Record<string, { model: string; configured: boolean }> }>('/settings/llm'),
  },
  skills: {
    list: () => request<{ skills: Array<{ name: string; version: string; description?: string; author?: string; category?: string; tags?: string[]; tools?: Array<{ name: string; description: string }>; requiredPermissions?: string[]; type: 'builtin' | 'filesystem' | 'imported'; sourcePath?: string; agentIds: string[] }> }>('/skills'),
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
      request<{ skills: Array<{ name: string; author: string; repo: string; installs: string; url: string }>; cached: boolean }>(`/skills/registry/skillssh${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    import: (name: string, sourceUrl?: string, description?: string, category?: string) =>
      request('/skills/import', { method: 'POST', body: JSON.stringify({ name, sourceUrl, description, category }) }),
    install: (opts: { name: string; source?: string; slug?: string; sourceUrl?: string; description?: string; category?: string; version?: string; githubRepo?: string; githubSkillPath?: string }) =>
      request<{ installed: boolean; name: string; path: string; method: string }>('/skills/install', { method: 'POST', body: JSON.stringify(opts) }),
    uninstall: (name: string) =>
      request<{ deleted: boolean; name: string; path: string }>(`/skills/installed/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  },
  marketplace: {
    skills: (opts?: { source?: string; category?: string; q?: string }) => {
      const params = new URLSearchParams();
      if (opts?.source) params.set('source', opts.source);
      if (opts?.category) params.set('category', opts.category);
      if (opts?.q) params.set('q', opts.q);
      const qs = params.toString();
      return request<{ skills: Array<{ id: string; name: string; description: string; source: string; status: string; version: string; authorName: string; category: string; tags: string[]; tools: Array<{ name: string; description: string }>; readme: string | null; downloadCount: number; avgRating: number; ratingCount: number }>; total: number }>(`/marketplace/skills${qs ? `?${qs}` : ''}`);
    },
    installSkill: (skillId: string) =>
      request(`/marketplace/skills/${skillId}/install`, { method: 'POST' }),
    publishSkill: (data: { name: string; description: string; authorName: string; category: string; tags?: string[]; tools?: Array<{ name: string; description: string }>; readme?: string; requiredPermissions?: string[]; requiredEnv?: string[]; publish?: boolean }) =>
      request('/marketplace/skills', { method: 'POST', body: JSON.stringify(data) }),
  },
  builder: {
    chat: (mode: 'agent' | 'team' | 'skill', messages: Array<{ role: string; content: string }>) =>
      request<{ reply: string; artifact: Record<string, unknown> | null; mode: string }>('/builder/chat', { method: 'POST', body: JSON.stringify({ mode, messages }) }),
    create: (mode: 'agent' | 'team' | 'skill', artifact: Record<string, unknown>) =>
      request('/builder/create', { method: 'POST', body: JSON.stringify({ mode, artifact }) }),
  },
  auth: {
    login: (email: string, password: string) =>
      request<{ user: AuthUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    logout: () => request('/auth/logout', { method: 'POST' }),
    me: () => request<{ user: AuthUser }>('/auth/me'),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<{ ok: boolean }>('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
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
    sendMessage: (channel: string, data: { text: string; senderId?: string; senderName?: string; mentions?: string[]; targetAgentId?: string; orgId?: string; humanOnly?: boolean }) =>
      request<{ userMessage: ChannelMessageInfo | null; agentMessage: ChannelMessageInfo | null }>(
        `/channels/${encodeURIComponent(channel)}/messages`,
        { method: 'POST', body: JSON.stringify(data) }
      ),
  },
  promptStudio: {
    list: (category?: string, q?: string) => {
      const params = new URLSearchParams();
      if (category) params.set('category', category);
      if (q) params.set('q', q);
      const qs = params.toString();
      return request<{ prompts: PromptTemplateInfo[] }>(`/prompts${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<{ prompt: PromptTemplateInfo }>(`/prompts/${id}`),
    create: (data: { name: string; description: string; category: string; content: string; tags?: string[] }) =>
      request<{ prompt: PromptTemplateInfo }>('/prompts', { method: 'POST', body: JSON.stringify(data) }),
    delete: (id: string) => request(`/prompts/${id}`, { method: 'DELETE' }),
    addVersion: (promptId: string, content: string, changelog?: string) =>
      request<{ version: PromptVersionInfo }>(`/prompts/${promptId}/versions`, {
        method: 'POST', body: JSON.stringify({ content, changelog }),
      }),
    render: (promptId: string, variables?: Record<string, string>, version?: number) =>
      request<{ rendered: string }>(`/prompts/${promptId}/render`, {
        method: 'POST', body: JSON.stringify({ variables, version }),
      }),
    evaluate: (promptId: string, version: number, testInput: string, variables?: Record<string, string>) =>
      request<{ evaluation: EvaluationResultInfo }>(`/prompts/${promptId}/evaluate`, {
        method: 'POST', body: JSON.stringify({ version, testInput, variables }),
      }),
    getEvaluations: (promptId: string, version?: number) => {
      const qs = version !== undefined ? `?version=${version}` : '';
      return request<{ evaluations: EvaluationResultInfo[] }>(`/prompts/${promptId}/evaluations${qs}`);
    },
    getEvaluationSummary: (promptId: string, version: number) =>
      request<{ summary: { avgScore: number; avgLatencyMs: number; avgTokenCount: number; count: number } }>(
        `/prompts/${promptId}/evaluation-summary?version=${version}`
      ),
    scoreEvaluation: (evaluationId: string, score: number, notes?: string) =>
      request<{ updated: boolean }>(`/prompts/evaluations/${evaluationId}/score`, {
        method: 'POST', body: JSON.stringify({ score, notes }),
      }),
    listABTests: (promptId?: string) => {
      const qs = promptId ? `?promptId=${promptId}` : '';
      return request<{ tests: ABTestInfo[] }>(`/prompts/ab-tests${qs}`);
    },
    createABTest: (data: { name: string; promptId: string; variantA: number; variantB: number; splitRatio?: number }) =>
      request<{ test: ABTestInfo }>('/prompts/ab-tests', { method: 'POST', body: JSON.stringify(data) }),
    startABTest: (testId: string) =>
      request<{ started: boolean }>(`/prompts/ab-tests/${testId}/start`, { method: 'POST' }),
    completeABTest: (testId: string) =>
      request<{ test: ABTestInfo }>(`/prompts/ab-tests/${testId}/complete`, { method: 'POST' }),
    recordABResult: (testId: string, variant: 'A' | 'B', score: number) =>
      request<{ ok: boolean }>(`/prompts/ab-tests/${testId}/record`, {
        method: 'POST', body: JSON.stringify({ variant, score }),
      }),
    getABTestResults: (testId: string) =>
      request<{ test: ABTestInfo; variantAAvg: number; variantBAvg: number; winner: 'A' | 'B' | 'tie'; confidence: number }>(
        `/prompts/ab-tests/${testId}/results`
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

    listIterations: (projectId: string) =>
      request<{ iterations: IterationInfo[] }>(`/projects/${projectId}/iterations`),
    createIteration: (projectId: string, data: Partial<IterationInfo>) =>
      request<{ iteration: IterationInfo }>(`/projects/${projectId}/iterations`, { method: 'POST', body: JSON.stringify(data) }),
    updateIterationStatus: (iterationId: string, status: string) =>
      request<{ iteration: IterationInfo }>(`/iterations/${iterationId}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  },

  // ─── Knowledge ─────────────────────────────────────────────────────
  knowledge: {
    search: (query: string, scope?: string) => {
      const params = new URLSearchParams({ query });
      if (scope) params.set('scope', scope);
      return request<{ results: KnowledgeEntryInfo[] }>(`/knowledge/search?${params}`);
    },
    list: (scope?: string) => {
      const params = scope ? `?scope=${scope}` : '';
      return request<{ entries: KnowledgeEntryInfo[] }>(`/knowledge${params}`);
    },
    contribute: (data: Partial<KnowledgeEntryInfo>) =>
      request<{ entry: KnowledgeEntryInfo }>('/knowledge', { method: 'POST', body: JSON.stringify(data) }),
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
};

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

  connect(): void {
    // Guard against duplicate connections in CONNECTING or OPEN state
    if (this.ws && (
      this.ws.readyState === WebSocket.CONNECTING ||
      this.ws.readyState === WebSocket.OPEN
    )) return;

    this.intentionalClose = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.hostname}:3001/ws`;

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
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
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
