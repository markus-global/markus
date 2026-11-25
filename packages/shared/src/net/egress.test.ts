/**
 * Egress policy tests.
 *
 * These cover the parts that decide *where traffic goes*: precedence between
 * config / environment / system, the bypass list, and credential masking. The
 * dispatcher installation itself is process-global and not unit-testable in a
 * meaningful way, so it is exercised by the probe in Settings instead.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildEgressPolicy,
  buildProxiedDispatcher,
  createPolicyDispatcher,
  createSystemProxyWatcher,
  hostMatchesNoProxy,
  isSocksProxy,
  maskProxyUrl,
  shouldBypassEgress,
  type EgressDispatcher,
} from './egress.js';

describe('buildEgressPolicy — precedence', () => {
  it('prefers the configured proxy over environment and system', () => {
    const policy = buildEgressPolicy({
      config: { proxy: 'http://config:1' },
      envProxy: 'http://env:2',
      systemProxy: 'http://system:3',
    });
    expect(policy).toMatchObject({ url: 'http://config:1', source: 'config', enabled: true });
  });

  it('falls back to the environment, then the system', () => {
    expect(buildEgressPolicy({ envProxy: 'http://env:2', systemProxy: 'http://system:3' }))
      .toMatchObject({ url: 'http://env:2', source: 'env' });
    expect(buildEgressPolicy({ systemProxy: 'http://system:3' }))
      .toMatchObject({ url: 'http://system:3', source: 'system' });
  });

  it('goes direct when nothing is configured', () => {
    expect(buildEgressPolicy({})).toMatchObject({ url: undefined, source: 'none', enabled: false });
  });

  it('lets an explicit disable win over every other source', () => {
    const policy = buildEgressPolicy({
      config: { proxy: 'http://config:1', proxyEnabled: false },
      envProxy: 'http://env:2',
      systemProxy: 'http://system:3',
    });
    expect(policy).toMatchObject({ url: undefined, source: 'disabled', enabled: false });
  });

  it('uses the configured bypass list when present, ignoring the environment', () => {
    const policy = buildEgressPolicy({
      config: { proxy: 'http://p:1', noProxy: ['example.com'] },
      envNoProxy: 'other.com',
    });
    expect(policy.noProxy).toEqual(['example.com']);
  });
});

describe('hostMatchesNoProxy', () => {
  const defaults = ['localhost', '127.0.0.1', '::1', '.local', '10.0.0.0/8', '192.168.0.0/16'];

  it('matches exact hosts and loopback', () => {
    expect(hostMatchesNoProxy('localhost', defaults)).toBe(true);
    expect(hostMatchesNoProxy('127.0.0.1', defaults)).toBe(true);
    expect(hostMatchesNoProxy('api.openai.com', defaults)).toBe(false);
  });

  it('matches suffixes declared with a leading dot', () => {
    expect(hostMatchesNoProxy('printer.local', defaults)).toBe(true);
    expect(hostMatchesNoProxy('notlocal.example.com', defaults)).toBe(false);
  });

  it('matches CIDR ranges', () => {
    expect(hostMatchesNoProxy('10.1.2.3', defaults)).toBe(true);
    expect(hostMatchesNoProxy('192.168.1.50', defaults)).toBe(true);
    expect(hostMatchesNoProxy('172.16.5.5', defaults)).toBe(false);
    expect(hostMatchesNoProxy('8.8.8.8', defaults)).toBe(false);
  });

  it('does not treat a plain name as a suffix match', () => {
    // "example.com" must not match "notexample.com".
    expect(hostMatchesNoProxy('notexample.com', ['example.com'])).toBe(false);
    expect(hostMatchesNoProxy('example.com', ['example.com'])).toBe(true);
  });
});

describe('shouldBypassEgress', () => {
  const policy = buildEgressPolicy({
    config: { proxy: 'http://127.0.0.1:7890', noProxy: ['localhost', '127.0.0.1', '.internal'] },
  });

  it('bypasses loopback and declared internal hosts', () => {
    expect(shouldBypassEgress('http://127.0.0.1:8056/api/health', policy)).toBe(true);
    expect(shouldBypassEgress('https://git.internal/repo', policy)).toBe(true);
  });

  it('routes public hosts through the proxy', () => {
    expect(shouldBypassEgress('https://api.anthropic.com/v1/messages', policy)).toBe(false);
  });
});

describe('maskProxyUrl', () => {
  it('hides credentials but keeps the route readable', () => {
    expect(maskProxyUrl('http://user:secret@proxy.local:8080'))
      .toBe('http://***:***@proxy.local:8080/');
  });

  it('leaves credential-free URLs alone', () => {
    expect(maskProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890/');
  });

  it('returns undefined for no URL', () => {
    expect(maskProxyUrl(undefined)).toBeUndefined();
  });
});

describe('createPolicyDispatcher — the bypass list is actually enforced', () => {
  function fakeDispatcher(): EgressDispatcher & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      dispatch(options) {
        const origin = options.origin;
        calls.push(origin instanceof URL ? origin.hostname : String(origin));
        return true;
      },
      close: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    };
  }

  it('routes loopback to the direct dispatcher and never touches the proxy', () => {
    // The regression this guards: a bare undici ProxyAgent proxied *everything*
    // and ignored NO_PROXY, so local services on 127.0.0.1:11434 (Ollama) were
    // sent out through the system proxy and failed with `fetch failed`. If the
    // routing ever collapses back to "always proxied", proxied.calls goes non-empty
    // and this assertion fails — the test bites.
    const direct = fakeDispatcher();
    const proxied = fakeDispatcher();
    const d = createPolicyDispatcher({
      direct,
      proxied,
      noProxy: ['localhost', '127.0.0.1', '::1'],
    });

    d.dispatch({ origin: new URL('http://127.0.0.1:11434/api/version') }, {});
    d.dispatch({ origin: new URL('http://localhost:11434/api/tags') }, {});

    expect(direct.calls).toEqual(['127.0.0.1', 'localhost']);
    expect(proxied.calls).toEqual([]);
  });

  it('still sends public hosts through the proxy', () => {
    const direct = fakeDispatcher();
    const proxied = fakeDispatcher();
    const d = createPolicyDispatcher({
      direct,
      proxied,
      noProxy: ['localhost', '127.0.0.1', '::1'],
    });

    d.dispatch({ origin: new URL('https://api.anthropic.com/v1/messages') }, {});

    expect(proxied.calls).toEqual(['api.anthropic.com']);
    expect(direct.calls).toEqual([]);
  });

  it('treats private CIDR ranges from the bypass list as direct', () => {
    const direct = fakeDispatcher();
    const proxied = fakeDispatcher();
    const d = createPolicyDispatcher({
      direct,
      proxied,
      noProxy: ['10.0.0.0/8', '192.168.0.0/16'],
    });

    d.dispatch({ origin: new URL('http://10.1.2.3:8080/health') }, {});
    d.dispatch({ origin: new URL('http://192.168.1.5/') }, {});

    expect(direct.calls).toEqual(['10.1.2.3', '192.168.1.5']);
    expect(proxied.calls).toEqual([]);
  });
});

describe('SOCKS5 support', () => {
  const makeUndici = (built: string[]) => ({
    Agent: class { constructor() { /* direct */ } },
    ProxyAgent: class {
      constructor(o: Record<string, unknown>) { built.push(`http:${String(o['uri'])}`); }
    },
    Socks5ProxyAgent: class {
      constructor(url: string) { built.push(`socks:${url}`); }
    },
    setGlobalDispatcher() { /* noop */ },
    fetch: async () => ({} as Response),
  });

  it('recognises socks schemes and rejects http ones', () => {
    expect(isSocksProxy('socks5://127.0.0.1:1080')).toBe(true);
    expect(isSocksProxy('socks5h://127.0.0.1:1080')).toBe(true);
    expect(isSocksProxy('socks4://1.2.3.4:1080')).toBe(true);
    expect(isSocksProxy('SOCKS5://host:1')).toBe(true);
    expect(isSocksProxy('http://127.0.0.1:7890')).toBe(false);
    expect(isSocksProxy('https://proxy:443')).toBe(false);
  });

  it('constructs Socks5ProxyAgent for a socks url, never ProxyAgent', () => {
    // ProxyAgent accepts a socks5:// uri without complaining and then fails every
    // request — so the assertion has to be on WHICH agent was built, not that we
    // returned something.
    const built: string[] = [];
    buildProxiedDispatcher(makeUndici(built) as never, 'socks5://127.0.0.1:1080');
    expect(built).toEqual(['socks:socks5://127.0.0.1:1080']);
  });

  it('keeps the TLS workaround on the http path only', () => {
    // The pin exists because some CDNs fingerprint the TLS stack. A SOCKS tunnel
    // carries the handshake untouched, so applying it there would be meaningless.
    let captured: Record<string, unknown> | undefined;
    const undici = {
      Agent: class { constructor() { /* direct */ } },
      ProxyAgent: class { constructor(o: Record<string, unknown>) { captured = o; } },
      setGlobalDispatcher() { /* noop */ },
      fetch: async () => ({} as Response),
    };
    buildProxiedDispatcher(undici as never, 'http://127.0.0.1:7890');
    expect(captured?.['requestTls']).toEqual({ maxVersion: 'TLSv1.2' });
  });

  it('throws instead of silently going direct when Socks5ProxyAgent is unavailable', () => {
    // The whole point of this change: a SOCKS route that cannot be honoured must be
    // loud. Falling back to "no proxy" would recreate the silent-direct bug that the
    // system-proxy SOCKS detection was added to fix.
    const undici = {
      Agent: class { constructor() { /* direct */ } },
      ProxyAgent: class { constructor() { /* would be wrong here */ } },
      setGlobalDispatcher() { /* noop */ },
      fetch: async () => ({} as Response),
    };
    expect(() => buildProxiedDispatcher(undici as never, 'socks5://127.0.0.1:1080'))
      .toThrow(/no Socks5ProxyAgent/);
  });
});

describe('createSystemProxyWatcher', () => {
  it('fires only when the OS proxy actually changes', async () => {
    vi.useFakeTimers();
    try {
      let current = 'http://a:1';
      let fired = 0;
      const stop = createSystemProxyWatcher({
        read: () => current,
        onChange: () => { fired += 1; },
        intervalMs: 1000,
      });

      // Three ticks with an unchanged value must not rebuild anything: re-installing
      // an identical dispatcher would churn live connections every 30s for nothing.
      await vi.advanceTimersByTimeAsync(3000);
      expect(fired).toBe(0);

      current = 'socks5://b:2';
      await vi.advanceTimersByTimeAsync(1000);
      expect(fired).toBe(1);

      // ...and exactly once, not once per subsequent tick.
      await vi.advanceTimersByTimeAsync(3000);
      expect(fired).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats undefined -> value as a change (user enables a proxy later)', async () => {
    // This is the case the old boot-once behaviour could never handle: Markus started
    // with no proxy, the user turned one on in System Settings, nothing happened.
    vi.useFakeTimers();
    try {
      let current: string | undefined;
      let fired = 0;
      const stop = createSystemProxyWatcher({
        read: () => current,
        onChange: () => { fired += 1; },
        intervalMs: 1000,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(fired).toBe(0);

      current = 'http://127.0.0.1:7890';
      await vi.advanceTimersByTimeAsync(1000);
      expect(fired).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('also notices a proxy being turned off', async () => {
    vi.useFakeTimers();
    try {
      let current: string | undefined = 'http://127.0.0.1:7890';
      let fired = 0;
      const stop = createSystemProxyWatcher({
        read: () => current,
        onChange: () => { fired += 1; },
        intervalMs: 1000,
      });

      current = undefined;
      await vi.advanceTimersByTimeAsync(1000);
      expect(fired).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops firing after the returned disposer runs', async () => {
    vi.useFakeTimers();
    try {
      let current = 'a';
      let fired = 0;
      const stop = createSystemProxyWatcher({
        read: () => current,
        onChange: () => { fired += 1; },
        intervalMs: 1000,
      });
      stop();
      current = 'b';
      await vi.advanceTimersByTimeAsync(5000);
      expect(fired).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
