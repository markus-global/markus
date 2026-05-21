/**
 * Network tools: list_network_requests, get_network_request
 * Performance tools: performance_start_trace, performance_stop_trace, etc.
 * Emulation tools: emulate, resize_page
 */

import type { PageManager } from '../page-manager.js';
import { ensureDebugger } from '../debugger-helper.js';

async function cdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Network request storage per tab
interface StoredRequest {
  id: string;
  url: string;
  method: string;
  status?: number;
  type?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  timestamp: number;
}

const networkRequests = new Map<number, StoredRequest[]>();
let netIdCounter = 1;
const networkEnabled = new Set<number>();

export function setupNetworkListener(): void {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!source.tabId) return;
    const p = params as Record<string, unknown>;

    if (method === 'Network.responseReceived') {
      let reqs = networkRequests.get(source.tabId);
      if (!reqs) { reqs = []; networkRequests.set(source.tabId, reqs); }
      const response = p.response as Record<string, unknown> | undefined;
      reqs.push({
        id: `req${netIdCounter++}`,
        url: (response?.url as string) ?? '',
        method: (p.type as string) ?? 'GET',
        status: response?.status as number | undefined,
        type: p.type as string | undefined,
        timestamp: Date.now(),
      });
      if (reqs.length > 500) reqs.splice(0, reqs.length - 500);
    }
  });
}

async function enableNetwork(pm: PageManager, tabId: number): Promise<void> {
  await ensureDebugger(pm, tabId);
  if (!networkEnabled.has(tabId)) {
    await cdp(tabId, 'Network.enable');
    networkEnabled.add(tabId);
  }
}

export function registerNetworkTools(
  register: (name: string, handler: (params: Record<string, unknown>) => Promise<string>) => void,
  pm: PageManager,
): void {

  register('list_network_requests', async (params) => {
    const tabId = pm.resolveTabId(params);
    await enableNetwork(pm, tabId);

    const reqs = networkRequests.get(tabId) ?? [];
    if (reqs.length === 0) return 'No network requests captured';

    return reqs.map(r =>
      `${r.id}: ${r.method ?? 'GET'} ${r.url} → ${r.status ?? 'pending'}`
    ).join('\n');
  });

  register('get_network_request', async (params) => {
    const reqId = params.reqid as string ?? params.id as string;
    if (!reqId) throw new Error('reqid is required');
    const tabId = pm.resolveTabId(params);

    const reqs = networkRequests.get(tabId) ?? [];
    const req = reqs.find(r => r.id === reqId);
    if (!req) return `Network request ${reqId} not found`;

    return JSON.stringify({
      id: req.id,
      url: req.url,
      method: req.method,
      status: req.status,
      type: req.type,
    }, null, 2);
  });

  register('performance_start_trace', async (params) => {
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);
    await cdp(tabId, 'Tracing.start', {
      categories: '-*,devtools.timeline,v8.execute,disabled-by-default-devtools.timeline',
    });
    return 'Performance trace started';
  });

  register('performance_stop_trace', async (params) => {
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);
    await cdp(tabId, 'Tracing.end');
    return 'Performance trace stopped. Results will be available via tracing events.';
  });

  register('performance_analyze_insight', async (params) => {
    const insightId = params.insightId as string;
    return `Performance insight analysis for "${insightId}" is not available in extension mode. Use chrome-devtools-mcp for full performance profiling.`;
  });

  register('take_heapsnapshot', async () => {
    return 'Heap snapshots are not available in extension mode. Use chrome-devtools-mcp for memory profiling.';
  });

  register('emulate', async (params) => {
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    if (params.width || params.height) {
      await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
        width: (params.width as number) || 0,
        height: (params.height as number) || 0,
        deviceScaleFactor: (params.deviceScaleFactor as number) || 1,
        mobile: params.mobile === true,
      });
    }

    if (params.userAgent) {
      await cdp(tabId, 'Emulation.setUserAgentOverride', {
        userAgent: params.userAgent as string,
      });
    }

    if (params.geolocation) {
      const geo = params.geolocation as { latitude: number; longitude: number; accuracy?: number };
      await cdp(tabId, 'Emulation.setGeolocationOverride', {
        latitude: geo.latitude,
        longitude: geo.longitude,
        accuracy: geo.accuracy ?? 1,
      });
    }

    if (params.colorScheme) {
      await cdp(tabId, 'Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: params.colorScheme as string }],
      });
    }

    return 'Emulation settings applied';
  });

  register('resize_page', async (params) => {
    const width = params.width as number;
    const height = params.height as number;
    if (!width || !height) throw new Error('width and height are required');
    const tabId = pm.resolveTabId(params);

    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { width, height });
    }
    return `Resized to ${width}x${height}`;
  });
}
