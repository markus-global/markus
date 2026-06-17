import { A2ABus } from '../src/bus.js';
import { StructuredMessageManager } from '../src/structured.js';
import type { A2AEnvelope, ProgressSync, StatusBroadcast } from '../src/protocol.js';

describe('StructuredMessageManager', () => {
  let bus: A2ABus;
  let mgr: StructuredMessageManager;

  beforeEach(() => {
    bus = new A2ABus();
    mgr = new StructuredMessageManager(bus);
  });

  it('sends and tracks resource requests', async () => {
    bus.registerAgent('provider', vi.fn().mockResolvedValue(undefined));

    const response = await mgr.requestResource('requester', 'provider', {
      requestId: 'req-1',
      resourceType: 'compute',
      resourceName: 'gpu',
      description: 'Need GPU',
    });

    expect(response.requestId).toBe('req-1');
    expect(response.granted).toBe(false);
    expect(mgr.getResourceRequest('req-1')?.request.resourceName).toBe('gpu');
  });

  it('clears resource request on response', async () => {
    await mgr.requestResource('requester', 'provider', {
      requestId: 'req-2',
      resourceType: 'storage',
      resourceName: 'disk',
      description: 'Need storage',
    });

    await bus.send({
      id: 'res-1',
      type: 'resource_response',
      from: 'provider',
      to: 'requester',
      timestamp: new Date().toISOString(),
      correlationId: 'req-2',
      payload: { requestId: 'req-2', granted: true },
    });

    expect(mgr.getResourceRequest('req-2')).toBeUndefined();
  });

  it('syncs and stores progress', async () => {
    bus.registerAgent('peer', vi.fn().mockResolvedValue(undefined));

    const sync: ProgressSync = {
      taskId: 'task-1',
      phase: 'build',
      progress: 50,
      status: 'in_progress',
    };
    await mgr.syncProgress('agent-a', 'peer', sync);

    expect(mgr.getTaskProgress('task-1')?.progress).toBe(50);
  });

  it('receives progress sync from bus', async () => {
    await bus.send({
      id: 'prog-1',
      type: 'progress_sync',
      from: 'agent-b',
      to: 'agent-a',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-2',
        phase: 'test',
        progress: 80,
        status: 'in_progress',
      },
    });

    expect(mgr.getTaskProgress('task-2')?.progress).toBe(80);
  });

  it('registers capabilities and broadcasts status', async () => {
    bus.registerAgent('agent-b', vi.fn().mockResolvedValue(undefined));

    await mgr.registerCapabilities('agent-a', {
      agentId: 'agent-a',
      name: 'Dev',
      role: 'developer',
      skills: ['typescript'],
      capabilities: ['coding'],
      currentLoad: 10,
      availability: 'idle',
    });

    expect(mgr.getAgentCapabilities('agent-a')?.skills).toContain('typescript');
  });

  it('discovers capabilities via broadcast', async () => {
    await mgr.registerCapabilities('agent-a', {
      agentId: 'agent-a',
      name: 'Dev',
      role: 'developer',
      skills: ['go'],
      capabilities: ['coding'],
      currentLoad: 0,
      availability: 'idle',
    });

    const results = await mgr.discoverCapabilities('agent-b', { skills: ['go'] });
    expect(results).toHaveLength(1);
    expect(results[0].agentId).toBe('agent-a');
  });

  it('stores capability discovery responses', async () => {
    const discoveryResponse: A2AEnvelope = {
      id: 'cap-1',
      type: 'capability_discovery',
      from: 'agent-x',
      to: 'agent-y',
      timestamp: new Date().toISOString(),
      payload: {
        discoveryId: 'disc-1',
        response: {
          agentId: 'agent-x',
          name: 'Worker',
          role: 'worker',
          skills: ['python'],
          capabilities: ['analysis'],
          currentLoad: 30,
          availability: 'working',
        },
      },
    };
    await bus.send(discoveryResponse);

    expect(mgr.getAgentCapabilities('agent-x')?.skills).toContain('python');
  });

  it('broadcasts and stores agent status', async () => {
    bus.registerAgent('agent-b', vi.fn().mockResolvedValue(undefined));

    const status: StatusBroadcast = {
      agentId: 'agent-a',
      status: 'idle',
      load: 5,
      capabilities: ['coding'],
      availableForWork: true,
    };
    await mgr.broadcastStatus(status);

    expect(mgr.getAgentStatus('agent-a')?.status).toBe('idle');
    expect(mgr.listAvailableAgents()).toHaveLength(1);
  });

  it('lists active in-progress tasks', async () => {
    await mgr.syncProgress('a', 'b', {
      taskId: 'active-1',
      phase: 'run',
      progress: 10,
      status: 'in_progress',
    });
    await mgr.syncProgress('a', 'b', {
      taskId: 'done-1',
      phase: 'done',
      progress: 100,
      status: 'completed',
    });

    const active = mgr.listActiveTasks();
    expect(active).toHaveLength(1);
    expect(active[0].taskId).toBe('active-1');
  });

  it('responds to capability discovery when query matches', async () => {
    bus.registerAgent('requester', vi.fn().mockResolvedValue(undefined));
    await mgr.registerCapabilities('responder', {
      agentId: 'responder',
      name: 'Bot',
      role: 'dev',
      skills: ['rust'],
      capabilities: ['coding'],
      currentLoad: 0,
      availability: 'idle',
    });

    const requestHandler = vi.fn().mockResolvedValue(undefined);
    bus.registerAgent('requester', requestHandler);

    await bus.send({
      id: 'disc-req',
      type: 'capability_discovery',
      from: 'requester',
      to: 'responder',
      timestamp: new Date().toISOString(),
      payload: { discoveryId: 'disc-99', query: { skills: ['rust'] } },
    });

    expect(requestHandler).toHaveBeenCalled();
  });
});
