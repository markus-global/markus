import { createLogger } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';

const log = createLogger('browser-session');

/**
 * Tracks browser tab ownership across agents and wraps chrome-devtools MCP
 * tool handlers to prevent cross-agent tab interference.
 *
 * When multiple agents share the same Chrome browser (via separate MCP
 * processes), each can see all tabs. This manager ensures agents only
 * operate on tabs they created.
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

  private isOwnedByOther(agentId: string, targetId: string): boolean {
    for (const [owner, pages] of this.ownedPages) {
      if (owner !== agentId && pages.has(targetId)) return true;
    }
    return false;
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
   * Wrap an array of chrome-devtools tool handlers with tab isolation logic.
   * Only the tab-management tools are wrapped; all others pass through unchanged.
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

  /** Filter list_pages to only show pages owned by this agent (or unowned). */
  private wrapListPages(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const result = await handler.execute(args);
        try {
          const parsed = JSON.parse(result);
          if (Array.isArray(parsed)) {
            const filtered = parsed.filter((page: Record<string, unknown>) => {
              const id = String(page.targetId ?? page.id ?? page.pageId ?? '');
              if (!id) return true; // unknown format, let through
              return !this.isOwnedByOther(agentId, id);
            });
            return JSON.stringify(filtered);
          }
        } catch {
          // non-JSON response — pass through unmodified
        }
        return result;
      },
    };
  }

  /** Block select_page if the target belongs to another agent. */
  private wrapSelectPage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const targetId = String(args.targetId ?? args.id ?? args.pageId ?? '');
        if (targetId && this.isOwnedByOther(agentId, targetId)) {
          const msg = `Cannot select page ${targetId}: it belongs to another agent`;
          log.warn(msg, { agentId, targetId });
          return JSON.stringify({ error: msg });
        }
        return handler.execute(args);
      },
    };
  }

  /** Block close_page for other agents' tabs and remove tracking on success. */
  private wrapClosePage(handler: AgentToolHandler, agentId: string): AgentToolHandler {
    return {
      ...handler,
      execute: async (args: Record<string, unknown>) => {
        const targetId = String(args.targetId ?? args.id ?? args.pageId ?? '');
        if (targetId && this.isOwnedByOther(agentId, targetId)) {
          const msg = `Cannot close page ${targetId}: it belongs to another agent`;
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
