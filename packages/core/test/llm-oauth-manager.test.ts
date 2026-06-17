import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthProfile, OAuthTokens } from '@markus/shared';
import type { AuthProfileStore } from '../src/llm/auth-profiles.js';

vi.mock('../src/llm/proxy-fetch.js', () => ({
  proxyFetch: vi.fn(),
}));

import { proxyFetch } from '../src/llm/proxy-fetch.js';
import { OAuthManager } from '../src/llm/oauth-manager.js';

function makeJwtPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function createMockStore(): AuthProfileStore {
  const profiles = new Map<string, AuthProfile>();
  return {
    listProfiles: vi.fn(() => [...profiles.values()]),
    getProfile: vi.fn((id: string) => profiles.get(id)),
    upsertProfile: vi.fn((p: AuthProfile) => { profiles.set(p.id, p); }),
    createOAuthProfile: vi.fn((provider: string, tokens: OAuthTokens, label?: string) => {
      const profile: AuthProfile = {
        id: `${provider}-oauth-1`,
        provider,
        authType: 'oauth',
        label: label ?? `${provider} OAuth`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        oauth: tokens,
      };
      profiles.set(profile.id, profile);
      return profile;
    }),
    updateOAuthTokens: vi.fn((id: string, tokens: OAuthTokens) => {
      const existing = profiles.get(id);
      if (existing) profiles.set(id, { ...existing, oauth: tokens, updatedAt: Date.now() });
    }),
  } as unknown as AuthProfileStore;
}

describe('OAuthManager', () => {
  let store: AuthProfileStore;
  let manager: OAuthManager;

  beforeEach(() => {
    vi.mocked(proxyFetch).mockReset();
    store = createMockStore();
    manager = new OAuthManager(store);
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  it('lists supported providers and custom registrations', () => {
    expect(manager.getSupportedProviders()).toContain('openai-codex');
    manager.registerProvider('custom', {
      authorizeUrl: 'https://auth.example/authorize',
      tokenUrl: 'https://auth.example/token',
      clientId: 'client-id',
    });
    expect(manager.getSupportedProviders()).toContain('custom');
    expect(manager.getProviderConfig('custom')?.clientId).toBe('client-id');
  });

  it('startLogin returns authorize URL with PKCE params', async () => {
    const { authorizeUrl, promise } = await manager.startLogin('openai-codex');
    expect(authorizeUrl).toContain('auth.openai.com/oauth/authorize');
    expect(authorizeUrl).toContain('code_challenge=');
    expect(authorizeUrl).toContain('state=');
    expect(manager.hasPendingLogin('openai-codex')).toBe(true);

    manager.cancelPendingLogin('openai-codex');
    await expect(promise).rejects.toThrow('Login cancelled');
  });

  it('rejects unknown provider on startLogin', async () => {
    await expect(manager.startLogin('unknown-provider')).rejects.toThrow('Unknown OAuth provider');
  });

  it('handleManualCallback exchanges code and creates profile', async () => {
    const { authorizeUrl } = await manager.startLogin('openai-codex');
    const state = new URL(authorizeUrl).searchParams.get('state')!;

    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: makeJwtPayload({ sub: 'user-1', chatgpt_account_id: 'acct-99' }),
        refresh_token: 'refresh-1',
        expires_in: 3600,
      }),
    } as Response);

    const profile = await manager.handleManualCallback(
      `http://localhost:1455/auth/callback?code=auth-code&state=${state}`,
    );
    expect(profile.provider).toBe('openai-codex');
    expect(store.createOAuthProfile).toHaveBeenCalled();
    expect(manager.hasPendingLogin()).toBe(false);
  });

  it('handleManualCallback rejects missing state and oauth errors', async () => {
    await expect(manager.handleManualCallback('http://localhost:1455/auth/callback?code=x&state=bad'))
      .rejects.toThrow('No pending login');

    await expect(manager.handleManualCallback('http://localhost:1455/auth/callback?error=access_denied'))
      .rejects.toThrow('OAuth error');
  });

  it('refreshToken updates stored tokens', async () => {
    const profile: AuthProfile = {
      id: 'openai-codex-oauth-1',
      provider: 'openai-codex',
      authType: 'oauth',
      label: 'Codex',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      oauth: {
        accessToken: makeJwtPayload({ sub: 'old' }),
        refreshToken: 'refresh-old',
        expiresAt: Date.now() - 1000,
      },
    };
    vi.mocked(store.getProfile).mockReturnValue(profile);

    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: makeJwtPayload({ sub: 'new-user', chatgpt_account_id: 'acct-new' }),
        refresh_token: 'refresh-new',
        expires_in: 7200,
      }),
    } as Response);

    const token = await manager.refreshToken(profile.id);
    expect(token.startsWith('eyJ')).toBe(true);
    expect(store.updateOAuthTokens).toHaveBeenCalled();
  });

  it('refreshToken returns cached token when still fresh', async () => {
    const profile: AuthProfile = {
      id: 'fresh-profile',
      provider: 'openai-codex',
      authType: 'oauth',
      label: 'Fresh',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      oauth: {
        accessToken: 'fresh-access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 60 * 60_000,
      },
    };
    vi.mocked(store.getProfile).mockReturnValue(profile);

    const token = await manager.refreshToken('fresh-profile');
    expect(token).toBe('fresh-access');
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('refreshToken recovers from refresh_token_reused with fresher stored token', async () => {
    const profile: AuthProfile = {
      id: 'reused-profile',
      provider: 'openai-codex',
      authType: 'oauth',
      label: 'Reused',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'refresh',
        expiresAt: Date.now() - 1000,
      },
    };
    vi.mocked(store.getProfile)
      .mockReturnValueOnce(profile)
      .mockReturnValueOnce({
        ...profile,
        oauth: { ...profile.oauth!, accessToken: 'fresher-access', expiresAt: Date.now() + 3600_000 },
      });

    vi.mocked(proxyFetch).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'refresh_token_reused',
    } as Response);

    const token = await manager.refreshToken('reused-profile');
    expect(token).toBe('fresher-access');
  });

  it('getValidToken returns api-key and setup-token profiles directly', async () => {
    vi.mocked(store.getProfile).mockImplementation((id: string) => {
      if (id === 'api-key-profile') {
        return {
          id, provider: 'openai', authType: 'api-key', label: 'Key', createdAt: 0, updatedAt: 0, apiKey: 'sk-test',
        };
      }
      if (id === 'setup-profile') {
        return {
          id, provider: 'anthropic', authType: 'setup-token', label: 'Setup', createdAt: 0, updatedAt: 0, setupToken: 'setup-token',
        };
      }
      return undefined;
    });

    await expect(manager.getValidToken('api-key-profile')).resolves.toBe('sk-test');
    await expect(manager.getValidToken('setup-profile')).resolves.toBe('setup-token');
  });

  it('getValidToken refreshes near-expiry oauth tokens', async () => {
    vi.mocked(store.getProfile).mockReturnValue({
      id: 'oauth-profile',
      provider: 'openai-codex',
      authType: 'oauth',
      label: 'OAuth',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      oauth: {
        accessToken: 'expiring',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 60_000,
      },
    });

    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'renewed',
        expires_in: 3600,
      }),
    } as Response);

    await expect(manager.getValidToken('oauth-profile')).resolves.toBe('renewed');
  });

  it('getValidToken falls back to existing token when refresh fails but token still valid', async () => {
    vi.mocked(store.getProfile).mockReturnValue({
      id: 'fallback-profile',
      provider: 'openai-codex',
      authType: 'oauth',
      label: 'Fallback',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      oauth: {
        accessToken: 'still-valid',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 120_000,
      },
    });

    vi.mocked(proxyFetch).mockRejectedValue(new Error('refresh failed'));

    await expect(manager.getValidToken('fallback-profile')).resolves.toBe('still-valid');
  });

  it('validateProfile returns true for fresh tokens and false when refresh fails', async () => {
    vi.mocked(store.getProfile).mockReturnValueOnce({
      id: 'valid-profile',
      provider: 'openai-codex',
      authType: 'oauth',
      label: 'Valid',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      oauth: {
        accessToken: 'valid',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 60 * 60_000,
      },
    });
    await expect(manager.validateProfile('valid-profile')).resolves.toBe(true);

    vi.mocked(store.getProfile).mockReturnValue({
      id: 'invalid-profile',
      provider: 'openai-codex',
      authType: 'oauth',
      label: 'Invalid',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      oauth: {
        accessToken: 'bad',
        refreshToken: 'refresh',
        expiresAt: Date.now() - 1000,
      },
    });
    vi.mocked(proxyFetch).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid_grant',
    } as Response);

    await expect(manager.validateProfile('invalid-profile')).resolves.toBe(false);
    expect(store.updateOAuthTokens).toHaveBeenCalled();
  });

  it('storeSetupToken upserts setup-token profile', () => {
    const profile = manager.storeSetupToken('anthropic', 'setup-token-value', 'My Setup');
    expect(profile.authType).toBe('setup-token');
    expect(store.upsertProfile).toHaveBeenCalled();
  });

  it('startDeviceCodeLogin polls until authorization succeeds', async () => {
    vi.useFakeTimers();

    vi.mocked(proxyFetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_code: 'ABCD-1234', device_auth_id: 'dev-auth-1', interval: 1 }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_code: 'auth-code',
          code_verifier: 'verifier',
          code_challenge: 'challenge',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: makeJwtPayload({ sub: 'device-user', organizations: [{ id: 'org-1' }] }),
          refresh_token: 'device-refresh',
          expires_in: 3600,
        }),
      } as Response);

    const { userCode, verificationUri, promise } = await manager.startDeviceCodeLogin('openai-codex');
    expect(userCode).toBe('ABCD-1234');
    expect(verificationUri).toContain('/codex/device');

    await vi.advanceTimersByTimeAsync(2000);
    const profile = await promise;
    expect(profile.provider).toBe('openai-codex');
  });

  it('startDeviceCodeLogin rejects when device code endpoint returns 404', async () => {
    vi.mocked(proxyFetch).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'not found',
    } as Response);

    await expect(manager.startDeviceCodeLogin('openai-codex')).rejects.toThrow('Device code login is not enabled');
  });
});
