/**
 * `readStoredPlatformConfig` — the bridge that makes a platform configured in
 * the Settings UI (which writes the `integrations` table) connect on the next
 * start. Slice S5, issue #340.
 *
 * The contract this file pins:
 *   • values come from the database, and manifest `field.default` is NOT applied
 *     (a form default must never switch a platform on by itself);
 *   • the row's `enabled` flag rides along so a disabled platform stays off;
 *   • "no row" is distinguishable from "row with an empty config".
 */
import { describe, it, expect } from 'vitest';
import { getManifest } from '@markus/comms';
import { readStoredPlatformConfig, savePlatform, type PlatformStoreDeps } from '../src/platform-integrations.js';

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
    listByPlatform: (orgId: string, platform: string) =>
      Array.from(store.values()).filter((r) => r['orgId'] === orgId && r['platform'] === platform) as never,
    update: async (id: string, data: Record<string, unknown>) => {
      const existing = store.get(id);
      if (existing) store.set(id, { ...existing, ...data });
    },
    size: () => store.size,
  };
}

const telegram = getManifest('telegram')!;

describe('readStoredPlatformConfig', () => {
  it('reports "no row" as undefined enabled with empty values', () => {
    const deps: PlatformStoreDeps = { orgId: 'default', repo: createRepo() as never };
    const stored = readStoredPlatformConfig(deps, telegram);
    expect(stored.enabled).toBeUndefined();
    expect(stored.values).toEqual({});
  });

  it('reads credentials saved through the Settings API', async () => {
    const repo = createRepo();
    const deps: PlatformStoreDeps = { orgId: 'default', repo: repo as never };
    await savePlatform(deps, telegram, { botToken: 'tok-1' }, true);

    const stored = readStoredPlatformConfig(deps, telegram);
    expect(stored.enabled).toBe(true);
    expect(stored.values['botToken']).toBe('tok-1');
  });

  it('does not inject manifest defaults into the startup config', async () => {
    const repo = createRepo();
    await repo.create({
      id: 'telegram_default',
      orgId: 'default',
      platform: 'telegram',
      displayName: 'Telegram',
      enabled: true,
      config: { botToken: 'tok-1' },
    });
    const deps: PlatformStoreDeps = { orgId: 'default', repo: repo as never };

    const stored = readStoredPlatformConfig(deps, telegram);
    expect(stored.values['botToken']).toBe('tok-1');
    // `webhookPath` has a manifest default ('/webhook/telegram'); a form default
    // must not leak into the startup config.
    expect(stored.values).not.toHaveProperty('webhookPath');
  });

  it('carries the disabled flag so a switched-off platform stays off', async () => {
    const repo = createRepo();
    const deps: PlatformStoreDeps = { orgId: 'default', repo: repo as never };
    await savePlatform(deps, telegram, { botToken: 'tok-1' }, false);

    const stored = readStoredPlatformConfig(deps, telegram);
    expect(stored.enabled).toBe(false);
    expect(stored.values['botToken']).toBe('tok-1');
  });

  it('is scoped per org', async () => {
    const repo = createRepo();
    const mine: PlatformStoreDeps = { orgId: 'org-a', repo: repo as never };
    await savePlatform(mine, telegram, { botToken: 'tok-a' }, true);

    const other: PlatformStoreDeps = { orgId: 'org-b', repo: repo as never };
    expect(readStoredPlatformConfig(other, telegram).enabled).toBeUndefined();
    expect(readStoredPlatformConfig(other, telegram).values).toEqual({});
  });
});
