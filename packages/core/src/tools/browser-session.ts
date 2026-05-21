import { createLogger } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';

const log = createLogger('browser-session');

/**
 * Hidden field injected into tool args by Agent.executeTool() so wrappers
 * can track ownership per-session rather than per-agent.
 */
const SESSION_KEY = '_browserSessionId';

/** Error substring that chrome-devtools-mcp returns when the selected page is gone. */
const STALE_PAGE_ERROR = 'The selected page has been closed';

/**
 * Tracks browser tab ownership per session and wraps chrome-devtools MCP
 * tool handlers to enforce strict tab isolation.
 *
 * chrome-devtools-mcp identifies pages by auto-incrementing numeric IDs
 * (1, 2, 3, …) returned in a "## Pages" text section. Tools like
 * `select_page` and `close_page` accept `pageId: number`.
 *
 * Ownership granularity is **per-session**: a single agent may run multiple
 * concurrent sessions (chat, tasks, heartbeats) each with their own set of
 * owned browser tabs.
 *
 * Tab contention prevention: since sessions within one agent share the same
 * MCP process, the "currently selected tab" is shared state. To prevent
 * session A's tool from accidentally operating on session B's tab, all
 * browser operations acquire a per-agent mutex and auto-select the session's
 * current page before executing. This makes "select → operate" atomic.
 *
 * Stale page recovery: when Chrome tabs are closed externally (by the user),
 * the MCP server enters a stuck state where ALL tools return "The selected
 * page has been closed". When detected, we automatically reconnect the MCP
 * server and retry the operation.
 */
export class BrowserSessionManager {
  /**
   * ownerKey → set of owned numeric page IDs.
   * ownerKey format: "agentId::sessionId" (or just "agentId" as fallback).
   */
  private ownedPages = new Map<string, Set<number>>();

  /** ownerKey → the page ID this session is currently working on. */
  private currentPage = new Map<string, number>();

  /**
   * Per-agent mutex: only one browser operation runs at a time per MCP process.
   * This prevents session A's "select → operate" from being interleaved with
   * session B's operations within the same agent.
   */
  private agentLocks = new Map<string, Promise<void>>();

  /**
   * Per-agent reference to the original (unwrapped) select_page handler.
   * Stored during wrapToolHandlers so auto-select can call it without
   * going through the ownership check wrapper.
   */
  private selectPageHandlers = new Map<string, AgentToolHandler>();
  private listPageHandlers = new Map<string, AgentToolHandler>();

  /**
   * Per-agent callback to disconnect + reconnect the MCP server process.
   * Set by agent-manager after wrapping tool handlers. When a stale page
   * error is detected, this callback is invoked to restart the MCP.
   * Since handlers look up the server by key dynamically, they automatically
   * route to the new process after reconnect.
   */
  private reconnectors = new Map<string, Map<string, () => Promise<void>>>();

  private _bringToFront = false;
  private _autoCloseTabs = true;

  get bringToFront(): boolean { return this._bringToFront; }
  set bringToFront(v: boolean) { this._bringToFront = v; }
  get autoCloseTabs(): boolean { return this._autoCloseTabs; }
  set autoCloseTabs(v: boolean) { this._autoCloseTabs = v; }

  /**
   * Register a reconnect callback for a specific MCP server of an agent.
   * Multiple servers can each have their own reconnector without overwriting.
   */
  setReconnector(agentId: string, serverKey: string, callback: () => Promise<void>): void {
    let map = this.reconnectors.get(agentId);
    if (!map) {
      map = new Map();
      this.reconnectors.set(agentId, map);
    }
    map.set(serverKey, callback);
  }

  // ─── Extension event handling ─────────────────────────────────────────────

  /**
   * Called when the Chrome extension reports a tab was closed.
   * Proactively remove the pageId from all ownership sets and currentPage
   * pointers so agents don't try to use a stale page.
   */
  handleTabClosed(pageId: number | undefined): void {
    if (pageId === undefined) return;
    for (const [key, owned] of this.ownedPages) {
      if (owned.delete(pageId)) {
        log.debug(`Removed closed page ${pageId} from ownership set ${key}`);
      }
    }
    for (const [key, val] of this.currentPage) {
      if (val === pageId) {
        this.currentPage.delete(key);
        log.debug(`Cleared currentPage pointer for ${key} (was page ${pageId})`);
      }
    }
  }

  // ─── Stale page recovery ──────────────────────────────────────────────────

  private isStalePageError(result: string): boolean {
    return result.includes(STALE_PAGE_ERROR)
      || /Page \d+ not found/.test(result);
  }

  /**
   * Reconnect the MCP server for an agent. Preserves ownership state
   * because page IDs remain stable across reconnects (Chrome stays running).
   * Only clears the currentPage pointer so the next operation re-selects.
   */
  private async reconnectMcp(agentId: string): Promise<boolean> {
    const map = this.reconnectors.get(agentId);
    const reconnect = map?.get('chrome-devtools');
    if (!reconnect) {
      log.warn(`No reconnector available for agent ${agentId}`);
      return false;
    }

    log.info(`Stale page detected for agent ${agentId} — reconnecting MCP server`);

    // Only clear currentPage and lastActive (forces re-select on next op).
    // Ownership is preserved — page IDs are stable since Chrome is still running.
    const prefix = `${agentId}::`;
    for (const key of [...this.currentPage.keys()]) {
      if (key === agentId || key.startsWith(prefix)) {
        this.currentPage.delete(key);
      }
    }
    this.lastActiveSession.delete(agentId);

    try {
      await reconnect();
      log.info(`MCP server reconnected for agent ${agentId}`);
      await this.pruneOwnedPages(agentId);
      return true;
    } catch (err) {
      log.error(`Failed to reconnect MCP server for agent ${agentId}: ${err}`);
      return false;
    }
  }

  /**
   * After reconnect, call list_pages and prune ownedPages to only valid IDs.
   * Pages that were closed while the MCP was disconnected are removed.
   */
  private async pruneOwnedPages(agentId: string): Promise<void> {
    const listHandler = this.listPageHandlers.get(agentId);
    if (!listHandler) return;

    try {
      const result = await listHandler.execute({});
      const livePages = this.parsePageEntries(result);
      const liveIds = new Set(livePages.map(p => p.id));

      const prefix = `${agentId}::`;
      for (const [key, owned] of this.ownedPages) {
        if (key === agentId || key.startsWith(prefix)) {
          for (const pageId of owned) {
            if (!liveIds.has(pageId)) {
              owned.delete(pageId);
              log.debug(`Pruned stale page ${pageId} from ${key}`);
            }
          }
        }
      }
    } catch (err) {
      log.warn(`Failed to prune owned pages for ${agentId}: ${err}`);
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.agentLocks.get(agentId) ?? Promise.resolve();
    let release: () => void;
    const gate = new Promise<void>(r => { release = r; });
    this.agentLocks.set(agentId, gate);
    await prev;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  private lastActiveSession = new Map<string, { ownerKey: string; pageId: number }>();

  private async ensureCorrectPage(agentId: string, ownerKey: string): Promise<void> {
    const pageId = this.currentPage.get(ownerKey);
    if (pageId === undefined) return;

    const last = this.lastActiveSession.get(agentId);
    if (last && last.ownerKey === ownerKey && last.pageId === pageId) {
      return;
    }

    const selectHandler = this.selectPageHandlers.get(agentId);
    if (!selectHandler) return;
    try {
      await selectHandler.execute({ pageId, bringToFront: this._bringToFront });
      this.lastActiveSession.set(agentId, { ownerKey, pageId });
    } catch (err) {
      log.warn(`Auto-select page ${pageId} failed for ${ownerKey}: ${err}`);
    }
  }

  private extractOwnerKey(agentId: string, args: Record<string, unknown>): string {
    const sessionId = args[SESSION_KEY] as string | undefined;
    delete args[SESSION_KEY];
    return sessionId ? `${agentId}::${sessionId}` : agentId;
  }

  private getOwned(ownerKey: string): Set<number> {
    let set = this.ownedPages.get(ownerKey);
    if (!set) {
      set = new Set();
      this.ownedPages.set(ownerKey, set);
    }
    return set;
  }

  private parsePageEntries(text: string): Array<{ id: number; url: string; selected: boolean }> {
    const entries: Array<{ id: number; url: string; selected: boolean }> = [];
    const regex = /^(\d+):\s+(\S+)(.*)/gm;
    let match;
    while ((match = regex.exec(text)) !== null) {
      entries.push({
        id: parseInt(match[1], 10),
        url: match[2],
        selected: match[3]?.includes('[selected]') ?? false,
      });
    }
    return entries;
  }

  private annotateResponse(result: string, ownerKey: string): string {
    const owned = this.getOwned(ownerKey);
    return result.replace(
      /^(\d+:\s+\S+.*)$/gm,
      (line) => {
        const idMatch = line.match(/^(\d+):/);
        if (!idMatch) return line;
        const id = parseInt(idMatch[1], 10);
        const tag = owned.has(id) ? ' -- YOUR TAB' : ' -- NOT YOUR TAB';
        return `${line}${tag}`;
      },
    );
  }

  private ownedPagesSummary(ownerKey: string): string {
    const owned = this.getOwned(ownerKey);
    if (owned.size === 0) return 'You currently have no owned tabs in this session. Call new_page or navigate_page to create one.';
    const ids = [...owned].join(', ');
    return `Your owned tab IDs: [${ids}] (${owned.size} total). You can only operate on these.`;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  wrapToolHandlers(handlers: AgentToolHandler[], agentId: string): AgentToolHandler[] {
    const findHandler = (name: string) =>
      handlers.find((h) => (h.name.split('__').pop() ?? h.name) === name);
    const newPageHandler = findHandler('new_page');
    const selectPageHandler = findHandler('select_page');
    const listPageHandler = findHandler('list_pages');

    if (selectPageHandler) {
      this.selectPageHandlers.set(agentId, selectPageHandler);
    }
    if (listPageHandler) {
      this.listPageHandlers.set(agentId, listPageHandler);
    }

    return handlers.map((h) => {
      const baseName = h.name.split('__').pop() ?? h.name;
      switch (baseName) {
        case 'new_page':
        case 'open_page':
          return this.wrapNewPage(h, agentId);
        case 'list_pages':
          return this.wrapListPages(h, agentId);
        case 'select_page':
          return this.wrapSelectPage(h, agentId);
        case 'close_page':
          return this.wrapClosePage(h, agentId);
        case 'navigate_page':
          return this.wrapNavigatePage(h, agentId, newPageHandler);
        default:
          return this.wrapGenericTool(h, agentId, baseName);
      }
    });
  }

  // ─── Tool wrappers ────────────────────────────────────────────────────────

  private wrapNewPage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const ownerKey = this.extractOwnerKey(agentId, args);
        if (args.background === undefined) {
          args.background = !this._bringToFront;
        }
        if (args.timeout === undefined && args.url) {
          args.timeout = 60000;
        }
        return this.withAgentLock(agentId, async () => {
          const owned = this.getOwned(ownerKey);
          const prevIds = new Set(owned);
          let result = await handler.execute(args);

          // Stale page recovery: reconnect and retry
          if (this.isStalePageError(result)) {
            const ok = await this.reconnectMcp(agentId);
            if (ok) {
              result = await handler.execute(args);
            }
          }

          if (!this.isStalePageError(result)) {
            const pages = this.parsePageEntries(result);
            // Identify the newly created page. Prefer pages NOT previously
            // owned by this session (highest ID among those = the new tab),
            // falling back to selected / highest-ID overall.
            const notPrevOwned = pages.filter((p) => !prevIds.has(p.id));
            const newPage = notPrevOwned.find((p) => p.selected)
              ?? (notPrevOwned.length > 0 ? notPrevOwned.reduce((a, b) => (a.id > b.id ? a : b)) : undefined)
              ?? pages.find((p) => p.selected)
              ?? (pages.length > 0 ? pages.reduce((a, b) => (a.id > b.id ? a : b)) : undefined);
            if (newPage) {
              // Re-fetch owned after potential reconnect (reconnect clears state)
              const currentOwned = this.getOwned(ownerKey);
              currentOwned.add(newPage.id);
              this.currentPage.set(ownerKey, newPage.id);
              this.lastActiveSession.set(agentId, { ownerKey, pageId: newPage.id });
              log.debug(`Page ${newPage.id} (${newPage.url}) assigned to ${ownerKey}`);
            } else {
              log.warn(`new_page response contained no pages for ${ownerKey}`);
            }
          }
          return this.annotateResponse(result, ownerKey);
        });
      },
    };
  }

  private wrapListPages(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const ownerKey = this.extractOwnerKey(agentId, args);
        return this.withAgentLock(agentId, async () => {
          const currentPageId = this.currentPage.get(ownerKey);
          if (currentPageId !== undefined) args._pageId = currentPageId;
          let result = await handler.execute(args);

          if (this.isStalePageError(result)) {
            const ok = await this.reconnectMcp(agentId);
            if (ok) result = await handler.execute(args);
          }

          return this.annotateResponse(result, ownerKey);
        });
      },
    };
  }

  private wrapSelectPage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const ownerKey = this.extractOwnerKey(agentId, args);
        const pageId = typeof args.pageId === 'number' ? args.pageId : undefined;
        if (pageId !== undefined && !this.getOwned(ownerKey).has(pageId)) {
          const msg = `Cannot select page ${pageId}: it is NOT your tab. ${this.ownedPagesSummary(ownerKey)}`;
          log.warn(msg, { ownerKey, pageId });
          return JSON.stringify({ error: msg });
        }
        if (args.bringToFront === undefined) {
          args.bringToFront = this._bringToFront;
        }
        return this.withAgentLock(agentId, async () => {
          const result = await handler.execute(args);

          if (this.isStalePageError(result)) {
            const ok = await this.reconnectMcp(agentId);
            if (ok) {
              // Remove only the failed page from ownership
              if (pageId !== undefined) {
                this.getOwned(ownerKey).delete(pageId);
                if (this.currentPage.get(ownerKey) === pageId) {
                  this.currentPage.delete(ownerKey);
                }
              }
              return `Tab ${pageId ?? 'unknown'} was closed externally. `
                + `${this.ownedPagesSummary(ownerKey)} Call new_page or navigate_page to create a new tab.`;
            }
          }

          if (pageId !== undefined) {
            this.currentPage.set(ownerKey, pageId);
            this.lastActiveSession.set(agentId, { ownerKey, pageId });
          }
          return this.annotateResponse(result, ownerKey);
        });
      },
    };
  }

  private wrapClosePage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const ownerKey = this.extractOwnerKey(agentId, args);
        const pageId = typeof args.pageId === 'number' ? args.pageId : undefined;
        if (pageId !== undefined && !this.getOwned(ownerKey).has(pageId)) {
          const msg = `Cannot close page ${pageId}: it is NOT your tab -- do not close tabs you did not create. ${this.ownedPagesSummary(ownerKey)}`;
          log.warn(msg, { ownerKey, pageId });
          return JSON.stringify({ error: msg });
        }
        return this.withAgentLock(agentId, async () => {
          // Adjust ownership and currentPage BEFORE calling the handler.
          // The handler triggers chrome.tabs.remove → chrome.tabs.onRemoved →
          // handleTabClosed, which runs during our await. If we haven't
          // adjusted currentPage yet, handleTabClosed will delete it outright
          // instead of letting us switch to the next owned tab.
          if (pageId !== undefined) {
            this.getOwned(ownerKey).delete(pageId);
            if (this.currentPage.get(ownerKey) === pageId) {
              const remaining = this.getOwned(ownerKey);
              const next = remaining.size > 0 ? [...remaining][remaining.size - 1] : undefined;
              if (next !== undefined) {
                this.currentPage.set(ownerKey, next);
              } else {
                this.currentPage.delete(ownerKey);
              }
            }
          }

          const result = await handler.execute(args);

          if (this.isStalePageError(result)) {
            const ok = await this.reconnectMcp(agentId);
            if (ok) {
              const remaining = this.getOwned(ownerKey);
              if (remaining.size > 0) {
                return `Tab ${pageId ?? 'unknown'} was already closed externally. `
                  + `${this.ownedPagesSummary(ownerKey)}`;
              }
              return `Tab ${pageId ?? 'unknown'} was closed externally and you have no remaining tabs. `
                + 'Call new_page or navigate_page to create a new tab.';
            }
          }

          return this.annotateResponse(result, ownerKey);
        });
      },
    };
  }

  private wrapNavigatePage(
    handler: AgentToolHandler,
    agentId: string,
    newPageHandler?: AgentToolHandler,
  ): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        if (args.timeout === undefined) {
          args.timeout = 60000;
        }
        const ownerKey = this.extractOwnerKey(agentId, args);
        const owned = this.getOwned(ownerKey);

        if (owned.size === 0) {
          return this.navigateAutoCreate(agentId, ownerKey, args, newPageHandler);
        }

        return this.withAgentLock(agentId, async () => {
          await this.ensureCorrectPage(agentId, ownerKey);
          const currentPageId = this.currentPage.get(ownerKey);
          if (currentPageId !== undefined) args._pageId = currentPageId;
          const result = await handler.execute(args);

          if (this.isStalePageError(result)) {
            const ok = await this.reconnectMcp(agentId);
            if (ok) {
              return this.navigateAutoCreateLocked(agentId, ownerKey, args, newPageHandler);
            }
          }

          return this.annotateResponse(result, ownerKey);
        });
      },
    };
  }

  /**
   * Auto-create a new tab for navigate_page when the session has no owned pages.
   * Acquires the agent lock internally.
   */
  private async navigateAutoCreate(
    agentId: string,
    ownerKey: string,
    args: Record<string, unknown>,
    newPageHandler?: AgentToolHandler,
  ): Promise<string> {
    return this.withAgentLock(agentId, async () => {
      return this.navigateAutoCreateLocked(agentId, ownerKey, args, newPageHandler);
    });
  }

  /** Inner auto-create logic, must be called with the agent lock held. */
  private async navigateAutoCreateLocked(
    agentId: string,
    ownerKey: string,
    args: Record<string, unknown>,
    newPageHandler?: AgentToolHandler,
  ): Promise<string> {
    const url = args.url as string | undefined;
    if (!url) {
      return JSON.stringify({ error: 'Cannot navigate: no URL provided. Call new_page first or provide a URL.' });
    }
    if (!newPageHandler) {
      return JSON.stringify({ error: 'new_page tool unavailable. Cannot navigate safely.' });
    }

    log.info(`Session ${ownerKey} auto-creating tab via new_page`, { url });

    const newPageArgs: Record<string, unknown> = { url, background: !this._bringToFront };
    if (args.timeout) newPageArgs.timeout = args.timeout;

    try {
      let result = await newPageHandler.execute(newPageArgs);

      if (this.isStalePageError(result)) {
        const ok = await this.reconnectMcp(agentId);
        if (ok) result = await newPageHandler.execute(newPageArgs);
      }

      if (!this.isStalePageError(result)) {
        const owned = this.getOwned(ownerKey);
        const pages = this.parsePageEntries(result);
        // Prefer highest-ID page (the just-created tab always gets the
        // highest auto-incremented ID). Only fall back to [selected] if
        // no pages exist at all.
        const newPage = (pages.length > 0 ? pages.reduce((a, b) => (a.id > b.id ? a : b)) : undefined);
        if (newPage) {
          owned.add(newPage.id);
          this.currentPage.set(ownerKey, newPage.id);
          this.lastActiveSession.set(agentId, { ownerKey, pageId: newPage.id });
          log.info(`Auto-created page ${newPage.id} (${newPage.url}) for ${ownerKey}`);
        }
      }

      return this.annotateResponse(result, ownerKey);
    } catch (err) {
      return JSON.stringify({ error: `Failed to auto-create new tab: ${err}` });
    }
  }

  private wrapGenericTool(handler: AgentToolHandler, agentId: string, toolName: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        if (args.timeout === undefined && args.url) {
          args.timeout = 60000;
        }
        const ownerKey = this.extractOwnerKey(agentId, args);
        const owned = this.getOwned(ownerKey);
        if (owned.size === 0) {
          const msg = `Cannot use ${toolName}: you have no owned tabs yet. Call navigate_page (auto-creates a tab) or new_page first.`;
          log.warn(`${ownerKey} called ${toolName} with no owned pages`);
          return JSON.stringify({ error: msg });
        }
        const pageId = typeof args.pageId === 'number' ? args.pageId : undefined;
        if (pageId !== undefined && !owned.has(pageId)) {
          const msg = `Cannot use ${toolName} on page ${pageId}: it is NOT your tab. ${this.ownedPagesSummary(ownerKey)}`;
          log.warn(msg, { ownerKey, pageId, toolName });
          return JSON.stringify({ error: msg });
        }
        return this.withAgentLock(agentId, async () => {
          await this.ensureCorrectPage(agentId, ownerKey);
          // Inject _pageId so the extension resolves target tab explicitly,
          // eliminating dependency on shared selectedPageId state.
          const currentPageId = this.currentPage.get(ownerKey);
          if (currentPageId !== undefined) args._pageId = currentPageId;
          const result = await handler.execute(args);

          if (this.isStalePageError(result)) {
            const ok = await this.reconnectMcp(agentId);
            if (ok) {
              if (currentPageId !== undefined) {
                this.getOwned(ownerKey).delete(currentPageId);
                this.currentPage.delete(ownerKey);
              }
              return `The tab you were operating on was closed externally. `
                + `${this.ownedPagesSummary(ownerKey)} Call navigate_page or new_page to create a new tab, then retry.`;
            }
          }

          return this.annotateResponse(result, ownerKey);
        });
      },
    };
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  cleanupAgent(agentId: string): void {
    const prefix = `${agentId}::`;
    let total = 0;
    for (const [key, owned] of this.ownedPages) {
      if (key === agentId || key.startsWith(prefix)) {
        total += owned.size;
        this.ownedPages.delete(key);
        this.currentPage.delete(key);
      }
    }
    this.agentLocks.delete(agentId);
    this.selectPageHandlers.delete(agentId);
    this.listPageHandlers.delete(agentId);
    this.lastActiveSession.delete(agentId);
    this.reconnectors.delete(agentId);
    if (total > 0) {
      log.info(`Cleaning up ${total} browser page(s) for agent ${agentId}`);
    }
  }
}
