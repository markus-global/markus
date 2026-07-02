import type { AgentToolHandler } from '../agent.js';

/**
 * Tool category descriptor used for organizing tools in the discovery catalog.
 */
export interface ToolCategory {
  /** Unique category name (e.g. "shell", "file", "web") */
  name: string;
  /** Human-readable description of the category */
  description: string;
}

/**
 * Full registration metadata for a tool in the ToolRegistry.
 */
export interface ToolRegistration {
  /** The tool handler instance */
  handler: AgentToolHandler;
  /** Category this tool belongs to */
  category: ToolCategory;
  /** Priority within the category (higher = more important, appears first) */
  priority: number;
  /** Search keywords for runtime discovery */
  tags: string[];
}

/**
 * In-memory registry for tool handlers that supports registration,
 * discovery, and search.
 *
 * Tools can be registered with metadata (category, priority, tags)
 * so the agent can discover them at runtime based on task requirements.
 */
export class ToolRegistry {
  private handlers = new Map<string, AgentToolHandler>();
  private registrations = new Map<string, ToolRegistration>();
  private indexedByCategory = new Map<string, ToolRegistration[]>();
  private indexedByTag = new Map<string, ToolRegistration[]>();

  /**
   * Register a tool with full metadata.
   * If a tool with the same name already exists, it is overwritten.
   */
  register(entry: ToolRegistration): void {
    const name = entry.handler.name;
    this.handlers.set(name, entry.handler);
    this.registrations.set(name, entry);

    // Index by category
    const catName = entry.category.name;
    if (!this.indexedByCategory.has(catName)) {
      this.indexedByCategory.set(catName, []);
    }
    this.indexedByCategory.get(catName)!.push(entry);

    // Index by tags
    for (const tag of entry.tags) {
      if (!this.indexedByTag.has(tag)) {
        this.indexedByTag.set(tag, []);
      }
      this.indexedByTag.get(tag)!.push(entry);
    }
  }

  /**
   * Get a tool handler by name.
   */
  get(name: string): AgentToolHandler | undefined {
    return this.handlers.get(name);
  }

  /**
   * Get all registered tool handlers.
   */
  getAll(): AgentToolHandler[] {
    return Array.from(this.handlers.values());
  }

  /**
   * Get all full registrations (handler + metadata).
   */
  getAllRegistrations(): ToolRegistration[] {
    return Array.from(this.registrations.values());
  }

  /**
   * Find all registrations in a given category.
   */
  findByCategory(categoryName: string): ToolRegistration[] {
    return this.indexedByCategory.get(categoryName) ?? [];
  }

  /**
   * Search registrations by name or tags.
   * Matches if the query string appears in the tool name or any of its tags.
   */
  search(query: string): ToolRegistration[] {
    const q = query.toLowerCase();
    const results: ToolRegistration[] = [];
    for (const reg of this.registrations.values()) {
      if (reg.handler.name.toLowerCase().includes(q) ||
          reg.tags.some(t => t.toLowerCase().includes(q))) {
        results.push(reg);
      }
    }
    return results;
  }

  /**
   * Unregister a tool by name.
   * Returns true if the tool existed and was removed.
   */
  unregister(name: string): boolean {
    const existed = this.handlers.delete(name);
    const reg = this.registrations.get(name);
    this.registrations.delete(name);

    if (reg) {
      // Remove from category index
      const catList = this.indexedByCategory.get(reg.category.name);
      if (catList) {
        const idx = catList.findIndex(r => r.handler.name === name);
        if (idx !== -1) catList.splice(idx, 1);
      }

      // Remove from tag indexes
      for (const tag of reg.tags) {
        const tagList = this.indexedByTag.get(tag);
        if (tagList) {
          const idx = tagList.findIndex(r => r.handler.name === name);
          if (idx !== -1) tagList.splice(idx, 1);
        }
      }
    }

    return existed;
  }
}

/**
 * Global singleton ToolRegistry used by default across all agents.
 */
export const globalToolRegistry = new ToolRegistry();
