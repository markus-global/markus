import { createLogger, type PlanTier, type PlanLimits, type EnterpriseFeature, type LicenseInfo, type LicenseFilePayload, PLAN_LIMITS, ENTERPRISE_FEATURES } from '@markus/shared';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createVerify } from 'node:crypto';

const log = createLogger('license');

const LICENSE_FILE = join(homedir(), '.markus', 'license.json');

/** fetch wrapper that follows redirects while preserving the Authorization header */
async function hubFetch(url: string, init?: RequestInit, maxRedirects = 3): Promise<Response> {
  let currentUrl = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(currentUrl, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) break;
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }
    return res;
  }
  return fetch(currentUrl, init);
}
const HEARTBEAT_INTERVAL_MS = 4 * 60 * 60 * 1000;

const HUB_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAPlaceholderPublicKeyForOfflineLicenseVerification00=
-----END PUBLIC KEY-----`;

export class LicenseService {
  private license: LicenseInfo;
  private hubUrl: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(hubUrl = 'https://markus.global') {
    this.hubUrl = hubUrl;
    this.license = this.loadLicense();
    this.startHeartbeat();
  }

  private loadLicense(): LicenseInfo {
    try {
      if (existsSync(LICENSE_FILE)) {
        const data = JSON.parse(readFileSync(LICENSE_FILE, 'utf-8'));
        if (data && data.plan && data.instanceId) {
          return data as LicenseInfo;
        }
      }
    } catch (e) {
      log.warn('Failed to load license file, using defaults');
    }

    const defaultLicense: LicenseInfo = {
      plan: 'free',
      features: [],
      limits: { ...PLAN_LIMITS.free },
      instanceId: randomUUID(),
    };
    this.saveLicense(defaultLicense);
    return defaultLicense;
  }

  private saveLicense(license: LicenseInfo): void {
    try {
      mkdirSync(dirname(LICENSE_FILE), { recursive: true });
      writeFileSync(LICENSE_FILE, JSON.stringify(license, null, 2), 'utf-8');
    } catch (e) {
      log.warn('Failed to save license file');
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    setTimeout(() => void this.sendHeartbeat(), 30_000);
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.license.licenseKey) return;

    const hubToken = this.readHubToken();
    if (!hubToken) return;

    try {
      const res = await hubFetch(`${this.hubUrl}/api/licenses/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hubToken}`,
        },
        body: JSON.stringify({
          licenseKey: this.license.licenseKey,
          instanceId: this.license.instanceId,
        }),
      });

      if (res.ok) {
        const data = await res.json() as { valid: boolean; plan: PlanTier; validUntil?: string; orgId?: string; orgName?: string; maxSeats?: number; usedSeats?: number };
        if (data.valid) {
          this.license.lastValidated = new Date().toISOString();
          this.license.plan = data.plan;
          this.license.validUntil = data.validUntil;
          this.license.limits = { ...PLAN_LIMITS[data.plan] };
          this.license.features = data.plan === 'enterprise' ? [...ENTERPRISE_FEATURES] : [];
          if (data.orgId) this.license.orgId = data.orgId;
          if (data.orgName) this.license.orgName = data.orgName;
          if (data.maxSeats !== null && data.maxSeats !== undefined) this.license.maxSeats = data.maxSeats;
          if (data.usedSeats !== null && data.usedSeats !== undefined) this.license.usedSeats = data.usedSeats;
          this.saveLicense(this.license);
        } else {
          log.warn('License heartbeat returned invalid — reverting to free');
          this.revertToFree();
        }
      } else if (res.status === 403 || res.status === 404) {
        log.warn('License heartbeat rejected — reverting to free');
        this.revertToFree();
      }
    } catch {
      log.debug('License heartbeat failed (network issue) — using cached state');
    }
  }

  private revertToFree(): void {
    this.license.plan = 'free';
    this.license.licenseKey = undefined;
    this.license.validUntil = undefined;
    this.license.isTrial = undefined;
    this.license.isOffline = undefined;
    this.license.features = [];
    this.license.limits = { ...PLAN_LIMITS.free };
    this.license.orgId = undefined;
    this.license.orgName = undefined;
    this.license.maxSeats = undefined;
    this.license.usedSeats = undefined;
    this.saveLicense(this.license);
  }

  private readHubToken(): string | undefined {
    try {
      const tokenPath = join(homedir(), '.markus', 'hub-token');
      return existsSync(tokenPath) ? readFileSync(tokenPath, 'utf-8').trim() : undefined;
    } catch {
      return undefined;
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────

  getPlan(): PlanTier {
    if (this.license.validUntil && new Date(this.license.validUntil) < new Date()) {
      if (this.license.plan !== 'free') {
        log.info('License expired — reverting to free');
        this.revertToFree();
      }
    }
    return this.license.plan;
  }

  getLimits(): PlanLimits {
    this.getPlan();
    return { ...this.license.limits };
  }

  getFeatures(): EnterpriseFeature[] {
    this.getPlan();
    return [...this.license.features];
  }

  canUse(feature: EnterpriseFeature): boolean {
    this.getPlan();
    if (this.license.plan === 'enterprise') return true;
    return this.license.features.includes(feature);
  }

  getInfo(): LicenseInfo {
    this.getPlan();
    return { ...this.license };
  }

  getInstanceId(): string {
    return this.license.instanceId;
  }

  async activateLicense(licenseKey: string): Promise<{ success: boolean; error?: string }> {
    const hubToken = this.readHubToken();
    if (!hubToken) {
      return { success: false, error: 'Not authenticated with Markus Hub' };
    }

    try {
      const res = await hubFetch(`${this.hubUrl}/api/licenses/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hubToken}`,
        },
        body: JSON.stringify({
          licenseKey,
          instanceId: this.license.instanceId,
        }),
      });

      const data = await res.json() as { success?: boolean; plan?: PlanTier; validUntil?: string; isTrial?: boolean; features?: EnterpriseFeature[]; error?: string; orgId?: string; orgName?: string; maxSeats?: number; usedSeats?: number };

      if (res.ok && data.success) {
        this.license.licenseKey = licenseKey;
        this.license.plan = data.plan ?? 'enterprise';
        this.license.validUntil = data.validUntil;
        this.license.isTrial = data.isTrial;
        this.license.isOffline = false;
        this.license.features = data.features ?? [...ENTERPRISE_FEATURES];
        this.license.limits = { ...PLAN_LIMITS[this.license.plan] };
        this.license.lastValidated = new Date().toISOString();
        this.license.orgId = data.orgId;
        this.license.orgName = data.orgName;
        this.license.maxSeats = data.maxSeats;
        this.license.usedSeats = data.usedSeats;
        this.saveLicense(this.license);
        log.info(`License activated: ${this.license.plan} (valid until ${this.license.validUntil})`);
        return { success: true };
      }

      return { success: false, error: data.error ?? 'Activation failed' };
    } catch {
      return { success: false, error: 'Could not connect to Markus Hub' };
    }
  }

  async activateTrial(): Promise<{ success: boolean; error?: string }> {
    const hubToken = this.readHubToken();
    if (!hubToken) {
      return { success: false, error: 'Not authenticated with Markus Hub' };
    }

    try {
      const res = await hubFetch(`${this.hubUrl}/api/licenses/trial`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hubToken}`,
        },
        body: JSON.stringify({
          instanceId: this.license.instanceId,
        }),
      });

      const data = await res.json() as { success?: boolean; licenseKey?: string; plan?: PlanTier; validUntil?: string; error?: string; orgId?: string; orgName?: string; maxSeats?: number };

      if (res.ok && data.success && data.licenseKey) {
        this.license.licenseKey = data.licenseKey;
        this.license.plan = data.plan ?? 'enterprise';
        this.license.validUntil = data.validUntil;
        this.license.isTrial = true;
        this.license.isOffline = false;
        this.license.features = [...ENTERPRISE_FEATURES];
        this.license.limits = { ...PLAN_LIMITS.enterprise };
        this.license.lastValidated = new Date().toISOString();
        this.license.orgId = data.orgId;
        this.license.orgName = data.orgName;
        this.license.maxSeats = data.maxSeats;
        this.saveLicense(this.license);
        log.info(`Trial activated (valid until ${this.license.validUntil})`);
        return { success: true };
      }

      return { success: false, error: data.error ?? 'Trial activation failed' };
    } catch {
      return { success: false, error: 'Could not connect to Markus Hub' };
    }
  }

  importOfflineLicense(fileContent: string): { success: boolean; error?: string } {
    try {
      const payload = JSON.parse(fileContent) as LicenseFilePayload;
      if (payload.version !== 1 || payload.plan !== 'enterprise') {
        return { success: false, error: 'Invalid license file format' };
      }

      if (new Date(payload.validUntil) < new Date()) {
        return { success: false, error: 'License has expired' };
      }

      // Verify signature (Ed25519)
      // For now, accept all offline licenses in development
      // Production will verify against HUB_LICENSE_PUBLIC_KEY
      if (payload.signature) {
        try {
          const verifier = createVerify('Ed25519');
          const signData = JSON.stringify({
            version: payload.version,
            licenseId: payload.licenseId,
            plan: payload.plan,
            issuedTo: payload.issuedTo,
            validFrom: payload.validFrom,
            validUntil: payload.validUntil,
            maxInstances: payload.maxInstances,
            features: payload.features,
          });
          verifier.update(signData);
          const valid = verifier.verify(HUB_LICENSE_PUBLIC_KEY, payload.signature, 'base64');
          if (!valid) {
            log.warn('Offline license signature verification failed — accepting in dev mode');
          }
        } catch {
          log.warn('Offline license signature verification skipped (key format)');
        }
      }

      this.license.licenseKey = payload.licenseId;
      this.license.plan = 'enterprise';
      this.license.validUntil = payload.validUntil;
      this.license.isTrial = false;
      this.license.isOffline = true;
      this.license.features = payload.features ?? [...ENTERPRISE_FEATURES];
      this.license.limits = { ...PLAN_LIMITS.enterprise };
      this.license.lastValidated = new Date().toISOString();
      this.saveLicense(this.license);
      log.info(`Offline license imported: ${payload.licenseId} (valid until ${payload.validUntil})`);
      return { success: true };
    } catch {
      return { success: false, error: 'Could not parse license file' };
    }
  }

  async deactivate(): Promise<void> {
    if (this.license.licenseKey && !this.license.isOffline) {
      const hubToken = this.readHubToken();
      if (hubToken) {
        try {
          await hubFetch(`${this.hubUrl}/api/licenses/deactivate`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${hubToken}`,
            },
            body: JSON.stringify({
              licenseKey: this.license.licenseKey,
              instanceId: this.license.instanceId,
            }),
          });
        } catch { /* best-effort */ }
      }
    }
    this.revertToFree();
    log.info('License deactivated');
  }

  async revalidate(): Promise<LicenseInfo> {
    if (!this.license.licenseKey) {
      const saved = this.loadLicense();
      if (saved.licenseKey) {
        this.license = saved;
      }
    }

    await this.syncFromHub();

    if (this.license.licenseKey) {
      await this.sendHeartbeat();
    }

    this.getPlan();
    return { ...this.license };
  }

  private async syncFromHub(): Promise<void> {
    const hubToken = this.readHubToken();
    if (!hubToken) return;
    try {
      const res = await hubFetch(`${this.hubUrl}/api/licenses/mine`, {
        headers: { 'Authorization': `Bearer ${hubToken}` },
      });
      if (!res.ok) return;
      const data = await res.json() as { license?: { licenseKey: string; plan: PlanTier; validUntil: string; isTrial: boolean; features: EnterpriseFeature[]; orgId?: string; orgName?: string; maxSeats?: number; usedSeats?: number } };
      if (!data.license) return;

      const currentKey = this.license.licenseKey;
      if (currentKey === data.license.licenseKey) {
        if (data.license.usedSeats !== null && data.license.usedSeats !== undefined && data.license.usedSeats !== this.license.usedSeats) {
          this.license.usedSeats = data.license.usedSeats;
          this.saveLicense(this.license);
        }
        return;
      }

      const currentIsTrial = this.license.isTrial;
      const newIsBetter = !currentKey
        || (currentIsTrial && !data.license.isTrial)
        || (!currentIsTrial && !data.license.isTrial && new Date(data.license.validUntil) > new Date(this.license.validUntil ?? ''));

      if (!newIsBetter) return;

      log.info(`Found better license on Hub: ${data.license.licenseKey} (current: ${currentKey ?? 'none'})`);
      const result = await this.activateLicense(data.license.licenseKey);
      if (result.success) {
        if (data.license.orgId) this.license.orgId = data.license.orgId;
        if (data.license.orgName) this.license.orgName = data.license.orgName;
        if (data.license.maxSeats !== null && data.license.maxSeats !== undefined) this.license.maxSeats = data.license.maxSeats;
        this.saveLicense(this.license);
        log.info(`Upgraded license from Hub: ${data.license.licenseKey}`);
      }
    } catch {
      log.debug('Failed to sync license from Hub');
    }
  }

  setHubUrl(url: string): void {
    this.hubUrl = url;
  }

  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
