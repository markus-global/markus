import { createLogger } from '@markus/shared';
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
 *
 * No longer depends on A2ABus — delegation calls go directly through the
 * registered handler, which typically creates a real task via TaskService.
 */
export class DelegationManager {
  private agentCards = new Map<string, AgentCard>();
  private delegationHandler?: (envelope: A2AEnvelope, delegation: TaskDelegation) => Promise<void>;

  registerAgentCard(card: AgentCard): void {
    this.agentCards.set(card.agentId, card);
  }

  unregisterAgentCard(agentId: string): void {
    this.agentCards.delete(agentId);
  }

  /** Set a handler that will be called when a task delegation arrives */
  onDelegationReceived(handler: (envelope: A2AEnvelope, delegation: TaskDelegation) => Promise<void>): void {
    this.delegationHandler = handler;
  }

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
   * Directly invokes the delegation handler instead of going through A2ABus.
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

    if (this.delegationHandler) {
      await this.delegationHandler(envelope, delegation);
    }

    log.info(`Task delegated from ${fromAgentId} to ${targetId}`, {
      taskId: delegation.taskId,
      title: delegation.title,
    });

    return { accepted: true, delegatedTo: targetId };
  }

  updateAgentStatus(agentId: string, status: string): void {
    const card = this.agentCards.get(agentId);
    if (card) {
      card.status = status as AgentCard['status'];
      log.debug('Updated agent card status', { agentId, status });
    }
  }

  getAgentCards(): AgentCard[] {
    return [...this.agentCards.values()];
  }
}
