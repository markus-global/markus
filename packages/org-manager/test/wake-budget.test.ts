import { describe, it, expect } from 'vitest';
import { AgentWakeBudget, DEFAULT_WAKE_BUDGET } from '../src/wake-budget.js';

describe('AgentWakeBudget', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const budget = new AgentWakeBudget({ capacity: 3, refillPerSecond: 0 });
    expect(budget.tryConsume('a').allowed).toBe(true);
    expect(budget.tryConsume('a').allowed).toBe(true);
    expect(budget.tryConsume('a').allowed).toBe(true);
    // 4th within the same instant is refused — this is the global ceiling that
    // the per-channel cooldown could not provide.
    const denied = budget.tryConsume('a');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBeLessThan(1);
  });

  it('is per-agent: one hot agent does not starve another', () => {
    const budget = new AgentWakeBudget({ capacity: 1, refillPerSecond: 0 });
    expect(budget.tryConsume('hot').allowed).toBe(true);
    expect(budget.tryConsume('hot').allowed).toBe(false);
    expect(budget.tryConsume('calm').allowed).toBe(true);
  });

  it('refills over time', () => {
    let now = 1_000_000;
    const budget = new AgentWakeBudget({ capacity: 2, refillPerSecond: 1 }, () => now);
    budget.tryConsume('a');
    budget.tryConsume('a');
    expect(budget.tryConsume('a').allowed).toBe(false);

    now += 1_000; // +1 token
    expect(budget.tryConsume('a').allowed).toBe(true);
    expect(budget.tryConsume('a').allowed).toBe(false);
  });

  it('never exceeds capacity when idle for a long time', () => {
    let now = 0;
    const budget = new AgentWakeBudget({ capacity: 2, refillPerSecond: 10 }, () => now);
    now += 3_600_000;
    expect(budget.peek('a')).toBe(2);
    budget.tryConsume('a');
    expect(budget.peek('a')).toBe(1);
  });

  it('default budget is a bounded burst, not unlimited', () => {
    expect(DEFAULT_WAKE_BUDGET.capacity).toBeLessThanOrEqual(20);
    expect(DEFAULT_WAKE_BUDGET.refillPerSecond).toBeLessThan(1);
  });
});
