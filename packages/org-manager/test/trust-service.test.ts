import { describe, it, expect, beforeEach } from 'vitest';
import { TrustService } from '../src/trust-service.js';

describe('TrustService', () => {
  let service: TrustService;

  beforeEach(() => {
    service = new TrustService();
  });

  it('creates probation trust for new agents', () => {
    const trust = service.getOrCreate('agent-1');
    expect(trust.level).toBe('probation');
    expect(trust.score).toBe(0);
  });

  it('promotes agent after accepted deliveries', () => {
    for (let i = 0; i < 10; i++) {
      service.recordDeliveryAccepted('agent-1');
    }
    const trust = service.getTrustLevel('agent-1')!;
    expect(trust.totalDeliveries).toBe(10);
    expect(trust.acceptedDeliveries).toBe(10);
    expect(['standard', 'trusted', 'senior']).toContain(trust.level);
  });

  it('resets consecutive acceptances on rejection', () => {
    for (let i = 0; i < 5; i++) service.recordDeliveryAccepted('agent-1');
    service.recordDeliveryRejected('agent-1');
    const trust = service.getTrustLevel('agent-1')!;
    expect(trust.consecutiveAcceptances).toBe(0);
    expect(trust.rejectedDeliveries).toBe(1);
  });

  it('records revision requests', () => {
    service.recordRevisionRequested('agent-1');
    expect(service.getTrustLevel('agent-1')?.revisionRequests).toBe(1);
  });

  it('adjusts approval tier based on trust', () => {
    expect(service.adjustApprovalTier('auto', 'agent-new')).toBe('auto');
    expect(service.adjustApprovalTier('manager', 'agent-new')).toBe('human');

    for (let i = 0; i < 25; i++) service.recordDeliveryAccepted('senior-agent');
    expect(service.adjustApprovalTier('manager', 'senior-agent')).toBe('auto');
    expect(service.adjustApprovalTier('human', 'senior-agent')).toBe('manager');
  });

  it('forces human approval for probation agents', () => {
    expect(service.adjustApprovalTier('manager', 'probation-agent')).toBe('human');
  });

  it('lists all trust levels', () => {
    service.getOrCreate('a1');
    service.getOrCreate('a2');
    expect(service.listAll()).toHaveLength(2);
  });
});
