/**
 * Unit tests for the bot-instance integration store — the manifest-driven
 * read/write path behind `/api/settings/integrations/instances`.
 *
 * Pure (no HTTP server): fake in-memory repos stand in for the G1 SQLite repos,
 * and the endpoint behaviour is covered separately in `instance-routes.test.ts`.
 *
 * The rules under test are the ones where a naive implementation silently loses
 * data: a second bot of the same platform must not inherit the first one's
 * config or routes, a masked secret must never overwrite a stored one, and a
 * replace-all channel save must not touch rows it does not own.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { getManifest } from '@markus/comms';
import type { ChannelBindingRow, PlatformInstanceRow } from '@markus/storage';
import {
  SECRET_MASK,
  InstanceValidationError,
  createInstance,
  deleteInstance,
  getInstanceStatus,
  listInstanceStatuses,
  readInstanceValues,
  recordInstanceVerification,
  saveInstance,
  setInstanceChannels,
  type InstanceStoreDeps,
} from '../src/instance-integrations.js';

/** Minimal in-memory PlatformInstanceRepo mirroring the SQLite row shapes. */
function createInstanceRepo() {
  const store = new Map<string, PlatformInstanceRow>();
  const toRow = (data: Record<string, unknown>): PlatformInstanceRow => ({
    id: data['id'] as string,
    orgId: data['orgId'] as string,
    platform: data['platform'] as string,
    label: (data['label'] as string) ?? 'default',
    config: (data['config'] ?? {}) as Record<string, unknown>,
    capabilities: null,
    enabled: data['enabled'] !== false,
    lastVerifiedAt: null,
    lastError: (data['lastError'] as string) ?? null,
    createdAt: '',
    updatedAt: '',
  });
  return {
    create: async (data: Record<string, unknown>) => {
      const row = toRow(data);
      store.set(row.id, row);
      return row;
    },
    findById: (id: string) => store.get(id),
    listByOrg: (orgId: string) => [...store.values()].filter((r) => r.orgId === orgId),
    listByPlatform: (orgId: string, platform: string) =>
      [...store.values()].filter((r) => r.orgId === orgId && r.platform === platform),
    update: async (id: string, data: Record<string, unknown>) => {
      const existing = store.get(id);
      if (existing) store.set(id, { ...existing, ...data } as PlatformInstanceRow);
    },
    delete: async (id: string) => {
      store.delete(id);
    },
    /** test helper — inspect a raw row without going through the DTO */
    raw: (id: string) => store.get(id),
    all: () => [...store.values()],
  };
}

/** Minimal in-memory ChannelBindingRepo. */
function createBindingRepo() {
  const store = new Map<string, ChannelBindingRow>();
  let seq = 0;
  return {
    create: async (data: Record<string, unknown>) => {
      const id = (data['id'] as string) ?? `cb_mock_${++seq}`;
      const row: ChannelBindingRow = {
        id,
        orgId: data['orgId'] as string,
        scope: data['scope'] as ChannelBindingRow['scope'],
        instanceId: (data['instanceId'] as string | null) ?? null,
        nativeId: (data['nativeId'] as string | null) ?? null,
        kind: (data['kind'] as string | null) ?? null,
        agentId: data['agentId'] as string,
        createdAt: '',
      };
      store.set(id, row);
      return row;
    },
    findById: (id: string) => store.get(id),
    listByOrg: (orgId: string) => [...store.values()].filter((r) => r.orgId === orgId),
    listByScope: (orgId: string, scope: ChannelBindingRow['scope']) =>
      [...store.values()].filter((r) => r.orgId === orgId && r.scope === scope),
    delete: async (id: string) => {
      store.delete(id);
    },
    all: () => [...store.values()],
  };
}

const feishu = getManifest('feishu')!;

type Repos = {
  instances: ReturnType<typeof createInstanceRepo>;
  bindings: ReturnType<typeof createBindingRepo>;
};

function makeDeps(repos: Repos, extra: Partial<InstanceStoreDeps> = {}): InstanceStoreDeps {
  return {
    orgId: 'default',
    instances: repos.instances as unknown as InstanceStoreDeps['instances'],
    bindings: repos.bindings as unknown as InstanceStoreDeps['bindings'],
    // The secretary is the org's default answering agent. The store resolves it
    // per org (role-based) and never hard-codes an id — so the test supplies one,
    // exactly as `api-server` does in production.
    defaultAgentId: () => 'agt_secretary',
    ...extra,
  };
}

describe('bot-instance integration store', () => {
  let repos: Repos;
  let deps: InstanceStoreDeps;

  beforeEach(() => {
    repos = { instances: createInstanceRepo(), bindings: createBindingRepo() };
    deps = makeDeps(repos);
  });

  describe('createInstance', () => {
    it('uses G1\'s stable id scheme (bi_<platform>_<sha1-12>)', async () => {
      const status = await createInstance(deps, { platform: 'feishu', label: 'sales' });
      // Independently recomputed from the documented scheme, so the shape and
      // the tuple order are pinned rather than merely self-consistent.
      const expectedHash = createHash('sha1')
        .update(['feishu', 'default', 'sales'].join('\u0000'))
        .digest('hex')
        .slice(0, 12);
      expect(status.id).toBe(`bi_feishu_${expectedHash}`);
      expect(status.id).toMatch(/^bi_feishu_[0-9a-f]{12}$/);
    });

    it('rejects a duplicate (org, platform, label) with "already exists"', async () => {
      await createInstance(deps, { platform: 'feishu', label: 'sales' });
      await expect(createInstance(deps, { platform: 'feishu', label: 'sales' })).rejects.toThrow(
        /already exists/,
      );
      expect(repos.instances.all()).toHaveLength(1);
    });

    it('allows the same label on a different platform', async () => {
      await createInstance(deps, { platform: 'feishu', label: 'sales' });
      await expect(createInstance(deps, { platform: 'telegram', label: 'sales' })).resolves.toBeTruthy();
    });

    it('rejects a platform with no manifest', async () => {
      await expect(createInstance(deps, { platform: 'nope', label: 'x' })).rejects.toThrow(/Unknown platform/);
    });

    it('rejects a blank label', async () => {
      await expect(createInstance(deps, { platform: 'feishu', label: '   ' })).rejects.toThrow(/required/);
    });

    it('starts with the manifest secret set, no credentials, and the default agent read through', async () => {
      const status = await createInstance(deps, { platform: 'feishu', label: 'sales' });
      expect(status.secrets['appSecret']).toEqual({ hasValue: false });
      expect(status.values['appId']).toBeUndefined();
      expect(status.values['domain']).toBe('https://open.feishu.cn');
      // `agentId` is required, so a fresh bot answers through the org secretary
      // rather than being born unsatisfiable — but the default is *read through*,
      // not stored. Nothing is persisted, so `hasConfig` stays false: the page
      // uses it as "credentials configured" (offering Disconnect / hiding the
      // Feishu scan-to-register panel), and a routing default must not flip it.
      expect(status.agentId).toBe('agt_secretary');
      expect(status.hasConfig).toBe(false);
    });
  });

  describe('two instances of one platform stay independent', () => {
    it('keeps separate config and separate channels', async () => {
      const a = await createInstance(deps, { platform: 'feishu', label: 'a' });
      const b = await createInstance(deps, { platform: 'feishu', label: 'b' });

      await saveInstance(deps, a.id, { appId: 'cli_a', appSecret: 'secret_a' });
      await saveInstance(deps, b.id, { appId: 'cli_b', appSecret: 'secret_b' });

      const afterA = getInstanceStatus(deps, a.id)!;
      const afterB = getInstanceStatus(deps, b.id)!;
      expect(afterA.values['appId']).toBe('cli_a');
      expect(afterB.values['appId']).toBe('cli_b');
      expect(afterA.label).toBe('a');
      expect(afterB.label).toBe('b');

      await setInstanceChannels(deps, a.id, [{ nativeId: 'oc_a', kind: 'group', agentId: 'agt_1' }]);
      await setInstanceChannels(deps, b.id, [{ nativeId: 'oc_b', kind: 'group', agentId: 'agt_2' }]);

      expect(getInstanceStatus(deps, a.id)!.channels).toEqual([
        { nativeId: 'oc_a', kind: 'group', agentId: 'agt_1' },
      ]);
      expect(getInstanceStatus(deps, b.id)!.channels).toEqual([
        { nativeId: 'oc_b', kind: 'group', agentId: 'agt_2' },
      ]);
    });

    it('lists every instance for the org', async () => {
      await createInstance(deps, { platform: 'feishu', label: 'a' });
      await createInstance(deps, { platform: 'telegram', label: 'b' });
      expect(listInstanceStatuses(deps).map((s) => `${s.platform}:${s.label}`)).toEqual([
        'feishu:a',
        'telegram:b',
      ]);
    });
  });

  describe('secret handling', () => {
    it('never exposes the value, only presence', async () => {
      const { id } = await createInstance(deps, { platform: 'feishu', label: 'a' });
      await saveInstance(deps, id, { appId: 'cli_a', appSecret: 'CANARY_SECRET' });

      const status = getInstanceStatus(deps, id)!;
      expect(status.secrets['appSecret']).toEqual({ hasValue: true });
      expect('appSecret' in status.values).toBe(false);
      // `fields` is the only thing that mentions the key on purpose.
      expect(JSON.stringify({ ...status, fields: [] })).not.toContain('CANARY_SECRET');
    });

    it('keeps the stored value when the secret is submitted empty', async () => {
      const { id } = await createInstance(deps, { platform: 'feishu', label: 'a' });
      await saveInstance(deps, id, { appId: 'cli_a', appSecret: 'stored_secret' });
      await saveInstance(deps, id, { appId: 'cli_a', appSecret: '' });

      const raw = repos.instances.raw(id)!;
      expect(raw.config['appSecret']).toBe('stored_secret');
    });

    it('keeps the stored value when the secret is submitted masked', async () => {
      const { id } = await createInstance(deps, { platform: 'feishu', label: 'a' });
      await saveInstance(deps, id, { appId: 'cli_a', appSecret: 'stored_secret' });
      await saveInstance(deps, id, { appId: 'cli_a', appSecret: SECRET_MASK, notifyChatId: 'oc_new' });

      const raw = repos.instances.raw(id)!;
      expect(raw.config['appSecret']).toBe('stored_secret');
      expect(raw.config['notifyChatId']).toBe('oc_new');
    });

    it('lets a new secret value overwrite the stored one', async () => {
      const { id } = await createInstance(deps, { platform: 'feishu', label: 'a' });
      await saveInstance(deps, id, { appId: 'cli_a', appSecret: 'old' });
      await saveInstance(deps, id, { appId: 'cli_a', appSecret: 'new' });
      expect(repos.instances.raw(id)!.config['appSecret']).toBe('new');
    });
  });

  describe('required-field validation', () => {
    it('names the missing required fields', async () => {
      const { id } = await createInstance(deps, { platform: 'feishu', label: 'a' });
      await expect(saveInstance(deps, id, { appId: 'cli_a' })).rejects.toBeInstanceOf(
        InstanceValidationError,
      );
      try {
        await saveInstance(deps, id, { appId: 'cli_a' });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as InstanceValidationError).missing).toEqual(['appSecret']);
      }
    });

    it('accepts a stored secret, so re-saving a masked form does not fail', async () => {
      const { id } = await createInstance(deps, { platform: 'feishu', label: 'a' });
      await saveInstance(deps, id, { appId: 'cli_a', appSecret: 'stored' });
      // No new secret in the submission; only the mask round-trips.
      await expect(
        saveInstance(deps, id, { appId: 'cli_a', appSecret: SECRET_MASK, agentId: 'agt_1' }),
      ).resolves.toBeTruthy();
      expect(getInstanceStatus(deps, id)!.secrets['appSecret']).toEqual({ hasValue: true });
    });

    it('satisfies a required secret from the legacy bootstrap', async () => {
      const bootDeps = makeDeps(repos, { bootstrap: () => ({ appId: 'cli_legacy', appSecret: 'legacy' }) });
      const { id } = await createInstance(bootDeps, { platform: 'feishu', label: 'a' });
      // appSecret is absent from the submission but present via the bootstrap.
      await expect(saveInstance(bootDeps, id, { appId: 'cli_a' })).resolves.toBeTruthy();
      expect(getInstanceStatus(bootDeps, id)!.secrets['appSecret']).toEqual({ hasValue: true });
    });
  });

  describe('config surface', () => {
    it('preserves non-manifest config keys across a save', async () => {
      const { id } = await createInstance(deps, { platform: 'feishu', label: 'a' });
      await repos.instances.update(id, {
        config: { appId: 'cli_a', appSecret: 's', legacyPref: { keep: true }, locale: 'en' },
      });

      await saveInstance(deps, id, { appId: 'cli_b' });

      const raw = repos.instances.raw(id)!;
      expect(raw.config['legacyPref']).toEqual({ keep: true });
      expect(raw.config['locale']).toBe('en');
      expect(raw.config['appId']).toBe('cli_b');
    });

    it('round-trips agentId and notifyAgentId, and "" clears notifyAgentId', async () => {
      const { id } = await createInstance(deps, { platform: 'feishu', label: 'a' });
      const saved = await saveInstance(deps, id, {
        appId: 'cli_a',
        appSecret: 's',
        agentId: 'agt_answer',
        notifyAgentId: 'agt_notify',
      });
      expect(saved.agentId).toBe('agt_answer');
      expect(saved.notifyAgentId).toBe('agt_notify');

      const cleared = await saveInstance(deps, id, { appId: 'cli_a', notifyAgentId: '' });
      expect(cleared.notifyAgentId).toBeNull();
      expect(cleared.agentId).toBe('agt_answer'); // untouched
      expect(getInstanceStatus(deps, id)!.secrets['appSecret']).toEqual({ hasValue: true });

      const moved = await saveInstance(deps, id, { appId: 'cli_a', agentId: 'agt_other' });
      expect(moved.agentId).toBe('agt_other');
    });

    it('prefers the row over the bootstrap and the manifest default', async () => {
      const bootDeps = makeDeps(repos, {
        bootstrap: () => ({ appId: 'cli_legacy', domain: 'https://legacy.example' }),
      });
      const { id } = await createInstance(bootDeps, { platform: 'feishu', label: 'a' });
      const instance = repos.instances.raw(id)!;

      // Nothing stored: bootstrap wins over the manifest default.
      expect(readInstanceValues(bootDeps, feishu, instance)['domain']).toBe('https://legacy.example');
      expect(readInstanceValues(bootDeps, feishu, instance)['appId']).toBe('cli_legacy');
      // A manifest default is a form starting value, so it is only resolved when
      // defaults are asked for.
      //
      // The value itself is `true` because G6 made Feishu's long connection the
      // default receiver (no public URL needed — a desktop install has none),
      // matching the manifest's own `capabilities.extra.wsMode` and
      // `defaultInboundMode: 'socket'`. This test shipped pinning the pre-G6
      // default (`false`); the cross-slice merge is where the two disagreed, so
      // it is reconciled here rather than silently loosened.
      expect(readInstanceValues(bootDeps, feishu, instance, { withDefaults: false })['wsMode']).toBeUndefined();
      expect(readInstanceValues(bootDeps, feishu, instance)['wsMode']).toBe(true);

      await saveInstance(bootDeps, id, { appId: 'cli_db', appSecret: 's' });
      const stored = repos.instances.raw(id)!;
      expect(readInstanceValues(bootDeps, feishu, stored)['appId']).toBe('cli_db');
      // A save writes the values it resolved — defaults included — exactly as
      // `savePlatform` does, so the two surfaces agree on what a save persists.
      expect(stored.config['wsMode']).toBe(true);
    });
  });

  describe('setInstanceChannels', () => {
    it('replaces only this instance\'s channel rows', async () => {
      const a = await createInstance(deps, { platform: 'feishu', label: 'a' });
      const b = await createInstance(deps, { platform: 'feishu', label: 'b' });

      // Rows this function must NOT touch: another instance's channel route, the
      // platform-level default answerer, and the org notification default.
      await repos.bindings.create({
        id: 'cb_other', orgId: 'default', scope: 'channel', instanceId: b.id,
        nativeId: 'oc_b', kind: 'group', agentId: 'agt_b',
      });
      await repos.bindings.create({
        id: 'cb_inst', orgId: 'default', scope: 'instance', instanceId: a.id,
        nativeId: null, kind: null, agentId: 'agt_inst',
      });
      await repos.bindings.create({
        id: 'cb_global', orgId: 'default', scope: 'global', instanceId: null,
        nativeId: null, kind: null, agentId: 'agt_global',
      });

      await setInstanceChannels(deps, a.id, [
        { nativeId: 'oc_1', kind: 'group', agentId: 'agt_1' },
        { nativeId: 'oc_2', kind: 'group', agentId: 'agt_2' },
      ]);
      // Same instance, second save replaces the first set entirely.
      const after = await setInstanceChannels(deps, a.id, [
        { nativeId: 'oc_3', kind: null, agentId: 'agt_3' },
      ]);

      expect(after.channels).toEqual([{ nativeId: 'oc_3', kind: null, agentId: 'agt_3' }]);
      // Exactly one channel row survived for instance A — the one just written.
      expect(
        repos.bindings.all().filter((r) => r['scope'] === 'channel' && r['instanceId'] === a.id),
      ).toHaveLength(1);
      // …and the three rows it does not own are still there.
      const ids = repos.bindings.all().map((r) => r.id);
      for (const untouched of ['cb_global', 'cb_inst', 'cb_other']) expect(ids).toContain(untouched);
      expect(repos.bindings.all()).toHaveLength(4);
      expect(getInstanceStatus(deps, b.id)!.channels).toEqual([
        { nativeId: 'oc_b', kind: 'group', agentId: 'agt_b' },
      ]);
    });

    it('collapses duplicate native ids instead of aborting on the unique key', async () => {
      const a = await createInstance(deps, { platform: 'feishu', label: 'a' });
      const status = await setInstanceChannels(deps, a.id, [
        { nativeId: 'oc_1', agentId: 'agt_1' },
        { nativeId: 'oc_1', agentId: 'agt_2' },
      ]);
      expect(status.channels).toEqual([{ nativeId: 'oc_1', kind: null, agentId: 'agt_2' }]);
    });

    it('rejects an unknown instance', async () => {
      await expect(setInstanceChannels(deps, 'bi_feishu_dead', [])).rejects.toThrow(/not found/);
    });
  });

  describe('deleteInstance', () => {
    it('removes the row and every binding that pointed at it', async () => {
      const a = await createInstance(deps, { platform: 'feishu', label: 'a' });
      const b = await createInstance(deps, { platform: 'feishu', label: 'b' });
      await setInstanceChannels(deps, a.id, [{ nativeId: 'oc_1', agentId: 'agt_1' }]);
      await repos.bindings.create({
        id: 'cb_inst', orgId: 'default', scope: 'instance', instanceId: a.id,
        nativeId: null, kind: null, agentId: 'agt_inst',
      });
      await repos.bindings.create({
        id: 'cb_global', orgId: 'default', scope: 'global', instanceId: null,
        nativeId: null, kind: null, agentId: 'agt_global',
      });

      await expect(deleteInstance(deps, a.id)).resolves.toBe(true);
      expect(getInstanceStatus(deps, a.id)).toBeUndefined();
      expect(repos.bindings.all().map((r) => r.id)).toEqual(['cb_global']);
      expect(getInstanceStatus(deps, b.id)).toBeDefined();
    });

    it('returns false for an unknown instance', async () => {
      await expect(deleteInstance(deps, 'bi_feishu_dead')).resolves.toBe(false);
    });
  });

  describe('org isolation', () => {
    it('never resolves another org\'s instance', async () => {
      const { id } = await createInstance(deps, { platform: 'feishu', label: 'a' });
      const otherOrg = makeDeps(repos, { orgId: 'other' });
      expect(getInstanceStatus(otherOrg, id)).toBeUndefined();
      expect(listInstanceStatuses(otherOrg)).toEqual([]);
      await expect(setInstanceChannels(otherOrg, id, [])).rejects.toThrow(/not found/);
      await expect(deleteInstance(otherOrg, id)).resolves.toBe(false);
      await expect(saveInstance(otherOrg, id, {})).rejects.toThrow(/not found/);
    });
  });

  describe('no storage', () => {
    it('reports empty reads and refuses writes', async () => {
      const bare: InstanceStoreDeps = { orgId: 'default' };
      expect(listInstanceStatuses(bare)).toEqual([]);
      expect(getInstanceStatus(bare, 'x')).toBeUndefined();
      await expect(createInstance(bare, { platform: 'feishu', label: 'a' })).rejects.toThrow(
        /Storage not available/,
      );
      await expect(saveInstance(bare, 'x', {})).rejects.toThrow(/Storage not available/);
      await expect(setInstanceChannels(bare, 'x', [])).rejects.toThrow(/Storage not available/);
      await expect(deleteInstance(bare, 'x')).resolves.toBe(false);
    });
  });

  describe('connected probe', () => {
    it('is answered per instance id', async () => {
      const a = await createInstance(deps, { platform: 'feishu', label: 'a' });
      const b = await createInstance(deps, { platform: 'feishu', label: 'b' });
      const probed = makeDeps(repos, { connected: (instanceId) => instanceId === a.id });
      const statuses = listInstanceStatuses(probed);
      expect(statuses.find((s) => s.id === a.id)!.connected).toBe(true);
      expect(statuses.find((s) => s.id === b.id)!.connected).toBe(false);
    });
  });

  describe('default agent (the secretary)', () => {
    it('reads a new instance through the org secretary, and materialises the binding on first save', async () => {
      const status = await createInstance(deps, { platform: 'feishu', label: 'sales' });
      // Read through: the DTO answers "who would reply" for a bot the org has
      // stored nothing for yet…
      expect(status.agentId).toBe('agt_secretary');
      expect(getInstanceStatus(deps, status.id)!.agentId).toBe('agt_secretary');
      // …without persisting it. A routing default must not make the row look
      // configured, so `hasConfig` (the page's "credentials configured" proxy)
      // stays false and the stored config is empty.
      expect(status.hasConfig).toBe(false);
      expect(repos.instances.raw(status.id)!.config).toEqual({});

      // The first real save materialises the binding (its merge base is the
      // read-through view), so a later reader sees a stored value.
      await saveInstance(deps, status.id, { appId: 'cli_a', appSecret: 's' });
      expect(repos.instances.raw(status.id)!.config['agentId']).toBe('agt_secretary');
      expect(getInstanceStatus(deps, status.id)!.hasConfig).toBe(true);
    });

    it('is a default, not an override: an explicit binding always wins', async () => {
      const { id } = await createInstance(deps, { platform: 'feishu', label: 'a' });
      const moved = await saveInstance(deps, id, {
        appId: 'cli_a',
        appSecret: 's',
        agentId: 'agt_other',
      });
      expect(moved.agentId).toBe('agt_other');

      // A later save that says nothing about the agent keeps the binding (a
      // stored value satisfies the now-required field).
      const kept = await saveInstance(deps, id, { appId: 'cli_a' });
      expect(kept.agentId).toBe('agt_other');
    });

    it('heals an instance created before `agentId` was required', async () => {
      // Written straight to the repo: no agent, exactly like an install that
      // predates the required field.
      await repos.instances.create({
        id: 'bi_feishu_legacy',
        orgId: 'default',
        platform: 'feishu',
        label: 'legacy',
        config: {},
        enabled: true,
      });

      // It reads through the default, so the required field is satisfiable…
      expect(getInstanceStatus(deps, 'bi_feishu_legacy')!.agentId).toBe('agt_secretary');
      // …and the first save materialises the binding instead of being rejected.
      await expect(
        saveInstance(deps, 'bi_feishu_legacy', { appId: 'cli_a', appSecret: 's' }),
      ).resolves.toBeTruthy();
      expect(repos.instances.raw('bi_feishu_legacy')!.config['agentId']).toBe('agt_secretary');
    });

    it('still rejects an agent-less save when the org has no secretary', async () => {
      // No resolver → no default. The required field then genuinely blocks the
      // save, which is the honest outcome rather than silently binding to a
      // stranger's agent id.
      const noDefault = makeDeps(repos, { defaultAgentId: () => null });
      const { id } = await createInstance(noDefault, { platform: 'feishu', label: 'a' });
      await expect(saveInstance(noDefault, id, { appId: 'cli_a' })).rejects.toThrow(/agentId/);
    });
  });

  describe('recordInstanceVerification', () => {
    let deps: InstanceStoreDeps;

    beforeEach(() => {
      deps = makeDeps(repos);
    });

    it('persists the instant a handshake passed, so it survives a reload', async () => {
      const { id } = await createInstance(deps, { platform: 'feishu', label: 'a' });
      // A bot that has never been verified says so, rather than claiming a
      // verification the org never ran.
      expect(getInstanceStatus(deps, id)!.lastVerifiedAt).toBeNull();

      const at = '2026-02-03T04:05:06.000Z';
      await recordInstanceVerification(deps, id, at);

      // Written to the row…
      expect(repos.instances.raw(id)!.lastVerifiedAt).toBe(at);
      // …and read back out through the DTO the Settings API serves.
      expect(getInstanceStatus(deps, id)!.lastVerifiedAt).toBe(at);
      expect(deps.instances && (await deps.instances.findById(id))!.lastVerifiedAt).toBe(at);
    });

    it('leaves every other field of the instance untouched', async () => {
      const { id } = await createInstance(deps, { platform: 'feishu', label: 'sales' });
      await saveInstance(deps, id, { appId: 'cli_a', appSecret: 's' });
      const before = repos.instances.raw(id)!;

      await recordInstanceVerification(deps, id, '2026-02-03T04:05:06.000Z');

      const after = repos.instances.raw(id)!;
      expect(after.config).toEqual(before.config);
      expect(after.label).toBe(before.label);
      expect(after.enabled).toBe(before.enabled);
      expect(after.lastVerifiedAt).not.toBe(before.lastVerifiedAt);
    });

    it('is a no-op when storage is unavailable rather than throwing', async () => {
      // The startup path calls this from the comms gateway; a missing repo must
      // degrade to "no record kept", never to a crash mid-verification.
      const noStore = { orgId: 'default' } as unknown as InstanceStoreDeps;
      await expect(
        recordInstanceVerification(noStore, 'bi_x', '2026-02-03T04:05:06.000Z'),
      ).resolves.toBeUndefined();
    });
  });
});
