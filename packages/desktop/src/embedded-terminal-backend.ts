/**
 * Agent-facing host for embedded PTY terminals (desktop only).
 *
 * Duck-typed to match `@markus/core` EmbeddedTerminalHost (injected at runtime).
 */

import {
  createEmbeddedTerminal,
  destroyEmbeddedTerminal,
  execEmbeddedTerminal,
  getEmbeddedTerminalBuffer,
  getSelectedEmbeddedTerminalId,
  listEmbeddedTerminals,
  selectEmbeddedTerminal,
  updateEmbeddedTerminalMeta,
  writeEmbeddedTerminal,
} from './embedded-terminal.js';

export interface EmbeddedTerminalToolResult {
  content: string;
  error?: string;
}

export interface EmbeddedTerminalHost {
  available(): boolean;
  callTool(name: string, args: Record<string, unknown>): Promise<EmbeddedTerminalToolResult>;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'list_terminals': {
      const list = listEmbeddedTerminals();
      if (list.length === 0) return 'No terminals open.';
      const selected = getSelectedEmbeddedTerminalId();
      return list.map((t, i) => {
        const mark = t.id === selected ? ' (selected)' : '';
        const status = t.exited ? ` exited=${t.exitCode ?? '?'}` : '';
        return `${i + 1}. id=${t.id} title=${JSON.stringify(t.title)} cwd=${t.cwd}${status}${mark}`;
      }).join('\n');
    }

    case 'new_terminal': {
      const id = asString(args.terminalId) || asString(args.id)
        || `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const cwd = asString(args.cwd) || undefined;
      const title = asString(args.title) || 'Terminal';
      const result = createEmbeddedTerminal(id, { cwd, title });
      if (!result.ok) throw new Error(result.error || 'Failed to create terminal');
      return `Created terminal ${id}\nTitle: ${title}\nCwd: ${result.info?.cwd ?? cwd ?? ''}`;
    }

    case 'select_terminal': {
      const id = asString(args.terminalId) || asString(args.id);
      if (!id) throw new Error('terminalId required');
      const result = selectEmbeddedTerminal(id);
      if (!result.ok) throw new Error(result.error || 'select failed');
      return `Selected terminal ${id}`;
    }

    case 'close_terminal': {
      const id = asString(args.terminalId) || asString(args.id);
      if (!id) throw new Error('terminalId required');
      destroyEmbeddedTerminal(id);
      return `Closed terminal ${id}`;
    }

    case 'read_terminal': {
      const id = asString(args.terminalId) || asString(args.id) || getSelectedEmbeddedTerminalId() || '';
      if (!id) throw new Error('terminalId required (or select a terminal first)');
      const maxLines = asNumber(args.max_lines ?? args.maxLines, 120);
      const maxChars = asNumber(args.max_chars ?? args.maxChars, 24_000);
      const result = getEmbeddedTerminalBuffer(id, { maxLines, maxChars });
      if (!result.ok) throw new Error(result.error || 'read failed');
      return result.content || '(empty)';
    }

    case 'write_terminal': {
      const id = asString(args.terminalId) || asString(args.id) || getSelectedEmbeddedTerminalId() || '';
      if (!id) throw new Error('terminalId required (or select a terminal first)');
      const data = asString(args.data ?? args.text ?? args.input);
      if (!data) throw new Error('data required');
      const result = writeEmbeddedTerminal(id, data);
      if (!result.ok) throw new Error(result.error || 'write failed');
      return `Wrote ${data.length} chars to ${id}`;
    }

    case 'exec_terminal': {
      const id = asString(args.terminalId) || asString(args.id) || getSelectedEmbeddedTerminalId() || '';
      if (!id) throw new Error('terminalId required (or select a terminal first)');
      const command = asString(args.command) || asString(args.cmd);
      if (!command) throw new Error('command required');
      const timeoutMs = asNumber(args.timeout_ms ?? args.timeoutMs, 30_000);
      const quietMs = asNumber(args.quiet_ms ?? args.quietMs, 400);
      const result = await execEmbeddedTerminal(id, command, { timeoutMs, quietMs });
      if (!result.ok) throw new Error(result.error || 'exec failed');
      const out = result.output || '';
      return result.error === 'timeout'
        ? `[timeout after ${timeoutMs}ms]\n${out}`
        : out || '(no output)';
    }

    case 'rename_terminal': {
      const id = asString(args.terminalId) || asString(args.id);
      const title = asString(args.title);
      if (!id || !title) throw new Error('terminalId and title required');
      const result = updateEmbeddedTerminalMeta(id, { title });
      if (!result.ok) throw new Error(result.error || 'rename failed');
      return `Renamed terminal ${id} → ${title}`;
    }

    default:
      throw new Error(`Unsupported embedded terminal tool: ${name}`);
  }
}

export function createEmbeddedTerminalHost(): EmbeddedTerminalHost {
  return {
    available: () => true,
    callTool: async (name, args): Promise<EmbeddedTerminalToolResult> => {
      try {
        const content = await handleTool(name, args);
        return { content };
      } catch (err) {
        return { content: '', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
