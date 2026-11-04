import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

const AGENT = 'agent-a';
const REVIEWER = 'reviewer-1';

/**
 * Regression suite for the `blocked` discriminator (`blockedReason`).
 *
 * Defect (2026-11-03/04, task tsk_9cf4fd09e8da2bc5bd2d730e — measured from the
 * task transition audit table):
 *
 *   22:06:47  in_progress → blocked      agent
 *   22:07:11  blocked → in_progress      system  "Dependency satisfied: all blockers resolved"
 *   22:08:29  in_progress → blocked      agent
 *   22:08:41  blocked → in_progress      system  "Dependency satisfied…"
 *
 * An agent parked the task on purpose (owner needed to rebuild/restart), and the
 * dependency engine kept flipping it back because `blocked` carried two different
 * meanings with no discriminator stored. Two earlier fix attempts failed:
 *   1. only `pauseTask()` was marked  → the agent path had no marker;
 *   2. inferring from the actor type   → `approveTask` (human) also lands in
 *      `blocked` for dependency reasons, so the inference mis-fired.
 *
 * The rule now: the *reason* is part of the record, computed from data at the
 * moment of entering `blocked`, and read — never re-inferred — by everyone else.
 */

describe('blocked discriminator (blockedReason)', () => {
  let ts: TaskService;

  beforeEach(() => {
    ts = new TaskService();
    ts.setGovernancePolicy({
      enabled: false,
      defaultTier: 'auto',
      maxPendingTasksPerAgent: 100,
      maxTotalActiveTasks: 100,
      requireApprovalForPriority: [],
      requireRequirement: false,
      rules: [],
    });
  });

  afterEach(() => {
    ts.stopTimeoutChecker();
    vi.useRealTimers();
  });

  function task(overrides: Record<string, unknown> = {}) {
    const created = ts.createTask({
      orgId: 'org-1',
      title: 'Blocker',
      description: '',
      assignedAgentId: AGENT,
      reviewerId: REVIEWER,
      ...overrides,
    } as never);
    return ts.getTask(created.id)!;
  }

  /** Human-created dependent with blockers: approve → lands in `blocked`. */
  function blockedDependent(blockerIds: string[]) {
    const created = ts.createTask({
      orgId: 'org-1',
      title: 'Dependent',
      description: '',
      assignedAgentId: AGENT,
      reviewerId: REVIEWER,
      creatorRole: 'human',
      blockedBy: blockerIds,
    } as never);
    return ts.approveTask(created.id, 'user-1');
  }

  function complete(id: string) {
    ts.updateTaskStatus(id, 'in_progress');
    ts.updateTaskStatus(id, 'review');
    ts.updateTaskStatus(id, 'completed');
  }

  // ── 1 · the reason is computed from data, at the single write point ─────────
  it('entering blocked with unresolved blockers records deps; without them records hold', () => {
    const blocker = task({ title: 'Blocker pending' });
    const dependent = blockedDependent([blocker.id]);
    expect(dependent.status).toBe('blocked');
    expect(ts.getTask(dependent.id)!.blockedReason).toBe('deps');

    const plain = task({ title: 'Plain', creatorRole: 'human' });
    ts.approveTask(plain.id, 'user-1');
    const parked = ts.updateTaskStatus(plain.id, 'blocked', AGENT, false, false, 'agent');
    expect(parked.status).toBe('blocked');
    expect(ts.getTask(plain.id)!.blockedReason).toBe('hold');
  });

  // ── 2 · THE bug: an agent parking a task must survive the dependency engine ─
  it('never auto-resumes a task an agent parked on purpose (hold survives the engine sweep)', () => {
    const blocker = task({ title: 'Blocker' });
    const dependent = blockedDependent([blocker.id]);
    expect(dependent.status).toBe('blocked');

    // Satisfied dependencies normally unblock a `deps` task — that path must
    // still work, so we first let the engine do its normal job.
    complete(blocker.id);
    expect(ts.getTask(dependent.id)!.status).toBe('in_progress');

    // Now the agent parks it deliberately (this is exactly what happened in the
    // audit log: "I'm stopping, the owner will rebuild and restart").
    ts.updateTaskStatus(dependent.id, 'blocked', AGENT, false, false, 'agent');
    expect(ts.getTask(dependent.id)!.status).toBe('blocked');
    expect(ts.getTask(dependent.id)!.blockedReason).toBe('hold');

    // Every dependency-engine entry point must leave it alone now.
    ts.reevaluateBlockedDependents();
    expect(ts.getTask(dependent.id)!.status).toBe('blocked');

    // …even though its blockers are all satisfied (the old code flipped it here).
    expect(ts.getTask(dependent.id)!.blockedBy).toEqual([blocker.id]);
  });

  // ── 3 · a human pause is a hold too, and is not overridden ──────────────────
  it('keeps a human-paused task blocked across engine sweeps, and resumeTask is the only exit', () => {
    const plain = task({ title: 'Paused by human', creatorRole: 'human' });
    ts.approveTask(plain.id, 'user-1');
    expect(ts.getTask(plain.id)!.status).toBe('in_progress');

    const paused = ts.pauseTask(plain.id, 'user-1', 'human');
    expect(paused.status).toBe('blocked');
    expect(ts.getTask(plain.id)!.blockedReason).toBe('hold');
    expect(ts.getTask(plain.id)!.pausedAt).toBeTruthy();

    ts.reevaluateBlockedDependents();
    expect(ts.getTask(plain.id)!.status).toBe('blocked');

    const resumed = ts.resumeTask(plain.id, 'user-1', 'human');
    expect(resumed.status).toBe('in_progress');
    // Leaving blocked clears the discriminator, so a later block cannot inherit it.
    expect(ts.getTask(plain.id)!.blockedReason).toBeUndefined();
  });

  // ── 4 · legacy rows (column absent → NULL) keep the old behaviour ───────────
  it('treats a blocked task with no recorded reason as deps and still auto-resumes it', () => {
    const blocker = task({ title: 'Blocker' });
    const dependent = blockedDependent([blocker.id]);
    expect(ts.getTask(dependent.id)!.blockedReason).toBe('deps');

    // Simulate a row written before `blocked_reason` existed.
    const legacy = ts.getTask(dependent.id)!;
    legacy.blockedReason = undefined;

    complete(blocker.id);
    expect(ts.getTask(dependent.id)!.status).toBe('in_progress');
  });
});
