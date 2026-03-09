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

export interface SyncResponse {
  assignedTasks: Array<{
    id: string;
    title: string;
    description: string;
    priority: string;
    status: string;
    parentTaskId?: string | null;
  }>;
  inboxMessages: Array<{
    id: string;
    from: string;
    fromName: string;
    content: string;
    timestamp: string;
  }>;
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
  /** Get pending messages for a Markus agent, returns and clears the queue */
  drainInbox(markusAgentId: string): Array<{
    id: string;
    from: string;
    fromName: string;
    content: string;
    timestamp: string;
  }>;
  /** Deliver a message from an external agent to a Markus agent */
  deliver(fromAgentId: string, toAgentId: string, content: string): void;
}

export interface AgentStatusUpdater {
  updateStatus(agentId: string, status: 'idle' | 'working' | 'error'): void;
  updateHeartbeat(agentId: string): void;
}

// ── Handler ────────────────────────────────────────────────────────────────────

export class GatewaySyncHandler {
  constructor(
    private tasks: TaskBridge,
    private messages: MessageBridge,
    private agents: AgentStatusUpdater,
    private syncIntervalSeconds = 30,
    private manualVersion = '1',
  ) {}

  async handleSync(markusAgentId: string, orgId: string, req: SyncRequest): Promise<SyncResponse> {
    // 1. Update agent heartbeat & status
    this.agents.updateHeartbeat(markusAgentId);
    if (req.status) {
      this.agents.updateStatus(markusAgentId, req.status);
    }

    // 2. Process completed tasks
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

    // 3. Process failed tasks
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

    // 4. Process progress updates
    if (req.progressUpdates?.length) {
      for (const pu of req.progressUpdates) {
        try {
          // Ensure task is in_progress
          this.tasks.updateTaskStatus(pu.taskId, 'in_progress', `ext:${markusAgentId}`);
        } catch {
          // Progress update on already in_progress task is fine
        }
      }
    }

    // 5. Deliver outbound messages
    if (req.messages?.length) {
      for (const msg of req.messages.slice(0, 100)) {
        try {
          this.messages.deliver(markusAgentId, msg.to, msg.content);
        } catch (e) {
          log.warn('Failed to deliver message from sync', { to: msg.to, error: String(e) });
        }
      }
    }

    // 6. Gather response: assigned tasks for this agent
    const assignedTasks = this.tasks.getTasksByAgent(markusAgentId)
      .filter(t => t.status === 'assigned' || t.status === 'in_progress' || t.status === 'pending')
      .map(t => ({
        id: t.id,
        title: t.title,
        description: t.description,
        priority: t.priority,
        status: t.status,
        parentTaskId: t.parentTaskId ?? null,
      }));

    // 7. Drain inbox messages
    const inboxMessages = this.messages.drainInbox(markusAgentId);

    return {
      assignedTasks,
      inboxMessages,
      announcements: [],
      config: {
        syncIntervalSeconds: this.syncIntervalSeconds,
        manualVersion: this.manualVersion,
      },
    };
  }
}
