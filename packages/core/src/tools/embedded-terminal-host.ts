/**
 * Injected host for the Electron embedded terminal (node-pty).
 *
 * Desktop wires a concrete implementation. AgentManager prefers this backend
 * when available; otherwise terminal__* tools return a clear error directing
 * agents to shell_execute.
 */

export interface EmbeddedTerminalToolResult {
  content: string;
  error?: string;
}

export interface EmbeddedTerminalHost {
  /** True when the desktop embedded terminal backend is ready. */
  available(): boolean;
  /** Execute a terminal tool by name (e.g. list_terminals, exec_terminal). */
  callTool(name: string, args: Record<string, unknown>): Promise<EmbeddedTerminalToolResult>;
}
