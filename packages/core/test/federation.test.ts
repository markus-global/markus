import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FederationManager, type FederationAgentProvider, type FederatedAgent, type FederationEvent,
} from '../src/federation/index.js';

function createMockProvider(agents?: Record<string, FederatedAgent[]>): FederationAgentProvider {
  return {
    listDiscoverableAgents: vi.fn((orgId: string) => agents?.[orgId] ?? []),
    routeMessage: vi.fn(async (_orgId: string, _agentId: string, message: string) => {
      return `Reply to: ${message}`;
    }),
  };
}

const orgAAgents: FederatedAgent[] = [
  { agentId: 'a-dev-1', agentName: 'Dev Agent', orgId: 'org-a', orgName: 'Org A', capabilities: ['code'], agentRole: 'worker', availableForDelegation: true },
  { agentId: 'a-pm-1', agentName: 'PM Agent', orgId: 'org-a', orgName: 'Org A', capabilities: ['management'], agentRole: 'manager', availableForDelegation: true },
];

const orgBAgents: FederatedAgent[] = [
  { agentId: 'b-qa-1', agentName: 'QA Agent', orgId: 'org-b', orgName: 'Org B', capabilities: ['testing'], agentRole: 'worker', availableForDelegation: true },
];

describe('FederationManager', () => {
  let fm: FederationManager;
  let provider: FederationAgentProvider;

  beforeEach(() => {
    provider = createMockProvider({ 'org-a': orgAAgents, 'org-b': orgBAgents });
    fm = new FederationManager(provider);
  });

  describe('policies', () => {
    it('should return default policy for unknown org', () => {
      const policy = fm.getPolicy('unknown-org');
      expect(policy.orgId).toBe('unknown-org');
      expect(policy.acceptIncoming).toBe(false);
    });

    it('should set and retrieve policy', () => {
      fm.setPolicy({
        orgId: 'org-a',
        acceptIncoming: true,
        autoApproveOrgs: ['org-b'],
        defaultTrustLevel: 'messaging',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: ['a-dev-1'],
      });
      const policy = fm.getPolicy('org-a');
      expect(policy.acceptIncoming).toBe(true);
      expect(policy.autoApproveOrgs).toEqual(['org-b']);
    });
  });

  describe('link management', () => {
    it('should reject link when target org does not accept incoming', () => {
      expect(() => fm.requestLink('org-a', 'org-b')).toThrow('does not accept incoming');
    });

    it('should create pending link when target accepts incoming', () => {
      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: [],
        defaultTrustLevel: 'messaging',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      const link = fm.requestLink('org-a', 'org-b');
      expect(link.status).toBe('pending');
      expect(link.sourceOrgId).toBe('org-a');
      expect(link.targetOrgId).toBe('org-b');
    });

    it('should auto-approve when source is in autoApproveOrgs', () => {
      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: ['org-a'],
        defaultTrustLevel: 'messaging',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      const link = fm.requestLink('org-a', 'org-b');
      expect(link.status).toBe('active');
    });

    it('should approve a pending link', () => {
      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: [],
        defaultTrustLevel: 'messaging',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      fm.requestLink('org-a', 'org-b');
      const approved = fm.approveLink('org-a', 'org-b');
      expect(approved).toBe(true);
      expect(fm.getLink('org-a', 'org-b')!.status).toBe('active');
    });

    it('should revoke a link and its reverse', () => {
      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: ['org-a'],
        defaultTrustLevel: 'messaging',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      fm.requestLink('org-a', 'org-b');
      const revoked = fm.revokeLink('org-a', 'org-b');
      expect(revoked).toBe(true);
      expect(fm.getLink('org-a', 'org-b')!.status).toBe('revoked');
    });

    it('should list active links for an org', () => {
      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: ['org-a'],
        defaultTrustLevel: 'messaging',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      fm.requestLink('org-a', 'org-b');
      const links = fm.listActiveLinks('org-a');
      expect(links.length).toBeGreaterThanOrEqual(1);
    });

    it('should use minimum trust level between request and policy', () => {
      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: ['org-a'],
        defaultTrustLevel: 'discovery',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      const link = fm.requestLink('org-a', 'org-b', 'full');
      expect(link.trustLevel).toBe('discovery');
    });
  });

  describe('agent discovery', () => {
    it('should discover agents from federated org', () => {
      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: ['org-a'],
        defaultTrustLevel: 'messaging',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      fm.requestLink('org-a', 'org-b');
      const agents = fm.discoverAgents('org-a', 'org-b');
      expect(agents).toHaveLength(1);
      expect(agents[0]!.agentId).toBe('b-qa-1');
    });

    it('should not discover agents without active link', () => {
      const agents = fm.discoverAgents('org-a', 'org-b');
      expect(agents).toHaveLength(0);
    });

    it('should discover agents from all federated orgs', () => {
      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: ['org-a'],
        defaultTrustLevel: 'messaging',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      fm.requestLink('org-a', 'org-b');
      const agents = fm.discoverAllFederatedAgents('org-a');
      expect(agents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('messaging', () => {
    it('should send cross-org message and receive response', async () => {
      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: ['org-a'],
        defaultTrustLevel: 'messaging',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      fm.requestLink('org-a', 'org-b');

      const response = await fm.sendMessage('org-a', 'a-dev-1', 'org-b', 'b-qa-1', 'Please test this code');
      expect(response.type).toBe('response');
      expect(response.content).toBe('Reply to: Please test this code');
      expect(response.sourceOrgId).toBe('org-b');
      expect(response.targetOrgId).toBe('org-a');
    });

    it('should reject messaging without active link', async () => {
      await expect(
        fm.sendMessage('org-a', 'a-dev-1', 'org-b', 'b-qa-1', 'Hello')
      ).rejects.toThrow('No active federation link');
    });

    it('should reject messaging with insufficient trust level', async () => {
      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: ['org-a'],
        defaultTrustLevel: 'discovery',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      fm.requestLink('org-a', 'org-b', 'discovery');
      await expect(
        fm.sendMessage('org-a', 'a-dev-1', 'org-b', 'b-qa-1', 'Hello')
      ).rejects.toThrow('does not allow messaging');
    });

    it('should track message log', async () => {
      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: ['org-a'],
        defaultTrustLevel: 'messaging',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      fm.requestLink('org-a', 'org-b');
      await fm.sendMessage('org-a', 'a-dev-1', 'org-b', 'b-qa-1', 'Test message');

      const log = fm.getMessageLog('org-a');
      expect(log).toHaveLength(2); // request + response
    });
  });

  describe('events', () => {
    it('should emit events for link lifecycle', () => {
      const events: FederationEvent[] = [];
      fm.onEvent(e => events.push(e));

      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: [],
        defaultTrustLevel: 'messaging',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      fm.requestLink('org-a', 'org-b');
      fm.approveLink('org-a', 'org-b');
      fm.revokeLink('org-a', 'org-b');

      const types = events.map(e => e.type);
      expect(types).toContain('link_created');
      expect(types).toContain('link_updated');
      expect(types).toContain('link_revoked');
    });

    it('should unsubscribe from events', () => {
      const events: FederationEvent[] = [];
      const unsub = fm.onEvent(e => events.push(e));

      fm.setPolicy({
        orgId: 'org-b', acceptIncoming: true, autoApproveOrgs: ['org-a'],
        defaultTrustLevel: 'messaging',
        defaultSandbox: { allowFileAccess: false, allowShellAccess: false, allowNetworkAccess: false, maxTokenBudget: 5000, timeoutMs: 30000, allowedTools: [] },
        discoverableAgentIds: [],
      });

      fm.requestLink('org-a', 'org-b');
      unsub();
      fm.revokeLink('org-a', 'org-b');

      expect(events.some(e => e.type === 'link_revoked')).toBe(false);
    });
  });
});
