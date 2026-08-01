import { applyFanoutDailyCap, matchAgentsForSkillFanout } from '../src/skill-fanout.js';
import { formatTaskContextForPrompt, buildTaskContextPackage } from '../src/task-context.js';

describe('skill fanout (LEARNING-LOOP §6)', () => {
  it('C-fanout-tag-match', () => {
    const ids = matchAgentsForSkillFanout(['xhs'], [
      { agentId: 'a1', roleSkills: ['xhs-posting'], roleTags: [] },
      { agentId: 'a2', roleSkills: ['coding'], roleTags: [] },
    ]);
    expect(ids).toEqual(['a1']);
  });

  it('C-fanout-cap', () => {
    const capped = applyFanoutDailyCap(['a1', 'a2', 'a3'], new Set(['a1', 'a2']));
    expect(capped).toEqual(['a3']);
  });
});

describe('task_context (STATE-MACHINES)', () => {
  it('C-task-context-inject: formats capped package', () => {
    const pkg = buildTaskContextPackage({
      requirement: { title: 'R', description: 'Do the thing' },
      deliverables: [{ id: 'dlv_1', title: 'Doc', version: 2 }],
      predecessors: [{ title: 'Prev', resultSummary: 'done' }],
      projectId: 'proj_1',
    });
    const text = formatTaskContextForPrompt(pkg);
    expect(text).toContain('Task Context');
    expect(text).toContain('dlv_1');
    expect(text).toContain('v2');
    expect(text.length).toBeLessThanOrEqual(2_600);
  });
});
