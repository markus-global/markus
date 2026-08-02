import { buildDistillationPrompt } from '../src/distillation.js';

describe('distillation prompt (LEARNING-LOOP §2)', () => {
  it('B-distill-uses-distillation-scenario: Habits encode, no JSON outcome ritual', () => {
    const prompt = buildDistillationPrompt({
      taskId: 'tsk_1',
      title: 'Ship feature',
      kind: 'success',
      executionRound: 1,
      traceSection: '- Execution rounds: 1',
    });
    expect(prompt).toMatch(/\[DISTILLATION/);
    expect(prompt).toContain('Learning Habits');
    expect(prompt).toContain('package_install');
    expect(prompt).toMatch(/request_user_input|impact/);
    expect(prompt).not.toMatch(/"outcome"|staged_skill/);
    expect(prompt).not.toContain('memory_consolidation');
    expect(prompt).not.toMatch(/Failed|failed task/i);
  });

  it('revision kind highlights feedback-driven correction', () => {
    const prompt = buildDistillationPrompt({
      taskId: 'tsk_2',
      title: 'Fix bug',
      kind: 'revision',
      executionRound: 3,
      traceSection: '- rounds: 3',
    });
    expect(prompt).toMatch(/Revision/);
    expect(prompt).toMatch(/feedback/i);
  });
});
