/**
 * Persistent shell session manager.
 *
 * Instead of spawning a new `sh -c` per tool call (one-shot), this keeps a
 * long-running shell process alive. cd, env vars, and shell state persist
 * across commands within the same session.
 *
 * Command completion is detected via a unique sentinel line echoed after the
 * command finishes, carrying the exit code.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  SHELL_TIMEOUT_DEFAULT_MS,
  SHELL_TIMEOUT_MAX_MS,
  SHELL_MAX_SESSIONS_PER_AGENT,
  SHELL_SESSION_IDLE_TIMEOUT_MS,
  SHELL_SESSION_MAX_OUTPUT_BYTES,
} from '@markus/shared';
import { existsSync } from 'node:fs';
import { killProcessTree } from './process-group.js';

/**
 * Pick the shell used for persistent sessions.
 *
 * WHY NOT `$SHELL`
 * ----------------
 * `$SHELL` mirrors the *user's login shell*, which is frequently NOT a POSIX
 * shell: fish, csh/tcsh, nu, pwsh…  The session protocol below relies on POSIX
 * behaviour (piping a command in, sourcing a sentinel back out), so a
 * non-POSIX shell makes **every command fail instantly** with confusing errors
 * like `Unable to read input file: Is a directory` — the agent then reports
 * "commands don't work / hang", which is misdiagnosed as a timeout bug.
 *
 * We therefore prefer a known-good POSIX shell and only fall back to `$SHELL`
 * as a last resort.
 */
function resolvePosixShell(): string {
  for (const candidate of ['/bin/bash', '/bin/zsh', '/bin/sh']) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return process.env['SHELL'] || '/bin/sh';
}

export interface ShellSession {
  id: string;
  agentId: string;
  process: ChildProcess;
  cwd: string;
  createdAt: number;
  lastUsedAt: number;
  alive: boolean;
  /**
   * The shell leads its own POSIX process group, so killing the session also
   * reaps whatever the agent launched through it.
   */
  isolatedGroup: boolean;
}

interface PendingCommand {
  sentinel: string;
  output: string;
  resolve: (result: { stdout: string; exitCode: number }) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SENTINEL_PREFIX = '__MARKUS_DONE_';

function makeSentinel(): string {
  return SENTINEL_PREFIX + randomBytes(8).toString('hex');
}

/**
 * Wraps a long-lived shell process, routing commands through it and detecting
 * completion via sentinel lines.
 */
class ManagedSession {
  readonly id: string;
  readonly agentId: string;
  readonly process: ChildProcess;
  readonly isolatedGroup: boolean;
  readonly createdAt = Date.now();
  lastUsedAt = Date.now();
  alive = true;
  /** Why this session was force-terminated (diagnostics only). */
  terminationReason: string | null = null;

  private pending: PendingCommand | null = null;
  private dataBuffer = '';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(id: string, agentId: string, proc: ChildProcess, isolatedGroup = false) {
    this.id = id;
    this.agentId = agentId;
    this.process = proc;
    this.isolatedGroup = isolatedGroup;

    proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
    proc.stderr?.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
    proc.stdin?.on('error', () => { /* suppress EPIPE when shell exits before write */ });

    proc.on('exit', () => {
      this.alive = false;
      this.rejectPending('Shell session exited unexpectedly');
    });
    proc.on('error', () => {
      this.alive = false;
      this.rejectPending('Shell session error');
    });

    this.resetIdleTimer();
  }

  private onData(data: string) {
    if (!this.pending) return;

    this.pending.output += data;
    // Cap buffer to prevent memory issues
    if (this.pending.output.length > SHELL_SESSION_MAX_OUTPUT_BYTES) {
      const keep = SHELL_SESSION_MAX_OUTPUT_BYTES - 1000;
      this.pending.output =
        '[... truncated ...]\n' + this.pending.output.slice(-keep);
    }

    const sentinelRe = new RegExp(
      `${this.pending.sentinel}_(\\d+)_\n?$`
    );
    const match = this.pending.output.match(sentinelRe);
    if (match) {
      const exitCode = parseInt(match[1]!, 10);
      const output = this.pending.output
        .slice(0, match.index)
        .replace(/^\n/, '');
      clearTimeout(this.pending.timer);
      const p = this.pending;
      this.pending = null;
      this.resetIdleTimer();
      p.resolve({ stdout: output, exitCode });
    }
  }

  private rejectPending(reason: string) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      const p = this.pending;
      this.pending = null;
      p.resolve({ stdout: p.output + `\n[${reason}]`, exitCode: -1 });
    }
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.kill(), SHELL_SESSION_IDLE_TIMEOUT_MS);
  }

  /**
   * Execute a command in this session.  Returns when the sentinel is detected
   * or the timeout fires.
   */
  execute(
    command: string,
    timeoutMs: number,
    onOutput?: (chunk: string) => void,
  ): Promise<{ stdout: string; exitCode: number }> {
    if (!this.alive) {
      return Promise.resolve({
        stdout: '[Session is no longer alive]',
        exitCode: -1,
      });
    }

    if (this.pending) {
      return Promise.resolve({
        stdout: '[Session is busy with another command]',
        exitCode: -1,
      });
    }

    this.lastUsedAt = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);

    const sentinel = makeSentinel();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const partial = this.pending?.output ?? '';
        this.pending = null;
        // A timeout MUST terminate the command, not just give up on waiting.
        // The previous implementation only resolved the promise: the command
        // (and everything it had spawned) kept running, and the shell stayed
        // busy forever, so every later command in this session queued behind
        // the runaway process and "timed out" as well — the session was wedged
        // (owner report 2026-10-01: a 120s limit never actually stopped
        // anything).  Terminating the session is the only deterministic way to
        // stop an arbitrary subtree from a persistent shell; the manager
        // transparently recreates a clean session (same cwd) on next use.
        this.terminate('timed out');
        resolve({
          stdout:
            partial +
            `\n[Command timed out after ${timeoutMs}ms — command and its child processes were killed; the shell session was reset.]`,
          exitCode: -1,
        });
      }, timeoutMs);

      this.pending = { sentinel, output: '', resolve, timer };

      if (onOutput) {
        const origOnData = this.onData.bind(this);
        const origPendingRef = this.pending;
        let lastLen = 0;
        const outputPoll = setInterval(() => {
          if (this.pending !== origPendingRef) {
            clearInterval(outputPoll);
            return;
          }
          const newContent = this.pending.output.slice(lastLen);
          if (newContent) {
            // Strip sentinel from streamed output
            const cleaned = newContent.replace(
              new RegExp(`echo ${sentinel}_\\$\\?_`),
              '',
            );
            if (cleaned) onOutput(cleaned);
            lastLen = this.pending.output.length;
          }
        }, 200);

        const origResolve = this.pending.resolve;
        this.pending.resolve = (result) => {
          clearInterval(outputPoll);
          origResolve(result);
        };
      }

      const script = `${command}\necho ${sentinel}_$?_\n`;
      try {
        this.process.stdin?.write(script);
      } catch {
        /* EPIPE: shell already exited; the 'exit' handler will resolve */
      }
    });
  }

  kill() {
    this.terminate('killed');
  }

  /**
   * Force-terminate this session and everything it spawned.
   *
   * SIGTERM → SIGKILL over the whole process group: anything the agent started
   * through this session (dev servers, watchers, test runners) must die with
   * it, otherwise it is reparented to PID 1 and leaks forever.  Used both by
   * kill() and by the command-timeout path.
   */
  terminate(reason: string) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.terminationReason = reason;
    this.alive = false;
    this.rejectPending(`Session terminated: ${reason}`);
    killProcessTree(this.process, this.process.pid ?? 0, this.isolatedGroup);
  }

  toInfo(): ShellSession {
    return {
      id: this.id,
      agentId: this.agentId,
      process: this.process,
      cwd: '',
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      alive: this.alive,
      isolatedGroup: this.isolatedGroup,
    };
  }
}

/**
 * Manages persistent shell sessions for agents.
 * Each agent can have up to SHELL_MAX_SESSIONS_PER_AGENT concurrent sessions.
 */
export class ShellSessionManager {
  private sessions = new Map<string, ManagedSession>();
  private agentSessions = new Map<string, Set<string>>();
  /** Last known cwd per session id — survives session recreation (e.g. after a timeout). */
  private sessionCwd = new Map<string, string>();

  /**
   * Get or create the default session for an agent.
   * If no session exists, one is lazily created.
   */
  getOrCreateDefault(agentId: string, cwd?: string): ManagedSession {
    const defaultId = `${agentId}:default`;
    const existing = this.sessions.get(defaultId);
    if (existing?.alive) return existing;

    if (existing && !existing.alive) {
      this.removeSession(defaultId);
    }

    return this.createSession(
      defaultId,
      agentId,
      cwd ?? this.sessionCwd.get(defaultId),
    );
  }

  /**
   * Create a named session for an agent.
   */
  create(agentId: string, sessionName: string, cwd?: string): ManagedSession | null {
    const sessionId = `${agentId}:${sessionName}`;
    if (this.sessions.has(sessionId)) {
      const s = this.sessions.get(sessionId)!;
      if (s.alive) return s;
      this.removeSession(sessionId);
    }

    const agentSet = this.agentSessions.get(agentId) ?? new Set();
    if (agentSet.size >= SHELL_MAX_SESSIONS_PER_AGENT) {
      return null;
    }

    return this.createSession(sessionId, agentId, cwd);
  }

  get(sessionId: string): ManagedSession | undefined {
    const s = this.sessions.get(sessionId);
    if (s && !s.alive) {
      this.removeSession(sessionId);
      return undefined;
    }
    return s;
  }

  /**
   * Execute a command in the given session (or agent default).
   */
  async execute(
    agentId: string,
    command: string,
    options?: {
      sessionId?: string;
      cwd?: string;
      timeoutMs?: number;
      onOutput?: (chunk: string) => void;
    },
  ): Promise<{ stdout: string; exitCode: number }> {
    const timeoutMs = Math.min(
      options?.timeoutMs ?? SHELL_TIMEOUT_DEFAULT_MS,
      SHELL_TIMEOUT_MAX_MS,
    );

    let session: ManagedSession | undefined;
    let sessionId: string;
    if (options?.sessionId) {
      sessionId = options.sessionId;
      session = this.get(sessionId);
      if (!session) {
        return { stdout: `[Session ${sessionId} not found]`, exitCode: -1 };
      }
    } else {
      sessionId = `${agentId}:default`;
      session = this.getOrCreateDefault(agentId, options?.cwd);
    }

    // Remember the working directory so a session that has to be recreated
    // (timeout termination, unexpected exit) resumes in the same place.
    const effectiveCwd = options?.cwd ?? this.sessionCwd.get(sessionId);
    if (options?.cwd) this.sessionCwd.set(sessionId, options.cwd);

    // If cwd is specified and differs, cd to it first
    if (options?.cwd) {
      const cdResult = await session.execute(
        `cd ${JSON.stringify(options.cwd)} 2>/dev/null`,
        5000,
      );
      if (cdResult.exitCode !== 0) {
        return { stdout: `[Failed to cd to ${options.cwd}]`, exitCode: -1 };
      }
    }

    const result = await session.execute(command, timeoutMs, options?.onOutput);

    // A timed-out command terminates its session (see ManagedSession.execute):
    // the shell is gone, so drop it from the registry.  The next call lazily
    // starts a clean session in the remembered cwd — the agent never inherits a
    // wedged shell that would make every subsequent command time out too.
    if (!session.alive) {
      if (effectiveCwd) this.sessionCwd.set(sessionId, effectiveCwd);
      this.removeSession(sessionId);
    }

    return result;
  }

  listForAgent(agentId: string): ShellSession[] {
    const ids = this.agentSessions.get(agentId);
    if (!ids) return [];
    const result: ShellSession[] = [];
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s?.alive) result.push(s.toInfo());
    }
    return result;
  }

  killSession(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.kill();
    this.removeSession(sessionId);
    return true;
  }

  killAllForAgent(agentId: string): void {
    const ids = this.agentSessions.get(agentId);
    if (!ids) return;
    for (const id of [...ids]) {
      this.killSession(id);
    }
  }

  destroyAll(): void {
    for (const [id, s] of this.sessions) {
      s.kill();
    }
    this.sessions.clear();
    this.agentSessions.clear();
  }

  private createSession(sessionId: string, agentId: string, cwd?: string): ManagedSession {
    const isWin = process.platform === 'win32';
    const shell = isWin
      ? (process.env['COMSPEC'] || 'cmd.exe')
      : resolvePosixShell();
    const isBashLike = !isWin && /\b(bash|zsh)\b/.test(shell);
    const args = isWin ? ['/Q'] : (isBashLike ? ['--norc', '--noprofile', '-i'] : []);
    const child = spawn(shell, args, {
      cwd: cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(isWin ? {} : { PS1: '', PS2: '', PROMPT_COMMAND: '', TERM: 'dumb', ENV: '' }),
      },
      windowsHide: true,
      // Own process group (setsid) → killSession() can reap descendants too.
      detached: !isWin,
    });

    // Two interactive-mode behaviours must be neutralised at session start.
    //
    // 1. Job control (`set +m`). `bash -i` turns on monitor mode (`set -m`),
    //    which puts every command — including `cmd &` — in its OWN process
    //    group. The session group then no longer contains the real work, so
    //    `kill(-pgid)` reaps only the shell and the actual command keeps running
    //    (observed: `sleep` grandchildren alive minutes after a timeout fired).
    //    `set +m` keeps every descendant inside the session's group.
    //
    // 2. Input echo (`set +o emacs`). GNU bash 5 — the version on Linux/CI —
    //    ECHOES every command it reads back to **stderr** when interactive with
    //    a non-tty stdin (bash 3.2 on macOS does not). ManagedSession merges
    //    stderr into the sentinel-parsing buffer (see the stderr handler in the
    //    constructor), so the echoed command leaked into the result `stdout` —
    //    e.g. `echo $X` came back as "echo $X\n<value>\n" instead of "<value>".
    //    Disabling emacs readline mode (neither emacs nor vi active) makes bash
    //    read plainly and stop echoing. Reproduced 2026-10-02 on bash 5.2;
    //    absent on bash 3.2.
    //
    // Both are written before any user command; their own echo and bash's
    // startup banners arrive before the first `pending` command exists, so
    // `onData` (which returns early when nothing is pending) drops them.
    try {
      child.stdin?.write('set +m 2>/dev/null; set +o emacs 2>/dev/null\n');
    } catch {
      /* best effort: worst case we fall back to the per-process kill */
    }

    const session = new ManagedSession(
      sessionId,
      agentId,
      child,
      // Trust the spawn contract (`detached: !isWin` ⇒ POSIX setsid ⇒ pgid === pid).
      // Do NOT re-derive this with a `ps` probe: that reports the process's CURRENT
      // state, not the spawn contract. Measured failure (2026-10-01): 0/25 wrong
      // while the wrapper is alive, but 100% wrong once the wrapper has exited
      // (self-daemonizing commands) → the kill path degrades to "kill the wrapper
      // only" and every descendant leaks. See process-group.ts for the full note.
      !isWin,
    );
    this.sessions.set(sessionId, session);

    const agentSet = this.agentSessions.get(agentId) ?? new Set();
    agentSet.add(sessionId);
    this.agentSessions.set(agentId, agentSet);

    return session;
  }

  private removeSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s) {
      const agentSet = this.agentSessions.get(s.agentId);
      agentSet?.delete(sessionId);
      if (agentSet?.size === 0) this.agentSessions.delete(s.agentId);
    }
    this.sessions.delete(sessionId);
  }
}

/** Singleton instance shared across the process. */
let _defaultManager: ShellSessionManager | undefined;

export function getShellSessionManager(): ShellSessionManager {
  if (!_defaultManager) {
    _defaultManager = new ShellSessionManager();
  }
  return _defaultManager;
}
