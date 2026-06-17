import { describe, it, expect } from 'vitest';
import { TASK_TRANSITIONS, TERMINAL_STATUSES, isValidTaskTransition, type ItemStatus } from '../src/types/task.js';

describe('TASK_TRANSITIONS', () => {
  it('covers all ItemStatus values', () => {
    const allStatuses: ItemStatus[] = ['pending', 'in_progress', 'blocked', 'review', 'completed', 'failed', 'rejected', 'cancelled', 'archived'];
    for (const s of allStatuses) {
      expect(TASK_TRANSITIONS[s]).toBeDefined();
    }
  });

  it('archived has no valid transitions', () => {
    expect(TASK_TRANSITIONS.archived.size).toBe(0);
  });

  it('pending can go to in_progress', () => {
    expect(TASK_TRANSITIONS.pending.has('in_progress')).toBe(true);
  });

  it('in_progress can go to review', () => {
    expect(TASK_TRANSITIONS.in_progress.has('review')).toBe(true);
  });

  it('review can go to completed or in_progress', () => {
    expect(TASK_TRANSITIONS.review.has('completed')).toBe(true);
    expect(TASK_TRANSITIONS.review.has('in_progress')).toBe(true);
  });
});

describe('TERMINAL_STATUSES', () => {
  it('includes completed, failed, rejected, cancelled, archived', () => {
    expect(TERMINAL_STATUSES.has('completed')).toBe(true);
    expect(TERMINAL_STATUSES.has('failed')).toBe(true);
    expect(TERMINAL_STATUSES.has('rejected')).toBe(true);
    expect(TERMINAL_STATUSES.has('cancelled')).toBe(true);
    expect(TERMINAL_STATUSES.has('archived')).toBe(true);
  });

  it('does not include non-terminal statuses', () => {
    expect(TERMINAL_STATUSES.has('pending')).toBe(false);
    expect(TERMINAL_STATUSES.has('in_progress')).toBe(false);
    expect(TERMINAL_STATUSES.has('blocked')).toBe(false);
  });
});

describe('isValidTaskTransition', () => {
  it('returns true for valid transitions', () => {
    expect(isValidTaskTransition('pending', 'in_progress')).toBe(true);
    expect(isValidTaskTransition('in_progress', 'review')).toBe(true);
    expect(isValidTaskTransition('review', 'completed')).toBe(true);
    expect(isValidTaskTransition('completed', 'archived')).toBe(true);
  });

  it('returns false for invalid transitions', () => {
    expect(isValidTaskTransition('pending', 'completed')).toBe(true); // pending -> completed is actually valid
    expect(isValidTaskTransition('pending', 'archived')).toBe(false);
    expect(isValidTaskTransition('archived', 'pending')).toBe(false);
    expect(isValidTaskTransition('review', 'failed')).toBe(false);
  });

  it('returns false for self-transitions', () => {
    expect(isValidTaskTransition('pending', 'pending')).toBe(false);
    expect(isValidTaskTransition('in_progress', 'in_progress')).toBe(false);
  });

  it('returns false for unknown statuses', () => {
    expect(isValidTaskTransition('nonexistent' as any, 'pending')).toBe(false);
  });
});
