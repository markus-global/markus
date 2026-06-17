import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserSessionManager } from '../src/tools/browser-session.js';
import type { AgentToolHandler } from '../src/agent.js';

function makeHandler(name: string, fn?: (args: Record<string, unknown>) => string | Promise<string>): AgentToolHandler {
  return {
    name: `chrome-devtools__${name}`,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    execute: fn ? async (args) => fn(args) : async () => 'ok',
  };
}

describe('BrowserSessionManager', () => {
  let bsm: BrowserSessionManager;
  const agentId = 'agent-1';
  const sessionA = 'session-a';
  const sessionB = 'session-b';

  beforeEach(() => {
    bsm = new BrowserSessionManager();
  });

  it('handleTabClosed removes page from ownership and currentPage', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '2: https://example.com [selected]\n'),
      makeHandler('list_pages', () => '2: https://example.com [selected]\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://example.com' });
    expect(bsm.getOwnedTabIds(agentId, sessionA)).toEqual([2]);

    bsm.handleTabClosed(2);
    expect(bsm.getOwnedTabIds(agentId, sessionA)).toEqual([]);
  });

  it('handleTabClosed ignores undefined pageId', () => {
    expect(() => bsm.handleTabClosed(undefined)).not.toThrow();
  });

  it('select_page rejects pages not owned by session', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '1: https://a.com [selected]\n'),
      makeHandler('select_page', () => 'Selected page 2\n'),
      makeHandler('list_pages', () => '1: https://a.com\n2: https://b.com\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://a.com' });

    const select = handlers.find(h => h.name.endsWith('__select_page'))!;
    const result = await select.execute({ _browserSessionId: sessionA, pageId: 2 });
    expect(result).toContain('NOT your tab');
    expect(JSON.parse(result).error).toContain('Cannot select page 2');
  });

  it('list_pages annotates owned vs foreign tabs', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '1: https://a.com [selected]\n'),
      makeHandler('list_pages', () => '1: https://a.com [selected]\n2: https://b.com\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://a.com' });

    const list = handlers.find(h => h.name.endsWith('__list_pages'))!;
    const result = await list.execute({ _browserSessionId: sessionA });
    expect(result).toContain('-- YOUR TAB');
    expect(result).toContain('-- NOT YOUR TAB');
  });

  it('isolates tab ownership between sessions', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', (args) => {
        const url = String(args.url ?? '');
        return url.includes('a.com')
          ? '1: https://a.com [selected]\n'
          : '2: https://b.com [selected]\n';
      }),
      makeHandler('list_pages', () => '1: https://a.com\n2: https://b.com\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://a.com' });
    await newPage.execute({ _browserSessionId: sessionB, url: 'https://b.com' });

    expect(bsm.getOwnedTabIds(agentId, sessionA)).toEqual([1]);
    expect(bsm.getOwnedTabIds(agentId, sessionB)).toEqual([2]);
  });

  it('reconnects MCP on stale page error and retries', async () => {
    let calls = 0;
    const reconnect = vi.fn(async () => {});
    bsm.setReconnector(agentId, 'chrome-devtools', reconnect);

    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => {
        calls++;
        if (calls === 1) return 'The selected page has been closed';
        return '3: https://fresh.com [selected]\n';
      }),
      makeHandler('list_pages', () => '3: https://fresh.com [selected]\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    const result = await newPage.execute({ _browserSessionId: sessionA, url: 'https://fresh.com' });
    expect(reconnect).toHaveBeenCalledOnce();
    expect(result).toContain('YOUR TAB');
    expect(bsm.getOwnedTabIds(agentId, sessionA)).toEqual([3]);
  });

  it('respects bringToFront and autoCloseTabs settings', () => {
    bsm.bringToFront = true;
    bsm.autoCloseTabs = false;
    expect(bsm.bringToFront).toBe(true);
    expect(bsm.autoCloseTabs).toBe(false);
  });

  it('cleanupAgent clears all state for agent', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '1: https://example.com [selected]\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://example.com' });
    expect(bsm.getOwnedTabIds(agentId, sessionA)).toEqual([1]);

    bsm.cleanupAgent(agentId);
    expect(bsm.getOwnedTabIds(agentId, sessionA)).toEqual([]);
  });

  it('close_page removes page from ownership', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '1: https://example.com [selected]\n'),
      makeHandler('close_page', () => 'Closed page 1\n'),
      makeHandler('list_pages', () => ''),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://example.com' });

    const close = handlers.find(h => h.name.endsWith('__close_page'))!;
    await close.execute({ _browserSessionId: sessionA, pageId: 1 });
    expect(bsm.getOwnedTabIds(agentId, sessionA)).toEqual([]);
  });

  it('open_page assigns ownership like new_page', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('open_page', () => '5: https://open.example.com [selected]\n'),
      makeHandler('list_pages', () => '5: https://open.example.com [selected]\n'),
    ], agentId);

    const openPage = handlers.find(h => h.name.endsWith('__open_page'))!;
    await openPage.execute({ _browserSessionId: sessionA, url: 'https://open.example.com' });
    expect(bsm.getOwnedTabIds(agentId, sessionA)).toEqual([5]);
  });

  it('navigate_page auto-creates tab when session has no owned pages', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '2: https://auto.com [selected]\n'),
      makeHandler('navigate_page', () => 'Navigated\n'),
      makeHandler('list_pages', () => '2: https://auto.com [selected]\n'),
    ], agentId);

    const navigate = handlers.find(h => h.name.endsWith('__navigate_page'))!;
    const result = await navigate.execute({ _browserSessionId: sessionA, url: 'https://auto.com' });
    expect(result).toContain('YOUR TAB');
    expect(bsm.getOwnedTabIds(agentId, sessionA)).toEqual([2]);
  });

  it('navigate_page rejects when no URL and no owned tabs', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('navigate_page', () => 'Navigated\n'),
    ], agentId);

    const navigate = handlers.find(h => h.name.endsWith('__navigate_page'))!;
    const result = await navigate.execute({ _browserSessionId: sessionA, action: 'reload' });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('no URL provided');
  });

  it('generic tool rejects when session has no owned tabs', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('click', () => 'Clicked\n'),
    ], agentId);

    const click = handlers.find(h => h.name.endsWith('__click'))!;
    const result = await click.execute({ _browserSessionId: sessionA, uid: 'btn-1' });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('no owned tabs');
  });

  it('generic tool rejects foreign pageId', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '1: https://a.com [selected]\n'),
      makeHandler('click', () => 'Clicked\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://a.com' });

    const click = handlers.find(h => h.name.endsWith('__click'))!;
    const result = await click.execute({ _browserSessionId: sessionA, pageId: 99, uid: 'btn-1' });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('NOT your tab');
  });

  it('close_page handles stale page with reconnect and remaining tabs message', async () => {
    const reconnect = vi.fn(async () => {});
    bsm.setReconnector(agentId, 'chrome-devtools', reconnect);

    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '1: https://a.com [selected]\n2: https://b.com\n'),
      makeHandler('close_page', () => 'The selected page has been closed'),
      makeHandler('list_pages', () => '2: https://b.com [selected]\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://a.com' });
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://b.com' });

    const close = handlers.find(h => h.name.endsWith('__close_page'))!;
    const result = await close.execute({ _browserSessionId: sessionA, pageId: 1 });
    expect(reconnect).toHaveBeenCalled();
    expect(result).toContain('closed externally');
  });

  it('select_page stale error returns externally closed guidance after reconnect', async () => {
    let calls = 0;
    const reconnect = vi.fn(async () => {});
    bsm.setReconnector(agentId, 'chrome-devtools', reconnect);

    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '1: https://example.com [selected]\n'),
      makeHandler('select_page', () => {
        calls++;
        if (calls === 1) return 'The selected page has been closed';
        return 'Selected page 1\n';
      }),
      makeHandler('list_pages', () => '1: https://example.com [selected]\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://example.com' });

    const select = handlers.find(h => h.name.endsWith('__select_page'))!;
    const result = await select.execute({ _browserSessionId: sessionA, pageId: 1 });
    expect(reconnect).toHaveBeenCalled();
    expect(result).toContain('closed externally');
  });

  it('generic tool stale page error clears ownership after reconnect', async () => {
    const reconnect = vi.fn(async () => {});
    bsm.setReconnector(agentId, 'chrome-devtools', reconnect);

    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '1: https://example.com [selected]\n'),
      makeHandler('click', () => 'The selected page has been closed'),
      makeHandler('list_pages', () => ''),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://example.com' });

    const click = handlers.find(h => h.name.endsWith('__click'))!;
    const result = await click.execute({ _browserSessionId: sessionA, uid: 'x' });
    expect(reconnect).toHaveBeenCalled();
    expect(result).toContain('closed externally');
    expect(bsm.getOwnedTabIds(agentId, sessionA)).toEqual([]);
  });

  it('reconnect failure leaves original stale error result', async () => {
    let calls = 0;
    bsm.setReconnector(agentId, 'chrome-devtools', vi.fn(async () => { throw new Error('reconnect failed'); }));

    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => {
        calls++;
        if (calls === 1) return 'The selected page has been closed';
        return '1: https://example.com [selected]\n';
      }),
      makeHandler('list_pages', () => '1: https://example.com [selected]\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    const result = await newPage.execute({ _browserSessionId: sessionA, url: 'https://example.com' });
    expect(result).toContain('The selected page has been closed');
  });

  it('navigate_page on owned tab delegates to handler', async () => {
    const navigateFn = vi.fn(async () => 'Navigated to https://target.com\n');
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '1: https://start.com [selected]\n'),
      makeHandler('navigate_page', navigateFn),
      makeHandler('list_pages', () => '1: https://target.com [selected]\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://start.com' });

    const navigate = handlers.find(h => h.name.endsWith('__navigate_page'))!;
    await navigate.execute({ _browserSessionId: sessionA, url: 'https://target.com' });
    expect(navigateFn).toHaveBeenCalled();
  });

  it('consumeCloseTabsReminder returns one-time reminder after browser use', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '1: https://example.com [selected]\n'),
      makeHandler('click', () => 'Clicked\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://example.com' });

    const click = handlers.find(h => h.name.endsWith('__click'))!;
    await click.execute({ _browserSessionId: sessionA, uid: 'btn' });

    const reminder = bsm.consumeCloseTabsReminder(agentId, sessionA);
    expect(reminder).toContain('close any tabs');
    expect(reminder).toContain('1');
    expect(bsm.consumeCloseTabsReminder(agentId, sessionA)).toBeNull();
  });

  it('wrapNewPage sets background=false when bringToFront is enabled', async () => {
    bsm.bringToFront = true;
    const newPageFn = vi.fn(async (args: Record<string, unknown>) => {
      expect(args.background).toBe(false);
      return '2: https://front.com [selected]\n';
    });
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', newPageFn),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://front.com' });
  });

  it('close_page rejects foreign tabs with JSON error', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '1: https://a.com [selected]\n'),
      makeHandler('close_page', () => 'Closed\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://a.com' });

    const close = handlers.find(h => h.name.endsWith('__close_page'))!;
    const result = await close.execute({ _browserSessionId: sessionA, pageId: 99 });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('NOT your tab');
  });

  it('navigate_page stale error on owned tab triggers reconnect', async () => {
    const reconnect = vi.fn(async () => {});
    bsm.setReconnector(agentId, 'chrome-devtools', reconnect);

    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '1: https://start.com [selected]\n'),
      makeHandler('navigate_page', () => 'The selected page has been closed'),
      makeHandler('list_pages', () => '2: https://fresh.com [selected]\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://start.com' });

    const navigate = handlers.find(h => h.name.endsWith('__navigate_page'))!;
    const result = await navigate.execute({ _browserSessionId: sessionA, url: 'https://fresh.com' });
    expect(reconnect).toHaveBeenCalled();
    expect(result).toContain('YOUR TAB');
  });

  it('navigate_page without new_page handler returns error JSON', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('navigate_page', () => 'Navigated\n'),
    ], agentId);

    const navigate = handlers.find(h => h.name.endsWith('__navigate_page'))!;
    const result = await navigate.execute({ _browserSessionId: sessionA, url: 'https://solo.com' });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('new_page tool unavailable');
  });

  it('handleTabClosed clears currentPage pointer', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', () => '4: https://tab.com [selected]\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionA, url: 'https://tab.com' });
    expect(bsm.getOwnedTabIds(agentId, sessionA)).toEqual([4]);

    bsm.handleTabClosed(4);
    expect(bsm.getOwnedTabIds(agentId, sessionA)).toEqual([]);
  });
});
