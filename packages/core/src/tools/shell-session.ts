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

export interface ShellSession {
  id: string;
  agentId: string;
  process: ChildProcess;
  cwd: string;
  createdAt: number;
  lastUsedAt: number;
  alive: boolean;
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
  readonly createdAt = Date.now();
  lastUsedAt = Date.now();
  alive = true;

  private pending: PendingCommand | null = null;
  private dataBuffer = '';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(id: string, agentId: string, proc: ChildProcess) {
    this.id = id;
    this.agentId = agentId;
    this.process = proc;

    proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
    proc.stderr?.on('data', (chunk: Buffer) => this.onData(chunk.toString()));

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
        this.resetIdleTimer();
        resolve({
          stdout: partial + `\n[Command timed out after ${timeoutMs}ms]`,
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

      // Write the command followed by a sentinel echo.
      // The sentinel captures $? (exit code of the user's command).
      const script = `${command}\necho ${sentinel}_$?_\n`;
      this.process.stdin?.write(script);
    });
  }

  kill() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.alive = false;
    this.rejectPending('Session killed');
    try {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        try { this.process.kill('SIGKILL'); } catch { /* already dead */ }
      }, 1000);
    } catch { /* already dead */ }
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

    return this.createSession(defaultId, agentId, cwd);
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
    if (options?.sessionId) {
      session = this.get(options.sessionId);
      if (!session) {
        return { stdout: `[Session ${options.sessionId} not found]`, exitCode: -1 };
      }
    } else {
      session = this.getOrCreateDefault(agentId, options?.cwd);
    }

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

    return session.execute(command, timeoutMs, options?.onOutput);
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
    const shell = process.env['SHELL'] || '/bin/sh';
    const child = spawn(shell, ['--norc', '--noprofile', '-i'], {
      cwd: cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PS1: '',
        PS2: '',
        PROMPT_COMMAND: '',
        TERM: 'dumb',
      },
    });

    const session = new ManagedSession(sessionId, agentId, child);
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
