import { createServer, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { createLogger, type OAuthTokens, type OAuthProviderConfig, type AuthProfile } from '@markus/shared';
import type { AuthProfileStore } from './auth-profiles.js';
import { proxyFetch } from './proxy-fetch.js';

const log = createLogger('oauth-manager');

const KNOWN_OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  'openai-codex': {
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    scope: 'openid profile email offline_access',
    callbackPort: 1455,
  },
};

interface PendingLogin {
  provider: string;
  state: string;
  verifier: string;
  challenge: string;
  redirectUri: string;
  resolve: (tokens: OAuthTokens) => void;
  reject: (error: Error) => void;
  server?: Server;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
  } catch {
    return undefined;
  }
}

/**
 * Extract accountId from tokens using a 3-level fallback:
 * 1. Top-level chatgpt_account_id
 * 2. https://api.openai.com/auth claim's chatgpt_account_id
 * 3. organizations[0].id
 * Tries id_token first (more reliable), then access_token.
 */
function extractAccountId(idToken?: string, accessToken?: string): string | undefined {
  const tokens = [idToken, accessToken].filter(Boolean) as string[];
  for (const token of tokens) {
    const payload = decodeJwtPayload(token);
    if (!payload) continue;

    // Level 1: top-level chatgpt_account_id
    if (payload.chatgpt_account_id && typeof payload.chatgpt_account_id === 'string') {
      return payload.chatgpt_account_id;
    }

    // Level 2: nested under https://api.openai.com/auth
    const authClaim = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    if (authClaim?.chatgpt_account_id && typeof authClaim.chatgpt_account_id === 'string') {
      return authClaim.chatgpt_account_id;
    }

    // Level 3: organizations[0].id
    const orgs = (payload.organizations ?? authClaim?.organizations) as Array<{ id: string }> | undefined;
    if (Array.isArray(orgs) && orgs.length > 0 && orgs[0]?.id) {
      return orgs[0].id;
    }
  }

  // Fallback to sub from access_token
  if (accessToken) {
    const payload = decodeJwtPayload(accessToken);
    if (payload?.sub && typeof payload.sub === 'string') return payload.sub;
  }
  return undefined;
}

export class OAuthManager {
  private profileStore: AuthProfileStore;
  private pendingLogins = new Map<string, PendingLogin>();
  private customProviders = new Map<string, OAuthProviderConfig>();

  constructor(profileStore: AuthProfileStore) {
    this.profileStore = profileStore;
  }

  registerProvider(name: string, config: OAuthProviderConfig): void {
    this.customProviders.set(name, config);
    log.info(`Registered custom OAuth provider: ${name}`);
  }

  getProviderConfig(provider: string): OAuthProviderConfig | undefined {
    return this.customProviders.get(provider) ?? KNOWN_OAUTH_PROVIDERS[provider];
  }

  getSupportedProviders(): string[] {
    const known = Object.keys(KNOWN_OAUTH_PROVIDERS);
    const custom = [...this.customProviders.keys()];
    return [...new Set([...known, ...custom])];
  }

  /**
   * Start the OAuth PKCE login flow.
   * Returns the authorization URL that the user/browser should be directed to.
   * The returned promise resolves when the callback is received (or rejects on timeout/error).
   */
  async startLogin(provider: string): Promise<{ authorizeUrl: string; promise: Promise<AuthProfile> }> {
    const config = this.getProviderConfig(provider);
    if (!config) throw new Error(`Unknown OAuth provider: ${provider}`);

    // Cancel any existing pending login for this provider
    this.cancelPendingLogin(provider);

    const { verifier, challenge } = generatePKCE();
    const state = randomBytes(16).toString('hex');
    const port = config.callbackPort ?? 1455;
    const redirectUri = `http://localhost:${port}/auth/callback`;

    const promise = new Promise<AuthProfile>((resolve, reject) => {
      const pending: PendingLogin = {
        provider,
        state,
        verifier,
        challenge,
        redirectUri,
        resolve: (tokens) => {
          const profile = this.profileStore.createOAuthProfile(provider, tokens, `${provider} (${tokens.accountId ?? 'OAuth'})`);
          resolve(profile);
        },
        reject,
      };

      pending.timeoutHandle = setTimeout(() => {
        this.cleanupPending(state);
        reject(new Error('OAuth login timed out after 5 minutes'));
      }, 5 * 60 * 1000);

      this.pendingLogins.set(state, pending);

      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://localhost:${port}`);

        if (url.pathname === '/auth/callback') {
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(callbackHtml('Authentication Failed', `Error: ${error}. You can close this tab.`, false));
            this.cleanupPending(state);
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (returnedState !== state || !code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(callbackHtml('Invalid Callback', 'State mismatch or missing code. Please try again.', false));
            return;
          }

          try {
            const tokens = await this.exchangeCode(provider, code, verifier, redirectUri);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(callbackHtml('Login Successful', `Connected to ${provider}. You can close this tab.`, true));
            this.cleanupPending(state);
            pending.resolve(tokens);
          } catch (err) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(callbackHtml('Token Exchange Failed', `${err}. Please try again.`, false));
            this.cleanupPending(state);
            pending.reject(err instanceof Error ? err : new Error(String(err)));
          }
          return;
        }

        res.writeHead(404);
        res.end();
      });

      pending.server = server;

      server.listen(port, 'localhost', () => {
        log.info(`OAuth callback server listening on localhost:${port} for ${provider}`);
      });

      server.on('error', (err) => {
        log.error(`Failed to start OAuth callback server on port ${port}`, { error: String(err) });
        this.cleanupPending(state);
        reject(new Error(`Cannot start callback server: ${err.message}. Port ${port} may be in use.`));
      });
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
    });
    if (config.scope) params.set('scope', config.scope);

    const authorizeUrl = `${config.authorizeUrl}?${params.toString()}`;
    return { authorizeUrl, promise };
  }

  /**
   * Handle a manual callback (for headless/remote scenarios where the user pastes the redirect URL).
   */
  async handleManualCallback(callbackUrl: string): Promise<AuthProfile> {
    const url = new URL(callbackUrl);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) throw new Error(`OAuth error: ${error}`);
    if (!state || !code) throw new Error('Missing state or code in callback URL');

    const pending = this.pendingLogins.get(state);
    if (!pending) throw new Error('No pending login found for this state. The login may have timed out.');

    const tokens = await this.exchangeCode(pending.provider, code, pending.verifier, pending.redirectUri);
    const profile = this.profileStore.createOAuthProfile(
      pending.provider, tokens, `${pending.provider} (${tokens.accountId ?? 'OAuth'})`
    );
    this.cleanupPending(state);
    return profile;
  }

  private async exchangeCode(provider: string, code: string, verifier: string, redirectUri: string): Promise<OAuthTokens> {
    const config = this.getProviderConfig(provider);
    if (!config) throw new Error(`Unknown OAuth provider: ${provider}`);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      code_verifier: verifier,
    });

    const res = await proxyFetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Token exchange failed (${res.status}): ${errText}`);
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    const tokens: OAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      accountId: extractAccountId(data.id_token, data.access_token),
    };

    log.info(`OAuth token exchange successful for ${provider}`, { accountId: tokens.accountId });
    return tokens;
  }

  /**
   * Refresh an OAuth token using the stored refresh token.
   * Returns the new access token (also persists to profile store).
   */
  async refreshToken(profileId: string): Promise<string> {
    // Re-read from disk to get freshest tokens (another process may have refreshed)
    const profile = this.profileStore.getProfile(profileId);
    if (!profile?.oauth?.refreshToken) {
      throw new Error(`Profile ${profileId} has no refresh token`);
    }

    // If another process already refreshed and the token is now fresh, just use it
    if (profile.oauth.expiresAt > Date.now() + 5 * 60_000) {
      log.debug(`Token for ${profileId} already refreshed by another process`);
      return profile.oauth.accessToken;
    }

    const config = this.getProviderConfig(profile.provider);
    if (!config) throw new Error(`Unknown OAuth provider: ${profile.provider}`);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: profile.oauth.refreshToken,
      client_id: config.clientId,
    });

    const res = await proxyFetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      // Handle refresh_token_reused: reload from disk in case another process refreshed
      if (errText.includes('refresh_token_reused') || errText.includes('invalid_grant')) {
        const freshProfile = this.profileStore.getProfile(profileId);
        if (freshProfile?.oauth && freshProfile.oauth.expiresAt > Date.now()) {
          log.info(`Recovered from refresh_token_reused for ${profileId} — using fresher stored token`);
          return freshProfile.oauth.accessToken;
        }
      }
      throw new Error(`Token refresh failed (${res.status}): ${errText}`);
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    };

    const newTokens: OAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? profile.oauth.refreshToken,
      idToken: data.id_token ?? profile.oauth.idToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      accountId: extractAccountId(data.id_token, data.access_token) ?? profile.oauth.accountId,
    };

    this.profileStore.updateOAuthTokens(profileId, newTokens);
    log.info(`Refreshed OAuth token for profile ${profileId}, next expiry in ${data.expires_in ?? 3600}s`);
    return newTokens.accessToken;
  }

  /**
   * Get a valid access token for a profile, refreshing if needed.
   * Refreshes proactively 10 minutes before expiry to avoid race conditions
   * (aligned with OpenClaw's EXTERNAL_CLI_NEAR_EXPIRY_MS strategy).
   */
  async getValidToken(profileId: string): Promise<string> {
    const profile = this.profileStore.getProfile(profileId);
    if (!profile) throw new Error(`Auth profile not found: ${profileId}`);

    if (profile.authType === 'api-key') return profile.apiKey ?? '';
    if (profile.authType === 'setup-token') return profile.setupToken ?? '';

    if (!profile.oauth) throw new Error(`Profile ${profileId} has no OAuth tokens`);

    const NEAR_EXPIRY_MS = 10 * 60_000; // 10 minutes buffer

    if (profile.oauth.expiresAt > Date.now() + NEAR_EXPIRY_MS) {
      return profile.oauth.accessToken;
    }

    if (profile.oauth.refreshToken) {
      log.debug(`Token expiring within 10min for ${profileId}, refreshing...`);
      try {
        return await this.refreshToken(profileId);
      } catch (err) {
        // If refresh fails but token is still technically valid, use it as fallback
        if (profile.oauth.expiresAt > Date.now()) {
          log.warn(`Refresh failed for ${profileId}, using existing token (still valid): ${err}`);
          return profile.oauth.accessToken;
        }
        throw err;
      }
    }

    if (profile.oauth.expiresAt > Date.now()) {
      return profile.oauth.accessToken;
    }

    throw new Error(`OAuth token expired for ${profileId} and no refresh token available`);
  }

  /**
   * Validate an OAuth profile by attempting a token refresh.
   * Returns true if the token is valid/refreshable, false if invalidated.
   * When validation fails, marks the profile's expiresAt = 0 so it appears expired.
   */
  async validateProfile(profileId: string): Promise<boolean> {
    const profile = this.profileStore.getProfile(profileId);
    if (!profile?.oauth) return false;

    // If token is still valid and not near expiry, skip refresh attempt
    if (profile.oauth.expiresAt > Date.now() + 5 * 60_000) {
      return true;
    }

    // Attempt a refresh to verify the token is still usable
    if (!profile.oauth.refreshToken) {
      if (profile.oauth.expiresAt > Date.now()) return true;
      return false;
    }

    try {
      await this.refreshToken(profileId);
      return true;
    } catch (err) {
      log.warn(`OAuth token validation failed for ${profileId}: ${err}`);
      // Mark as expired so UI reflects the invalidated state
      this.profileStore.updateOAuthTokens(profileId, {
        ...profile.oauth,
        expiresAt: 0,
      });
      return false;
    }
  }

  /**
   * Store a setup token (e.g. Anthropic's claude setup-token).
   */
  storeSetupToken(provider: string, token: string, label?: string): AuthProfile {
    const profile: AuthProfile = {
      id: `${provider}-setup-${Date.now()}`,
      provider,
      authType: 'setup-token',
      label: label ?? `${provider} Setup Token`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      setupToken: token,
    };
    this.profileStore.upsertProfile(profile);
    return profile;
  }

  /**
   * Start Device Code login flow for headless/remote scenarios.
   * Returns a userCode and verificationUri for the user to complete in any browser.
   * The returned promise resolves when the device is authorized.
   */
  async startDeviceCodeLogin(provider: string): Promise<{
    userCode: string;
    verificationUri: string;
    promise: Promise<AuthProfile>;
  }> {
    const config = this.getProviderConfig(provider);
    if (!config) throw new Error(`Unknown OAuth provider: ${provider}`);

    const issuer = new URL(config.authorizeUrl).origin;
    const deviceUserCodeUrl = `${issuer}/api/accounts/deviceauth/usercode`;
    const deviceTokenUrl = `${issuer}/api/accounts/deviceauth/token`;
    const deviceRedirectUri = `${issuer}/deviceauth/callback`;
    const verificationUri = `${issuer}/codex/device`;

    const res = await proxyFetch(deviceUserCodeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 404) {
        throw new Error('Device code login is not enabled. Enable it in ChatGPT Security Settings first.');
      }
      throw new Error(`Device code request failed (${res.status}): ${errText}`);
    }

    const deviceData = await res.json() as {
      user_code?: string;
      device_auth_id: string;
      interval?: number;
    };

    const userCode = deviceData.user_code ?? '';
    const deviceAuthId = deviceData.device_auth_id;
    const pollInterval = (deviceData.interval ?? 5) * 1000;

    log.info(`Device code login started for ${provider}`, { userCode, verificationUri });

    const promise = new Promise<AuthProfile>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(pollHandle);
        reject(new Error('Device code login timed out after 15 minutes'));
      }, 15 * 60 * 1000);

      const pollHandle = setInterval(async () => {
        try {
          const tokenRes = await proxyFetch(deviceTokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
          });

          if (tokenRes.status === 202 || tokenRes.status === 428) return; // still pending

          if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            if (tokenRes.status === 403 || tokenRes.status === 400) {
              clearInterval(pollHandle);
              clearTimeout(timeout);
              reject(new Error(`Device code login rejected: ${errText}`));
            }
            return;
          }

          const codeData = await tokenRes.json() as {
            authorization_code: string;
            code_verifier: string;
            code_challenge: string;
          };

          clearInterval(pollHandle);
          clearTimeout(timeout);

          // Exchange the authorization code for tokens
          const tokens = await this.exchangeCode(
            provider,
            codeData.authorization_code,
            codeData.code_verifier,
            deviceRedirectUri,
          );

          const profile = this.profileStore.createOAuthProfile(
            provider, tokens, `${provider} (${tokens.accountId ?? 'Device Code'})`
          );
          resolve(profile);
        } catch (err) {
          if (err instanceof Error && err.message.includes('rejected')) {
            clearInterval(pollHandle);
            clearTimeout(timeout);
            reject(err);
          }
          // Otherwise continue polling
        }
      }, pollInterval);
    });

    return { userCode, verificationUri, promise };
  }

  hasPendingLogin(provider?: string): boolean {
    if (!provider) return this.pendingLogins.size > 0;
    return [...this.pendingLogins.values()].some(p => p.provider === provider);
  }

  cancelPendingLogin(provider: string): void {
    for (const [state, pending] of this.pendingLogins) {
      if (pending.provider === provider) {
        pending.reject(new Error('Login cancelled'));
        this.cleanupPending(state);
      }
    }
  }

  private cleanupPending(state: string): void {
    const pending = this.pendingLogins.get(state);
    if (!pending) return;
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    if (pending.server) {
      pending.server.close(() => {
        log.debug(`Closed OAuth callback server for state ${state.slice(0, 8)}...`);
      });
    }
    this.pendingLogins.delete(state);
  }

  destroy(): void {
    for (const [state] of this.pendingLogins) {
      this.cleanupPending(state);
    }
  }
}

function callbackHtml(title: string, message: string, success: boolean): string {
  const color = success ? '#22c55e' : '#ef4444';
  const icon = success ? '&#10003;' : '&#10007;';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex; align-items: center; justify-content: center; min-height: 100vh;
    margin: 0; background: #111; color: #eee; }
  .card { text-align: center; padding: 3rem; border-radius: 1rem;
    background: #1a1a1a; border: 1px solid #333; max-width: 400px; }
  .icon { font-size: 3rem; color: ${color}; margin-bottom: 1rem; }
  h1 { font-size: 1.25rem; margin: 0.5rem 0; }
  p { color: #999; font-size: 0.875rem; margin-top: 0.5rem; }
</style></head>
<body><div class="card">
  <div class="icon">${icon}</div>
  <h1>${title}</h1>
  <p>${message}</p>
</div></body></html>`;
}
