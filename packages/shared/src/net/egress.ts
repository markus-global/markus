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
import { platform } from 'node:os';
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
  /** Direct (un-proxied) dispatcher: the one we restore when the proxy is turned off. */
  Agent: new (opts?: Record<string, unknown>) => EgressDispatcher;
  ProxyAgent: new (opts: Record<string, unknown>) => EgressDispatcher;
  /** Optional: absent in older undici builds (and in test doubles). */
  Socks5ProxyAgent?: new (url: string) => EgressDispatcher;
  setGlobalDispatcher: (dispatcher: unknown) => void;
  fetch: (url: string | URL, init?: Record<string, unknown>) => Promise<Response>;
}

/**
 * True when a proxy URL needs a SOCKS agent rather than an HTTP one.
 *
 * `undici.ProxyAgent` accepts a `socks5://` uri without complaint and then fails at
 * request time, so the scheme — not a try/catch — has to decide the transport.
 */
export function isSocksProxy(url: string): boolean {
  return /^socks(4|5|5h)?:\/\//i.test(url);
}

/**
 * Build the dispatcher for the proxied half of the routing decision.
 *
 * A SOCKS5 route needs `Socks5ProxyAgent`: `ProxyAgent` speaks HTTP CONNECT and would
 * fail every request against a SOCKS endpoint. The TLS workaround below applies only
 * to the HTTP path — it exists because some CDNs fingerprint the TLS stack, and SOCKS
 * tunnels the TLS handshake untouched, so there is nothing to pin there.
 */
export function buildProxiedDispatcher(undici: UndiciLike, url: string): EgressDispatcher {
  if (isSocksProxy(url)) {
    if (!undici.Socks5ProxyAgent) {
      throw new Error(
        'SOCKS proxy configured but this undici build exposes no Socks5ProxyAgent; traffic would silently go direct',
      );
    }
    return new undici.Socks5ProxyAgent(url);
  }
  return new undici.ProxyAgent({
    uri: url,
    // Some CDNs fingerprint the TLS stack; keep the long-standing workaround.
    requestTls: { maxVersion: 'TLSv1.2' },
  });
}

/**
 * The slice of the undici `Dispatcher` interface the policy router touches.
 * Kept structural (not `implements Dispatcher`) so the pure routing logic can be
 * unit-tested with fakes and never needs a live socket to prove the bypass works.
 */
export interface EgressDispatcher {
  dispatch(options: { origin?: unknown; [key: string]: unknown }, handler: unknown): boolean;
  close(): Promise<void>;
  destroy(): Promise<void>;
}

function originHost(origin: unknown): string | undefined {
  if (!origin) return undefined;
  try {
    const asString = origin instanceof URL ? origin.toString() : String(origin);
    return new URL(asString).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Route each request to the direct or the proxied dispatcher based on the
 * bypass list.
 *
 * This exists because a bare `undici.ProxyAgent` proxies *everything* — it does
 * not read `NO_PROXY`. A global ProxyAgent therefore silently sends calls to
 * loopback / private hosts (Ollama on `127.0.0.1:11434`, an internal API on
 * `10.x`) through the external proxy, where they fail with `fetch failed`
 * (`UND_ERR_SOCKET`). The `noProxy` list was documented and surfaced in Settings
 * but never actually enforced on the wire — this is the enforcement point.
 */
export function createPolicyDispatcher(opts: {
  direct: EgressDispatcher;
  proxied: EgressDispatcher;
  noProxy: string[];
}): EgressDispatcher {
  const { direct, proxied, noProxy } = opts;
  return {
    dispatch(options, handler) {
      const host = originHost(options.origin);
      if (host && hostMatchesNoProxy(host, noProxy)) {
        return direct.dispatch(options, handler);
      }
      return proxied.dispatch(options, handler);
    },
    close: () => Promise.all([direct.close(), proxied.close()]).then(() => undefined),
    destroy: () => Promise.all([direct.destroy(), proxied.destroy()]).then(() => undefined),
  };
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

/** How often the macOS system proxy is re-read. See {@link createSystemProxyWatcher}. */
export const SYSTEM_PROXY_POLL_MS = 30_000;

/**
 * Watch a system proxy value and call `onChange` when it actually differs.
 *
 * Why polling: macOS gives a Node process no proxy-change event — `scutil --proxy` is
 * a one-shot query. The alternative was the previous behaviour, reading once at
 * startup, which meant a user who turned their VPN's proxy on (or off) had to restart
 * Markus before it believed them. 30s is the compromise between responsiveness and
 * spawning a child process on a timer.
 *
 * Only fires on a real change: re-installing an identical dispatcher on every tick
 * would churn live connections for no reason.
 */
export function createSystemProxyWatcher(opts: {
  read: () => string | undefined;
  onChange: () => void;
  intervalMs?: number;
}): () => void {
  const { read, onChange, intervalMs = SYSTEM_PROXY_POLL_MS } = opts;
  let last = read() ?? '';
  const timer = setInterval(() => {
    const next = read() ?? '';
    if (next === last) return;
    last = next;
    onChange();
  }, intervalMs);
  // A watcher must never be the reason the process stays alive.
  timer.unref?.();
  return () => clearInterval(timer);
}

let stopProxyWatch: (() => void) | null = null;

/**
 * Start following the OS proxy (macOS only — Owner's scope for now).
 *
 * Skipped when a config or environment proxy is set: those outrank the system route,
 * so watching it would only rebuild the same dispatcher every time the OS value moves.
 *
 * Called after EVERY resolve, not only after a successful install. If the machine
 * boots with no proxy and the user enables one later, there is no install to hook onto
 * — the watcher is the only thing that can notice.
 */
function ensureSystemProxyWatch(): void {
  if (stopProxyWatch) return;
  if (platform() !== 'darwin') return;
  if (readNetworkConfig().proxy || fromEnv()) return;
  stopProxyWatch = createSystemProxyWatcher({
    read: readSystemProxy,
    onChange: () => {
      // Force a fresh resolve: the cached policy predates the OS change, and the
      // install path re-drives both undici and the embedded browser's session.
      void installEgress({ force: true });
    },
  });
}

/** Stop following the OS proxy (shutdown paths and tests). */
export function stopSystemProxyWatch(): void {
  if (stopProxyWatch) {
    stopProxyWatch();
    stopProxyWatch = null;
  }
}

/**
 * Sink for the browser half of the same decision.
 *
 * undici's global dispatcher and Chromium's network stack are two independent
 * transports. Installing only the dispatcher left the right-panel browser going
 * direct while every `fetch` went through the proxy — one "network proxy" setting
 * with two different meanings depending on who was asking. The setting is meant to
 * be all-or-nothing, so the host injects a callback here and we drive both.
 *
 * shared/ cannot import Electron, so this stays a plain function reference.
 */
export type ChromiumProxyApplier = (
  policy: { url?: string; noProxy: string[] } | null,
) => void | Promise<void>;
let chromiumProxyApplier: ChromiumProxyApplier | null = null;

/**
 * Register the browser-side applier. Replays the current policy immediately when one
 * is already cached — the desktop registers this during startup, which can happen
 * *after* the first {@link installEgress} has already run.
 */
export function setChromiumProxyApplier(applier: ChromiumProxyApplier | null): void {
  chromiumProxyApplier = applier;
  if (applier && cachedPolicy) {
    void syncChromiumProxy(cachedPolicy);
  }
}

async function syncChromiumProxy(policy: EgressPolicy): Promise<void> {
  if (!chromiumProxyApplier) return;
  try {
    await chromiumProxyApplier({ url: policy.url, noProxy: policy.noProxy });
  } catch (err) {
    // A browser-side failure must never break the server's own proxy install: the
    // agent's fetch calls still route correctly, and the panel keeps whatever
    // proxy rule it had.
    console.warn(`[egress] chromium proxy sync failed: ${String(err)}`);
  }
}

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
  // Drive the browser side from the same resolved policy, before the early returns
  // below: "either both on or both off" has to hold on every path, including the
  // proxy-was-just-disabled one.
  await syncChromiumProxy(policy);
  // Every resolve is a chance to start following the OS proxy — including the
  // "no proxy yet" case, which is exactly when a later OS change needs noticing.
  ensureSystemProxyWatch();

  if (!policy.url) {
    // Take back the variables we exported, otherwise a disabled proxy keeps
    // applying to child processes started from here on.
    if (envExported) {
      delete process.env['HTTPS_PROXY'];
      delete process.env['HTTP_PROXY'];
      delete process.env['NO_PROXY'];
      envExported = false;
    }
    // A previously-installed global proxy dispatcher outlives a config change.
    // Without this reset, turning the proxy OFF would keep routing every request
    // (loopback included) through the old proxy until the process restarts — the
    // settings switch would look applied while traffic still went out via proxy,
    // so the upstream failure blames a proxy the user has already turned off and
    // cannot find (v0.12.4 report: `Markus proxy error 400 … "Request path cannot
    // be relayed"`, whose only reachable emitter is the user's own proxy).
    if (installed) {
      const undici = await loadUndici();
      if (undici) {
        try {
          undici.setGlobalDispatcher(new undici.Agent());
        } catch (err) {
          installError = `failed to restore the direct dispatcher: ${String(err)}`;
        }
      }
      installed = false;
    }
    return { policy, installed: false, error: installError, displayUrl: undefined };
  }

  // Children (git, gh, npm, tunnel binaries) inherit these.
  //
  // Hazard (learned the hard way): these vars are read *in-process* too, by any
  // HTTP client that consumes the standard proxy env vars on its own — notably
  // axios (proxy-from-env), whose https-over-http-proxy handling mis-tunnels and
  // turns an HTTPS call into a plaintext request on the TLS port. `fetch`/undici
  // is unaffected because it rides the global dispatcher installed above. If you
  // add a client backed by axios or another self-proxying library, give it an
  // explicit fetch-based `httpInstance` (see org-manager/src/feishu-http.ts)
  // rather than letting it read these variables.
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
    const direct = new undici.Agent();
    const proxied = buildProxiedDispatcher(undici, policy.url);
    // Route by host instead of proxying everything. `ProxyAgent` ignores
    // `NO_PROXY`, so a bare global ProxyAgent would push loopback / private
    // requests (Ollama on 127.0.0.1:11434, an internal API on 10.x) through the
    // external proxy, where they fail with `fetch failed`. The bypass list is
    // documented and exposed in Settings — this is where it is enforced.
    undici.setGlobalDispatcher(
      createPolicyDispatcher({ direct, proxied, noProxy: policy.noProxy }),
    );
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
  stopSystemProxyWatch();
}
