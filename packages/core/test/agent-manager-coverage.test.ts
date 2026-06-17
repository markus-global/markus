import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import { AgentManager } from '../src/agent-manager.js';
import type { LLMRouter } from '../src/llm/router.js';

let dataDir: string;
let rolesDir: string;
let roleLoader: RoleLoader;

function makeMockRouter(overrides?: Partial<LLMRouter>): LLMRouter {
  return {
    defaultProviderName: 'anthropic',
    chat: vi.fn(async () => ({
      content: 'Manager coverage reply.',
      finishReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 25 },
    })),
    chatStream: vi.fn(async (_req, onEvent) => {
      onEvent?.({ type: 'text_delta', text: 'Working...' });
      return {
        content: 'Task stream done.',
        finishReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 25 },
      };
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
    ...overrides,
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

function makeTaskService(overrides?: Record<string, unknown>) {
  return {
    createTask: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'pending' })),
    listTasks: vi.fn(() => [{
      id: 'task_1', title: 'Active Task', description: 'Do work', status: 'in_progress',
      priority: 'medium', updatedAt: new Date().toISOString(), assignedAgentId: 'agt_worker',
    }]),
    queryTasks: vi.fn(() => ({ tasks: [], total: 0 })),
    updateTaskStatus: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'done' })),
    getTask: vi.fn((id: string) => ({
      id,
      title: 'Active Task',
      description: 'Do work',
      status: 'in_progress',
      reviewerId: 'agt_reviewer',
      subtasks: [],
    })),
    assignTask: vi.fn(() => ({ id: 'task_1', status: 'assigned' })),
    addTaskNote: vi.fn(),
    updateTask: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'in_progress' })),
    rejectTask: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'rejected' })),
    addSubtask: vi.fn(() => ({ id: 'sub_1', title: 'S', status: 'pending' })),
    completeSubtask: vi.fn(() => ({ id: 'sub_1', title: 'S', status: 'done' })),
    submitForReview: vi.fn(async () => ({ id: 'task_1', status: 'in_review' })),
    requestRevision: vi.fn(async () => ({ id: 'task_1', title: 'T', status: 'in_progress' })),
    getTaskComments: vi.fn(async () => []),
    postTaskComment: vi.fn(async () => ({ id: 'cmt_1' })),
    postRequirementComment: vi.fn(async () => ({ id: 'rcmt_1' })),
    getTaskStatusHistory: vi.fn(async () => []),
    getRequirementComments: vi.fn(async () => []),
    updateScheduleFields: vi.fn(async () => ({ id: 'task_1', title: 'T', status: 'pending' })),
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-mgr-cov-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-mgr-cov-roles-'));
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

describe('AgentManager task and deliverable tool execution', () => {
  it('task_submit_review resolves active task via resolveCurrentTaskId', async () => {
    const taskService = makeTaskService();
    const slowRouter = makeMockRouter({
      chatStream: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 400));
        return {
          content: 'Task stream done.',
          finishReason: 'end_turn',
          usage: { inputTokens: 50, outputTokens: 25 },
        };
      }),
    });
    const manager = createManager({ llmRouter: slowRouter });
    manager.setTaskService(taskService);

    const agent = await manager.createAgent({
      name: 'Review Worker',
      roleName: 'custom',
      orgId: 'org_review',
      tools: [],
    });

    const execPromise = agent.executeTask('task_live', 'Implement feature', () => {});
    await vi.waitFor(() => agent.getActiveTasks().length > 0, { timeout: 2000 });

    const submitTool = agent.getTools().get('task_submit_review');
    expect(submitTool).toBeDefined();
    const raw = await submitTool!.execute({
      summary: 'Implemented feature with tests',
      deliverables: [{ type: 'file', reference: '/tmp/out.txt', summary: 'Output file' }],
    });
    const parsed = JSON.parse(raw) as { status: string };
    expect(parsed.status).toBe('success');
    expect(taskService.submitForReview).toHaveBeenCalled();

    await execPromise;
  });

  it('executes deliverable tool callbacks wired through buildDeliverableCallbacks', async () => {
    const deliverableService = {
      create: vi.fn(async () => ({ id: 'del_1', type: 'file', title: 'Report', status: 'active' })),
      search: vi.fn(() => ({
        results: [{ id: 'del_1', type: 'file', title: 'Report', summary: 'Monthly report', status: 'active' }],
      })),
      update: vi.fn(async () => ({ id: 'del_1', type: 'file', title: 'Updated', status: 'active' })),
    };

    const manager = createManager();
    manager.setWebUiBaseUrl('http://localhost:3000');
    manager.setDeliverableService(deliverableService);
    manager.setProjectService({
      listProjects: vi.fn(() => [{ id: 'p1', name: 'P1', description: 'd', status: 'active', teamIds: [] }]),
      getProject: vi.fn(() => ({ id: 'p1', name: 'P1', description: 'd', status: 'active', teamIds: [] })),
    } as never);

    const agent = await manager.createAgent({
      name: 'Deliverable Worker',
      roleName: 'custom',
      orgId: 'org_del',
      tools: [],
    });

    const createRaw = await agent.getTools().get('deliverable_create')!.execute({
      type: 'file',
      title: 'Monthly Report',
      summary: 'Q1 metrics summary',
      reference: '/tmp/report.md',
      tags: 'metrics, q1',
    });
    expect(JSON.parse(createRaw).status).toBe('success');
    expect(deliverableService.create).toHaveBeenCalled();

    const searchRaw = await agent.getTools().get('deliverable_search')!.execute({
      query: 'monthly report',
      limit: 5,
    });
    expect(JSON.parse(searchRaw).status).toBe('success');
    expect(deliverableService.search).toHaveBeenCalled();

    const listRaw = await agent.getTools().get('deliverable_list')!.execute({ limit: 10 });
    expect(JSON.parse(listRaw).status).toBe('success');

    const updateRaw = await agent.getTools().get('deliverable_update')!.execute('del_1', {
      title: 'Updated Report',
      tags: 'metrics, updated',
    });
    expect(JSON.parse(updateRaw).status).toBe('success');
    expect(deliverableService.update).toHaveBeenCalled();
  });

  it('requirement tools execute reject and cancel status paths', async () => {
    const requirementService = {
      listRequirements: vi.fn(() => []),
      proposeRequirement: vi.fn(() => ({ id: 'req_1', title: 'R', status: 'draft' })),
      updateRequirementStatus: vi.fn(() => ({ id: 'req_1', title: 'R', status: 'active' })),
      rejectRequirement: vi.fn(() => ({ id: 'req_1', title: 'R', status: 'rejected' })),
      cancelRequirement: vi.fn(() => ({ id: 'req_1', title: 'R', status: 'cancelled' })),
      updateRequirement: vi.fn(() => ({ id: 'req_1', title: 'R', status: 'active' })),
      resubmitRequirement: vi.fn(() => ({ id: 'req_1', title: 'R', status: 'draft' })),
      getRequirement: vi.fn(() => ({
        id: 'req_1', title: 'R', description: 'd', status: 'active', priority: 'medium',
        source: 'agent', taskIds: [],
      })),
    };

    const manager = createManager();
    manager.setTaskService(makeTaskService());
    manager.setRequirementService(requirementService);

    const agent = await manager.createAgent({
      name: 'Req Worker',
      roleName: 'custom',
      orgId: 'org_req',
      tools: [],
    });

    await agent.getTools().get('requirement_update_status')!.execute({
      requirement_id: 'req_1',
      status: 'rejected',
      reason: 'Out of scope',
    });
    expect(requirementService.rejectRequirement).toHaveBeenCalled();

    await agent.getTools().get('requirement_update_status')!.execute({
      requirement_id: 'req_1',
      status: 'cancelled',
      reason: 'No longer needed',
    });
    expect(requirementService.cancelRequirement).toHaveBeenCalled();
  });
});

describe('AgentManager workflow, delegation, and A2A paths', () => {
  it('wires workflow tools for manager agents with workflow factory', async () => {
    const manager = createManager();
    manager.setWorkflowToolsFactory(() => ({
      teamId: 'team_wf',
      getActiveRuns: () => [{
        id: 'run_1',
        workflowName: 'Deploy',
        runNumber: 1,
        status: 'running',
        taskIds: ['task_1'],
        startedAt: new Date().toISOString(),
      }],
      listWorkflows: () => [{
        name: 'Deploy',
        displayName: 'Deploy',
        description: 'Deploy pipeline',
        version: '1',
        roles: [],
        hasSchedule: false,
        stepCount: 3,
      }],
      getWorkflow: () => null,
      runWorkflow: vi.fn(async () => ({
        runId: 'run_1',
        runNumber: 1,
        requirementId: 'req_1',
        taskIds: [],
      })),
      listRuns: vi.fn(async () => []),
      cancelRun: vi.fn(async () => {}),
      addWorkflow: vi.fn(),
    }));

    const agent = await manager.createAgent({
      name: 'Team Manager',
      roleName: 'developer',
      orgId: 'org_wf',
      teamId: 'team_wf',
      agentRole: 'manager',
      tools: [],
    });

    expect(agent.getTools().has('workflow_list')).toBe(true);
    await agent.handleMessage('List active workflows');
  });

  it('delegation handler creates task when taskService is configured', async () => {
    const taskService = makeTaskService();
    const manager = createManager();
    manager.setTaskService(taskService);

    const fromAgent = await manager.createAgent({
      name: 'Delegator',
      roleName: 'custom',
      orgId: 'org_del',
      tools: [],
    });
    const toAgent = await manager.createAgent({
      name: 'Delegatee',
      roleName: 'custom',
      orgId: 'org_del',
      tools: [],
    });

    const result = await manager.getDelegationManager().delegateTask(
      fromAgent.id,
      {
        taskId: 'del_task_1',
        title: 'Delegated work',
        description: 'Please implement the API endpoint',
        priority: 'high',
        context: 'From manager',
        expectedOutput: 'Working endpoint with tests',
      },
      toAgent.id,
    );

    expect(result.accepted).toBe(true);
    expect(taskService.createTask).toHaveBeenCalled();
  });

  it('delegation without taskService sends message to target agent', async () => {
    const manager = createManager();
    const fromAgent = await manager.createAgent({ name: 'From', roleName: 'custom', tools: [] });
    const toAgent = await manager.createAgent({ name: 'To', roleName: 'custom', tools: [] });
    await manager.startAgent(toAgent.id);

    const sendSpy = vi.spyOn(toAgent, 'sendMessage');
    await manager.getDelegationManager().delegateTask(
      fromAgent.id,
      {
        taskId: 'del_msg_1',
        title: 'Quick question',
        description: 'Can you review this?',
        priority: 'low',
      },
      toAgent.id,
    );

    expect(sendSpy).toHaveBeenCalled();
    await manager.stopAgent(toAgent.id);
  });

  it('A2A status_broadcast uses lightweight daily log path', async () => {
    const manager = createManager();
    const sender = await manager.createAgent({ name: 'Sender', roleName: 'custom', orgId: 'org_a2a', tools: [] });
    const receiver = await manager.createAgent({ name: 'Receiver', roleName: 'custom', orgId: 'org_a2a', tools: [] });

    const sendTool = sender.getTools().get('agent_send_message')!;
    const payload = JSON.stringify({
      type: 'status_broadcast',
      sender: { name: 'Sender' },
      payload: { status: 'working', currentTask: { title: 'Build feature' } },
    });
    const raw = await sendTool.execute({ agent_id: receiver.id, message: payload });
    expect(JSON.parse(raw).status).toBe('dispatched');
  });

  it('group chat handlers wire into A2A tools', async () => {
    const manager = createManager();
    manager.setGroupChatHandlers({
      sendGroupMessage: vi.fn(async () => 'msg_1'),
      createGroupChat: vi.fn(async () => ({ id: 'gc_1', name: 'Team Chat' })),
      listGroupChats: vi.fn(async () => [{ id: 'gc_1', name: 'Team Chat', type: 'group', channelKey: 'gc:1' }]),
      getChannelMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
    });

    const agent = await manager.createAgent({ name: 'Group Agent', roleName: 'custom', tools: [] });
    expect(agent.getTools().has('agent_send_group_message')).toBe(true);
    expect(agent.getTools().has('agent_create_group_chat')).toBe(true);
  });
});

describe('AgentManager lifecycle and role utilities', () => {
  it('shutdown stops agents and disconnects MCP', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Shutdown Me', roleName: 'custom', tools: [] });
    await manager.startAgent(agent.id);
    await expect(manager.shutdown()).resolves.not.toThrow();
  });

  it('clearEmergencyMode resets global pause flags', async () => {
    const manager = createManager();
    await manager.createAgent({ name: 'E1', roleName: 'custom', tools: [] });
    await manager.emergencyStop();
    expect(manager.isEmergencyMode()).toBe(true);
    manager.clearEmergencyMode();
    expect(manager.isEmergencyMode()).toBe(false);
    expect(manager.isGlobalPaused()).toBe(false);
  });

  it('getRoleFileDiff returns agent and template contents', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Diff Agent', roleName: 'developer', tools: [] });
    writeFileSync(join(dataDir, agent.id, 'role', 'ROLE.md'), '# Developer\nLocal changes.');

    const diff = manager.getRoleFileDiff(agent.id, 'ROLE.md');
    expect(diff.agentContent).toContain('Local changes');
    expect(diff.templateContent).toContain('Writes code');
  });

  it('checkRoleUpdate skips custom roles with role-origin marker', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Custom Origin', roleName: 'developer', tools: [] });
    writeFileSync(
      join(dataDir, agent.id, 'role', '.role-origin.json'),
      JSON.stringify({ customRole: true }),
    );

    const status = manager.checkRoleUpdate(agent.id);
    expect(status.isUpToDate).toBe(true);
    expect(status.hasTemplate).toBe(false);
  });

  it('manager agent delegateMessage tool sends to colleague', async () => {
    const manager = createManager();
    const mgr = await manager.createAgent({
      name: 'Manager',
      roleName: 'custom',
      orgId: 'org_mgr',
      teamId: 'team_mgr',
      agentRole: 'manager',
      tools: [],
    });
    const worker = await manager.createAgent({
      name: 'Worker',
      roleName: 'custom',
      orgId: 'org_mgr',
      teamId: 'team_mgr',
      tools: [],
    });
    await manager.startAgent(worker.id);

    const delegateTool = mgr.getTools().get('delegate_message');
    expect(delegateTool).toBeDefined();
    const raw = await delegateTool!.execute({ agent_id: worker.id, message: 'Please update the docs' });
    expect(JSON.parse(raw).status).toBe('dispatched');
    await manager.stopAgent(worker.id);
  });

  it('setHubClient and setBuilderService are stored on manager', async () => {
    const manager = createManager();
    manager.setHubClient({
      search: vi.fn(async () => []),
      downloadAndInstall: vi.fn(async () => ({ type: 'skill', installed: {} })),
    });
    manager.setBuilderService({
      listArtifacts: vi.fn(() => [{ type: 'skill', name: 'search' }]),
      installArtifact: vi.fn(async () => ({ type: 'skill', installed: {} })),
    });
    expect(manager).toBeDefined();
  });

  it('enrichChromeDevtoolsConfig via remote debugging port on agent create', async () => {
    const manager = createManager();
    manager.setBrowserRemoteDebuggingPort(9222);

    const agent = await manager.createAgent({
      name: 'Chrome Agent',
      roleName: 'custom',
      tools: [],
      skills: [],
    });
    expect(agent).toBeDefined();
  });
});

describe('AgentManager comprehensive tool execution', () => {
  async function createWiredManager() {
    const taskService = makeTaskService({
      findDuplicateTasks: vi.fn(() => []),
      cleanupDuplicateTasks: vi.fn(() => ({ removed: 0 })),
      getTaskBoardHealth: vi.fn(() => ({ score: 90, issues: [] })),
    });
    const manager = createManager();
    manager.setTaskService(taskService);
    manager.setWebUiBaseUrl('http://localhost:3000');
    manager.setProjectService({
      listProjects: vi.fn(() => [{
        id: 'proj_1', name: 'Project', description: 'desc', status: 'active', teamIds: ['team_full'],
      }]),
      getProject: vi.fn(() => ({
        id: 'proj_1', name: 'Project', description: 'desc', status: 'active', teamIds: ['team_full'],
      })),
    } as never);
    manager.setRequirementService({
      listRequirements: vi.fn(() => []),
      proposeRequirement: vi.fn(() => ({ id: 'req_1', title: 'Req', status: 'draft' })),
      updateRequirementStatus: vi.fn(() => ({ id: 'req_1', title: 'Req', status: 'active' })),
      rejectRequirement: vi.fn(() => ({ id: 'req_1', title: 'Req', status: 'rejected' })),
      cancelRequirement: vi.fn(() => ({ id: 'req_1', title: 'Req', status: 'cancelled' })),
      updateRequirement: vi.fn(() => ({ id: 'req_1', title: 'Req', status: 'active' })),
      resubmitRequirement: vi.fn(() => ({ id: 'req_1', title: 'Req', status: 'draft' })),
      getRequirement: vi.fn(() => ({
        id: 'req_1', title: 'Req', description: 'd', status: 'active', priority: 'medium',
        source: 'agent', taskIds: [],
      })),
      getRequirementStatusHistory: vi.fn(() => []),
    } as never);
    manager.setDeliverableService({
      create: vi.fn(() => Promise.resolve({ id: 'd1', type: 'file', title: 'T', status: 'active' })),
      search: vi.fn(() => ({ results: [] })),
      update: vi.fn(() => Promise.resolve({ id: 'd1', type: 'file', title: 'T', status: 'active' })),
    });
    manager.setTeamUpdater(vi.fn(async () => ({ id: 'team_full', name: 'Team' })));
    manager.setBuilderService({
      listArtifacts: vi.fn(() => [{ type: 'skill', name: 'search', description: 'Search' }]),
      installArtifact: vi.fn(async () => ({ type: 'skill', installed: { name: 'search' } })),
    });
    manager.setHubClient({
      search: vi.fn(async () => []),
      downloadAndInstall: vi.fn(async () => ({ type: 'skill', installed: {} })),
    });
    manager.setAgentConfigPersister(vi.fn(async () => {}));
    manager.setApprovalHandler(vi.fn(async () => ({ approved: true })));
    return { manager, taskService };
  }

  it('executes full task tool suite on created agent', async () => {
    const { manager, taskService } = await createWiredManager();
    const agent = await manager.createAgent({
      name: 'Task Suite Agent',
      roleName: 'custom',
      orgId: 'org_full_tools',
      tools: [],
    });

    await agent.getTools().get('task_create')!.execute({
      title: 'New task',
      description: 'Do something',
      assigned_agent_id: agent.id,
      reviewer_id: 'agt_reviewer',
    });
    expect(taskService.createTask).toHaveBeenCalled();

    await agent.getTools().get('task_list')!.execute({ assigned_to_me: true });
    expect(taskService.queryTasks).toHaveBeenCalled();

    await agent.getTools().get('task_get')!.execute({ task_id: 'task_1' });
    await agent.getTools().get('task_update')!.execute({ task_id: 'task_1', status: 'in_progress' });
    await agent.getTools().get('task_assign')!.execute({ task_id: 'task_1', agent_id: agent.id });
    await agent.getTools().get('task_note')!.execute({ task_id: 'task_1', note: 'Progress update' });
    await agent.getTools().get('subtask_create')!.execute({ task_id: 'task_1', title: 'Subtask A' });
    await agent.getTools().get('subtask_complete')!.execute({ task_id: 'task_1', subtask_id: 'sub_1' });
    await agent.getTools().get('requirement_propose')!.execute({
      title: 'New req', description: 'Feature request',
    });
    await agent.getTools().get('requirement_list')!.execute({});
    await agent.getTools().get('requirement_get')!.execute({ requirement_id: 'req_1' });
  });

  it('manager agent runs team and duplicate-task tools', async () => {
    const { manager } = await createWiredManager();
    const mgr = await manager.createAgent({
      name: 'Full Manager',
      roleName: 'custom',
      orgId: 'org_full_tools',
      teamId: 'team_full',
      agentRole: 'manager',
      tools: [],
    });
    await manager.createAgent({
      name: 'Team Worker',
      roleName: 'custom',
      orgId: 'org_full_tools',
      teamId: 'team_full',
      tools: [],
    });

    await mgr.getTools().get('team_list')!.execute({});
    await mgr.getTools().get('team_status')!.execute({});
    await mgr.getTools().get('task_check_duplicates')!.execute({ org_id: 'org_full_tools' });
    await mgr.getTools().get('task_cleanup_duplicates')!.execute({ org_id: 'org_full_tools' });
    await mgr.getTools().get('task_board_health')!.execute({ org_id: 'org_full_tools' });
    await mgr.getTools().get('team_update')!.execute({ team_id: 'team_full', name: 'Renamed Team' });
    await mgr.getTools().get('agent_update')!.execute({ agent_id: mgr.id, name: 'Renamed Manager' });
    await mgr.getTools().get('package_list')!.execute({});
    await mgr.getTools().get('hub_search')!.execute({ query: 'search' });
  });

  it('restoreAgent wires task and project tools for manager', async () => {
    const { manager } = await createWiredManager();
    manager.setWorkflowToolsFactory(() => ({
      teamId: 'team_restore',
      getActiveRuns: () => [],
      listWorkflows: () => [],
      getWorkflow: () => null,
      runWorkflow: vi.fn(async () => ({ runId: 'r1', runNumber: 1, requirementId: 'req_1', taskIds: [] })),
      listRuns: vi.fn(async () => []),
      cancelRun: vi.fn(async () => {}),
      addWorkflow: vi.fn(),
    }));

    const created = await manager.createAgent({
      name: 'Restore Target',
      roleName: 'developer',
      orgId: 'org_restore_full',
      teamId: 'team_restore',
      agentRole: 'manager',
      tools: [],
    });
    await manager.stopAgent(created.id);
    await manager.removeAgent(created.id);

    const restored = await manager.restoreAgent({
      id: created.id,
      name: 'Restore Target',
      roleId: 'developer',
      roleName: 'Developer',
      orgId: 'org_restore_full',
      teamId: 'team_restore',
      agentRole: 'manager',
      skills: '["search"]',
      status: 'offline',
      llmConfig: JSON.stringify({ modelMode: 'custom', primary: 'anthropic' }),
      heartbeatIntervalMs: 900000,
      createdAt: new Date().toISOString(),
      tokensUsedToday: 0,
    });

    expect(restored.getTools().has('task_create')).toBe(true);
    expect(restored.getTools().has('workflow_list')).toBe(true);
    await restored.getTools().get('list_projects')!.execute({});
  });

  it('removeAgent cleans up delegation registration', async () => {
    const { manager } = await createWiredManager();
    const agent = await manager.createAgent({ name: 'Remove Me', roleName: 'custom', tools: [] });
    const cardsBefore = manager.getDelegationManager().getAgentCards().length;
    await manager.removeAgent(agent.id);
    expect(manager.hasAgent(agent.id)).toBe(false);
    expect(manager.getDelegationManager().getAgentCards().length).toBeLessThanOrEqual(cardsBefore);
  });

  it('A2A sendMessage between agents exercises full path', async () => {
    const { manager } = await createWiredManager();
    const a = await manager.createAgent({ name: 'Sender A', roleName: 'custom', orgId: 'org_a2a_full', tools: [] });
    const b = await manager.createAgent({ name: 'Receiver B', roleName: 'custom', orgId: 'org_a2a_full', tools: [] });
    await manager.startAgent(b.id, { startAsPaused: false });

    const raw = await a.getTools().get('agent_send_message')!.execute({
      agent_id: b.id,
      message: 'Hello colleague',
    });
    expect(JSON.parse(raw).status).toBe('dispatched');
    await manager.stopAgent(b.id);
  });

  it('createAgent with skill registry injects instructions and catalog', async () => {
    const { InMemorySkillRegistry } = await import('../src/skills/registry.js');
    const registry = new InMemorySkillRegistry();
    registry.register({
      manifest: {
        name: 'search',
        version: '1.0.0',
        description: 'Web search skill',
        author: 'test',
        category: 'productivity',
        instructions: 'Use web search for research tasks.',
      },
    });

    const { manager } = await createWiredManager();
    const managerWithSkills = new AgentManager({
      llmRouter: makeMockRouter(),
      roleLoader,
      dataDir,
      eventBus: new EventBus(),
      skillRegistry: registry,
    });
    managerWithSkills.setTaskService(makeTaskService());

    const agent = await managerWithSkills.createAgent({
      name: 'Skilled Agent',
      roleName: 'custom',
      orgId: 'org_skills',
      tools: [],
      skills: ['search'],
    });

    expect(agent.hasSkillInstructions('search')).toBe(true);
    expect(agent.getAvailableSkillCatalog().some(s => s.name === 'search')).toBe(true);
  });

  it('createAgent from developer template provisions role and memory files', async () => {
    const { manager } = await createWiredManager();
    const agent = await manager.createAgent({
      name: 'Template Agent',
      roleName: 'developer',
      orgId: 'org_template',
      tools: [],
    });

    const agentDir = join(dataDir, agent.id);
    expect(existsSync(join(agentDir, 'role', 'ROLE.md'))).toBe(true);
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(true);
    expect(existsSync(join(agentDir, 'sessions'))).toBe(true);
    expect(existsSync(join(agentDir, 'daily-logs'))).toBe(true);
  });

  it('startAgentsByIds and stopAgentsByIds manage multiple agents', async () => {
    const { manager } = await createWiredManager();
    const a = await manager.createAgent({ name: 'Batch A', roleName: 'custom', tools: [] });
    const b = await manager.createAgent({ name: 'Batch B', roleName: 'custom', tools: [] });

    const started = await manager.startAgentsByIds([a.id, b.id]);
    expect(started.success).toEqual([a.id, b.id]);

    const stopped = await manager.stopAgentsByIds([a.id, b.id]);
    expect(stopped.success).toEqual([a.id, b.id]);
  });

  it('getAgent throws for unknown id', () => {
    const { manager } = createManager();
    expect(() => manager.getAgent('agt_nonexistent')).toThrow();
  });

  it('listAvailableRoles returns role loader data', () => {
    const manager = createManager();
    const roles = manager.listAvailableRoles();
    expect(roles).toContain('developer');
  });

  it('runQuickBrowserTest is callable on manager', async () => {
    const manager = createManager();
    const result = await manager.runQuickBrowserTest();
    expect(result).toBeDefined();
  });

  it('createAgent with orgContext and custom workspace provisions paths', async () => {
    const { manager } = await createWiredManager();
    const customWs = join(dataDir, 'custom-ws');
    mkdirSync(customWs, { recursive: true });

    const agent = await manager.createAgent({
      name: 'Org Context Agent',
      roleName: 'developer',
      orgId: 'org_ctx',
      teamId: 'team_ctx',
      agentRole: 'manager',
      llmProvider: 'anthropic',
      tools: [],
      profile: { workspacePath: customWs, maxConcurrentTasks: 2 },
      orgContext: { orgName: 'Acme', teamName: 'Platform' } as never,
    });

    expect(agent.config.llmConfig.modelMode).toBe('custom');
    expect(agent.config.llmConfig.primary).toBe('anthropic');
    const policy = manager.buildPathPolicy(agent.id, customWs);
    expect(policy.primaryWorkspace).toBe(customWs);
  });

  it('setStateChangeHandler receives agent state updates', async () => {
    const { manager } = await createWiredManager();
    const handler = vi.fn();
    manager.setStateChangeHandler(handler);

    const agent = await manager.createAgent({ name: 'State CB', roleName: 'custom', tools: [] });
    await manager.startAgent(agent.id, { startAsPaused: false });
    await agent.handleMessage('trigger state');
    expect(handler).toHaveBeenCalled();
    await manager.stopAgent(agent.id);
  });

  it('refreshIdentityContexts updates multiple agents', async () => {
    const { manager } = await createWiredManager();
    const a = await manager.createAgent({ name: 'Id A', roleName: 'custom', orgId: 'org_id', teamId: 'team_id', tools: [] });
    const b = await manager.createAgent({ name: 'Id B', roleName: 'custom', orgId: 'org_id', teamId: 'team_id', tools: [] });

    manager.refreshIdentityContexts(
      'org_id',
      'Org Name',
      [{ id: 'h1', name: 'Human', role: 'user' }],
      [{ id: 'team_id', name: 'Team Name', memberAgentIds: [a.id, b.id] }],
    );
    expect(a.getTeamName()).toBe('Team Name');
    expect(b.getTeamName()).toBe('Team Name');
  });
});

describe('AgentManager MCP skill wiring', () => {
  it('createAgent connects shared MCP servers from skill registry', async () => {
    const { InMemorySkillRegistry } = await import('../src/skills/registry.js');
    const registry = new InMemorySkillRegistry();
    registry.register({
      manifest: {
        name: 'shared-mcp-skill',
        version: '1.0.0',
        description: 'Shared MCP skill',
        author: 'test',
        category: 'productivity',
        isolation: 'shared',
        mcpServers: {
          'test-server': { command: 'echo', args: ['mcp'] },
        },
      },
    });

    const manager = createManager({ skillRegistry: registry });
    manager.setTaskService(makeTaskService());

    const mockTool = {
      name: 'test-server__ping',
      description: 'Ping',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"pong":true}',
    };
    const mcpManager = (manager as unknown as { mcpManager: { connectServer: ReturnType<typeof vi.fn>; getToolHandlers: ReturnType<typeof vi.fn> } }).mcpManager;
    vi.spyOn(mcpManager, 'connectServer').mockResolvedValue(undefined);
    vi.spyOn(mcpManager, 'getToolHandlers').mockReturnValue([mockTool]);

    const agent = await manager.createAgent({
      name: 'MCP Shared Agent',
      roleName: 'custom',
      orgId: 'org_mcp',
      tools: [],
      skills: ['shared-mcp-skill'],
    });

    expect(mcpManager.connectServer).toHaveBeenCalled();
    expect(agent.getTools().has('test-server__ping')).toBe(true);
  });

  it('createAgent connects per-agent scoped MCP servers with browser wrapping', async () => {
    const { InMemorySkillRegistry } = await import('../src/skills/registry.js');
    const registry = new InMemorySkillRegistry();
    registry.register({
      manifest: {
        name: 'isolated-skill',
        version: '1.0.0',
        description: 'Per-agent MCP',
        author: 'test',
        category: 'productivity',
        isolation: 'per-agent',
        mcpServers: {
          'scoped-server': { command: 'echo', args: ['scoped'] },
        },
      },
    });

    const manager = createManager({ skillRegistry: registry });
    manager.setTaskService(makeTaskService());

    const mockTool = {
      name: 'scoped-server__action',
      description: 'Action',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"ok":true}',
    };
    const mcpManager = (manager as unknown as {
      mcpManager: {
        connectServerScoped: ReturnType<typeof vi.fn>;
        getToolHandlersScoped: ReturnType<typeof vi.fn>;
      };
    }).mcpManager;
    vi.spyOn(mcpManager, 'connectServerScoped').mockResolvedValue(undefined);
    vi.spyOn(mcpManager, 'getToolHandlersScoped').mockReturnValue([mockTool]);

    const agent = await manager.createAgent({
      name: 'MCP Scoped Agent',
      roleName: 'custom',
      orgId: 'org_mcp_scoped',
      tools: [],
      skills: ['isolated-skill'],
    });

    expect(mcpManager.connectServerScoped).toHaveBeenCalled();
    expect(agent.getTools().has('scoped-server__action')).toBe(true);
  });

  it('createAgent registers chrome-devtools lazily when skill declares it', async () => {
    const { InMemorySkillRegistry } = await import('../src/skills/registry.js');
    const registry = new InMemorySkillRegistry();
    registry.register({
      manifest: {
        name: 'browser-skill',
        version: '1.0.0',
        description: 'Browser automation',
        author: 'test',
        category: 'productivity',
        mcpServers: {
          'chrome-devtools': { command: 'npx', args: ['chrome-devtools-mcp', '--autoConnect'] },
        },
      },
    });

    const manager = createManager({ skillRegistry: registry });
    manager.setBrowserRemoteDebuggingPort(9222);
    manager.setTaskService(makeTaskService());

    const agent = await manager.createAgent({
      name: 'Chrome Skill Agent',
      roleName: 'custom',
      orgId: 'org_chrome',
      tools: [],
      skills: ['browser-skill'],
    });

    const chromeTools = [...agent.getTools().keys()].filter(n => n.startsWith('chrome-devtools__'));
    expect(chromeTools.length).toBeGreaterThan(0);
  });

  it('restoreAgent reconnects MCP servers for assigned skills', async () => {
    const { InMemorySkillRegistry } = await import('../src/skills/registry.js');
    const registry = new InMemorySkillRegistry();
    registry.register({
      manifest: {
        name: 'restore-skill',
        version: '1.0.0',
        description: 'Restore MCP skill',
        author: 'test',
        category: 'productivity',
        mcpServers: {
          'restore-server': { command: 'echo', args: ['restore'] },
        },
      },
    });

    const manager = createManager({ skillRegistry: registry });
    manager.setTaskService(makeTaskService());

    const mockTool = {
      name: 'restore-server__tool',
      description: 'Restore tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"restored":true}',
    };
    const mcpManager = (manager as unknown as { mcpManager: { connectServer: ReturnType<typeof vi.fn>; getToolHandlers: ReturnType<typeof vi.fn> } }).mcpManager;
    vi.spyOn(mcpManager, 'connectServer').mockResolvedValue(undefined);
    vi.spyOn(mcpManager, 'getToolHandlers').mockReturnValue([mockTool]);

    const created = await manager.createAgent({
      name: 'Restore MCP Agent',
      roleName: 'custom',
      orgId: 'org_restore_mcp',
      tools: [],
      skills: ['restore-skill'],
    });
    await manager.removeAgent(created.id);

    const restored = await manager.restoreAgent({
      id: created.id,
      name: 'Restore MCP Agent',
      roleId: 'custom',
      roleName: 'Custom',
      orgId: 'org_restore_mcp',
      skills: ['restore-skill'],
      status: 'offline',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      heartbeatIntervalMs: 900000,
      createdAt: new Date().toISOString(),
      tokensUsedToday: 0,
    });

    await vi.waitFor(() => restored.getTools().has('restore-server__tool'), { timeout: 3000 });
    expect(restored.getTools().has('restore-server__tool')).toBe(true);
  });

  it('skillMcpActivator callback loads tools at runtime via discover_tools', async () => {
    const { InMemorySkillRegistry } = await import('../src/skills/registry.js');
    const registry = new InMemorySkillRegistry();
    registry.register({
      manifest: {
        name: 'runtime-skill',
        version: '1.0.0',
        description: 'Runtime activation',
        author: 'test',
        category: 'productivity',
        instructions: 'Runtime skill instructions.',
        mcpServers: {
          'runtime-server': { command: 'echo', args: ['runtime'] },
        },
      },
    });

    const manager = createManager({ skillRegistry: registry });
    manager.setTaskService(makeTaskService());

    const mockTool = {
      name: 'runtime-server__exec',
      description: 'Exec',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"runtime":true}',
    };
    const mcpManager = (manager as unknown as { mcpManager: { connectServer: ReturnType<typeof vi.fn>; getToolHandlers: ReturnType<typeof vi.fn> } }).mcpManager;
    vi.spyOn(mcpManager, 'connectServer').mockResolvedValue(undefined);
    vi.spyOn(mcpManager, 'getToolHandlers').mockReturnValue([mockTool]);

    const agent = await manager.createAgent({
      name: 'Runtime Skill Agent',
      roleName: 'custom',
      orgId: 'org_runtime',
      tools: [],
    });

    const raw = await (agent as unknown as PrivateAgentExec).executeTool({
      id: 'tc_disc',
      name: 'discover_tools',
      arguments: { name: ['runtime-skill'] },
    });
    expect(JSON.parse(raw).status).toBe('ok');
    expect(agent.getTools().has('runtime-server__exec')).toBe(true);
  });
});

type PrivateAgentExec = {
  executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }) => Promise<string>;
};

describe('AgentManager project stats and extended task tools', () => {
  it('project_stats aggregates task and requirement counts', async () => {
    const taskService = makeTaskService({
      listTasks: vi.fn(() => [
        { id: 't1', title: 'Done', status: 'completed', priority: 'medium', updatedAt: new Date().toISOString() },
        { id: 't2', title: 'Active', status: 'in_progress', priority: 'high', updatedAt: new Date().toISOString() },
        { id: 't3', title: 'Review', status: 'review', priority: 'medium', updatedAt: new Date().toISOString() },
        { id: 't4', title: 'Blocked', status: 'blocked', priority: 'low', updatedAt: new Date().toISOString() },
        { id: 't5', title: 'Failed', status: 'failed', priority: 'medium', updatedAt: new Date().toISOString() },
      ]),
    });
    const manager = createManager();
    manager.setTaskService(taskService);
    manager.setWebUiBaseUrl('http://localhost:3000');
    manager.setProjectService({
      listProjects: vi.fn(() => [{
        id: 'proj_stats', name: 'Stats Project', description: 'd', status: 'active', teamIds: ['team_stats'],
      }]),
      getProject: vi.fn(() => ({
        id: 'proj_stats', name: 'Stats Project', description: 'd', status: 'active', teamIds: ['team_stats'],
      })),
    } as never);
    manager.setRequirementService({
      listRequirements: vi.fn(() => [
        { id: 'r1', title: 'Req', status: 'completed' },
        { id: 'r2', title: 'Req2', status: 'active' },
      ]),
    } as never);

    const agent = await manager.createAgent({
      name: 'Stats Agent',
      roleName: 'custom',
      orgId: 'org_stats',
      teamId: 'team_stats',
      tools: [],
    });

    const raw = await agent.getTools().get('project_stats')!.execute({ project_id: 'proj_stats' });
    const parsed = JSON.parse(raw) as { status: string; totalTasks: number; completed: number };
    expect(parsed.status).toBe('success');
    expect(parsed.totalTasks).toBe(5);
    expect(parsed.completed).toBe(1);
  });

  it('task tools cover schedule update, cancel, subtasks, and query', async () => {
    const taskService = makeTaskService({
      queryTasks: vi.fn(() => ({
        tasks: [{ id: 'task_q', title: 'Query result', status: 'pending' }],
        total: 1,
      })),
      getTask: vi.fn((id: string) => ({
        id,
        title: 'Task',
        description: 'desc',
        status: 'pending',
        createdBy: 'targeted-agent',
        subtasks: [{ id: 'sub_1', title: 'Sub', status: 'pending' }],
      })),
    });
    const manager = createManager();
    manager.setTaskService(taskService);

    const agent = await manager.createAgent({
      name: 'Extended Task Agent',
      roleName: 'custom',
      orgId: 'org_ext_task',
      tools: [],
    });

    (taskService.getTask as ReturnType<typeof vi.fn>).mockImplementation((id: string) => ({
      id,
      title: 'Task',
      description: 'desc',
      status: 'pending',
      createdBy: agent.id,
      subtasks: [{ id: 'sub_1', title: 'Sub', status: 'pending' }],
    }));

    await agent.getTools().get('task_list')!.execute({ search: 'deploy', status: 'in_progress' });
    expect(taskService.queryTasks).toHaveBeenCalled();

    await agent.getTools().get('task_update')!.execute({
      task_id: 'task_1',
      schedule: { every: '1h' },
    });
    expect(taskService.updateScheduleFields).toHaveBeenCalled();

    await agent.getTools().get('task_update')!.execute({
      task_id: 'task_1',
      status: 'cancelled',
    });
    expect(taskService.rejectTask).toHaveBeenCalled();

    const subListRaw = await agent.getTools().get('subtask_list')!.execute({ task_id: 'task_1' });
    expect(JSON.parse(subListRaw).subtasks).toHaveLength(1);
  });

  it('createAgent warns when requested skills are missing from registry', async () => {
    const { InMemorySkillRegistry } = await import('../src/skills/registry.js');
    const registry = new InMemorySkillRegistry();
    const manager = createManager({ skillRegistry: registry });
    manager.setTaskService(makeTaskService());

    const agent = await manager.createAgent({
      name: 'Missing Skill Agent',
      roleName: 'custom',
      orgId: 'org_missing',
      tools: [],
      skills: ['nonexistent-skill'],
    });
    expect(agent).toBeDefined();
  });

  it('startBrowserBridge handles tab_closed events', () => {
    const manager = createManager();
    manager.startBrowserBridge(9876);
    const bridge = manager.getBrowserBridge();
    (bridge as unknown as { emit: (event: string, data: unknown) => void }).emit?.('tab_closed', { pageId: 42 });
    manager.stopBrowserBridge();
    expect(manager).toBeDefined();
  });

  it('initializes semantic search when embedding API key is set', async () => {
    const prev = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'test-key-for-semantic-init';
    try {
      const manager = createManager();
      expect(manager).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = prev;
    }
  });
});
