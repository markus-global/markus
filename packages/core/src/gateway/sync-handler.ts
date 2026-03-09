import { createLogger } from '@markus/shared';

const log = createLogger('gateway-sync');

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SyncRequest {
  status?: 'idle' | 'working' | 'error';
  currentTaskId?: string | null;
  completedTasks?: Array<{ taskId: string; result: string; artifacts?: string[] }>;
  failedTasks?: Array<{ taskId: string; error: string }>;
  progressUpdates?: Array<{ taskId: string; progress: number; note?: string }>;
  messages?: Array<{ to: string; content: string }>;
  metrics?: Record<string, unknown>;
}

export interface SyncTeamContext {
  colleagues: Array<{
    id: string;
    name: string;
    role: string;
    status: string;
  }>;
  manager?: { id: string; name: string };
}

export interface SyncProjectContext {
  id: string;
  name: string;
  currentIteration?: { id: string; name: string; status: string };
  activeRequirements: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
  }>;
}

export interface SyncResponse {
  assignedTasks: Array<{
    id: string;
    title: string;
    description: string;
    priority: string;
    status: string;
    parentTaskId?: string | null;
    requirementId?: string | null;
    projectId?: string | null;
  }>;
  inboxMessages: Array<{
    id: string;
    from: string;
    fromName: string;
    content: string;
    timestamp: string;
  }>;
  teamContext: SyncTeamContext;
  projectContext: SyncProjectContext[];
  announcements: Array<{
    type: string;
    content: string;
    timestamp: string;
  }>;
  config: {
    syncIntervalSeconds: number;
    manualVersion: string;
  };
}

// ── Service interfaces (injected by the API layer) ─────────────────────────────

export interface TaskBridge {
  getTasksByAgent(agentId: string): Array<{
    id: string;
    title: string;
    description: string;
    priority: string;
    status: string;
    parentTaskId?: string | null;
    requirementId?: string | null;
    projectId?: string | null;
  }>;
  updateTaskStatus(taskId: string, status: string, updatedBy?: string): void;
  createTask(request: {
    title: string;
    description: string;
    priority: string;
    orgId: string;
    assignedAgentId?: string;
    parentTaskId?: string;
    createdBy?: string;
  }): { id: string };
}

export interface MessageBridge {
  drainInbox(markusAgentId: string): Array<{
    id: string;
    from: string;
    fromName: string;
    content: string;
    timestamp: string;
  }>;
  deliver(fromAgentId: string, toAgentId: string, content: string): void;
}

export interface AgentStatusUpdater {
  updateStatus(agentId: string, status: 'idle' | 'working' | 'error'): void;
  updateHeartbeat(agentId: string): void;
}

export interface TeamBridge {
  getColleagues(agentId: string, orgId: string): Array<{
    id: string;
    name: string;
    role: string;
    status: string;
  }>;
  getManager(agentId: string, orgId: string): { id: string; name: string } | undefined;
}

export interface ProjectBridge {
  getProjects(orgId: string): Array<{
    id: string;
    name: string;
    currentIteration?: { id: string; name: string; status: string };
  }>;
  getActiveRequirements(orgId: string): Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    projectId?: string;
  }>;
}

// ── Handler ────────────────────────────────────────────────────────────────────

export class GatewaySyncHandler {
  private teamBridge?: TeamBridge;
  private projectBridge?: ProjectBridge;

  constructor(
    private tasks: TaskBridge,
    private messages: MessageBridge,
    private agents: AgentStatusUpdater,
    private syncIntervalSeconds = 30,
    private manualVersion = '2',
  ) {}

  setTeamBridge(bridge: TeamBridge): void { this.teamBridge = bridge; }
  setProjectBridge(bridge: ProjectBridge): void { this.projectBridge = bridge; }

  async handleSync(markusAgentId: string, orgId: string, req: SyncRequest): Promise<SyncResponse> {
    this.agents.updateHeartbeat(markusAgentId);
    if (req.status) {
      this.agents.updateStatus(markusAgentId, req.status);
    }

    if (req.completedTasks?.length) {
      for (const ct of req.completedTasks) {
        try {
          this.tasks.updateTaskStatus(ct.taskId, 'completed', `ext:${markusAgentId}`);
          log.info('External agent completed task', { markusAgentId, taskId: ct.taskId });
        } catch (e) {
          log.warn('Failed to complete task from sync', { taskId: ct.taskId, error: String(e) });
        }
      }
    }

    if (req.failedTasks?.length) {
      for (const ft of req.failedTasks) {
        try {
          this.tasks.updateTaskStatus(ft.taskId, 'failed', `ext:${markusAgentId}`);
          log.info('External agent failed task', { markusAgentId, taskId: ft.taskId, error: ft.error });
        } catch (e) {
          log.warn('Failed to update task failure from sync', { taskId: ft.taskId, error: String(e) });
        }
      }
    }

    if (req.progressUpdates?.length) {
      for (const pu of req.progressUpdates) {
        try {
          this.tasks.updateTaskStatus(pu.taskId, 'in_progress', `ext:${markusAgentId}`);
        } catch {
          // Progress update on already in_progress task is fine
        }
      }
    }

    if (req.messages?.length) {
      for (const msg of req.messages.slice(0, 100)) {
        try {
          this.messages.deliver(markusAgentId, msg.to, msg.content);
        } catch (e) {
          log.warn('Failed to deliver message from sync', { to: msg.to, error: String(e) });
        }
      }
    }

    const assignedTasks = this.tasks.getTasksByAgent(markusAgentId)
      .filter(t => t.status === 'assigned' || t.status === 'in_progress' || t.status === 'pending')
      .map(t => ({
        id: t.id,
        title: t.title,
        description: t.description,
        priority: t.priority,
        status: t.status,
        parentTaskId: t.parentTaskId ?? null,
        requirementId: t.requirementId ?? null,
        projectId: t.projectId ?? null,
      }));

    const inboxMessages = this.messages.drainInbox(markusAgentId);

    const teamContext: SyncTeamContext = {
      colleagues: this.teamBridge?.getColleagues(markusAgentId, orgId) ?? [],
      manager: this.teamBridge?.getManager(markusAgentId, orgId),
    };

    let projectContext: SyncProjectContext[] = [];
    if (this.projectBridge) {
      const projects = this.projectBridge.getProjects(orgId);
      const reqs = this.projectBridge.getActiveRequirements(orgId);
      projectContext = projects.map(p => ({
        id: p.id,
        name: p.name,
        currentIteration: p.currentIteration,
        activeRequirements: reqs
          .filter(r => r.projectId === p.id)
          .map(r => ({ id: r.id, title: r.title, status: r.status, priority: r.priority })),
      }));
    }

    return {
      assignedTasks,
      inboxMessages,
      teamContext,
      projectContext,
      announcements: [],
      config: {
        syncIntervalSeconds: this.syncIntervalSeconds,
        manualVersion: this.manualVersion,
      },
    };
  }
}
