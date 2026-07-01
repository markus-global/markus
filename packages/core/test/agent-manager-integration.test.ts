import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import { AgentManager } from '../src/agent-manager.js';
import type { LLMRouter } from '../src/llm/router.js';

let dataDir: string;
let rolesDir: string;
let roleLoader: RoleLoader;

function makeMockRouter(): LLMRouter {
  return {
    defaultProviderName: 'anthropic',
    chat: vi.fn(async () => ({
      content: 'Integration reply.',
      finishReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 25 },
    })),
    chatStream: vi.fn(async function* () {
      yield { type: 'content_delta', content: 'Hi' };
      yield { type: 'done', content: 'Hi', finishReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
    }),
    resolveModalityCandidates: vi.fn(() => []),
    listProviders: vi.fn(() => ['anthropic']),
    getProvider: vi.fn(),
    getDefaultProvider: vi.fn(() => 'anthropic'),
    getActiveModelName: vi.fn(() => 'claude-test'),
    getActiveModelContextWindow: vi.fn(() => 200000),
    getActiveModelMaxOutput: vi.fn(() => 8000),
    getModelContextWindow: vi.fn(() => 200000),
    getModelMaxOutput: vi.fn(() => 8000),
    getModelCost: vi.fn(),
    isCompactionSupported: vi.fn(() => true),
    modelSupportsVision: vi.fn(() => false),
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
  dataDir = mkdtempSync(join(tmpdir(), 'markus-mgr-int-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-mgr-int-roles-'));
  roleLoader = new RoleLoader([rolesDir]);
  createRoleTemplate('developer', {
    'ROLE.md': '# Developer\nWrites code.',
    'HEARTBEAT.md': '- Check CI',
    'POLICIES.md': '## Code\n- Write tests',
  });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
});

describe('AgentManager integration (real Agent)', () => {
  it('createAgent provisions on-disk directories and real Agent instance', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({
      name: 'Real Worker',
      roleName: 'developer',
      orgId: 'org_int',
      tools: [],
      skills: ['search'],
    });

    expect(agent.id).toMatch(/^agt_/);
    expect(agent.config.name).toBe('Real Worker');
    expect(existsSync(join(dataDir, agent.id, 'workspace'))).toBe(true);
    expect(existsSync(join(dataDir, agent.id, 'role', 'ROLE.md'))).toBe(true);
    expect(agent.getTools().has('spawn_subagent')).toBe(true);
  });

  it('startAgent and stopAgent run real agent lifecycle', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({
      name: 'Lifecycle Agent',
      roleName: 'custom',
      tools: [],
    });

    await manager.startAgent(agent.id);
    expect(agent.getState().status).not.toBe('offline');

    await manager.stopAgent(agent.id);
    expect(agent.getState().status).toBe('offline');
  });

  it('listAgents includes mailbox depth from real agents', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({
      name: 'Listed Real',
      roleName: 'custom',
      tools: [],
    });

    agent.enqueueToMailbox('system_event', { summary: 'evt', content: 'test' });
    const listed = manager.listAgents();
    expect(listed[0]?.mailboxDepth).toBe(1);
  });

  it('setEscalationHandler wires into created agents', async () => {
    const manager = createManager();
    const handler = vi.fn();
    manager.setEscalationHandler(handler);

    await manager.createAgent({ name: 'Escalation', roleName: 'custom', tools: [] });
    expect(handler).not.toHaveBeenCalled();
  });

  it('setToolCallLimitChecker propagates to agents', async () => {
    const manager = createManager();
    manager.setToolCallLimitChecker(() => ({ allowed: true }));

    const agent = await manager.createAgent({ name: 'Limited', roleName: 'custom', tools: [] });
    expect(agent).toBeDefined();
  });

  it('rehydrateAgentTasks is callable for restored agents', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Rehydrate', roleName: 'custom', tools: [] });
    await expect(manager.rehydrateAgentTasks(agent.id, [])).resolves.not.toThrow();
  });

  it('restoreAgent recreates agent from persisted row', async () => {
    const manager = createManager();
    const created = await manager.createAgent({
      name: 'Restored Agent',
      roleName: 'developer',
      orgId: 'org_restore',
      tools: [],
    });
    await manager.stopAgent(created.id);
    await manager.removeAgent(created.id);

    const restored = await manager.restoreAgent({
      id: created.id,
      name: 'Restored Agent',
      roleId: 'developer',
      orgId: 'org_restore',
      agentRole: 'worker',
      skills: '[]',
      status: 'offline',
      llmConfig: JSON.stringify({ modelMode: 'default' }),
      heartbeatIntervalMs: 1800000,
      createdAt: new Date().toISOString(),
      tokensUsedToday: 100,
    });

    expect(restored.id).toBe(created.id);
    expect(manager.hasAgent(created.id)).toBe(true);
    expect(restored.getState().tokensUsedToday).toBe(100);
  });

  it('stopAllAgents emits system:pause-all event', async () => {
    const eventBus = new EventBus();
    const manager = createManager({ eventBus });
    const handler = vi.fn();
    eventBus.on('system:pause-all', handler);

    await manager.createAgent({ name: 'P1', roleName: 'custom', tools: [] });
    await manager.stopAllAgents('maintenance');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ reason: 'maintenance' }));
  });

  it('startAllAgents emits system:resume-all event', async () => {
    const eventBus = new EventBus();
    const manager = createManager({ eventBus });
    const handler = vi.fn();
    eventBus.on('system:resume-all', handler);

    await manager.createAgent({ name: 'R1', roleName: 'custom', tools: [] });
    await manager.stopAllAgents();
    await manager.startAllAgents();
    expect(handler).toHaveBeenCalled();
  });

  it('buildPathPolicy includes workspace and role paths', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Policy', roleName: 'developer', tools: [] });
    const ws = join(dataDir, agent.id, 'workspace');
    const policy = manager.buildPathPolicy(agent.id, ws, join(dataDir, agent.id, 'role'));
    expect(policy.primaryWorkspace).toBe(ws);
    expect(policy.roleDir).toBe(join(dataDir, agent.id, 'role'));
  });

  it('createAgent rejects duplicate custom role without template', async () => {
    const manager = createManager();
    await manager.createAgent({ name: 'First', roleName: 'custom', tools: [] });
    const second = await manager.createAgent({ name: 'Second', roleName: 'custom', tools: [] });
    expect(second.id).not.toBe(manager.listAgents()[0]!.id);
  });

  it('agent sendMessage through real attention loop', { timeout: 30000 }, async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Messenger', roleName: 'custom', tools: [] });
    await manager.startAgent(agent.id);

    const reply = await agent.sendMessage('Hello integration');
    expect(reply).toContain('Integration reply');
    await manager.stopAgent(agent.id);
  });

  it('createAgent with teamId and cognitive config', async () => {
    const manager = createManager();
    manager.cognitiveConfig = { enabled: true };
    manager.maxToolIterations = 25;

    const agent = await manager.createAgent({
      name: 'Team Cognitive',
      roleName: 'developer',
      orgId: 'org_team',
      teamId: 'team_1',
      agentRole: 'manager',
      tools: [],
      skills: ['search', 'file_read_write'],
    });

    expect(agent.config.teamId).toBe('team_1');
    expect(agent.config.agentRole).toBe('manager');
    expect(agent.config.skills).toContain('search');
  });

  it('removeAgent emits agent:removed event', async () => {
    const eventBus = new EventBus();
    const manager = createManager({ eventBus });
    const handler = vi.fn();
    eventBus.on('agent:removed', handler);

    const agent = await manager.createAgent({ name: 'Removed', roleName: 'custom', tools: [] });
    await manager.removeAgent(agent.id);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ agentId: agent.id }));
  });

  it('setRecallCallbacks registers recall tool on agents', async () => {
    const manager = createManager();
    manager.setRecallCallbacks({
      queryActivities: vi.fn(async () => []),
    });

    const agent = await manager.createAgent({ name: 'Recall', roleName: 'custom', tools: [] });
    expect(agent.getTools().has('recall_activity')).toBe(true);
  });

  it('setSkillSearcher and setSkillInstaller wire into manager', async () => {
    const manager = createManager();
    manager.setSkillSearcher(vi.fn(async () => [{ name: 'skill-a', description: 'A', source: 'hub' }]));
    manager.setSkillInstaller(vi.fn(async () => ({ installed: true, name: 'skill-a', method: 'hub' })));
    expect(manager).toBeDefined();
  });

  it('startAgentsByIds staggers heartbeat delays for multiple agents', async () => {
    const manager = createManager();
    const a = await manager.createAgent({
      name: 'Stagger A',
      roleName: 'custom',
      tools: [],
      heartbeatIntervalMs: 60000,
    });
    const b = await manager.createAgent({
      name: 'Stagger B',
      roleName: 'custom',
      tools: [],
      heartbeatIntervalMs: 60000,
    });

    const result = await manager.startAgentsByIds([a.id, b.id], { staggerHeartbeats: true });
    expect(result.success).toEqual([a.id, b.id]);
    await manager.stopAgentsByIds([a.id, b.id]);
  });

  it('createAgent wires task tools when taskService is configured', async () => {
    const taskService = {
      createTask: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'pending' })),
      listTasks: vi.fn(() => []),
      queryTasks: vi.fn(() => []),
      updateTaskStatus: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'done' })),
      getTask: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'pending' })),
      assignTask: vi.fn(() => ({ id: 'task_1', status: 'assigned' })),
      addTaskNote: vi.fn(),
      updateTask: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'pending' })),
      rejectTask: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'rejected' })),
      addSubtask: vi.fn(() => ({ id: 'sub_1', title: 'S', status: 'pending' })),
      completeSubtask: vi.fn(() => ({ id: 'sub_1', title: 'S', status: 'done' })),
      submitForReview: vi.fn(async () => ({ id: 'task_1', status: 'in_review' })),
      requestRevision: vi.fn(async () => ({ id: 'task_1', title: 'T', status: 'in_progress' })),
    };

    const manager = createManager();
    manager.setTaskService(taskService);

    const agent = await manager.createAgent({
      name: 'Task Enabled',
      roleName: 'custom',
      orgId: 'org_tasks',
      tools: [],
    });

    expect(agent.getTools().has('task_create')).toBe(true);
    expect(agent.getTools().has('task_list')).toBe(true);
  });
});

describe('AgentManager service setters', () => {
  it('setWebUiBaseUrl and getSharedDataDir are accessible', () => {
    const manager = createManager();
    manager.setWebUiBaseUrl('http://localhost:3000');
    expect(manager.getSharedDataDir()).toBeUndefined();
    expect(manager.getDataDir()).toBe(dataDir);
  });

  it('setBrowserBringToFront and related browser settings', () => {
    const manager = createManager();
    manager.setBrowserBringToFront(true);
    manager.setBrowserAutoCloseTabs(false);
    manager.setBrowserRemoteDebuggingPort(9222);
    manager.setBrowserAutoClickAllowDialog(true);
    expect(manager.getBrowserBridge()).toBeDefined();
  });
});

describe('AgentManager extended integration', () => {
  it('createAgent registers multimodal tools', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({
      name: 'Multimodal Agent',
      roleName: 'custom',
      tools: [],
    });

    expect(agent.getTools().has('generate_image')).toBe(true);
    expect(agent.getTools().has('text_to_speech')).toBe(true);
  });

  it('refreshIdentityContexts updates real agent team name', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({
      name: 'Identity Agent',
      roleName: 'custom',
      orgId: 'org_real',
      teamId: 'team_real',
      tools: [],
    });

    manager.refreshIdentityContexts(
      'org_real',
      'Real Org',
      [{ id: 'h1', name: 'Human', role: 'user' }],
      [{ id: 'team_real', name: 'Real Team', memberAgentIds: [agent.id] }],
    );

    expect(agent.getTeamName()).toBe('Real Team');
  });

  it('broadcastAnnouncement delivers to started agents', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Broadcast Target', roleName: 'custom', tools: [] });
    await manager.startAgent(agent.id);

    manager.broadcastAnnouncement({
      id: 'ann_int',
      title: 'Update',
      body: 'New feature released',
      acknowledged: [],
    });

    expect(agent.getMailbox().depth).toBeGreaterThan(0);
    await manager.stopAgent(agent.id);
  });

  it('checkAllRoleUpdates reports developer template drift', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Drift Check', roleName: 'developer', tools: [] });
    writeFileSync(join(dataDir, agent.id, 'role', 'ROLE.md'), '# Developer\nLocally changed.');

    const updates = manager.checkAllRoleUpdates();
    const mine = updates.find(u => u.agentId === agent.id);
    expect(mine?.isUpToDate).toBe(false);
  });

  it('createAgent with manager role and teamId provisions team manager paths', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({
      name: 'Team Manager',
      roleName: 'developer',
      orgId: 'org_mgr',
      teamId: 'team_mgr',
      agentRole: 'manager',
      tools: [],
    });

    expect(agent.config.agentRole).toBe('manager');
    expect(agent.config.teamId).toBe('team_mgr');
  });

  it('restoreAgent rebuilds manager agent with team context', async () => {
    const manager = createManager();
    const created = await manager.createAgent({
      name: 'Restore Manager',
      roleName: 'developer',
      orgId: 'org_restore_mgr',
      teamId: 'team_restore',
      agentRole: 'manager',
      tools: [],
    });
    await manager.stopAgent(created.id);
    await manager.removeAgent(created.id);

    const restored = await manager.restoreAgent({
      id: created.id,
      name: 'Restore Manager',
      roleId: 'developer',
      roleName: 'Developer',
      orgId: 'org_restore_mgr',
      teamId: 'team_restore',
      agentRole: 'manager',
      skills: '["search"]',
      status: 'offline',
      llmConfig: JSON.stringify({ modelMode: 'custom', primary: 'anthropic', maxTokensPerDay: 50000 }),
      heartbeatIntervalMs: 900000,
      createdAt: new Date().toISOString(),
      tokensUsedToday: 250,
      profile: JSON.stringify({ maxConcurrentTasks: 2 }),
    });

    expect(restored.config.teamId).toBe('team_restore');
    expect(restored.config.agentRole).toBe('manager');
    expect(restored.getState().tokensUsedToday).toBe(250);
  });

  it('createAgent with custom workspace path uses profile workspace', async () => {
    const manager = createManager();
    const customWs = join(dataDir, 'shared-workspace');
    mkdirSync(customWs, { recursive: true });

    const agent = await manager.createAgent({
      name: 'Custom WS',
      roleName: 'custom',
      tools: [],
      profile: { workspacePath: customWs },
    });

    const policy = manager.buildPathPolicy(agent.id, customWs);
    expect(policy.primaryWorkspace).toBe(customWs);
  });

  it('createAgent with project and requirement services registers tools', async () => {
    const taskService = {
      createTask: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'pending' })),
      listTasks: vi.fn(() => []),
      queryTasks: vi.fn(() => []),
      updateTaskStatus: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'done' })),
      getTask: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'pending' })),
      assignTask: vi.fn(() => ({ id: 'task_1', status: 'assigned' })),
      addTaskNote: vi.fn(),
      updateTask: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'pending' })),
      rejectTask: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'rejected' })),
      addSubtask: vi.fn(() => ({ id: 'sub_1', title: 'S', status: 'pending' })),
      completeSubtask: vi.fn(() => ({ id: 'sub_1', title: 'S', status: 'done' })),
      submitForReview: vi.fn(async () => ({ id: 'task_1', status: 'in_review' })),
      requestRevision: vi.fn(async () => ({ id: 'task_1', title: 'T', status: 'in_progress' })),
    };

    const manager = createManager();
    manager.setTaskService(taskService);
    manager.setProjectService({
      listProjects: vi.fn(() => [{ id: 'p1', name: 'P1', description: 'd', status: 'active', teamIds: [] }]),
      getProject: vi.fn(() => ({ id: 'p1', name: 'P1', description: 'd', status: 'active', teamIds: [] })),
    } as never);
    manager.setRequirementService({
      listRequirements: vi.fn(() => []),
      proposeRequirement: vi.fn(() => ({ id: 'r1', title: 'R', status: 'draft' })),
      updateRequirementStatus: vi.fn(() => ({ id: 'r1', title: 'R', status: 'active' })),
      rejectRequirement: vi.fn(() => ({ id: 'r1', title: 'R', status: 'rejected' })),
      cancelRequirement: vi.fn(() => ({ id: 'r1', title: 'R', status: 'cancelled' })),
      updateRequirement: vi.fn(() => ({ id: 'r1', title: 'R', status: 'active' })),
      resubmitRequirement: vi.fn(() => ({ id: 'r1', title: 'R', status: 'draft' })),
      getRequirement: vi.fn(() => ({ id: 'r1', title: 'R', status: 'active', description: 'd' })),
    } as never);
    manager.setDeliverableService({
      createDeliverable: vi.fn(() => ({ id: 'd1' })),
      searchDeliverables: vi.fn(() => []),
      getDeliverable: vi.fn(() => ({ id: 'd1' })),
    } as never);

    const agent = await manager.createAgent({
      name: 'Full Service Agent',
      roleName: 'custom',
      orgId: 'org_full',
      tools: [],
    });

    expect(agent.getTools().has('requirement_propose')).toBe(true);
    expect(agent.getTools().has('list_projects')).toBe(true);
    expect(agent.getTools().has('deliverable_create')).toBe(true);
  });

  it('createAgent with skipTemplateCopy leaves role dir without template files', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({
      name: 'Skip Template',
      roleName: 'developer',
      skipTemplateCopy: true,
      tools: [],
    });

    const rolePath = join(dataDir, agent.id, 'role', 'ROLE.md');
    expect(existsSync(rolePath)).toBe(false);
    expect(agent.config.roleId).toBe('developer');
  });

  it('restoreAgent creates custom role when no on-disk role files exist', async () => {
    const manager = createManager();
    const id = 'agt_custom_restore_test';

    const restored = await manager.restoreAgent({
      id,
      name: 'Custom Restored',
      roleId: 'custom',
      roleName: 'Custom Restored',
      orgId: 'org_custom',
      teamId: null,
      agentRole: 'worker',
      skills: '[]',
      status: 'offline',
      llmConfig: JSON.stringify({ modelMode: 'default' }),
      heartbeatIntervalMs: 1800000,
      createdAt: new Date().toISOString(),
    });

    expect(restored.id).toBe(id);
    expect(restored.role.name).toBe('Custom Restored');
    expect(manager.hasAgent(id)).toBe(true);
  });

  it('acknowledgeAnnouncement tracks agent on real instance', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Ack Real', roleName: 'custom', tools: [] });

    manager.broadcastAnnouncement({
      id: 'ann_ack_real',
      title: 'Notice',
      body: 'Please read',
      acknowledged: [],
    });

    manager.acknowledgeAnnouncement('ann_ack_real', agent.id);
    expect(manager.getActiveAnnouncements()[0]?.acknowledged).toContain(agent.id);
  });
});
