import { describe, it, expect, beforeEach } from 'vitest';
import { BrowserSessionManager } from '../src/tools/browser-session.js';
import type { AgentToolHandler } from '../src/agent.js';

function makeHandler(name: string, result: string): AgentToolHandler {
  return {
    name: `chrome-devtools__${name}`,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => result,
  };
}

describe('BrowserSessionManager close-tabs reminder', () => {
  let bsm: BrowserSessionManager;
  const agentId = 'agent-1';
  const sessionId = 'session-1';

  beforeEach(() => {
    bsm = new BrowserSessionManager();
  });

  it('returns null when browser was not used', () => {
    expect(bsm.consumeCloseTabsReminder(agentId, sessionId)).toBeNull();
  });

  it('returns null when browser was used but no owned tabs remain', () => {
    bsm.markBrowserUsed(`${agentId}::${sessionId}`);
    expect(bsm.consumeCloseTabsReminder(agentId, sessionId)).toBeNull();
  });

  it('returns reminder once when browser was used and owned tabs remain', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', '1: https://example.com [selected]\n'),
      makeHandler('list_pages', '1: https://example.com [selected]\n'),
      makeHandler('close_page', 'Closed page 1\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionId, url: 'https://example.com' });

    expect(bsm.getOwnedTabIds(agentId, sessionId)).toEqual([1]);

    const first = bsm.consumeCloseTabsReminder(agentId, sessionId);
    expect(first).toContain('[SYSTEM]');
    expect(first).toContain('close_page');
    expect(first).toContain('[1]');

    const second = bsm.consumeCloseTabsReminder(agentId, sessionId);
    expect(second).toBeNull();
  });

  it('does not remind after all owned tabs are closed', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', '1: https://example.com [selected]\n'),
      makeHandler('list_pages', '1: https://example.com [selected]\n'),
      makeHandler('close_page', 'Closed page 1\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionId, url: 'https://example.com' });

    const listPages = handlers.find(h => h.name.endsWith('__list_pages'))!;
    await listPages.execute({ _browserSessionId: sessionId });

    const closePage = handlers.find(h => h.name.endsWith('__close_page'))!;
    await closePage.execute({ _browserSessionId: sessionId, pageId: 1 });

    expect(bsm.getOwnedTabIds(agentId, sessionId)).toEqual([]);
    expect(bsm.consumeCloseTabsReminder(agentId, sessionId)).toBeNull();
  });

  it('marks browser used on navigate_page and generic tools', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', '1: https://example.com [selected]\n'),
      makeHandler('navigate_page', 'Navigated to https://example.com\n'),
      makeHandler('click', 'Clicked element\n'),
      makeHandler('list_pages', '1: https://example.com [selected]\n'),
    ], agentId);

    const navigate = handlers.find(h => h.name.endsWith('__navigate_page'))!;
    await navigate.execute({ _browserSessionId: sessionId, url: 'https://example.com' });

    const click = handlers.find(h => h.name.endsWith('__click'))!;
    await click.execute({ _browserSessionId: sessionId });

    const reminder = bsm.consumeCloseTabsReminder(agentId, sessionId);
    expect(reminder).toContain('[SYSTEM]');
  });

  it('clears reminder tracking on cleanupAgent', async () => {
    const handlers = bsm.wrapToolHandlers([
      makeHandler('new_page', '1: https://example.com [selected]\n'),
    ], agentId);

    const newPage = handlers.find(h => h.name.endsWith('__new_page'))!;
    await newPage.execute({ _browserSessionId: sessionId, url: 'https://example.com' });

    expect(bsm.consumeCloseTabsReminder(agentId, sessionId)).not.toBeNull();
    expect(bsm.consumeCloseTabsReminder(agentId, sessionId)).toBeNull();

    bsm.cleanupAgent(agentId);

    await newPage.execute({ _browserSessionId: sessionId, url: 'https://example.com' });
    expect(bsm.consumeCloseTabsReminder(agentId, sessionId)).not.toBeNull();
  });
});
