import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { CapabilityRoutingConfig } from '../types/model-catalog.js';

export interface MarkusConfig {
  org: {
    id: string;
    name: string;
  };
  llm: {
    defaultProvider: string;
    defaultModel: string;
    providers: Record<string, {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      enabled?: boolean;
    }>;
    /** Custom model definitions added via UI/API, keyed by provider name */
    customModels?: Record<string, Array<{
      id: string;
      name: string;
      provider: string;
      contextWindow: number;
      maxOutputTokens: number;
      cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
      reasoning?: boolean;
      inputTypes?: Array<'text' | 'image'>;
    }>>;
    /** Request timeout in ms for all LLM providers (default: 90s) */
    timeoutMs?: number;
    /** Allow automatic fallback to other providers/models when the primary fails (default: true) */
    autoFallback?: boolean;
    /** Capability-specific model routing (manual assignments per capability type) */
    capabilityRouting?: CapabilityRoutingConfig;
    /** Global routing default model — used as fallback when routing can't find a tier match */
    routingDefaultModel?: { provider: string; model: string };
    /** Mirror URL for model catalog updates (default: GitHub raw + CDN mirrors). Set this if raw.githubusercontent.com is unreachable. */
    catalogMirrorUrl?: string;
  };
  server: {
    apiPort: number;
    webPort: number;
  };
  security?: {
    adminPassword?: string;
    gatewaySecret?: string;
  };
  hub?: {
    url: string;
  };
  mcpServers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
  agent?: {
    /** Safety cap on tool iterations per agent turn (default: 200) */
    maxToolIterations?: number;
    /** Cognitive Preparation Pipeline settings (default: disabled) */
    cognitive?: {
      enabled?: boolean;
      /** Cap depth level: 0=D0, 1=D1, 2=D2, 3=D3 (default: 1 = appraisal only) */
      maxDepth?: number;
      /** Model override for appraisal/reflection calls */
      appraisalModel?: string;
      /** Timeout in ms for CPP LLM calls (default: 15000) */
      timeoutMs?: number;
    };
  };
  browser?: {
    /** Bring Chrome tabs/windows to foreground when agent navigates (default: false) */
    bringToFront?: boolean;
    /** Remote debugging port for persistent Chrome connection (avoids repeated permission dialogs). Set to e.g. 9222 to enable. */
    remoteDebuggingPort?: number;
    /** Automatically close agent-owned tabs when the task completes (default: true) */
    autoCloseTabs?: boolean;
    /** Auto-click Chrome's "Allow debugging" dialog via OS accessibility APIs (macOS/Windows) */
    autoClickAllowDialog?: boolean;
    /** WebSocket port for Chrome extension bridge (default: 9333) */
    extensionBridgePort?: number;
  };
  integrations?: {
    feishu?: { appId?: string; appSecret?: string };
    search?: {
      serperApiKey?: string;
      tavilyApiKey?: string;
      bingApiKey?: string;
      googleSearchApiKey?: string;
      googleSearchCx?: string;
      serpApiKey?: string;
      braveApiKey?: string;
      exaApiKey?: string;
      bochaApiKey?: string;
    };
    embedding?: { apiKey?: string };
  };
  database?: {
    url: string;
  };
  /** File / blob storage for uploads (images, attachments, etc.).
   *  Default: local filesystem at ~/.markus/uploads/ */
  fileStorage?: {
    provider: 'local';
    local?: {
      /** Override the upload directory (default: ~/.markus/uploads/) */
      dir?: string;
    };
    // Future cloud providers:
    // s3?: { bucket: string; region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string };
  };
  remote?: {
    enabled?: boolean;
    autoConnect?: boolean;
    hubUrl?: string;
    instanceName?: string;
  };
  network?: {
    /** HTTP/HTTPS proxy URL for outbound requests (e.g. "http://127.0.0.1:7890") */
    proxy?: string;
    /** Set to false to disable proxy entirely (ignoring system/env detection) */
    proxyEnabled?: boolean;
  };
}

const DEFAULT_CONFIG: MarkusConfig = {
  org: { id: 'default', name: 'My Organization' },
  llm: {
    defaultProvider: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    providers: {},
  },
  server: { apiPort: 8056, webPort: 8057 },
  security: { adminPassword: 'markus123', gatewaySecret: 'markus-gateway-default-secret-change-me' },
  hub: { url: 'https://markus.global' },
};

export function getDefaultConfigPath(): string {
  return join(homedir(), '.markus', 'markus.json');
}

export function loadConfig(configPath?: string): MarkusConfig {
  const p = configPath ?? getDefaultConfigPath();
  if (!existsSync(p)) return DEFAULT_CONFIG;

  const raw = readFileSync(p, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<MarkusConfig>;
  // Migrate legacy 'taskRouting' key → 'capabilityRouting'
  if (parsed.llm && (parsed.llm as any).taskRouting && !parsed.llm.capabilityRouting) {
    parsed.llm.capabilityRouting = (parsed.llm as any).taskRouting;
    delete (parsed.llm as any).taskRouting;
  }
  return deepMerge(DEFAULT_CONFIG as unknown as Obj, parsed as unknown as Obj) as unknown as MarkusConfig;
}

/**
 * Acquire a simple filesystem lock. Returns a release function.
 * Uses O_EXCL to atomically create the lock file.
 */
function acquireConfigLock(configPath: string, timeoutMs = 5000): () => void {
  const lockPath = configPath + '.lock';
  const deadline = Date.now() + timeoutMs;
  const SPIN_MS = 50;

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      writeFileSync(lockPath, `${process.pid}-${Date.now()}`, 'utf-8');
      return () => { try { unlinkSync(lockPath); } catch { /* already released */ } };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Check for stale lock (>10s)
        try {
          const content = readFileSync(lockPath, 'utf-8');
          const ts = Number(content.split('-').pop());
          if (Date.now() - ts > 10_000) {
            try { unlinkSync(lockPath); } catch { /* race with another cleaner */ }
            continue;
          }
        } catch { /* lock file disappeared — retry */ continue; }

        // Spin-wait
        const waitUntil = Date.now() + SPIN_MS;
        while (Date.now() < waitUntil) { /* busy wait */ }
        continue;
      }
      break;
    }
  }
  // Fallback: proceed without lock (better than deadlocking)
  return () => {};
}

/**
 * Merge partial updates into the on-disk markus.json (creates it if absent).
 * Uses a filesystem lock to prevent concurrent write races.
 */
export function saveConfig(updates: Partial<MarkusConfig>, configPath?: string): void {
  const p = configPath ?? getDefaultConfigPath();
  mkdirSync(resolve(p, '..'), { recursive: true });
  const releaseLock = acquireConfigLock(p);
  try {
    let existing: Obj = {};
    if (existsSync(p)) {
      try {
        existing = JSON.parse(readFileSync(p, 'utf-8')) as Obj;
      } catch {
        existing = {};
      }
    }
    const merged = deepMerge(existing, updates as unknown as Obj);
    writeFileSync(p, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  } finally {
    releaseLock();
  }
}

type Obj = Record<string, unknown>;

/**
 * Deep-merge source into target.
 * - `null` values in source DELETE the corresponding key from the result.
 * - Arrays in source REPLACE the target array (no element-level merge).
 * - Plain objects are recursively merged.
 */
function deepMerge(target: Obj, source: Obj): Obj {
  const result: Obj = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv === null || sv === undefined) {
      delete result[key];
    } else if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      const tv = target[key];
      if (tv && typeof tv === 'object' && !Array.isArray(tv)) {
        result[key] = deepMerge(tv as Obj, sv as Obj);
      } else {
        result[key] = sv;
      }
    } else {
      result[key] = sv;
    }
  }
  return result;
}
