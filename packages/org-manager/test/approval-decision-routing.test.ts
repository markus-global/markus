/**
 * A decision must reach its gate **whoever recorded it**.
 *
 * Defect it fixes (2026-10-16): a Feishu card tap recorded the decision
 * (`respondToApproval` flipped the approval to `approved` / `rejected`) while the
 * task stayed `pending` — the target never moved. Root cause: applying the
 * decision was an obligation of the *caller*, and only some callers honoured it.
 * The in-process platform-action path relied exclusively on the
 * `requestApprovalAndWait` promise callback, which lives in memory and is lost
 * when the process restarts; the HTTP path had a documented fallback, the card
 * path did not. So the same tap "worked" on an approval created minutes earlier
 * and did nothing on one created before the last restart.
 *
 * The invariant locked down here: **recording a decision routes it.** Routing
 * lives at the single point where a decision is recorded, so no surface —
 * present or future — can forget. Exactly-once is preserved by `claimApply`.
 */
import { describe, it, expect, vi } from 'vitest';
import { HITLService } from '../src/hitl-service.js';
import { ApprovalApplier, routeRecordedDecision, targetOfApproval } from '../src/approval-apply.js';

/** Let queued microtasks and the applier's async port call settle. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

type AppliedCall = {
  subType: string;
  targetId: string;
  intent: string;
  actorId?: string;
  comment?: string;
};

/** A minimal gate port that records every apply it is asked to perform. */
function createGatePort(subTypes: string[]) {
  const applied: AppliedCall[] = [];
  const port = {
    approvalGateSubTypes: subTypes,
    canApplyApproval: vi.fn(() => true),
    applyApprovalDecision: vi.fn((input: AppliedCall) => {
      applied.push(input);
    }),
  };
  return { applied, port };
}

/** A service with routing wired, exactly as the composition root wires it. */
function createWiredService() {
  const hitl = new HITLService();
  const { applied, port } = createGatePort(['task', 'task_review', 'requirement']);
  const applier = new ApprovalApplier(hitl);
  applier.registerPort(port as never);
  hitl.setDecisionRouter(response =>
    routeRecordedDecision(applier, response.approval, response.decision),
  );
  return { hitl, applied, port, applier };
}

function requestTaskGate(hitl: HITLService, taskId: string) {
  return hitl.requestApproval({
    agentId: 'agent-a',
    agentName: 'Agent A',
    type: 'custom',
    title: 'Create task',
    description: 'wants to create a task',
    details: { subType: 'task', taskId },
  });
}

describe('approval decision routing', () => {
  it('routes a decision recorded with no live waiter (card tap after a restart)', async () => {
    const { hitl, applied } = createWiredService();

    // The approval exists — as it does after a restart, restored from storage —
    // but nothing in this process is awaiting it.
    const approval = requestTaskGate(hitl, 'tsk_after_restart');
    expect(hitl.getApproval(approval.id)?.status).toBe('pending');

    // Exactly what the inbound platform-action path does with a card tap.
    const response = hitl.respondToApproval(approval.id, true, 'ou_operator', undefined, 'approve');
    expect(response?.approval.status).toBe('approved');
    await flush();

    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      subType: 'task',
      targetId: 'tsk_after_restart',
      intent: 'approve',
      actorId: 'ou_operator',
    });
  });

  it('applies exactly once when a live waiter also routes the same decision', async () => {
    const { hitl, applied, applier } = createWiredService();

    const waiting = hitl.requestApprovalAndWait({
      agentId: 'agent-a',
      agentName: 'Agent A',
      type: 'custom',
      title: 'Create task',
      description: 'wants to create a task',
      details: { subType: 'task', taskId: 'tsk_live' },
    });
    const approvalId = hitl.listApprovals('pending')[0]!.id;

    // The gate's own promise callback — the pre-existing, happy path.
    const gatePath = waiting.then(result => {
      const approval = hitl.getApproval(approvalId);
      if (approval) routeRecordedDecision(applier, approval, result, {
        actorId: result.respondedBy,
      });
    });

    hitl.respondToApproval(approvalId, true, 'user-1', undefined, 'approve');
    await flush();
    await gatePath;
    await flush();

    // One decision, one write — the duplicate must lose the claim, never double.
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ targetId: 'tsk_live', intent: 'approve' });
    void waiting.catch(() => undefined);
  });

  it('does not silently drop a decision for a gate nobody owns', async () => {
    const hitl = new HITLService();
    const applier = new ApprovalApplier(hitl);
    const { applied } = createGatePort(['task']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hitl.setDecisionRouter(response =>
      routeRecordedDecision(applier, response.approval, response.decision),
    );

    const approval = requestTaskGate(hitl, 'tsk_orphan');
    const outcome = await applier.apply({
      approvalId: approval.id,
      ...targetOfApproval(approval.details),
      intent: 'approve',
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('unrouted');
    expect(applied).toHaveLength(0);
    warn.mockRestore();
  });
});

describe('targetOfApproval', () => {
  it.each([
    ['task', { subType: 'task', taskId: 'tsk_1' }, 'tsk_1'],
    ['task_review', { subType: 'task_review', taskId: 'tsk_2' }, 'tsk_2'],
    ['requirement', { subType: 'requirement', requirementId: 'req_1' }, 'req_1'],
    ['requirement_resubmit', { subType: 'requirement_resubmit', requirementId: 'req_2' }, 'req_2'],
  ])('reads the target id for %s from the approval itself', (_label, details, expected) => {
    expect(targetOfApproval(details as Record<string, unknown>).targetId).toBe(expected);
  });

  it('reports no target for an unknown gate instead of guessing', () => {
    expect(targetOfApproval({ subType: 'something_else', taskId: 'tsk_x' })).toEqual({
      subType: 'something_else',
      targetId: '',
    });
    expect(targetOfApproval(undefined)).toEqual({ subType: '', targetId: '' });
  });
});
