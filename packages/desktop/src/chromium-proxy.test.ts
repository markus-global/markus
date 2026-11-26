import { describe, it, expect } from 'vitest';
import { toChromiumBypassRules } from './chromium-proxy.js';

/**
 * These assertions exist because a mistranslated bypass rule does not crash
 * anything — it silently routes the wrong hosts through the proxy. The symptom
 * surfaces much later as "some sites fail" and looks like a network fault.
 */
describe('toChromiumBypassRules', () => {
  it('always includes <local> so loopback/private stay direct', () => {
    // Without proxyRules Chromium infers this; once proxyRules are set it does not.
    // Dropping it would send Ollama on 127.0.0.1 through the external proxy.
    expect(toChromiumBypassRules([])).toBe('<local>');
  });

  it('maps a leading-dot suffix to the wildcard form Chromium understands', () => {
    // `.corp.example` is OUR syntax for "domain + subdomains". Passed through
    // verbatim, Chromium would search for a literal hostname starting with a dot —
    // which can never match, so the bypass would silently do nothing.
    expect(toChromiumBypassRules(['.corp.example'])).toBe('<local>,*.corp.example');
  });

  it('leaves CIDR and exact hostnames untouched', () => {
    expect(toChromiumBypassRules(['10.0.0.0/8', 'api.internal']))
      .toBe('<local>,10.0.0.0/8,api.internal');
  });

  it('trims and drops empty entries instead of emitting bare commas', () => {
    // A stray empty rule becomes an empty segment in Chromium's comma list, which
    // makes the whole rule string unreliable.
    expect(toChromiumBypassRules(['  ', ' a.com ', ''])).toBe('<local>,a.com');
  });

  it('handles the realistic mixed list end to end', () => {
    expect(toChromiumBypassRules(['.internal', '192.168.0.0/16', 'localhost']))
      .toBe('<local>,*.internal,192.168.0.0/16,localhost');
  });
});
