/**
 * Unit tests for the platform integration store — the manifest-driven read/write
 * path behind `/api/settings/integrations`.
 *
 * These are pure (no HTTP server); the endpoint behaviour is covered separately
 * in `platform-integrations-api.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getManifest } from '@markus/comms';
import {
  SECRET_MASK,
  buildPlatformStatus,
  deletePlatform,
  flattenStatus,
  getPlatformStatus,
  isKnownPlatform,
  knownPlatformIds,
  listPlatformStatuses,
  loadPlatformBindings,
  mergeSubmission,
  missingRequiredFields,
  readPlatformValues,
  savePlatform,
  type PlatformStoreDeps,
} from '../src/platform-integrations.js';

/** Minimal in-memory IntegrationRepo mirroring SqliteIntegrationRepo's shapes. */
function createRepo() {
  const store = new Map<string, Record<string, unknown>>();
  const row = (data: Record<string, unknown>) => ({
    id: data['id'] as string,
    orgId: data['orgId'] as string,
    platform: data['platform'] as string,
    displayName: data['displayName'] as string,
    enabled: !!(data['enabled'] as boolean),
    config: (data['config'] ?? {}) as Record<string, unknown>,
    forwardRules: (data['forwardRules'] ?? []) as Record<string, unknown>[],
    lastVerifiedAt: null,
    lastError: null,
    createdAt: '',
    updatedAt: '',
  });

  return {
    create: async (data: Record<string, unknown>) => {
      const r = row(data);
      store.set(r.id, r as unknown as Record<string, unknown>);
      return r;
    },
    findById: (id: string) => store.get(id) as never,
    listByOrg: (orgId: string) =>
      Array.from(store.values()).filter((r) => r['orgId'] === orgId) as never,
    listByPlatform: (orgId: string, platform: string) =>
      Array.from(store.values()).filter(
        (r) => r['orgId'] === orgId && r['platform'] === platform,
      ) as never,
    update: async (id: string, data: Record<string, unknown>) => {
      const existing = store.get(id);
      if (existing) store.set(id, { ...existing, ...data });
    },
    delete: async (id: string) => {
      store.delete(id);
    },
    /** test helper */
    get: (id: string) => store.get(id),
    size: () => store.size,
  };
}

const feishu = getManifest('feishu')!;
const telegram = getManifest('telegram')!;

function deps(repo?: ReturnType<typeof createRepo>, extra?: Partial<PlatformStoreDeps>): PlatformStoreDeps {
  return {
    orgId: 'default',
    repo: repo as unknown as PlatformStoreDeps['repo'],
    // The secretary is the org's default answering agent. The store resolves it
    // per org (role-based), never by a hard-coded id — so the test supplies one.
    defaultAgentId: () => 'agt_secretary',
    ...extra,
  };
}

describe('platform-integrations store', () => {
  let repo: ReturnType<typeof createRepo>;

  beforeEach(() => {
    repo = createRepo();
  });

  describe('registry projection', () => {
    it('knows only registered platforms', () => {
      expect(isKnownPlatform('feishu')).toBe(true);
      expect(isKnownPlatform('telegram')).toBe(true);
      expect(isKnownPlatform('notaplatform')).toBe(false);
      expect(knownPlatformIds()).toEqual(['feishu', 'telegram', 'slack', 'whatsapp', 'discord']);
    });

    it('lists a status for every registered platform', () => {
      const statuses = listPlatformStatuses(deps(repo));
      expect(statuses.map((s) => s.id)).toEqual(['feishu', 'telegram', 'slack', 'whatsapp', 'discord']);
    });

    it('returns undefined for an unknown platform', () => {
      expect(getPlatformStatus(deps(repo), 'nope')).toBeUndefined();
    });
  });

  describe('value resolution (DB → bootstrap → manifest default)', () => {
    it('falls back to manifest defaults when nothing is stored', () => {
      const values = readPlatformValues(deps(repo), feishu);
      expect(values['domain']).toBe('https://open.feishu.cn');
      expect(values['appId']).toBeUndefined();
    });

    it('uses the legacy bootstrap only when the DB has no value', () => {
      const withBootstrap = deps(repo, {
        bootstrap: () => ({ appId: 'cli_legacy', appSecret: 'legacy_secret' }),
      });
      expect(readPlatformValues(withBootstrap, feishu)['appId']).toBe('cli_legacy');
    });

    it('lets the database win over the bootstrap', async () => {
      await savePlatform(deps(repo), feishu, { appId: 'cli_db', appSecret: 'db_secret' });
      const withBootstrap = deps(repo, {
        bootstrap: () => ({ appId: 'cli_legacy', appSecret: 'legacy_secret' }),
      });
      const values = readPlatformValues(withBootstrap, feishu);
      expect(values['appId']).toBe('cli_db');
      expect(values['appSecret']).toBe('db_secret');
    });

    it('carries through non-manifest legacy config keys', async () => {
      await repo.create({
        id: 'feishu_default',
        orgId: 'default',
        platform: 'feishu',
        displayName: '飞书',
        enabled: true,
        config: { connectionMode: 'long_connection' },
      });
      const values = readPlatformValues(deps(repo), feishu);
      expect(values['connectionMode']).toBe('long_connection');
    });

    it('takes a legacy stored value for a manifest key over the manifest default', async () => {
      await repo.create({
        id: 'feishu_default',
        orgId: 'default',
        platform: 'feishu',
        displayName: '飞书',
        enabled: true,
        config: { notifyOnApproval: false },
      });
      // notifyOnApproval became a manifest field (default true); a value stored by
      // an older build still wins over that default.
      expect(readPlatformValues(deps(repo), feishu)['notifyOnApproval']).toBe(false);
    });
  });

  describe('notification preferences (manifest-driven multi-select)', () => {
    it('reads manifest defaults when nothing is stored', async () => {
      await savePlatform(deps(repo), feishu, { appId: 'cli_x', appSecret: 's' });
      const values = readPlatformValues(deps(repo), feishu);
      expect(values['notifyOnApproval']).toBe(true);
      expect(values['notifyOnNotification']).toBe(false);
      expect(values['notifyPriority']).toEqual(['high', 'urgent']);
    });

    it('coerces a comma-joined scalar to an array and drops options off the manifest', async () => {
      await savePlatform(deps(repo), feishu, {
        appId: 'cli_x',
        appSecret: 's',
        notifyPriority: 'urgent,bogus,high',
      });
      expect(buildPlatformStatus(deps(repo), feishu).values['notifyPriority']).toEqual(['urgent', 'high']);
    });

    it('keeps an array submission de-duplicated and in order', async () => {
      await savePlatform(deps(repo), feishu, {
        appId: 'cli_x',
        appSecret: 's',
        notifyPriority: ['high', 'high', 'urgent'],
      });
      expect(buildPlatformStatus(deps(repo), feishu).values['notifyPriority']).toEqual(['high', 'urgent']);
    });

    it('coerces submitted booleans for the notification toggles', async () => {
      await savePlatform(deps(repo), feishu, {
        appId: 'cli_x',
        appSecret: 's',
        notifyOnApproval: false,
        notifyOnNotification: true,
      });
      const values = readPlatformValues(deps(repo), feishu);
      expect(values['notifyOnApproval']).toBe(false);
      expect(values['notifyOnNotification']).toBe(true);
    });
  });

  describe('secret handling', () => {
    it('never exposes a stored secret in the status values', async () => {
      await savePlatform(deps(repo), feishu, { appId: 'cli_x', appSecret: 'super-secret' });
      const status = buildPlatformStatus(deps(repo), feishu);

      expect(status.values['appSecret']).toBeUndefined();
      expect(status.secrets['appSecret']).toEqual({ hasValue: true });
      expect(JSON.stringify(status)).not.toContain('super-secret');
    });

    it('reports secret presence as False when unset', () => {
      const status = buildPlatformStatus(deps(repo), feishu);
      expect(status.secrets['appSecret']).toEqual({ hasValue: false });
      expect(status.secrets['encryptKey']).toEqual({ hasValue: false });
    });

    it('masks secrets and flattens non-secret values', async () => {
      await savePlatform(deps(repo), feishu, {
        appId: 'cli_x',
        appSecret: 'super-secret',
        notifyChatId: 'oc_1',
      });
      const flat = flattenStatus(buildPlatformStatus(deps(repo), feishu));

      expect(flat['appSecret']).toBe(SECRET_MASK);
      expect(flat['appId']).toBe('cli_x');
      expect(flat['notifyChatId']).toBe('oc_1');
      expect(JSON.stringify(flat)).not.toContain('super-secret');
    });

    it('treats a masked/empty submission as "keep the stored secret"', () => {
      const merged = mergeSubmission(
        feishu,
        { appId: 'cli_new', appSecret: SECRET_MASK },
        { appId: 'cli_old', appSecret: 'stored-secret' },
      );
      expect(merged['appId']).toBe('cli_new');
      expect(merged['appSecret']).toBe('stored-secret');

      const mergedEmpty = mergeSubmission(feishu, { appSecret: '' }, { appSecret: 'stored-secret' });
      expect(mergedEmpty['appSecret']).toBe('stored-secret');
    });

    it('coerces values to the declared field type', () => {
      const merged = mergeSubmission(
        feishu,
        { wsMode: 'true', webhookPort: '9100', appId: 'cli_a' },
        {},
      );
      expect(merged['wsMode']).toBe(true);
      expect(merged['webhookPort']).toBe(9100);
    });
  });

  describe('required-field validation', () => {
    it('reports missing required fields for an empty submission', () => {
      // `agentId` joined the required set: a bot with no answering agent cannot
      // route, so it is a required field rather than an optional one.
      expect(missingRequiredFields(feishu, {}, {})).toEqual(['appId', 'appSecret', 'agentId']);
    });

    it('accepts a re-save that omits an already-stored secret', () => {
      expect(missingRequiredFields(feishu, { appId: 'cli_a' }, { appSecret: 'stored' })).toEqual([
        'agentId',
      ]);
    });

    it('flags a blank non-secret required field', () => {
      expect(missingRequiredFields(feishu, { appId: '   ', appSecret: 'x' }, {})).toEqual([
        'appId',
        'agentId',
      ]);
    });

    it('treats an already-stored value as satisfying a field that became required later', () => {
      // The upgrade path: installs created before `agentId` was required still
      // hold no value (or a bootstrap one). They must stay saveable.
      expect(
        missingRequiredFields(
          feishu,
          { appId: 'cli_a', appSecret: 's' },
          { agentId: 'agt_from_bootstrap' },
        ),
      ).toEqual([]);
    });
  });

  describe('persistence', () => {
    it('creates then updates a single row per platform', async () => {
      await savePlatform(deps(repo), feishu, { appId: 'cli_1', appSecret: 's1' });
      await savePlatform(deps(repo), feishu, { appId: 'cli_2' });

      expect(repo.size()).toBe(1);
      const status = getPlatformStatus(deps(repo), 'feishu')!;
      expect(status.values['appId']).toBe('cli_2');
      expect(status.secrets['appSecret']).toEqual({ hasValue: true }); // preserved
      expect(status.hasConfig).toBe(true);
    });

    it('persists enable/disable state', async () => {
      await savePlatform(deps(repo), feishu, { appId: 'a', appSecret: 'b' }, false);
      expect(getPlatformStatus(deps(repo), 'feishu')!.enabled).toBe(false);
    });

    it('deletes stored config', async () => {
      await savePlatform(deps(repo), feishu, { appId: 'a', appSecret: 'b' });
      await deletePlatform(deps(repo), 'feishu');
      const status = getPlatformStatus(deps(repo), 'feishu')!;
      expect(status.hasConfig).toBe(false);
      expect(status.secrets['appSecret']).toEqual({ hasValue: false });
    });

    it('throws when storage is unavailable', async () => {
      await expect(savePlatform(deps(undefined), feishu, {})).rejects.toThrow(/Storage not available/);
    });

    it('reports live connection state from the injected probe', () => {
      const status = buildPlatformStatus(deps(repo, { connected: (p) => p === 'feishu' }), telegram);
      expect(status.connected).toBe(false);
      expect(buildPlatformStatus(deps(repo, { connected: (p) => p === 'feishu' }), feishu).connected).toBe(true);
    });
  });
});

/**
 * Startup routing (issue #340, defect A). `loadPlatformBindings` is the single
 * place the router's bindings come from, so it must read exactly one value —
 * the manifest `agentId` — and honour the legacy bootstrap only as a default.
 */
describe('loadPlatformBindings', () => {
  let repo: ReturnType<typeof createRepo>;

  beforeEach(() => {
    repo = createRepo();
  });

  it('returns nothing when no platform has a bound agent', () => {
    expect(loadPlatformBindings(deps(repo))).toEqual([]);
  });

  it('reads agentId from the platform row', async () => {
    await savePlatform(deps(repo), feishu, { appId: 'cli_x', appSecret: 'sec', agentId: 'agt_1' });
    expect(loadPlatformBindings(deps(repo))).toEqual([{ platform: 'feishu', agentId: 'agt_1' }]);
  });

  it('ignores a blank agentId', async () => {
    await savePlatform(deps(repo), feishu, { appId: 'cli_x', appSecret: 'sec', agentId: '   ' });
    expect(loadPlatformBindings(deps(repo))).toEqual([]);
  });

  it('honours a legacy bootstrap binding when the database has none (upgrade compat)', () => {
    const legacy = deps(undefined, {
      bootstrap: (p) => (p === 'feishu' ? { appId: 'cli_x', appSecret: 'sec', agentId: 'legacy-agent' } : {}),
    });
    expect(loadPlatformBindings(legacy)).toEqual([{ platform: 'feishu', agentId: 'legacy-agent' }]);
  });

  it('lets the database win over the bootstrap binding', async () => {
    await savePlatform(deps(repo), feishu, { appId: 'cli_x', appSecret: 'sec', agentId: 'db-agent' });
    // The legacy bootstrap is per-platform (it reads one `integrations.<id>` block),
    // so the stub must be scoped to feishu too — otherwise it would fabricate a
    // binding for every inbound platform the registry declares.
    const withLegacy = deps(repo, {
      bootstrap: (p) => (p === 'feishu' ? { agentId: 'legacy-agent' } : {}),
    });
    expect(loadPlatformBindings(withLegacy)).toEqual([{ platform: 'feishu', agentId: 'db-agent' }]);
  });
});
