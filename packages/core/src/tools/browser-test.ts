/**
 * Comprehensive browser integration test suite.
 *
 * Two modes:
 * - Quick: structured 8-group sanity check (~15s)
 * - Chaos: continuous randomized multi-agent stress test with per-op correctness verification
 */

import { createLogger } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';
import type { MarkusBrowserBridge } from './markus-browser-bridge.js';
import type { BrowserSessionManager } from './browser-session.js';
import { getBridgeToolDescriptors } from './markus-browser-mcp.js';

const log = createLogger('browser-test');

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface BrowserTestStep {
  name: string;
  group: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  detail?: string;
}

export interface BrowserTestResult {
  connected: boolean;
  steps: BrowserTestStep[];
  totalDurationMs: number;
  passed: number;
  failed: number;
  summary: string;
}

export interface ChaosOpResult {
  type: 'op';
  agent: string;
  op: string;
  target: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  detail?: string;
  timestamp: number;
}

export interface ChaosStats {
  type: 'stats';
  elapsed: number;
  totalOps: number;
  passed: number;
  failed: number;
  opsPerSec: number;
}

export interface ChaosDone {
  type: 'done';
  totalOps: number;
  passed: number;
  failed: number;
  elapsed: number;
}

export type ChaosEvent = ChaosOpResult | ChaosStats | ChaosDone;

// ─── Constants ─────────────────────────────────────────────────────────────────

const SITE_POOL = [
  'https://example.com',
  'https://httpbin.org/html',
  'https://jsonplaceholder.typicode.com',
  'https://httpbin.org/get',
  'https://httpbin.org/headers',
];

const SITE_KEYWORDS: Record<string, string[]> = {
  'https://example.com': ['Example Domain', 'example'],
  'https://httpbin.org/html': ['Herman Melville', 'Moby Dick'],
  'https://jsonplaceholder.typicode.com': ['JSONPlaceholder', 'jsonplaceholder'],
  'https://httpbin.org/get': ['httpbin', 'origin'],
  'https://httpbin.org/headers': ['headers', 'Host'],
};

function getKeywords(url: string): string[] {
  for (const [pattern, kw] of Object.entries(SITE_KEYWORDS)) {
    if (url.includes(pattern.replace('https://', ''))) return kw;
  }
  return [];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parsePageId(result: string): number | null {
  const m = result.match(/^(\d+):/m);
  return m ? parseInt(m[1], 10) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, max = 300): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function createTestAgentTools(
  bridge: MarkusBrowserBridge,
  bsm: BrowserSessionManager,
  agentId: string,
): Map<string, AgentToolHandler> {
  const toolDescriptors = getBridgeToolDescriptors();
  let tools: AgentToolHandler[] = toolDescriptors.map((tool) => ({
    name: `chrome-devtools__${tool.name}`,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (args: Record<string, unknown>) => {
      const result = await bridge.callTool(tool.name, args);
      if (result.error) return `Error: ${result.error}`;
      return result.content;
    },
  }));
  tools = bsm.wrapToolHandlers(tools, agentId);
  const map = new Map<string, AgentToolHandler>();
  for (const t of tools) map.set(t.name.replace('chrome-devtools__', ''), t);
  return map;
}

async function callTool(
  tools: Map<string, AgentToolHandler>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const handler = tools.get(name);
  if (!handler) throw new Error(`Tool ${name} not found`);
  return handler.execute(args);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Quick Test
// ═══════════════════════════════════════════════════════════════════════════════

export async function runQuickBrowserTest(
  bridge: MarkusBrowserBridge,
  bsm: BrowserSessionManager,
): Promise<BrowserTestResult> {
  const t0 = Date.now();
  const steps: BrowserTestStep[] = [];

  if (!bridge.connected) {
    return { connected: false, steps: [], totalDurationMs: 0, passed: 0, failed: 0, summary: 'Extension not connected' };
  }

  const agentIds = ['__test-quick-a__', '__test-quick-b__', '__test-quick-c__'];
  const toolSets = agentIds.map((id) => createTestAgentTools(bridge, bsm, id));
  const [toolsA, toolsB, toolsC] = toolSets;

  let pageA = 0, pageB = 0, pageC = 0;

  async function step(group: string, name: string, fn: () => Promise<void>): Promise<void> {
    const st = Date.now();
    try {
      await fn();
      steps.push({ name, group, passed: true, durationMs: Date.now() - st });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ name, group, passed: false, durationMs: Date.now() - st, error: msg });
    }
  }

  try {
    // ── Group 1: Setup (sequential to avoid page-ID race) ────────────────
    await step('Setup', 'Agent A: new_page (example.com)', async () => {
      const r = await callTool(toolsA, 'new_page', { url: 'https://example.com', background: true });
      pageA = parsePageId(r)!;
      if (!pageA) throw new Error(`Failed to parse pageId: ${truncate(r)}`);
    });
    await step('Setup', 'Agent B: new_page (httpbin.org/html)', async () => {
      const r = await callTool(toolsB, 'new_page', { url: 'https://httpbin.org/html', background: true });
      pageB = parsePageId(r)!;
      if (!pageB) throw new Error(`Failed to parse pageId: ${truncate(r)}`);
    });
    await step('Setup', 'Agent C: new_page (jsonplaceholder)', async () => {
      const r = await callTool(toolsC, 'new_page', { url: 'https://jsonplaceholder.typicode.com', background: true });
      pageC = parsePageId(r)!;
      if (!pageC) throw new Error(`Failed to parse pageId: ${truncate(r)}`);
    });
    await step('Setup', 'All pageIds distinct', async () => {
      if (pageA === pageB || pageB === pageC || pageA === pageC) {
        throw new Error(`Duplicate pageIds: A=${pageA}, B=${pageB}, C=${pageC}`);
      }
    });

    log.info('Setup complete', { pageA, pageB, pageC });

    // ── Group 2: Tab Verification ───────────────────────────────────────────
    await step('Tab Verification', 'list_pages: all 3 pages present', async () => {
      const r = await callTool(toolsA, 'list_pages');
      for (const pid of [pageA, pageB, pageC]) {
        if (!new RegExp(`^${pid}:\\s`, 'm').test(r)) throw new Error(`Page ${pid} not in list: ${truncate(r)}`);
      }
    });
    await step('Tab Verification', 'Agent A: select own page', async () => {
      const r = await callTool(toolsA, 'select_page', { pageId: pageA });
      if (r.includes('Error') || r.includes('NOT your tab')) throw new Error(truncate(r));
    });
    await step('Tab Verification', 'Agent B: select own page', async () => {
      const r = await callTool(toolsB, 'select_page', { pageId: pageB });
      if (r.includes('Error') || r.includes('NOT your tab')) throw new Error(truncate(r));
    });
    await step('Tab Verification', 'Agent C: select own page', async () => {
      const r = await callTool(toolsC, 'select_page', { pageId: pageC });
      if (r.includes('Error') || r.includes('NOT your tab')) throw new Error(truncate(r));
    });

    // ── Group 3: Inspection Tools (parallel) ────────────────────────────────
    await step('Inspection', 'Agent A: take_snapshot (example.com)', async () => {
      const r = await callTool(toolsA, 'take_snapshot');
      if (!r.toLowerCase().includes('example')) {
        throw new Error(`Snapshot doesn't contain "example": ${truncate(r)}`);
      }
    });
    await step('Inspection', 'Agent B: take_screenshot', async () => {
      const r = await callTool(toolsB, 'take_screenshot');
      if (!r || r.length < 100) {
        throw new Error(`Screenshot too short (${r.length} chars): ${truncate(r, 120)}`);
      }
    });
    await step('Inspection', 'Agent C: evaluate_script (document.title)', async () => {
      const r = await callTool(toolsC, 'evaluate_script', { expression: 'document.title' });
      if (!r.toLowerCase().includes('jsonplaceholder')) {
        throw new Error(`Title doesn't contain "jsonplaceholder": ${truncate(r)}`);
      }
    });

    // ── Group 4: Parallel evaluation + input ────────────────────────────────
    {
      const [linksA, h1B, keyC] = await Promise.all([
        callTool(toolsA, 'evaluate_script', { expression: 'document.querySelectorAll("a").length' }),
        callTool(toolsB, 'evaluate_script', { expression: 'document.querySelector("h1")?.textContent || ""' }),
        callTool(toolsC, 'press_key', { key: 'Tab' }),
      ]);
      await step('Input', 'Agent A: count links on example.com', async () => {
        const count = parseInt(linksA, 10);
        if (isNaN(count) || count < 1) throw new Error(`Expected links > 0, got: ${linksA}`);
      });
      await step('Input', 'Agent B: h1 text on httpbin/html', async () => {
        if (!h1B.toLowerCase().includes('melville') && !h1B.toLowerCase().includes('moby')) {
          throw new Error(`Expected Melville content, got: ${truncate(h1B)}`);
        }
      });
      await step('Input', 'Agent C: press_key Tab', async () => {
        if (keyC.includes('Error:')) throw new Error(truncate(keyC));
      });
    }

    // ── Group 5: Navigation ─────────────────────────────────────────────────
    await step('Navigation', 'Agent A: reload page', async () => {
      const r = await callTool(toolsA, 'navigate_page', { action: 'reload' });
      if (r.includes('Error:')) throw new Error(truncate(r));
    });
    await step('Navigation', 'Agent B: wait_for "Melville"', async () => {
      const r = await callTool(toolsB, 'wait_for', { text: 'Melville', timeout: 10000 });
      if (r.includes('not found') || r.includes('Error:')) throw new Error(truncate(r));
    });
    await step('Navigation', 'Agent C: reload page', async () => {
      const r = await callTool(toolsC, 'navigate_page', { action: 'reload' });
      if (r.includes('Error:')) throw new Error(truncate(r));
    });

    // ── Group 6: Cross-Agent Isolation (parallel eval) ──────────────────────
    {
      const [isoA, isoB, isoC] = await Promise.all([
        callTool(toolsA, 'evaluate_script', { expression: 'document.URL' }),
        callTool(toolsB, 'evaluate_script', { expression: 'document.URL' }),
        callTool(toolsC, 'evaluate_script', { expression: 'document.URL' }),
      ]);
      await step('Isolation', 'Agent A: URL is example.com', async () => {
        if (!isoA.includes('example.com')) throw new Error(`Expected example.com, got: ${truncate(isoA)}`);
      });
      await step('Isolation', 'Agent B: URL is httpbin.org', async () => {
        if (!isoB.includes('httpbin.org')) throw new Error(`Expected httpbin.org, got: ${truncate(isoB)}`);
      });
      await step('Isolation', 'Agent C: URL is jsonplaceholder', async () => {
        if (!isoC.includes('jsonplaceholder')) throw new Error(`Expected jsonplaceholder, got: ${truncate(isoC)}`);
      });
    }

    // ── Group 7: Security ───────────────────────────────────────────────────
    await step('Security', 'Agent A: cannot close Agent B tab', async () => {
      const r = await callTool(toolsA, 'close_page', { pageId: pageB });
      if (!r.includes('NOT your tab') && !r.includes('not your tab')) {
        throw new Error(`Expected rejection, got: ${truncate(r)}`);
      }
    });
    await step('Security', 'Agent B: cannot select Agent C tab', async () => {
      const r = await callTool(toolsB, 'select_page', { pageId: pageC });
      if (!r.includes('NOT your tab') && !r.includes('not your tab')) {
        throw new Error(`Expected rejection, got: ${truncate(r)}`);
      }
    });
    await step('Security', 'Agent C: cannot close Agent A tab', async () => {
      const r = await callTool(toolsC, 'close_page', { pageId: pageA });
      if (!r.includes('NOT your tab') && !r.includes('not your tab')) {
        throw new Error(`Expected rejection, got: ${truncate(r)}`);
      }
    });

    // ── Group 8: Tab Lifecycle ──────────────────────────────────────────────
    await step('Lifecycle', 'Agent A: close own tab', async () => {
      const r = await callTool(toolsA, 'close_page', { pageId: pageA });
      if (r.includes('Error:') && !r.includes('externally')) throw new Error(truncate(r));
    });
    await step('Lifecycle', 'Agent B: page A gone from list', async () => {
      await sleep(300);
      const r = await callTool(toolsB, 'list_pages');
      if (new RegExp(`^${pageA}:\\s`, 'm').test(r)) throw new Error(`Page ${pageA} still in list`);
      if (!new RegExp(`^${pageB}:\\s`, 'm').test(r)) throw new Error(`Own page ${pageB} missing`);
    });
    await step('Lifecycle', 'Agent C: create new tab', async () => {
      const r = await callTool(toolsC, 'new_page', { url: 'https://example.com', background: true });
      const newId = parsePageId(r);
      if (!newId || newId === pageA) throw new Error(`Bad new pageId: ${newId}`);
    });
  } finally {
    // Cleanup all test agent state
    for (const agentId of agentIds) {
      try {
        const tools = createTestAgentTools(bridge, bsm, agentId);
        const list = await callTool(tools, 'list_pages');
        const entries = [...list.matchAll(/^(\d+):.*YOUR TAB/gm)];
        for (const e of entries) {
          const pid = parseInt(e[1], 10);
          await callTool(tools, 'close_page', { pageId: pid }).catch(() => {});
        }
      } catch { /* ignore */ }
      bsm.cleanupAgent(agentId);
    }
  }

  const passed = steps.filter((s) => s.passed).length;
  const failed = steps.filter((s) => !s.passed).length;
  return {
    connected: true,
    steps,
    totalDurationMs: Date.now() - t0,
    passed,
    failed,
    summary: `${passed}/${passed + failed} passed`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chaos Test
// ═══════════════════════════════════════════════════════════════════════════════

interface ChaosAgent {
  name: string;
  agentId: string;
  tabs: Array<{ pageId: number; url: string; keywords: string[] }>;
  currentTabIndex: number;
  tools: Map<string, AgentToolHandler>;
}

type OpType =
  | 'new_page' | 'select_page' | 'navigate_url' | 'navigate_reload'
  | 'take_snapshot' | 'take_screenshot' | 'eval_title' | 'eval_url'
  | 'wait_for' | 'press_key' | 'list_pages' | 'close_page'
  | 'security_close' | 'security_select';

interface WeightedOp { op: OpType; weight: number; precondition: (a: ChaosAgent, all: ChaosAgent[]) => boolean }

const OP_POOL: WeightedOp[] = [
  { op: 'new_page',          weight: 10, precondition: (a) => a.tabs.length < 4 },
  { op: 'select_page',       weight: 8,  precondition: (a) => a.tabs.length >= 2 },
  { op: 'navigate_url',      weight: 12, precondition: (a) => a.tabs.length >= 1 },
  { op: 'navigate_reload',   weight: 5,  precondition: (a) => a.tabs.length >= 1 },
  { op: 'take_snapshot',     weight: 18, precondition: (a) => a.tabs.length >= 1 },
  { op: 'take_screenshot',   weight: 8,  precondition: (a) => a.tabs.length >= 1 },
  { op: 'eval_title',        weight: 12, precondition: (a) => a.tabs.length >= 1 },
  { op: 'eval_url',          weight: 10, precondition: (a) => a.tabs.length >= 1 },
  { op: 'wait_for',          weight: 5,  precondition: (a) => a.tabs.length >= 1 && a.tabs[a.currentTabIndex]?.keywords.length > 0 },
  { op: 'press_key',         weight: 3,  precondition: (a) => a.tabs.length >= 1 },
  { op: 'list_pages',        weight: 5,  precondition: () => true },
  { op: 'close_page',        weight: 5,  precondition: (a) => a.tabs.length >= 1 },
  { op: 'security_close',    weight: 3,  precondition: (_, all) => all.some((a) => a.tabs.length > 0) },
  { op: 'security_select',   weight: 3,  precondition: (_, all) => all.some((a) => a.tabs.length > 0) },
];

function pickRandomOp(agent: ChaosAgent, allAgents: ChaosAgent[]): OpType {
  const eligible = OP_POOL.filter((o) => o.precondition(agent, allAgents.filter((a) => a !== agent)));
  if (eligible.length === 0) return 'new_page';
  const totalWeight = eligible.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * totalWeight;
  for (const o of eligible) {
    r -= o.weight;
    if (r <= 0) return o.op;
  }
  return eligible[eligible.length - 1].op;
}

function pickOtherAgentWithTabs(agent: ChaosAgent, allAgents: ChaosAgent[]): ChaosAgent | null {
  const others = allAgents.filter((a) => a !== agent && a.tabs.length > 0);
  return others.length > 0 ? others[Math.floor(Math.random() * others.length)] : null;
}

async function executeChaosOp(
  op: OpType,
  agent: ChaosAgent,
  allAgents: ChaosAgent[],
): Promise<{ target: string; result: string; passed: boolean; error?: string }> {
  const tools = agent.tools;
  const currentTab = agent.tabs[agent.currentTabIndex];

  switch (op) {
    case 'new_page': {
      const url = SITE_POOL[Math.floor(Math.random() * SITE_POOL.length)];
      const r = await callTool(tools, 'new_page', { url, background: true });
      const pid = parsePageId(r);
      if (!pid) return { target: url, result: r, passed: false, error: `Failed to parse pageId from: ${truncate(r)}` };
      const kw = getKeywords(url);
      agent.tabs.push({ pageId: pid, url, keywords: kw });
      agent.currentTabIndex = agent.tabs.length - 1;
      return { target: `${url} -> pageId:${pid}`, result: truncate(r), passed: true };
    }

    case 'select_page': {
      const otherIdx = agent.tabs.findIndex((_, i) => i !== agent.currentTabIndex);
      if (otherIdx < 0) return { target: 'no other tab', result: '', passed: true };
      const tab = agent.tabs[otherIdx];
      const r = await callTool(tools, 'select_page', { pageId: tab.pageId });
      if (r.includes('Error') || r.includes('NOT your tab')) {
        return { target: `pageId:${tab.pageId}`, result: truncate(r), passed: false, error: truncate(r) };
      }
      agent.currentTabIndex = otherIdx;
      const urlCheck = await callTool(tools, 'evaluate_script', { expression: 'document.URL' });
      const urlMatches = urlCheck.includes(new URL(tab.url).hostname);
      if (!urlMatches) {
        return { target: `pageId:${tab.pageId}`, result: truncate(urlCheck), passed: false,
          error: `After select, URL is ${truncate(urlCheck)} but expected ${tab.url}` };
      }
      return { target: `pageId:${tab.pageId}`, result: truncate(r), passed: true };
    }

    case 'navigate_url': {
      const url = SITE_POOL[Math.floor(Math.random() * SITE_POOL.length)];
      const r = await callTool(tools, 'navigate_page', { url });
      if (r.includes('Error:')) return { target: url, result: truncate(r), passed: false, error: truncate(r) };
      if (currentTab) {
        // Verify actual URL after navigation instead of optimistic update
        const actualUrl = await callTool(tools, 'evaluate_script', { expression: 'document.URL' });
        if (!actualUrl.includes('Error:')) {
          currentTab.url = actualUrl.trim();
          currentTab.keywords = getKeywords(actualUrl);
        } else {
          currentTab.url = url;
          currentTab.keywords = getKeywords(url);
        }
      }
      return { target: url, result: truncate(r), passed: true };
    }

    case 'navigate_reload': {
      const r = await callTool(tools, 'navigate_page', { action: 'reload' });
      if (r.includes('Error:')) return { target: 'reload', result: truncate(r), passed: false, error: truncate(r) };
      return { target: 'reload', result: truncate(r), passed: true };
    }

    case 'take_snapshot': {
      const r = await callTool(tools, 'take_snapshot');
      if (r.includes('Error:')) return { target: currentTab?.url ?? '?', result: truncate(r), passed: false, error: truncate(r) };
      if (currentTab) {
        const hasKeyword = currentTab.keywords.some((kw) => r.toLowerCase().includes(kw.toLowerCase()));
        if (!hasKeyword) {
          return { target: currentTab.url, result: truncate(r, 200), passed: false,
            error: `Expected keywords [${currentTab.keywords.join(', ')}] not found in snapshot` };
        }
      }
      return { target: currentTab?.url ?? '?', result: truncate(r, 200), passed: true };
    }

    case 'take_screenshot': {
      const r = await callTool(tools, 'take_screenshot');
      if (r.includes('Error:')) return { target: currentTab?.url ?? '?', result: truncate(r, 100), passed: false, error: truncate(r) };
      const ok = r.length > 100;
      return { target: currentTab?.url ?? '?', result: `${r.length} chars`, passed: ok,
        error: ok ? undefined : `Screenshot too short: ${r.length} chars` };
    }

    case 'eval_title': {
      const r = await callTool(tools, 'evaluate_script', { expression: 'document.title' });
      if (r.includes('Error:')) return { target: currentTab?.url ?? '?', result: truncate(r), passed: false, error: truncate(r) };
      if (currentTab && r.length > 0) {
        // Only validate hostname match when the page actually has a title.
        // Some test pages (e.g. httpbin.org/html) have no <title> tag.
        const hostname = new URL(currentTab.url).hostname.replace('www.', '').split('.')[0];
        const match = r.toLowerCase().includes(hostname.toLowerCase());
        if (!match) {
          return { target: currentTab.url, result: truncate(r), passed: false,
            error: `Title "${truncate(r, 80)}" doesn't contain hostname "${hostname}"` };
        }
      }
      return { target: currentTab?.url ?? '?', result: truncate(r), passed: true };
    }

    case 'eval_url': {
      const r = await callTool(tools, 'evaluate_script', { expression: 'document.URL' });
      if (r.includes('Error:')) return { target: currentTab?.url ?? '?', result: truncate(r), passed: false, error: truncate(r) };
      if (currentTab) {
        const expected = new URL(currentTab.url).hostname;
        if (!r.includes(expected)) {
          return { target: currentTab.url, result: truncate(r), passed: false,
            error: `URL "${truncate(r, 80)}" doesn't contain "${expected}"` };
        }
      }
      return { target: currentTab?.url ?? '?', result: truncate(r), passed: true };
    }

    case 'wait_for': {
      if (!currentTab || currentTab.keywords.length === 0) return { target: '?', result: 'skip', passed: true };
      const kw = currentTab.keywords[0];
      const r = await callTool(tools, 'wait_for', { text: kw, timeout: 8000 });
      const found = !r.toLowerCase().includes('not found') && !r.includes('Error:');
      return { target: `"${kw}"`, result: truncate(r), passed: found,
        error: found ? undefined : `wait_for "${kw}" failed: ${truncate(r)}` };
    }

    case 'press_key': {
      const r = await callTool(tools, 'press_key', { key: 'Tab' });
      const ok = !r.includes('Error:');
      return { target: 'Tab', result: truncate(r), passed: ok, error: ok ? undefined : truncate(r) };
    }

    case 'list_pages': {
      const r = await callTool(tools, 'list_pages');
      if (r.includes('Error:')) return { target: 'list', result: truncate(r), passed: false, error: truncate(r) };
      let ok = true;
      let err: string | undefined;
      for (const tab of agent.tabs) {
        if (!new RegExp(`^${tab.pageId}:\\s`, 'm').test(r)) {
          ok = false;
          err = `Own page ${tab.pageId} missing from list`;
          break;
        }
      }
      return { target: `${agent.tabs.length} tabs`, result: truncate(r, 200), passed: ok, error: err };
    }

    case 'close_page': {
      const idx = Math.floor(Math.random() * agent.tabs.length);
      const tab = agent.tabs[idx];
      const r = await callTool(tools, 'close_page', { pageId: tab.pageId });
      const ok = !r.includes('Error:') || r.includes('externally');
      agent.tabs.splice(idx, 1);
      if (agent.tabs.length === 0) {
        agent.currentTabIndex = 0;
      } else if (idx < agent.currentTabIndex) {
        // Removed tab was before current → shift index down to stay on same tab
        agent.currentTabIndex--;
      } else if (agent.currentTabIndex >= agent.tabs.length) {
        agent.currentTabIndex = agent.tabs.length - 1;
      }
      return { target: `pageId:${tab.pageId}`, result: truncate(r), passed: ok, error: ok ? undefined : truncate(r) };
    }

    case 'security_close': {
      const victim = pickOtherAgentWithTabs(agent, allAgents);
      if (!victim) return { target: 'no victim', result: 'skip', passed: true };
      const victimTab = victim.tabs[Math.floor(Math.random() * victim.tabs.length)];
      const r = await callTool(tools, 'close_page', { pageId: victimTab.pageId });
      const rejected = r.toLowerCase().includes('not your tab');
      return { target: `${victim.name}:pageId:${victimTab.pageId}`, result: truncate(r), passed: rejected,
        error: rejected ? undefined : `Expected "NOT your tab" rejection, got: ${truncate(r)}` };
    }

    case 'security_select': {
      const victim = pickOtherAgentWithTabs(agent, allAgents);
      if (!victim) return { target: 'no victim', result: 'skip', passed: true };
      const victimTab = victim.tabs[Math.floor(Math.random() * victim.tabs.length)];
      const r = await callTool(tools, 'select_page', { pageId: victimTab.pageId });
      const rejected = r.toLowerCase().includes('not your tab');
      return { target: `${victim.name}:pageId:${victimTab.pageId}`, result: truncate(r), passed: rejected,
        error: rejected ? undefined : `Expected "NOT your tab" rejection, got: ${truncate(r)}` };
    }

    default:
      return { target: '?', result: 'unknown op', passed: false, error: `Unknown op: ${op}` };
  }
}

async function runAgentLoop(
  agent: ChaosAgent,
  allAgents: ChaosAgent[],
  deadline: number,
  queue: ChaosEvent[],
  signal?: AbortSignal,
): Promise<void> {
  while (Date.now() < deadline && !signal?.aborted) {
    const op = pickRandomOp(agent, allAgents);
    const t0 = Date.now();
    try {
      const res = await executeChaosOp(op, agent, allAgents);
      queue.push({
        type: 'op',
        agent: agent.name,
        op,
        target: res.target,
        passed: res.passed,
        durationMs: Date.now() - t0,
        error: res.error,
        detail: res.result,
        timestamp: Date.now(),
      });
    } catch (err) {
      queue.push({
        type: 'op',
        agent: agent.name,
        op,
        target: '?',
        passed: false,
        durationMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
    }
    await sleep(50 + Math.random() * 150);
  }

  // Cleanup: close all owned tabs
  for (const tab of [...agent.tabs]) {
    try {
      await callTool(agent.tools, 'close_page', { pageId: tab.pageId });
    } catch { /* ignore cleanup errors */ }
  }
  agent.tabs.length = 0;
}

export async function* runChaosBrowserTest(
  bridge: MarkusBrowserBridge,
  bsm: BrowserSessionManager,
  opts: { durationMs?: number; agentCount?: number; signal?: AbortSignal },
): AsyncGenerator<ChaosEvent> {
  if (!bridge.connected) throw new Error('Extension not connected');

  const count = Math.min(opts.agentCount ?? 3, 5);
  const agents: ChaosAgent[] = Array.from({ length: count }, (_, i) => {
    const agentId = `__test-chaos-${i + 1}__`;
    return {
      name: `Agent-${i + 1}`,
      agentId,
      tabs: [],
      currentTabIndex: 0,
      tools: createTestAgentTools(bridge, bsm, agentId),
    };
  });

  const deadline = Date.now() + (opts.durationMs ?? 120_000);
  const queue: ChaosEvent[] = [];
  let totalOps = 0, passedOps = 0, failedOps = 0;
  const startTime = Date.now();
  let lastStats = Date.now();

  const loops = agents.map((a) => runAgentLoop(a, agents, deadline, queue, opts.signal));
  const allDone = Promise.allSettled(loops);

  let done = false;
  allDone.then(() => { done = true; });

  while (!done) {
    while (queue.length > 0) {
      const ev = queue.shift()!;
      if (ev.type === 'op') {
        totalOps++;
        if (ev.passed) passedOps++; else failedOps++;
      }
      yield ev;
    }

    const now = Date.now();
    if (now - lastStats >= 5000) {
      const elapsed = now - startTime;
      yield {
        type: 'stats',
        elapsed,
        totalOps,
        passed: passedOps,
        failed: failedOps,
        opsPerSec: Math.round((totalOps / (elapsed / 1000)) * 100) / 100,
      };
      lastStats = now;
    }

    await sleep(50);
  }

  // Drain remaining
  while (queue.length > 0) {
    const ev = queue.shift()!;
    if (ev.type === 'op') {
      totalOps++;
      if (ev.passed) passedOps++; else failedOps++;
    }
    yield ev;
  }

  // Cleanup BrowserSessionManager state
  for (const a of agents) {
    bsm.cleanupAgent(a.agentId);
  }

  yield {
    type: 'done',
    totalOps,
    passed: passedOps,
    failed: failedOps,
    elapsed: Date.now() - startTime,
  };
}
