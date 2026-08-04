/**
 * Embedded PTY sessions for the Team Chat right-panel terminal.
 * Mirrors embedded-browser.ts: create / write / resize / destroy / list + ring buffer.
 */

import { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

export type TerminalSessionInfo = {
  id: string;
  title: string;
  cwd: string;
  pid?: number;
  exited?: boolean;
  exitCode?: number;
};

type PtyProcess = {
  pid: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
};

type Slot = {
  id: string;
  title: string;
  cwd: string;
  pty: PtyProcess;
  /** Ring buffer of raw PTY output for Agent read / recent-output chips. */
  buffer: string;
  exited: boolean;
  exitCode?: number;
  cols: number;
  rows: number;
};

const MAX_BUFFER_CHARS = 256_000;
const sessions = new Map<string, Slot>();
let selectedId: string | null = null;

type PtyModule = {
  spawn: (
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ) => PtyProcess;
};

let ptyMod: PtyModule | null = null;
let ptyLoadError: string | null = null;

function loadPty(): PtyModule {
  if (ptyMod) return ptyMod;
  try {
    // Native module — kept external from the esbuild bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyMod = require('node-pty') as PtyModule;
    return ptyMod;
  } catch (err) {
    ptyLoadError = err instanceof Error ? err.message : String(err);
    throw new Error(`node-pty unavailable: ${ptyLoadError}`);
  }
}

function shellArgsFor(file: string): string[] {
  // fish: interactive; bash/zsh: login so profile/rc load like a real terminal.
  if (/fish$/i.test(file)) return ['-i'];
  if (/\/(?:ba)?sh$|zsh$/i.test(file)) return ['-l'];
  return [];
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const comspec = process.env['COMSPEC'];
    if (comspec && existsSync(comspec)) {
      return { file: comspec, args: /powershell/i.test(comspec) ? ['-NoLogo'] : [] };
    }
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    if (existsSync(ps)) return { file: ps, args: ['-NoLogo'] };
    return { file: 'cmd.exe', args: [] };
  }

  // Prefer the directory-service login shell (what `chsh` updates) over process.env.SHELL.
  // Electron/GUI apps often keep a stale $SHELL from launch (e.g. old Homebrew Cellar path)
  // even after the user fixes their login shell — that made us fall through to zsh.
  let loginShell = '';
  try { loginShell = userInfo().shell || ''; } catch { /* ignore */ }

  const candidates = [
    loginShell,
    process.env['SHELL'] || '',
    '/opt/homebrew/bin/fish',
    '/usr/local/bin/fish',
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ];
  for (const file of candidates) {
    if (file && existsSync(file)) return { file, args: shellArgsFor(file) };
  }
  return { file: '/bin/sh', args: [] };
}

function defaultCwd(cwd?: string): string {
  if (cwd && existsSync(cwd)) return cwd;
  const home = homedir();
  return existsSync(home) ? home : process.cwd();
}

function appendBuffer(slot: Slot, data: string): void {
  slot.buffer += data;
  if (slot.buffer.length > MAX_BUFFER_CHARS) {
    slot.buffer = slot.buffer.slice(slot.buffer.length - MAX_BUFFER_CHARS);
  }
}

function emitToRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export function createEmbeddedTerminal(
  id: string,
  opts?: { cwd?: string; title?: string; cols?: number; rows?: number },
): { ok: boolean; error?: string; info?: TerminalSessionInfo } {
  if (!id || typeof id !== 'string') return { ok: false, error: 'id required' };
  const existing = sessions.get(id);
  if (existing && !existing.exited) {
    // Re-attach to a live PTY — do NOT re-emit "opened" (avoids UI mode steal / remount loops).
    selectedId = id;
    return {
      ok: true,
      info: {
        id: existing.id,
        title: existing.title,
        cwd: existing.cwd,
        pid: existing.pty.pid,
        exited: false,
      },
    };
  }
  // Dead session left from a failed shell (e.g. stale $SHELL path) — recreate cleanly.
  if (existing?.exited) {
    sessions.delete(id);
  }

  try {
    const pty = loadPty();
    const { file, args } = defaultShell();
    const cwd = defaultCwd(opts?.cwd);
    const cols = opts?.cols && opts.cols > 0 ? opts.cols : 80;
    const rows = opts?.rows && opts.rows > 0 ? opts.rows : 24;
    const title = opts?.title || 'Terminal';

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env as Record<string, string>,
        // Keep child $SHELL aligned with the binary we actually spawned (not a stale GUI env).
        SHELL: file,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    const slot: Slot = {
      id,
      title,
      cwd,
      pty: proc,
      buffer: '',
      exited: false,
      cols,
      rows,
    };

    proc.onData((data) => {
      appendBuffer(slot, data);
      emitToRenderers('terminal:data', { id, data });
    });

    proc.onExit(({ exitCode }) => {
      slot.exited = true;
      slot.exitCode = exitCode;
      emitToRenderers('terminal:exit', { id, exitCode });
    });

    sessions.set(id, slot);
    selectedId = id;
    emitToRenderers('terminal:event', { type: 'opened', id, title, cwd });
    return {
      ok: true,
      info: { id, title, cwd, pid: proc.pid, exited: false },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function writeEmbeddedTerminal(id: string, data: string): { ok: boolean; error?: string } {
  const slot = sessions.get(id);
  if (!slot) return { ok: false, error: `Terminal not found: ${id}` };
  if (slot.exited) return { ok: false, error: `Terminal exited: ${id}` };
  try {
    slot.pty.write(data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function resizeEmbeddedTerminal(
  id: string,
  cols: number,
  rows: number,
): { ok: boolean; error?: string } {
  const slot = sessions.get(id);
  if (!slot) return { ok: false, error: `Terminal not found: ${id}` };
  if (slot.exited) return { ok: true };
  try {
    const c = Math.max(2, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    slot.pty.resize(c, r);
    slot.cols = c;
    slot.rows = r;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function destroyEmbeddedTerminal(id: string): { ok: boolean } {
  const slot = sessions.get(id);
  if (!slot) return { ok: true };
  try {
    if (!slot.exited) slot.pty.kill();
  } catch { /* ignore */ }
  sessions.delete(id);
  if (selectedId === id) {
    selectedId = sessions.keys().next().value ?? null;
  }
  emitToRenderers('terminal:event', { type: 'closed', id });
  return { ok: true };
}

export function listEmbeddedTerminals(): TerminalSessionInfo[] {
  return [...sessions.values()].map(s => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    pid: s.pty.pid,
    exited: s.exited,
    exitCode: s.exitCode,
  }));
}

export function getEmbeddedTerminalBuffer(
  id: string,
  opts?: { maxChars?: number; maxLines?: number },
): { ok: boolean; content?: string; error?: string } {
  const slot = sessions.get(id);
  if (!slot) return { ok: false, error: `Terminal not found: ${id}` };
  let content = slot.buffer;
  if (opts?.maxLines != null && opts.maxLines > 0) {
    const lines = content.split(/\r?\n/);
    content = lines.slice(-opts.maxLines).join('\n');
  }
  if (opts?.maxChars != null && opts.maxChars > 0 && content.length > opts.maxChars) {
    content = content.slice(content.length - opts.maxChars);
  }
  return { ok: true, content };
}

export function selectEmbeddedTerminal(id: string): { ok: boolean; error?: string } {
  if (!sessions.has(id)) return { ok: false, error: `Terminal not found: ${id}` };
  const s = sessions.get(id)!;
  // Skip no-op selects — re-emitting "selected" forces the renderer back into terminal mode.
  if (selectedId === id) {
    return { ok: true };
  }
  selectedId = id;
  emitToRenderers('terminal:event', { type: 'selected', id, title: s.title, cwd: s.cwd });
  return { ok: true };
}

export function getSelectedEmbeddedTerminalId(): string | null {
  return selectedId;
}

export function updateEmbeddedTerminalMeta(
  id: string,
  patch: { title?: string; cwd?: string },
): { ok: boolean; error?: string } {
  const slot = sessions.get(id);
  if (!slot) return { ok: false, error: `Terminal not found: ${id}` };
  if (patch.title) slot.title = patch.title;
  if (patch.cwd) slot.cwd = patch.cwd;
  return { ok: true };
}

export function hasEmbeddedTerminals(): boolean {
  return sessions.size > 0;
}

export function destroyAllEmbeddedTerminals(): void {
  for (const id of [...sessions.keys()]) {
    destroyEmbeddedTerminal(id);
  }
}

/**
 * Write a command and wait until output is quiet (or timeout).
 * Used by Agent `exec_terminal`.
 */
export async function execEmbeddedTerminal(
  id: string,
  command: string,
  opts?: { timeoutMs?: number; quietMs?: number },
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const slot = sessions.get(id);
  if (!slot) return { ok: false, error: `Terminal not found: ${id}` };
  if (slot.exited) return { ok: false, error: `Terminal exited: ${id}` };

  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const quietMs = opts?.quietMs ?? 400;
  const markerStart = slot.buffer.length;
  const payload = command.endsWith('\n') || command.endsWith('\r') ? command : `${command}\n`;

  try {
    slot.pty.write(payload);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const started = Date.now();
  let lastLen = slot.buffer.length;
  let lastChange = Date.now();

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const len = slot.buffer.length;
      if (len !== lastLen) {
        lastLen = len;
        lastChange = Date.now();
      }
      const quiet = Date.now() - lastChange >= quietMs;
      const timedOut = Date.now() - started >= timeoutMs;
      if ((quiet && len > markerStart) || timedOut || slot.exited) {
        clearInterval(timer);
        resolve({
          ok: true,
          output: slot.buffer.slice(markerStart),
          ...(timedOut && !quiet ? { error: 'timeout' } : {}),
        });
      }
    }, 50);
  });
}
