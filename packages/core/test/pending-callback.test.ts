import { describe, it, expect, beforeEach } from 'vitest';
import { PendingCallbackRegistry, type PersistedCallback } from '../src/pending-callback.js';

describe('PendingCallbackRegistry (generalized)', () => {
  let registry: PendingCallbackRegistry;

  beforeEach(() => {
    registry = new PendingCallbackRegistry();
  });

  it('registers and resolves callbacks of different types', () => {
    registry.register({ id: 'bg1', agentId: 'a1', originSessionId: 's1', type: 'background_exec', registeredAt: Date.now(), timeoutMs: 1000 });
    registry.register({ id: 'wk1', agentId: 'a1', originSessionId: 's1', type: 'wakeup', wakeAt: Date.now() + 5000, registeredAt: Date.now(), timeoutMs: Number.MAX_SAFE_INTEGER });
    expect(registry.getByAgentId('a1')).toHaveLength(2);
    const resolved = registry.resolve('bg1');
    expect(resolved?.type).toBe('background_exec');
    expect(registry.getByAgentId('a1')).toHaveLength(1);
  });

  it('finds a callback by correlation id (scoped to agent)', () => {
    registry.register({ id: 'a2a_a1_conv9', agentId: 'a1', originSessionId: 's1', type: 'a2a_reply', deliveryMode: 'in_session', correlationId: 'conv9', registeredAt: Date.now(), timeoutMs: 1000 });
    registry.register({ id: 'a2a_a2_conv9', agentId: 'a2', originSessionId: 's2', type: 'a2a_reply', deliveryMode: 'in_session', correlationId: 'conv9', registeredAt: Date.now(), timeoutMs: 1000 });
    const found = registry.findByCorrelation('a1', 'conv9');
    expect(found?.id).toBe('a2a_a1_conv9');
    expect(registry.findByCorrelation('a1', 'nope')).toBeUndefined();
  });

  it('returns only wakeups that are due', () => {
    const now = Date.now();
    registry.register({ id: 'due', agentId: 'a1', originSessionId: 's1', type: 'wakeup', wakeAt: now - 1000, registeredAt: now, timeoutMs: Number.MAX_SAFE_INTEGER });
    registry.register({ id: 'future', agentId: 'a1', originSessionId: 's1', type: 'wakeup', wakeAt: now + 60_000, registeredAt: now, timeoutMs: Number.MAX_SAFE_INTEGER });
    registry.register({ id: 'bg', agentId: 'a1', originSessionId: 's1', type: 'background_exec', registeredAt: now, timeoutMs: 1000 });
    const due = registry.getDueWakeups(now);
    expect(due.map(c => c.id)).toEqual(['due']);
  });

  it('surfaces timed-out callbacks and can expire them', () => {
    const now = Date.now();
    registry.register({ id: 'old', agentId: 'a1', originSessionId: 's1', type: 'background_exec', registeredAt: now - 5000, timeoutMs: 1000 });
    const timedOut = registry.getTimedOut(now);
    expect(timedOut.map(c => c.id)).toContain('old');
    registry.expireTimedOut('old');
    expect(registry.getByAgentId('a1')).toHaveLength(0);
  });

  it('persists and restores callbacks (normalizing loose types)', () => {
    const store = new Map<string, PersistedCallback>();
    const persistence = {
      save: (cb: PersistedCallback) => { store.set(cb.id, cb); },
      remove: (id: string) => { store.delete(id); },
      loadAll: () => [...store.values()],
    };
    registry.setPersistence(persistence);
    registry.register({ id: 'wk1', agentId: 'a1', originSessionId: 's1', type: 'wakeup', deliveryMode: 'mailbox', note: 'check', wakeAt: 123, recurringMs: 456, registeredAt: 1, timeoutMs: 2 });
    expect(store.has('wk1')).toBe(true);

    // Restore into a fresh registry from the same persistence store.
    const registry2 = new PendingCallbackRegistry();
    registry2.setPersistence(persistence);
    const restored = registry2.getByAgentId('a1')[0];
    expect(restored?.type).toBe('wakeup');
    expect(restored?.deliveryMode).toBe('mailbox');
    expect(restored?.wakeAt).toBe(123);
    expect(restored?.recurringMs).toBe(456);

    registry2.resolve('wk1');
    expect(store.has('wk1')).toBe(false);
  });

  it('get() peeks without removing; resolve() is the only consumer', () => {
    registry.register({ id: 'bg1', agentId: 'a1', originSessionId: 's1', type: 'background_exec', registeredAt: Date.now(), timeoutMs: 1000 });
    // The completion bus must be able to read lineage BEFORE claiming ownership.
    expect(registry.get('bg1')?.originSessionId).toBe('s1');
    expect(registry.get('bg1')).toBeDefined(); // peek did not consume
    expect(registry.get('missing')).toBeUndefined();
    registry.resolve('bg1');
    expect(registry.get('bg1')).toBeUndefined();
  });

  it('lineage (originScenario + workUnitRef) survives a persistence roundtrip', () => {
    const store = new Map<string, PersistedCallback>();
    const persistence = {
      save: (cb: PersistedCallback) => { store.set(cb.id, cb); },
      remove: (id: string) => { store.delete(id); },
      loadAll: () => [...store.values()],
    };
    registry.setPersistence(persistence);
    registry.register({
      id: 'bg_lineage', agentId: 'a1', originSessionId: 'task_t1_r1', type: 'background_exec',
      originScenario: 'task_execution', workUnitRef: 'task:tsk_1#round=2',
      registeredAt: 1, timeoutMs: 2,
    });
    // A restart loads from the SAME durable store — lineage must not live only
    // in a parallel in-memory map that dies with the process.
    const registry2 = new PendingCallbackRegistry();
    registry2.setPersistence(persistence);
    const restored = registry2.get('bg_lineage');
    expect(restored?.originScenario).toBe('task_execution');
    expect(restored?.workUnitRef).toBe('task:tsk_1#round=2');
    expect(restored?.originSessionId).toBe('task_t1_r1');
  });

  it('defaults deliveryMode to in_session on restore when missing', () => {
    const persistence = {
      save: () => {},
      remove: () => {},
      loadAll: (): PersistedCallback[] => [
        { id: 'legacy', agentId: 'a1', originSessionId: 's1', type: 'background_exec', registeredAt: 1, timeoutMs: 2 },
      ],
    };
    registry.setPersistence(persistence);
    expect(registry.getByAgentId('a1')[0]?.deliveryMode).toBe('in_session');
  });
});
