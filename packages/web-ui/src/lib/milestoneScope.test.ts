/**
 * Milestone scope rules — behaviour tests for the ONE place that answers "is this item in the
 * active milestone?". The Work page consumes exactly these functions, so a regression here is a
 * wrong board rather than a wrong local variable.
 */
import { describe, it, expect } from 'vitest';
import { MILESTONE_ALL, MILESTONE_NONE, resolveMilestoneScope, requirementInScope, taskInScope } from './milestoneScope.ts';

const REQS = [
  { id: 'req_a1', milestoneId: 'ms_a' },
  { id: 'req_a2', milestoneId: 'ms_a' },
  { id: 'req_b1', milestoneId: 'ms_b' },
  { id: 'req_free', milestoneId: null },
  { id: 'req_undef' },
];

describe('resolveMilestoneScope', () => {
  it('returns null for the ALL filter so callers can skip filtering', () => {
    expect(resolveMilestoneScope(REQS, MILESTONE_ALL)).toBeNull();
  });

  it('collects the requirement ids of a specific milestone', () => {
    const scope = resolveMilestoneScope(REQS, 'ms_a')!;
    expect(scope.mode).toBe('one');
    expect([...scope.ids].sort()).toEqual(['req_a1', 'req_a2']);
  });

  it('collects the ids that HAVE a milestone for 未归属 (the complement is in scope)', () => {
    const scope = resolveMilestoneScope(REQS, MILESTONE_NONE)!;
    expect(scope.mode).toBe('none');
    expect([...scope.ids].sort()).toEqual(['req_a1', 'req_a2', 'req_b1']);
  });
});

describe('requirementInScope', () => {
  const one = resolveMilestoneScope(REQS, 'ms_a');
  const none = resolveMilestoneScope(REQS, MILESTONE_NONE);

  it('keeps everything when there is no filter', () => {
    expect(REQS.every(r => requirementInScope(r, null))).toBe(true);
  });

  it('keeps only the milestone members for a specific milestone', () => {
    expect(REQS.filter(r => requirementInScope(r, one)).map(r => r.id)).toEqual(['req_a1', 'req_a2']);
  });

  it('treats both `null` and a missing field as unassigned', () => {
    expect(REQS.filter(r => requirementInScope(r, none)).map(r => r.id)).toEqual(['req_free', 'req_undef']);
  });
});

describe('taskInScope — a task belongs to a milestone through its requirement', () => {
  const one = resolveMilestoneScope(REQS, 'ms_a');
  const none = resolveMilestoneScope(REQS, MILESTONE_NONE);

  it('keeps everything when there is no filter', () => {
    expect(taskInScope({ requirementId: 'req_b1' }, null)).toBe(true);
  });

  it('keeps a task only when its requirement is in the milestone', () => {
    expect(taskInScope({ requirementId: 'req_a1' }, one)).toBe(true);
    expect(taskInScope({ requirementId: 'req_b1' }, one)).toBe(false);
  });

  it('excludes requirement-less tasks from a named milestone (they belong to none)', () => {
    expect(taskInScope({}, one)).toBe(false);
    expect(taskInScope({ requirementId: null }, one)).toBe(false);
  });

  it('includes requirement-less tasks under 未归属, and excludes those whose requirement has a milestone', () => {
    expect(taskInScope({ requirementId: 'req_free' }, none)).toBe(true);
    expect(taskInScope({}, none)).toBe(true);
    expect(taskInScope({ requirementId: 'req_a1' }, none)).toBe(false);
  });
});
