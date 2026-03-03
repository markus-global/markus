const BASE = '/api';

export interface AgentToolEvent {
  tool: string;
  phase: 'start' | 'end';
  success?: boolean;
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
  | { type: 'tool'; tool: string; status: 'done' | 'error' };

export interface ChatMessageInfo {
  id: string;
  sessionId: string;
  agentId: string;
  role: string;
  content: string;
  metadata?: { segments?: StoredSegment[] } | null;
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

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',  // send cookies
    ...opts,
    body: opts?.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  status: string;
  activeTaskCount?: number;
  agentRole?: 'manager' | 'worker';
  teamId?: string;
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
  notes?: string[];
  createdAt?: string;
  updatedAt?: string;
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
  llmConfig: { primary: string; fallback?: string; maxTokensPerRequest?: number; maxTokensPerDay?: number };
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
    message: (id: string, text: string) =>
      request<{ reply: string }>(`/agents/${id}/message`, { method: 'POST', body: JSON.stringify({ text }) }),
    messageStream: (id: string, text: string, onChunk: (chunk: string) => void, onActivity?: (event: AgentToolEvent) => void, signal?: AbortSignal): Promise<string> => {
      return new Promise(async (resolve, reject) => {
        try {
          const res = await fetch(`${BASE}/agents/${id}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ text, stream: true }),
            signal,
          });
          if (!res.ok) { reject(new Error(`API error: ${res.status}`)); return; }
          const reader = res.body?.getReader();
          if (!reader) { reject(new Error('No reader')); return; }
          const decoder = new TextDecoder();
          let fullContent = '';
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
                const event = JSON.parse(trimmed.slice(6)) as { type: string; text?: string; content?: string; tool?: string; phase?: 'start' | 'end'; success?: boolean; toolCall?: { id?: string; name?: string } };
                if (event.type === 'text_delta' && event.text) {
                  fullContent += event.text;
                  onChunk(event.text);
                } else if (event.type === 'done') {
                  fullContent = event.content ?? fullContent;
                } else if (event.type === 'error') {
                  const errEvent = event as { type: string; message?: string; error?: string };
                  reject(new Error(errEvent.message ?? errEvent.error ?? 'Unknown stream error'));
                  reader.cancel().catch(() => {});
                  return;
                } else if (event.type === 'tool_call_start' && event.toolCall?.name) {
                  // LLM just named the tool it wants to use — show loading immediately
                  onActivity?.({ tool: event.toolCall.name, phase: 'start' });
                } else if (event.type === 'agent_tool' && event.tool && event.phase) {
                  // Only propagate 'end' from agent_tool to avoid double 'start'
                  if (event.phase === 'end') onActivity?.({ tool: event.tool, phase: 'end', success: event.success });
                }
              } catch { /* skip */ }
            }
          }
          resolve(fullContent);
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') { resolve(fullContent); }
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
    delete: (id: string) => request(`/teams/${id}`, { method: 'DELETE' }),
    addMember: (teamId: string, memberId: string, memberType: 'human' | 'agent') =>
      request(`/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ memberId, memberType }) }),
    removeMember: (teamId: string, memberId: string) =>
      request(`/teams/${teamId}/members/${memberId}`, { method: 'DELETE' }),
  },
  tasks: {
    list: (filters?: { assignedAgentId?: string; status?: string }) => {
      const params = new URLSearchParams();
      if (filters?.assignedAgentId) params.set('assignedAgentId', filters.assignedAgentId);
      if (filters?.status) params.set('status', filters.status);
      const qs = params.toString();
      return request<{ tasks: TaskInfo[] }>(`/tasks${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<{ task: TaskInfo }>(`/tasks/${id}`),
    create: (title: string, description: string, priority?: string, assignedAgentId?: string, autoAssign?: boolean) =>
      request('/tasks', { method: 'POST', body: JSON.stringify({ title, description, priority, assignedAgentId, autoAssign }) }),
    update: (id: string, data: { title?: string; description?: string; priority?: string }) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    updateStatus: (id: string, status: string) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status }) }),
    assign: (id: string, agentId: string | null) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ assignedAgentId: agentId }) }),
    delete: (id: string) => request(`/tasks/${id}`, { method: 'DELETE' }),
    board: () => request<{ board: Record<string, TaskInfo[]> }>('/taskboard'),
    listSubtasks: (parentId: string) => request<{ subtasks: TaskInfo[] }>(`/tasks/${parentId}/subtasks`),
    createSubtask: (parentId: string, title: string, description?: string, priority?: string) =>
      request<{ subtask: TaskInfo }>(`/tasks/${parentId}/subtasks`, { method: 'POST', body: JSON.stringify({ title, description: description ?? '', priority: priority ?? 'medium' }) }),
    run: (id: string) => request<{ status: string; taskId: string }>(`/tasks/${id}/run`, { method: 'POST' }),
    getLogs: (id: string) => request<{ logs: TaskLogEntry[] }>(`/tasks/${id}/logs`),
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
    sendStream: (text: string, onChunk: (chunk: string) => void, opts?: { targetAgentId?: string; senderId?: string; orgId?: string; signal?: AbortSignal }, onActivity?: (event: AgentToolEvent) => void): Promise<{ content: string; agentId: string }> => {
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
                const event = JSON.parse(trimmed.slice(6)) as { type: string; text?: string; content?: string; agentId?: string; tool?: string; phase?: 'start' | 'end'; success?: boolean; toolCall?: { id?: string; name?: string } };
                if (event.type === 'text_delta' && event.text) {
                  fullContent += event.text;
                  onChunk(event.text);
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
                  if (event.phase === 'end') onActivity?.({ tool: event.tool, phase: 'end', success: event.success });
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
  health: () => request<{ status: string; version: string; agents: number }>('/health'),
  settings: {
    getLlm: () => request<{ defaultProvider: string; providers: Record<string, { model: string; configured: boolean }> }>('/settings/llm'),
  },
  skills: {
    list: () => request<{ skills: Array<{ name: string; version: string; description?: string; tools?: string[] }> }>('/skills'),
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
