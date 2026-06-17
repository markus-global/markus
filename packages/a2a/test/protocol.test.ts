import type {
  A2AEnvelope,
  A2AMessageType,
  TaskDelegation,
  TaskUpdate,
  InfoRequest,
  InfoResponse,
  CollaborationInvite,
  AgentCard,
  ResourceRequest,
  ResourceResponse,
  ProgressSync,
  CapabilityDiscovery,
  StatusBroadcast,
} from '../src/protocol.js';

const ALL_MESSAGE_TYPES: A2AMessageType[] = [
  'task_delegate',
  'task_update',
  'task_complete',
  'task_failed',
  'info_request',
  'info_response',
  'collaboration_invite',
  'collaboration_accept',
  'collaboration_decline',
  'heartbeat_ping',
  'heartbeat_pong',
  'resource_request',
  'resource_response',
  'progress_sync',
  'capability_discovery',
  'status_broadcast',
  'announcement',
  'feedback_notification',
];

function makeEnvelope(type: A2AMessageType, payload: unknown): A2AEnvelope {
  return {
    id: `env-${type}`,
    type,
    from: 'agent-1',
    to: 'agent-2',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
    version: '1.0',
  };
}

describe('A2A Protocol types', () => {
  it('covers all message types in envelope construction', () => {
    for (const type of ALL_MESSAGE_TYPES) {
      const env = makeEnvelope(type, { kind: type });
      expect(env.type).toBe(type);
      expect(env.version).toBe('1.0');
    }
  });

  it('supports optional correlationId on envelopes', () => {
    const env = makeEnvelope('task_delegate', {});
    env.correlationId = 'corr-123';
    expect(env.correlationId).toBe('corr-123');
  });

  it('models TaskDelegation with priority levels', () => {
    const delegation: TaskDelegation = {
      taskId: 'task-1',
      title: 'Review PR',
      description: 'Review the open pull request',
      priority: 'high',
      deadline: '2026-06-01T00:00:00.000Z',
      context: 'Sprint 5',
      expectedOutput: 'Approval or feedback',
    };
    const env = makeEnvelope('task_delegate', delegation);
    expect((env.payload as TaskDelegation).priority).toBe('high');
  });

  it('models TaskUpdate with artifacts', () => {
    const update: TaskUpdate = {
      taskId: 'task-1',
      status: 'in_progress',
      progress: 50,
      message: 'Half done',
      artifacts: [{ name: 'report.md', type: 'text/markdown', content: '# Report' }],
    };
    expect(update.artifacts).toHaveLength(1);
  });

  it('models info request/response pair', () => {
    const request: InfoRequest = { question: 'What is the deadline?', urgency: 'high' };
    const response: InfoResponse = { answer: 'Friday', confidence: 0.9, sources: ['calendar'] };
    expect(makeEnvelope('info_request', request).type).toBe('info_request');
    expect((makeEnvelope('info_response', response).payload as InfoResponse).confidence).toBe(0.9);
  });

  it('models CollaborationInvite', () => {
    const invite: CollaborationInvite = {
      sessionId: 'sess-1',
      topic: 'Architecture review',
      description: 'Review the new design',
      participants: ['agent-a', 'agent-b'],
    };
    expect(invite.participants).toContain('agent-b');
  });

  it('models AgentCard', () => {
    const card: AgentCard = {
      agentId: 'agent-1',
      name: 'Dev Bot',
      role: 'developer',
      capabilities: ['coding'],
      skills: ['typescript'],
      status: 'idle',
      endpoint: 'http://localhost:8056',
    };
    expect(card.status).toBe('idle');
  });

  it('models resource request/response', () => {
    const req: ResourceRequest = {
      requestId: 'req-1',
      resourceType: 'compute',
      resourceName: 'gpu-pool',
      description: 'Need GPU for training',
      requirements: { cpu: 4, memory: 8192 },
      urgency: 'critical',
    };
    const res: ResourceResponse = {
      requestId: 'req-1',
      granted: true,
      resourceInfo: { endpoint: 'gpu://cluster-1', expiresAt: '2026-06-02T00:00:00.000Z' },
    };
    expect((makeEnvelope('resource_request', req).payload as ResourceRequest).resourceType).toBe('compute');
    expect((makeEnvelope('resource_response', res).payload as ResourceResponse).granted).toBe(true);
  });

  it('models ProgressSync with dependencies', () => {
    const sync: ProgressSync = {
      taskId: 'task-1',
      phase: 'testing',
      progress: 75,
      status: 'in_progress',
      dependencies: [{ taskId: 'task-0', status: 'completed', required: true }],
    };
    expect(sync.dependencies![0].required).toBe(true);
  });

  it('models CapabilityDiscovery query and response', () => {
    const discovery: CapabilityDiscovery = {
      discoveryId: 'disc-1',
      query: { skills: ['typescript'], minAvailability: 50 },
      response: {
        agentId: 'agent-1',
        name: 'Dev',
        role: 'developer',
        skills: ['typescript'],
        capabilities: ['coding'],
        currentLoad: 20,
        availability: 'idle',
      },
    };
    expect(discovery.response!.availability).toBe('idle');
  });

  it('models StatusBroadcast with health metrics', () => {
    const status: StatusBroadcast = {
      agentId: 'agent-1',
      status: 'working',
      load: 60,
      capabilities: ['coding'],
      availableForWork: true,
      currentTask: { taskId: 't1', title: 'Build feature', progress: 40 },
      health: { cpu: 45, memory: 70, uptime: 3600, errors: 0 },
    };
    expect((makeEnvelope('status_broadcast', status).payload as StatusBroadcast).load).toBe(60);
  });
});
