/**
 * Injected host for the Electron embedded browser (WebContentsView).
 *
 * Desktop wires a concrete implementation that speaks CDP via
 * `webContents.debugger`. AgentManager prefers this backend when available
 * (desktop), then the Chrome extension bridge, then npx chrome-devtools-mcp.
 *
 * Tools must match the chrome-devtools-mcp / markus-browser-mcp surface so
 * BrowserSessionManager can wrap them unchanged.
 */

export interface EmbeddedBrowserToolResult {
  content: string;
  error?: string;
}

export interface EmbeddedBrowserHost {
  /** True when the desktop embedded browser backend is ready. */
  available(): boolean;
  /** Execute a browser tool by name (e.g. new_page, take_snapshot). */
  callTool(name: string, args: Record<string, unknown>): Promise<EmbeddedBrowserToolResult>;
}
