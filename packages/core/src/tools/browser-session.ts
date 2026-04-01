import { createLogger } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';

const log = createLogger('browser-session');

/**
 * Tracks browser tab ownership across agents and wraps chrome-devtools MCP
 * tool handlers to enforce strict tab isolation.
 *
 * chrome-devtools-mcp identifies pages by auto-incrementing numeric IDs
 * (1, 2, 3, …) returned in a "## Pages" text section. Tools like
 * `select_page` and `close_page` accept `pageId: number`.
 *
 * Each agent gets its own MCP server process (per-agent isolation), but all
 * processes connect to the same Chrome browser. This manager ensures agents
 * can ONLY operate on tabs they explicitly created via `new_page`.
 *
 * Defense-in-depth:
 *  1. new_page  → registers the tab's numeric ID as owned by the calling agent
 *  2. list_pages → annotates every page with ownership info
 *  3. select_page / close_page → blocked unless targeting an owned page ID
 *  4. navigate_page → if agent has no owned pages, transparently calls
 *     new_page with the target URL (so agents don't need to call new_page
 *     explicitly before their first navigation)
 *  5. ALL other tools → blocked if the agent has no owned pages yet;
 *     if args contain a `pageId`, it must be owned
 *  6. ALL tool responses → "## Pages" section is annotated with ownership
 *     tags so agents always know which tabs they can operate on
 */
export class BrowserSessionManager {
  /** agentId → set of owned numeric page IDs */
  private ownedPages = new Map<string, Set<number>>();

  private getOwned(agentId: string): Set<number> {
    let set = this.ownedPages.get(agentId);
    if (!set) {
      set = new Set();
      this.ownedPages.set(agentId, set);
    }
    return set;
  }

  /**
   * Parse page entries from the "## Pages" section of an MCP text response.
   *
   * The format produced by chrome-devtools-mcp is:
   *   <id>: <url> [selected]? [isolatedContext=<name>]?
   *
   * Example:
   *   ## Pages
   *   1: https://example.com
   *   2: https://x.com/home [selected]
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
   *
   * Every page line gets either " -- YOUR TAB" or " -- NOT YOUR TAB"
   * appended so the agent always knows which tabs it can operate on.
   * Applied to ALL tool responses except where we return early with an error.
   */
  private annotateResponse(result: string, agentId: string): string {
    const owned = this.getOwned(agentId);
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

  /** Build a short summary of this agent's owned pages for error messages. */
  private ownedPagesSummary(agentId: string): string {
    const owned = this.getOwned(agentId);
    if (owned.size === 0) return 'You currently have no owned tabs. Call new_page or navigate_page to create one.';
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
    const selectPageHandler = findHandler('select_page');

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
          return this.wrapNavigatePage(h, agentId, newPageHandler, selectPageHandler);
        default:
          return this.wrapGenericTool(h, agentId, baseName);
      }
    });
  }

  /**
   * Track the newly created page as owned by this agent.
   *
   * new_page always selects the new tab internally, so the [selected] entry
   * in the response is the one we just created.
   */
  private wrapNewPage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const result = await handler.execute(args);
        const pages = this.parsePageEntries(result);
        const owned = this.getOwned(agentId);
        const newPage = pages.find((p) => p.selected);
        if (newPage) {
          owned.add(newPage.id);
          log.debug(`Page ${newPage.id} (${newPage.url}) assigned to agent ${agentId}`);
        } else {
          log.warn(`new_page response did not contain a [selected] page for agent ${agentId}`);
        }
        return this.annotateResponse(result, agentId);
      },
    };
  }

  /**
   * Annotate list_pages results with ownership info.
   * The agent sees ALL tabs but clearly knows which ones it can operate on.
   */
  private wrapListPages(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const result = await handler.execute(args);
        return this.annotateResponse(result, agentId);
      },
    };
  }

  /** Only allow selecting pages this agent owns. */
  private wrapSelectPage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const pageId = typeof args.pageId === 'number' ? args.pageId : undefined;
        if (pageId !== undefined && !this.getOwned(agentId).has(pageId)) {
          const msg = `Cannot select page ${pageId}: it is NOT your tab. ${this.ownedPagesSummary(agentId)}`;
          log.warn(msg, { agentId, pageId });
          return JSON.stringify({ error: msg });
        }
        const result = await handler.execute(args);
        return this.annotateResponse(result, agentId);
      },
    };
  }

  /** Only allow closing pages this agent owns; remove tracking on success. */
  private wrapClosePage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const pageId = typeof args.pageId === 'number' ? args.pageId : undefined;
        if (pageId !== undefined && !this.getOwned(agentId).has(pageId)) {
          const msg = `Cannot close page ${pageId}: it is NOT your tab -- do not close tabs you did not create. ${this.ownedPagesSummary(agentId)}`;
          log.warn(msg, { agentId, pageId });
          return JSON.stringify({ error: msg });
        }
        const result = await handler.execute(args);
        if (pageId !== undefined) {
          this.getOwned(agentId).delete(pageId);
        }
        return this.annotateResponse(result, agentId);
      },
    };
  }

  /**
   * Wrap navigate_page with auto-creation of a new tab.
   *
   * When the agent has no owned pages, instead of blocking we transparently
   * call `new_page` with the target URL. This creates a fresh tab, navigates
   * to the URL, and tracks ownership -- all in one step.
   *
   * This is the most natural flow for agents: they just call navigate_page
   * and everything works.
   */
  private wrapNavigatePage(
    handler: AgentToolHandler,
    agentId: string,
    newPageHandler?: AgentToolHandler,
    selectPageHandler?: AgentToolHandler,
  ): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const owned = this.getOwned(agentId);

        if (owned.size === 0) {
          const url = args.url as string | undefined;
          if (!url) {
            const msg = 'Cannot navigate: you have no owned tabs and no URL provided. Call new_page first or provide a URL.';
            log.warn(msg, { agentId });
            return JSON.stringify({ error: msg });
          }
          if (!newPageHandler) {
            const msg = 'No owned pages and new_page tool unavailable. Cannot navigate safely.';
            log.error(msg, { agentId });
            return JSON.stringify({ error: msg });
          }

          log.info(`Agent ${agentId} called navigate_page with no owned pages -- auto-creating via new_page`, { url });

          const newPageArgs: Record<string, unknown> = { url };
          if (args.timeout) newPageArgs.timeout = args.timeout;

          try {
            const result = await newPageHandler.execute(newPageArgs);
            const pages = this.parsePageEntries(result);
            const newPage = pages.find((p) => p.selected);

            if (newPage) {
              owned.add(newPage.id);
              log.info(`Auto-created page ${newPage.id} (${newPage.url}) for agent ${agentId}`);
            } else {
              log.warn(`Auto-created page but could not determine its ID for agent ${agentId}`);
            }

            return this.annotateResponse(result, agentId);
          } catch (err) {
            const msg = `Failed to auto-create new tab: ${err}`;
            log.error(msg, { agentId });
            return JSON.stringify({ error: msg });
          }
        }

        const result = await handler.execute(args);
        return this.annotateResponse(result, agentId);
      },
    };
  }

  /**
   * Generic guard for ALL interaction tools (click, fill, snapshot, etc.).
   *
   * Checks:
   *  1. Agent must have at least one owned page (prevents operating on the
   *     MCP's auto-connected default tab before creating a new one).
   *  2. If args contain `pageId`, it must be an owned page.
   */
  private wrapGenericTool(handler: AgentToolHandler, agentId: string, toolName: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const owned = this.getOwned(agentId);
        if (owned.size === 0) {
          const msg = `Cannot use ${toolName}: you have no owned tabs yet. Call navigate_page (auto-creates a tab) or new_page first.`;
          log.warn(`Agent ${agentId} called ${toolName} with no owned pages`, { agentId });
          return JSON.stringify({ error: msg });
        }
        const pageId = typeof args.pageId === 'number' ? args.pageId : undefined;
        if (pageId !== undefined && !owned.has(pageId)) {
          const msg = `Cannot use ${toolName} on page ${pageId}: it is NOT your tab. ${this.ownedPagesSummary(agentId)}`;
          log.warn(msg, { agentId, pageId, toolName });
          return JSON.stringify({ error: msg });
        }
        const result = await handler.execute(args);
        return this.annotateResponse(result, agentId);
      },
    };
  }

  /**
   * Clean up all page ownership records for an agent.
   * Called when an agent is removed.
   */
  cleanupAgent(agentId: string): void {
    const owned = this.ownedPages.get(agentId);
    if (owned?.size) {
      log.info(`Cleaning up ${owned.size} browser page(s) for agent ${agentId}`);
    }
    this.ownedPages.delete(agentId);
  }
}
