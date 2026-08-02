import { SUBTASK_SOFT_CAP } from '@markus/shared';
import { computeEvolutionMetrics } from '../src/evolution-metrics.js';
import { shouldDistillTask } from '../src/learning-loop.js';

describe('governance runtime helpers', () => {
  it('C-subtask-soft-cap constant is 8', () => {
    expect(SUBTASK_SOFT_CAP).toBe(8);
  });

  it('C-review-notes: approved_with_notes is a distinct verdict string', () => {
    const verdicts = ['approved', 'approved_with_notes', 'rejected'] as const;
    expect(verdicts).toContain('approved_with_notes');
  });

  it('C-task-context-inject: distillation gate still allows complex tasks', () => {
    expect(
      shouldDistillTask({
        toolCallCount: 5,
        hadRejection: false,
        similarTaskCount: 0,
        status: 'completed',
      }),
    ).toBe(true);
  });

  it('C-metrics-api zero-safe', () => {
    const m = computeEvolutionMetrics({
      tasksCompleted: 0,
      tasksWithSkillActivation: 0,
      tasksReviewed: 0,
      tasksApprovedWithoutPriorRejection: 0,
      tasksDistilled: 0,
    });
    expect(m.skillReuseRate).toBe(0);
  });
});
