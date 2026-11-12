import { describe, it, expect } from 'vitest';
// @ts-ignore - plain ESM harness, no type declarations
import { runBenchmark } from '../../../scripts/bench-agents.mjs';
describe('bench:agents harness', () => {
  it('produces stub-mode metrics with percentiles and concurrency', async () => {
    const r = await runBenchmark({ agents: 2, steps: 2, provider: 'stub' });
    expect(r.achievedConcurrency).toBe(2);
    expect(r.latencyMs.task.count).toBe(2);
    expect(r.latencyMs.toolCall.count).toBe(4);
    expect(r.latencyMs.persistence.count).toBe(4);
  });
});
