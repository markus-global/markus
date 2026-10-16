import { createLogger } from '@markus/shared';
import type { ApprovalIntent, HITLService } from './hitl-service.js';

const log = createLogger('approval-apply');

/**
 * The gate closure: an approval whose `details.subType` is one of these is a
 * *gate* approval and its decision drives a task/requirement. Anything else
 * (tool approvals, expense/access requests, …) has no target to move and is
 * deliberately left untouched by the applier.
 */
export const APPROVAL_GATE_SUB_TYPES = ['task', 'task_review', 'requirement', 'requirement_resubmit'] as const;
export type ApprovalGateSubType = (typeof APPROVAL_GATE_SUB_TYPES)[number];

export interface ApprovalApplyInput {
  /** The approval entity whose decision is being applied (idempotency key holder). */
  approvalId: string;
  /** Gate marker — taken from `approval.details.subType`. */
  subType: string;
  /** The entity the decision moves (`taskId` / `requirementId`). */
  targetId: string;
  /** Resolved once, upstream, by {@link resolveApprovalIntent}. */
  intent: ApprovalIntent;
  actorId?: string;
  actorName?: string;
  comment?: string;
}

export type ApprovalApplyReason =
  | 'applied'
  | 'already-applied'
  | 'out-of-window'
  | 'unrouted'
  | 'failed';

export interface ApprovalApplyOutcome {
  applied: boolean;
  reason: ApprovalApplyReason;
  approvalId: string;
  subType: string;
  intent: ApprovalIntent;
  targetId: string;
  error?: string;
}

/**
 * A gate's narrow port. Implemented by the service that owns the target entity,
 * so the applier never has to import (and therefore never couples to) a concrete
 * service — and there is exactly one dispatch table in the whole platform.
 */
export interface ApprovalTargetPort {
  /** Gates this port owns. */
  readonly approvalGateSubTypes: readonly ApprovalGateSubType[];
  /**
   * Window guard — read-only, synchronous, no side effects: can this decision
   * still move the target?
   *
   * Orthogonal to the claim and **not** a substitute for it: it answers "is the
   * target still in the state this decision applies to" (a directly-invoked admin
   * endpoint may already have moved it), while the claim answers "has this
   * decision been applied already". Deliberately not used as an idempotency
   * judgement: two of the three gates intentionally perform zero state
   * transition, so a window check alone could never detect a re-apply.
   */
  canApplyApproval(subType: string, targetId: string): boolean;
  /**
   * Apply the decision. Implementations must keep the *pre-existing* semantics of
   * their gate intact (including per-status notes/settlement bookkeeping).
   */
  applyApprovalDecision(input: {
    subType: string;
    targetId: string;
    intent: ApprovalIntent;
    actorId?: string;
    actorName?: string;
    comment?: string;
  }): Promise<void> | void;
}

/**
 * The **single point of execution** for approval outcomes.
 *
 * Every consumer of a decision — the `requestApprovalAndWait` promise chain in
 * each gate and the `POST /api/approvals/:id` fallback — calls {@link apply}.
 * Nobody else is allowed to move a target on account of an approval, and the
 * fallback never calls `approveTask` / `rejectTask` / `rejectRequirement`
 * directly (those stay as admin direct endpoints).
 *
 * Idempotency is enforced by a synchronous claim on the approval entity, taken
 * after the window guard and before any `await`, so the promise path and the
 * fallback can never both write.
 */
export class ApprovalApplier {
  private ports = new Map<string, ApprovalTargetPort>();

  constructor(private hitlService: Pick<HITLService, 'claimApply'>) {}

  registerPort(port: ApprovalTargetPort): void {
    for (const subType of port.approvalGateSubTypes) {
      const existing = this.ports.get(subType);
      if (existing && existing !== port) {
        log.warn('Overriding approval gate port', { subType });
      }
      this.ports.set(subType, port);
    }
  }

  hasPort(subType: string): boolean {
    return this.ports.has(subType);
  }

  /**
   * Route one decision. Never rejects: a target-side failure is reported
   * (log + returned outcome) instead of propagating, so it can never fall into
   * the auto-reject `catch` of a gate that only wanted to say "I could not get a
   * decision".
   */
  async apply(input: ApprovalApplyInput): Promise<ApprovalApplyOutcome> {
    const { approvalId, subType, targetId, intent } = input;
    const base = { approvalId, subType, intent, targetId };

    const port = this.ports.get(subType);
    if (!port || !targetId) {
      log.warn('Approval decision has no routable gate — ignoring', { approvalId, subType, targetId, intent });
      return { ...base, applied: false, reason: 'unrouted' };
    }

    if (!port.canApplyApproval(subType, targetId)) {
      return { ...base, applied: false, reason: 'out-of-window' };
    }

    if (!this.hitlService.claimApply(approvalId, intent)) {
      return { ...base, applied: false, reason: 'already-applied' };
    }

    try {
      await port.applyApprovalDecision(input);
      return { ...base, applied: true, reason: 'applied' };
    } catch (err) {
      // Routed correctly and still failed → this one is worth reporting, with
      // enough identity to act on it.
      log.error('Approval decision apply failed after routing', {
        approvalId,
        subType,
        targetId,
        intent,
        error: String(err),
      });
      return { ...base, applied: false, reason: 'failed', error: String(err) };
    }
  }
}
