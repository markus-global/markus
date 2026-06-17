import { A2ABus } from '../src/bus.js';
import { CollaborationManager } from '../src/collaboration.js';
import type { A2AEnvelope, CollaborationInvite } from '../src/protocol.js';

describe('CollaborationManager', () => {
  let bus: A2ABus;
  let mgr: CollaborationManager;

  beforeEach(() => {
    bus = new A2ABus();
    mgr = new CollaborationManager(bus);
  });

  it('creates a pending session and sends invites', async () => {
    const inviteHandler = vi.fn().mockResolvedValue(undefined);
    bus.registerAgent('agent-b', inviteHandler);
    bus.registerAgent('agent-c', inviteHandler);

    const invite: CollaborationInvite = {
      sessionId: 'sess-1',
      topic: 'Design review',
      description: 'Review API design',
      participants: ['agent-a', 'agent-b', 'agent-c'],
    };

    const session = await mgr.createSession('agent-a', invite);

    expect(session.id).toBe('sess-1');
    expect(session.status).toBe('pending');
    expect(session.participants).toEqual(['agent-a']);
    expect(inviteHandler).toHaveBeenCalledTimes(2);
  });

  it('activates session when participant accepts', async () => {
    await mgr.createSession('agent-a', {
      sessionId: 'sess-1',
      topic: 'Sync',
      description: 'Weekly sync',
      participants: ['agent-a', 'agent-b'],
    });

    const acceptEnvelope: A2AEnvelope = {
      id: 'accept-1',
      type: 'collaboration_accept',
      from: 'agent-b',
      to: 'agent-a',
      timestamp: new Date().toISOString(),
      correlationId: 'sess-1',
      payload: {},
    };
    await bus.send(acceptEnvelope);

    const session = mgr.getSession('sess-1');
    expect(session?.status).toBe('active');
    expect(session?.participants).toContain('agent-b');
  });

  it('adds messages and broadcasts to participants', async () => {
    const msgHandler = vi.fn().mockResolvedValue(undefined);
    bus.registerAgent('agent-b', msgHandler);

    await mgr.createSession('agent-a', {
      sessionId: 'sess-1',
      topic: 'Chat',
      description: 'Discussion',
      participants: ['agent-a', 'agent-b'],
    });

    await bus.send({
      id: 'accept-1',
      type: 'collaboration_accept',
      from: 'agent-b',
      to: 'agent-a',
      timestamp: new Date().toISOString(),
      correlationId: 'sess-1',
      payload: {},
    });

    await mgr.addMessage('sess-1', 'agent-a', 'Hello team');

    const session = mgr.getSession('sess-1');
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].content).toBe('Hello team');
    expect(msgHandler).toHaveBeenCalled();
  });

  it('throws when adding message to unknown session', async () => {
    await expect(mgr.addMessage('missing', 'agent-a', 'hi')).rejects.toThrow(
      'Collaboration session not found: missing',
    );
  });

  it('completes a session', async () => {
    await mgr.createSession('agent-a', {
      sessionId: 'sess-1',
      topic: 'Done',
      description: 'Wrap up',
      participants: ['agent-a'],
    });
    await mgr.completeSession('sess-1');
    expect(mgr.getSession('sess-1')?.status).toBe('completed');
    expect(mgr.listActiveSessions()).toHaveLength(0);
  });

  it('does not duplicate participants on repeated accept', async () => {
    await mgr.createSession('agent-a', {
      sessionId: 'sess-1',
      topic: 'Sync',
      description: 'Weekly',
      participants: ['agent-a', 'agent-b'],
    });

    const accept: A2AEnvelope = {
      id: 'accept-1',
      type: 'collaboration_accept',
      from: 'agent-b',
      to: 'agent-a',
      timestamp: new Date().toISOString(),
      correlationId: 'sess-1',
      payload: {},
    };
    await bus.send(accept);
    await bus.send({ ...accept, id: 'accept-2' });

    expect(mgr.getSession('sess-1')?.participants.filter(p => p === 'agent-b')).toHaveLength(1);
  });
});
