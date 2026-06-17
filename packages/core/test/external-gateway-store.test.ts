import { describe, it, expect, vi } from 'vitest';
import { ExternalAgentGateway } from '../src/external-gateway.js';

const TEST_SECRET = 'test-signing-secret-32chars-long!';

describe('ExternalAgentGateway store integration', () => {
  it('loadFromStore hydrates registrations and recreates missing agents', async () => {
    const gw = new ExternalAgentGateway({ signingSecret: TEST_SECRET });
    const saveRegistration = vi.fn(async () => {});
    gw.setStore({
      loadAll: vi.fn(async () => [{
        externalAgentId: 'ext_store_1',
        agentName: 'Stored Agent',
        orgId: 'org_store',
        markusAgentId: 'agt_old',
        capabilities: ['chat'],
        connected: true,
        registeredAt: new Date().toISOString(),
      }]),
      saveRegistration,
    } as never);
    gw.setAgentCreator(vi.fn(async () => ({ id: 'agt_recreated' })));

    const loaded = await gw.loadFromStore(() => false);
    expect(loaded).toBe(1);
    expect(gw.listRegistrations('org_store')).toHaveLength(1);
    expect(gw.setAgentCreator).toBeDefined();
    expect(saveRegistration).toHaveBeenCalled();
  });

  it('loadFromStore returns zero when no store configured', async () => {
    const gw = new ExternalAgentGateway({ signingSecret: TEST_SECRET });
    expect(await gw.loadFromStore()).toBe(0);
  });

  it('setOrgSecret validates per-org authentication', async () => {
    const gw = new ExternalAgentGateway({ signingSecret: TEST_SECRET });
    gw.setAgentCreator(vi.fn(async () => ({ id: 'agt_org' })));
    await gw.register({ externalAgentId: 'ext_org', agentName: 'Org Agent', orgId: 'org_x' });
    gw.setOrgSecret('org_x', 'org-specific-secret');

    const auth = gw.authenticate({
      externalAgentId: 'ext_org',
      orgId: 'org_x',
      secret: 'org-specific-secret',
    });
    expect(auth.token).toBeDefined();
    expect(gw.verifyToken(auth.token).externalAgentId).toBe('ext_org');
  });
});
