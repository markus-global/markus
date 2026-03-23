import { describe, it, expect, beforeEach } from 'vitest';
import { ExternalAgentGateway, GatewayError } from '../src/external-gateway.js';

const TEST_SECRET = 'test-signing-secret-32chars-long!';

describe('ExternalAgentGateway', () => {
  let gw: ExternalAgentGateway;

  beforeEach(() => {
    gw = new ExternalAgentGateway({ signingSecret: TEST_SECRET });
    gw.setAgentCreator(async (opts) => ({ id: `markus_${opts.name}` }));
    gw.setMessageRouter(async (_agentId, message, _senderId) => `echo: ${message}`);
    gw.setTasksFetcher(() => []);
  });

  describe('register', () => {
    it('registers an external agent', async () => {
      const reg = await gw.register({
        externalAgentId: 'ext-1',
        agentName: 'Test Agent',
        orgId: 'org-1',
        capabilities: ['code_review'],
      });

      expect(reg.externalAgentId).toBe('ext-1');
      expect(reg.agentName).toBe('Test Agent');
      expect(reg.orgId).toBe('org-1');
      expect(reg.markusAgentId).toBe('markus_Test Agent');
      expect(reg.connected).toBe(false);
    });

    it('rejects duplicate registration', async () => {
      await gw.register({ externalAgentId: 'ext-1', agentName: 'A', orgId: 'org-1' });
      await expect(gw.register({ externalAgentId: 'ext-1', agentName: 'B', orgId: 'org-1' }))
        .rejects.toThrow(GatewayError);
    });

    it('rejects missing fields', async () => {
      await expect(gw.register({ externalAgentId: '', agentName: 'A', orgId: 'org-1' }))
        .rejects.toThrow('Missing required fields');
    });

    it('enforces per-org agent limit', async () => {
      const limitedGw = new ExternalAgentGateway({ signingSecret: TEST_SECRET, maxAgentsPerOrg: 2 });
      limitedGw.setAgentCreator(async (opts) => ({ id: `m_${opts.name}` }));

      await limitedGw.register({ externalAgentId: 'e1', agentName: 'A1', orgId: 'org-1' });
      await limitedGw.register({ externalAgentId: 'e2', agentName: 'A2', orgId: 'org-1' });
      await expect(limitedGw.register({ externalAgentId: 'e3', agentName: 'A3', orgId: 'org-1' }))
        .rejects.toThrow('maximum');
    });
  });

  describe('authenticate', () => {
    it('returns a valid token for registered agents', async () => {
      await gw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      const auth = gw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: TEST_SECRET });

      expect(auth.token).toBeDefined();
      expect(auth.token.split('.')).toHaveLength(2);
      expect(auth.markusAgentId).toBe('markus_Agent');
    });

    it('rejects unregistered agents', () => {
      expect(() => gw.authenticate({ externalAgentId: 'unknown', orgId: 'org-1', secret: TEST_SECRET }))
        .toThrow('not registered');
    });

    it('rejects wrong secret', async () => {
      await gw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      expect(() => gw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: 'wrong' }))
        .toThrow('Invalid organization secret');
    });

    it('uses per-org secrets when set', async () => {
      await gw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      gw.setOrgSecret('org-1', 'org-specific-secret');

      expect(() => gw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: TEST_SECRET }))
        .toThrow('Invalid organization secret');

      const auth = gw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: 'org-specific-secret' });
      expect(auth.token).toBeDefined();
    });
  });

  describe('token verification', () => {
    it('verifies a valid token', async () => {
      await gw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      const { token } = gw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: TEST_SECRET });
      const payload = gw.verifyToken(token);

      expect(payload.externalAgentId).toBe('ext-1');
      expect(payload.orgId).toBe('org-1');
      expect(payload.markusAgentId).toBe('markus_Agent');
    });

    it('rejects tampered tokens', async () => {
      await gw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      const { token } = gw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: TEST_SECRET });
      const [payload] = token.split('.');
      const tampered = `${payload}.0000000000000000000000000000000000000000000000000000000000000000`;

      expect(() => gw.verifyToken(tampered)).toThrow('Invalid token signature');
    });

    it('rejects expired tokens', async () => {
      const shortGw = new ExternalAgentGateway({ signingSecret: TEST_SECRET, tokenExpiryMs: -1 });
      shortGw.setAgentCreator(async (opts) => ({ id: `m_${opts.name}` }));
      await shortGw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      const { token } = shortGw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: TEST_SECRET });

      expect(() => shortGw.verifyToken(token)).toThrow('Token expired');
    });

    it('rejects malformed tokens', () => {
      expect(() => gw.verifyToken('not-a-token')).toThrow('Invalid token format');
    });
  });

  describe('message routing', () => {
    it('routes a task message', async () => {
      await gw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      const { token: tokenStr } = gw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: TEST_SECRET });
      const token = gw.verifyToken(tokenStr);

      const result = await gw.routeMessage(token, { type: 'task', content: 'Do something' });
      expect(result.success).toBe(true);
      expect(result.messageId).toMatch(/^gwmsg_/);
      expect(result.response).toBe('echo: [TASK] Do something');
    });

    it('handles heartbeat without routing', async () => {
      await gw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      const { token: tokenStr } = gw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: TEST_SECRET });
      const token = gw.verifyToken(tokenStr);

      const result = await gw.routeMessage(token, { type: 'heartbeat', content: 'ping' });
      expect(result.success).toBe(true);
      expect(result.response).toBe('heartbeat_ack');
    });
  });

  describe('status', () => {
    it('returns agent status', async () => {
      await gw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      const { token: tokenStr } = gw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: TEST_SECRET });
      const token = gw.verifyToken(tokenStr);

      const status = gw.getStatus(token);
      expect(status.connected).toBe(true);
      expect(status.assignedTasks).toEqual([]);
      expect(status.lastHeartbeat).toBeDefined();
    });

    it('returns tasks from fetcher', async () => {
      const tasks = [{ id: 't1', title: 'Task 1', status: 'in_progress', priority: 'high' }];
      gw.setTasksFetcher(() => tasks);

      await gw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      const { token: tokenStr } = gw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: TEST_SECRET });
      const token = gw.verifyToken(tokenStr);

      const status = gw.getStatus(token);
      expect(status.assignedTasks).toHaveLength(1);
      expect(status.assignedTasks[0].title).toBe('Task 1');
    });
  });

  describe('disconnect & unregister', () => {
    it('disconnects an agent', async () => {
      await gw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      gw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: TEST_SECRET });

      gw.disconnect('ext-1', 'org-1');

      const regs = gw.listRegistrations('org-1');
      expect(regs[0].connected).toBe(false);
    });

    it('unregisters an agent', async () => {
      await gw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      const removed = await gw.unregister('ext-1', 'org-1');

      expect(removed).not.toBeNull();
      expect(gw.listRegistrations('org-1')).toHaveLength(0);
    });

    it('rejects token after unregistration', async () => {
      await gw.register({ externalAgentId: 'ext-1', agentName: 'Agent', orgId: 'org-1' });
      const { token } = gw.authenticate({ externalAgentId: 'ext-1', orgId: 'org-1', secret: TEST_SECRET });
      await gw.unregister('ext-1', 'org-1');

      expect(() => gw.verifyToken(token)).toThrow('no longer registered');
    });
  });

  describe('listRegistrations', () => {
    it('lists all registrations', async () => {
      await gw.register({ externalAgentId: 'e1', agentName: 'A1', orgId: 'org-1' });
      await gw.register({ externalAgentId: 'e2', agentName: 'A2', orgId: 'org-2' });

      expect(gw.listRegistrations()).toHaveLength(2);
      expect(gw.listRegistrations('org-1')).toHaveLength(1);
      expect(gw.listRegistrations('org-2')).toHaveLength(1);
    });
  });
});
