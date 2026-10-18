import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StaleDetector } from '../src/stale-detector.js';

/**
 * Regression coverage for the 2026-10-17 review stall.
 *
 * Four cards sat in `review` for ~15 hours. Both reviewers received their
 * review_request and each turn was recorded as `completed`, but the cards were
 * never touched (21s / 26s / 45s turns with no action). The only backstop was a
 * human notification 12 hours later — the reviewer was never told again, and no
 * human-visible signal existed before then.
 *
 * The detector now measures `now - task.updatedAt`, which IS the authoritative
 * "when did anyone last touch this card" fact, and escalates in two steps:
 * reviewer first (fast), human only if the card still has not moved.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function reviewTask(minutesIdle: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-review',
    title: 'T42 review',
    status: 'review',
    updatedAt: new Date(Date.now() - minutesIdle * MIN).toISOString(),
    assignedAgentId: 'agent-assignee',
    reviewerId: 'agent-reviewer',
    ...overrides,
  };
}

describe('review stall detection', () => {
  let taskService: { listTasks: ReturnType<typeof vi.fn> };
  let detector: StaleDetector;

  beforeEach(() => {
    taskService = { listTasks: vi.fn(() => []) };
    detector = new StaleDetector(taskService as never, {
      maxInProgressMs: 24 * HOUR,
      reviewReminderMs: 30 * MIN,
      maxReviewWaitMs: 4 * HOUR,
      maxAssignedUnstartedMs: 4 * HOUR,
      maxBranchDivergenceCommits: 100,
    });
  });

  it('stays quiet while a review is young', async () => {
    taskService.listTasks.mockReturnValue([reviewTask(5)]);
    expect(await detector.scan()).toHaveLength(0);
  });

  it('reminds the REVIEWER, not a human, once a review turn leaves no trace', async () => {
    taskService.listTasks.mockReturnValue([reviewTask(35)]);
    const items = await detector.scan();

    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe('review_reminder');
    // The whole point of the fix: the agent that can act is the one addressed.
    expect(items[0]?.agentId).toBe('agent-reviewer');
    expect(items[0]?.taskId).toBe('task-review');
    // Not an hours-scale wait: 35 minutes of an untouched card is already wrong.
    expect(items[0]?.ageMs).toBeGreaterThan(30 * MIN);
  });

  it('escalates to a human only after the reviewer reminder had its chance', async () => {
    taskService.listTasks.mockReturnValue([reviewTask(5 * 60)]);
    const types = (await detector.scan()).map(i => i.type);

    // Both tiers fire for a genuinely abandoned card: reminder first, escalation after.
    expect(types).toContain('review_reminder');
    expect(types).toContain('review_stale');
  });

  it('does not re-notify on every scan while the card keeps not moving', async () => {
    taskService.listTasks.mockReturnValue([reviewTask(35)]);
    expect(await detector.scan()).toHaveLength(1);
    expect(await detector.scan()).toHaveLength(0);
  });

  it('re-notifies after the card moves and gets stuck again', async () => {
    taskService.listTasks.mockReturnValue([reviewTask(35)]);
    expect(await detector.scan()).toHaveLength(1);

    // Someone acted (card touched) …
    taskService.listTasks.mockReturnValue([reviewTask(1)]);
    expect(await detector.scan()).toHaveLength(0);

    // … and it stalled again.
    taskService.listTasks.mockReturnValue([reviewTask(35)]);
    expect(await detector.scan()).toHaveLength(1);
  });

  it('falls back to the assignee when a card has no reviewer bound', async () => {
    taskService.listTasks.mockReturnValue([reviewTask(35, { reviewerId: undefined })]);
    const items = await detector.scan();
    expect(items[0]?.agentId).toBe('agent-assignee');
  });
});
