import { computeEvolutionMetrics } from '../src/evolution-metrics.js';

describe('evolution metrics (LEARNING-LOOP §6)', () => {
  it('C-metrics-api: computes reuse / first-pass / distill rates', () => {
    const m = computeEvolutionMetrics({
      tasksCompleted: 10,
      tasksWithSkillActivation: 4,
      tasksReviewed: 8,
      tasksApprovedWithoutPriorRejection: 6,
      tasksDistilled: 2,
    });
    expect(m.skillReuseRate).toBeCloseTo(0.4);
    expect(m.firstPassRate).toBeCloseTo(0.75);
    expect(m.distillRate).toBeCloseTo(0.2);
  });
});
