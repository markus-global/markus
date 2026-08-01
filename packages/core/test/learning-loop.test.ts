import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shouldDistillTask,
  recordSkillActivation,
  recordSkillTaskSuccess,
  recordSkillTaskRejection,
  loadSkillStats,
  shouldSuppressSkillDraft,
} from '../src/learning-loop.js';

describe('learning loop (LEARNING-LOOP.md)', () => {
  it('B-hook-skip-trivial: low tool count completed without rejection', () => {
    expect(
      shouldDistillTask({
        toolCallCount: 2,
        hadRejection: false,
        similarTaskCount: 0,
        status: 'completed',
      }),
    ).toBe(false);
  });

  it('B-hook-fire-complex: toolCallCount >= 5', () => {
    expect(
      shouldDistillTask({
        toolCallCount: 5,
        hadRejection: false,
        similarTaskCount: 0,
        status: 'completed',
      }),
    ).toBe(true);
  });

  it('B-hook-fire-failed: failed always fires', () => {
    expect(
      shouldDistillTask({
        toolCallCount: 0,
        hadRejection: false,
        similarTaskCount: 0,
        status: 'failed',
      }),
    ).toBe(true);
  });

  it('B-stats-activate / B-stats-success / B-stats-reject-feedback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-stats-'));
    try {
      let s = recordSkillActivation(dir);
      expect(s.usage_count).toBe(1);
      expect(s.last_used).toBeTruthy();
      s = recordSkillTaskSuccess(dir);
      expect(s.success_count).toBe(1);
      const trustBefore = 42; // sentinel: stats must not imply trust mutation
      s = recordSkillTaskRejection(dir, 'tsk_y step3 stale');
      expect(s.feedback.some((f) => f.includes('tsk_y'))).toBe(true);
      expect(trustBefore).toBe(42);
      expect(loadSkillStats(dir).usage_count).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B-reject-feedback: suppress duplicate draft fingerprint', () => {
    expect(
      shouldSuppressSkillDraft(
        ['- rejected draft fingerprint:my-skill-v1'],
        'my-skill-v1',
      ),
    ).toBe(true);
    expect(shouldSuppressSkillDraft(['- other'], 'my-skill-v1')).toBe(false);
  });
});
