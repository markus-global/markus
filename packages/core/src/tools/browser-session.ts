import { createLogger } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';

const log = createLogger('browser-session');

const TARGET_ID_PARAM_NAMES = ['targetId', 'id', 'pageId', 'target'];

/**
 * Tracks browser tab ownership across agents and wraps chrome-devtools MCP
 * tool handlers to enforce strict tab isolation.
 *
 * When multiple agents share the same Chrome browser (via separate MCP
 * processes), each can see all tabs. This manager ensures agents can ONLY
 * operate on tabs they explicitly created via `new_page`.
 *
 * Defense-in-depth:
 *  1. new_page  → registers the tab as owned by the calling agent
 *  2. list_pages → only returns this agent's owned tabs
 *  3. select_page / close_page → blocked unless targeting an owned tab
 *  4. navigate_page → blocked if no owned pages OR targeting a non-owned tab
 *  5. ALL other tools (click, fill, snapshot, evaluate_script, …) →
 *     blocked if the agent has no owned pages yet (prevents operating on
 *     the MCP's default auto-connected tab before new_page is called),
 *     AND blocked if args contain a targetId/pageId that isn't owned.
 */
export class BrowserSessionManager {
  /** agentId → set of owned target/page IDs */
  private ownedPages = new Map<string, Set<string>>();

  private getOwned(agentId: string): Set<string> {
    let set = this.ownedPages.get(agentId);
    if (!set) {
      set = new Set();
      this.ownedPages.set(agentId, set);
    }
    return set;
  }

  private isOwnedByMe(agentId: string, targetId: string): boolean {
    return this.getOwned(agentId).has(targetId);
  }

  /**
   * Check tool args for any target/page ID parameter and return it if found.
   * Returns empty string if none present.
   */
  private extractTargetIdFromArgs(args: Record<string, unknown>): string {
    for (const key of TARGET_ID_PARAM_NAMES) {
      if (args[key] !== undefined && args[key] !== null) {
        const val = String(args[key]);
        if (val) return val;
      }
    }
    return '';
  }

  /**
   * Extract page/target identifiers from a tool response string.
   * Handles both JSON objects and JSON arrays.  Returns empty array
   * when the response format is unrecognised (fail-open).
   */
  private extractTargetIds(text: string): string[] {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .map((p: Record<string, unknown>) => String(p.targetId ?? p.id ?? p.pageId ?? ''))
          .filter(Boolean);
      }
      const id = String(parsed.targetId ?? parsed.id ?? parsed.pageId ?? '');
      return id ? [id] : [];
    } catch {
      return [];
    }
  }

  /**
   * Wrap an array of chrome-devtools tool handlers with strict tab isolation.
   *
   * - Tab management tools get specific ownership wrappers.
   * - ALL other tools get a generic guard that blocks execution when the agent
   *   has no owned pages (i.e. hasn't called new_page yet) or when args
   *   contain a targetId pointing to a non-owned page.
   */
  wrapToolHandlers(handlers: AgentToolHandler[], agentId: string): AgentToolHandler[] {
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
          return this.wrapNavigatePage(h, agentId);
        default:
          return this.wrapGenericTool(h, agentId, baseName);
      }
    });
  }

  /** Track the newly created page as owned by this agent. */
  private wrapNewPage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const result = await handler.execute(args);
        const ids = this.extractTargetIds(result);
        const owned = this.getOwned(agentId);
        for (const id of ids) {
          owned.add(id);
          log.debug(`Page ${id} assigned to agent ${agentId}`);
        }
        return result;
      },
    };
  }

  /** Only show pages that this agent explicitly created. */
  private wrapListPages(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const result = await handler.execute(args);
        try {
          const parsed = JSON.parse(result);
          if (Array.isArray(parsed)) {
            const owned = this.getOwned(agentId);
            const filtered = parsed.filter((page: Record<string, unknown>) => {
              const id = String(page.targetId ?? page.id ?? page.pageId ?? '');
              if (!id) return false;
              return owned.has(id);
            });
            if (parsed.length !== filtered.length) {
              log.debug(
                `list_pages: agent ${agentId} sees ${filtered.length}/${parsed.length} pages (strict ownership filter)`
              );
            }
            return JSON.stringify(filtered);
          }
        } catch {
          // non-JSON response — pass through unmodified
        }
        return result;
      },
    };
  }

  /** Only allow selecting pages this agent owns. */
  private wrapSelectPage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const targetId = this.extractTargetIdFromArgs(args);
        if (targetId && !this.isOwnedByMe(agentId, targetId)) {
          const msg = `Cannot select page ${targetId}: you can only select pages you created with new_page. Use new_page to open your own tab.`;
          log.warn(msg, { agentId, targetId });
          return JSON.stringify({ error: msg });
        }
        return handler.execute(args);
      },
    };
  }

  /** Only allow closing pages this agent owns; remove tracking on success. */
  private wrapClosePage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const targetId = this.extractTargetIdFromArgs(args);
        if (targetId && !this.isOwnedByMe(agentId, targetId)) {
          const msg = `Cannot close page ${targetId}: you can only close pages you created with new_page. Do not close tabs you did not open.`;
          log.warn(msg, { agentId, targetId });
          return JSON.stringify({ error: msg });
        }
        const result = await handler.execute(args);
        if (targetId) {
          this.getOwned(agentId).delete(targetId);
        }
        return result;
      },
    };
  }

  /**
   * Block navigate_page if:
   *  - agent has no owned pages (hasn't called new_page)
   *  - args include a targetId pointing to a non-owned page
   */
  private wrapNavigatePage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const owned = this.getOwned(agentId);
        if (owned.size === 0) {
          const msg = 'You have no owned pages. Call new_page first to create your own tab before navigating.';
          log.warn(`Agent ${agentId} called navigate_page with no owned pages`, { agentId, url: args.url });
          return JSON.stringify({ error: msg });
        }
        const targetId = this.extractTargetIdFromArgs(args);
        if (targetId && !owned.has(targetId)) {
          const msg = `Cannot navigate page ${targetId}: it is not a page you own. Use new_page to create your own tab.`;
          log.warn(msg, { agentId, targetId });
          return JSON.stringify({ error: msg });
        }
        return handler.execute(args);
      },
    };
  }

  /**
   * Generic guard for ALL interaction tools (click, fill, snapshot, etc.).
   *
   * Two checks:
   *  1. Agent must have at least one owned page. This prevents the tool from
   *     operating on the MCP process's auto-connected default tab, which
   *     belongs to the user or another agent.
   *  2. If the tool args contain a targetId/pageId, it must be an owned page.
   *     This prevents agents from targeting specific non-owned tabs.
   */
  private wrapGenericTool(handler: AgentToolHandler, agentId: string, toolName: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const owned = this.getOwned(agentId);
        if (owned.size === 0) {
          const msg = `Cannot use ${toolName} before creating a tab. Call new_page first to create your own tab.`;
          log.warn(`Agent ${agentId} called ${toolName} with no owned pages`, { agentId });
          return JSON.stringify({ error: msg });
        }
        const targetId = this.extractTargetIdFromArgs(args);
        if (targetId && !owned.has(targetId)) {
          const msg = `Cannot use ${toolName} on page ${targetId}: it is not a page you own. Only interact with pages you created via new_page.`;
          log.warn(msg, { agentId, targetId, toolName });
          return JSON.stringify({ error: msg });
        }
        return handler.execute(args);
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
