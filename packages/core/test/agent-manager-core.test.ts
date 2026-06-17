import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import type { AgentConfig, RoleTemplate } from '@markus/shared';
import type { AgentOptions } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';

const { MockAgent, mockAgentInstances } = vi.hoisted(() => {
  const instances: MockAgent[] = [];

  class MockAgent {
    id: string;
    config: AgentConfig;
    role: RoleTemplate;

    private status: 'idle' | 'paused' | 'offline' | 'working' = 'idle';

    start = vi.fn(async (options?: { startAsPaused?: boolean }) => {
      this.status = options?.startAsPaused ? 'paused' : 'idle';
    });

    stop = vi.fn(async () => {
      this.status = 'offline';
    });

    pause = vi.fn((reason?: string) => {
      this._pauseReason = reason;
      this.status = 'paused';
    });

    resume = vi.fn(() => {
      this._pauseReason = undefined;
      this.status = 'idle';
    });

    cancelActiveStream = vi.fn();

    getState = vi.fn(() => ({
      agentId: this.id,
      status: this.status,
      activeTaskCount: 0,
      activeTaskIds: [] as string[],
      tokensUsedToday: 0,
    }));

    getTeamName = vi.fn(() => undefined);
    getModelSupportsVision = vi.fn(() => false);
    enqueueToMailbox = vi.fn(() => ({ id: 'mbx_mock', agentId: this.id }));
    setIdentityContext = vi.fn();
    getMailbox = vi.fn(() => ({ depth: 0 }));
    getAttentionController = vi.fn(() => ({ getState: () => 'idle' }));
    getMemory = vi.fn(() => ({ writeDailyLog: vi.fn() }));
    getContextEngine = vi.fn(() => ({ setSemanticSearch: vi.fn() }));
    registerTool = vi.fn();
    injectSkillInstructions = vi.fn();
    hasSkillInstructions = vi.fn(() => false);
    setAvailableSkillCatalog = vi.fn();
    activateTools = vi.fn();
    setSkillMcpActivator = vi.fn();
    setSkillSearcher = vi.fn();
    setSkillInstaller = vi.fn();
    setUserApprovalRequester = vi.fn();
    setUserNotifier = vi.fn();
    setSemanticSearch = vi.fn();
    setAuditCallback = vi.fn();
    setEscalationCallback = vi.fn();
    setApprovalCallback = vi.fn();
    setToolCallLimitChecker = vi.fn();
    setStateChangeCallback = vi.fn();
    setActivityCallbacks = vi.fn();
    setBrowserCloseTabsHelper = vi.fn();
    setTeamDataDir = vi.fn();
    reloadRole = vi.fn();
    sendMessage = vi.fn(async () => 'ok');

    private _pauseReason?: string;
    private _eventBus = new EventBus();

    constructor(opts: AgentOptions) {
      this.id = opts.config.id;
      this.config = opts.config;
      this.role = opts.role;
      instances.push(this);
    }

    getEventBus() {
      return this._eventBus;
    }

    getPauseReason() {
      return this._pauseReason;
    }
  }

  return { MockAgent, mockAgentInstances: instances };
});

vi.mock('../src/agent.js', () => ({
  Agent: MockAgent,
}));

vi.mock('../src/tools/builtin.js', () => ({
  createBuiltinTools: vi.fn(() => []),
}));

import { AgentManager } from '../src/agent-manager.js';

let dataDir: string;
let rolesDir: string;
let roleLoader: RoleLoader;

function makeMockRouter(): LLMRouter {
  return {
    defaultProviderName: 'anthropic',
    chat: vi.fn(),
    chatStream: vi.fn(),
    resolveModalityCandidates: vi.fn(() => []),
    listProviders: vi.fn(() => ['anthropic']),
    getProvider: vi.fn(),
    getDefaultProvider: vi.fn(() => 'anthropic'),
    getModelContextWindow: vi.fn(() => 200000),
    getModelMaxOutput: vi.fn(() => 8000),
    isCompactionSupported: vi.fn(() => true),
  } as unknown as LLMRouter;
}

function createRoleTemplate(name: string, files: Record<string, string>) {
  const roleDir = join(rolesDir, name);
  mkdirSync(roleDir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(roleDir, file), content);
  }
}

function createManager(overrides?: Partial<ConstructorParameters<typeof AgentManager>[0]>) {
  return new AgentManager({
    llmRouter: makeMockRouter(),
    roleLoader,
    dataDir,
    eventBus: new EventBus(),
    ...overrides,
  });
}

beforeEach(() => {
  mockAgentInstances.length = 0;
  dataDir = mkdtempSync(join(tmpdir(), 'markus-agent-mgr-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-agent-mgr-roles-'));
  roleLoader = new RoleLoader([rolesDir]);
  createRoleTemplate('developer', {
    'ROLE.md': '# Developer\nWrites and reviews code.',
    'HEARTBEAT.md': '- Check tasks',
    'POLICIES.md': '## Code\n- Write tests',
  });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
});

describe('AgentManager constructor', () => {
  it('initializes with provided dataDir and event bus', () => {
    const eventBus = new EventBus();
    const manager = createManager({ eventBus });
    expect(manager.getEventBus()).toBe(eventBus);
    expect(manager.maxToolIterations).toBeGreaterThan(0);
  });

  it('allows setting maxToolIterations and cognitiveConfig', () => {
    const manager = createManager();
    manager.maxToolIterations = 50;
    manager.cognitiveConfig = { enabled: true };
    expect(manager.maxToolIterations).toBe(50);
    expect(manager.cognitiveConfig?.enabled).toBe(true);
  });
});

describe('createAgent', () => {
  it('throws when name is empty', async () => {
    const manager = createManager();
    await expect(manager.createAgent({ name: '   ' })).rejects.toThrow('Agent name is required');
  });

  it('creates a custom-role agent and registers it', async () => {
    const manager = createManager();
    const created = await manager.createAgent({
      name: 'Worker One',
      roleName: 'custom',
      orgId: 'org_test',
      tools: [],
    });

    expect(created.id).toMatch(/^agt_/);
    expect(created.config.name).toBe('Worker One');
    expect(manager.hasAgent(created.id)).toBe(true);
    expect(manager.listAgents()).toHaveLength(1);
  });

  it('loads template role files for named roles', async () => {
    const manager = createManager();
    const created = await manager.createAgent({
      name: 'Dev Bot',
      roleName: 'developer',
      tools: [],
    });

    const rolePath = join(dataDir, created.id, 'role', 'ROLE.md');
    expect(readFileSync(rolePath, 'utf-8')).toContain('Developer');
    expect(created.role.name).toBe('Developer');
  });

  it('passes maxToolIterations and cognitive config to Agent constructor', async () => {
    const manager = createManager();
    manager.maxToolIterations = 42;
    manager.cognitiveConfig = { enabled: true };

    await manager.createAgent({ name: 'Cognitive Agent', roleName: 'custom', tools: [] });

    expect(mockAgentInstances).toHaveLength(1);
    expect(mockAgentInstances[0].registerTool).toHaveBeenCalled();
  });

  it('emits agent:created on the event bus', async () => {
    const manager = createManager();
    const handler = vi.fn();
    manager.getEventBus().on('agent:created', handler);

    const created = await manager.createAgent({ name: 'Event Agent', roleName: 'custom', tools: [] });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: created.id, name: 'Event Agent' }),
    );
  });
});

describe('agent lookup', () => {
  it('getAgent returns the registered agent', async () => {
    const manager = createManager();
    const created = await manager.createAgent({ name: 'Lookup Agent', roleName: 'custom', tools: [] });
    expect(manager.getAgent(created.id)).toBe(created);
  });

  it('getAgent throws for unknown id', () => {
    const manager = createManager();
    expect(() => manager.getAgent('agt_missing')).toThrow('Agent not found');
  });

  it('listAgents maps agent state into summaries', async () => {
    const manager = createManager();
    const created = await manager.createAgent({
      name: 'Listed Agent',
      roleName: 'custom',
      agentRole: 'manager',
      skills: ['search'],
      tools: [],
    });

    const listed = manager.listAgents();
    expect(listed).toEqual([
      expect.objectContaining({
        id: created.id,
        name: 'Listed Agent',
        role: created.role.name,
        status: 'idle',
        agentRole: 'manager',
        skills: ['search'],
        activeTaskCount: 0,
      }),
    ]);
  });
});

describe('agent lifecycle', () => {
  it('startAgent delegates to agent.start', async () => {
    const manager = createManager();
    const created = await manager.createAgent({ name: 'Starter', roleName: 'custom', tools: [] });

    await manager.startAgent(created.id, { startAsPaused: true });
    expect(created.start).toHaveBeenCalledWith({ startAsPaused: true });
  });

  it('stopAgent delegates to agent.stop and cleans up scoped resources', async () => {
    const manager = createManager();
    const created = await manager.createAgent({ name: 'Stopper', roleName: 'custom', tools: [] });

    await manager.stopAgent(created.id);
    expect(created.stop).toHaveBeenCalled();
  });

  it('pauseAgentsByIds pauses multiple agents', async () => {
    const manager = createManager();
    const a = await manager.createAgent({ name: 'A', roleName: 'custom', tools: [] });
    const b = await manager.createAgent({ name: 'B', roleName: 'custom', tools: [] });

    const result = manager.pauseAgentsByIds([a.id, b.id], 'batch pause');
    expect(result.success).toEqual([a.id, b.id]);
    expect(a.pause).toHaveBeenCalledWith('batch pause');
    expect(b.pause).toHaveBeenCalledWith('batch pause');
  });

  it('resumeAgentsByIds resumes paused agents only', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Resume Me', roleName: 'custom', tools: [] });
    (agent.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      agentId: agent.id,
      status: 'paused',
      activeTaskCount: 0,
      activeTaskIds: [],
      tokensUsedToday: 0,
    });

    const result = manager.resumeAgentsByIds([agent.id]);
    expect(result.success).toEqual([agent.id]);
    expect(agent.resume).toHaveBeenCalled();
  });

  it('pauseAllAgents and resumeAllAgents toggle global pause flag', async () => {
    const manager = createManager();
    await manager.createAgent({ name: 'Global', roleName: 'custom', tools: [] });

    await manager.pauseAllAgents('maintenance');
    expect(manager.isGlobalPaused()).toBe(true);

    await manager.resumeAllAgents();
    expect(manager.isGlobalPaused()).toBe(false);
  });
});

describe('config update wiring', () => {
  it('setAgentConfigPersister stores callback for later persistence', async () => {
    const manager = createManager();
    const persister = vi.fn(async () => undefined);
    manager.setAgentConfigPersister(persister);

    const created = await manager.createAgent({
      name: 'Renamable',
      roleName: 'custom',
      agentRole: 'manager',
      tools: [],
    });

    (created.config as unknown as Record<string, unknown>).name = 'Renamed';
    await persister(created.id, { name: 'Renamed' });

    expect(persister).toHaveBeenCalledWith(created.id, { name: 'Renamed' });
    expect(created.config.name).toBe('Renamed');
  });

  it('setApprovalHandler wires approval into created agents', async () => {
    const manager = createManager();
    const handler = vi.fn(async () => ({ approved: true }));
    manager.setApprovalHandler(handler);

    const created = await manager.createAgent({ name: 'Approved', roleName: 'custom', tools: [] });
    expect(created.setApprovalCallback).toHaveBeenCalled();
  });
});

describe('role sync logic', () => {
  it('syncRoleFromTemplate copies template files and reloads role', async () => {
    const manager = createManager();
    const created = await manager.createAgent({
      name: 'Sync Agent',
      roleName: 'developer',
      tools: [],
    });

    const agentRoleDir = join(dataDir, created.id, 'role');
    writeFileSync(join(agentRoleDir, 'ROLE.md'), '# Developer\nOld local copy.');

    createRoleTemplate('developer', {
      'ROLE.md': '# Developer\nUpdated template content.',
      'HEARTBEAT.md': '- New heartbeat item',
    });

    const result = manager.syncRoleFromTemplate(created.id);
    expect(result.success).toBe(true);
    expect(result.synced).toContain('ROLE.md');
    expect(readFileSync(join(agentRoleDir, 'ROLE.md'), 'utf-8')).toContain('Updated template content');
    expect(created.reloadRole).toHaveBeenCalled();
  });

  it('syncRoleFromTemplate returns error when template is missing', async () => {
    const manager = createManager();
    const created = await manager.createAgent({
      name: 'Custom Only',
      roleName: 'custom',
      tools: [],
    });

    const result = manager.syncRoleFromTemplate(created.id);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No template found/);
  });

  it('checkRoleUpdate detects modified role files', async () => {
    const manager = createManager();
    const created = await manager.createAgent({
      name: 'Drift Agent',
      roleName: 'developer',
      tools: [],
    });

    const agentRoleDir = join(dataDir, created.id, 'role');
    writeFileSync(join(agentRoleDir, 'ROLE.md'), '# Developer\nLocally modified.');

    const status = manager.checkRoleUpdate(created.id);
    expect(status.hasTemplate).toBe(true);
    expect(status.isUpToDate).toBe(false);
    expect(status.files.some(f => f.file === 'ROLE.md' && f.status === 'modified')).toBe(true);
  });

  it('getRoleFileDiff returns agent and template contents', async () => {
    const manager = createManager();
    const created = await manager.createAgent({
      name: 'Diff Agent',
      roleName: 'developer',
      tools: [],
    });

    writeFileSync(join(dataDir, created.id, 'role', 'ROLE.md'), '# Developer\nAgent copy');

    const diff = manager.getRoleFileDiff(created.id, 'ROLE.md');
    expect(diff.agentContent).toContain('Agent copy');
    expect(diff.templateContent).toContain('Developer');
  });
});

describe('batch control', () => {
  it('startAgentsByIds reports success and failure separately', async () => {
    const manager = createManager();
    const created = await manager.createAgent({ name: 'Batch', roleName: 'custom', tools: [] });

    const result = await manager.startAgentsByIds([created.id, 'agt_missing']);
    expect(result.success).toEqual([created.id]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe('agt_missing');
  });

  it('stopAgentsByIds stops each agent', async () => {
    const manager = createManager();
    const created = await manager.createAgent({ name: 'Batch Stop', roleName: 'custom', tools: [] });

    const result = await manager.stopAgentsByIds([created.id]);
    expect(result.success).toEqual([created.id]);
    expect(created.stop).toHaveBeenCalled();
  });
});

describe('buildPathPolicy', () => {
  it('excludes other agent directories from write access', async () => {
    const manager = createManager();
    const first = await manager.createAgent({ name: 'First', roleName: 'custom', tools: [] });
    const second = await manager.createAgent({ name: 'Second', roleName: 'custom', tools: [] });

    const policy = manager.buildPathPolicy(second.id, join(dataDir, second.id, 'workspace'));
    expect(policy.denyWritePaths).toContain(join(dataDir, first.id));
    expect(policy.denyWritePaths).not.toContain(join(dataDir, second.id));
  });
});

describe('removeAgent and cleanup', () => {
  it('removeAgent stops agent and unregisters it', async () => {
    const manager = createManager();
    const created = await manager.createAgent({ name: 'Removable', roleName: 'custom', tools: [] });

    await manager.removeAgent(created.id);
    expect(manager.hasAgent(created.id)).toBe(false);
    expect(created.stop).toHaveBeenCalled();
  });

  it('removeAgent with purgeFiles deletes agent data directory', async () => {
    const manager = createManager();
    const created = await manager.createAgent({
      name: 'Purge Me',
      roleName: 'developer',
      tools: [],
    });
    const agentDir = join(dataDir, created.id);
    expect(readFileSync(join(agentDir, 'role', 'ROLE.md'), 'utf-8')).toBeTruthy();

    await manager.removeAgent(created.id, { purgeFiles: true });
    expect(() => readFileSync(join(agentDir, 'role', 'ROLE.md'))).toThrow();
  });

  it('purgeOrphanedAgentDirs removes unknown directories', async () => {
    const manager = createManager();
    const created = await manager.createAgent({ name: 'Known', roleName: 'custom', tools: [] });

    const orphanDir = join(dataDir, 'agt_orphan_xyz');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'orphan.txt'), 'orphan');

    const result = manager.purgeOrphanedAgentDirs(new Set([created.id]));
    expect(result.removed).toContain('agt_orphan_xyz');
    expect(() => readFileSync(join(orphanDir, 'orphan.txt'))).toThrow();
  });
});

describe('listAvailableRoles and data dir accessors', () => {
  it('listAvailableRoles returns template role names', () => {
    const manager = createManager();
    expect(manager.listAvailableRoles()).toContain('developer');
  });

  it('getDataDir returns configured data directory', () => {
    const manager = createManager();
    expect(manager.getDataDir()).toBe(dataDir);
  });
});

describe('emergency and global control', () => {
  it('emergencyStop stops all agents and sets global pause', async () => {
    const manager = createManager();
    const handler = vi.fn();
    manager.getEventBus().on('system:emergency-stop', handler);

    const a = await manager.createAgent({ name: 'E1', roleName: 'custom', tools: [] });
    const b = await manager.createAgent({ name: 'E2', roleName: 'custom', tools: [] });

    await manager.emergencyStop();
    expect(a.stop).toHaveBeenCalled();
    expect(b.stop).toHaveBeenCalled();
    expect(manager.isGlobalPaused()).toBe(true);
    expect(handler).toHaveBeenCalled();
  });

  it('setGlobalPaused toggles global pause flag', () => {
    const manager = createManager();
    manager.setGlobalPaused(true);
    expect(manager.isGlobalPaused()).toBe(true);
    manager.setGlobalPaused(false);
    expect(manager.isGlobalPaused()).toBe(false);
  });
});

describe('handler wiring', () => {
  it('setStateChangeHandler wires callback to existing agents', async () => {
    const manager = createManager();
    const handler = vi.fn();
    manager.setStateChangeHandler(handler);

    const created = await manager.createAgent({ name: 'State Agent', roleName: 'custom', tools: [] });
    expect(created.setStateChangeCallback).toHaveBeenCalled();
  });

  it('setActivityCallbacks propagates to all agents', async () => {
    const manager = createManager();
    const cbs = {
      onStart: vi.fn(),
      onLog: vi.fn(),
      onEnd: vi.fn(),
    };
    manager.setActivityCallbacks(cbs);

    const created = await manager.createAgent({ name: 'Activity Agent', roleName: 'custom', tools: [] });
    expect(created.setActivityCallbacks).toHaveBeenCalledWith(cbs);
  });

  it('setAuditCallback wires audit events to agents', async () => {
    const manager = createManager();
    const audit = vi.fn();
    manager.setAuditCallback(audit);

    const created = await manager.createAgent({ name: 'Audit Agent', roleName: 'custom', tools: [] });
    expect(created.setAuditCallback).toHaveBeenCalled();
  });

  it('forwards agent events to manager event bus', async () => {
    const eventBus = new EventBus();
    const manager = createManager({ eventBus });
    const forwarded = vi.fn();
    eventBus.on('agent:paused', forwarded);

    const created = await manager.createAgent({ name: 'Forward Agent', roleName: 'custom', tools: [] });
    created.getEventBus().emit('agent:paused', { agentId: created.id, reason: 'test' });
    expect(forwarded).toHaveBeenCalledWith(expect.objectContaining({ agentId: created.id }));
  });
});

describe('createAgentFromTemplate', () => {
  it('creates agent from template registry entry', async () => {
    const manager = createManager();
    manager.setTemplateRegistry({
      get: vi.fn((id: string) => id === 'tpl_dev' ? {
        roleId: 'custom',
        agentRole: 'worker',
        skills: ['search'],
        heartbeatIntervalMs: 60000,
        llmProvider: 'anthropic',
      } : undefined),
    } as never);

    const created = await manager.createAgentFromTemplate({
      templateId: 'tpl_dev',
      name: 'From Template',
      orgId: 'org_1',
    });

    expect(created.config.name).toBe('From Template');
    expect(manager.hasAgent(created.id)).toBe(true);
  });

  it('throws when template registry is not configured', async () => {
    const manager = createManager();
    await expect(manager.createAgentFromTemplate({
      templateId: 'missing',
      name: 'X',
      orgId: 'org_1',
    })).rejects.toThrow('Template registry not configured');
  });
});

describe('getDelegationManager', () => {
  it('returns delegation manager instance', () => {
    const manager = createManager();
    expect(manager.getDelegationManager()).toBeDefined();
  });
});

describe('announcements and identity', () => {
  it('broadcastAnnouncement enqueues to online agents and emits event', async () => {
    const eventBus = new EventBus();
    const manager = createManager({ eventBus });
    const handler = vi.fn();
    eventBus.on('system:announcement', handler);

    const agent = await manager.createAgent({ name: 'Ann Agent', roleName: 'custom', tools: [] });
    (agent.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      agentId: agent.id,
      status: 'idle',
      activeTaskCount: 0,
      activeTaskIds: [],
      tokensUsedToday: 0,
    });

    manager.broadcastAnnouncement({
      id: 'ann_1',
      title: 'Maintenance',
      body: 'Downtime at midnight',
      acknowledged: [],
    });

    expect(agent.enqueueToMailbox).toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'ann_1' }));
    expect(manager.getActiveAnnouncements()).toHaveLength(1);
  });

  it('acknowledgeAnnouncement records agent acknowledgement', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Ack Agent', roleName: 'custom', tools: [] });

    manager.broadcastAnnouncement({
      id: 'ann_2',
      title: 'Deploy',
      body: 'New version',
      acknowledged: [],
    });

    manager.acknowledgeAnnouncement('ann_2', agent.id);
    const active = manager.getActiveAnnouncements();
    expect(active[0]?.acknowledged).toContain(agent.id);
  });

  it('checkAllRoleUpdates aggregates per-agent status', async () => {
    const manager = createManager();
    await manager.createAgent({ name: 'Role A', roleName: 'developer', tools: [] });
    await manager.createAgent({ name: 'Role B', roleName: 'custom', tools: [] });

    const updates = manager.checkAllRoleUpdates();
    expect(updates.length).toBe(2);
    expect(updates.some(u => u.hasTemplate)).toBe(true);
  });

  it('refreshIdentityContexts sets identity on org agents', async () => {
    const manager = createManager();
    const a = await manager.createAgent({
      name: 'Team Worker',
      roleName: 'custom',
      orgId: 'org_ctx',
      teamId: 'team_alpha',
      tools: [],
    });
    const b = await manager.createAgent({
      name: 'Team Mate',
      roleName: 'custom',
      orgId: 'org_ctx',
      teamId: 'team_alpha',
      agentRole: 'manager',
      tools: [],
    });

    manager.refreshIdentityContexts(
      'org_ctx',
      'Context Org',
      [{ id: 'human_1', name: 'Alice', role: 'admin' }],
      [{ id: 'team_alpha', name: 'Alpha', memberAgentIds: [a.id, b.id] }],
      [{ id: 'proj_1', name: 'Project One', description: 'Main', status: 'active', teamIds: ['team_alpha'] }],
    );

    expect(a.setIdentityContext).toHaveBeenCalled();
    expect(b.setIdentityContext).toHaveBeenCalled();
  });
});

describe('service wiring setters', () => {
  it('setUserApprovalRequester and setUserNotifier propagate to agents', async () => {
    const manager = createManager();
    manager.setUserApprovalRequester(vi.fn(async () => ({ approved: true })));
    manager.setUserNotifier(vi.fn());

    const agent = await manager.createAgent({ name: 'Notify Agent', roleName: 'custom', tools: [] });
    expect(agent.setUserApprovalRequester).toHaveBeenCalled();
    expect(agent.setUserNotifier).toHaveBeenCalled();
  });

  it('setProjectService and setRequirementService are stored', async () => {
    const manager = createManager();
    const projectService = { listProjects: vi.fn(() => []) };
    const requirementService = {
      listRequirements: vi.fn(() => []),
      proposeRequirement: vi.fn(),
      updateRequirementStatus: vi.fn(),
      rejectRequirement: vi.fn(),
      cancelRequirement: vi.fn(),
      updateRequirement: vi.fn(),
      resubmitRequirement: vi.fn(),
      getRequirement: vi.fn(),
    };

    manager.setProjectService(projectService as never);
    manager.setRequirementService(requirementService as never);

    const agent = await manager.createAgent({
      name: 'Service Agent',
      roleName: 'custom',
      orgId: 'org_svc',
      tools: [],
    });
    expect(agent).toBeDefined();
  });

  it('setDeliverableService wires deliverable tools', async () => {
    const manager = createManager();
    manager.setDeliverableService({
      createDeliverable: vi.fn(),
      searchDeliverables: vi.fn(() => []),
      getDeliverable: vi.fn(),
    } as never);

    const agent = await manager.createAgent({
      name: 'Deliverable Agent',
      roleName: 'custom',
      orgId: 'org_del',
      tools: [],
    });
    expect(agent.registerTool).toHaveBeenCalled();
  });

  it('setRecallCallbacks registers on existing agents', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Recall Existing', roleName: 'custom', tools: [] });

    manager.setRecallCallbacks({ queryActivities: vi.fn(async () => []) });
    expect(agent.registerTool).toHaveBeenCalled();
  });

  it('createAgent with llmProvider uses custom model mode', async () => {
    const manager = createManager();
    const created = await manager.createAgent({
      name: 'Custom LLM',
      roleName: 'custom',
      llmProvider: 'openai',
      tools: [],
    });

    expect(created.config.llmConfig.modelMode).toBe('custom');
    expect(created.config.llmConfig.primary).toBe('openai');
  });

  it('getTemplateRegistry returns configured registry', () => {
    const manager = createManager();
    const registry = { get: vi.fn() };
    manager.setTemplateRegistry(registry as never);
    expect(manager.getTemplateRegistry()).toBe(registry);
  });

  it('pauseAgentsByIds reports failures for unknown agents', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Pause Me', roleName: 'custom', tools: [] });

    const result = manager.pauseAgentsByIds([agent.id, 'agt_missing'], 'test pause');
    expect(result.success).toEqual([agent.id]);
    expect(result.failed).toHaveLength(1);
  });

  it('resumeAgentsByIds skips resume for agents that are not paused', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Idle Agent', roleName: 'custom', tools: [] });

    const result = manager.resumeAgentsByIds([agent.id]);
    expect(result.success).toEqual([agent.id]);
    expect(agent.resume).not.toHaveBeenCalled();
  });

  it('syncRoleFromTemplate syncs selected files only', async () => {
    const manager = createManager();
    const created = await manager.createAgent({ name: 'Partial Sync', roleName: 'developer', tools: [] });

    createRoleTemplate('developer', {
      'ROLE.md': '# Developer\nPartial sync role.',
      'HEARTBEAT.md': '- Updated heartbeat only',
    });

    const result = manager.syncRoleFromTemplate(created.id, ['HEARTBEAT.md']);
    expect(result.success).toBe(true);
    expect(result.synced).toEqual(['HEARTBEAT.md']);
    expect(readFileSync(join(dataDir, created.id, 'role', 'HEARTBEAT.md'), 'utf-8')).toContain('Updated heartbeat');
  });
});
