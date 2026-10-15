import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CapabilityRoutingConfig } from '../types/model-catalog.js';
import type { AgentConcurrentConfig } from '../types/agent.js';
import { markusConfigPath } from './config-paths.js';

/**
 * Tunnel channels a user can choose for remote access (`config.remote.mode`).
 *
 * WHY it lives here: `@markus/shared` sits BELOW `@markus/remote` in the
 * dependency graph, so it cannot import the frozen `REMOTE_ENDPOINT_KINDS` from
 * the remote contract. This list must stay byte-identical to that constant; a
 * drift guard (`packages/remote/test/remote-config-modes.test.ts`) asserts it.
 */
export const REMOTE_TUNNEL_MODES = [
  'cloudflare_quick',
  'cloudflare_named',
  'tailscale_funnel',
  'tailscale_serve',
  'custom',
] as const;
export type RemoteTunnelMode = (typeof REMOTE_TUNNEL_MODES)[number];

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
      /** Name of the env var (in `~/.markus/.env`) that holds the apiKey. The
       *  canonical form: the secret lives in the env store, the config only
       *  references it by name (mirrors dsh `apiKeyEnv` / OpenClaw SecretRef). */
      apiKeyEnv?: string;
      baseUrl?: string;
      model?: string;
      enabled?: boolean;
      /** Hub geo-aware catalog URL. */
      modelsUrl?: string;
      /** @deprecated Legacy Worker subscription key — stripped on normalize/save. */
      subscriptionKey?: string;
      /** @deprecated Legacy Cloudflare Worker proxy URL — stripped on normalize/save. */
      proxyUrl?: string;
      /** @deprecated Legacy Hub search facade URL — ignored. */
      searchUrl?: string;
      /** @deprecated Legacy Worker toggle — ignored. */
      workerEnabled?: boolean;
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
    /**
     * 并发处理配置（智能体设置 → 并发处理），持久化到 markus.json。
     *
     * 单一事实源：由 `POST /api/settings/agent` 写入，启动时由 `createServices`
     * 读回并灌入 `AgentManager.concurrentConfig`（热应用到所有 agent）。
     * 这里声明字段类型，避免读回时 from `as any` 的隐式契约漂移。
     */
    concurrent?: AgentConcurrentConfig;
    /**
     * 每个 agent 的任务上限（智能体设置 → 任务上限），持久化到 markus.json。
     *
     * 单一事实源：由 `POST /api/settings/agent` 写入，启动时由 `createServices`
     * 读回并灌入 `AgentManager.maxPendingTasksPerAgent`。该上限对每个 agent
     * 各自独立计数；未配置时 `TaskService.checkTaskLimits` 回退到治理策略默认值。
     */
    maxPendingTasksPerAgent?: number;
  };
  browser?: {
    /** Backend that drives agent browser automation: 'embedded' = built-in Electron WebContentsView (default), 'system-chrome' = Chrome extension bridge. */
    mode?: 'embedded' | 'system-chrome';
    /**
     * How agents choose WHICH element to act on.
     * Orthogonal to `mode`: `mode` picks WHICH browser runs, this picks HOW the element is chosen.
     * 'direct' (default) = the model reads the accessibility snapshot and picks the element itself.
     * 'jev' = code enumerates candidate elements and a decision model ranks them.
     */
    elementSelection?: 'direct' | 'jev';
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
    /**
     * Platform config blocks. `feishu` / `search` / `embedding` are the
     * long-standing built-ins; every other key is a **platform block** whose
     * shape is declared by that platform's manifest in
     * `packages/comms/src/platforms/registry.ts` (`PLATFORM_MANIFESTS`) and
     * consumed by the manifest-driven startup traversal + Settings API. Keeping
     * the field list out of this type is deliberate: the manifest is the single
     * source of truth, so `integrations.telegram.botToken` here would be a
     * second, drift-prone copy. Hand-editing a platform block in `markus.json`
     * works because unknown keys survive `loadConfig`; it is only a read-only
     * bootstrap once the Settings API has written the value to the database.
     */
    [platform: string]: unknown;
    feishu?: {
      appId?: string;
      appSecret?: string;
      domain?: string;
      /** Default group chat_id for notifications / agent sends */
      notifyChatId?: string;
      /** Default user open_id for p2p ("send to my Feishu") */
      notifyOpenId?: string;
      mcp?: {
        enabled?: boolean;
        presets?: string[];
      };
    };
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
      /**
       * Per-provider enable switches. Undefined = enabled (default). When set to
       * false, the provider is skipped by web_search even if a key is configured.
       */
      serperEnabled?: boolean;
      tavilyEnabled?: boolean;
      bingEnabled?: boolean;
      googleEnabled?: boolean;
      serpapiEnabled?: boolean;
      braveEnabled?: boolean;
      exaEnabled?: boolean;
      bochaEnabled?: boolean;
      /** Use Markus-hosted search (billed in CU) when no own key is configured. Default: enabled. */
      useMarkusHosted?: boolean;
      /**
       * OpenRouter model id for Markus-hosted search (e.g. 'perplexity/sonar').
       * Applied as MARKUS_SEARCH_OR_MODEL at runtime.
       */
      markusSearchModel?: string;
      /** Preferred Markus-hosted search provider ('bocha' | 'tavily'). Empty = auto (by language). */
      markusProvider?: string;
      /**
       * UI language (e.g. 'zh-CN' | 'en'), synced from the client. Used to choose
       * the default Markus-hosted search provider when markusProvider is auto:
       * Chinese → Bocha, otherwise → Tavily.
       */
      language?: string;
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
    // ── Tunnel intent + pointer (T8) ──────────────────────────────────────
    // This block holds the user's INTENT and a pointer only. The authoritative
    // endpoint state lives in the Hub registry (`/api/remote/endpoints`); the
    // local side never keeps a second copy. Secrets (endpoint rotation secret /
    // Hub token) NEVER land here — they go to `~/.markus/.env` via
    // `provider-secrets.ts`.
    /** Chosen tunnel channel. Unset → legacy WebRTC relay (grey-release fallback). */
    mode?: RemoteTunnelMode;
    /** Port the tunnel points at. Defaults to `server.apiPort ?? 8056`. */
    localPort?: number;
    /** Id of the currently active endpoint (authoritative status stays on the Hub). */
    activeEndpointId?: string;
    /** Own domain — required for `cloudflare_named` / `custom`. */
    hostname?: string;
    /** Explicit opt-in to the legacy WebRTC relay path (the grey-release fallback switch). */
    legacyRelay?: boolean;
  };
  network?: {
    /** HTTP/HTTPS proxy URL for outbound requests (e.g. "http://127.0.0.1:7890") */
    proxy?: string;
    /** Set to false to disable proxy entirely (ignoring system/env detection) */
    proxyEnabled?: boolean;
  };
  codingTools?: {
    enabled?: boolean;
    tools?: Record<string, {
      enabled?: boolean;
      binaryPath?: string;
      defaultArgs?: string[];
      timeoutMs?: number;
      env?: Record<string, string>;
      defaultModel?: string;
      maxBudgetPerSessionUsd?: number;
      approvalRequired?: boolean;
    }>;
  };
}

const DEFAULT_CONFIG: MarkusConfig = {
  org: { id: 'default', name: 'My Organization' },
  llm: {
    // Factory default is Markus Cloud AI. A detected *environment* key
    // (OPENAI_API_KEY, …) only makes a provider usable — it must never
    // silently become the default; the user chooses a default explicitly.
    defaultProvider: 'markus',
    defaultModel: 'claude-opus-5',
    providers: {},
  },
  server: { apiPort: 8056, webPort: 8057 },
  // NOTE: no default adminPassword / gatewaySecret here. Shipping a known
  // literal would let anyone claim a fresh instance or sign gateway requests.
  // Secrets are resolved at runtime (env var, or a random value persisted to
  // ~/.markus/) — see @markus/shared/utils/secrets.
  security: {},
  hub: { url: 'https://markus.global' },
};

export function getDefaultConfigPath(): string {
  return markusConfigPath();
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
        // No existing object to merge into: still recurse with an empty target
        // so nested `null`s in the source are honoured as deletions (the
        // documented contract). Copying `sv` verbatim would leak `key: null`.
        result[key] = deepMerge({}, sv as Obj);
      }
    } else {
      result[key] = sv;
    }
  }
  return result;
}
