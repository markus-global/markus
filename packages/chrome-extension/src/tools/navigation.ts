/**
 * Navigation tools: new_page, close_page, list_pages, select_page, navigate_page, wait_for
 *
 * These use chrome.tabs API for tab management and chrome.debugger
 * for CDP-level navigation control.
 */

import type { PageManager } from '../page-manager.js';
import { ensureDebugger } from '../debugger-helper.js';

/** Helper: send CDP command on a tab */
async function cdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/** Helper: wait for page load after navigation */
async function waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
  // Check if already loaded before registering listener (avoids race condition)
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
  } catch { return; }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Double-check after listener is registered (another race window)
    chrome.tabs.get(tabId).then(t => {
      if (t.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    });
  });
}

export function registerNavigationTools(
  register: (name: string, handler: (params: Record<string, unknown>) => Promise<string>) => void,
  pm: PageManager,
): void {

  register('new_page', async (params) => {
    const url = (params.url as string) || 'about:blank';
    const background = params.background === true;
    const timeout = (params.timeout as number) || 15000;

    const tab = await chrome.tabs.create({ url, active: !background });
    if (!tab.id) throw new Error('Failed to create tab');

    const pageId = pm.getPageId(tab.id);
    pm.selectPage(pageId);

    if (url !== 'about:blank') {
      await waitForLoad(tab.id, timeout);
    }

    const updatedTab = await chrome.tabs.get(tab.id);
    return formatPageList([{ pageId, tab: updatedTab, selected: true }]);
  });

  register('open_page', async (params) => {
    const url = (params.url as string) || 'about:blank';
    const background = params.background === true;
    const timeout = (params.timeout as number) || 15000;

    const tab = await chrome.tabs.create({ url, active: !background });
    if (!tab.id) throw new Error('Failed to create tab');

    const pageId = pm.getPageId(tab.id);
    pm.selectPage(pageId);

    if (url !== 'about:blank') {
      await waitForLoad(tab.id, timeout);
    }

    const updatedTab = await chrome.tabs.get(tab.id);
    return formatPageList([{ pageId, tab: updatedTab, selected: true }]);
  });

  register('close_page', async (params) => {
    const pageId = params.pageId as number;
    if (pageId === undefined) throw new Error('pageId is required');

    const tabId = pm.getTabId(pageId);
    if (tabId === undefined) throw new Error(`Page ${pageId} not found`);

    if (pm.isDebuggerAttached(tabId)) {
      try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
    }
    await chrome.tabs.remove(tabId);
    pm.removePage(pageId);

    return `Closed page ${pageId}`;
  });

  register('list_pages', async (params) => {
    const tabs = await chrome.tabs.query({});
    const entries: Array<{ pageId: number; tab: chrome.tabs.Tab; selected: boolean }> = [];
    const explicitPageId = params._pageId as number | undefined;

    for (const tab of tabs) {
      if (!tab.id || tab.id === chrome.tabs.TAB_ID_NONE) continue;
      const pageId = pm.getPageId(tab.id);
      const isSelected = explicitPageId !== undefined
        ? pageId === explicitPageId
        : pageId === pm.selectedPageId;
      entries.push({ pageId, tab, selected: isSelected });
    }

    entries.sort((a, b) => a.pageId - b.pageId);
    return formatPageList(entries);
  });

  register('select_page', async (params) => {
    const pageId = params.pageId as number;
    if (pageId === undefined) throw new Error('pageId is required');

    const tabId = pm.getTabId(pageId);
    if (tabId === undefined) throw new Error(`Page ${pageId} not found`);

    pm.selectPage(pageId);

    const bringToFront = params.bringToFront !== false;
    if (bringToFront) {
      await chrome.tabs.update(tabId, { active: true });
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    }

    const tab = await chrome.tabs.get(tabId);
    return formatPageList([{ pageId, tab, selected: true }]);
  });

  register('navigate_page', async (params) => {
    const url = params.url as string | undefined;
    const timeout = (params.timeout as number) || 15000;

    const tabId = pm.resolveTabId(params);

    if (url) {
      await ensureDebugger(pm, tabId);
      await cdp(tabId, 'Page.navigate', { url });
      await waitForLoad(tabId, timeout);
    } else if (params.action === 'back') {
      await ensureDebugger(pm, tabId);
      await cdp(tabId, 'Page.navigateToHistoryEntry', { entryId: -1 }).catch(() => {
        return chrome.tabs.goBack(tabId);
      });
    } else if (params.action === 'forward') {
      await ensureDebugger(pm, tabId);
      await cdp(tabId, 'Page.navigateToHistoryEntry', { entryId: 1 }).catch(() => {
        return chrome.tabs.goForward(tabId);
      });
    } else if (params.action === 'reload') {
      await chrome.tabs.reload(tabId);
      await waitForLoad(tabId, timeout);
    }

    const tab = await chrome.tabs.get(tabId);
    const pageId = pm.getPageId(tabId);
    return formatPageList([{ pageId, tab, selected: true }]);
  });

  register('wait_for', async (params) => {
    const text = params.text as string;
    const timeout = (params.timeout as number) || 30000;
    if (!text) throw new Error('text parameter is required');

    const tabId = pm.resolveTabId(params);

    await ensureDebugger(pm, tabId);

    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const result = await cdp(tabId, 'Runtime.evaluate', {
        expression: `document.body?.innerText?.includes(${JSON.stringify(text)}) ?? false`,
        returnByValue: true,
      }) as { result?: { value?: boolean } };

      if (result?.result?.value === true) {
        return `Found text "${text}" on page`;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    throw new Error(`Text "${text}" not found within ${timeout}ms`);
  });
}

function formatPageList(entries: Array<{ pageId: number; tab: chrome.tabs.Tab; selected: boolean }>): string {
  if (entries.length === 0) return 'No pages open';
  return entries.map(e => {
    const url = e.tab.url || e.tab.pendingUrl || 'about:blank';
    const sel = e.selected ? ' [selected]' : '';
    return `${e.pageId}: ${url}${sel}`;
  }).join('\n');
}
