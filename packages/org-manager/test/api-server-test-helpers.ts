import { vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APIServer } from '../src/api-server.js';
import { TaskService } from '../src/task-service.js';
import type { OrganizationService } from '../src/org-service.js';
import type { StorageBridge } from '../src/storage-bridge.js';

export class MockIncomingMessage extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;

  constructor(
    method: string,
    url: string,
    headers: Record<string, string> = {},
    private body: string = '',
  ) {
    super();
    this.method = method;
    this.url = url;
    this.headers = {
      host: 'localhost:8056',
      ...headers,
      ...(body.length > 0 ? { 'content-length': String(body.length) } : {}),
    };
  }

  _simulate(): void {
    if (this.body) this.emit('data', Buffer.from(this.body));
    this.emit('end');
  }

  setTimeout(_ms: number, _cb?: () => void): this { return this; }
  destroy(): void {}
}

export class MockServerResponse {
  statusCode = 200;
  statusMessage = 'OK';
  headers: Record<string, string> = {};
  body = '';
  private _ended = false;

  writeHead(statusCode: number, statusMessageOrHeaders?: string | Record<string, string>, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    if (typeof statusMessageOrHeaders === 'string') {
      this.statusMessage = statusMessageOrHeaders;
      if (headers) this.headers = headers;
    } else if (statusMessageOrHeaders) {
      this.headers = statusMessageOrHeaders;
    }
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headers[name];
  }

  write(chunk: string | Buffer): boolean {
    this.body += chunk.toString();
    return true;
  }

  end(chunk?: string | Buffer): void {
    if (chunk) this.body += chunk.toString();
    this._ended = true;
  }

  on(): this { return this; }
  once(): this { return this; }
  emit(): boolean { return true; }
  get ended(): boolean { return this._ended; }
}

export const GW_AUTH = { authorization: 'Bearer gw-token' };
export const TEST_PASSWORD_HASH = 'pbkdf2:100000:d1d65ae1304250defeac12036a3d9806:13354cc2a0df0bed13bbe804ab9059dfa8aa5aa3e267ad329b4799a094851870';

export async function request(
  server: APIServer,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown>; raw: string; headers: Record<string, string> }> {
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const effectiveBody = body !== undefined ? body : (mutating ? {} : undefined);
  const bodyStr = effectiveBody !== undefined ? JSON.stringify(effectiveBody) : '';
  const reqHeaders = {
    ...(bodyStr ? { 'content-type': 'application/json' } : {}),
    ...headers,
  };
  const req = new MockIncomingMessage(method, path, reqHeaders, bodyStr);
  const res = new MockServerResponse();
  server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  req._simulate();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  let json: Record<string, unknown> = {};
  try {
    if (res.body) json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    json = { _raw: res.body };
  }
  return { status: res.statusCode, json, raw: res.body, headers: res.headers };
}

/** Send a raw body (e.g. multipart) without JSON stringification. */
export async function requestRaw(
  server: APIServer,
  method: string,
  path: string,
  body: Buffer | string,
  headers: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown>; raw: string; headers: Record<string, string> }> {
  const bodyBuf = typeof body === 'string' ? Buffer.from(body) : body;
  const reqHeaders = {
    ...headers,
    'content-length': String(bodyBuf.length),
  };
  const req = new MockIncomingMessage(method, path, reqHeaders, '');
  const res = new MockServerResponse();
  server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  req.emit('data', bodyBuf);
  req.emit('end');
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  let json: Record<string, unknown> = {};
  try {
    if (res.body) json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    json = { _raw: res.body };
  }
  return { status: res.statusCode, json, raw: res.body, headers: res.headers };
}

export const AGENT_A = 'agent-a';
export const AGENT_B = 'agent-b';
export const REVIEWER = 'reviewer-1';
export const TEAM_1 = 'team-1';
export const PROJECT_1 = 'proj-1';
export const REQ_1 = 'req-1';

export function createMockAgent(id: string, overrides: Record<string, unknown> = {}) {
  const config = {
    id,
    name: `Agent ${id}`,
    orgId: 'default',
    teamId: TEAM_1,
    roleId: 'developer',
    agentRole: id === REVIEWER ? 'manager' as const : 'worker' as const,
    skills: ['coding'],
    llmConfig: { provider: 'openai', model: 'gpt-4' },
    heartbeatIntervalMs: 1800000,
    ...(overrides.config as object),
  };
  return {
    id,
    config,
    role: { name: 'Developer', description: 'Dev role' },
    tools: new Map([['read_file', { name: 'read_file', description: 'Read files' }]]),
    heartbeat: { getStatus: () => ({ running: false, uptimeMs: 0, intervalMs: 1000, initialDelayMs: 0 }) },
    getState: vi.fn(() => ({
      status: 'idle',
      activeTaskIds: [],
      activeTaskCount: 0,
      tokensUsedToday: 10,
      lastError: null,
      lastErrorAt: null,
      currentActivity: null,
    })),
    getMindState: vi.fn(() => ({ focus: 'idle', attention: [] })),
    getMailbox: vi.fn(() => ({ getQueuedItems: () => [] })),
    getAttentionController: vi.fn(() => ({ getRecentDecisions: () => [] })),
    getMetrics: vi.fn(() => ({
      period: '24h', tokens: 100, toolCalls: 5, healthScore: 85,
      tokenUsage: { input: 100, output: 50, cost: 0.01 },
      taskMetrics: { completed: 2, failed: 0, cancelled: 0, averageCompletionTimeMs: 1000 },
      averageResponseTimeMs: 500, errorRate: 0, totalInteractions: 10,
    })),
    getMemory: vi.fn(() => ({
      getEntries: () => [], listSessions: () => [], getDailyLog: () => null,
      getRecentDailyLogs: () => [], getLongTermMemory: () => null, getSession: () => null,
      updateDailyLog: vi.fn(), updateLongTermMemory: vi.fn(), writeDailyLog: vi.fn(), addLongTermMemory: vi.fn(),
    })),
    getUsageStats: vi.fn(() => ({
      toolCallsToday: 3, totalTokens: 100, requestsToday: 5, tokensToday: 50,
      promptTokens: 60, completionTokens: 40, requestCount: 5, toolCalls: 3,
      estimatedCost: 0.01, costToday: 0.005,
    })),
    getActiveSkillNames: vi.fn(() => ['coding']),
    getSkillProficiency: vi.fn(() => ({})),
    getRecentActivities: vi.fn(() => []),
    sendMessage: vi.fn(async () => 'Hello from agent'),
    pause: vi.fn(), resume: vi.fn(), cancelActiveStream: vi.fn(),
    generateDailyReport: vi.fn(async () => 'Daily report'),
    startNewSession: vi.fn(), restoreSessionFromHistory: vi.fn(), bindDbSession: vi.fn(),
    injectFollowUp: vi.fn(), injectSkillInstructions: vi.fn(), deactivateSkill: vi.fn(),
    addDynamicContextProvider: vi.fn(), enqueueToMailbox: vi.fn(),
    checkRoleUpdate: vi.fn(() => ({ hasTemplate: false, isUpToDate: true })),
    getRoleFileDiff: vi.fn(() => ({ file: 'ROLE.md', changed: false, diff: '' })),
    syncRoleFromTemplate: vi.fn(() => ({ success: true, synced: ['ROLE.md'] })),
    smartSyncRoleFromTemplate: vi.fn(() => ({ success: true })),
    createAgentFromTemplate: vi.fn(async () => createMockAgent('from-template')),
    ...overrides,
  };
}

export function createMockAgentManager() {
  const agents = new Map([
    [AGENT_A, createMockAgent(AGENT_A)],
    [AGENT_B, createMockAgent(AGENT_B)],
    [REVIEWER, createMockAgent(REVIEWER)],
    ['secretary', createMockAgent('secretary', { config: { agentRole: 'secretary' as const } })],
  ]);
  return {
    listAgents: vi.fn(() => [...agents.values()].map(a => ({
      id: a.id, name: a.config.name, agentRole: a.config.agentRole,
      role: a.role.name, status: 'idle', skills: a.config.skills ?? [],
    }))),
    getAgent: vi.fn((id: string) => {
      const agent = agents.get(id);
      if (!agent) throw new Error(`Agent not found: ${id}`);
      return agent;
    }),
    hasAgent: vi.fn((id: string) => agents.has(id)),
    startAgent: vi.fn(async () => {}), stopAgent: vi.fn(async () => {}),
    stopAllAgents: vi.fn(async () => {}), startAllAgents: vi.fn(async () => {}),
    emergencyStop: vi.fn(async () => {}),
    isGlobalStopped: vi.fn(() => false), isEmergencyMode: vi.fn(() => false),
    broadcastAnnouncement: vi.fn(), getActiveAnnouncements: vi.fn(() => []),
    checkAllRoleUpdates: vi.fn(() => []),
    checkRoleUpdate: vi.fn(() => ({ hasTemplate: false, isUpToDate: true })),
    getRoleFileDiff: vi.fn(() => ({
      file: 'ROLE.md', changed: true, diff: '--- a\n+++ b',
      agentContent: '# Agent Role\nCustom', templateContent: '# Template Role\nUpdated',
    })),
    syncRoleFromTemplate: vi.fn(() => ({ success: true, synced: ['ROLE.md'] })),
    smartSyncRoleFromTemplate: vi.fn(() => ({ success: true })),
    createAgentFromTemplate: vi.fn(async () => createMockAgent('from-template')),
    getDataDir: vi.fn(() => '/tmp/markus/agents'),
    getEventBus: vi.fn(() => ({ on: vi.fn(), emit: vi.fn() })),
    runQuickBrowserTest: vi.fn(async () => ({ success: true, tabs: 1 })),
    runChaosBrowserTest: vi.fn(async function* () {
      yield { type: 'start', message: 'ok' };
      yield { type: 'done', message: 'finished' };
    }),
    setTemplateRegistry: vi.fn(), setGroupChatHandlers: vi.fn(), getTemplateRegistry: vi.fn(() => null),
  };
}

export function createMockStorage(): StorageBridge {
  const users = new Map<string, Record<string, unknown>>([
    ['user-1', { id: 'user-1', orgId: 'default', name: 'Test User', email: 'login@test.com', role: 'owner', passwordHash: TEST_PASSWORD_HASH }],
    ['anonymous', { id: 'anonymous', orgId: 'default', name: 'Anonymous', email: 'anon@test.com', role: 'owner' }],
    ['member-1', { id: 'member-1', orgId: 'default', name: 'Member', email: 'member@test.com', role: 'member' }],
  ]);
  return {
    userRepo: {
      findById: vi.fn((id: string) => users.get(id) ?? null),
      findByEmail: vi.fn((email: string) => {
        for (const u of users.values()) if (u.email === email) return u;
        return null;
      }),
      findByHubUserId: vi.fn(() => null),
      updateHubUserId: vi.fn(),
      listByOrg: vi.fn(async () => [...users.values()]),
      updateProfile: vi.fn((id: string, data: Record<string, unknown>) => {
        const existing = users.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...data };
        users.set(id, updated);
        return updated;
      }),
      updateAvatarUrl: vi.fn(),
      countByOrg: vi.fn(() => users.size),
      create: vi.fn(async (u: Record<string, unknown>) => { users.set(u.id as string, u); return u; }),
      findDeletedByEmail: vi.fn(() => null), reactivate: vi.fn(), setInviteToken: vi.fn(),
      updatePassword: vi.fn(), updateLastLogin: vi.fn(),
      findByInviteToken: vi.fn(() => ({
        id: 'invited-1', orgId: 'default', name: 'Invited', email: 'invited@test.com',
        role: 'member', inviteExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      })),
      clearInviteToken: vi.fn(),
      upsert: vi.fn(async (u: Record<string, unknown>) => { users.set(u.id as string, u); }),
    },
    agentRepo: {
      listAll: vi.fn(() => [{ id: AGENT_A, avatarUrl: 'http://avatar.test/a.png' }]),
      findById: vi.fn((id: string) => ({ id, avatarUrl: undefined })),
      updateConfig: vi.fn(async () => {}),
      updateAvatarUrl: vi.fn(),
    },
    readCursorRepo: {
      getUnreadCounts: vi.fn(() => ({ 'agent:agent-a': 2 })),
      getSessionAgentMap: vi.fn(() => ({ 'sess-1': AGENT_A })),
      setReadCursor: vi.fn(),
      markAllRead: vi.fn(),
    },
    integrationRepo: {
      listByPlatform: vi.fn(() => []), listByOrg: vi.fn(() => []),
      create: vi.fn(async (d: Record<string, unknown>) => d),
      update: vi.fn(async () => {}), delete: vi.fn(async () => {}),
    },
    chatSessionRepo: {
      getSessionsByAgent: vi.fn(async () => [{ id: 'sess-1', title: 'Chat' }]),
      createSession: vi.fn(async () => ({ id: 'sess-1', title: null })),
      appendMessage: vi.fn(async () => ({ id: 'msg-1' })),
      updateLastMessage: vi.fn(async () => {}),
      getSession: vi.fn((sessionId: string) => ({ id: sessionId, userId: 'anonymous', title: 'Chat' })),
      getMessages: vi.fn(async () => ({ messages: [{ id: 'm1', text: 'Hi' }], hasMore: false })),
      hasAnySessions: vi.fn(() => true),
      deleteSession: vi.fn(async () => {}),
      deleteLastExchange: vi.fn(async () => {}),
      searchMessages: vi.fn(() => []),
    },
    channelMessageRepo: {
      append: vi.fn(async () => ({ id: 'ch-msg-1' })),
      getMessages: vi.fn(async () => ({ messages: [] })),
      searchMessages: vi.fn(() => []),
      getMessageById: vi.fn(() => ({ id: 'orig-1', senderName: 'Agent A', text: 'Original', senderType: 'agent' })),
    },
    groupChatRepo: {
      list: vi.fn(() => [{ id: 'gc-1', name: 'Custom Chat', creatorId: 'anonymous', creatorName: 'Anon', memberCount: 2, channelKey: 'group:custom:abc', orgId: 'default' }]),
      listByMember: vi.fn(() => []),
      create: vi.fn(() => ({ channelKey: 'group:custom:abc', id: 'gc-1', name: 'Custom Chat', creatorId: 'anonymous', creatorName: 'Anon', members: [{ memberId: AGENT_A, memberName: 'Agent A', memberType: 'agent' }] })),
      getById: vi.fn((id: string) => id === 'gc-1' ? { id: 'gc-1', name: 'Custom Chat', channelKey: 'group:custom:abc', creatorId: 'anonymous', creatorName: 'Anon', members: [{ memberId: AGENT_A, memberName: 'Agent A', memberType: 'agent' }] } : null),
      updateName: vi.fn(), delete: vi.fn(), getAgentMemberIds: vi.fn(() => [AGENT_A]),
      addMember: vi.fn(), removeMember: vi.fn(),
    },
    mailboxRepo: { getHistory: vi.fn(() => []), getStatusCounts: vi.fn(() => ({})), getSourceTypeCounts: vi.fn(() => ({})) },
    decisionRepo: { getByMailboxItemIds: vi.fn(() => new Map()), getByAgent: vi.fn(() => []) },
    activityRepo: { getByMailboxItemIds: vi.fn(() => new Map()), queryActivities: vi.fn(() => []) },
    taskCommentRepo: { getByTask: vi.fn(async () => []) },
    requirementCommentRepo: { getByRequirement: vi.fn(async () => []) },
    taskLogRepo: { getRoundsSummary: vi.fn(() => []), getByTaskRound: vi.fn(() => []), getByTask: vi.fn(async () => []) },
    executionStreamRepo: { getBySource: vi.fn(() => []) },
    notificationRepo: { list: vi.fn(() => []) },
    apiKeyRepo: { list: vi.fn(() => []), create: vi.fn(() => ({ id: 'key-1', name: 'test', prefix: 'mk_test' })), delete: vi.fn(() => true) },
  } as unknown as StorageBridge;
}

export function createMockOrgService(agentManager = createMockAgentManager()): OrganizationService {
  return {
    getAgentManager: () => agentManager,
    getTeam: vi.fn((id: string) => id === TEAM_1 ? { id: TEAM_1, name: 'Team One', orgId: 'default', memberAgentIds: [AGENT_A, AGENT_B], description: 'Test team' } : null),
    listTeams: vi.fn(() => [{ id: TEAM_1, name: 'Team One', orgId: 'default' }]),
    listTeamsWithMembers: vi.fn(() => [{ id: TEAM_1, name: 'Team One', orgId: 'default', members: [{ id: AGENT_A, type: 'agent', name: 'Agent A' }] }]),
    listUngroupedMembers: vi.fn(() => []),
    listAvailableRoles: vi.fn(() => ['developer', 'secretary']),
    listOrganizations: vi.fn(() => [{ id: 'default', name: 'Default Org' }]),
    getDefaultOrganization: vi.fn(() => ({ id: 'default', name: 'Default Org' })),
    listHumanUsers: vi.fn(() => [{ id: 'user-1', name: 'Test User' }]),
    getRoleDetails: vi.fn((name: string) => ({ name, description: `${name} role`, category: 'builtin' })),
    isProtectedAgent: vi.fn((id: string) => id === 'secretary'),
    resolveHumanIdentity: vi.fn((id: string) => ({ id, name: 'Test User', role: 'owner' })),
    getHumanUser: vi.fn((id: string) => ({ id, name: 'Test User', email: 'test@example.com', role: 'owner' })),
    syncHumanIdentity: vi.fn(),
    routeMessage: vi.fn(() => AGENT_A),
    removeHumanUser: vi.fn(),
    hireAgent: vi.fn(async (req: { name: string; orgId: string }) => {
      const agent = createMockAgent(`agent-new-${Date.now()}`);
      agent.config.name = req.name;
      return agent;
    }),
    fireAgent: vi.fn(async () => {}),
    createOrganization: vi.fn(async (name: string, ownerId: string) => ({ id: 'org-new', name, ownerId, createdAt: new Date().toISOString(), status: 'active' as const })),
    getTeamDataDir: vi.fn(() => '/tmp/markus/teams/team-1'),
    buildBuilderDynamicContext: vi.fn(() => 'builder context'),
    getTeamAgentStatuses: vi.fn(() => []),
    addHumanUser: vi.fn(),
    createTeam: vi.fn(async () => ({ id: 'team-new', name: 'New Team' })),
    updateTeam: vi.fn(async () => ({ id: TEAM_1, name: 'Updated' })),
    deleteTeam: vi.fn(async () => {}),
    addTeamMember: vi.fn(async () => {}),
    removeTeamMember: vi.fn(async () => {}),
    removeMemberFromTeam: vi.fn(async () => {}),
    addMemberToTeam: vi.fn(async () => {}),
  } as unknown as OrganizationService;
}

export interface TestContext {
  server: APIServer;
  taskService: TaskService;
  storage: StorageBridge;
  agentManager: ReturnType<typeof createMockAgentManager>;
}

export function createTestServer(): TestContext {
  const agentManager = createMockAgentManager();
  const orgService = createMockOrgService(agentManager);
  const taskService = new TaskService();
  taskService.setAgentManager(agentManager as never);
  taskService.setWSBroadcaster({ broadcast: vi.fn(), broadcastTaskCreate: vi.fn(), broadcastTaskUpdate: vi.fn() } as never);
  taskService.setGovernancePolicy({
    enabled: false, defaultTier: 'auto', maxPendingTasksPerAgent: 100, maxTotalActiveTasks: 100,
    requireApprovalForPriority: [], requireRequirement: false, rules: [],
  });
  const storage = createMockStorage();
  const server = new APIServer(orgService, taskService, 0);
  server.setStorage(storage);
  server.setAuditService({ record: vi.fn(), query: vi.fn(() => []), summary: vi.fn(() => ({ total: 0, byType: {} })), getSummary: vi.fn(() => ({ total: 0 })), getTokenUsage: vi.fn(() => []) } as never);
  server.setHITLService({
    onNotification: vi.fn(),
    listApprovals: vi.fn(() => []),
    requestApproval: vi.fn(() => ({ id: 'appr-1', status: 'pending', title: 'Test' })),
    getApproval: vi.fn((id: string) => id === 'appr-pending' ? {
      id: 'appr-pending', status: 'pending', title: 'Approve task', agentId: AGENT_A,
      details: { taskId: 'task-x' },
    } : null),
    respondToApproval: vi.fn((id: string, approved: boolean) => ({
      id, status: approved ? 'approved' : 'rejected', title: 'Approve task', agentId: AGENT_A,
      details: { taskId: 'task-x' },
    })),
    listNotifications: vi.fn(() => [{ id: 'notif-1', read: false }]),
    countNotifications: vi.fn(() => ({ total: 1, unread: 1 })),
    markNotificationRead: vi.fn(() => true),
    markAllNotificationsRead: vi.fn(() => 1),
  } as never);
  server.setBillingService({
    getUsage: vi.fn(() => ({ tokens: 0, cost: 0 })), getAgentUsage: vi.fn(() => []),
    getUsageSummary: vi.fn(() => ({ storageBytes: 1024 })), setOrgPlan: vi.fn(), getOrgPlan: vi.fn(() => 'free'),
    listAPIKeys: vi.fn(() => []), createAPIKey: vi.fn(() => ({ id: 'key-1', name: 'test', prefix: 'mk_test' })),
    revokeAPIKey: vi.fn(() => true),
  } as never);
  server.setLicenseService({
    getInfo: vi.fn(() => ({ plan: 'free', features: [], limits: { maxTeams: 100, maxToolCallsPerDay: 500, maxUsers: 100 } })),
    revalidate: vi.fn(async () => ({ plan: 'free', features: [], limits: { maxTeams: 100, maxToolCallsPerDay: 500, maxUsers: 100 } })),
    getLimits: vi.fn(() => ({ maxTeams: 100, maxToolCallsPerDay: 500, maxUsers: 100 })),
    getLicenseInfo: vi.fn(async () => ({ plan: 'free', valid: true })),
    refreshLicense: vi.fn(async () => ({ success: true })), activateLicense: vi.fn(async () => ({ success: true })),
    activateTrial: vi.fn(async () => ({ success: true })), importOfflineLicense: vi.fn(() => ({ success: true })),
    deactivate: vi.fn(async () => {}), getPlan: vi.fn(() => 'free'),
  } as never);
  server.setTelemetryService({ isEnabled: vi.fn(() => false), setEnabled: vi.fn() } as never);
  server.setDeliverableService({
    search: vi.fn(() => ({ results: [], total: 0 })), checkFileHealth: vi.fn(() => []),
    create: vi.fn(async (d: Record<string, unknown>) => ({ id: 'deliv-1', ...d })),
    get: vi.fn(async (id: string) => id === 'deliv-1' ? { id, title: 'Test' } : null),
    update: vi.fn(async (id: string, data: Record<string, unknown>) => ({ id, ...data })),
    remove: vi.fn(async () => {}), flagOutdated: vi.fn(async () => {}),
  } as never);
  server.setProjectService({
    listProjects: vi.fn(() => [{ id: PROJECT_1, name: 'Project One', orgId: 'default' }]),
    getProject: vi.fn((id: string) => id === PROJECT_1 ? { id, name: 'Project One', orgId: 'default' } : null),
    createProject: vi.fn((data: Record<string, unknown>) => ({ id: 'proj-new', ...data })),
    updateProject: vi.fn((id: string, data: Record<string, unknown>) => ({ id, ...data })),
    deleteProject: vi.fn(() => true),
  } as never);
  server.setRequirementService({
    listRequirements: vi.fn(() => [{ id: REQ_1, title: 'Req One', status: 'draft' }]),
    getRequirement: vi.fn((id: string) => id === REQ_1 ? { id, title: 'Req One', orgId: 'default', projectId: PROJECT_1 } : null),
    createRequirement: vi.fn((data: Record<string, unknown>) => ({ id: 'req-new', ...data })),
    updateRequirement: vi.fn((id: string, data: Record<string, unknown>) => ({ id, ...data })),
    updateRequirementStatus: vi.fn((id: string, status: string) => ({ id, status })),
    approveRequirement: vi.fn((id: string) => ({ id, status: 'approved' })),
    rejectRequirement: vi.fn((id: string) => ({ id, status: 'rejected' })),
    cancelRequirement: vi.fn((id: string) => ({ id, status: 'cancelled' })),
    getRequirementStatusHistory: vi.fn(() => []),
    postRequirementComment: vi.fn(async () => ({ comment: { id: 'rc-1' } })),
  } as never);
  server.setWorkflowService({
    listWorkflows: vi.fn(() => []),
    addWorkflow: vi.fn(() => ({ name: 'wf', displayName: 'WF', description: '', version: 1, steps: [] })),
    getWorkflow: vi.fn((teamId: string, name: string) => name === 'wf-test' ? {
      name: 'wf-test', displayName: 'WF Test', description: '', version: 1, steps: [],
    } : null),
    updateWorkflow: vi.fn(() => ({ name: 'wf', displayName: 'WF', description: '', version: 2 })),
    removeWorkflow: vi.fn(), listRoles: vi.fn(() => []), listRuns: vi.fn(() => []), startRun: vi.fn(() => ({ id: 'run-1' })),
    buildDefaultRoleMapping: vi.fn(() => ({ developer: AGENT_A })),
  } as never);
  server.setWorkflowRunner({
    getRun: vi.fn(() => null),
    getRunAsync: vi.fn(async (id: string) => id === 'run-1' ? { id, status: 'running', teamId: TEAM_1 } : null),
    cancelRun: vi.fn(async () => {}),
    listRuns: vi.fn(async () => [{ id: 'run-1', status: 'completed' }]),
    createRun: vi.fn(async () => ({ id: 'run-new', status: 'pending' })),
  } as never);
  server.setReportService({
    listReports: vi.fn(() => []), getReport: vi.fn(() => null), generateReport: vi.fn(async () => ({ id: 'rpt-1' })),
    approvePlan: vi.fn(async () => ({})), rejectPlan: vi.fn(async () => ({})), getFeedback: vi.fn(() => []),
    addFeedback: vi.fn(async () => ({ id: 'fb-1' })),
  } as never);
  server.setKnowledgeService({ search: vi.fn(() => []), addEntry: vi.fn(async () => ({ id: 'know-1' })) } as never);
  const oauthPromise = Promise.resolve({ id: 'oauth-profile-1', provider: 'openai-codex' });
  server.setLLMRouter({
    getEnhancedSettings: vi.fn(() => ({ defaultProvider: 'openai', providers: {}, autoFallback: true, capabilityRouting: { assignments: {} } })),
    updateSettings: vi.fn(), addProvider: vi.fn(), removeProvider: vi.fn(), updateProvider: vi.fn(),
    getProvider: vi.fn(() => ({ apiKey: 'test-key', baseUrl: 'https://api.openai.com' })),
    updateProviderModelConfig: vi.fn(), testProvider: vi.fn(async () => ({ ok: true })),
    listProviders: vi.fn(() => []), setDefaultProvider: vi.fn(), setAutoFallback: vi.fn(),
    setCapabilityRouting: vi.fn(), setRoutingDefaultModel: vi.fn(), capabilityRouting: { assignments: {} },
    getModelCatalog: vi.fn(() => [{ id: 'gpt-4', provider: 'openai' }]),
    registerOAuthProvider: vi.fn(),
    setProviderEnabled: vi.fn(),
    unregisterProvider: vi.fn(),
    addCustomModel: vi.fn(),
    setProviderModel: vi.fn(),
    getSettings: vi.fn(() => ({ defaultProvider: 'openai', providers: { openai: { enabled: true } } })),
    removeCustomModel: vi.fn(),
    oauthManager: {
      startLogin: vi.fn(async () => ({ authorizeUrl: 'https://oauth.example/auth', promise: oauthPromise })),
      startDeviceCodeLogin: vi.fn(async () => ({ userCode: 'ABCD-1234', verificationUri: 'https://oauth.example/device', promise: oauthPromise })),
      handleCallback: vi.fn(async () => ({ id: 'oauth-profile-1' })),
      createSetupToken: vi.fn(async () => ({ token: 'setup-tok', expiresAt: Date.now() + 3600000 })),
    },
  } as never);
  server.setModelCatalog({
    getModelsByProvider: vi.fn(() => [{ id: 'gpt-4', name: 'GPT-4' }]),
    getAllProviders: vi.fn(() => ['openai']), getStatus: vi.fn(() => ({ loaded: true })),
    refresh: vi.fn(async () => true), getModelInfo: vi.fn(() => null),
  } as never);
  server.setReviewService({
    createReview: vi.fn(() => ({ id: 'rev-1' })), getReview: vi.fn(() => null), listReviews: vi.fn(() => []),
    getRecentReports: vi.fn(() => []), getReportsByTask: vi.fn(() => []), getReport: vi.fn(() => null),
  } as never);
  server.setGateway({
    listRegistrations: vi.fn(() => []), unregister: vi.fn(async () => {}),
    register: vi.fn(async () => ({ externalAgentId: 'ext-1' })),
    authenticate: vi.fn(async () => ({ token: 'gw-token' })),
    verifyToken: vi.fn(() => ({ markusAgentId: AGENT_A, orgId: 'default' })),
    handleMessage: vi.fn(async () => ({ reply: 'ok' })),
    routeMessage: vi.fn(async () => ({ reply: 'ok' })),
    getStatus: vi.fn(() => ({ connected: true, agents: 1 })),
    resetConnectionStatus: vi.fn(),
  } as never, 'gw-secret');
  server.setFileStorage({
    upload: vi.fn(async (_buf: Buffer, opts: { name: string; contentType: string; prefix?: string }) => ({
      url: `/api/uploads/${opts.prefix ?? 'default'}/${opts.name}`,
      key: `${opts.prefix ?? 'default'}/${opts.name}`,
    })),
    resolve: vi.fn((key: string) => `/tmp/markus/uploads/${key}`),
  } as never);
  return { server, taskService, storage, agentManager };
}
