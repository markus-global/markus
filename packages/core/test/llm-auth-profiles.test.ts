import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthProfile } from '@markus/shared';

const fileStore = new Map<string, string>();
const lockExists = { value: false };

const mockMkdirSync = vi.fn();
const mockExistsSync = vi.fn((p: string) => {
  if (p.endsWith('.auth-profiles.lock')) return lockExists.value;
  return fileStore.has(p);
});
const mockReadFileSync = vi.fn((p: string) => {
  if (!fileStore.has(p)) throw new Error('ENOENT');
  return fileStore.get(p)!;
});
const mockWriteFileSync = vi.fn((p: string, data: string, opts?: { flag?: string; mode?: number }) => {
  if (opts?.flag === 'wx' && lockExists.value) throw new Error('EEXIST');
  if (opts?.flag === 'wx') lockExists.value = true;
  fileStore.set(p, data);
});
const mockUnlinkSync = vi.fn((p: string) => {
  if (p.endsWith('.auth-profiles.lock')) lockExists.value = false;
  fileStore.delete(p);
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args as [string]),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args as [string]),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args as [string, string, { flag?: string; mode?: number }?]),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args as [string]),
  };
});

describe('AuthProfileStore', () => {
  beforeEach(() => {
    vi.resetModules();
    fileStore.clear();
    lockExists.value = false;
    mockMkdirSync.mockClear();
    mockWriteFileSync.mockClear();
  });

  async function loadStore(stateDir = '/tmp/markus-test-auth') {
    const { AuthProfileStore } = await import('../src/llm/auth-profiles.js');
    return new AuthProfileStore(stateDir);
  }

  function profilesPath(stateDir: string) {
    return `${stateDir}/auth-profiles.json`;
  }

  it('returns empty list when file does not exist', async () => {
    const store = await loadStore();
    expect(store.listProfiles()).toEqual([]);
  });

  it('upserts and retrieves a profile', async () => {
    const store = await loadStore('/tmp/markus-auth-1');
    const profile: AuthProfile = {
      id: 'openai-apikey-1',
      provider: 'openai',
      authType: 'api-key',
      label: 'OpenAI Key',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      apiKey: 'sk-test',
    };
    store.upsertProfile(profile);

    expect(store.getProfile('openai-apikey-1')).toMatchObject({
      id: 'openai-apikey-1',
      provider: 'openai',
      apiKey: 'sk-test',
    });
    expect(store.listProfiles('openai')).toHaveLength(1);
    expect(store.getDefaultProfile('openai')).toMatchObject({ id: 'openai-apikey-1' });
  });

  it('updates existing profile on upsert', async () => {
    const store = await loadStore('/tmp/markus-auth-2');
    store.upsertProfile({
      id: 'p1',
      provider: 'anthropic',
      authType: 'api-key',
      createdAt: 1000,
      updatedAt: 1000,
      apiKey: 'old-key',
    });
    store.upsertProfile({
      id: 'p1',
      provider: 'anthropic',
      authType: 'api-key',
      createdAt: 1000,
      updatedAt: 2000,
      apiKey: 'new-key',
    });

    expect(store.getProfile('p1')?.apiKey).toBe('new-key');
    expect(store.getProfile('p1')?.createdAt).toBe(1000);
  });

  it('deletes a profile', async () => {
    const store = await loadStore('/tmp/markus-auth-3');
    store.upsertProfile({
      id: 'del-me',
      provider: 'openai',
      authType: 'api-key',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(store.deleteProfile('del-me')).toBe(true);
    expect(store.getProfile('del-me')).toBeUndefined();
    expect(store.deleteProfile('missing')).toBe(false);
  });

  it('updates OAuth tokens for existing profile', async () => {
    const store = await loadStore('/tmp/markus-auth-4');
    store.createOAuthProfile('openai-codex', {
      accessToken: 'old',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3600_000,
      accountId: 'acct-1',
    });
    const profile = store.listProfiles('openai-codex')[0]!;
    store.updateOAuthTokens(profile.id, {
      accessToken: 'new-token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 7200_000,
      accountId: 'acct-1',
    });
    expect(store.getProfile(profile.id)?.oauth?.accessToken).toBe('new-token');
  });

  it('createApiKeyProfile creates and persists profile', async () => {
    const store = await loadStore('/tmp/markus-auth-5');
    const profile = store.createApiKeyProfile('deepseek', 'ds-key', 'My DeepSeek');
    expect(profile.authType).toBe('api-key');
    expect(profile.apiKey).toBe('ds-key');
    expect(profile.label).toBe('My DeepSeek');
    expect(store.listProfiles('deepseek')).toHaveLength(1);
  });

  it('listProfilesSafe strips sensitive fields', async () => {
    const store = await loadStore('/tmp/markus-auth-6');
    store.createApiKeyProfile('openai', 'secret-key');
    const safe = store.listProfilesSafe('openai')[0]!;
    expect(safe.hasApiKey).toBe(true);
    expect(safe).not.toHaveProperty('apiKey');
  });

  it('handles corrupt file gracefully', async () => {
    const dir = '/tmp/markus-auth-corrupt';
    fileStore.set(profilesPath(dir), '{not json');
    const store = await loadStore(dir);
    expect(store.listProfiles()).toEqual([]);
  });
});
