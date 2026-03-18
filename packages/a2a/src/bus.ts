import { createLogger } from '@markus/shared';
import type { A2AEnvelope, A2AMessageType } from './protocol.js';

const log = createLogger('a2a-bus');

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

export type A2AHandler = (envelope: A2AEnvelope) => Promise<void>;

/**
 * In-process message bus for agent-to-agent communication.
 * Each agent registers itself and can send/receive typed messages.
 * In production this could be backed by Redis pub/sub or a proper MQ.
 */
export class A2ABus {
  private handlers = new Map<string, A2AHandler[]>();
  private agentEndpoints = new Map<string, A2AHandler>();

  registerAgent(agentId: string, handler: A2AHandler): void {
    this.agentEndpoints.set(agentId, handler);
    log.info(`Agent registered on A2A bus: ${agentId}`);
  }

  unregisterAgent(agentId: string): void {
    this.agentEndpoints.delete(agentId);
    log.info(`Agent unregistered from A2A bus: ${agentId}`);
  }

  on(type: A2AMessageType, handler: A2AHandler): void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler);
    this.handlers.set(type, existing);
  }

  private async deliverWithRetry(handler: A2AHandler, envelope: A2AEnvelope, label: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await handler(envelope);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES - 1) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt);
          log.warn(`${label} failed, retrying (${attempt + 1}/${MAX_RETRIES})`, {
            error: String(error).slice(0, 200),
            delay,
          });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    log.error(`${label} failed after ${MAX_RETRIES} retries`, { error: String(lastError) });
  }

  async send(envelope: A2AEnvelope): Promise<void> {
    log.debug(`A2A message: ${envelope.type} from=${envelope.from} to=${envelope.to}`, {
      id: envelope.id,
      correlationId: envelope.correlationId,
    });

    // Deliver to specific agent with retry
    const agentHandler = this.agentEndpoints.get(envelope.to);
    if (agentHandler) {
      await this.deliverWithRetry(agentHandler, envelope, `A2A delivery to ${envelope.to}`);
    } else {
      log.warn(`A2A target agent not found: ${envelope.to}`);
    }

    // Notify type subscribers with retry
    const typeHandlers = this.handlers.get(envelope.type) ?? [];
    for (const handler of typeHandlers) {
      await this.deliverWithRetry(handler, envelope, `A2A type handler (${envelope.type})`);
    }
  }

  async broadcast(fromId: string, type: A2AMessageType, payload: unknown): Promise<void> {
    for (const [agentId] of this.agentEndpoints) {
      if (agentId === fromId) continue;
      await this.send({
        id: `a2a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type,
        from: fromId,
        to: agentId,
        timestamp: new Date().toISOString(),
        payload,
      });
    }
  }

  listRegisteredAgents(): string[] {
    return [...this.agentEndpoints.keys()];
  }
}
