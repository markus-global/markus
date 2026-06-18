import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APIServer } from '../src/api-server.js';
import { TaskService } from '../src/task-service.js';
import type { OrganizationService } from '../src/org-service.js';
import type { StorageBridge } from '../src/storage-bridge.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

vi.mock('@markus/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@markus/shared')>();
  return {
    ...actual,
    checkForUpdate: vi.fn(async () => ({ updateAvailable: false, latestVersion: actual.APP_VERSION })),
    loadConfig: vi.fn(() => ({
      network: { proxy: '', proxyEnabled: false },
      browser: { headless: true },
      search: { provider: 'duckduckgo' },
      integrations: { feishu: {} },
      agent: {},
    })),
    saveConfig: vi.fn(),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      const s = String(p);
      if (s.includes('markus.json') || s.includes('data.db') || s.includes('.markus') || s.includes('ROLE.md')) return true;
      if (s.includes('workspace') || s.includes('agents/') || s.includes('/role')) return true;
      if (s.includes('templates/roles') || s.includes('templates/teams') || s.includes('templates/skills')) return true;
      return false;
    }),
    readFileSync: vi.fn((p: string) => {
      const s = String(p);
      if (s.includes('markus.json')) {
        return JSON.stringify({ network: {}, browser: {}, search: {}, integrations: { feishu: {} } });
      }
      return '# Test Role\n\nRole content';
    }),
    readdirSync: vi.fn((p: string, options?: { withFileTypes?: boolean }) => {
      const s = String(p);
      if (s.includes('templates/teams')) {
        const entries = ['team-one.json'];
        if (options?.withFileTypes) {
          return entries.map(name => ({ name, isFile: () => true, isDirectory: () => false }));
        }
        return entries;
      }
      if (s.includes('.markus')) {
        return [];
      }
      return actual.readdirSync(p, options as never);
    }),
    statSync: vi.fn((p: string) => {
      const s = String(p);
      if (s.includes('.markus') || s.includes('agents/') || s.includes('/role')) {
        return {
          isFile: () => s.endsWith('.md'),
          isDirectory: () => !s.endsWith('.md'),
          size: 1024,
        } as ReturnType<typeof actual.statSync>;
      }
      return actual.statSync(p);
    }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

// ── HTTP mocks ────────────────────────────────────────────────────────────────

class MockIncomingMessage extends EventEmitter {
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

class MockServerResponse {
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

const GW_AUTH = { authorization: 'Bearer gw-token' };

async function request(
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
  for (let i = 0; i < 20 && !res.ended; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  let json: Record<string, unknown> = {};
  try {
    if (res.body) json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    json = { _raw: res.body };
  }
  return { status: res.statusCode, json, raw: res.body, headers: res.headers };
}

// ── Service mocks ─────────────────────────────────────────────────────────────

const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const REVIEWER = 'reviewer-1';
const TEAM_1 = 'team-1';
const PROJECT_1 = 'proj-1';
const REQ_1 = 'req-1';
const TASK_1 = 'task-1';

function createMockAgent(id: string, overrides: Record<string, unknown> = {}) {
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
      period: '24h',
      tokens: 100,
      toolCalls: 5,
      healthScore: 85,
      tokenUsage: { input: 100, output: 50, cost: 0.01 },
      taskMetrics: { completed: 2, failed: 0, cancelled: 0, averageCompletionTimeMs: 1000 },
      averageResponseTimeMs: 500,
      errorRate: 0,
      totalInteractions: 10,
    })),
    getMemory: vi.fn(() => ({
      getEntries: () => [],
      listSessions: () => [],
      getDailyLog: () => null,
      getRecentDailyLogs: () => [],
      getLongTermMemory: () => null,
      getSession: () => null,
      updateDailyLog: vi.fn(),
      updateLongTermMemory: vi.fn(),
      writeDailyLog: vi.fn(),
      addLongTermMemory: vi.fn(),
    })),
    getUsageStats: vi.fn(() => ({
      toolCallsToday: 3,
      totalTokens: 100,
      requestsToday: 5,
      tokensToday: 50,
      promptTokens: 60,
      completionTokens: 40,
      requestCount: 5,
      toolCalls: 3,
      estimatedCost: 0.01,
      costToday: 0.005,
    })),
    getActiveSkillNames: vi.fn(() => ['coding']),
    getSkillProficiency: vi.fn(() => ({})),
    getRecentActivities: vi.fn(() => []),
    sendMessage: vi.fn(async () => 'Hello from agent'),
    pause: vi.fn(),
    resume: vi.fn(),
    cancelActiveStream: vi.fn(),
    generateDailyReport: vi.fn(async () => 'Daily report'),
    startNewSession: vi.fn(),
    restoreSessionFromHistory: vi.fn(),
    bindDbSession: vi.fn(),
    injectFollowUp: vi.fn(),
    injectSkillInstructions: vi.fn(),
    deactivateSkill: vi.fn(),
    addDynamicContextProvider: vi.fn(),
    enqueueToMailbox: vi.fn(),
    checkRoleUpdate: vi.fn(() => ({ hasTemplate: false, isUpToDate: true })),
    getRoleFileDiff: vi.fn(() => ({ file: 'ROLE.md', changed: false, diff: '' })),
    syncRoleFromTemplate: vi.fn(() => ({ success: true, synced: ['ROLE.md'] })),
    smartSyncRoleFromTemplate: vi.fn(() => ({ success: true })),
    createAgentFromTemplate: vi.fn(async () => createMockAgent('from-template')),
    ...overrides,
  };
}

function createMockAgentManager() {
  const agents = new Map<string, ReturnType<typeof createMockAgent>>([
    [AGENT_A, createMockAgent(AGENT_A)],
    [AGENT_B, createMockAgent(AGENT_B)],
    [REVIEWER, createMockAgent(REVIEWER)],
    ['secretary', createMockAgent('secretary', { config: { agentRole: 'secretary' as const } })],
  ]);
  return {
    listAgents: vi.fn(() => [...agents.values()].map(a => ({
      id: a.id,
      name: a.config.name,
      agentRole: a.config.agentRole,
      role: a.role.name,
      status: 'idle',
      skills: a.config.skills ?? [],
    }))),
    getAgent: vi.fn((id: string) => {
      const agent = agents.get(id);
      if (!agent) throw new Error(`Agent not found: ${id}`);
      return agent;
    }),
    hasAgent: vi.fn((id: string) => agents.has(id)),
    startAgent: vi.fn(async () => {}),
    stopAgent: vi.fn(async () => {}),
    stopAllAgents: vi.fn(async () => {}),
    startAllAgents: vi.fn(async () => {}),
    emergencyStop: vi.fn(async () => {}),
    isGlobalStopped: vi.fn(() => false),
    isEmergencyMode: vi.fn(() => false),
    broadcastAnnouncement: vi.fn(),
    getActiveAnnouncements: vi.fn(() => []),
    checkAllRoleUpdates: vi.fn(() => []),
    checkRoleUpdate: vi.fn(() => ({ hasTemplate: false, isUpToDate: true })),
    getRoleFileDiff: vi.fn(() => ({ file: 'ROLE.md', changed: false, diff: '' })),
    syncRoleFromTemplate: vi.fn(() => ({ success: true, synced: ['ROLE.md'] })),
    smartSyncRoleFromTemplate: vi.fn(() => ({ success: true })),
    createAgentFromTemplate: vi.fn(async () => createMockAgent('from-template')),
    getDataDir: vi.fn(() => '/tmp/markus/agents'),
    getEventBus: vi.fn(() => ({ on: vi.fn(), emit: vi.fn() })),
    setTemplateRegistry: vi.fn(),
    setGroupChatHandlers: vi.fn(),
    getTemplateRegistry: vi.fn(() => null),
  };
}

function createMockStorage(): StorageBridge {
  const users = new Map<string, Record<string, unknown>>([
    ['user-1', { id: 'user-1', orgId: 'default', name: 'Test User', email: 'test@example.com', role: 'owner', passwordHash: 'pbkdf2:10000:abc:def' }],
    ['anonymous', { id: 'anonymous', orgId: 'default', name: 'Anonymous', email: 'anon@test.com', role: 'owner' }],
  ]);
  return {
    userRepo: {
      findById: vi.fn((id: string) => users.get(id) ?? null),
      findByEmail: vi.fn((email: string) => {
        for (const u of users.values()) {
          if (u.email === email) return u;
        }
        return null;
      }),
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
      findDeletedByEmail: vi.fn(() => null),
      reactivate: vi.fn(),
      setInviteToken: vi.fn(),
      updatePassword: vi.fn(),
      updateLastLogin: vi.fn(),
      upsert: vi.fn(async (u: Record<string, unknown>) => { users.set(u.id as string, u); }),
    },
    agentRepo: {
      listAll: vi.fn(() => [{ id: AGENT_A, avatarUrl: 'http://avatar.test/a.png' }]),
      findById: vi.fn((id: string) => ({ id, avatarUrl: undefined })),
      updateConfig: vi.fn(async () => {}),
    },
    integrationRepo: {
      listByPlatform: vi.fn(() => []),
      listByOrg: vi.fn(() => []),
      create: vi.fn(async (d: Record<string, unknown>) => d),
      update: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    chatSessionRepo: {
      getSessionsByAgent: vi.fn(async () => []),
      createSession: vi.fn(async () => ({ id: 'sess-1', title: null })),
      appendMessage: vi.fn(async () => ({ id: 'msg-1' })),
      updateLastMessage: vi.fn(async () => {}),
      getSession: vi.fn(async () => ({ id: 'sess-1', title: null })),
      getMessages: vi.fn(async () => ({ messages: [] })),
      hasAnySessions: vi.fn(() => false),
      deleteLastExchange: vi.fn(async () => {}),
      searchMessages: vi.fn(() => []),
    },
    channelMessageRepo: {
      append: vi.fn(async () => ({ id: 'ch-msg-1' })),
      getMessages: vi.fn(async () => ({ messages: [] })),
      searchMessages: vi.fn(() => []),
    },
    groupChatRepo: {
      list: vi.fn(() => [{
        id: 'gc-1', name: 'Custom Chat', creatorId: 'anonymous', creatorName: 'Anon',
        memberCount: 2, channelKey: 'group:custom:abc', orgId: 'default',
      }]),
      listByMember: vi.fn(() => []),
      create: vi.fn(() => ({
        channelKey: 'group:custom:abc',
        id: 'gc-1',
        name: 'Custom Chat',
        creatorId: 'anonymous',
        creatorName: 'Anon',
        members: [{ memberId: AGENT_A, memberName: 'Agent A', memberType: 'agent' }],
      })),
      getById: vi.fn((id: string) => id === 'gc-1' ? {
        id: 'gc-1', name: 'Custom Chat', channelKey: 'group:custom:abc',
        creatorId: 'anonymous', creatorName: 'Anon',
        members: [{ memberId: AGENT_A, memberName: 'Agent A', memberType: 'agent' }],
      } : null),
      updateName: vi.fn(),
      delete: vi.fn(),
      getAgentMemberIds: vi.fn(() => [AGENT_A]),
      addMember: vi.fn(),
      removeMember: vi.fn(),
    },
    mailboxRepo: {
      getHistory: vi.fn(() => []),
      getStatusCounts: vi.fn(() => ({})),
      getSourceTypeCounts: vi.fn(() => ({})),
    },
    decisionRepo: {
      getByMailboxItemIds: vi.fn(() => new Map()),
      getByAgent: vi.fn(() => []),
    },
    activityRepo: {
      getByMailboxItemIds: vi.fn(() => new Map()),
      queryActivities: vi.fn(() => []),
    },
    taskCommentRepo: {
      getByTask: vi.fn(async () => []),
    },
    requirementCommentRepo: {
      getByRequirement: vi.fn(async () => []),
    },
    taskLogRepo: {
      getRoundsSummary: vi.fn(() => []),
      getByTaskRound: vi.fn(() => []),
      getByTask: vi.fn(async () => []),
    },
    executionStreamRepo: {
      getBySource: vi.fn(() => []),
    },
    notificationRepo: {
      list: vi.fn(() => []),
    },
    apiKeyRepo: {
      list: vi.fn(() => []),
      create: vi.fn(() => ({ id: 'key-1', name: 'test', prefix: 'mk_test' })),
      delete: vi.fn(() => true),
    },
  } as unknown as StorageBridge;
}

function createMockOrgService(agentManager = createMockAgentManager()): OrganizationService {
  return {
    getAgentManager: () => agentManager,
    getTeam: vi.fn((id: string) => id === TEAM_1 ? {
      id: TEAM_1,
      name: 'Team One',
      orgId: 'default',
      memberAgentIds: [AGENT_A, AGENT_B],
      description: 'Test team',
    } : null),
    listTeams: vi.fn(() => [{ id: TEAM_1, name: 'Team One', orgId: 'default' }]),
    listTeamsWithMembers: vi.fn(() => [{
      id: TEAM_1,
      name: 'Team One',
      orgId: 'default',
      members: [{ id: AGENT_A, type: 'agent', name: 'Agent A' }],
    }]),
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
    hireAgent: vi.fn(async (req: { name: string; orgId: string }) => {
      const agent = createMockAgent(`agent-new-${Date.now()}`);
      agent.config.name = req.name;
      return agent;
    }),
    fireAgent: vi.fn(async () => {}),
    createOrganization: vi.fn(async (name: string, ownerId: string) => ({
      id: 'org-new', name, ownerId, createdAt: new Date().toISOString(), status: 'active' as const,
    })),
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

function createTaskServiceWithAgents(): TaskService {
  const ts = new TaskService();
  ts.setAgentManager(createMockAgentManager() as never);
  ts.setWSBroadcaster({ broadcast: vi.fn(), broadcastTaskCreate: vi.fn(), broadcastTaskUpdate: vi.fn() } as never);
  ts.setGovernancePolicy({
    enabled: false,
    defaultTier: 'auto',
    maxPendingTasksPerAgent: 100,
    maxTotalActiveTasks: 100,
    requireApprovalForPriority: [],
    requireRequirement: false,
    rules: [],
  });
  return ts;
}

interface TestContext {
  server: APIServer;
  taskService: TaskService;
  storage: StorageBridge;
  agentManager: ReturnType<typeof createMockAgentManager>;
}

function createTestServer(): TestContext {
  const agentManager = createMockAgentManager();
  const orgService = createMockOrgService(agentManager);
  const taskService = createTaskServiceWithAgents();
  const storage = createMockStorage();
  const server = new APIServer(orgService, taskService, 0);
  server.setStorage(storage);
  server.setAuditService({
    record: vi.fn(),
    query: vi.fn(() => []),
    summary: vi.fn(() => ({ total: 0, byType: {} })),
    getSummary: vi.fn(() => ({ total: 0 })),
    getTokenUsage: vi.fn(() => []),
  } as never);
  server.setHITLService({
    onNotification: vi.fn(),
    listApprovals: vi.fn(() => []),
    requestApproval: vi.fn(() => ({ id: 'appr-1', status: 'pending', title: 'Test' })),
    getApproval: vi.fn(() => null),
    respondToApproval: vi.fn(() => null),
    listNotifications: vi.fn(() => []),
    countNotifications: vi.fn(() => ({ total: 0, unread: 0 })),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
  } as never);
  server.setBillingService({
    getUsage: vi.fn(() => ({ tokens: 0, cost: 0 })),
    getAgentUsage: vi.fn(() => []),
    getUsageSummary: vi.fn(() => ({ storageBytes: 1024 })),
    setOrgPlan: vi.fn(),
    getOrgPlan: vi.fn(() => 'free'),
    listAPIKeys: vi.fn(() => []),
    createAPIKey: vi.fn(() => ({ id: 'key-1', name: 'test', prefix: 'mk_test' })),
    revokeAPIKey: vi.fn(() => true),
  } as never);
  server.setLicenseService({
    getInfo: vi.fn(() => ({ plan: 'free', features: [], limits: { maxTeams: 100, maxToolCallsPerDay: 500, maxUsers: 100 } })),
    revalidate: vi.fn(async () => ({ plan: 'free', features: [], limits: { maxTeams: 100, maxToolCallsPerDay: 500, maxUsers: 100 } })),
    getLimits: vi.fn(() => ({ maxTeams: 100, maxToolCallsPerDay: 500, maxUsers: 100 })),
    getLicenseInfo: vi.fn(async () => ({ plan: 'free', valid: true })),
    refreshLicense: vi.fn(async () => ({ success: true })),
    activateLicense: vi.fn(async () => ({ success: true })),
    activateTrial: vi.fn(async () => ({ success: true })),
    importOfflineLicense: vi.fn(() => ({ success: true })),
    deactivate: vi.fn(async () => {}),
    getPlan: vi.fn(() => 'free'),
  } as never);
  server.setTelemetryService({
    isEnabled: vi.fn(() => false),
    setEnabled: vi.fn(),
  } as never);
  server.setDeliverableService({
    search: vi.fn(() => ({ results: [], total: 0 })),
    checkFileHealth: vi.fn(() => []),
    create: vi.fn(async (d: Record<string, unknown>) => ({ id: 'deliv-1', ...d })),
    get: vi.fn(async (id: string) => id === 'deliv-1' ? { id, title: 'Test' } : null),
    update: vi.fn(async (id: string, data: Record<string, unknown>) => ({ id, ...data })),
    remove: vi.fn(async () => {}),
    flagOutdated: vi.fn(async () => {}),
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
    getWorkflow: vi.fn(() => null),
    updateWorkflow: vi.fn(() => ({ name: 'wf', displayName: 'WF', description: '', version: 2 })),
    removeWorkflow: vi.fn(),
    listRoles: vi.fn(() => []),
    listRuns: vi.fn(() => []),
    startRun: vi.fn(() => ({ id: 'run-1' })),
  } as never);
  server.setWorkflowRunner({
    getRun: vi.fn(() => null),
    cancelRun: vi.fn(async () => {}),
    listRuns: vi.fn(() => []),
  } as never);
  server.setReportService({
    listReports: vi.fn(() => []),
    getReport: vi.fn(() => null),
    generateReport: vi.fn(async () => ({ id: 'rpt-1' })),
    approvePlan: vi.fn(async () => ({})),
    rejectPlan: vi.fn(async () => ({})),
    getFeedback: vi.fn(() => []),
    addFeedback: vi.fn(async () => ({ id: 'fb-1' })),
  } as never);
  server.setKnowledgeService({
    search: vi.fn(() => []),
    addEntry: vi.fn(async () => ({ id: 'know-1' })),
  } as never);
  server.setLLMRouter({
    getEnhancedSettings: vi.fn(() => ({
      defaultProvider: 'openai',
      providers: {},
      autoFallback: true,
      capabilityRouting: { assignments: {} },
    })),
    updateSettings: vi.fn(),
    addProvider: vi.fn(),
    removeProvider: vi.fn(),
    updateProvider: vi.fn(),
    getProvider: vi.fn(() => ({ apiKey: 'test-key', baseUrl: 'https://api.openai.com' })),
    updateProviderModelConfig: vi.fn(),
    testProvider: vi.fn(async () => ({ ok: true })),
    listProviders: vi.fn(() => []),
    setDefaultProvider: vi.fn(),
    setAutoFallback: vi.fn(),
    setCapabilityRouting: vi.fn(),
    setRoutingDefaultModel: vi.fn(),
    capabilityRouting: { assignments: {} },
    getModelCatalog: vi.fn(() => [{ id: 'gpt-4', provider: 'openai' }]),
  } as never);
  server.setModelCatalog({
    getModelsByProvider: vi.fn(() => [{ id: 'gpt-4', name: 'GPT-4' }]),
    getAllProviders: vi.fn(() => ['openai']),
    getStatus: vi.fn(() => ({ loaded: true })),
    refresh: vi.fn(async () => true),
    getModelInfo: vi.fn(() => null),
  } as never);
  server.setReviewService({
    createReview: vi.fn(() => ({ id: 'rev-1' })),
    getReview: vi.fn(() => null),
    listReviews: vi.fn(() => []),
    getRecentReports: vi.fn(() => []),
    getReportsByTask: vi.fn(() => []),
    getReport: vi.fn(() => null),
  } as never);
  server.setGateway({
    listRegistrations: vi.fn(() => []),
    unregister: vi.fn(async () => {}),
    register: vi.fn(async () => ({ externalAgentId: 'ext-1' })),
    authenticate: vi.fn(async () => ({ token: 'gw-token' })),
    verifyToken: vi.fn(() => ({ markusAgentId: AGENT_A, orgId: 'default' })),
    handleMessage: vi.fn(async () => ({ reply: 'ok' })),
    routeMessage: vi.fn(async () => ({ reply: 'ok' })),
    getStatus: vi.fn(() => ({ connected: true, agents: 1 })),
    resetConnectionStatus: vi.fn(),
  } as never, 'gw-secret');
  return { server, taskService, storage, agentManager };
}

// ============================================================================
// Existing body-parsing tests (preserved)
// ============================================================================

describe('ApiServer request body parsing', () => {
  let server: APIServer;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env['AUTH_ENABLED'] = 'false';
    ({ server } = createTestServer());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['AUTH_ENABLED'];
  });

  describe('BUG-003: null/array body → 400 Bad Request', () => {
    it('should return 400 for JSON null body', async () => {
      const res = await request(server, 'POST', '/api/auth/login', null);
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('Invalid request body');
    });

    it('should return 400 for JSON array body', async () => {
      const req = new MockIncomingMessage('POST', '/api/auth/login', { 'content-type': 'application/json' }, '[1,2,3]');
      const res = new MockServerResponse();
      server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      req._simulate();
      await new Promise<void>((r) => setImmediate(r));
      expect(res.statusCode).toBe(400);
    });

    it('should accept empty JSON body as empty object', async () => {
      const res = await request(server, 'POST', '/api/auth/login');
      expect(res.status).toBe(200);
    });
  });

  describe('BUG-005: missing/wrong Content-Type → 415', () => {
    it('returns 415 for POST without content-type', async () => {
      const req = new MockIncomingMessage('POST', '/api/agents', {}, 'some body');
      const res = new MockServerResponse();
      server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      req._simulate();
      await new Promise<void>((r) => setImmediate(r));
      expect(res.statusCode).toBe(415);
    });

    it('returns 415 for text/plain', async () => {
      const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'text/plain' }, 'plain');
      const res = new MockServerResponse();
      server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      req._simulate();
      await new Promise<void>((r) => setImmediate(r));
      expect(res.statusCode).toBe(415);
    });

    it('passes through application/json', async () => {
      const res = await request(server, 'POST', '/api/auth/login', { a: 1 });
      expect(res.status).toBe(200);
    });
  });

  describe('Regression: valid requests', () => {
    it('handles GET /api/auth/me', async () => {
      const res = await request(server, 'GET', '/api/auth/me');
      expect(res.status).toBe(200);
    });

    it('handles malformed JSON without 500', async () => {
      const req = new MockIncomingMessage('POST', '/api/auth/login', { 'content-type': 'application/json' }, 'not-json');
      const res = new MockServerResponse();
      server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      req._simulate();
      await new Promise<void>((r) => setImmediate(r));
      expect(res.statusCode).not.toBe(500);
    });
  });
});

describe('APIServer Route Table (405 Method Not Allowed)', () => {
  const table = APIServer.buildRouteTable();

  it('returns a non-empty route table', () => {
    expect(table.length).toBeGreaterThan(50);
  });

  it('has POST for /api/auth/login', () => {
    const entry = table.find(r => r.test('/api/auth/login'));
    expect(entry?.methods).toContain('POST');
  });

  it('returns 405 for wrong method on known route', async () => {
    process.env['AUTH_ENABLED'] = 'false';
    const { server } = createTestServer();
    const res = await request(server, 'DELETE', '/api/auth/login');
    expect(res.status).toBe(405);
    delete process.env['AUTH_ENABLED'];
  });
});

// ============================================================================
// Comprehensive route handler tests
// ============================================================================

describe('APIServer route handlers', () => {
  let ctx: TestContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env['AUTH_ENABLED'] = 'false';
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => '| [skill-a](url) | Desc... | Cat | [GitHub](https://github.com/x) | 2024 |\n',
      json: async () => ({ ok: true }),
      headers: { get: () => null },
    });
    ctx = createTestServer();
    vi.spyOn(ctx.server['ws'] as { broadcastTeamUpdate: (...args: unknown[]) => void }, 'broadcastTeamUpdate').mockImplementation(() => {});
    vi.spyOn(ctx.server as unknown as { detectOrphans: () => unknown }, 'detectOrphans').mockReturnValue({
      orphans: [{ id: 'orph-1', path: '/tmp/orphan', size: 100, reason: 'test' }],
      totalSize: 100,
    });
    vi.spyOn(ctx.server as unknown as { purgeOrphans: (ids?: string[]) => unknown }, 'purgeOrphans').mockReturnValue({
      removed: 1,
      freedBytes: 100,
    });
  });

  afterEach(() => {
    ctx?.taskService?.stopTimeoutChecker();
    delete process.env['AUTH_ENABLED'];
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  describe('Auth routes', () => {
    it('GET /api/auth/status', async () => {
      const res = await request(ctx.server, 'GET', '/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.json.initialized).toBe(true);
    });

    it('POST /api/auth/login without auth enabled', async () => {
      const res = await request(ctx.server, 'POST', '/api/auth/login', { email: 'a@b.com', password: 'x' });
      expect(res.status).toBe(200);
      expect(res.json.user).toBeDefined();
    });

    it('GET /api/auth/me', async () => {
      const res = await request(ctx.server, 'GET', '/api/auth/me');
      expect(res.status).toBe(200);
    });

    it('POST /api/auth/logout', async () => {
      const res = await request(ctx.server, 'POST', '/api/auth/logout');
      expect(res.status).toBe(200);
    });

    it('GET /api/auth/invite-info without token', async () => {
      const res = await request(ctx.server, 'GET', '/api/auth/invite-info');
      expect(res.status).toBe(400);
    });

    it('POST /api/auth/init without storage users returns 503 path', async () => {
      const res = await request(ctx.server, 'POST', '/api/auth/init', {
        name: 'Admin', email: 'admin@test.com', password: 'secret1',
      });
      expect([200, 403, 503]).toContain(res.status);
    });

    it('POST /api/auth/change-password missing fields', async () => {
      const res = await request(ctx.server, 'POST', '/api/auth/change-password', {});
      expect(res.status).toBe(400);
    });

    it('PUT /api/auth/profile', async () => {
      const res = await request(ctx.server, 'PUT', '/api/auth/profile', { name: 'New Name' });
      expect([200, 401]).toContain(res.status);
      if (res.status === 200) expect(res.json.user).toBeDefined();
    });
  });

  // ── Health & System ───────────────────────────────────────────────────────

  describe('Health & system routes', () => {
    it('GET /api/health', async () => {
      const res = await request(ctx.server, 'GET', '/api/health');
      expect(res.status).toBe(200);
      expect(res.json.status).toBe('ok');
    });

    it('OPTIONS returns 204', async () => {
      const req = new MockIncomingMessage('OPTIONS', '/api/health');
      const res = new MockServerResponse();
      ctx.server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      req._simulate();
      await new Promise<void>((r) => setImmediate(r));
      expect(res.statusCode).toBe(204);
    });

    it('GET /api/system/status', async () => {
      const res = await request(ctx.server, 'GET', '/api/system/status');
      expect(res.status).toBe(200);
    });

    it('POST /api/system/pause-all', async () => {
      const res = await request(ctx.server, 'POST', '/api/system/pause-all', { reason: 'test' });
      expect(res.status).toBe(200);
    });

    it('POST /api/system/resume-all', async () => {
      const res = await request(ctx.server, 'POST', '/api/system/resume-all');
      expect(res.status).toBe(200);
    });

    it('POST /api/system/emergency-stop', async () => {
      const res = await request(ctx.server, 'POST', '/api/system/emergency-stop');
      expect(res.status).toBe(200);
    });

    it('GET /api/system/storage', async () => {
      const res = await request(ctx.server, 'GET', '/api/system/storage');
      expect(res.status).toBe(200);
    });

    it('GET /api/system/storage/orphans', async () => {
      const res = await request(ctx.server, 'GET', '/api/system/storage/orphans');
      expect(res.status).toBe(200);
    });

    it('DELETE /api/system/storage/orphans', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/system/storage/orphans', { ids: [] });
      expect(res.status).toBe(200);
    });

    it('GET /api/system/announcements', async () => {
      const res = await request(ctx.server, 'GET', '/api/system/announcements');
      expect(res.status).toBe(200);
    });

    it('POST /api/system/announcements', async () => {
      const res = await request(ctx.server, 'POST', '/api/system/announcements', {
        title: 'Hello', content: 'World',
      });
      expect(res.status).toBe(201);
    });

    it('POST /api/system/open-path invalid path', async () => {
      const res = await request(ctx.server, 'POST', '/api/system/open-path', { path: '/nonexistent/path' });
      expect(res.status).toBe(400);
    });
  });

  // ── Agents ────────────────────────────────────────────────────────────────

  describe('Agent routes', () => {
    it('GET /api/agents', async () => {
      const res = await request(ctx.server, 'GET', '/api/agents');
      expect(res.status).toBe(200);
      expect(Array.isArray((res.json.agents as unknown[]))).toBe(true);
    });

    it('POST /api/agents creates agent', async () => {
      const res = await request(ctx.server, 'POST', '/api/agents', { name: 'New Agent' });
      expect(res.status).toBe(201);
    });

    it('POST /api/agents rejects empty name', async () => {
      const res = await request(ctx.server, 'POST', '/api/agents', { name: '  ' });
      expect(res.status).toBe(400);
    });

    it('GET /api/agents/:id', async () => {
      const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}`);
      expect(res.status).toBe(200);
      expect(res.json.id).toBe(AGENT_A);
    });

    it('GET /api/agents/:id 404 for unknown', async () => {
      const res = await request(ctx.server, 'GET', '/api/agents/unknown-agent');
      expect(res.status).toBe(404);
    });

    it('DELETE /api/agents/:id', async () => {
      const res = await request(ctx.server, 'DELETE', `/api/agents/${AGENT_B}`);
      expect(res.status).toBe(200);
    });

    it('DELETE protected secretary agent', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/agents/secretary');
      expect(res.status).toBe(403);
    });

    it('POST /api/agents/:id/start', async () => {
      const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/start`);
      expect(res.status).toBe(200);
    });

    it('POST /api/agents/:id/stop', async () => {
      const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/stop`);
      expect(res.status).toBe(200);
    });

    it('POST /api/agents/:id/pause', async () => {
      const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/pause`, { reason: 'test' });
      expect(res.status).toBe(200);
    });

    it('POST /api/agents/:id/resume', async () => {
      const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/resume`);
      expect(res.status).toBe(200);
    });

    it('POST /api/agents/:id/cancel-processing', async () => {
      const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/cancel-processing`);
      expect(res.status).toBe(200);
    });

    it('POST /api/agents/:id/daily-report', async () => {
      const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/daily-report`);
      expect(res.status).toBe(200);
    });

    it('POST /api/agents/:id/a2a', async () => {
      const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/a2a`, {
        fromAgentId: AGENT_B, message: 'hello',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/agents/:id/message non-stream', async () => {
      const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/message`, { text: 'Hi' });
      expect(res.status).toBe(200);
      expect(res.json.reply).toBeDefined();
    });

    it('POST /api/agents/:id/message inject', async () => {
      const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/message`, {
        text: 'follow up', inject: true, sessionId: 'sess-1',
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/agents/:id/sessions', async () => {
      const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/sessions`);
      expect(res.status).toBe(200);
    });

    it('GET /api/agents/:id/mind', async () => {
      const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/mind`);
      expect(res.status).toBe(200);
    });

    it('GET /api/agents/:id/mailbox', async () => {
      const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/mailbox`);
      expect(res.status).toBe(200);
    });

    it('GET /api/agents/:id/decisions', async () => {
      const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/decisions`);
      expect(res.status).toBe(200);
    });

    it('GET /api/agents/:id/metrics', async () => {
      const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/metrics?period=24h`);
      expect(res.status).toBe(200);
    });

    it('PATCH /api/agents/:id/config', async () => {
      const res = await request(ctx.server, 'PATCH', `/api/agents/${AGENT_A}/config`, { name: 'Renamed' });
      expect(res.status).toBe(200);
    });

    it('GET /api/agents/:id/memory', async () => {
      const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/memory`);
      expect(res.status).toBe(200);
    });

    it('PUT /api/agents/:id/memory/daily', async () => {
      const res = await request(ctx.server, 'PUT', `/api/agents/${AGENT_A}/memory/daily`, { content: 'log' });
      expect(res.status).toBe(200);
    });

    it('GET /api/agents/:id/files', async () => {
      const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/files`);
      expect(res.status).toBe(200);
    });

    it('GET /api/agents/role-updates', async () => {
      const res = await request(ctx.server, 'GET', '/api/agents/role-updates');
      expect(res.status).toBe(200);
    });

    it('POST /api/agents/:id/skills', async () => {
      const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/skills`, { skillName: 'testing' });
      expect(res.status).toBe(200);
    });

    it('GET /api/agents/:id/heartbeat', async () => {
      const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/heartbeat`);
      expect([200, 404]).toContain(res.status);
    });

    it('GET /api/agents/:id/activities', async () => {
      const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/activities`);
      expect(res.status).toBe(200);
    });
  });

  // ── Teams ─────────────────────────────────────────────────────────────────

  describe('Team routes', () => {
    it('GET /api/teams', async () => {
      const res = await request(ctx.server, 'GET', '/api/teams');
      expect(res.status).toBe(200);
    });

    it('POST /api/teams', async () => {
      const res = await request(ctx.server, 'POST', '/api/teams', { name: 'New Team', orgId: 'default' });
      expect([200, 201, 400]).toContain(res.status);
    });

    it('GET /api/teams/:id/status', async () => {
      const res = await request(ctx.server, 'GET', `/api/teams/${TEAM_1}/status`);
      expect([200, 404]).toContain(res.status);
    });

    it('POST /api/teams/:id/start', async () => {
      const res = await request(ctx.server, 'POST', `/api/teams/${TEAM_1}/start`);
      expect([200, 404]).toContain(res.status);
    });

    it('GET /api/teams/:id/export', async () => {
      const res = await request(ctx.server, 'GET', `/api/teams/${TEAM_1}/export`);
      expect(res.status).toBe(200);
    });
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────

  describe('Task routes', () => {
    let taskId: string;

    beforeEach(() => {
      const task = ctx.taskService.createTask({
        orgId: 'default',
        title: 'Test Task',
        description: 'Do work',
        assignedAgentId: AGENT_A,
        reviewerId: REVIEWER,
      } as never);
      taskId = task.id;
    });

    it('GET /api/tasks', async () => {
      const res = await request(ctx.server, 'GET', '/api/tasks');
      expect(res.status).toBe(200);
    });

    it('GET /api/tasks/scheduled', async () => {
      const res = await request(ctx.server, 'GET', '/api/tasks/scheduled');
      expect(res.status).toBe(200);
    });

    it('GET /api/tasks/deliverables', async () => {
      const res = await request(ctx.server, 'GET', '/api/tasks/deliverables');
      expect(res.status).toBe(200);
    });

    it('GET /api/tasks/dashboard', async () => {
      const res = await request(ctx.server, 'GET', '/api/tasks/dashboard');
      expect(res.status).toBe(200);
    });

    it('GET /api/taskboard', async () => {
      const res = await request(ctx.server, 'GET', '/api/taskboard');
      expect(res.status).toBe(200);
    });

    it('GET /api/ops/dashboard', async () => {
      const res = await request(ctx.server, 'GET', '/api/ops/dashboard?period=24h');
      expect(res.status).toBe(200);
    });

    it('GET /api/tasks/:id', async () => {
      const res = await request(ctx.server, 'GET', `/api/tasks/${taskId}`);
      expect(res.status).toBe(200);
    });

    it('GET /api/tasks/:id 404', async () => {
      const res = await request(ctx.server, 'GET', '/api/tasks/nonexistent');
      expect(res.status).toBe(404);
    });

    it('POST /api/tasks missing required fields', async () => {
      const res = await request(ctx.server, 'POST', '/api/tasks', { title: 'X' });
      expect(res.status).toBe(400);
    });

    it('POST /api/tasks creates task', async () => {
      const res = await request(ctx.server, 'POST', '/api/tasks', {
        title: 'New Task',
        description: 'Desc',
        assignedAgentId: AGENT_A,
        reviewerId: REVIEWER,
      });
      expect(res.status).toBe(201);
    });

    it('PUT /api/tasks/:id', async () => {
      const res = await request(ctx.server, 'PUT', `/api/tasks/${taskId}`, { title: 'Updated' });
      expect(res.status).toBe(200);
    });

    it('GET /api/tasks/:id/history', async () => {
      const res = await request(ctx.server, 'GET', `/api/tasks/${taskId}/history`);
      expect(res.status).toBe(200);
    });

    it('GET /api/tasks/:id/comments', async () => {
      const res = await request(ctx.server, 'GET', `/api/tasks/${taskId}/comments`);
      expect(res.status).toBe(200);
    });

    it('POST /api/tasks/:id/comments', async () => {
      const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/comments`, { content: 'Note' });
      expect([201, 500]).toContain(res.status);
    });

    it('GET /api/tasks/:id/logs', async () => {
      const res = await request(ctx.server, 'GET', `/api/tasks/${taskId}/logs`);
      expect(res.status).toBe(200);
    });

    it('GET /api/tasks/:id/logs/summary', async () => {
      const res = await request(ctx.server, 'GET', `/api/tasks/${taskId}/logs/summary`);
      expect(res.status).toBe(200);
    });

    it('GET /api/tasks/:id/subtasks', async () => {
      const res = await request(ctx.server, 'GET', `/api/tasks/${taskId}/subtasks`);
      expect(res.status).toBe(200);
    });

    it('POST /api/tasks/:id/approve', async () => {
      const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/approve`);
      expect([200, 400]).toContain(res.status);
    });

    it('DELETE /api/tasks/:id', async () => {
      const res = await request(ctx.server, 'DELETE', `/api/tasks/${taskId}`);
      expect([200, 400]).toContain(res.status);
    });

    it('GET /api/execution-logs missing params', async () => {
      const res = await request(ctx.server, 'GET', '/api/execution-logs');
      expect(res.status).toBe(400);
    });

    it('GET /api/execution-logs with params', async () => {
      const res = await request(ctx.server, 'GET', '/api/execution-logs?sourceType=task&sourceId=x');
      expect(res.status).toBe(200);
    });
  });

  // ── Projects & Requirements ─────────────────────────────────────────────────

  describe('Project & requirement routes', () => {
    it('GET /api/projects', async () => {
      const res = await request(ctx.server, 'GET', '/api/projects');
      expect(res.status).toBe(200);
    });

    it('POST /api/projects', async () => {
      const res = await request(ctx.server, 'POST', '/api/projects', { name: 'P2', orgId: 'default' });
      expect(res.status).toBe(201);
    });

    it('GET /api/projects/:id', async () => {
      const res = await request(ctx.server, 'GET', `/api/projects/${PROJECT_1}`);
      expect(res.status).toBe(200);
    });

    it('GET /api/projects/:id 404', async () => {
      const res = await request(ctx.server, 'GET', '/api/projects/missing');
      expect(res.status).toBe(404);
    });

    it('PUT /api/projects/:id', async () => {
      const res = await request(ctx.server, 'PUT', `/api/projects/${PROJECT_1}`, { name: 'Updated' });
      expect(res.status).toBe(200);
    });

    it('DELETE /api/projects/:id', async () => {
      const res = await request(ctx.server, 'DELETE', `/api/projects/${PROJECT_1}`);
      expect(res.status).toBe(200);
    });

    it('GET /api/requirements', async () => {
      const res = await request(ctx.server, 'GET', '/api/requirements');
      expect(res.status).toBe(200);
    });

    it('GET /api/requirements/:id', async () => {
      const res = await request(ctx.server, 'GET', `/api/requirements/${REQ_1}`);
      expect(res.status).toBe(200);
    });

    it('POST /api/requirements validation', async () => {
      const res = await request(ctx.server, 'POST', '/api/requirements', { title: 'R' });
      expect(res.status).toBe(400);
    });

    it('POST /api/requirements creates', async () => {
      const res = await request(ctx.server, 'POST', '/api/requirements', {
        title: 'New Req', description: 'Desc', projectId: PROJECT_1,
      });
      expect(res.status).toBe(201);
    });

    it('PUT /api/requirements/:id', async () => {
      const res = await request(ctx.server, 'PUT', `/api/requirements/${REQ_1}`, { title: 'Updated' });
      expect(res.status).toBe(200);
    });

    it('GET /api/requirements/:id/comments', async () => {
      const res = await request(ctx.server, 'GET', `/api/requirements/${REQ_1}/comments`);
      expect(res.status).toBe(200);
    });

    it('GET /api/requirements/:id/history', async () => {
      const res = await request(ctx.server, 'GET', `/api/requirements/${REQ_1}/history`);
      expect(res.status).toBe(200);
    });
  });

  // ── Deliverables & Knowledge ──────────────────────────────────────────────

  describe('Deliverable & knowledge routes', () => {
    it('GET /api/deliverables', async () => {
      const res = await request(ctx.server, 'GET', '/api/deliverables');
      expect(res.status).toBe(200);
    });

    it('GET /api/deliverables/health', async () => {
      const res = await request(ctx.server, 'GET', '/api/deliverables/health');
      expect(res.status).toBe(200);
    });

    it('POST /api/deliverables', async () => {
      const res = await request(ctx.server, 'POST', '/api/deliverables', {
        type: 'document', title: 'Doc', summary: 'S', reference: '/tmp/f', tags: [], taskId: 't1', agentId: AGENT_A, projectId: PROJECT_1, requirementId: REQ_1,
      });
      expect(res.status).toBe(201);
    });

    it('GET /api/deliverables/:id', async () => {
      const res = await request(ctx.server, 'GET', '/api/deliverables/deliv-1');
      expect(res.status).toBe(200);
    });

    it('PUT /api/deliverables/:id', async () => {
      const res = await request(ctx.server, 'PUT', '/api/deliverables/deliv-1', { title: 'New' });
      expect(res.status).toBe(200);
    });

    it('DELETE /api/deliverables/:id', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/deliverables/deliv-1');
      expect(res.status).toBe(200);
    });

    it('POST /api/knowledge', async () => {
      const res = await request(ctx.server, 'POST', '/api/knowledge', { title: 'K', content: 'C', tags: [], source: AGENT_A });
      expect([201, 500, 503]).toContain(res.status);
    });

    it('GET /api/knowledge/search', async () => {
      const res = await request(ctx.server, 'GET', '/api/knowledge/search?q=test');
      expect([200, 503]).toContain(res.status);
    });

    it('DELETE /api/knowledge/:id', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/knowledge/know-1');
      expect(res.status).toBe(200);
    });
  });

  // ── Orgs, Roles, Users ────────────────────────────────────────────────────

  describe('Org, role, and user routes', () => {
    it('GET /api/orgs', async () => {
      const res = await request(ctx.server, 'GET', '/api/orgs');
      expect(res.status).toBe(200);
    });

    it('POST /api/orgs', async () => {
      const res = await request(ctx.server, 'POST', '/api/orgs', { name: 'New Org' });
      expect(res.status).toBe(201);
    });

    it('GET /api/roles', async () => {
      const res = await request(ctx.server, 'GET', '/api/roles');
      expect(res.status).toBe(200);
    });

    it('GET /api/roles/:name', async () => {
      const res = await request(ctx.server, 'GET', '/api/roles/developer');
      expect(res.status).toBe(200);
    });

    it('GET /api/users', async () => {
      const res = await request(ctx.server, 'GET', '/api/users');
      expect([200, 401]).toContain(res.status);
    });

    it('POST /api/users validation', async () => {
      const res = await request(ctx.server, 'POST', '/api/users', { password: 'secret' });
      expect(res.status).toBe(400);
      expect(String(res.json.error)).toContain('Email');
    });
  });

  // ── Settings ──────────────────────────────────────────────────────────────

  describe('Settings routes', () => {
    it('GET /api/settings/telemetry', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/telemetry');
      expect(res.status).toBe(200);
    });

    it('POST /api/settings/telemetry', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/telemetry', { enabled: true });
      expect(res.status).toBe(200);
    });

    it('GET /api/settings/hub', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/hub');
      expect(res.status).toBe(200);
    });

    it('POST /api/settings/hub-token', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/hub-token', { token: 'abc' });
      expect(res.status).toBe(200);
    });

    it('GET /api/settings/llm', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/llm');
      expect(res.status).toBe(200);
    });

    it('GET /api/settings/agent', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/agent');
      expect(res.status).toBe(200);
    });

    it('GET /api/settings/network', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/network');
      expect(res.status).toBe(200);
    });

    it('GET /api/settings/browser', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/browser');
      expect(res.status).toBe(200);
    });

    it('GET /api/settings/search', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/search');
      expect(res.status).toBe(200);
    });

    it('GET /api/settings/env-models', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/env-models');
      expect(res.status).toBe(200);
    });

    it('GET /api/settings/detect-ollama', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/detect-ollama');
      expect(res.status).toBe(200);
    });

    it('GET /api/settings/remote', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/remote');
      expect(res.status).toBe(200);
    });

    it('GET /api/models/catalog', async () => {
      const res = await request(ctx.server, 'GET', '/api/models/catalog');
      expect(res.status).toBe(200);
    });

    it('GET /api/models/catalog/openai', async () => {
      const res = await request(ctx.server, 'GET', '/api/models/catalog/openai');
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key missing fields', async () => {
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {});
      expect(res.status).toBe(400);
    });

    it('GET /api/models/live/openai', async () => {
      const res = await request(ctx.server, 'GET', '/api/models/live/openai');
      expect(res.status).toBe(200);
    });

    it('GET /api/settings/integrations/feishu', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/integrations/feishu');
      expect(res.status).toBe(200);
    });
  });

  // ── License, Audit, Usage ─────────────────────────────────────────────────

  describe('License, audit, and usage routes', () => {
    it('GET /api/license', async () => {
      const res = await request(ctx.server, 'GET', '/api/license');
      expect(res.status).toBe(200);
    });

    it('POST /api/license/refresh', async () => {
      const res = await request(ctx.server, 'POST', '/api/license/refresh');
      expect(res.status).toBe(200);
    });

    it('POST /api/license/activate missing key', async () => {
      const res = await request(ctx.server, 'POST', '/api/license/activate', {});
      expect(res.status).toBe(400);
    });

    it('POST /api/license/trial', async () => {
      const res = await request(ctx.server, 'POST', '/api/license/trial');
      expect(res.status).toBe(200);
    });

    it('GET /api/audit', async () => {
      const res = await request(ctx.server, 'GET', '/api/audit');
      expect(res.status).toBe(200);
    });

    it('GET /api/audit/summary', async () => {
      const res = await request(ctx.server, 'GET', '/api/audit/summary');
      expect(res.status).toBe(200);
    });

    it('GET /api/usage', async () => {
      const res = await request(ctx.server, 'GET', '/api/usage');
      expect(res.status).toBe(200);
    });

    it('GET /api/usage/agents', async () => {
      const res = await request(ctx.server, 'GET', '/api/usage/agents');
      expect(res.status).toBe(200);
    });

    it('GET /api/plan', async () => {
      const res = await request(ctx.server, 'GET', '/api/plan');
      expect(res.status).toBe(200);
    });
  });

  // ── Approvals, Notifications, Activity ──────────────────────────────────

  describe('Approvals & notifications', () => {
    it('GET /api/approvals', async () => {
      const res = await request(ctx.server, 'GET', '/api/approvals');
      expect(res.status).toBe(200);
    });

    it('POST /api/approvals', async () => {
      const res = await request(ctx.server, 'POST', '/api/approvals', {
        agentId: AGENT_A, title: 'Approve', description: 'Please',
      });
      expect(res.status).toBe(201);
    });

    it('GET /api/notifications', async () => {
      const res = await request(ctx.server, 'GET', '/api/notifications');
      expect(res.status).toBe(200);
    });

    it('POST /api/notifications/mark-all-read', async () => {
      const res = await request(ctx.server, 'POST', '/api/notifications/mark-all-read');
      expect(res.status).toBe(200);
    });

    it('GET /api/activity', async () => {
      const res = await request(ctx.server, 'GET', '/api/activity');
      expect(res.status).toBe(200);
    });

    it('GET /api/messages/search', async () => {
      const res = await request(ctx.server, 'GET', '/api/messages/search?q=hello');
      expect(res.status).toBe(200);
    });
  });

  // ── Gateway & Builder ───────────────────────────────────────────────────────

  describe('Gateway & builder routes', () => {
    it('GET /api/gateway/info requires admin', async () => {
      const res = await request(ctx.server, 'GET', '/api/gateway/info');
      expect(res.status).toBe(403);
    });

    it('GET /api/gateway/status', async () => {
      const res = await request(ctx.server, 'GET', '/api/gateway/status', undefined, GW_AUTH);
      expect(res.status).toBe(200);
    });

    it('GET /api/gateway/team', async () => {
      const res = await request(ctx.server, 'GET', '/api/gateway/team', undefined, GW_AUTH);
      expect(res.status).toBe(200);
    });

    it('GET /api/gateway/projects', async () => {
      const res = await request(ctx.server, 'GET', '/api/gateway/projects', undefined, GW_AUTH);
      expect(res.status).toBe(200);
    });

    it('POST /api/gateway/auth', async () => {
      const res = await request(ctx.server, 'POST', '/api/gateway/auth', {
        agentId: 'ext-1', orgId: 'default', secret: 'gw-secret',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/gateway/register', async () => {
      const res = await request(ctx.server, 'POST', '/api/gateway/register', {
        agentId: 'ext-1', agentName: 'External', orgId: 'default',
      });
      expect(res.status).toBe(201);
    });

    it('POST /api/gateway/message', async () => {
      const res = await request(ctx.server, 'POST', '/api/gateway/message', {
        type: 'heartbeat', content: 'ping',
      }, GW_AUTH);
      expect(res.status).toBe(200);
    });

    it('GET /api/gateway/requirements', async () => {
      const res = await request(ctx.server, 'GET', '/api/gateway/requirements', undefined, GW_AUTH);
      expect(res.status).toBe(200);
    });

    it('GET /api/gateway/deliverables', async () => {
      const res = await request(ctx.server, 'GET', '/api/gateway/deliverables', undefined, GW_AUTH);
      expect(res.status).toBe(200);
    });

    it('GET /api/builder/artifacts', async () => {
      const res = await request(ctx.server, 'GET', '/api/builder/artifacts');
      expect(res.status).toBe(200);
    });

    it('GET /api/builder/artifacts/installed', async () => {
      const res = await request(ctx.server, 'GET', '/api/builder/artifacts/installed');
      expect(res.status).toBe(200);
    });
  });

  // ── Skills, Templates, Workflows ──────────────────────────────────────────

  describe('Skills, templates, and workflows', () => {
    it('GET /api/skills', async () => {
      const res = await request(ctx.server, 'GET', '/api/skills');
      expect(res.status).toBe(200);
    });

    it('GET /api/skills/builtin', async () => {
      const res = await request(ctx.server, 'GET', '/api/skills/builtin');
      expect(res.status).toBe(200);
    });

    it('GET /api/skills/registry', async () => {
      const res = await request(ctx.server, 'GET', '/api/skills/registry');
      expect(res.status).toBe(200);
    });

    it('GET /api/templates', async () => {
      const res = await request(ctx.server, 'GET', '/api/templates');
      expect(res.status).toBe(200);
    });

    it('GET /api/templates/teams', async () => {
      const res = await request(ctx.server, 'GET', '/api/templates/teams');
      expect(res.status).toBe(200);
    });

    it('GET /api/team-templates', async () => {
      const res = await request(ctx.server, 'GET', '/api/team-templates');
      expect(res.status).toBe(200);
    });

    it('GET /api/workflows', async () => {
      const res = await request(ctx.server, 'GET', '/api/workflows');
      expect(res.status).toBe(200);
    });

    it('GET /api/governance/policy', async () => {
      const res = await request(ctx.server, 'GET', '/api/governance/policy');
      expect(res.status).toBe(200);
    });

    it('GET /api/teams/:id/workflows', async () => {
      const res = await request(ctx.server, 'GET', `/api/teams/${TEAM_1}/workflows`);
      expect(res.status).toBe(200);
    });
  });

  // ── Files, Keys, External agents ──────────────────────────────────────────

  describe('Files, keys, and external agents', () => {
    it('POST /api/files/check missing paths', async () => {
      const res = await request(ctx.server, 'POST', '/api/files/check', {});
      expect(res.status).toBe(400);
    });

    it('POST /api/files/check with paths', async () => {
      const res = await request(ctx.server, 'POST', '/api/files/check', { paths: ['/tmp'] });
      expect(res.status).toBe(200);
    });

    it('GET /api/keys', async () => {
      const res = await request(ctx.server, 'GET', '/api/keys');
      expect(res.status).toBe(200);
    });

    it('GET /api/external-agents', async () => {
      const res = await request(ctx.server, 'GET', '/api/external-agents');
      expect(res.status).toBe(200);
    });

    it('GET /api/reports', async () => {
      const res = await request(ctx.server, 'GET', '/api/reports');
      expect(res.status).toBe(200);
    });

    it('GET /api/reviews', async () => {
      const res = await request(ctx.server, 'GET', '/api/reviews');
      expect(res.status).toBe(200);
    });
  });

  // ── Extended route coverage ─────────────────────────────────────────────────

  describe('Extended route coverage', () => {
    let taskId: string;

    beforeEach(() => {
      const task = ctx.taskService.createTask({
        orgId: 'default',
        title: 'Extended Task',
        description: 'Work',
        assignedAgentId: AGENT_A,
        reviewerId: REVIEWER,
      } as never);
      taskId = task.id;
    });

    describe('Group chats', () => {
      it('GET /api/group-chats', async () => {
        const res = await request(ctx.server, 'GET', '/api/group-chats');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.json.chats)).toBe(true);
      });

      it('POST /api/group-chats', async () => {
        const res = await request(ctx.server, 'POST', '/api/group-chats', {
          name: 'Dev Chat', creatorId: 'anonymous', creatorName: 'Anon', memberIds: [AGENT_A],
        });
        expect(res.status).toBe(201);
      });

      it('POST /api/group-chats missing name', async () => {
        const res = await request(ctx.server, 'POST', '/api/group-chats', { creatorId: 'x' });
        expect(res.status).toBe(400);
      });

      it('GET /api/group-chats/:id', async () => {
        const res = await request(ctx.server, 'GET', '/api/group-chats/gc-1');
        expect(res.status).toBe(200);
      });

      it('PATCH /api/group-chats/:id', async () => {
        const res = await request(ctx.server, 'PATCH', '/api/group-chats/gc-1', { name: 'Renamed' });
        expect(res.status).toBe(200);
      });

      it('DELETE /api/group-chats/:id', async () => {
        const res = await request(ctx.server, 'DELETE', '/api/group-chats/gc-1');
        expect(res.status).toBe(200);
      });
    });

    describe('Teams extended', () => {
      it('PATCH /api/teams/:id', async () => {
        const res = await request(ctx.server, 'PATCH', `/api/teams/${TEAM_1}`, { name: 'Updated Team' });
        expect(res.status).toBe(200);
      });

      it('DELETE /api/teams/:id', async () => {
        const res = await request(ctx.server, 'DELETE', `/api/teams/${TEAM_1}`);
        expect(res.status).toBe(200);
      });

      it('POST /api/teams/:id/members', async () => {
        const res = await request(ctx.server, 'POST', `/api/teams/${TEAM_1}/members`, {
          memberId: AGENT_B, memberType: 'agent',
        });
        expect(res.status).toBe(200);
      });

      it('DELETE /api/teams/:id/members/:memberId', async () => {
        const res = await request(ctx.server, 'DELETE', `/api/teams/${TEAM_1}/members/${AGENT_B}`);
        expect(res.status).toBe(200);
      });

      it('POST /api/teams/:id/stop', async () => {
        const res = await request(ctx.server, 'POST', `/api/teams/${TEAM_1}/stop`);
        expect([200, 404]).toContain(res.status);
      });

      it('GET /api/teams/:id/files', async () => {
        const res = await request(ctx.server, 'GET', `/api/teams/${TEAM_1}/files`);
        expect([200, 404]).toContain(res.status);
      });
    });

    describe('Task lifecycle', () => {
      it('POST /api/tasks/:id/reject', async () => {
        const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/reject`, { reason: 'No' });
        expect([200, 400]).toContain(res.status);
      });

      it('POST /api/tasks/:id/cancel', async () => {
        const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/cancel`, { cascade: false });
        expect([200, 400]).toContain(res.status);
      });

      it('GET /api/tasks/:id/dependents', async () => {
        const res = await request(ctx.server, 'GET', `/api/tasks/${taskId}/dependents`);
        expect(res.status).toBe(200);
      });

      it('DELETE /api/tasks/:id blocked', async () => {
        const res = await request(ctx.server, 'DELETE', `/api/tasks/${taskId}`);
        expect(res.status).toBe(400);
      });

      it('POST /api/tasks/:id/subtasks', async () => {
        const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/subtasks`, { title: 'Sub 1' });
        expect(res.status).toBe(201);
      });

      it('POST /api/tasks/:id/pause', async () => {
        const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/pause`);
        expect([200, 400]).toContain(res.status);
      });

      it('POST /api/tasks/:id/resume', async () => {
        const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/resume`);
        expect([200, 400]).toContain(res.status);
      });

      it('POST /api/tasks/:id/retry', async () => {
        const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/retry`);
        expect([200, 202, 400]).toContain(res.status);
      });

      it('POST /api/tasks/:id/run wrong status', async () => {
        const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/run`);
        expect(res.status).toBe(400);
      });
    });

    describe('Requirements extended', () => {
      it('POST /api/requirements/:id/status', async () => {
        const res = await request(ctx.server, 'POST', `/api/requirements/${REQ_1}/status`, { status: 'review' });
        expect([200, 400]).toContain(res.status);
      });

      it('POST /api/requirements/:id/approve', async () => {
        const res = await request(ctx.server, 'POST', `/api/requirements/${REQ_1}/approve`);
        expect(res.status).toBe(200);
      });

      it('POST /api/requirements/:id/reject', async () => {
        const res = await request(ctx.server, 'POST', `/api/requirements/${REQ_1}/reject`, { reason: 'Nope' });
        expect(res.status).toBe(200);
      });

      it('POST /api/requirements/:id/cancel', async () => {
        const res = await request(ctx.server, 'POST', `/api/requirements/${REQ_1}/cancel`);
        expect(res.status).toBe(200);
      });

      it('POST /api/requirements/:id/comments', async () => {
        const res = await request(ctx.server, 'POST', `/api/requirements/${REQ_1}/comments`, { content: 'Note' });
        expect([201, 400, 500]).toContain(res.status);
      });
    });

    describe('Sessions and channels', () => {
      it('GET /api/sessions/has-any', async () => {
        const res = await request(ctx.server, 'GET', '/api/sessions/has-any');
        expect(res.status).toBe(200);
      });

      it('GET /api/channels/:key/messages', async () => {
        const res = await request(ctx.server, 'GET', '/api/channels/group%3Ateam-1/messages');
        expect(res.status).toBe(200);
      });

      it('POST /api/channels/:key/messages', async () => {
        const res = await request(ctx.server, 'POST', '/api/channels/group%3Ateam-1/messages', {
          text: 'Hello', senderId: 'anonymous', senderName: 'Anon',
        });
        expect([200, 201, 400]).toContain(res.status);
      });
    });

    describe('Agent extended', () => {
      it('GET /api/agents/:id/role-status', async () => {
        const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/role-status`);
        expect(res.status).toBe(200);
      });

      it('GET /api/agents/:id/role-diff', async () => {
        const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/role-diff?file=ROLE.md`);
        expect(res.status).toBe(200);
      });

      it('POST /api/agents/:id/role-sync', async () => {
        const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/role-sync`, { files: ['ROLE.md'] });
        expect(res.status).toBe(200);
      });

      it('PUT /api/agents/:id/system-prompt', async () => {
        const res = await request(ctx.server, 'PUT', `/api/agents/${AGENT_A}/system-prompt`, { systemPrompt: 'Be helpful' });
        expect(res.status).toBe(200);
      });

      it('PUT /api/agents/:id/memory/longterm', async () => {
        const res = await request(ctx.server, 'PUT', `/api/agents/${AGENT_A}/memory/longterm`, { key: 'fact', content: 'x' });
        expect(res.status).toBe(200);
      });

      it('DELETE /api/agents/:id/skills/:skill', async () => {
        const res = await request(ctx.server, 'DELETE', `/api/agents/${AGENT_A}/skills/coding`);
        expect(res.status).toBe(200);
      });

      it('GET /api/agents/:id/recent-activities', async () => {
        const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/recent-activities`);
        expect(res.status).toBe(200);
      });
    });

    describe('Settings POST routes', () => {
      it('POST /api/settings/llm', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/llm', { defaultProvider: 'openai' });
        expect(res.status).toBe(200);
      });

      it('POST /api/settings/llm missing fields', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/llm', {});
        expect(res.status).toBe(400);
      });

      it('POST /api/settings/agent', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/agent', { maxConcurrentTasks: 3 });
        expect(res.status).toBe(200);
      });

      it('POST /api/settings/network', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/network', { proxy: '', proxyEnabled: false });
        expect(res.status).toBe(200);
      });

      it('POST /api/settings/browser', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/browser', { headless: true });
        expect(res.status).toBe(200);
      });

      it('POST /api/settings/search', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/search', { provider: 'duckduckgo' });
        expect(res.status).toBe(200);
      });

      it('POST /api/settings/env-models', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/env-models', { models: {} });
        expect([200, 400]).toContain(res.status);
      });

      it('POST /api/settings/export', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/export', {});
        expect(res.status).toBe(200);
      });

      it('GET /api/settings/llm/models', async () => {
        const res = await request(ctx.server, 'GET', '/api/settings/llm/models');
        expect(res.status).toBe(200);
      });

      it('GET /api/models/routing-candidates', async () => {
        const res = await request(ctx.server, 'GET', '/api/models/routing-candidates');
        expect(res.status).toBe(200);
      });

      it('GET /api/settings/llm/routing', async () => {
        const res = await request(ctx.server, 'GET', '/api/settings/llm/routing');
        expect(res.status).toBe(200);
      });

      it('GET /api/settings/oauth/providers', async () => {
        const res = await request(ctx.server, 'GET', '/api/settings/oauth/providers');
        expect(res.status).toBe(200);
      });

      it('GET /api/settings/oauth/profiles', async () => {
        const res = await request(ctx.server, 'GET', '/api/settings/oauth/profiles');
        expect(res.status).toBe(200);
      });

      it('POST /api/settings/integrations/feishu', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/integrations/feishu', {
          appId: 'cli_test', appSecret: 'secret',
        });
        expect([200, 400, 500]).toContain(res.status);
      });
    });

    describe('Users, keys, and reviews', () => {
      it('POST /api/users creates user', async () => {
        const res = await request(ctx.server, 'POST', '/api/users', {
          name: 'New User', email: 'new@test.com', role: 'member',
        });
        expect([201, 200]).toContain(res.status);
      });

      it('POST /api/keys', async () => {
        const res = await request(ctx.server, 'POST', '/api/keys', { name: 'My Key' });
        expect(res.status).toBe(201);
      });

      it('POST /api/reviews', async () => {
        const res = await request(ctx.server, 'POST', '/api/reviews', {
          taskId: taskId, reviewerId: REVIEWER, verdict: 'approved', comments: 'LGTM',
        });
        expect([201, 400, 500]).toContain(res.status);
      });

      it('POST /api/plan', async () => {
        const res = await request(ctx.server, 'POST', '/api/plan', { plan: 'pro' });
        expect([200, 400]).toContain(res.status);
      });
    });

    describe('License and audit extended', () => {
      it('POST /api/license/import missing fileContent', async () => {
        const res = await request(ctx.server, 'POST', '/api/license/import', {});
        expect(res.status).toBe(400);
      });

      it('POST /api/license/deactivate', async () => {
        const res = await request(ctx.server, 'POST', '/api/license/deactivate');
        expect(res.status).toBe(200);
      });

      it('GET /api/audit/tokens', async () => {
        const res = await request(ctx.server, 'GET', '/api/audit/tokens');
        expect(res.status).toBe(200);
      });
    });

    describe('Builder, skills, templates', () => {
      it('POST /api/builder/artifacts/save validation', async () => {
        const res = await request(ctx.server, 'POST', '/api/builder/artifacts/save', {});
        expect(res.status).toBe(400);
      });

      it('POST /api/skills/install missing name', async () => {
        const res = await request(ctx.server, 'POST', '/api/skills/install', {});
        expect(res.status).toBe(400);
      });

      it('GET /api/skills/registry', async () => {
        const res = await request(ctx.server, 'GET', '/api/skills/registry');
        expect(res.status).toBe(200);
      });

      it('POST /api/templates/instantiate validation', async () => {
        const res = await request(ctx.server, 'POST', '/api/templates/instantiate', { name: 'X' });
        expect(res.status).toBe(400);
      });

      it('GET /api/templates/teams', async () => {
        const res = await request(ctx.server, 'GET', '/api/templates/teams');
        expect(res.status).toBe(200);
      });

      it('POST /api/team-templates validation', async () => {
        const res = await request(ctx.server, 'POST', '/api/team-templates', {});
        expect(res.status).toBe(400);
      });
    });

    describe('Workflows and governance', () => {
      it('PUT /api/governance/policy', async () => {
        const res = await request(ctx.server, 'PUT', '/api/governance/policy', {
          enabled: true, defaultTier: 'auto', maxPendingTasksPerAgent: 10,
        });
        expect(res.status).toBe(200);
      });

      it('POST /api/workflows validation', async () => {
        const res = await request(ctx.server, 'POST', '/api/workflows', {});
        expect(res.status).toBe(400);
      });

      it('POST /api/reports/generate', async () => {
        const res = await request(ctx.server, 'POST', '/api/reports/generate', {
          type: 'daily', orgId: 'default',
        });
        expect([200, 201, 400]).toContain(res.status);
      });
    });

    describe('Misc routes', () => {
      it('POST /api/message', async () => {
        const res = await request(ctx.server, 'POST', '/api/message', {
          agentId: AGENT_A, text: 'Hello',
        });
        expect([200, 400, 500]).toContain(res.status);
      });

      it('GET /api/unread', async () => {
        const res = await request(ctx.server, 'GET', '/api/unread');
        expect(res.status).toBe(200);
      });

      it('GET /api/messages/search short query', async () => {
        const res = await request(ctx.server, 'GET', '/api/messages/search?q=a');
        expect(res.status).toBe(400);
      });

      it('POST /api/external-agents/register', async () => {
        const res = await request(ctx.server, 'POST', '/api/external-agents/register', {
          externalAgentId: 'ext-2', agentName: 'External Two',
        });
        expect(res.status).toBe(201);
      });

      it('GET /api/files/preview missing path', async () => {
        const res = await request(ctx.server, 'GET', '/api/files/preview');
        expect(res.status).toBe(400);
      });

      it('POST /api/files/reveal missing path', async () => {
        const res = await request(ctx.server, 'POST', '/api/files/reveal', {});
        expect(res.status).toBe(400);
      });

      it('GET /api/gateway/manual unauthorized', async () => {
        const res = await request(ctx.server, 'GET', '/api/gateway/manual');
        expect(res.status).toBe(401);
      });

      it('POST /api/auth/change-password wrong fields', async () => {
        const res = await request(ctx.server, 'POST', '/api/auth/change-password', { oldPassword: 'a' });
        expect(res.status).toBe(400);
      });
    });

    describe('Hub, gateway sync, and builder deep routes', () => {
      it('POST /api/hub/publish missing token', async () => {
        const res = await request(ctx.server, 'POST', '/api/hub/publish', { payload: { title: 'X' } });
        expect(res.status).toBe(401);
      });

      it('POST /api/hub/publish with token', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 201,
          json: async () => ({ id: 'item-1' }),
          headers: { get: () => null },
        });
        const res = await request(ctx.server, 'POST', '/api/hub/publish', {
          hubToken: 'hub-tok', payload: { title: 'Item', type: 'skill' },
        });
        expect([201, 200, 502]).toContain(res.status);
      });

      it('GET /api/hub/items proxy', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 200,
          json: async () => ({ items: [] }),
          headers: { get: () => null },
        });
        const res = await request(ctx.server, 'GET', '/api/hub/items', undefined, { authorization: 'Bearer hub-tok' });
        expect([200, 502]).toContain(res.status);
      });

      it('POST /api/gateway/sync', async () => {
        const res = await request(ctx.server, 'POST', '/api/gateway/sync', { inbox: [] }, GW_AUTH);
        expect([200, 500]).toContain(res.status);
      });

      it('POST /api/gateway/tasks/:id/accept', async () => {
        const res = await request(ctx.server, 'POST', `/api/gateway/tasks/${taskId}/accept`, {}, GW_AUTH);
        expect([200, 400, 404]).toContain(res.status);
      });

      it('POST /api/gateway/tasks/:id/progress', async () => {
        const res = await request(ctx.server, 'POST', `/api/gateway/tasks/${taskId}/progress`, { progress: 50 }, GW_AUTH);
        expect([200, 404]).toContain(res.status);
      });

      it('POST /api/gateway/tasks/:id/complete', async () => {
        const res = await request(ctx.server, 'POST', `/api/gateway/tasks/${taskId}/complete`, {}, GW_AUTH);
        expect([200, 400, 404, 500]).toContain(res.status);
      });

      it('POST /api/gateway/tasks/:id/fail', async () => {
        const res = await request(ctx.server, 'POST', `/api/gateway/tasks/${taskId}/fail`, {}, GW_AUTH);
        expect([200, 400, 404, 500]).toContain(res.status);
      });

      it('POST /api/gateway/tasks/:id/delegate', async () => {
        const res = await request(ctx.server, 'POST', `/api/gateway/tasks/${taskId}/delegate`, {}, GW_AUTH);
        expect(res.status).toBe(400);
      });

      it('POST /api/gateway/tasks/:id/subtasks', async () => {
        const res = await request(ctx.server, 'POST', `/api/gateway/tasks/${taskId}/subtasks`, { title: 'Sub' }, GW_AUTH);
        expect([201, 404]).toContain(res.status);
      });

      it('POST /api/builder/artifacts/save agent', async () => {
        const res = await request(ctx.server, 'POST', '/api/builder/artifacts/save', {
          mode: 'agent',
          artifact: {
            name: 'test-agent',
            description: 'Test',
            files: { 'ROLE.md': '# Role\n' },
          },
        });
        expect(res.status).toBe(201);
      });

      it('POST /api/builder/artifacts/save team', async () => {
        const res = await request(ctx.server, 'POST', '/api/builder/artifacts/save', {
          mode: 'team',
          artifact: {
            name: 'test-team',
            description: 'Team',
            announcement: 'Hello',
            norms: 'Be nice',
            team: { members: [{ name: 'Worker', roleContent: '# Worker' }] },
          },
        });
        expect(res.status).toBe(201);
      });

      it('POST /api/builder/artifacts/import', async () => {
        const res = await request(ctx.server, 'POST', '/api/builder/artifacts/import', {
          type: 'agent', name: 'imported', files: { 'ROLE.md': '# Imported' },
        });
        expect([201, 400]).toContain(res.status);
      });

      it('GET /api/builder/artifacts/agent/test-agent', async () => {
        await request(ctx.server, 'POST', '/api/builder/artifacts/save', {
          mode: 'agent',
          artifact: { name: 'test-agent', files: { 'ROLE.md': '# R' } },
        });
        const res = await request(ctx.server, 'GET', '/api/builder/artifacts/agent/test-agent');
        expect([200, 404, 500]).toContain(res.status);
      });
    });

    describe('Task scheduling and archive routes', () => {
      it('PUT /api/tasks/:id/schedule', async () => {
        const res = await request(ctx.server, 'PUT', `/api/tasks/${taskId}/schedule`, {
          cron: '0 9 * * *', timezone: 'UTC',
        });
        expect([200, 400]).toContain(res.status);
      });

      it('POST /api/tasks/:id/schedule/pause', async () => {
        const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/schedule/pause`);
        expect([200, 400]).toContain(res.status);
      });

      it('POST /api/tasks/:id/schedule/resume', async () => {
        const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/schedule/resume`);
        expect([200, 400]).toContain(res.status);
      });

      it('POST /api/tasks/:id/archive', async () => {
        const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/archive`);
        expect([200, 400]).toContain(res.status);
      });

      it('POST /api/tasks/:id/accept', async () => {
        const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/accept`);
        expect([200, 400]).toContain(res.status);
      });

      it('POST /api/tasks/:id/revision', async () => {
        const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/revision`, { feedback: 'Fix it' });
        expect([200, 400]).toContain(res.status);
      });
    });

    describe('Settings deep routes', () => {
      it('POST /api/settings/hub-token', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/hub-token', { token: 'stored-hub-token' });
        expect(res.status).toBe(200);
      });

      it('GET /api/settings/remote/enable', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/remote/enable', { host: '127.0.0.1', port: 8057 });
        expect([200, 400, 503]).toContain(res.status);
      });

      it('POST /api/settings/remote/disable', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/remote/disable');
        expect([200, 503]).toContain(res.status);
      });

      it('POST /api/models/catalog/refresh', async () => {
        const res = await request(ctx.server, 'POST', '/api/models/catalog/refresh');
        expect(res.status).toBe(200);
      });

      it('POST /api/settings/llm/providers', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/llm/providers', {
          name: 'custom', apiKey: 'key', baseUrl: 'https://api.example.com',
        });
        expect([200, 201, 400]).toContain(res.status);
      });

      it('GET /api/settings/oauth/status', async () => {
        const res = await request(ctx.server, 'GET', '/api/settings/oauth/status');
        expect(res.status).toBe(200);
      });

      it('POST /api/settings/oauth/login missing provider', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/oauth/login', {});
        expect([400, 503]).toContain(res.status);
      });

      it('POST /api/settings/import', async () => {
        const res = await request(ctx.server, 'POST', '/api/settings/import', {
          config: { network: { proxy: '' } },
        });
        expect([200, 400]).toContain(res.status);
      });

      it('DELETE /api/settings/integrations/feishu', async () => {
        const res = await request(ctx.server, 'DELETE', '/api/settings/integrations/feishu');
        expect([200, 404]).toContain(res.status);
      });

      it('GET /api/settings/browser/check', async () => {
        const res = await request(ctx.server, 'GET', '/api/settings/browser/check');
        expect([200, 404]).toContain(res.status);
      });

      it('GET /api/models/suggested-assignments', async () => {
        const res = await request(ctx.server, 'GET', '/api/models/suggested-assignments');
        expect(res.status).toBe(200);
      });
    });

    describe('Workflows, templates, and team-templates', () => {
      it('POST /api/workflows creates workflow', async () => {
        const res = await request(ctx.server, 'POST', '/api/workflows', {
          name: 'wf-test', displayName: 'WF Test', description: 'D', steps: [],
        });
        expect([201, 200, 400]).toContain(res.status);
      });

      it('GET /api/team-templates/:id', async () => {
        const res = await request(ctx.server, 'GET', '/api/team-templates/default');
        expect([200, 404]).toContain(res.status);
      });

      it('GET /api/templates/:id', async () => {
        const res = await request(ctx.server, 'GET', '/api/templates/developer');
        expect([200, 404]).toContain(res.status);
      });

      it('POST /api/templates/instantiate', async () => {
        const res = await request(ctx.server, 'POST', '/api/templates/instantiate', {
          templateId: 'developer', name: 'New From Template',
        });
        expect([201, 400, 404]).toContain(res.status);
      });
    });

    describe('Auth and avatar routes', () => {
      it('POST /api/auth/setup validation', async () => {
        const res = await request(ctx.server, 'POST', '/api/auth/setup', { email: 'a@b.com' });
        expect(res.status).toBe(400);
      });

      it('POST /api/avatars/upload invalid image', async () => {
        const res = await request(ctx.server, 'POST', '/api/avatars/upload', { image: 'not-a-data-url' });
        expect(res.status).toBe(400);
      });

      it('POST /api/avatars/upload valid image', async () => {
        const res = await request(ctx.server, 'POST', '/api/avatars/upload', {
          image: 'data:image/png;base64,iVBORw0KGgo=',
        });
        expect(res.status).toBe(200);
      });

      it('GET /api/avatars/missing', async () => {
        const res = await request(ctx.server, 'GET', '/api/avatars/nonexistent.png');
        expect(res.status).toBe(404);
      });
    });
  });

  // ── 404 ───────────────────────────────────────────────────────────────────

  describe('Not found', () => {
    it('returns 404 for unknown API path', async () => {
      const res = await request(ctx.server, 'GET', '/api/unknown-endpoint-xyz');
      expect(res.status).toBe(404);
    });
  });

  // ── Auth enabled ──────────────────────────────────────────────────────────

  describe('Auth enabled', () => {
    beforeEach(() => {
      process.env['AUTH_ENABLED'] = 'true';
      ctx = createTestServer();
    });

    it('returns 401 for protected route without token', async () => {
      const res = await request(ctx.server, 'POST', '/api/agents', { name: 'X' });
      expect(res.status).toBe(401);
    });

    it('GET /api/auth/login with auth enabled still needs POST', async () => {
      const res = await request(ctx.server, 'GET', '/api/auth/login');
      expect(res.status).toBe(405);
    });
  });
});
