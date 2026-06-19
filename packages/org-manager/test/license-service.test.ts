import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LICENSE_PATH = join(homedir(), '.markus', 'license.json');
const HUB_TOKEN_PATH = join(homedir(), '.markus', 'hub-token');

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  };
});

function defaultLicenseJson() {
  return JSON.stringify({
    plan: 'free',
    features: [],
    limits: {
      maxAgents: -1,
      maxTokensPerMonth: -1,
      maxToolCallsPerDay: 5000,
      maxMessagesPerDay: -1,
      maxStorageBytes: -1,
    },
    instanceId: 'inst-123',
  });
}

function setupFsMocks() {
  mockExistsSync.mockImplementation((p: string) => p === LICENSE_PATH || p === HUB_TOKEN_PATH);
  mockReadFileSync.mockImplementation((p: string) => {
    if (p === LICENSE_PATH) return defaultLicenseJson();
    if (p === HUB_TOKEN_PATH) return 'hub-token-value';
    throw new Error(`ENOENT: ${p}`);
  });
}

describe('LicenseService', () => {
  let LicenseService: typeof import('../src/license-service.js').LicenseService;
  let service: InstanceType<typeof LicenseService>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
    setupFsMocks();

    ({ LicenseService } = await import('../src/license-service.js'));
    service = new LicenseService('https://hub.test');
    service.destroy();
    vi.clearAllTimers();
  });

  afterEach(() => {
    service.destroy();
    vi.unstubAllGlobals();
  });

  describe('defaults', () => {
    it('loads free plan by default', () => {
      expect(service.getPlan()).toBe('free');
      expect(service.getInstanceId()).toBe('inst-123');
      expect(service.canUse('sso')).toBe(false);
    });

    it('returns license info and limits', () => {
      const info = service.getInfo();
      expect(info.plan).toBe('free');
      expect(service.getLimits().maxToolCallsPerDay).toBe(5000);
    });
  });

  describe('activateLicense', () => {
    it('fails without hub token', async () => {
      mockExistsSync.mockImplementation((p: string) => p === LICENSE_PATH);
      const result = await service.activateLicense('key-abc');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Not authenticated/);
    });

    it('activates enterprise license via hub', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          plan: 'enterprise',
          validUntil: '2027-01-01T00:00:00.000Z',
          features: ['sso'],
        }),
      } as Response);

      const result = await service.activateLicense('ent-key');
      expect(result.success).toBe(true);
      expect(service.getPlan()).toBe('enterprise');
      expect(service.canUse('sso')).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('returns hub error on failed activation', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ success: false, error: 'Invalid key' }),
      } as Response);

      const result = await service.activateLicense('bad-key');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid key');
    });
  });

  describe('activateTrial', () => {
    it('activates trial license', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          licenseKey: 'trial-key',
          plan: 'enterprise',
          validUntil: '2026-07-01T00:00:00.000Z',
        }),
      } as Response);

      const result = await service.activateTrial();
      expect(result.success).toBe(true);
      expect(service.getInfo().isTrial).toBe(true);
      expect(service.getInfo().licenseKey).toBe('trial-key');
    });
  });

  describe('importOfflineLicense', () => {
    it('imports valid offline license file', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const payload = {
        version: 1,
        licenseId: 'offline-1',
        plan: 'enterprise',
        issuedTo: 'Acme',
        validFrom: new Date().toISOString(),
        validUntil: future,
        maxInstances: 1,
        features: ['audit_log'],
      };
      const result = service.importOfflineLicense(JSON.stringify(payload));
      expect(result.success).toBe(true);
      expect(service.getPlan()).toBe('enterprise');
      expect(service.getInfo().isOffline).toBe(true);
    });

    it('rejects expired offline license', () => {
      const payload = {
        version: 1,
        licenseId: 'offline-expired',
        plan: 'enterprise',
        issuedTo: 'Acme',
        validFrom: '2020-01-01T00:00:00.000Z',
        validUntil: '2020-02-01T00:00:00.000Z',
        maxInstances: 1,
        features: [],
      };
      const result = service.importOfflineLicense(JSON.stringify(payload));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/expired/);
    });
  });

  describe('deactivate and revalidate', () => {
    it('deactivates license and reverts to free', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, plan: 'enterprise', validUntil: '2027-01-01T00:00:00.000Z' }),
      } as Response);
      await service.activateLicense('ent-key');

      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
      await service.deactivate();
      expect(service.getPlan()).toBe('free');
      expect(service.getInfo().licenseKey).toBeUndefined();
    });

    it('revalidates via heartbeat when license key exists', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          plan: 'enterprise',
          validUntil: '2027-01-01T00:00:00.000Z',
        }),
      } as Response);
      await service.activateLicense('ent-key');

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ valid: true, plan: 'enterprise' }),
      } as Response);

      const info = await service.revalidate();
      expect(info.plan).toBe('enterprise');
    });

    it('reverts to free when heartbeat returns invalid', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, plan: 'enterprise', validUntil: '2027-01-01T00:00:00.000Z' }),
      } as Response);
      await service.activateLicense('ent-key');

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ valid: false }),
      } as Response);
      await service.revalidate();
      expect(service.getPlan()).toBe('free');
    });

    it('syncs license from hub when no local key', async () => {
      mockExistsSync.mockImplementation((p: string) => p === LICENSE_PATH || p === HUB_TOKEN_PATH);
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === LICENSE_PATH) {
          return JSON.stringify({
            plan: 'free', features: [], limits: { maxToolCallsPerDay: 5000 }, instanceId: 'inst-123',
          });
        }
        if (p === HUB_TOKEN_PATH) return 'hub-token-value';
        throw new Error('missing');
      });
      vi.resetModules();
      ({ LicenseService } = await import('../src/license-service.js'));
      const fresh = new LicenseService('https://hub.test');
      fresh.destroy();

      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            license: {
              licenseKey: 'hub-key',
              plan: 'enterprise',
              validUntil: '2027-01-01T00:00:00.000Z',
              isTrial: false,
              features: ['sso'],
            },
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ valid: true, plan: 'enterprise', validUntil: '2027-01-01T00:00:00.000Z' }),
        } as Response);

      const info = await fresh.revalidate();
      expect(info.plan).toBe('enterprise');
      fresh.destroy();
    });

    it('handles activation network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network'));
      const result = await service.activateLicense('key');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/connect/);
    });

    it('rejects invalid offline license format', () => {
      const result = service.importOfflineLicense(JSON.stringify({ version: 2, plan: 'free' }));
      expect(result.success).toBe(false);
    });

    it('exposes features, limits, and hub url setter', () => {
      expect(service.getFeatures()).toEqual([]);
      expect(service.getLimits().maxToolCallsPerDay).toBe(5000);
      service.setHubUrl('https://hub2.test');
      expect(service.getInfo().plan).toBe('free');
    });
  });
});
