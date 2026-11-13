import { describe, expect, it, vi } from 'vitest';
import { createCursorWriter, DEFAULT_FLUSH_DELAY_MS } from './cursorWriter.ts';

/**
 * The guarantee under test: a burst of any size becomes ONE request.
 *
 * This is the third attempt at fixing the read-cursor fan-out. The first two
 * batched individual call sites and both missed others — measured on the wire,
 * opening one agent's chat still fired 495 POSTs in 435 ms (247 sessions x 2
 * effect runs). So the coalescing lives in the transport, and these tests exist
 * so a future caller that loops cannot quietly reintroduce it.
 */
describe('createCursorWriter — a burst must be one request', () => {
  function makeWriter() {
    const scheduled: Array<() => void> = [];
    const cancelled: unknown[] = [];
    const send = vi.fn();
    const writer = createCursorWriter(send, {
      delayMs: 100,
      schedule: (fn) => { scheduled.push(fn); return scheduled.length - 1; },
      cancel: (h) => { cancelled.push(h); },
    });
    const fire = () => { const fns = scheduled.splice(0); for (const fn of fns) fn(); };
    return { writer, send, fire, scheduled, cancelled };
  }

  it('247 separate queue() calls in one burst => ONE send with 247 items', () => {
    // The exact shape of the bug: markAgentNotificationsRead loops over every
    // session of an agent, calling the single-key path once per session.
    const { writer, send, fire, scheduled } = makeWriter();
    for (let i = 0; i < 247; i++) writer.queue([`session:cs_${i}`], '2026-01-01T00:00:00Z');

    expect(send).not.toHaveBeenCalled();          // nothing goes out synchronously
    expect(scheduled).toHaveLength(1);            // one timer, not 247
    fire();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toHaveLength(247);
  });

  it('one burst, then another burst => two sends (not merged forever)', () => {
    const { writer, send, fire } = makeWriter();
    writer.queue(['session:a', 'session:b'], 't1');
    fire();
    writer.queue(['session:c'], 't2');
    fire();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].map((i: { conversationKey: string }) => i.conversationKey)).toEqual(['session:a', 'session:b']);
    expect(send.mock.calls[1][0].map((i: { conversationKey: string }) => i.conversationKey)).toEqual(['session:c']);
  });

  it('repeated writes to the same conversation collapse to one item, latest timestamp wins', () => {
    const { writer, send, fire } = makeWriter();
    writer.queue(['session:x'], 'old');
    writer.queue(['session:x'], 'old2');
    writer.queue(['session:x'], 'new');
    fire();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual([{ conversationKey: 'session:x', lastReadAt: 'new' }]);
  });

  it('nothing pending => no request at all (the steady state must stay silent)', () => {
    const { writer, send, fire } = makeWriter();
    fire();
    expect(send).not.toHaveBeenCalled();
    expect(writer.pendingCount()).toBe(0);
  });

  it('empty / falsy keys are ignored and do not arm a timer', () => {
    const { writer, send, scheduled } = makeWriter();
    writer.queue([], 't');
    writer.queue([''], 't');
    expect(scheduled).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('flushNow() sends immediately and cancels the pending timer (page is going away)', () => {
    const { writer, send, cancelled } = makeWriter();
    writer.queue(['session:a'], 't');
    writer.flushNow();

    expect(send).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveLength(1);
    expect(writer.pendingCount()).toBe(0);
  });

  it('flushNow() after a flush is a harmless no-op', () => {
    const { writer, send } = makeWriter();
    writer.queue(['session:a'], 't');
    writer.flushNow();
    writer.flushNow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('default delay is short enough to be invisible to the reader', () => {
    // The badge is already cleared locally before the write, so this delay only
    // affects when the SERVER learns about it — it must not be perceptible.
    expect(DEFAULT_FLUSH_DELAY_MS).toBeLessThanOrEqual(250);
  });
});
