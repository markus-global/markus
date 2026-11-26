import { describe, it, expect } from 'vitest';
import { FeishuApiClient } from './feishu-api-client.js';

/**
 * This client is REST-only — the long connection belongs to the comms Feishu
 * adapter, which has its own egress guard. What is asserted here is that the
 * REST side rides the platform's fetch/undici egress rather than the SDK's
 * axios default (axios honours the HTTP(S)_PROXY env vars our own egress layer
 * exports and then mis-tunnels HTTPS to Feishu's gateway).
 */
describe('FeishuApiClient egress wiring', () => {
  it('gives the SDK a fetch-backed instance (no axios defaults) for REST', () => {
    const client = new FeishuApiClient({ appId: 'cli_x', appSecret: 's' });
    // TS `private` is not a runtime boundary; the SDK stores what we passed.
    const wired = (client as unknown as { client: { httpInstance: { request?: unknown; defaults?: unknown } } }).client
      .httpInstance;
    expect(typeof wired.request).toBe('function');
    // axios instances always carry `defaults`; our fetch instance never does.
    // If someone reverts to the SDK default this assertion fails.
    expect(wired.defaults).toBeUndefined();
  });
});