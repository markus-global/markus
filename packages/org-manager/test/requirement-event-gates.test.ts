import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequirementService } from '../src/requirement-service.js';
import { TaskService } from '../src/task-service.js';
import { mailboxDedupKey, assertWakeupDedupable } from '@markus/core';
import { WAKEUP_EVENTS, wakeupDedupKey } from '@markus/shared';

/**
 * Regression suite for the requirement-event amplification family.
 *
 * Incident (2026-11-04, req_319b0b66c5f99964e3ff65e8 — measured from the DB):
 *   - 257 comments on one requirement, **all** authored by the same agent
 *     (the requirement's own creator), written across 3 hours;
 *   - 239 of 249 adjacent gaps were between 2s and 1m → the agent wrote a dozen
 *     comments per wake-up, each re-narrating "card1 completed, card3 in rework…";
 *   - meanwhile only 21 mailbox deliveries were produced for that requirement
 *     (20 task_status_update + 1 requirement_update), so the wake-ups themselves
 *     were legitimate — what was unbounded was the *writing* side.
 *
 * Four defects were fixed. Each test below bites if its fix is reverted:
 *   1. `requirement_update` had NO dedup key → the "all tasks terminal" reminder
 *      could be delivered forever, once per task event;
 *   2. `checkCompletion()` was level-triggered and only excluded
 *      completed/cancelled → rejected/archived requirements kept nagging;
 *   3. nothing bounded an agent's comment spam on one requirement;
 *   4. `task_create` accepted a terminal requirement → "completed requirement
 *      with a pending card" invariant break.
 */

describe('1 · mailboxDedupKey covers requirement events', () => {
  const item = (extra: Record<string, unknown>) => ({
    sourceType: 'requirement_update' as const,
    // 唤醒型投递 = 告知 agent「有事要你做」——这类才必须可去重。
    payload: {
      summary: '',
      content: '',
      requirementId: 'req_1',
      extra: { actionRequired: true, ...extra },
    } as never,
    metadata: {} as never,
  });

  it('same fact → same key (delivery layer can suppress the duplicate)', () => {
    const a = mailboxDedupKey(item({ event: 'all_tasks_terminal', factFingerprint: 't1:completed' }));
    const b = mailboxDedupKey(item({ event: 'all_tasks_terminal', factFingerprint: 't1:completed' }));
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it('a genuinely new fact (a task got linked) → different key, so it can notify again', () => {
    const a = mailboxDedupKey(item({ event: 'all_tasks_terminal', factFingerprint: 't1:completed' }));
    const c = mailboxDedupKey(
      item({ event: 'all_tasks_terminal', factFingerprint: 't1:completed,t2:completed' }),
    );
    expect(a).not.toBe(c);
  });

  it('no declared event → no key (never guess structure from content text)', () => {
    expect(mailboxDedupKey(item({}))).toBeUndefined();
  });
});

describe('2 · checkCompletion is edge-triggered and terminal-aware', () => {
  let service: RequirementService;
  let enqueue: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new RequirementService();
    service.setStatusTransitionRepo({
      record: vi.fn(),
      getByEntity: vi.fn(() => []),
    } as never);
    enqueue = vi.fn();
    service.setAgentManager({
      hasAgent: vi.fn(() => true),
      getAgent: vi.fn(() => ({ enqueueToMailbox: enqueue })),
    } as never);
  });

  function agentRequirement(taskIds = ['task-1']) {
    const req = service.createRequirement({
      orgId: 'org-1',
      projectId: 'proj-1',
      title: 'Do the thing',
      description: 'Deliver the thing end to end',
      priority: 'high' as const,
      source: 'agent',
      createdBy: 'agent-1',
    } as never);
    for (const tid of taskIds) service.linkTask(req.id, tid);
    return req;
  }

  it('re-emitting the same fact produces the identical dedup key (so delivery suppresses it)', () => {
    const req = agentRequirement(['task-1', 'task-2']);
    const statuses = new Map([
      ['task-1', 'completed'],
      ['task-2', 'completed'],
    ]);

    expect(service.checkCompletion(req.id, statuses)).toBe(true);
    expect(service.checkCompletion(req.id, statuses)).toBe(true);

    const keys = enqueue.mock.calls.map(call =>
      mailboxDedupKey({
        sourceType: 'requirement_update',
        payload: call[1] as never,
        metadata: (call[2]?.metadata ?? {}) as never,
      }),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(new Set(keys).size).toBe(1);
  });

  it('never nags a terminal (cancelled) requirement', () => {
    const req = agentRequirement();
    service.cancelRequirement(req.id, 'user-1', 'human');

    expect(service.checkCompletion(req.id, new Map([['task-1', 'completed']]))).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('3 · comment spam gate', () => {
  const row = (authorId: string, authorType: string, offsetMs: number) => ({
    id: `c_${offsetMs}`,
    requirementId: 'req_1',
    authorId,
    authorName: 'Author',
    authorType,
    content: `comment at ${offsetMs}`,
    mentions: [],
    createdAt: new Date(Date.now() - offsetMs).toISOString(),
  });

  function serviceWith(rows: unknown[]) {
    const ts = new TaskService();
    ts.setRequirementCommentRepo({
      add: vi.fn(async (data: Record<string, unknown>) => ({ id: 'new', ...data })),
      getByRequirement: vi.fn(() => rows),
    } as never);
    return ts;
  }

  it('rejects the 6th agent comment on the same requirement within 10 minutes', async () => {
    const rows = [0, 1000, 2000, 3000, 4000].map(ms => row('agent-1', 'agent', ms));
    const ts = serviceWith(rows);

    await expect(
      ts.postRequirementComment('req_1', 'agent-1', 'Author', 'sixth'),
    ).rejects.toMatchObject({ code: 'COMMENT_RATE_LIMITED' });
  });

  it('lets a human comment through — the gate only bounds agent self-narration', async () => {
    const rows = [0, 1000, 2000, 3000, 4000].map(ms => row('user-1', 'human', ms));
    const ts = serviceWith(rows);

    await expect(
      ts.postRequirementComment('req_1', 'user-1', 'Owner', 'a real reply', [], undefined, {
        authorType: 'human',
      }),
    ).resolves.toBeTruthy();
  });
});

describe('6 · wake-up dedup invariant: registry (L0) + fail-closed (L2)', () => {
  it('every registered event can compute a key (registry completeness)', () => {
    for (const [event, spec] of Object.entries(WAKEUP_EVENTS)) {
      const extra: Record<string, unknown> = { actionRequired: true, event };
      for (const field of spec.fingerprint) extra[field] = 'x';
      const payload: Record<string, unknown> = { summary: '', content: '', extra };
      payload[spec.entity[0]] = 'ent_1';
      const key = wakeupDedupKey(payload as never);
      expect(key, `event ${event} must be deduplicable`).toContain(event);
    }
  });

  it('a free-form event name is rejected — `event: "whatever"` cannot sneak past', () => {
    expect(
      wakeupDedupKey({
        requirementId: 'req_1',
        extra: { actionRequired: true, event: 'whatever' },
      } as never),
    ).toBeUndefined();
  });

  it('the delivery layer refuses an undedupable wake-up instead of letting it through', () => {
    expect(() =>
      assertWakeupDedupable('requirement_update', {
        summary: '',
        content: '',
        requirementId: 'req_1',
        extra: { actionRequired: true },
      } as never),
    ).toThrow(/undedupable wake-up/);

    // The error must be actionable: it names the registry to extend.
    expect(() =>
      assertWakeupDedupable('requirement_update', {
        summary: '',
        content: '',
        extra: { actionRequired: true },
      } as never),
    ).toThrow(/WAKEUP_EVENTS/);
  });

  it('workflow notifications became deduplicable without editing their call sites', () => {
    const base = {
      summary: '',
      content: '',
      extra: {
        actionRequired: true,
        event: 'step_failed',
        runId: 'wfrun_1',
        taskId: 'tsk_1',
        reason: 'timeout',
      },
    };
    const same = wakeupDedupKey(base as never);
    expect(same).toBeTruthy();
    expect(wakeupDedupKey(base as never)).toBe(same);

    // A different reason is a *different fact* and must not be suppressed.
    const otherReason = wakeupDedupKey({
      ...base,
      extra: { ...base.extra, reason: 'output_contract' },
    } as never);
    expect(otherReason).toBeTruthy();
    expect(otherReason).not.toBe(same);
  });

  it('never blocks a non-wake-up notification (informational items stay cheap)', () => {
    expect(() =>
      assertWakeupDedupable('requirement_update', {
        summary: '',
        content: '',
        requirementId: 'req_1',
        extra: { somethingElse: true },
      } as never),
    ).not.toThrow();
  });
});

describe('5 · decision notifications are identifiable and deduplicable', () => {
  it('an approval notice declares its event kind, so the delivery layer can suppress replays', () => {
    const service = new RequirementService();
    service.setStatusTransitionRepo({ record: vi.fn(), getByEntity: vi.fn(() => []) } as never);
    const enqueue = vi.fn();
    service.setAgentManager({
      hasAgent: vi.fn(() => true),
      getAgent: vi.fn(() => ({ enqueueToMailbox: enqueue })),
    } as never);

    const req = service.createRequirement({
      orgId: 'org-1',
      projectId: 'proj-1',
      title: 'Do the thing',
      description: 'Deliver the thing end to end',
      priority: 'high' as const,
      source: 'agent',
      createdBy: 'agent-1',
    } as never);
    service.approveRequirement(req.id, 'user-1');

    const decisionCall = enqueue.mock.calls.find(
      call => (call[1] as { extra?: { event?: string } }).extra?.event === 'decision:approved',
    );
    expect(decisionCall).toBeTruthy();

    // The whole point: the key must be computable, otherwise replays are undeduped.
    const key = mailboxDedupKey({
      sourceType: 'requirement_update',
      payload: decisionCall![1] as never,
      metadata: (decisionCall![2]?.metadata ?? {}) as never,
    });
    expect(key).toBeTruthy();
    expect(key).toContain('decision:approved');
  });
});

describe('4 · terminal requirement accepts no new tasks', () => {
  it('rejects task creation with an actionable error instead of minting an orphan card', () => {
    const ts = new TaskService();
    ts.setGovernancePolicy({
      enabled: false,
      defaultTier: 'auto',
      maxPendingTasksPerAgent: 100,
      maxTotalActiveTasks: 100,
      requireApprovalForPriority: [],
      requireRequirement: false,
      rules: [],
    });
    ts.setRequirementService({
      getRequirement: () => ({ id: 'req_1', title: 'Already done', status: 'completed' }),
    } as never);

    expect(() =>
      ts.createTask({
        orgId: 'org-1',
        title: 'Late work',
        description: '',
        assignedAgentId: 'agent-a',
        reviewerId: 'reviewer-1',
        requirementId: 'req_1',
      } as never),
    ).toThrow(/already completed/i);
  });
});
