/**
 * Egress dispatcher *lifecycle* tests.
 *
 * The pure policy functions live in `egress.test.ts`. This file covers the one
 * thing they cannot: what happens to an ALREADY INSTALLED global dispatcher when
 * the policy changes. That gap is not academic — a process that installed a
 * `ProxyAgent` and then had the proxy switched OFF kept sending every fetch
 * through the old proxy until a restart, so Settings reported "no proxy" while
 * the wire still used one. The upstream failure that produced named a proxy the
 * user had already disabled (v0.12.4: `Markus proxy error 400 … "Request path
 * cannot be relayed"`).
 *
 * Assertion style — on purpose: we assert on *the dispatcher actually handed to
 * undici*, not on `installed` alone. A fix that flips a boolean without restoring
 * the direct dispatcher would satisfy the boolean and keep the bug.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as EgressTypes from './egress.js';

const dispatchers: unknown[] = [];

class FakeAgent {
  readonly kind = 'direct';
}
class FakeProxyAgent {
  readonly kind = 'proxy';
  constructor(public opts: { uri: string }) {}
}

vi.mock('undici', () => ({
  Agent: FakeAgent,
  ProxyAgent: FakeProxyAgent,
  setGlobalDispatcher: (d: unknown) => {
    dispatchers.push(d);
  },
}));

let configDir = '';
let configPath = '';

vi.mock('../utils/config-paths.js', () => ({
  markusConfigPath: () => configPath,
  markusPath: (...parts: string[]) => join(configDir, ...parts),
}));

vi.mock('./system-proxy.js', () => ({
  readSystemProxy: () => undefined,
}));

type EgressModule = typeof EgressTypes;

async function loadModule(): Promise<EgressModule> {
  return import('./egress.js');
}

function writeNetwork(network: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify({ network }), 'utf-8');
}

describe('installEgress — switching the proxy OFF must restore the direct dispatcher', () => {
  let mod: EgressModule;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'markus-egress-'));
    configPath = join(configDir, 'markus.json');
    dispatchers.length = 0;
    mod = await loadModule();
    mod.resetEgressForTests();
  });

  afterEach(() => {
    mod.resetEgressForTests();
    delete process.env['HTTPS_PROXY'];
    delete process.env['HTTP_PROXY'];
    delete process.env['NO_PROXY'];
    rmSync(configDir, { recursive: true, force: true });
  });

  it('installs a ProxyAgent when a proxy is configured', async () => {
    writeNetwork({ proxy: 'http://127.0.0.1:7890' });
    const status = await mod.installEgress({ force: true });

    expect(status.policy.source).toBe('config');
    expect(status.installed).toBe(true);
    expect(dispatchers).toHaveLength(1);
    // What "a proxy is installed" means to the wire is that the global dispatcher
    // is NOT the direct agent. The concrete object is the policy dispatcher, which
    // wraps the proxied agent so NO_PROXY hosts still go direct (see egress.test);
    // asserting on its constructor would silently re-pin the pre-policy shape.
    expect(dispatchers[0]).not.toBeInstanceOf(FakeAgent);
  });

  it('replaces it with a direct Agent when the proxy is turned off (no restart)', async () => {
    writeNetwork({ proxy: 'http://127.0.0.1:7890' });
    await mod.installEgress({ force: true });
    expect(dispatchers[0]).not.toBeInstanceOf(FakeAgent);

    // The user turns the proxy off in Settings — exactly the config the reported
    // machine has: `network.proxyEnabled: false`, no proxy URL.
    writeNetwork({ proxyEnabled: false });
    const status = await mod.installEgress({ force: true });

    expect(status.policy.source).toBe('disabled');
    expect(status.installed).toBe(false);
    // The biting assertion: the last dispatcher undici holds must be a direct
    // Agent. Without the restore, no second call happens and this is red.
    expect(dispatchers.length).toBeGreaterThanOrEqual(2);
    expect(dispatchers.at(-1)).toBeInstanceOf(FakeAgent);
    expect(dispatchers.at(-1)).not.toBeInstanceOf(FakeProxyAgent);
  });

  it('reports itself as not installed after the switch-off', async () => {
    writeNetwork({ proxy: 'http://127.0.0.1:7890' });
    await mod.installEgress({ force: true });
    writeNetwork({ proxyEnabled: false });
    await mod.installEgress({ force: true });

    // A status that still says `installed: true` would make the Settings panel
    // claim a proxy is active that the config no longer has.
    expect(mod.egressStatus().installed).toBe(false);
    expect(mod.egressStatus().policy.url).toBeUndefined();
  });
});
