/**
 * Ack normalisation — slice G7 (design §6.3).
 *
 * Platforms demand an ACK inside a hard window (Slack Socket Mode 3 s, Discord
 * interactions 3 s). The gateway mints one handle per inbound event; the handle
 * is **idempotent** (a transport that acks on receipt *and* arms a deadline must
 * not send two ACKs — several platforms treat the second as a protocol error)
 * and can carry a **deadline**, so "nobody acked in time" still acks instead of
 * dropping the event.
 *
 * These are the invariants the Socket Mode transport relies on, pinned in
 * isolation so a regression here is not diagnosed through six layers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAck, createDeadlineAck } from '../src/gateway/ack.js';

describe('createAck', () => {
  it('sends exactly once and reports acked, however many times it is called', () => {
    const send = vi.fn();
    const ack = createAck(send);
    expect(ack.acked).toBe(false);

    ack.ack();
    ack.ack();
    ack.ack();

    expect(send).toHaveBeenCalledTimes(1);
    expect(ack.acked).toBe(true);
  });
});

describe('createDeadlineAck', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-acks once when the deadline elapses without a manual ack', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    createDeadlineAck(3000, send);

    vi.advanceTimersByTime(2999);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);

    // Still exactly once — the timer must not re-fire.
    vi.advanceTimersByTime(10000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never double-sends when the caller acks before the deadline (timer disarmed)', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const ack = createDeadlineAck(3000, send);

    ack.ack();
    expect(send).toHaveBeenCalledTimes(1);
    expect(ack.acked).toBe(true);

    vi.advanceTimersByTime(60000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
