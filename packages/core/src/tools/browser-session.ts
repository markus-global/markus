import { createLogger } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';

const log = createLogger('browser-session');

/**
 * Hidden field injected into tool args by Agent.executeTool() so wrappers
 * can track ownership per-session rather than per-agent.
 */
const SESSION_KEY = '_browserSessionId';

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
 * owned browser tabs. The session ID is injected into tool args by the
 * agent as `_browserSessionId` and stripped before reaching the MCP server.
 *
 * Defense-in-depth:
 *  1. new_page  → registers the tab's numeric ID as owned by this session
 *  2. list_pages → annotates every page with ownership info
 *  3. select_page / close_page → blocked unless targeting an owned page ID
 *  4. navigate_page → if session has no owned pages, transparently calls
 *     new_page with the target URL
 *  5. ALL other tools → blocked if the session has no owned pages yet;
 *     if args contain a `pageId`, it must be owned
 *  6. ALL tool responses → "## Pages" section is annotated with ownership
 *     tags so agents always know which tabs they can operate on
 */
export class BrowserSessionManager {
  /**
   * ownerKey → set of owned numeric page IDs.
   * ownerKey format: "agentId::sessionId" (or just "agentId" as fallback).
   */
  private ownedPages = new Map<string, Set<number>>();

  /**
   * Extract the owner key from agentId + session info in args.
   * Also strips the session key from args so MCP servers never see it.
   */
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

  /**
   * Parse page entries from the "## Pages" section of an MCP text response.
   *
   * Format: <id>: <url> [selected]? [isolatedContext=<name>]?
   */
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

  /**
   * Annotate "## Pages" lines in tool responses with ownership tags.
   */
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

  /**
   * Wrap an array of chrome-devtools tool handlers with strict tab isolation.
   */
  wrapToolHandlers(handlers: AgentToolHandler[], agentId: string): AgentToolHandler[] {
    const findHandler = (name: string) =>
      handlers.find((h) => (h.name.split('__').pop() ?? h.name) === name);
    const newPageHandler = findHandler('new_page');

    return handlers.map((h) => {
      const baseName = h.name.split('__').pop() ?? h.name;
      switch (baseName) {
        case 'new_page':
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

  /**
   * Track the newly created page as owned by this session.
   */
  private wrapNewPage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const ownerKey = this.extractOwnerKey(agentId, args);
        const result = await handler.execute(args);
        const pages = this.parsePageEntries(result);
        const owned = this.getOwned(ownerKey);
        const newPage = pages.find((p) => p.selected);
        if (newPage) {
          owned.add(newPage.id);
          log.debug(`Page ${newPage.id} (${newPage.url}) assigned to ${ownerKey}`);
        } else {
          log.warn(`new_page response did not contain a [selected] page for ${ownerKey}`);
        }
        return this.annotateResponse(result, ownerKey);
      },
    };
  }

  private wrapListPages(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const ownerKey = this.extractOwnerKey(agentId, args);
        const result = await handler.execute(args);
        return this.annotateResponse(result, ownerKey);
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
        const result = await handler.execute(args);
        return this.annotateResponse(result, ownerKey);
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
        const result = await handler.execute(args);
        if (pageId !== undefined) {
          this.getOwned(ownerKey).delete(pageId);
        }
        return this.annotateResponse(result, ownerKey);
      },
    };
  }

  /**
   * Wrap navigate_page with auto-creation of a new tab.
   *
   * When the session has no owned pages, transparently calls new_page
   * with the target URL instead.
   */
  private wrapNavigatePage(
    handler: AgentToolHandler,
    agentId: string,
    newPageHandler?: AgentToolHandler,
  ): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const ownerKey = this.extractOwnerKey(agentId, args);
        const owned = this.getOwned(ownerKey);

        if (owned.size === 0) {
          const url = args.url as string | undefined;
          if (!url) {
            const msg = 'Cannot navigate: you have no owned tabs and no URL provided. Call new_page first or provide a URL.';
            log.warn(msg, { ownerKey });
            return JSON.stringify({ error: msg });
          }
          if (!newPageHandler) {
            const msg = 'No owned pages and new_page tool unavailable. Cannot navigate safely.';
            log.error(msg, { ownerKey });
            return JSON.stringify({ error: msg });
          }

          log.info(`Session ${ownerKey} called navigate_page with no owned pages -- auto-creating via new_page`, { url });

          const newPageArgs: Record<string, unknown> = { url };
          if (args.timeout) newPageArgs.timeout = args.timeout;

          try {
            const result = await newPageHandler.execute(newPageArgs);
            const pages = this.parsePageEntries(result);
            const newPage = pages.find((p) => p.selected);

            if (newPage) {
              owned.add(newPage.id);
              log.info(`Auto-created page ${newPage.id} (${newPage.url}) for ${ownerKey}`);
            } else {
              log.warn(`Auto-created page but could not determine its ID for ${ownerKey}`);
            }

            return this.annotateResponse(result, ownerKey);
          } catch (err) {
            const msg = `Failed to auto-create new tab: ${err}`;
            log.error(msg, { ownerKey });
            return JSON.stringify({ error: msg });
          }
        }

        const result = await handler.execute(args);
        return this.annotateResponse(result, ownerKey);
      },
    };
  }

  /**
   * Generic guard for ALL interaction tools (click, fill, snapshot, etc.).
   */
  private wrapGenericTool(handler: AgentToolHandler, agentId: string, toolName: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
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
        const result = await handler.execute(args);
        return this.annotateResponse(result, ownerKey);
      },
    };
  }

  /**
   * Clean up all page ownership records for an agent (all sessions).
   * Called when an agent is removed.
   */
  cleanupAgent(agentId: string): void {
    const prefix = `${agentId}::`;
    let total = 0;
    for (const [key, owned] of this.ownedPages) {
      if (key === agentId || key.startsWith(prefix)) {
        total += owned.size;
        this.ownedPages.delete(key);
      }
    }
    if (total > 0) {
      log.info(`Cleaning up ${total} browser page(s) for agent ${agentId}`);
    }
  }
}
