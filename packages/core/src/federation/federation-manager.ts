import { createLogger, generateId } from '@markus/shared';
import {
  DEFAULT_SANDBOX,
  type FederationLink, type TrustLevel,
  type FederatedAgent, type CrossOrgMessage,
  type FederationPolicy, type FederationEvent,
} from './types.js';

const log = createLogger('federation');

export type FederationEventHandler = (event: FederationEvent) => void;

export interface FederationAgentProvider {
  listDiscoverableAgents(orgId: string): FederatedAgent[];
  routeMessage(orgId: string, agentId: string, message: string, senderInfo: { name: string; role: string }): Promise<string>;
}

export class FederationManager {
  private links = new Map<string, FederationLink>();
  private policies = new Map<string, FederationPolicy>();
  private eventHandlers: FederationEventHandler[] = [];
  private messageLog: CrossOrgMessage[] = [];
  private rateCounts = new Map<string, { count: number; resetAt: number }>();

  constructor(private agentProvider: FederationAgentProvider) {}

  onEvent(handler: FederationEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx >= 0) this.eventHandlers.splice(idx, 1);
    };
  }

  private emit(event: FederationEvent): void {
    for (const handler of this.eventHandlers) {
      try { handler(event); } catch (err) {
        log.warn('Event handler error', { error: String(err) });
      }
    }
  }

  // ── Policy Management ──────────────────────────────────────────────────

  setPolicy(policy: FederationPolicy): void {
    this.policies.set(policy.orgId, policy);
    log.info('Federation policy set', { orgId: policy.orgId, acceptIncoming: policy.acceptIncoming });
  }

  getPolicy(orgId: string): FederationPolicy {
    return this.policies.get(orgId) ?? {
      orgId,
      acceptIncoming: false,
      autoApproveOrgs: [],
      defaultTrustLevel: 'discovery',
      defaultSandbox: DEFAULT_SANDBOX,
      discoverableAgentIds: [],
    };
  }

  // ── Link Management ────────────────────────────────────────────────────

  requestLink(sourceOrgId: string, targetOrgId: string, trustLevel: TrustLevel = 'messaging'): FederationLink {
    const existingKey = this.linkKey(sourceOrgId, targetOrgId);
    if (this.links.has(existingKey)) {
      const existing = this.links.get(existingKey)!;
      if (existing.status === 'active') {
        return existing;
      }
    }

    const targetPolicy = this.getPolicy(targetOrgId);

    if (!targetPolicy.acceptIncoming) {
      throw new Error(`Organization ${targetOrgId} does not accept incoming federation requests`);
    }

    const autoApprove = targetPolicy.autoApproveOrgs.includes(sourceOrgId);
    const effectiveTrust = this.minTrust(trustLevel, targetPolicy.defaultTrustLevel);

    const link: FederationLink = {
      id: generateId('fed-link'),
      sourceOrgId,
      targetOrgId,
      status: autoApprove ? 'active' : 'pending',
      trustLevel: effectiveTrust,
      sharedCapabilities: [],
      maxConcurrentTasks: 5,
      rateLimitPerMinute: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.links.set(existingKey, link);

    if (autoApprove) {
      const reverseKey = this.linkKey(targetOrgId, sourceOrgId);
      if (!this.links.has(reverseKey)) {
        this.links.set(reverseKey, {
          ...link,
          id: generateId('fed-link'),
          sourceOrgId: targetOrgId,
          targetOrgId: sourceOrgId,
        });
      }
    }

    this.emit({
      type: 'link_created',
      sourceOrgId,
      targetOrgId,
      data: { linkId: link.id, status: link.status, trustLevel: link.trustLevel },
      timestamp: new Date(),
    });

    log.info('Federation link requested', {
      sourceOrgId, targetOrgId,
      status: link.status, trustLevel: link.trustLevel,
    });

    return link;
  }

  approveLink(sourceOrgId: string, targetOrgId: string): boolean {
    const key = this.linkKey(sourceOrgId, targetOrgId);
    const link = this.links.get(key);
    if (!link || link.status !== 'pending') return false;

    link.status = 'active';
    link.updatedAt = new Date();

    const reverseKey = this.linkKey(targetOrgId, sourceOrgId);
    if (!this.links.has(reverseKey)) {
      this.links.set(reverseKey, {
        ...link,
        id: generateId('fed-link'),
        sourceOrgId: targetOrgId,
        targetOrgId: sourceOrgId,
      });
    }

    this.emit({
      type: 'link_updated',
      sourceOrgId, targetOrgId,
      data: { status: 'active' },
      timestamp: new Date(),
    });

    return true;
  }

  revokeLink(sourceOrgId: string, targetOrgId: string): boolean {
    const key = this.linkKey(sourceOrgId, targetOrgId);
    const link = this.links.get(key);
    if (!link) return false;

    link.status = 'revoked';
    link.updatedAt = new Date();

    const reverseKey = this.linkKey(targetOrgId, sourceOrgId);
    const reverseLink = this.links.get(reverseKey);
    if (reverseLink && reverseLink.status !== 'revoked') {
      reverseLink.status = 'revoked';
      reverseLink.updatedAt = new Date();
    }

    this.emit({
      type: 'link_revoked',
      sourceOrgId, targetOrgId,
      timestamp: new Date(),
    });

    return true;
  }

  getLink(sourceOrgId: string, targetOrgId: string): FederationLink | undefined {
    return this.links.get(this.linkKey(sourceOrgId, targetOrgId));
  }

  listLinks(orgId: string): FederationLink[] {
    return [...this.links.values()].filter(
      l => l.sourceOrgId === orgId || l.targetOrgId === orgId
    );
  }

  listActiveLinks(orgId: string): FederationLink[] {
    return this.listLinks(orgId).filter(l => l.status === 'active');
  }

  // ── Agent Discovery ────────────────────────────────────────────────────

  discoverAgents(requestingOrgId: string, targetOrgId: string): FederatedAgent[] {
    const link = this.getActiveLink(requestingOrgId, targetOrgId);
    if (!link) return [];

    if (!this.hasTrustLevel(link.trustLevel, 'discovery')) return [];

    const agents = this.agentProvider.listDiscoverableAgents(targetOrgId);

    this.emit({
      type: 'agent_discovered',
      sourceOrgId: requestingOrgId,
      targetOrgId,
      data: { agentCount: agents.length },
      timestamp: new Date(),
    });

    return agents;
  }

  discoverAllFederatedAgents(orgId: string): FederatedAgent[] {
    const activeLinks = this.listActiveLinks(orgId);
    const agents: FederatedAgent[] = [];

    for (const link of activeLinks) {
      const targetOrgId = link.sourceOrgId === orgId ? link.targetOrgId : link.sourceOrgId;
      if (this.hasTrustLevel(link.trustLevel, 'discovery')) {
        agents.push(...this.agentProvider.listDiscoverableAgents(targetOrgId));
      }
    }

    return agents;
  }

  // ── Cross-Org Messaging ────────────────────────────────────────────────

  async sendMessage(
    sourceOrgId: string,
    sourceAgentId: string,
    targetOrgId: string,
    targetAgentId: string,
    content: string,
    opts: { type?: CrossOrgMessage['type']; metadata?: Record<string, unknown>; correlationId?: string } = {},
  ): Promise<CrossOrgMessage> {
    const link = this.getActiveLink(sourceOrgId, targetOrgId);
    if (!link) {
      throw new Error(`No active federation link between ${sourceOrgId} and ${targetOrgId}`);
    }

    if (!this.hasTrustLevel(link.trustLevel, 'messaging')) {
      throw new Error(`Trust level "${link.trustLevel}" does not allow messaging`);
    }

    if (!this.checkRateLimit(link)) {
      throw new Error('Rate limit exceeded for this federation link');
    }

    const targetPolicy = this.getPolicy(targetOrgId);
    const sandbox = targetPolicy.defaultSandbox;

    const msg: CrossOrgMessage = {
      id: generateId('xorg-msg'),
      sourceOrgId,
      sourceAgentId,
      targetOrgId,
      targetAgentId,
      type: opts.type ?? 'request',
      content,
      metadata: opts.metadata,
      correlationId: opts.correlationId,
      timestamp: new Date(),
      sandbox,
    };

    this.messageLog.push(msg);

    const reply = await this.agentProvider.routeMessage(
      targetOrgId, targetAgentId, content,
      { name: `agent:${sourceAgentId}@${sourceOrgId}`, role: 'federated-agent' },
    );

    const responseMsg: CrossOrgMessage = {
      id: generateId('xorg-msg'),
      sourceOrgId: targetOrgId,
      sourceAgentId: targetAgentId,
      targetOrgId: sourceOrgId,
      targetAgentId: sourceAgentId,
      type: 'response',
      content: reply,
      correlationId: msg.id,
      timestamp: new Date(),
      sandbox,
    };

    this.messageLog.push(responseMsg);

    this.emit({
      type: 'message_sent',
      sourceOrgId,
      targetOrgId,
      agentId: sourceAgentId,
      data: { messageId: msg.id, responseId: responseMsg.id },
      timestamp: new Date(),
    });

    return responseMsg;
  }

  getMessageLog(orgId: string, limit = 50): CrossOrgMessage[] {
    return this.messageLog
      .filter(m => m.sourceOrgId === orgId || m.targetOrgId === orgId)
      .slice(-limit);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private linkKey(sourceOrgId: string, targetOrgId: string): string {
    return `${sourceOrgId}::${targetOrgId}`;
  }

  private getActiveLink(orgA: string, orgB: string): FederationLink | undefined {
    const forward = this.links.get(this.linkKey(orgA, orgB));
    if (forward?.status === 'active') return forward;
    const reverse = this.links.get(this.linkKey(orgB, orgA));
    if (reverse?.status === 'active') return reverse;
    return undefined;
  }

  private readonly TRUST_ORDER: TrustLevel[] = ['none', 'discovery', 'messaging', 'task_delegation', 'full'];

  private hasTrustLevel(current: TrustLevel, required: TrustLevel): boolean {
    return this.TRUST_ORDER.indexOf(current) >= this.TRUST_ORDER.indexOf(required);
  }

  private minTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
    const idxA = this.TRUST_ORDER.indexOf(a);
    const idxB = this.TRUST_ORDER.indexOf(b);
    return this.TRUST_ORDER[Math.min(idxA, idxB)]!;
  }

  private checkRateLimit(link: FederationLink): boolean {
    const key = link.id;
    const now = Date.now();
    const entry = this.rateCounts.get(key);

    if (!entry || now >= entry.resetAt) {
      this.rateCounts.set(key, { count: 1, resetAt: now + 60000 });
      return true;
    }

    if (entry.count >= link.rateLimitPerMinute) {
      this.emit({
        type: 'policy_violation',
        sourceOrgId: link.sourceOrgId,
        targetOrgId: link.targetOrgId,
        data: { reason: 'rate_limit_exceeded', count: entry.count, limit: link.rateLimitPerMinute },
        timestamp: new Date(),
      });
      return false;
    }

    entry.count++;
    return true;
  }
}
