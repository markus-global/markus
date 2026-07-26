import { describe, it, expect, vi } from 'vitest';
import type { EmbeddedBrowserHost } from '../src/tools/embedded-browser-host.js';
import { getBridgeToolDescriptors } from '../src/tools/markus-browser-mcp.js';

/**
 * Simulates AgentManager's call-time backend selection for chrome-devtools tools.
 */
async function selectBackend(
  toolName: string,
  args: Record<string, unknown>,
  opts: {
    bridgeConnected: boolean;
    bridgeCall?: (name: string, args: Record<string, unknown>) => Promise<{ content: string; error?: string }>;
    embedded?: EmbeddedBrowserHost | null;
    npxCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
  },
): Promise<string> {
  if (opts.bridgeConnected && opts.bridgeCall) {
    const result = await opts.bridgeCall(toolName, args);
    if (result.error) return `Error: ${result.error}`;
    return result.content;
  }
  if (opts.embedded?.available()) {
    const result = await opts.embedded.callTool(toolName, args);
    if (result.error) return `Error: ${result.error}`;
    return result.content;
  }
  if (opts.npxCall) {
    const { _pageId, ...cleanArgs } = args;
    void _pageId;
    return opts.npxCall(toolName, cleanArgs);
  }
  return 'Error: no browser backend';
}

describe('embedded browser host routing', () => {
  it('exposes the same tool surface as the bridge descriptors', () => {
    const names = getBridgeToolDescriptors().map(d => d.name);
    expect(names).toContain('new_page');
    expect(names).toContain('take_snapshot');
    expect(names).toContain('navigate_page');
    expect(names).toContain('evaluate_script');
  });

  it('prefers extension bridge when connected', async () => {
    const bridgeCall = vi.fn(async () => ({ content: 'bridge-ok' }));
    const embedded: EmbeddedBrowserHost = {
      available: () => true,
      callTool: vi.fn(async () => ({ content: 'embedded-ok' })),
    };
    const out = await selectBackend('list_pages', {}, {
      bridgeConnected: true,
      bridgeCall,
      embedded,
      npxCall: async () => 'npx-ok',
    });
    expect(out).toBe('bridge-ok');
    expect(bridgeCall).toHaveBeenCalled();
    expect(embedded.callTool).not.toHaveBeenCalled();
  });

  it('uses embedded host when bridge is down', async () => {
    const embedded: EmbeddedBrowserHost = {
      available: () => true,
      callTool: vi.fn(async () => ({ content: '1: https://example.com [selected]' })),
    };
    const npxCall = vi.fn(async () => 'npx-ok');
    const out = await selectBackend('list_pages', {}, {
      bridgeConnected: false,
      embedded,
      npxCall,
    });
    expect(out).toContain('example.com');
    expect(embedded.callTool).toHaveBeenCalledWith('list_pages', {});
    expect(npxCall).not.toHaveBeenCalled();
  });

  it('falls back to npx when neither bridge nor embedded is available', async () => {
    const npxCall = vi.fn(async () => 'npx-ok');
    const out = await selectBackend('list_pages', { _pageId: 3 }, {
      bridgeConnected: false,
      embedded: { available: () => false, callTool: async () => ({ content: '' }) },
      npxCall,
    });
    expect(out).toBe('npx-ok');
    expect(npxCall).toHaveBeenCalledWith('list_pages', {});
  });
});
