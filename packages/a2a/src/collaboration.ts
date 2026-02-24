import { createLogger } from '@markus/shared';
import type { A2ABus } from './bus.js';
import type { A2AEnvelope, CollaborationInvite } from './protocol.js';

const log = createLogger('a2a-collaboration');

export interface CollaborationSession {
  id: string;
  topic: string;
  description: string;
  participants: string[];
  messages: Array<{ from: string; content: string; timestamp: string }>;
  status: 'pending' | 'active' | 'completed';
  createdAt: string;
}

/**
 * Manages collaborative sessions where multiple agents work together
 * on a shared topic.
 */
export class CollaborationManager {
  private sessions = new Map<string, CollaborationSession>();

  constructor(private bus: A2ABus) {
    bus.on('collaboration_invite', (env) => this.handleInvite(env));
    bus.on('collaboration_accept', (env) => this.handleAccept(env));
    bus.on('info_request', (env) => this.handleInfoRequest(env));
    bus.on('info_response', (env) => this.handleInfoResponse(env));
  }

  async createSession(initiatorId: string, invite: CollaborationInvite): Promise<CollaborationSession> {
    const session: CollaborationSession = {
      id: invite.sessionId,
      topic: invite.topic,
      description: invite.description,
      participants: [initiatorId],
      messages: [],
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(session.id, session);

    // Send invites to all target participants
    for (const participantId of invite.participants) {
      if (participantId === initiatorId) continue;

      await this.bus.send({
        id: `a2a_collab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'collaboration_invite',
        from: initiatorId,
        to: participantId,
        timestamp: new Date().toISOString(),
        correlationId: session.id,
        payload: invite,
      });
    }

    log.info(`Collaboration session created: ${session.topic}`, {
      sessionId: session.id,
      participants: invite.participants,
    });

    return session;
  }

  async addMessage(sessionId: string, fromAgentId: string, content: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Collaboration session not found: ${sessionId}`);

    session.messages.push({
      from: fromAgentId,
      content,
      timestamp: new Date().toISOString(),
    });

    // Broadcast to all other participants
    for (const participantId of session.participants) {
      if (participantId === fromAgentId) continue;
      await this.bus.send({
        id: `a2a_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'info_response',
        from: fromAgentId,
        to: participantId,
        timestamp: new Date().toISOString(),
        correlationId: sessionId,
        payload: { answer: content, context: `collaboration:${sessionId}` },
      });
    }
  }

  async completeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'completed';
      log.info(`Collaboration session completed: ${session.topic}`, { sessionId });
    }
  }

  getSession(sessionId: string): CollaborationSession | undefined {
    return this.sessions.get(sessionId);
  }

  listActiveSessions(): CollaborationSession[] {
    return [...this.sessions.values()].filter((s) => s.status === 'active');
  }

  private async handleInvite(envelope: A2AEnvelope): Promise<void> {
    const invite = envelope.payload as CollaborationInvite;
    log.info(`Collaboration invite received`, {
      sessionId: invite.sessionId,
      topic: invite.topic,
      from: envelope.from,
    });
  }

  private async handleAccept(envelope: A2AEnvelope): Promise<void> {
    const sessionId = envelope.correlationId;
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);
    if (session && !session.participants.includes(envelope.from)) {
      session.participants.push(envelope.from);
      if (session.status === 'pending') session.status = 'active';
      log.info(`Agent joined collaboration: ${envelope.from}`, { sessionId });
    }
  }

  private async handleInfoRequest(envelope: A2AEnvelope): Promise<void> {
    log.debug(`Info request from ${envelope.from}`, { correlationId: envelope.correlationId });
  }

  private async handleInfoResponse(envelope: A2AEnvelope): Promise<void> {
    log.debug(`Info response from ${envelope.from}`, { correlationId: envelope.correlationId });
  }
}
