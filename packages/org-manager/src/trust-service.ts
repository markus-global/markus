import {
  createLogger,
  type AgentTrustLevel,
  type TrustLevel,
  type ApprovalTier,
} from '@markus/shared';

const log = createLogger('trust-service');

export class TrustService {
  private trustLevels = new Map<string, AgentTrustLevel>();

  getOrCreate(agentId: string): AgentTrustLevel {
    let trust = this.trustLevels.get(agentId);
    if (!trust) {
      trust = {
        agentId,
        level: 'probation',
        score: 0,
        totalDeliveries: 0,
        acceptedDeliveries: 0,
        rejectedDeliveries: 0,
        revisionRequests: 0,
        consecutiveAcceptances: 0,
        lastEvaluatedAt: new Date().toISOString(),
      };
      this.trustLevels.set(agentId, trust);
    }
    return trust;
  }

  recordDeliveryAccepted(agentId: string): AgentTrustLevel {
    const trust = this.getOrCreate(agentId);
    trust.totalDeliveries++;
    trust.acceptedDeliveries++;
    trust.consecutiveAcceptances++;
    return this.recalculate(trust);
  }

  recordDeliveryRejected(agentId: string): AgentTrustLevel {
    const trust = this.getOrCreate(agentId);
    trust.totalDeliveries++;
    trust.rejectedDeliveries++;
    trust.consecutiveAcceptances = 0;
    return this.recalculate(trust);
  }

  recordRevisionRequested(agentId: string): AgentTrustLevel {
    const trust = this.getOrCreate(agentId);
    trust.revisionRequests++;
    trust.consecutiveAcceptances = 0;
    return this.recalculate(trust);
  }

  private recalculate(trust: AgentTrustLevel): AgentTrustLevel {
    const oldLevel = trust.level;

    if (trust.totalDeliveries > 0) {
      trust.score = Math.max(
        0,
        Math.min(
          100,
          (trust.acceptedDeliveries / trust.totalDeliveries) * 80 +
            Math.min(trust.consecutiveAcceptances / 10, 1) * 20 -
            trust.rejectedDeliveries * 5
        )
      );
    }

    trust.level = this.scoreToLevel(trust.score, trust.totalDeliveries);
    trust.lastEvaluatedAt = new Date().toISOString();

    if (trust.level !== oldLevel) {
      log.info('Trust level changed', {
        agentId: trust.agentId,
        oldLevel,
        newLevel: trust.level,
        score: trust.score,
      });
    }

    this.trustLevels.set(trust.agentId, trust);
    return trust;
  }

  private scoreToLevel(score: number, totalDeliveries: number): TrustLevel {
    if (score < 40 || totalDeliveries < 3) return 'probation';
    if (score >= 85 && totalDeliveries >= 25) return 'senior';
    if (score >= 70 && totalDeliveries >= 10) return 'trusted';
    return 'standard';
  }

  adjustApprovalTier(policyTier: ApprovalTier, agentId: string): ApprovalTier {
    const trust = this.getOrCreate(agentId);

    if (policyTier === 'auto') return 'auto';

    if (trust.level === 'probation') {
      return 'human';
    }
    if (trust.level === 'trusted' || trust.level === 'senior') {
      if (policyTier === 'manager') return 'auto';
      if (policyTier === 'human') return 'manager';
    }

    return policyTier;
  }

  getTrustLevel(agentId: string): AgentTrustLevel | undefined {
    return this.trustLevels.get(agentId);
  }

  listAll(): AgentTrustLevel[] {
    return [...this.trustLevels.values()];
  }
}
