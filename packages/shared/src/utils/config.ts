import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

export interface MarkusConfig {
  org: {
    id: string;
    name: string;
  };
  llm: {
    defaultProvider: string;
    defaultModel: string;
    providers: Record<string, { apiKey?: string; baseUrl?: string }>;
    /** Request timeout in ms for all LLM providers (default: 90s) */
    timeoutMs?: number;
  };
  compute: {
    defaultType: 'docker' | 'vm';
    docker?: {
      socketPath?: string;
      defaultImage?: string;
    };
  };
  server: {
    apiPort: number;
    webPort: number;
  };
  mcpServers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
  redis?: {
    url: string;
  };
  database?: {
    url: string;
  };
}

const DEFAULT_CONFIG: MarkusConfig = {
  org: { id: 'default', name: 'My Organization' },
  llm: {
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
    providers: {},
  },
  compute: {
    defaultType: 'docker',
    docker: { defaultImage: 'node:20-slim' },
  },
  server: { apiPort: 3001, webPort: 3000 },
};

export function getDefaultConfigPath(): string {
  return join(homedir(), '.markus', 'markus.json');
}

export function loadConfig(configPath?: string): MarkusConfig {
  const p = configPath ?? getDefaultConfigPath();
  if (!existsSync(p)) return DEFAULT_CONFIG;

  const raw = readFileSync(p, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<MarkusConfig>;
  return deepMerge(DEFAULT_CONFIG as unknown as Obj, parsed as unknown as Obj) as unknown as MarkusConfig;
}

/**
 * Merge partial updates into the on-disk markus.json (creates it if absent).
 */
export function saveConfig(updates: Partial<MarkusConfig>, configPath?: string): void {
  const p = configPath ?? getDefaultConfigPath();
  mkdirSync(resolve(p, '..'), { recursive: true });
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
}

type Obj = Record<string, unknown>;

function deepMerge(target: Obj, source: Obj): Obj {
  const result: Obj = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Obj, sv as Obj);
    } else {
      result[key] = sv;
    }
  }
  return result;
}
