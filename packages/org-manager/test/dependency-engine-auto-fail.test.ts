import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

const AGENT = 'agent-a';
const REVIEWER = 'reviewer-1';

interface RecordedTransition {
  entityId: string;
  fromStatus: string;
  toStatus: string;
  changedByType: string;
  reason?: string | null;
}

/**
 * Regression suite for the dependency engine's auto-fail behaviour.
 *
 * Defect (2026-09-12, task tsk_e991647e313fbe9a3b07a64f):
 *  - 06:29Z blocker tsk_e7cf0f2d entered a *transient* `failed` (provider error)
 *    → the dependent was cascade-failed 2ms later.
 *  - 07:32Z the very same blocker `completed`, but the dependent stayed `failed`
 *    — the engine never re-evaluated it. Recovery required a human (PM restart
 *    + CTO clearing `blockedBy`).
 *
 * The fix: `failed` is recoverable by default (only a blocker that stays failed
 * past the recovery window, or is `cancelled`/`archived`, makes a dependency
 * unsatisfiable); every evaluation reads the blocker's CURRENT state (no verdict
 * cache); auto-fail applies only to `blocked` dependents; auto-fails self-heal.
 */
describe('Dependency engine — auto-fail robustness & self-healing', () => {
  let ts: TaskService;
  let transitions: RecordedTransition[];

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
    transitions = [];
    ts.setStatusTransitionRepo({
      record: (data: {
        entityId: string; fromStatus: string; toStatus: string;
        changedByType: 'human' | 'agent' | 'system'; reason?: string | null;
      }) => { transitions.push({ ...data }); },
      getByEntity: (_entityType: string, entityId: string, limit = 50) =>
        transitions.filter(t => t.entityId === entityId).slice(-limit),
    });
  });

  afterEach(() => {
    ts.stopTimeoutChecker();
    vi.useRealTimers();
  });

  function blocker(overrides: Record<string, unknown> = {}) {
    const task = ts.createTask({
      orgId: 'org-1', title: 'Blocker', description: '',
      assignedAgentId: AGENT, reviewerId: REVIEWER, ...overrides,
    } as never);
    return ts.getTask(task.id)!;
  }

  /** A human-created dependent that lands in `blocked` (needs approval first). */
  function blockedDependent(blockerIds: string[]) {
    const task = ts.createTask({
      orgId: 'org-1', title: 'Dependent', description: '',
      assignedAgentId: AGENT, reviewerId: REVIEWER,
      creatorRole: 'human', blockedBy: blockerIds,
    } as never);
    return ts.approveTask(task.id, 'user-1');
  }

  const statusOf = (id: string) => ts.getTask(id)!.status;
  const reasons = (id: string) =>
    transitions.filter(t => t.entityId === id).map(t => t.reason ?? '');
  const lastReasonFor = (id: string, toStatus: string) =>
    [...transitions].reverse().find(t => t.entityId === id && t.toStatus === toStatus)?.reason ?? '';

  // ── Case 1 · transient blocker failure must NOT auto-fail the dependent ──────
  it('keeps the dependent blocked when its blocker fails transiently, then unblocks when the blocker completes', () => {
    const dep = blocker();
    const dependent = blockedDependent([dep.id]);
    expect(statusOf(dependent.id)).toBe('blocked');

    // Transient failure (provider/timeout class) — blocker is recoverable.
    ts.updateTaskStatus(dep.id, 'failed');
    expect(statusOf(dependent.id)).toBe('blocked');
    expect(ts.getTask(dependent.id)!.notes?.join(' ') ?? '').not.toContain('[dependency-auto-fail]');

    // Blocker is retried / resumed and completes — self-heal, no human action.
    ts.updateTaskStatus(dep.id, 'in_progress');
    ts.updateTaskStatus(dep.id, 'review');
    ts.updateTaskStatus(dep.id, 'completed');
    expect(statusOf(dependent.id)).toBe('in_progress');
    expect(lastReasonFor(dependent.id, 'in_progress')).toContain('Dependency satisfied');
  });

  // ── Case 2 · terminal blocker failure auto-fails with a traceable reason ─────
  it('auto-fails the dependent with a non-empty, traceable reason when the blocker is terminally failed', () => {
    ts.setDependencyFailureGraceMs(0); // any `failed` blocker is terminal
    const dep = blocker();
    const dependent = blockedDependent([dep.id]);

    ts.updateTaskStatus(dep.id, 'failed');
    expect(statusOf(dependent.id)).toBe('failed');

    const reason = lastReasonFor(dependent.id, 'failed');
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toContain(dep.id);               // trigger source
    expect(reason).toContain('recoverable=false');  // judgement basis
    expect(reason).toMatch(/Evaluated against the blocker's current state at \d{4}-\d{2}-\d{2}T/); // evaluation time
    expect(reason).toContain('Dependency auto-fail');
    expect(ts.getTask(dependent.id)!.notes?.join(' ')).toContain('[dependency-auto-fail]');
  });

  // ── Case 2b · a blocker that stays failed past the window releases dependents ─
  it('releases dependents once the blocker has stayed failed past the recovery window', () => {
    vi.useFakeTimers();
    ts.setDependencyFailureGraceMs(5 * 60_000);
    const dep = blocker();
    const dependent = blockedDependent([dep.id]);

    ts.updateTaskStatus(dep.id, 'failed');
    expect(statusOf(dependent.id)).toBe('blocked'); // still inside the window

    vi.advanceTimersByTime(6 * 60_000);
    ts.reevaluateBlockedDependents();               // periodic safety-net pass
    expect(statusOf(dependent.id)).toBe('failed');
    expect(lastReasonFor(dependent.id, 'failed')).toContain('recovery window');
  });

  // ── Case 6b · no verdict cache: evaluation always reads the CURRENT state ────
  it('never replays a stale verdict — a blocker that recovers auto-heals its auto-failed dependent', () => {
    ts.setDependencyFailureGraceMs(0);
    const dep = blocker();
    const dependent = blockedDependent([dep.id]);

    ts.updateTaskStatus(dep.id, 'failed');
    expect(statusOf(dependent.id)).toBe('failed');

    // The blocker is revived and completes. A cached "failed" verdict would keep
    // the dependent failed forever; a fresh read must restore it.
    ts.updateTaskStatus(dep.id, 'in_progress');
    ts.updateTaskStatus(dep.id, 'review');
    ts.updateTaskStatus(dep.id, 'completed');

    expect(statusOf(dependent.id)).toBe('in_progress');
    expect(lastReasonFor(dependent.id, 'in_progress')).toContain('Dependency recovered');
  });

  it('is idempotent — repeated evaluation produces no extra transition', () => {
    const dep = blocker();
    const dependent = blockedDependent([dep.id]);
    ts.updateTaskStatus(dep.id, 'failed');
    ts.updateTaskStatus(dep.id, 'in_progress');
    ts.updateTaskStatus(dep.id, 'review');
    ts.updateTaskStatus(dep.id, 'completed');

    const before = transitions.length;
    ts.reevaluateBlockedDependents();
    ts.reevaluateBlockedDependents();
    ts.updateTaskStatus(dep.id, 'archived');
    expect(transitions.length).toBe(before + 1); // only dep's own completion→archived
    expect(statusOf(dependent.id)).toBe('in_progress');
  });

  // ── Case 6 · propagation never touches a non-blocked dependent ───────────────
  it('never changes the status of an in_progress dependent when its blocker fails', () => {
    const dep = blocker();
    const dependent = blockedDependent([dep.id]);

    ts.updateTaskStatus(dep.id, 'review');
    ts.updateTaskStatus(dep.id, 'completed');
    expect(statusOf(dependent.id)).toBe('in_progress');

    // The already-running dependent keeps running even if the blocker regresses.
    ts.updateTaskStatus(dep.id, 'in_progress');
    ts.updateTaskStatus(dep.id, 'failed');
    expect(statusOf(dependent.id)).toBe('in_progress');
    expect(reasons(dependent.id).join(' ')).not.toContain('Dependency auto-fail');
  });

  it('propagates through a dependency chain without flapping', () => {
    ts.setDependencyFailureGraceMs(0);
    const dep = blocker();
    const middle = blockedDependent([dep.id]);
    const leaf = blockedDependent([middle.id]);
    expect(statusOf(leaf.id)).toBe('blocked');

    ts.updateTaskStatus(dep.id, 'failed');
    expect(statusOf(middle.id)).toBe('failed');
    expect(statusOf(leaf.id)).toBe('failed');

    // Whole chain heals when the root recovers — but only once each link
    // actually completes (a recovering middle must not unblock the leaf early).
    ts.updateTaskStatus(dep.id, 'in_progress');
    ts.updateTaskStatus(dep.id, 'review');
    ts.updateTaskStatus(dep.id, 'completed');
    expect(statusOf(middle.id)).toBe('in_progress');
    expect(statusOf(leaf.id)).toBe('failed');

    ts.updateTaskStatus(middle.id, 'review');
    ts.updateTaskStatus(middle.id, 'completed');
    expect(statusOf(leaf.id)).toBe('in_progress');
  });

  it('cancels a blocked dependent when its blocker is cancelled, with a traceable reason', () => {
    const dep = blocker();
    const dependent = blockedDependent([dep.id]);
    ts.updateTaskStatus(dep.id, 'cancelled');
    expect(statusOf(dependent.id)).toBe('cancelled');
    expect(lastReasonFor(dependent.id, 'cancelled')).toContain('Dependency cancelled');
  });

  it('does not auto-fail a dependent whose blocker is completed (no stale judgement)', () => {
    const dep = blocker();
    const dependent = blockedDependent([dep.id]);
    ts.updateTaskStatus(dep.id, 'review');
    ts.updateTaskStatus(dep.id, 'completed');

    expect(statusOf(dependent.id)).toBe('in_progress');
    expect(reasons(dependent.id).join(' ')).not.toContain('Dependency auto-fail');
    expect(ts.getDependencyFailureGraceMs()).toBeGreaterThan(0);
  });
});
