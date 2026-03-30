import { createLogger } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';

const log = createLogger('browser-session');

/**
 * Tracks browser tab ownership across agents and wraps chrome-devtools MCP
 * tool handlers to enforce strict tab isolation.
 *
 * When multiple agents share the same Chrome browser (via separate MCP
 * processes), each can see all tabs. This manager ensures agents can ONLY
 * operate on tabs they explicitly created via `new_page`.
 *
 * Strict ownership model:
 * - list_pages: only shows pages this agent created
 * - select_page: only allows selecting pages this agent created
 * - close_page: only allows closing pages this agent created
 * - navigate_page: warns if agent has no owned pages (should call new_page first)
 * - All other tools: pass through but log if agent has no owned pages
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
   * Tab-management tools enforce ownership; navigate_page gets a safety check.
   */
  wrapToolHandlers(handlers: AgentToolHandler[], agentId: string): AgentToolHandler[] {
    return handlers.map((h) => {
      const baseName = h.name.split('__').pop();
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
          return h;
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
        const targetId = String(args.targetId ?? args.id ?? args.pageId ?? '');
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
        const targetId = String(args.targetId ?? args.id ?? args.pageId ?? '');
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
   * Safety check for navigate_page: warn if agent has no owned pages,
   * which means it's about to navigate a tab it doesn't own.
   */
  private wrapNavigatePage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const owned = this.getOwned(agentId);
        if (owned.size === 0) {
          const msg = 'Warning: You have no owned pages. Call new_page first to create your own tab before navigating. Navigating without an owned page may affect other agents or user tabs.';
          log.warn(`Agent ${agentId} called navigate_page with no owned pages`, { agentId, url: args.url });
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
