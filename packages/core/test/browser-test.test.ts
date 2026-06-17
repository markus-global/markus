import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runQuickBrowserTest, runChaosBrowserTest } from '../src/tools/browser-test.js';
import { BrowserSessionManager } from '../src/tools/browser-session.js';
import type { MarkusBrowserBridge } from '../src/tools/markus-browser-bridge.js';

interface MockPage {
  id: number;
  url: string;
}

/** In-memory CDP-like browser for integration tests. */
class MockBrowserState {
  pages = new Map<number, MockPage>();
  nextId = 1;
  selectedId: number | null = null;

  pageUrl(args: Record<string, unknown> = {}): string {
    const pid = typeof args._pageId === 'number' ? args._pageId : this.selectedId;
    return pid ? (this.pages.get(pid)?.url ?? '') : '';
  }

  createPage(url: string, background = false): string {
    const id = this.nextId++;
    this.pages.set(id, { id, url });
    if (!background || this.selectedId === null) this.selectedId = id;
    return this.formatPageLine(id);
  }

  formatPageLine(id: number): string {
    const page = this.pages.get(id);
    if (!page) return '';
    const selected = this.selectedId === id ? ' [selected]' : '';
    return `${id}: ${page.url}${selected}\n`;
  }

  listPages(): string {
    let out = '';
    for (const p of this.pages.values()) {
      out += this.formatPageLine(p.id);
    }
    return out;
  }

  selectPage(pageId: number): string {
    if (!this.pages.has(pageId)) return `Error: Page ${pageId} not found`;
    this.selectedId = pageId;
    return `Selected page ${pageId}\n`;
  }

  closePage(pageId: number): string {
    if (!this.pages.has(pageId)) return `Error: Page ${pageId} not found`;
    this.pages.delete(pageId);
    if (this.selectedId === pageId) {
      const ids = [...this.pages.keys()];
      this.selectedId = ids.length > 0 ? ids[ids.length - 1]! : null;
    }
    return `Closed page ${pageId}\n`;
  }

  evaluateScript(expression: string, args: Record<string, unknown> = {}): string {
    const url = this.pageUrl(args);
    if (expression.includes('document.title')) {
      if (url.includes('jsonplaceholder')) return 'JSONPlaceholder - Free fake REST API';
      if (url.includes('example.com')) return 'Example Domain';
      return 'Page Title';
    }
    if (expression.includes('document.URL')) return url;
    if (expression.includes('querySelectorAll("a")')) return '1';
    if (expression.includes('querySelector("h1")')) {
      if (url.includes('httpbin.org/html')) return 'Herman Melville - Moby-Dick';
      return '';
    }
    return '42';
  }

  takeSnapshot(args: Record<string, unknown> = {}): string {
    const url = this.pageUrl(args);
    if (url.includes('example.com')) return 'Example Domain\n  link "More information..."';
    if (url.includes('httpbin.org/html')) return 'Herman Melville\n  heading "Moby-Dick"';
    if (url.includes('jsonplaceholder')) return 'JSONPlaceholder\n  text "jsonplaceholder"';
    return 'Generic snapshot';
  }

  takeScreenshot(): string {
    return 'data:image/png;base64,' + 'A'.repeat(200);
  }

  navigatePage(args: Record<string, unknown>): string {
    const pid = typeof args._pageId === 'number' ? args._pageId : this.selectedId;
    if (pid === null || !this.pages.has(pid)) return 'Error: no page selected';
    const page = this.pages.get(pid)!;
    if (args.action === 'reload') return 'Page reloaded\n';
    if (typeof args.url === 'string') {
      page.url = args.url;
      return `Navigated to ${args.url}\n`;
    }
    return 'Navigation complete\n';
  }

  waitFor(text: string, args: Record<string, unknown> = {}): string {
    const url = this.pageUrl(args);
    if (url.includes('httpbin.org/html') && text === 'Melville') return `Found "${text}"\n`;
    if (url.includes('example.com') && text.toLowerCase().includes('example')) return `Found "${text}"\n`;
    return `${text} not found within timeout`;
  }

  pressKey(): string {
    return 'Key pressed\n';
  }
}

function createStatefulBridge(state: MockBrowserState, connected = true): MarkusBrowserBridge {
  return {
    connected,
    callTool: async (name: string, args: Record<string, unknown>) => {
      try {
        switch (name) {
          case 'new_page':
          case 'open_page':
            return {
              content: state.createPage(
                String(args.url ?? 'about:blank'),
                args.background === true,
              ),
            };
          case 'list_pages':
            return { content: state.listPages() };
          case 'select_page':
            return { content: state.selectPage(Number(args.pageId)) };
          case 'close_page':
            return { content: state.closePage(Number(args.pageId)) };
          case 'evaluate_script':
            return { content: state.evaluateScript(String(args.expression ?? ''), args) };
          case 'take_snapshot':
            return { content: state.takeSnapshot(args) };
          case 'take_screenshot':
            return { content: state.takeScreenshot() };
          case 'navigate_page':
            return { content: state.navigatePage(args) };
          case 'wait_for':
            return { content: state.waitFor(String(args.text ?? ''), args) };
          case 'press_key':
            return { content: state.pressKey() };
          case 'click':
          case 'fill':
            return { content: 'Action completed\n' };
          default:
            return { content: `ok:${name}` };
        }
      } catch (err) {
        return { content: '', error: String(err) };
      }
    },
  } as unknown as MarkusBrowserBridge;
}

function makeBridge(connected: boolean): MarkusBrowserBridge {
  return createStatefulBridge(new MockBrowserState(), connected);
}

describe('runQuickBrowserTest', () => {
  it('returns early when extension is not connected', async () => {
    const result = await runQuickBrowserTest(makeBridge(false), new BrowserSessionManager());
    expect(result.connected).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.summary).toContain('not connected');
  });

  it('runs full quick test suite when connected', async () => {
    const state = new MockBrowserState();
    const bsm = new BrowserSessionManager();
    const result = await runQuickBrowserTest(createStatefulBridge(state), bsm);

    expect(result.connected).toBe(true);
    expect(result.steps.length).toBeGreaterThan(10);
    expect(result.passed).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
    expect(result.summary).toMatch(/\d+\/\d+ passed/);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);

    const groups = new Set(result.steps.map(s => s.group));
    expect(groups.has('Setup')).toBe(true);
    expect(groups.has('Tab Verification')).toBe(true);
    expect(groups.has('Inspection')).toBe(true);
    expect(groups.has('Isolation')).toBe(true);
    expect(groups.has('Security')).toBe(true);
    expect(groups.has('Lifecycle')).toBe(true);
  });

  it('records step failures without throwing', async () => {
    const state = new MockBrowserState();
    const bridge = createStatefulBridge(state);
    const original = bridge.callTool.bind(bridge);
    bridge.callTool = async (name, args) => {
      if (name === 'take_snapshot') return { content: 'unexpected content without keywords' };
      return original(name, args);
    };

    const result = await runQuickBrowserTest(bridge, new BrowserSessionManager());
    expect(result.connected).toBe(true);
    expect(result.failed).toBeGreaterThan(0);
    const failed = result.steps.find(s => !s.passed);
    expect(failed?.error).toBeDefined();
  });

  it('propagates bridge tool errors as step failures', async () => {
    const bridge = createStatefulBridge(new MockBrowserState());
    bridge.callTool = async (name) => {
      if (name === 'new_page') return { content: '', error: 'Extension disconnected' };
      return { content: 'ok' };
    };

    const result = await runQuickBrowserTest(bridge, new BrowserSessionManager());
    expect(result.failed).toBeGreaterThan(0);
  });
});

describe('runChaosBrowserTest', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when extension is not connected', async () => {
    const gen = runChaosBrowserTest(makeBridge(false), new BrowserSessionManager(), {
      durationMs: 100,
      agentCount: 1,
    });
    await expect(async () => {
      for await (const _ of gen) { /* drain */ }
    }).rejects.toThrow('Extension not connected');
  });

  it('yields op events and completes with done summary', async () => {
    const state = new MockBrowserState();
    const bsm = new BrowserSessionManager();
    const events = [];

    for await (const ev of runChaosBrowserTest(createStatefulBridge(state), bsm, {
      durationMs: 300,
      agentCount: 2,
    })) {
      events.push(ev);
    }

    const ops = events.filter(e => e.type === 'op');
    const done = events.find(e => e.type === 'done');
    expect(ops.length).toBeGreaterThan(0);
    expect(done).toBeDefined();
    expect(done!.type === 'done' && done!.totalOps).toBeGreaterThan(0);
    expect(done!.type === 'done' && done!.elapsed).toBeGreaterThan(0);
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    const state = new MockBrowserState();
    const events = [];

    const run = async () => {
      for await (const ev of runChaosBrowserTest(createStatefulBridge(state), new BrowserSessionManager(), {
        durationMs: 5000,
        agentCount: 1,
        signal: controller.signal,
      })) {
        events.push(ev);
        if (events.length >= 2) controller.abort();
      }
    };

    await run();
    expect(events.some(e => e.type === 'done')).toBe(true);
  });

  it('yields stats events during longer chaos runs', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.05);
    const state = new MockBrowserState();
    const bsm = new BrowserSessionManager();
    const events = [];

    for await (const ev of runChaosBrowserTest(createStatefulBridge(state), bsm, {
      durationMs: 5500,
      agentCount: 3,
    })) {
      events.push(ev);
    }

    expect(events.some(e => e.type === 'stats')).toBe(true);
    vi.restoreAllMocks();
  });
});
