import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewaySyncHandler } from '../src/gateway/sync-handler.js';
import type {
  TaskBridge,
  MessageBridge,
  AgentStatusUpdater,
  TeamBridge,
  ProjectBridge,
} from '../src/gateway/sync-handler.js';
import { generateHandbook } from '../src/gateway/markus-handbook.js';

function makeMocks() {
  const tasks: TaskBridge = {
    getTasksByAgent: vi.fn(() => [
      {
        id: 'task-active',
        title: 'Active task',
        description: 'Do work',
        priority: 'high',
        status: 'in_progress',
        requirementId: 'req-1',
        projectId: 'proj-1',
      },
      {
        id: 'task-done',
        title: 'Done task',
        description: 'Finished',
        priority: 'medium',
        status: 'completed',
      },
      {
        id: 'task-blocked',
        title: 'Blocked',
        description: 'Waiting',
        priority: 'low',
        status: 'blocked',
      },
    ]),
    updateTaskStatus: vi.fn(),
    createTask: vi.fn(() => ({ id: 'new-task' })),
  };

  const messages: MessageBridge = {
    drainInbox: vi.fn(() => [
      {
        id: 'inbox-1',
        from: 'agent-2',
        fromName: 'Colleague',
        content: 'Need help',
        timestamp: '2026-01-01T00:00:00Z',
      },
    ]),
    deliver: vi.fn(),
  };

  const agents: AgentStatusUpdater = {
    updateStatus: vi.fn(),
    updateHeartbeat: vi.fn(),
  };

  const team: TeamBridge = {
    getColleagues: vi.fn(() => [
      { id: 'agent-2', name: 'Colleague', role: 'Developer', status: 'idle' },
    ]),
    getManager: vi.fn(() => ({ id: 'mgr-1', name: 'Manager' })),
  };

  const projects: ProjectBridge = {
    getProjects: vi.fn(() => [
      { id: 'proj-1', name: 'Alpha' },
      { id: 'proj-2', name: 'Beta' },
    ]),
    getActiveRequirements: vi.fn(() => [
      { id: 'req-1', title: 'Feature A', status: 'in_progress', priority: 'high', projectId: 'proj-1' },
      { id: 'req-2', title: 'Feature B', status: 'in_progress', priority: 'medium', projectId: 'proj-2' },
    ]),
  };

  return { tasks, messages, agents, team, projects };
}

describe('GatewaySyncHandler', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let handler: GatewaySyncHandler;

  beforeEach(() => {
    mocks = makeMocks();
    handler = new GatewaySyncHandler(mocks.tasks, mocks.messages, mocks.agents, 45, '3');
    handler.setTeamBridge(mocks.team);
    handler.setProjectBridge(mocks.projects);
  });

  it('updates heartbeat and status on sync', async () => {
    await handler.handleSync('agent-1', 'org-1', { status: 'working' });

    expect(mocks.agents.updateHeartbeat).toHaveBeenCalledWith('agent-1');
    expect(mocks.agents.updateStatus).toHaveBeenCalledWith('agent-1', 'working');
  });

  it('processes completed, failed, and progress task updates', async () => {
    await handler.handleSync('agent-1', 'org-1', {
      completedTasks: [{ taskId: 't1', result: 'done' }],
      failedTasks: [{ taskId: 't2', error: 'boom' }],
      progressUpdates: [{ taskId: 't3', progress: 50, note: 'halfway' }],
    });

    expect(mocks.tasks.updateTaskStatus).toHaveBeenCalledWith('t1', 'completed', 'ext:agent-1');
    expect(mocks.tasks.updateTaskStatus).toHaveBeenCalledWith('t2', 'failed', 'ext:agent-1');
    expect(mocks.tasks.updateTaskStatus).toHaveBeenCalledWith('t3', 'in_progress', 'ext:agent-1');
  });

  it('continues sync when task updates throw', async () => {
    vi.mocked(mocks.tasks.updateTaskStatus).mockImplementation((taskId) => {
      if (taskId === 'bad') throw new Error('update failed');
    });

    const response = await handler.handleSync('agent-1', 'org-1', {
      completedTasks: [{ taskId: 'bad', result: 'x' }, { taskId: 'good', result: 'y' }],
    });

    expect(mocks.tasks.updateTaskStatus).toHaveBeenCalledTimes(2);
    expect(response.assignedTasks.length).toBeGreaterThan(0);
  });

  it('delivers outbound messages (max 100) and swallows delivery errors', async () => {
    vi.mocked(mocks.messages.deliver).mockImplementation((_from, to) => {
      if (to === 'bad-agent') throw new Error('delivery failed');
    });

    const messages = Array.from({ length: 105 }, (_, i) => ({
      to: i === 0 ? 'bad-agent' : `agent-${i}`,
      content: `msg ${i}`,
    }));

    await handler.handleSync('agent-1', 'org-1', { messages });

    expect(mocks.messages.deliver).toHaveBeenCalledTimes(100);
    expect(mocks.messages.deliver).toHaveBeenCalledWith('agent-1', 'agent-1', 'msg 1');
  });

  it('returns assigned tasks filtered to active statuses', async () => {
    const response = await handler.handleSync('agent-1', 'org-1', {});

    expect(response.assignedTasks).toHaveLength(2);
    expect(response.assignedTasks.map(t => t.id).sort()).toEqual(['task-active', 'task-blocked']);
    expect(response.assignedTasks[0].requirementId).toBe('req-1');
  });

  it('returns inbox messages and config', async () => {
    const response = await handler.handleSync('agent-1', 'org-1', {});

    expect(response.inboxMessages).toHaveLength(1);
    expect(response.inboxMessages[0].content).toBe('Need help');
    expect(response.config).toEqual({ syncIntervalSeconds: 45, manualVersion: '3' });
    expect(response.announcements).toEqual([]);
  });

  it('builds team and project context when bridges are set', async () => {
    const response = await handler.handleSync('agent-1', 'org-1', {});

    expect(response.teamContext.colleagues).toHaveLength(1);
    expect(response.teamContext.manager?.name).toBe('Manager');
    expect(response.projectContext).toHaveLength(2);
    expect(response.projectContext[0].activeRequirements).toHaveLength(1);
    expect(response.projectContext[0].activeRequirements[0].id).toBe('req-1');
  });

  it('returns empty team and project context without bridges', async () => {
    const bareHandler = new GatewaySyncHandler(mocks.tasks, mocks.messages, mocks.agents);
    const response = await bareHandler.handleSync('agent-1', 'org-1', {});

    expect(response.teamContext).toEqual({ colleagues: [] });
    expect(response.projectContext).toEqual([]);
  });
});

describe('generateHandbook', () => {
  it('generates handbook with base URL and sync interval', () => {
    const md = generateHandbook({ baseUrl: 'https://markus.example.com/' });
    expect(md).toContain('# Markus Platform Integration Handbook');
    expect(md).toContain('POST https://markus.example.com/api/gateway/sync');
    expect(md).toContain('Poll for work');
    expect(md).toContain('every ~30 seconds');
  });

  it('includes org, agent, platform, and team context', () => {
    const md = generateHandbook({
      baseUrl: 'http://localhost:3000',
      orgName: 'Acme Corp',
      agentName: 'Bot-1',
      markusAgentId: 'agent-99',
      platform: 'openclaw',
      teamName: 'Platform',
      syncIntervalSeconds: 60,
    });

    expect(md).toContain('organization: Acme Corp');
    expect(md).toContain('**Bot-1**');
    expect(md).toContain('`agent-99`');
    expect(md).toContain('platform: openclaw');
    expect(md).toContain('Team: **Platform**');
    expect(md).toContain('every ~60 seconds');
  });

  it('includes colleagues and manager table when provided', () => {
    const md = generateHandbook({
      baseUrl: 'http://localhost:3000',
      colleagues: [
        { id: 'a1', name: 'Alice', role: 'Dev', status: 'idle' },
        { id: 'a2', name: 'Bob', role: 'QA', status: 'working' },
      ],
      manager: { id: 'mgr', name: 'Manager' },
    });

    expect(md).toContain('### Your Colleagues');
    expect(md).toContain('| Alice | Dev | idle | `a1` |');
    expect(md).toContain('**Your Manager**: Manager (`mgr`)');
  });

  it('includes active projects section when provided', () => {
    const md = generateHandbook({
      baseUrl: 'http://localhost:3000',
      projects: [
        { id: 'p1', name: 'Project Alpha' },
        { id: 'p2', name: 'Project Beta' },
      ],
    });

    expect(md).toContain('### Active Projects');
    expect(md).toContain('**Project Alpha** (`p1`)');
    expect(md).toContain('GET http://localhost:3000/api/gateway/projects');
  });

  it('strips trailing slashes from base URL', () => {
    const md = generateHandbook({ baseUrl: 'https://host///' });
    expect(md).toContain('POST https://host/api/gateway/sync');
    expect(md).not.toContain('https://host///');
  });
});
