import { describe, it, expect } from 'vitest';
import { proxyFailureMessage } from './proxyFailure.ts';

/**
 * These assertions are deliberately about WHICH REMEDY the user is pointed at,
 * not about string formatting. The bug this fixes was that four different causes
 * all rendered as `TypeError: fetch failed`, so a test that only asserted "some
 * message is returned" would have passed on the broken code too.
 */
describe('proxyFailureMessage', () => {
  it('points a refused connection at the proxy process, not at the network', () => {
    const m = proxyFailureMessage({ code: 'network_unreachable', detail: 'ECONNREFUSED' });
    expect(m.key).toBe('networkProxy.failRefused');
    expect(m.params.detail).toBe('ECONNREFUSED');
  });

  it('separates a DNS failure from a refused connection', () => {
    // Same classifier code, different errno → different advice. Collapsing these
    // was the original defect.
    const dns = proxyFailureMessage({ code: 'network_unreachable', detail: 'ENOTFOUND' });
    const refused = proxyFailureMessage({ code: 'network_unreachable', detail: 'ECONNREFUSED' });
    expect(dns.key).not.toBe(refused.key);
    expect(dns.key).toBe('networkProxy.failDns');
  });

  it('separates a timeout from a refused connection', () => {
    const m = proxyFailureMessage({ code: 'network_unreachable', detail: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(m.key).toBe('networkProxy.failTimeout');
  });

  it('keeps the undici folded message in the generic unreachable bucket', () => {
    // undici's `TypeError: fetch failed` carries no errno when `cause` is dropped.
    // It must still reach a "check the proxy" remedy — just the generic one.
    const m = proxyFailureMessage({ code: 'network_unreachable', detail: 'fetch failed' });
    expect(m.key).toBe('networkProxy.failUnreachable');
  });

  it('does NOT blame the proxy when the chain reached the probe', () => {
    // This is the branch the old code could not express at all: `probe returned
    // HTTP 403` was sent to the same "Test failed: ..." slot as a dead proxy.
    const m = proxyFailureMessage({ code: 'probe_http_error', detail: 'HTTP 403' });
    expect(m.key).toBe('networkProxy.failProbeHttp');
    expect(m.key).not.toBe('networkProxy.failUnreachable');
    expect(m.params.detail).toBe('HTTP 403');
  });

  it('falls back to a named bucket for unclassified errors instead of echoing prose', () => {
    const m = proxyFailureMessage({ code: 'probe_failed', detail: 'boom' });
    expect(m.key).toBe('networkProxy.failUnknown');
    expect(m.params.detail).toBe('boom');
  });

  it('never returns an empty detail (i18n would render a blank {{detail}})', () => {
    for (const f of [null, undefined, {}, { code: 'network_unreachable' }, { detail: '   ' }]) {
      const m = proxyFailureMessage(f as never);
      expect(m.params.detail.length).toBeGreaterThan(0);
    }
  });
});
