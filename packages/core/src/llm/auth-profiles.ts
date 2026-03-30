import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger, type AuthProfile, type LLMAuthType, type OAuthTokens } from '@markus/shared';

const log = createLogger('auth-profiles');

interface AuthProfilesFile {
  version: 1;
  profiles: AuthProfile[];
}

/**
 * Manages persistent auth profiles for LLM providers.
 * Stores OAuth tokens, API keys, and setup tokens in ~/.markus/auth-profiles.json.
 * Uses a file-lock pattern (rename-based) to avoid concurrent refresh races.
 */
export class AuthProfileStore {
  private filePath: string;
  private lockPath: string;

  constructor(stateDir?: string) {
    const dir = stateDir ?? join(homedir(), '.markus');
    this.filePath = join(dir, 'auth-profiles.json');
    this.lockPath = join(dir, '.auth-profiles.lock');
    mkdirSync(dir, { recursive: true });
  }

  private read(): AuthProfilesFile {
    if (!existsSync(this.filePath)) {
      return { version: 1, profiles: [] };
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as AuthProfilesFile;
    } catch (err) {
      log.warn('Failed to read auth-profiles.json, starting fresh', { error: String(err) });
      return { version: 1, profiles: [] };
    }
  }

  private write(data: AuthProfilesFile): void {
    writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  }

  /**
   * Acquire a simple filesystem lock for atomic profile updates (token refresh).
   * Returns a release function. Falls back gracefully if locking fails.
   */
  private acquireLock(): () => void {
    const lockContent = `${process.pid}-${Date.now()}`;
    try {
      writeFileSync(this.lockPath, lockContent, { flag: 'wx' });
      return () => {
        try {
          unlinkSync(this.lockPath);
        } catch { /* already released */ }
      };
    } catch {
      // Lock already held — check staleness (>30s = stale)
      try {
        const existing = readFileSync(this.lockPath, 'utf-8');
        const ts = Number(existing.split('-').pop());
        if (Date.now() - ts > 30_000) {
          writeFileSync(this.lockPath, lockContent, { mode: 0o600 });
          return () => {
            try {
              unlinkSync(this.lockPath);
            } catch { /* ok */ }
          };
        }
      } catch { /* ignore */ }
      log.debug('Auth profile lock contention, proceeding without lock');
      return () => {};
    }
  }

  listProfiles(provider?: string): AuthProfile[] {
    const data = this.read();
    if (provider) return data.profiles.filter(p => p.provider === provider);
    return data.profiles;
  }

  getProfile(id: string): AuthProfile | undefined {
    return this.read().profiles.find(p => p.id === id);
  }

  getDefaultProfile(provider: string): AuthProfile | undefined {
    return this.read().profiles.find(p => p.provider === provider);
  }

  upsertProfile(profile: AuthProfile): void {
    const release = this.acquireLock();
    try {
      const data = this.read();
      const idx = data.profiles.findIndex(p => p.id === profile.id);
      if (idx >= 0) {
        data.profiles[idx] = { ...data.profiles[idx], ...profile, updatedAt: Date.now() };
      } else {
        data.profiles.push({ ...profile, createdAt: Date.now(), updatedAt: Date.now() });
      }
      this.write(data);
      log.info(`Upserted auth profile: ${profile.id} (${profile.provider}/${profile.authType})`);
    } finally {
      release();
    }
  }

  updateOAuthTokens(profileId: string, tokens: OAuthTokens): void {
    const release = this.acquireLock();
    try {
      const data = this.read();
      const profile = data.profiles.find(p => p.id === profileId);
      if (!profile) {
        log.warn(`Profile not found for token update: ${profileId}`);
        return;
      }
      profile.oauth = tokens;
      profile.updatedAt = Date.now();
      this.write(data);
      log.debug(`Updated OAuth tokens for profile: ${profileId}`);
    } finally {
      release();
    }
  }

  deleteProfile(id: string): boolean {
    const release = this.acquireLock();
    try {
      const data = this.read();
      const before = data.profiles.length;
      data.profiles = data.profiles.filter(p => p.id !== id);
      if (data.profiles.length < before) {
        this.write(data);
        log.info(`Deleted auth profile: ${id}`);
        return true;
      }
      return false;
    } finally {
      release();
    }
  }

  /**
   * Create an API-key profile (convenience wrapper).
   */
  createApiKeyProfile(provider: string, apiKey: string, label?: string): AuthProfile {
    const profile: AuthProfile = {
      id: `${provider}-apikey-${Date.now()}`,
      provider,
      authType: 'api-key' as LLMAuthType,
      label: label ?? `${provider} API Key`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      apiKey,
    };
    this.upsertProfile(profile);
    return profile;
  }

  /**
   * Create an OAuth profile with initial tokens.
   */
  createOAuthProfile(provider: string, tokens: OAuthTokens, label?: string): AuthProfile {
    const profile: AuthProfile = {
      id: `${provider}-oauth-${tokens.accountId ?? Date.now()}`,
      provider,
      authType: 'oauth' as LLMAuthType,
      label: label ?? `${provider} OAuth`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      oauth: tokens,
    };
    this.upsertProfile(profile);
    return profile;
  }

  /**
   * Serializable summary for the API (strips sensitive token details).
   */
  listProfilesSafe(provider?: string): Array<{
    id: string;
    provider: string;
    authType: LLMAuthType;
    label?: string;
    createdAt: number;
    updatedAt: number;
    hasApiKey: boolean;
    hasOAuth: boolean;
    oauthExpired?: boolean;
    accountId?: string;
  }> {
    return this.listProfiles(provider).map(p => ({
      id: p.id,
      provider: p.provider,
      authType: p.authType,
      label: p.label,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      hasApiKey: !!p.apiKey,
      hasOAuth: !!p.oauth,
      oauthExpired: p.oauth ? p.oauth.expiresAt < Date.now() : undefined,
      accountId: p.oauth?.accountId,
    }));
  }
}
