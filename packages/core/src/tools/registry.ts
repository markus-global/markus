import type { AgentToolHandler } from '../agent.js';
import { createLogger } from '@markus/shared';

const log = createLogger('tool-registry');

/**
 * Category descriptor for grouping related tools together for discovery.
 */
export interface ToolCategory {
  name: string;
  description: string;
}

/**
 * Registration metadata attached to a tool at registration time.
 * Separated from AgentToolHandler so the handler itself remains
 * a pure execution contract.
 */
export interface ToolRegistration {
  handler: AgentToolHandler;
  category?: ToolCategory;
  /** Higher priority tools appear first in listings. Default: 0 */
  priority?: number;
  /** Tags for search/discovery filtering */
  tags?: string[];
  /** If true, the tool is hidden from the discovery catalog (internal/meta tools). Default: false */
  hidden?: boolean;
}

/**
 * Central tool registry.
 *
 * Owns the canonical set of tools available in the system. Tools are
 * registered once at startup (built-in tools) or dynamically at runtime
 * (skill-installed tools, MCP tools, plugin tools, etc.).
 *
 * The registry provides:
 *  - `register` / `registerMany` — add tools (from any source)
 *  - `get` / `getAll` — retrieve tools by name or category
 *  - `search` — filter by name, tags, or category
 *  - `createToolHandler` — produce an AgentToolHandler that wraps a
 *     registry-backed tool (for backward compat with caller sites
 *     that construct the handler themselves)
 */
export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();
  private categories = new Map<string, ToolCategory>();

  // ── Registration ──────────────────────────────────────────────

  register(registration: ToolRegistration): void {
    const name = registration.handler.name;
    if (this.tools.has(name)) {
      log.warn(`Tool "${name}" already registered — overwriting`);
    }
    this.tools.set(name, registration);
    if (registration.category && !this.categories.has(registration.category.name)) {
      this.categories.set(registration.category.name, registration.category);
    }
    log.debug(`Registered tool: ${name}`);
  }

  registerMany(registrations: ToolRegistration[]): void {
    for (const r of registrations) {
      this.register(r);
    }
  }

  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) log.debug(`Unregistered tool: ${name}`);
    return removed;
  }

  // ── Retrieval ─────────────────────────────────────────────────

  get(name: string): AgentToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Return all registered tool handlers (including hidden ones).
   * Useful for populating the agent's tool map.
   */
  getAll(): AgentToolHandler[] {
    const result: AgentToolHandler[] = [];
    for (const reg of this.tools.values()) {
      result.push(reg.handler);
    }
    return result;
  }

  /**
   * Return the raw registrations (mostly for internal inspection).
   */
  getAllRegistrations(): ToolRegistration[] {
    return [...this.tools.values()];
  }

  // ── Discovery / Search ────────────────────────────────────────

  /**
   * List all non-hidden tools with their metadata, grouped by category.
   * This is the public catalog surface used by `discover_tools`.
   */
  listCatalog(): Array<{
    name: string;
    description: string;
    category?: string;
    categoryDescription?: string;
    tags?: string[];
  }> {
    const catalog: Array<{
      name: string;
      description: string;
      category?: string;
      categoryDescription?: string;
      tags?: string[];
    }> = [];

    for (const [name, reg] of this.tools) {
      if (reg.hidden) continue;
      catalog.push({
        name,
        description: reg.handler.description,
        category: reg.category?.name,
        categoryDescription: reg.category?.description,
        tags: reg.tags,
      });
    }

    // Sort by priority desc, then by name
    catalog.sort((a, b) => {
      const pa = this.tools.get(a.name)?.priority ?? 0;
      const pb = this.tools.get(b.name)?.priority ?? 0;
      if (pa !== pb) return pb - pa;
      return a.name.localeCompare(b.name);
    });

    return catalog;
  }

  /**
   * Search tools by name, description, or tags.
   */
  search(query: string): Array<{
    name: string;
    description: string;
    category?: string;
    tags?: string[];
    score: number;
  }> {
    const q = query.toLowerCase();
    const results: Array<{
      name: string;
      description: string;
      category?: string;
      tags?: string[];
      score: number;
    }> = [];

    for (const [name, reg] of this.tools) {
      if (reg.hidden) continue;
      let score = 0;

      if (name.toLowerCase().includes(q)) {
        score += 10; // exact name match is strongest
      }
      if (reg.handler.description.toLowerCase().includes(q)) {
        score += 5;
      }
      if (reg.tags?.some(t => t.toLowerCase().includes(q))) {
        score += 3;
      }

      if (score > 0) {
        results.push({
          name,
          description: reg.handler.description,
          category: reg.category?.name,
          tags: reg.tags,
          score,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  // ── Categories ────────────────────────────────────────────────

  listCategories(): ToolCategory[] {
    return [...this.categories.values()];
  }

  getToolsByCategory(categoryName: string): AgentToolHandler[] {
    const result: AgentToolHandler[] = [];
    for (const reg of this.tools.values()) {
      if (reg.category?.name === categoryName) {
        result.push(reg.handler);
      }
    }
    return result;
  }

  // ── Bulk helpers ──────────────────────────────────────────────

  clear(): void {
    this.tools.clear();
    this.categories.clear();
  }

  get size(): number {
    return this.tools.size;
  }
}

/**
 * Singleton global registry.
 * All tools — built-in, skill-installed, MCP, plugin — are registered here.
 */
export const globalToolRegistry = new ToolRegistry();
