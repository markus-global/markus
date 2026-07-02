/**
 * Tool Registry — Self-registration and runtime discovery of tools.
 *
 * L0: Core registry that allows tools to register themselves with metadata
 * (category, priority, tags) for runtime discovery by the agent.
 *
 * @module @markus/core/tools/registry
 */

/**
 * Category metadata for tool grouping and discovery.
 */
export interface ToolCategory {
  name: string;
  description: string;
}

/**
 * Registration entry for a tool in the registry.
 *
 * The `name` is extracted from the `handler` at registration time so that
 * consumers (Agent, discovery tools) can reference tools by `entry.name`
 * without unwrapping a nested handler object.
 */
export interface ToolRegistration {
  /** Tool name (mirrored from handler.name at registration) */
  name: string;
  /** The tool handler instance (must have a unique `.name` property) */
  handler: { name: string };
  /** Optional category for grouping/filtering */
  category?: ToolCategory;
  /** Priority for sorting (higher = more important, default: 0) */
  priority?: number;
  /** Search tags for runtime discovery */
  tags?: string[];
}

/**
 * Internal storage shape — each entry has a name key plus metadata.
 */
interface InternalEntry {
  registration: ToolRegistration;
}

/**
 * ToolRegistry — in-memory registry for tools.
 *
 * Provides register/discover/list capability so new tools can be
 * self-registered without hardcoding them in the agent or router.
 */
export class ToolRegistry {
  private entries = new Map<string, InternalEntry>();

  /**
   * Register a tool with metadata.
   * If a tool with the same name already exists, it will be overwritten.
   */
  register(entry: { handler: { name: string }; category?: ToolCategory; priority?: number; tags?: string[] }): void {
    const name = entry.handler.name;
    if (!name) {
      throw new Error('ToolRegistration requires a handler with a `.name` property');
    }
    this.entries.set(name, {
      registration: {
        name,
        handler: entry.handler,
        category: entry.category,
        priority: entry.priority,
        tags: entry.tags,
      },
    });
  }

  /**
   * Get a registered tool by name.
   */
  get(name: string): ToolRegistration | undefined {
    return this.entries.get(name)?.registration;
  }

  /**
   * Get all registered tool handlers (raw handler objects with `.name`).
   *
   * This is used by the Agent's core tool loop which iterates handlers
   * directly. For metadata-enriched entries, use `getAllRegistrations()`.
   */
  getAll(): { name: string }[] {
    return Array.from(this.entries.values()).map(e => e.registration.handler);
  }

  /**
   * Get all registered tools with full metadata (category, tags, priority).
   * Each entry has a `.name` at the top level plus `.handler`, `.category`,
   * `.tags`, and `.priority`.
   */
  getAllRegistrations(): ToolRegistration[] {
    return Array.from(this.entries.values()).map(e => e.registration);
  }

  /**
   * Find tools by category name.
   */
  findByCategory(categoryName: string): ToolRegistration[] {
    return this.getAllRegistrations().filter(e => e.category?.name === categoryName);
  }

  /**
   * Search tools by query string (matches name, tags, category, description).
   */
  search(query: string): ToolRegistration[] {
    const q = query.toLowerCase();
    return this.getAllRegistrations().filter(e => {
      const name = e.name.toLowerCase();
      const tags = e.tags?.join(' ') ?? '';
      const cat = e.category?.name.toLowerCase() ?? '';
      const desc = e.category?.description.toLowerCase() ?? '';
      return name.includes(q) || tags.includes(q) || cat.includes(q) || desc.includes(q);
    });
  }

  /**
   * Unregister a tool by name.
   */
  unregister(name: string): void {
    this.entries.delete(name);
  }

  /**
   * Get the count of registered tools.
   */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Global singleton instance of ToolRegistry.
 *
 * Used by built-in tool registration (registerBuiltinTools) and the Agent
 * constructor when no explicit registry is provided.
 */
export const globalToolRegistry = new ToolRegistry();
