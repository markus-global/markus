/**
 * Outbound HTTP egress policy — the single place that decides how this process
 * reaches the network.
 *
 * Why one place
 * -------------
 * A proxy is a property of *this machine's egress*, not of a request. When proxy
 * support is opt-in per call site, the coverage is whatever percentage of call
 * sites remembered, and every forgotten site silently goes direct — which is both a
 * reachability bug (behind a firewall those features just fail) and a control bug
 * (traffic escapes the egress policy nobody is watching).
 *
 * So: resolve once, install once at process bootstrap
 * ({@link installEgress}), and let bare `fetch` be proxied by default. Call sites
 * do not need to know that a proxy exists.
 *
 * What is covered
 * ---------------
 * Everything that goes through `fetch` / `undici` in this process, plus child
 * processes that inherit the environment we export (git, gh, npm, tunnel binaries).
 * NOT covered: WebSocket clients that build their own agent, third-party binaries
 * run with an explicit env, and the browser (Chrome uses its own proxy settings).
 */
import { existsSync, readFileSync } from 'node:fs';
import { markusConfigPath } from '../utils/config-paths.js';
import { readSystemProxy } from './system-proxy.js';

export type ProxySource = 'config' | 'env' | 'system' | 'none' | 'disabled';

/** Loopback, link-local and private ranges never belong on an external proxy. */
const DEFAULT_NO_PROXY = [
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  '.local',
  '169.254.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
];

export interface EgressPolicy {
  /** Proxy URL, or undefined when going direct. */
  url?: string;
  source: ProxySource;
  /** Hosts that bypass the proxy. */
  noProxy: string[];
  enabled: boolean;
}

export interface RawNetworkConfig {
  proxy?: string;
  proxyEnabled?: boolean;
  noProxy?: string[] | string;
}

function readNetworkConfig(): RawNetworkConfig {
  try {
    const path = markusConfigPath();
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { network?: RawNetworkConfig };
    return raw.network ?? {};
  } catch {
    return {};
  }
}

function fromEnv(): string | undefined {
  return process.env['HTTPS_PROXY'] || process.env['https_proxy']
    || process.env['HTTP_PROXY'] || process.env['http_proxy']
    || process.env['ALL_PROXY'] || process.env['all_proxy']
    || undefined;
}

function normaliseNoProxy(value: RawNetworkConfig['noProxy']): string[] | undefined {
  if (!value) return undefined;
  const list = Array.isArray(value) ? value : value.split(',');
  const cleaned = list.map(entry => entry.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Pure policy builder: every input is explicit, so precedence is testable without
 * touching the real config file, environment or OS.
 */
export function buildEgressPolicy(input: {
  config?: RawNetworkConfig;
  envProxy?: string;
  systemProxy?: string;
  envNoProxy?: string;
}): EgressPolicy {
  const cfg = input.config ?? {};
  const noProxy = normaliseNoProxy(cfg.noProxy)
    ?? normaliseNoProxy(input.envNoProxy)
    ?? [...DEFAULT_NO_PROXY];

  if (cfg.proxyEnabled === false) {
    return { url: undefined, source: 'disabled', noProxy, enabled: false };
  }
  if (cfg.proxy) return { url: cfg.proxy, source: 'config', noProxy, enabled: true };
  if (input.envProxy) return { url: input.envProxy, source: 'env', noProxy, enabled: true };
  if (input.systemProxy) return { url: input.systemProxy, source: 'system', noProxy, enabled: true };
  return { url: undefined, source: 'none', noProxy, enabled: false };
}

/**
 * The effective egress policy. Precedence: config → environment → system → direct.
 * `proxyEnabled: false` short-circuits everything, including system detection.
 */
export function resolveEgress(): EgressPolicy {
  const cfg = readNetworkConfig();
  const envProxy = fromEnv();
  return buildEgressPolicy({
    config: cfg,
    envProxy,
    envNoProxy: process.env['NO_PROXY'] ?? process.env['no_proxy'],
    // System detection shells out; skip it when config or env already answered.
    systemProxy: cfg.proxy || envProxy ? undefined : readSystemProxy(),
  });
}

/** Hide credentials in a proxy URL before it reaches a log or the UI. */
export function maskProxyUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : '';
      parsed.password = parsed.password ? '***' : '';
    }
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^@/]*@/, '//***@');
  }
}

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function matchesCidr(host: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const rangeInt = range ? ipv4ToInt(range) : undefined;
  const hostInt = ipv4ToInt(host);
  if (rangeInt === undefined || hostInt === undefined || !Number.isInteger(bits)) return false;
  if (bits <= 0 || bits > 32) return false;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (rangeInt & mask) === (hostInt & mask);
}

/** True when `host` matches a NO_PROXY entry (exact, suffix or CIDR). */
export function hostMatchesNoProxy(host: string, noProxy: string[]): boolean {
  const target = host.toLowerCase().replace(/^\[|\]$/g, '');
  return noProxy.some(rawEntry => {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) return false;
    if (entry.includes('/')) return matchesCidr(target, entry);
    const bare = entry.replace(/^\*?\./, '').replace(/^\./, '');
    if (bare === target) return true;
    // `.local` style entries match subdomains; plain names match exactly.
    return entry.startsWith('.') || entry.startsWith('*.') ? target.endsWith(bare) : false;
  });
}

/** True when this request must bypass the proxy. */
export function shouldBypassEgress(target: string | URL, policy: EgressPolicy = resolveEgress()): boolean {
  let host: string;
  try {
    host = new URL(typeof target === 'string' ? target : target.toString()).hostname;
  } catch {
    return false;
  }
  return hostMatchesNoProxy(host, policy.noProxy);
}

// ── Installation ───────────────────────────────────────────────────────────

/**
 * Probe URL used by the settings "Test" action. Fixed on purpose: the endpoint
 * echoes the caller's IP, so a successful probe proves which route traffic took,
 * and a fixed target means the test cannot be pointed at internal services.
 */
export const EGRESS_PROBE_URL = 'https://api.ipify.org?format=json';

interface UndiciLike {
  ProxyAgent: new (opts: Record<string, unknown>) => unknown;
  setGlobalDispatcher: (dispatcher: unknown) => void;
  fetch: (url: string | URL, init?: Record<string, unknown>) => Promise<Response>;
}

export interface EgressStatus {
  policy: EgressPolicy;
  /** True when a global dispatcher is installed for this process. */
  installed: boolean;
  /** Why installation did not happen, when it did not. */
  error?: string;
  /** Proxy URL with credentials masked. */
  displayUrl?: string;
}

let installed = false;
let installError: string | undefined;
let cachedPolicy: EgressPolicy | undefined;
/** True once we have written proxy vars into process.env (so we can take them back). */
let envExported = false;

async function loadUndici(): Promise<UndiciLike | null> {
  try {
    const id = 'undici';
    const mod = (await import(/* @vite-ignore */ id)) as unknown as UndiciLike;
    return typeof mod.setGlobalDispatcher === 'function' ? mod : null;
  } catch {
    return null;
  }
}

/**
 * Install the process-wide egress policy. Idempotent; call once at bootstrap,
 * before any network client is created.
 *
 * When a proxy is configured this sets the undici global dispatcher (so bare
 * `fetch` is proxied) and exports the standard proxy variables so child processes
 * inherit the same route. When no proxy is configured it does nothing at all —
 * behaviour is exactly what it was before this module existed.
 */
export async function installEgress(options: { force?: boolean } = {}): Promise<EgressStatus> {
  // Resolution can shell out to the OS for system-proxy detection, so it happens
  // once per process unless a caller explicitly asks for a re-read.
  if (cachedPolicy && !options.force) {
    return {
      policy: cachedPolicy,
      installed: !!cachedPolicy.url && installed,
      error: installError,
      displayUrl: maskProxyUrl(cachedPolicy.url),
    };
  }

  const policy = resolveEgress();
  cachedPolicy = policy;

  if (!policy.url) {
    // Take back the variables we exported, otherwise a disabled proxy keeps
    // applying to child processes started from here on.
    if (envExported) {
      delete process.env['HTTPS_PROXY'];
      delete process.env['HTTP_PROXY'];
      delete process.env['NO_PROXY'];
      envExported = false;
    }
    return { policy, installed: false, error: installError, displayUrl: undefined };
  }

  // Children (git, gh, npm, tunnel binaries) inherit these.
  process.env['HTTPS_PROXY'] = policy.url;
  process.env['HTTP_PROXY'] = policy.url;
  process.env['NO_PROXY'] = policy.noProxy.join(',');
  envExported = true;

  if (installed && !options.force) {
    return { policy, installed, displayUrl: maskProxyUrl(policy.url) };
  }

  const undici = await loadUndici();
  if (!undici) {
    installError = 'undici unavailable — traffic is NOT proxied';
    return { policy, installed: false, error: installError, displayUrl: maskProxyUrl(policy.url) };
  }

  try {
    const agent = new undici.ProxyAgent({
      uri: policy.url,
      // Some CDNs fingerprint the TLS stack; keep the long-standing workaround.
      requestTls: { maxVersion: 'TLSv1.2' },
    });
    undici.setGlobalDispatcher(agent);
    installed = true;
    installError = undefined;
  } catch (err) {
    installError = `failed to install proxy: ${String(err)}`;
  }

  return { policy, installed, error: installError, displayUrl: maskProxyUrl(policy.url) };
}

/** Current status for the settings API and diagnostics. */
export function egressStatus(): EgressStatus {
  const policy = cachedPolicy ?? resolveEgress();
  return {
    policy,
    installed: !!policy.url && installed,
    error: installError,
    displayUrl: maskProxyUrl(policy.url),
  };
}

/**
 * Test-only escape hatch: forget that a dispatcher was installed so the next
 * {@link installEgress} re-reads config. Not used in production paths.
 */
export function resetEgressForTests(): void {
  installed = false;
  installError = undefined;
  cachedPolicy = undefined;
  envExported = false;
}
