import { describe, it, expect } from 'vitest';
import { REQ_TRANSITIONS, isValidRequirementTransition } from '../src/types/requirement.js';
import { TASK_TRANSITIONS, isValidTaskTransition } from '../src/types/task.js';
import type { RequirementStatus } from '../src/types/requirement.js';
import type { ItemStatus } from '../src/types/task.js';

describe('requirement FSM matrix', () => {
  it('allows blocked from pending and in_progress (the newly-added transition)', () => {
    expect(isValidRequirementTransition('pending', 'blocked')).toBe(true);
    expect(isValidRequirementTransition('in_progress', 'blocked')).toBe(true);
  });

  it('archived is a dead end — nothing may leave it', () => {
    for (const to of Object.keys(REQ_TRANSITIONS) as RequirementStatus[]) {
      expect(isValidRequirementTransition('archived', to), `archived -> ${to}`).toBe(false);
    }
  });

  it('rejects junk transitions that the old enum-only check let through', () => {
    expect(isValidRequirementTransition('completed', 'pending')).toBe(false);
    expect(isValidRequirementTransition('rejected', 'completed')).toBe(false);
  });

  it('keeps the legit reopen (resubmit) paths to pending', () => {
    expect(isValidRequirementTransition('rejected', 'pending')).toBe(true);
    expect(isValidRequirementTransition('cancelled', 'pending')).toBe(true);
    expect(isValidRequirementTransition('failed', 'pending')).toBe(true);
  });
});

describe('task FSM — the workflow retry contract', () => {
  it('in_progress is a legal re-entry; pending is NOT (the old retry target)', () => {
    // attemptStepRetry used to write 'pending' — not a target of any transition,
    // so it threw and was swallowed. This pins why the retry must go to in_progress.
    expect(isValidTaskTransition('failed', 'in_progress')).toBe(true);
    expect(isValidTaskTransition('blocked', 'in_progress')).toBe(true);
    for (const from of Object.keys(TASK_TRANSITIONS) as ItemStatus[]) {
      expect(isValidTaskTransition(from, 'pending'), `${from} -> pending`).toBe(false);
    }
  });
});
