import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { platform } from 'node:os';
import type { AgentToolHandler } from '../agent.js';
import { pendingCallbackRegistry } from '../pending-callback.js';
import {
  KILL_GRACE_MS,
  isProcessGroupAlive,
  killProcessTree,
  type SignalDelivery,
} from './process-group.js';

interface BackgroundSession {
  id: string;
  pid: number;
  command: string;
  startedAt: number;
  exitCode: number | null;
  stdout: string[];
  stderr: string[];
  process: ChildProcess;
  /** Whether the completion has been consumed via drainCompletedNotifications */
  notified: boolean;
  /** Resolves when the process exits (any cause). Idempotent; lets a turn await
   *  the result in-band (`background_wait`) instead of via a separate turn. */
  done: Promise<void>;
  resolveDone: () => void;
  /**
   * The wrapper leads its own POSIX process group (spawned `detached`), so
   * `kill(-pid)` reaches every descendant instead of only the shell.
   */
  isolatedGroup: boolean;
  /** How the last termination signal was delivered (for diagnostics). */
  killDelivery?: SignalDelivery;
}

/** Wrapper already exited, yet members of its process group are still alive. */
function hasLeakedDescendants(s: BackgroundSession): boolean {
  return s.exitCode !== null && s.isolatedGroup && isProcessGroupAlive(s.pid);
}

const sessions = new Map<string, BackgroundSession>();
let sessionCounter = 0;

/**
 * Results already read IN-TURN (`background_wait`, or `process poll`/`log` on a
 * finished session). A completion whose result the launching turn already
 * consumed must NOT spawn another attention cycle — that turn would burn a full
 * context re-injection re-deriving what the agent already knows (measured:
 * ~53k tokens / 0 tools / HEARTBEAT_OK per redundant callback).
 *
 * Kept separate from `sessions` so `process clear` cannot erase the dedupe
 * evidence while a queued callback item is still waiting. TTL-bounded.
 */
const consumedResults = new Map<string, number>();
const CONSUMED_TTL_MS = 60 * 60 * 1000;
const CONSUMED_MAX = 1000;

function markResultConsumed(session: BackgroundSession): void {
  if (session.exitCode === null) return;
  session.notified = true;
  consumedResults.set(session.id, Date.now());
  // Close the pending question: the completion bus peeks the registry for
  // lineage, so a resolved entry means "nothing left to deliver". If the bus
  // already fired (completion preceded the read), the queued mailbox item is
  // skipped at processing time via wasBackgroundResultConsumed — both
  // orderings are covered by the same consumption fact.
  pendingCallbackRegistry.resolve(session.id);
  if (consumedResults.size > CONSUMED_MAX) {
    const now = Date.now();
    for (const [id, at] of consumedResults) {
      if (now - at > CONSUMED_TTL_MS) consumedResults.delete(id);
    }
    while (consumedResults.size > CONSUMED_MAX) {
      const oldest = consumedResults.keys().next().value;
      if (oldest === undefined) break;
      consumedResults.delete(oldest);
    }
  }
}

/**
 * Sessions a turn is awaiting IN-BAND right now (`background_wait` in flight).
 * The completion bus fires synchronously on exit — BEFORE the waiting turn's
 * continuation resumes — so "consumed" alone cannot suppress that delivery.
 * While a waiter is active the result belongs to that turn: the bus defers,
 * and `background_wait` consumes + resolves the registry entry itself.
 */
const activeWaiters = new Map<string, number>();

/** True while some turn is inside `background_wait` for this session. */
export function hasActiveBackgroundWaiter(sessionId: string): boolean {
  return (activeWaiters.get(sessionId) ?? 0) > 0;
}

/** True when this session's final result was already returned to a turn. */
export function wasBackgroundResultConsumed(sessionId: string): boolean {
  const at = consumedResults.get(sessionId);
  if (at === undefined) return false;
  if (Date.now() - at > CONSUMED_TTL_MS) {
    consumedResults.delete(sessionId);
    return false;
  }
  return true;
}

export type CompletionCallback = (notification: {
  sessionId: string;
  command: string;
  exitCode: number;
  durationMs: number;
  stderrTail: string;
  stdoutTail: string;
}) => void;

const completionListeners: CompletionCallback[] = [];

/**
 * Register a listener that fires when any background session completes.
 * Used by the agent to inject completion notifications into conversations.
 */
export function onBackgroundCompletion(cb: CompletionCallback): () => void {
  completionListeners.push(cb);
  return () => {
    const idx = completionListeners.indexOf(cb);
    if (idx >= 0) completionListeners.splice(idx, 1);
  };
}

/**
 * Drain all sessions that completed since the last drain but haven't been
 * notified yet. Returns summaries suitable for injecting into agent context.
 */
export function drainCompletedNotifications(): Array<{
  sessionId: string;
  command: string;
  exitCode: number;
  durationMs: number;
  stderrTail: string;
  stdoutTail: string;
}> {
  const results: Array<{
    sessionId: string;
    command: string;
    exitCode: number;
    durationMs: number;
    stderrTail: string;
    stdoutTail: string;
  }> = [];
  for (const s of sessions.values()) {
    if (s.exitCode !== null && !s.notified) {
      s.notified = true;
      results.push({
        sessionId: s.id,
        command: s.command.slice(0, 200),
        exitCode: s.exitCode,
        durationMs: Date.now() - s.startedAt,
        stderrTail: s.stderr.slice(-10).join('\n'),
        stdoutTail: s.stdout.slice(-10).join('\n'),
      });
    }
  }
  return results;
}

function notifyCompletion(session: BackgroundSession): void {
  // Resolve in-turn waiters FIRST — even when no bus listener exists.
  session.resolveDone();
  if (completionListeners.length === 0) return;
  const notification = {
    sessionId: session.id,
    command: session.command.slice(0, 200),
    exitCode: session.exitCode ?? -1,
    durationMs: Date.now() - session.startedAt,
    stderrTail: session.stderr.slice(-10).join('\n'),
    stdoutTail: session.stdout.slice(-10).join('\n'),
  };
  for (const cb of completionListeners) {
    try { cb(notification); } catch { /* listener errors should not crash the manager */ }
  }
}

export function createBackgroundExecTool(workspacePath?: string): AgentToolHandler {
  return {
    name: 'background_exec',
    description: 'Run a shell command in the background. Returns immediately with a session ID. If you need the outcome to continue your current work (build/test/CI results), call "background_wait" with the session ID before ending the turn — the result arrives as a normal tool result in THIS turn. Use the "process" tool to poll, view logs, or kill. Ideal for long-running commands like dev servers, test suites, or builds. If you end the turn without consuming the result, a continuation turn notifies you when the process completes.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run in background' },
        cwd: { type: 'string', description: 'Working directory (optional, defaults to workspace)' },
        timeout_seconds: { type: 'number', description: 'Auto-kill after N seconds (default: 300)' },
      },
      required: ['command'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const command = args['command'] as string;
      const cwd = args['cwd'] as string | undefined;
      const timeoutSec = (args['timeout_seconds'] as number) ?? 300;

      const basePath = workspacePath ?? process.cwd();
      const effectiveCwd = cwd ? resolve(basePath, cwd) : basePath;

      if (workspacePath && !effectiveCwd.startsWith(resolve(workspacePath))) {
        return JSON.stringify({ status: 'denied', error: 'Working directory must be within workspace' });
      }

      const id = `bg_${++sessionCounter}_${Date.now()}`;

      const isWin = platform() === 'win32';
      const child = spawn(
        isWin ? process.env['COMSPEC'] || 'cmd.exe' : 'sh',
        isWin ? ['/d', '/s', '/c', command] : ['-c', command],
        {
          cwd: effectiveCwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // POSIX: give the wrapper its own process group (setsid) so that a
          // timeout/kill can reach the grandchildren too. Without this the
          // wrapper shares Markus' group and `kill(-pid)` would be unsafe.
          detached: !isWin,
        },
      );

      let resolveDone!: () => void;
      const done = new Promise<void>(res => { resolveDone = res; });

      const session: BackgroundSession = {
        id,
        pid: child.pid ?? 0,
        command,
        startedAt: Date.now(),
        exitCode: null,
        stdout: [],
        stderr: [],
        process: child,
        notified: false,
        done,
        resolveDone,
        // Trust the spawn contract: we passed `detached: !isWin`, so on POSIX
        // this child IS the leader of its own process group. Probing with `ps`
        // here is wrong — once the wrapper exits (self-daemonizing commands
        // such as `foo & exit`), `ps -p <pid>` returns nothing and the probe
        // reports "not isolated". The kill path then degrades to signalling the
        // (already dead) wrapper and every descendant leaks. Measured: 100%
        // leak for `sh -c 'sleep N & exit 0'` when the probe gated the kill.
        isolatedGroup: !isWin,
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        session.stdout.push(...lines);
        if (session.stdout.length > 2000) {
          session.stdout = session.stdout.slice(-1500);
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        session.stderr.push(...lines);
        if (session.stderr.length > 2000) {
          session.stderr = session.stderr.slice(-1500);
        }
      });

      let autoKillTimer: ReturnType<typeof setTimeout> | null = null;
      let cancelEscalation: (() => void) | null = null;
      const releaseTimers = () => {
        if (autoKillTimer) {
          clearTimeout(autoKillTimer);
          autoKillTimer = null;
        }
        cancelEscalation?.();
        cancelEscalation = null;
      };

      child.on('close', (code) => {
        releaseTimers();
        session.exitCode = code ?? -1;
        notifyCompletion(session);
      });
      child.on('exit', (code) => {
        if (session.exitCode === null) {
          session.exitCode = code ?? -1;
          notifyCompletion(session);
        }
      });

      // Auto-kill timeout. Kills the WHOLE process tree: signalling only the
      // wrapper used to leave grandchildren (`vitest` fork workers, `tsx`
      // watchers, …) alive and reparented to PID 1, where nothing could ever
      // reach them again.
      if (timeoutSec > 0) {
        autoKillTimer = setTimeout(() => {
          if (session.exitCode !== null) return;
          const handle = killProcessTree(child, session.pid, session.isolatedGroup, () => {
            // SIGTERM was ignored, SIGKILL has now been sent.
            if (session.exitCode === null) {
              session.exitCode = -1;
              notifyCompletion(session);
            }
          });
          session.killDelivery = handle.delivered;
          cancelEscalation = handle.cancelEscalation;
          if (session.exitCode === null) {
            session.exitCode = -1;
            notifyCompletion(session);
          }
        }, timeoutSec * 1000);
      }

      sessions.set(id, session);

      return JSON.stringify({
        status: 'running',
        sessionId: id,
        pid: child.pid,
        command,
        killsProcessTree: session.isolatedGroup,
      });
    },
  };
}

export function createProcessTool(): AgentToolHandler {
  return {
    name: 'process',
    description: 'Manage background exec sessions. Actions: list (show all sessions), poll (check status + new output), log (view output), kill (terminate), clear (remove finished sessions). Reading a FINISHED session\'s result via poll/log consumes it: the separate completion notification turn is suppressed (you already have the answer).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'poll', 'log', 'kill', 'clear'],
          description: 'Action to perform',
        },
        sessionId: { type: 'string', description: 'Session ID (required for poll/log/kill)' },
        tail: { type: 'number', description: 'Number of lines from end (for log action, default: 50)' },
      },
      required: ['action'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const action = args['action'] as string;
      const sessionId = args['sessionId'] as string | undefined;
      const tail = (args['tail'] as number) ?? 50;

      switch (action) {
        case 'list': {
          const list = [...sessions.values()].map(s => ({
            id: s.id,
            pid: s.pid,
            command: s.command.slice(0, 100),
            running: s.exitCode === null,
            exitCode: s.exitCode,
            uptime: s.exitCode === null ? Date.now() - s.startedAt : undefined,
            outputLines: s.stdout.length + s.stderr.length,
            // Wrapper gone but descendants still burning CPU → use
            // `process kill` on this session to reap them.
            orphanedDescendants: hasLeakedDescendants(s) || undefined,
          }));
          return JSON.stringify({ status: 'success', sessions: list });
        }

        case 'poll': {
          if (!sessionId) return JSON.stringify({ status: 'error', error: 'sessionId required' });
          const s = sessions.get(sessionId);
          if (!s) return JSON.stringify({ status: 'error', error: `Session not found: ${sessionId}` });

          const recentStdout = s.stdout.slice(-tail).join('\n');
          const recentStderr = s.stderr.slice(-tail).join('\n');
          if (s.exitCode !== null) markResultConsumed(s);

          return JSON.stringify({
            status: 'success',
            running: s.exitCode === null,
            exitCode: s.exitCode,
            uptimeMs: Date.now() - s.startedAt,
            orphanedDescendants: hasLeakedDescendants(s) || undefined,
            stdout: recentStdout,
            stderr: recentStderr || undefined,
          });
        }

        case 'log': {
          if (!sessionId) return JSON.stringify({ status: 'error', error: 'sessionId required' });
          const s = sessions.get(sessionId);
          if (!s) return JSON.stringify({ status: 'error', error: `Session not found: ${sessionId}` });
          if (s.exitCode !== null) markResultConsumed(s);

          return JSON.stringify({
            status: 'success',
            totalLines: s.stdout.length + s.stderr.length,
            stdout: s.stdout.slice(-tail).join('\n'),
            stderr: s.stderr.slice(-tail).join('\n') || undefined,
          });
        }

        case 'kill': {
          if (!sessionId) return JSON.stringify({ status: 'error', error: 'sessionId required' });
          const s = sessions.get(sessionId);
          if (!s) return JSON.stringify({ status: 'error', error: `Session not found: ${sessionId}` });
          if (s.exitCode !== null) {
            if (!hasLeakedDescendants(s)) {
              return JSON.stringify({ status: 'success', message: 'Process already exited', exitCode: s.exitCode });
            }
            // The wrapper is gone but its descendants survived; the signal is
            // still delivered to the (possibly leaderless) group.
            const reap = killProcessTree(s.process, s.pid, s.isolatedGroup);
            s.killDelivery = reap.delivered;
            return JSON.stringify({
              status: 'success',
              message: `Process already exited (exitCode ${s.exitCode}), but its descendants were still alive — SIGTERM sent to the process group of PID ${s.pid}; SIGKILL follows in ${KILL_GRACE_MS}ms if anything survives`,
              reaped: true,
            });
          }
          const kill = killProcessTree(s.process, s.pid, s.isolatedGroup, () => {
            if (s.exitCode === null) {
              s.exitCode = -1;
              notifyCompletion(s);
            }
          });
          s.killDelivery = kill.delivered;
          return JSON.stringify({
            status: 'success',
            message: `SIGTERM sent to ${kill.delivered === 'group' ? `the process group of PID ${s.pid} (wrapper + all descendants)` : `PID ${s.pid}`}; SIGKILL follows in ${KILL_GRACE_MS}ms if anything survives`,
          });
        }

        case 'clear': {
          const removed: string[] = [];
          const keptOrphaned: string[] = [];
          for (const [id, s] of sessions) {
            if (s.exitCode === null) continue;
            if (hasLeakedDescendants(s)) {
              // Dropping the entry would throw away the only handle able to
              // kill those descendants — keep it and tell the caller why.
              keptOrphaned.push(id);
              continue;
            }
            sessions.delete(id);
            removed.push(id);
          }
          return JSON.stringify({
            status: 'success',
            cleared: removed.length,
            sessionIds: removed,
            ...(keptOrphaned.length > 0
              ? {
                  keptOrphaned,
                  hint: 'These sessions finished but their descendants are still running. Call process kill on them to reap the process group.',
                }
              : {}),
          });
        }

        default:
          return JSON.stringify({ status: 'error', error: `Unknown action: ${action}` });
      }
    },
  };
}

/**
 * In-turn await for background sessions.
 *
 * First principle: the result of a background command BELONGS to the turn that
 * launched it. `background_wait` delivers that result as a normal tool result
 * in the SAME turn — same scenario, same tool pack, cheap append — instead of
 * severing the bond and re-entering as a fresh attention cycle (which paid a
 * full context re-injection, re-decided the scenario, and could not continue
 * the launching turn's reasoning).
 *
 * Consuming a result here suppresses the separate completion turn in BOTH
 * orderings: while this wait is in flight the completion bus defers to the
 * waiting turn (`hasActiveBackgroundWaiter` — the bus fires synchronously on
 * exit, before this continuation resumes); if completion preceded the read,
 * the already-queued mailbox item is skipped at processing time via
 * `wasBackgroundResultConsumed`.
 */
export function createBackgroundWaitTool(): AgentToolHandler {
  return {
    name: 'background_wait',
    description: 'Wait for background_exec session(s) to finish and return their results IN THIS TURN as a normal tool result. Use when you need the outcome to continue your current work (build/test/CI results): launch via background_exec, do other useful work, then background_wait before ending the turn. Consuming a result here suppresses the separate completion notification turn (no duplicate wake-up). If the timeout elapses first, still-running sessions keep their notification — you will be woken after this turn ends, or call background_wait again.',
    inputSchema: {
      type: 'object',
      properties: {
        session_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Background session IDs returned by background_exec (one or more; waits for all, sharing one deadline)',
        },
        timeout_ms: { type: 'number', description: 'Max milliseconds to wait (default 120000, max 600000)' },
        tail: { type: 'number', description: 'Output lines from the end returned per session (default 50)' },
      },
      required: ['session_ids'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const rawIds = args['session_ids'];
      if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.some(x => typeof x !== 'string')) {
        return JSON.stringify({ status: 'error', error: 'session_ids must be a non-empty array of session ID strings' });
      }
      const ids = [...new Set(rawIds as string[])];
      const rawTimeout = Number(args['timeout_ms']);
      const timeoutMs = Math.min(Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 120_000, 600_000);
      const rawTail = Number(args['tail']);
      const tail = Math.max(1, Number.isFinite(rawTail) && rawTail > 0 ? rawTail : 50);
      const deadline = Date.now() + timeoutMs;
      const results: Array<Record<string, unknown>> = [];

      for (const id of ids) {
        const s = sessions.get(id);
        if (!s) {
          results.push({ sessionId: id, status: 'not_found' });
          continue;
        }
        if (s.exitCode === null) {
          const remaining = deadline - Date.now();
          if (remaining > 0) {
            // Announce the in-band waiter BEFORE awaiting: the completion bus
            // fires synchronously on exit and must defer to this turn.
            activeWaiters.set(id, (activeWaiters.get(id) ?? 0) + 1);
            try {
              // Race the session's exit against the shared deadline; clear the
              // timer when exit wins so a long timeout leaves no dangling handle.
              await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, remaining);
                void s.done.then(() => { clearTimeout(timer); resolve(); });
              });
            } finally {
              const n = (activeWaiters.get(id) ?? 1) - 1;
              if (n <= 0) activeWaiters.delete(id);
              else activeWaiters.set(id, n);
            }
          }
        }
        if (s.exitCode !== null) {
          markResultConsumed(s);
          results.push({
            sessionId: id,
            status: 'completed',
            exitCode: s.exitCode,
            durationMs: Date.now() - s.startedAt,
            stdout: s.stdout.slice(-tail).join('\n'),
            stderr: s.stderr.slice(-tail).join('\n') || undefined,
            orphanedDescendants: hasLeakedDescendants(s) || undefined,
          });
        } else {
          results.push({ sessionId: id, status: 'running', uptimeMs: Date.now() - s.startedAt });
        }
      }

      const anyRunning = results.some(r => r['status'] === 'running');
      return JSON.stringify({
        status: 'success',
        results,
        ...(anyRunning
          ? { hint: 'Still-running sessions keep their completion notification — you will be woken after this turn ends, or call background_wait again.' }
          : {}),
      });
    },
  };
}
