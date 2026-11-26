/**
 * C10-F — pure part of the external-signals settings surface.
 *
 * The two properties worth guarding, because both fail silently in production:
 *
 *  1. **No tunnel ⇒ `external: false`.** If the join ever defaults to building a
 *     plausible `http://localhost…` URL and reports it as external, the UI will
 *     print a copyable address that no outside system can reach, and the user
 *     learns this only when a delivery fails. The assertion is on the boolean,
 *     not on the string, because the string looks fine either way.
 *  2. **Trailing slashes are normalised once.** `https://x.dev/` and
 *     `https://x.dev` must not produce two different URLs for one source — that
 *     is the same class of bug as two cache keys for one input.
 */
import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_INGRESS_POLICIES,
  externalIngressUrl,
  isExternalIngressPolicy,
  sourceDeliveryState,
  tunnelStateFor,
} from './externalSources.ts';

describe('externalIngressUrl', () => {
  it('flags local-only paths as not external', () => {
    expect(externalIngressUrl(null, '/api/webhooks/src_1')).toEqual({
      url: '/api/webhooks/src_1',
      external: false,
    });
    expect(externalIngressUrl('', '/api/webhooks/src_1').external).toBe(false);
    expect(externalIngressUrl('   ', '/api/webhooks/src_1').external).toBe(false);
  });

  it('joins a tunnel base without doubling or dropping the slash', () => {
    const withSlash = externalIngressUrl('https://abc.trycloudflare.com/', '/api/webhooks/src_1');
    const withoutSlash = externalIngressUrl('https://abc.trycloudflare.com', '/api/webhooks/src_1');
    expect(withSlash).toEqual({ url: 'https://abc.trycloudflare.com/api/webhooks/src_1', external: true });
    expect(withoutSlash).toEqual(withSlash);
  });
});

describe('policy narrowing', () => {
  it('accepts exactly the closed set', () => {
    expect(EXTERNAL_INGRESS_POLICIES).toEqual(['off', 'observe', 'accept']);
    for (const p of EXTERNAL_INGRESS_POLICIES) expect(isExternalIngressPolicy(p)).toBe(true);
  });

  it('never invents a state from junk', () => {
    for (const junk of ['auto', 'ON', '', null, undefined, 1, {}]) {
      expect(isExternalIngressPolicy(junk)).toBe(false);
    }
  });
});

describe('tunnelStateFor', () => {
  it('separates "no tunnel" (a fact) from "could not ask" (no fact)', () => {
    // The defect this guards: the screen printed "no tunnel is configured" for
    // BOTH. A failed request must not become a claim about the user's machine.
    expect(tunnelStateFor(null)).toEqual({ kind: 'unknown' });
    expect(tunnelStateFor(undefined)).toEqual({ kind: 'unknown' });
    expect(tunnelStateFor({ publicUrl: null })).toEqual({ kind: 'none' });
    expect(tunnelStateFor({ publicUrl: '' })).toEqual({ kind: 'none' });
    expect(tunnelStateFor({ publicUrl: '   ' })).toEqual({ kind: 'none' });
    expect(tunnelStateFor({ publicUrl: ' https://abc.trycloudflare.com ' })).toEqual({
      kind: 'url',
      url: 'https://abc.trycloudflare.com',
    });
  });

  it('flattens "no tunnel" to a local-only URL base, never to a fake host', () => {
    for (const state of [{ kind: 'none' as const }, { kind: 'unknown' as const }, { kind: 'url' as const, url: '' }]) {
      const base = state.kind === 'url' ? state.url : null;
      expect(externalIngressUrl(base, '/api/webhooks/src_1').external).toBe(false);
    }
  });
});

describe('sourceDeliveryState', () => {
  it('lets the org switch win over a source that is switched on', () => {
    // The point of the master switch: an enabled source under `off` is NOT
    // delivering. Reporting it as delivering would be the exact misreading the
    // settings screen exists to prevent.
    expect(sourceDeliveryState({ enabled: true }, 'off')).toBe('blocked_by_policy');
    expect(sourceDeliveryState({ enabled: true }, 'observe')).toBe('delivering');
    expect(sourceDeliveryState({ enabled: true }, 'accept')).toBe('delivering');
    expect(sourceDeliveryState({ enabled: false }, 'accept')).toBe('paused');
  });
});
