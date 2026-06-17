import { A2ABus } from '../src/bus.js';
import type { A2AEnvelope } from '../src/protocol.js';

function makeEnvelope(overrides: Partial<A2AEnvelope> = {}): A2AEnvelope {
  return {
    id: 'env-1',
    type: 'task_update',
    from: 'agent-a',
    to: 'agent-b',
    timestamp: new Date().toISOString(),
    payload: { taskId: 't1' },
    ...overrides,
  };
}

describe('A2ABus', () => {
  it('registers and lists agents', () => {
    const bus = new A2ABus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.registerAgent('agent-1', handler);
    expect(bus.listRegisteredAgents()).toEqual(['agent-1']);
    bus.unregisterAgent('agent-1');
    expect(bus.listRegisteredAgents()).toEqual([]);
  });

  it('delivers messages to registered agent', async () => {
    const bus = new A2ABus();
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.registerAgent('agent-b', handler);

    await bus.send(makeEnvelope());

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].type).toBe('task_update');
  });

  it('notifies type subscribers', async () => {
    const bus = new A2ABus();
    const typeHandler = vi.fn().mockResolvedValue(undefined);
    bus.on('task_update', typeHandler);

    await bus.send(makeEnvelope());

    expect(typeHandler).toHaveBeenCalledOnce();
  });

  it('broadcasts to all agents except sender', async () => {
    const bus = new A2ABus();
    const bHandler = vi.fn().mockResolvedValue(undefined);
    const cHandler = vi.fn().mockResolvedValue(undefined);
    bus.registerAgent('agent-a', vi.fn().mockResolvedValue(undefined));
    bus.registerAgent('agent-b', bHandler);
    bus.registerAgent('agent-c', cHandler);

    await bus.broadcast('agent-a', 'heartbeat_ping', { ts: 1 });

    expect(bHandler).toHaveBeenCalledOnce();
    expect(cHandler).toHaveBeenCalledOnce();
    expect(bHandler.mock.calls[0][0].from).toBe('agent-a');
  });

  it('retries failed delivery up to MAX_RETRIES', async () => {
    vi.useFakeTimers();
    const bus = new A2ABus();
    let attempts = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
    });
    bus.registerAgent('agent-b', handler);

    const sendPromise = bus.send(makeEnvelope());
    await vi.runAllTimersAsync();
    await sendPromise;

    expect(handler).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('continues when target agent is not found', async () => {
    const bus = new A2ABus();
    const typeHandler = vi.fn().mockResolvedValue(undefined);
    bus.on('task_update', typeHandler);

    await bus.send(makeEnvelope({ to: 'missing-agent' }));

    expect(typeHandler).toHaveBeenCalledOnce();
  });
});
