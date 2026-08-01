/**
 * Evolution metrics — LEARNING-LOOP §6
 */

export interface EvolutionMetrics {
  skillReuseRate: number;
  firstPassRate: number;
  distillRate: number;
  tasksCompleted: number;
  tasksWithSkill: number;
  tasksReviewed: number;
  tasksFirstPass: number;
  tasksDistilled: number;
}

export function computeEvolutionMetrics(opts: {
  tasksCompleted: number;
  tasksWithSkillActivation: number;
  tasksReviewed: number;
  tasksApprovedWithoutPriorRejection: number;
  tasksWithDistillOutcome: number;
}): EvolutionMetrics {
  const {
    tasksCompleted: completed,
    tasksWithSkillActivation: withSkill,
    tasksReviewed: reviewed,
    tasksApprovedWithoutPriorRejection: firstPass,
    tasksWithDistillOutcome: distilled,
  } = opts;
  return {
    skillReuseRate: completed > 0 ? withSkill / completed : 0,
    firstPassRate: reviewed > 0 ? firstPass / reviewed : 0,
    distillRate: completed > 0 ? distilled / completed : 0,
    tasksCompleted: completed,
    tasksWithSkill: withSkill,
    tasksReviewed: reviewed,
    tasksFirstPass: firstPass,
    tasksDistilled: distilled,
  };
}
