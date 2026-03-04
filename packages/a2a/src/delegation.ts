import { createLogger } from '@markus/shared';
import type { A2ABus } from './bus.js';
import type { A2AEnvelope, TaskDelegation, TaskUpdate, AgentCard } from './protocol.js';

const log = createLogger('a2a-delegation');

export interface DelegationResult {
  accepted: boolean;
  delegatedTo?: string;
  reason?: string;
}

/**
 * Manages task delegation between agents.
 * Handles routing tasks to the most suitable agent based on skills/availability.
 */
export class DelegationManager {
  private agentCards = new Map<string, AgentCard>();
  private pendingDelegations = new Map<string, { delegation: TaskDelegation; from: string; resolvers: { resolve: (r: DelegationResult) => void; reject: (e: Error) => void } }>();
  private delegationHandler?: (envelope: A2AEnvelope, delegation: TaskDelegation) => Promise<void>;

  constructor(private bus: A2ABus) {
    bus.on('task_delegate', (env) => this.handleDelegation(env));
    bus.on('task_update', (env) => this.handleUpdate(env));
    bus.on('task_complete', (env) => this.handleComplete(env));
  }

  /** Set a handler that will be called when a task_delegate message arrives */
  onDelegationReceived(handler: (envelope: A2AEnvelope, delegation: TaskDelegation) => Promise<void>): void {
    this.delegationHandler = handler;
  }

  registerAgentCard(card: AgentCard): void {
    this.agentCards.set(card.agentId, card);
  }

  unregisterAgentCard(agentId: string): void {
    this.agentCards.delete(agentId);
  }

  /**
   * Find the best agent for a task based on required skills.
   */
  findBestAgent(requiredSkills: string[], excludeAgentId?: string): AgentCard | undefined {
    let bestAgent: AgentCard | undefined;
    let bestScore = 0;

    for (const [id, card] of this.agentCards) {
      if (id === excludeAgentId) continue;
      if (card.status !== 'idle' && card.status !== 'working') continue;

      const score = requiredSkills.reduce((acc, skill) => {
        return acc + (card.skills.includes(skill) || card.capabilities.includes(skill) ? 1 : 0);
      }, 0);

      if (score > bestScore) {
        bestScore = score;
        bestAgent = card;
      }
    }

    return bestAgent;
  }

  /**
   * Delegate a task to another agent.
   */
  async delegateTask(fromAgentId: string, delegation: TaskDelegation, toAgentId?: string): Promise<DelegationResult> {
    const targetId = toAgentId ?? this.findBestAgent([], fromAgentId)?.agentId;
    if (!targetId) {
      return { accepted: false, reason: 'No suitable agent found' };
    }

    const envelope: A2AEnvelope = {
      id: `a2a_del_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'task_delegate',
      from: fromAgentId,
      to: targetId,
      timestamp: new Date().toISOString(),
      payload: delegation,
    };

    await this.bus.send(envelope);

    log.info(`Task delegated from ${fromAgentId} to ${targetId}`, {
      taskId: delegation.taskId,
      title: delegation.title,
    });

    return { accepted: true, delegatedTo: targetId };
  }

  /**
   * Send a task status update back to the delegating agent.
   */
  async sendUpdate(fromAgentId: string, toAgentId: string, update: TaskUpdate): Promise<void> {
    await this.bus.send({
      id: `a2a_upd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'task_update',
      from: fromAgentId,
      to: toAgentId,
      timestamp: new Date().toISOString(),
      correlationId: update.taskId,
      payload: update,
    });
  }

  /**
   * Mark a delegated task as complete.
   */
  async completeTask(fromAgentId: string, toAgentId: string, update: TaskUpdate): Promise<void> {
    await this.bus.send({
      id: `a2a_cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'task_complete',
      from: fromAgentId,
      to: toAgentId,
      timestamp: new Date().toISOString(),
      correlationId: update.taskId,
      payload: update,
    });
  }

  getAgentCards(): AgentCard[] {
    return [...this.agentCards.values()];
  }

  private async handleDelegation(envelope: A2AEnvelope): Promise<void> {
    const delegation = envelope.payload as TaskDelegation;
    log.info(`Received task delegation: ${delegation.title}`, {
      from: envelope.from,
      to: envelope.to,
      taskId: delegation.taskId,
    });
    if (this.delegationHandler) {
      await this.delegationHandler(envelope, delegation);
    }
  }

  private async handleUpdate(envelope: A2AEnvelope): Promise<void> {
    const update = envelope.payload as TaskUpdate;
    log.info(`Task update: ${update.taskId} -> ${update.status}`, {
      from: envelope.from,
      progress: update.progress,
    });
  }

  private async handleComplete(envelope: A2AEnvelope): Promise<void> {
    const update = envelope.payload as TaskUpdate;
    log.info(`Task completed: ${update.taskId}`, {
      from: envelope.from,
      to: envelope.to,
    });
  }
}
