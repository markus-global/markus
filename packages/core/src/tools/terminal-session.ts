import { createLogger } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';
import type { EmbeddedTerminalHost } from './embedded-terminal-host.js';
import { toolErr } from './result.js';

const log = createLogger('terminal-session');

const SESSION_KEY = '_terminalSessionId';

export type TerminalOwnershipEvent = {
  action: 'claimed' | 'released';
  terminalId: string;
  agentId: string;
  ownerKey: string;
};

/**
 * Tracks interactive terminal ownership per chat session and wraps
 * terminal__* tool handlers for isolation (mirrors BrowserSessionManager).
 */
export class TerminalSessionManager {
  private owned = new Map<string, Set<string>>();
  private current = new Map<string, string>();
  private agentLocks = new Map<string, Promise<void>>();
  private ownershipListeners = new Set<(e: TerminalOwnershipEvent) => void>();
  private host: EmbeddedTerminalHost | null = null;

  setHost(host: EmbeddedTerminalHost | null): void {
    this.host = host;
  }

  getHost(): EmbeddedTerminalHost | null {
    return this.host;
  }

  onOwnershipChange(listener: (e: TerminalOwnershipEvent) => void): () => void {
    this.ownershipListeners.add(listener);
    return () => { this.ownershipListeners.delete(listener); };
  }

  listOwnership(): Array<{ terminalId: string; agentId: string; ownerKey: string }> {
    const out: Array<{ terminalId: string; agentId: string; ownerKey: string }> = [];
    for (const [ownerKey, set] of this.owned) {
      const agentId = this.agentIdFromOwnerKey(ownerKey);
      for (const terminalId of set) {
        out.push({ terminalId, agentId, ownerKey });
      }
    }
    return out;
  }

  handleTerminalClosed(terminalId?: string): void {
    if (!terminalId) return;
    for (const [ownerKey, set] of this.owned) {
      if (!set.has(terminalId)) continue;
      set.delete(terminalId);
      if (this.current.get(ownerKey) === terminalId) this.current.delete(ownerKey);
      this.emitOwnership({
        action: 'released',
        terminalId,
        agentId: this.agentIdFromOwnerKey(ownerKey),
        ownerKey,
      });
    }
  }

  cleanupAgent(agentId: string): void {
    for (const key of [...this.owned.keys()]) {
      if (key === agentId || key.startsWith(`${agentId}::`)) {
        const set = this.owned.get(key);
        if (set) {
          for (const terminalId of set) {
            this.emitOwnership({
              action: 'released',
              terminalId,
              agentId,
              ownerKey: key,
            });
          }
        }
        this.owned.delete(key);
        this.current.delete(key);
      }
    }
    this.agentLocks.delete(agentId);
  }

  private agentIdFromOwnerKey(ownerKey: string): string {
    const idx = ownerKey.indexOf('::');
    return idx === -1 ? ownerKey : ownerKey.slice(0, idx);
  }

  private emitOwnership(event: TerminalOwnershipEvent): void {
    for (const listener of this.ownershipListeners) {
      try { listener(event); } catch (err) {
        log.warn('ownership listener error', { error: String(err) });
      }
    }
  }

  private ownerKey(agentId: string, args: Record<string, unknown>): string {
    const sid = typeof args[SESSION_KEY] === 'string' ? args[SESSION_KEY] : '';
    return sid ? `${agentId}::${sid}` : agentId;
  }

  private claim(ownerKey: string, terminalId: string): void {
    let set = this.owned.get(ownerKey);
    if (!set) {
      set = new Set();
      this.owned.set(ownerKey, set);
    }
    const wasNew = !set.has(terminalId);
    set.add(terminalId);
    this.current.set(ownerKey, terminalId);
    if (wasNew) {
      this.emitOwnership({
        action: 'claimed',
        terminalId,
        agentId: this.agentIdFromOwnerKey(ownerKey),
        ownerKey,
      });
    }
  }

  private release(ownerKey: string, terminalId: string): void {
    const set = this.owned.get(ownerKey);
    if (!set?.has(terminalId)) return;
    set.delete(terminalId);
    if (this.current.get(ownerKey) === terminalId) this.current.delete(ownerKey);
    this.emitOwnership({
      action: 'released',
      terminalId,
      agentId: this.agentIdFromOwnerKey(ownerKey),
      ownerKey,
    });
  }

  private async withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.agentLocks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    this.agentLocks.set(agentId, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  wrapToolHandlers(handlers: AgentToolHandler[], agentId: string): AgentToolHandler[] {
    return handlers.map(handler => {
      const name = handler.name.replace(/^terminal__/, '');
      const original = handler.execute.bind(handler);

      return {
        ...handler,
        execute: async (args: Record<string, unknown>) => {
          const host = this.host;
          if (!host?.available()) {
            return toolErr(
              'Interactive terminal host unavailable. Use shell_execute for non-interactive commands, or open Markus Desktop.',
            );
          }

          return this.withAgentLock(agentId, async () => {
            const key = this.ownerKey(agentId, args);
            const cleanArgs = { ...args };
            delete cleanArgs[SESSION_KEY];

            if (name === 'new_terminal') {
              const result = await host.callTool(name, cleanArgs);
              if (result.error) return toolErr(result.error);
              const match = /Created terminal (\S+)/.exec(result.content);
              const terminalId = match?.[1];
              if (terminalId) this.claim(key, terminalId);
              return result.content;
            }

            if (name === 'list_terminals') {
              const result = await host.callTool(name, cleanArgs);
              if (result.error) return toolErr(result.error);
              const owned = this.owned.get(key);
              if (!owned || owned.size === 0) {
                return `${result.content}\n\n(You do not own any terminals yet — call new_terminal or select_terminal.)`;
              }
              return `${result.content}\n\nYour owned ids: ${[...owned].join(', ')}`;
            }

            if (name === 'select_terminal') {
              const terminalId = typeof cleanArgs.terminalId === 'string'
                ? cleanArgs.terminalId
                : (typeof cleanArgs.id === 'string' ? cleanArgs.id : '');
              if (!terminalId) return toolErr('terminalId required');
              const result = await host.callTool(name, { ...cleanArgs, terminalId });
              if (result.error) return toolErr(result.error);
              this.claim(key, terminalId);
              return result.content;
            }

            if (name === 'close_terminal') {
              const terminalId = typeof cleanArgs.terminalId === 'string'
                ? cleanArgs.terminalId
                : (typeof cleanArgs.id === 'string' ? cleanArgs.id : this.current.get(key) || '');
              if (!terminalId) return toolErr('terminalId required');
              const result = await host.callTool(name, { ...cleanArgs, terminalId });
              if (result.error) return toolErr(result.error);
              this.release(key, terminalId);
              return result.content;
            }

            if (
              name === 'read_terminal'
              || name === 'write_terminal'
              || name === 'exec_terminal'
              || name === 'rename_terminal'
            ) {
              const terminalId = typeof cleanArgs.terminalId === 'string'
                ? cleanArgs.terminalId
                : (typeof cleanArgs.id === 'string' ? cleanArgs.id : this.current.get(key));
              const effectiveId = terminalId || this.current.get(key);
              if (!effectiveId) {
                return toolErr('No terminal selected. Call new_terminal or select_terminal first.');
              }
              this.claim(key, effectiveId);
              const result = await host.callTool(name, {
                ...cleanArgs,
                terminalId: effectiveId,
                id: effectiveId,
              });
              if (result.error) return toolErr(result.error);
              return result.content;
            }

            return original(cleanArgs);
          });
        },
      };
    });
  }
}

export const TERMINAL_TOOL_DESCRIPTORS = [
  {
    name: 'list_terminals',
    description: 'List interactive right-panel terminal tabs (id, title, cwd, selected).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'new_terminal',
    description: 'Open a new interactive terminal tab in the Team Chat right panel.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cwd: { type: 'string', description: 'Working directory' },
        title: { type: 'string', description: 'Tab title' },
      },
    },
  },
  {
    name: 'select_terminal',
    description: 'Select (focus) a terminal tab by id and claim it for this session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        terminalId: { type: 'string' },
      },
      required: ['terminalId'],
    },
  },
  {
    name: 'close_terminal',
    description: 'Close a terminal tab and kill its PTY.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        terminalId: { type: 'string' },
      },
      required: ['terminalId'],
    },
  },
  {
    name: 'read_terminal',
    description: 'Read recent output from a terminal tab (ring buffer).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        terminalId: { type: 'string' },
        max_lines: { type: 'number' },
        max_chars: { type: 'number' },
      },
    },
  },
  {
    name: 'write_terminal',
    description: 'Write raw data to a terminal (include \\n to run a command). Prefer exec_terminal for command+wait.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        terminalId: { type: 'string' },
        data: { type: 'string' },
      },
      required: ['data'],
    },
  },
  {
    name: 'exec_terminal',
    description: 'Run a command in an interactive terminal and return output after a quiet period. Use for user-visible shell work in the right panel. For headless one-shots prefer shell_execute.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        terminalId: { type: 'string' },
        command: { type: 'string' },
        timeout_ms: { type: 'number' },
        quiet_ms: { type: 'number' },
      },
      required: ['command'],
    },
  },
] as const;

export function createTerminalToolHandlers(host: EmbeddedTerminalHost): AgentToolHandler[] {
  return TERMINAL_TOOL_DESCRIPTORS.map(desc => ({
    name: `terminal__${desc.name}`,
    description: desc.description,
    inputSchema: desc.inputSchema as Record<string, unknown>,
    execute: async (args: Record<string, unknown>) => {
      const result = await host.callTool(desc.name, args);
      if (result.error) return toolErr(result.error);
      return result.content;
    },
  }));
}
