import { describe, it, expect } from 'vitest';
import { runQuickBrowserTest } from '../src/tools/browser-test.js';
import { BrowserSessionManager } from '../src/tools/browser-session.js';
import type { MarkusBrowserBridge } from '../src/tools/markus-browser-bridge.js';

describe('browser-test extended', () => {
  it('returns early when bridge is not connected', async () => {
    const bridge = {
      connected: false,
      callTool: async () => ({ content: '', error: 'not connected' }),
    } as unknown as MarkusBrowserBridge;
    const bsm = new BrowserSessionManager();
    const result = await runQuickBrowserTest(bridge, bsm);
    expect(result.connected).toBe(false);
    expect(result.summary).toContain('not connected');
    expect(result.steps).toHaveLength(0);
  });
});
