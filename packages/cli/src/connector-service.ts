/**
 * Connector Service — discovers, loads, and manages platform connector descriptors.
 * Handles detection of installed agent platforms and config file read/write.
 */

import { resolve, join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ConnectorDescriptor } from '@markus/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function expandHome(p: string): string {
  return p.replace(/^~/, homedir());
}

export interface DetectionResult {
  platform: string;
  displayName: string;
  installed: boolean;
  configPath?: string;
  binaryFound: boolean;
  running: boolean;
}

export interface ConnectResult {
  success: boolean;
  platform: string;
  externalAgentId: string;
  markusAgentId?: string;
  token?: string;
  configUpdated: boolean;
  error?: string;
}

/**
 * Load all connector descriptors from built-in + user directories.
 * User connectors override built-in ones with the same platform name.
 */
export function loadConnectors(): ConnectorDescriptor[] {
  const connectors = new Map<string, ConnectorDescriptor>();

  // 1. Built-in connectors (shipped with CLI package)
  const builtinDir = resolve(__dirname, '..', 'connectors');
  loadFromDir(builtinDir, connectors);

  // 2. Dev mode: connectors/ in repo root
  const devDir = resolve(process.cwd(), 'packages', 'cli', 'connectors');
  if (devDir !== builtinDir) loadFromDir(devDir, connectors);

  // 3. User connectors (overrides)
  const userDir = join(homedir(), '.markus', 'connectors');
  loadFromDir(userDir, connectors);

  return [...connectors.values()].filter(c => c.platform !== '_template');
}

function loadFromDir(dir: string, map: Map<string, ConnectorDescriptor>): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue;
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const desc = JSON.parse(raw) as ConnectorDescriptor;
      if (desc.platform) {
        map.set(desc.platform, desc);
      }
    } catch {
      // skip invalid files
    }
  }
}

/**
 * Find a specific connector by platform name.
 */
export function findConnector(platform: string): ConnectorDescriptor | undefined {
  return loadConnectors().find(c => c.platform === platform);
}

/**
 * Detect which agent platforms are installed on this machine.
 */
export function scanInstalledPlatforms(): DetectionResult[] {
  const connectors = loadConnectors();
  const results: DetectionResult[] = [];

  for (const c of connectors) {
    const result: DetectionResult = {
      platform: c.platform,
      displayName: c.displayName,
      installed: false,
      binaryFound: false,
      running: false,
    };

    // Check config paths
    for (const p of c.detection.configPaths) {
      const expanded = expandHome(p);
      if (existsSync(expanded)) {
        result.installed = true;
        result.configPath = expanded;
        break;
      }
    }

    // Check binary in PATH
    if (c.detection.binaryName) {
      try {
        execSync(`which ${c.detection.binaryName} 2>/dev/null`, { encoding: 'utf-8' });
        result.binaryFound = true;
        result.installed = true;
      } catch {
        // not found
      }
    }

    // Check if running
    if (c.detection.processName) {
      try {
        const out = execSync(`pgrep -f ${c.detection.processName} 2>/dev/null`, { encoding: 'utf-8' });
        result.running = out.trim().length > 0;
      } catch {
        // not running
      }
    }

    results.push(result);
  }

  return results;
}

/**
 * Read the external platform's config file and return parsed JSON.
 */
export function readPlatformConfig(connector: ConnectorDescriptor): Record<string, unknown> | null {
  const configPath = expandHome(connector.integration.configPath);
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, 'utf-8');
    if (connector.integration.configFormat === 'json5') {
      const cleaned = raw
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*([\]}])/g, '$1');
      return JSON.parse(cleaned);
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write Markus connection info (URL + token) into the external platform's config.
 * Creates the config file if it doesn't exist.
 */
export function writePlatformConfig(
  connector: ConnectorDescriptor,
  markusUrl: string,
  token: string,
): boolean {
  const configPath = expandHome(connector.integration.configPath);
  const configDir = dirname(configPath);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const existing = readPlatformConfig(connector);
    if (existing) config = existing;
  }

  // Set nested fields via dot notation
  setNestedField(config, connector.integration.urlField, markusUrl);
  setNestedField(config, connector.integration.tokenField, token);

  try {
    const content = JSON.stringify(config, null, 2);
    writeFileSync(configPath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the Markus integration skill template to the external platform's skill dir.
 */
export function installSkillTemplate(connector: ConnectorDescriptor): boolean {
  if (!connector.integration.skillDir || !connector.integration.skillTemplateName) {
    return false;
  }

  const skillDir = expandHome(connector.integration.skillDir);
  const templateName = connector.integration.skillTemplateName;

  // Find the template source
  const candidates = [
    join(homedir(), '.markus', 'templates', templateName),
    resolve(process.cwd(), 'templates', templateName),
    resolve(__dirname, '..', 'templates', templateName),
  ];

  let sourceDir: string | undefined;
  for (const c of candidates) {
    if (existsSync(c)) {
      sourceDir = c;
      break;
    }
  }

  if (!sourceDir) return false;

  const targetDir = join(skillDir, templateName);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  try {
    cpSync(sourceDir, targetDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function setNestedField(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function getNestedField(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const key of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Read LLM provider configs from the external platform's config.
 */
export function readPlatformLLMProviders(
  connector: ConnectorDescriptor,
): Record<string, unknown> | null {
  if (!connector.integration.llmProvidersField) return null;
  const config = readPlatformConfig(connector);
  if (!config) return null;
  const providers = getNestedField(config, connector.integration.llmProvidersField);
  return (providers && typeof providers === 'object') ? providers as Record<string, unknown> : null;
}
