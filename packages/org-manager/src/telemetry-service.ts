import { createLogger, APP_VERSION } from '@markus/shared';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, arch } from 'node:os';

const log = createLogger('telemetry');

const TELEMETRY_CONFIG_FILE = join(homedir(), '.markus', 'telemetry.json');
const REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface TelemetryConfig {
  enabled: boolean;
  lastReportAt?: string;
}

interface TelemetryPayload {
  instanceId: string;
  version: string;
  os: string;
  agentCount: number;
  taskCount: number;
  toolCallCount: number;
  teamCount: number;
  plan: string;
}

type StatsProvider = () => {
  agentCount: number;
  taskCount: number;
  toolCallCount: number;
  teamCount: number;
  plan: string;
};

export class TelemetryService {
  private enabled: boolean;
  private hubUrl: string;
  private instanceId: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private statsProvider: StatsProvider | null = null;

  constructor(hubUrl: string, instanceId: string) {
    this.hubUrl = hubUrl;
    this.instanceId = instanceId;
    const config = this.loadConfig();
    this.enabled = config.enabled;
  }

  private loadConfig(): TelemetryConfig {
    try {
      if (existsSync(TELEMETRY_CONFIG_FILE)) {
        return JSON.parse(readFileSync(TELEMETRY_CONFIG_FILE, 'utf-8'));
      }
    } catch { /* use defaults */ }
    return { enabled: true };
  }

  private saveConfig(config: TelemetryConfig): void {
    try {
      mkdirSync(dirname(TELEMETRY_CONFIG_FILE), { recursive: true });
      writeFileSync(TELEMETRY_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch { /* non-critical */ }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    const config = this.loadConfig();
    config.enabled = enabled;
    this.saveConfig(config);
    log.info(`Telemetry ${enabled ? 'enabled' : 'disabled'}`);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setStatsProvider(provider: StatsProvider): void {
    this.statsProvider = provider;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.report(), REPORT_INTERVAL_MS);
    setTimeout(() => void this.report(), 60_000);
  }

  private async report(): Promise<void> {
    if (!this.enabled || !this.statsProvider) return;

    try {
      const stats = this.statsProvider();
      const payload: TelemetryPayload = {
        instanceId: this.instanceId,
        version: APP_VERSION,
        os: `${platform()}/${arch()}`,
        ...stats,
      };

      const hubToken = this.readHubToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (hubToken) headers['Authorization'] = `Bearer ${hubToken}`;

      await fetch(`${this.hubUrl}/api/telemetry`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const config = this.loadConfig();
      config.lastReportAt = new Date().toISOString();
      this.saveConfig(config);
    } catch {
      log.debug('Telemetry report failed (network)');
    }
  }

  private readHubToken(): string | undefined {
    try {
      const tokenPath = join(homedir(), '.markus', 'hub-token');
      return existsSync(tokenPath) ? readFileSync(tokenPath, 'utf-8').trim() : undefined;
    } catch {
      return undefined;
    }
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
