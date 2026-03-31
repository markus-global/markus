import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { AgentToolHandler } from '../agent.js';

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
}

const sessions = new Map<string, BackgroundSession>();
let sessionCounter = 0;

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
    description: 'Run a shell command in the background. Returns immediately with a session ID. Use the "process" tool to poll for results, view logs, or kill the process. Ideal for long-running commands like dev servers, test suites, or builds. You will be automatically notified when the process completes.',
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

      const child = spawn('sh', ['-c', command], {
        cwd: effectiveCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

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

      child.on('close', (code) => {
        session.exitCode = code ?? -1;
        notifyCompletion(session);
      });
      child.on('exit', (code) => {
        if (session.exitCode === null) {
          session.exitCode = code ?? -1;
          notifyCompletion(session);
        }
      });

      // Auto-kill timeout
      if (timeoutSec > 0) {
        setTimeout(() => {
          if (session.exitCode === null) {
            child.kill('SIGTERM');
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
      });
    },
  };
}

export function createProcessTool(): AgentToolHandler {
  return {
    name: 'process',
    description: 'Manage background exec sessions. Actions: list (show all sessions), poll (check status + new output), log (view output), kill (terminate), clear (remove finished sessions).',
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
          }));
          return JSON.stringify({ status: 'success', sessions: list });
        }

        case 'poll': {
          if (!sessionId) return JSON.stringify({ status: 'error', error: 'sessionId required' });
          const s = sessions.get(sessionId);
          if (!s) return JSON.stringify({ status: 'error', error: `Session not found: ${sessionId}` });

          const recentStdout = s.stdout.slice(-tail).join('\n');
          const recentStderr = s.stderr.slice(-tail).join('\n');

          return JSON.stringify({
            status: 'success',
            running: s.exitCode === null,
            exitCode: s.exitCode,
            uptimeMs: Date.now() - s.startedAt,
            stdout: recentStdout,
            stderr: recentStderr || undefined,
          });
        }

        case 'log': {
          if (!sessionId) return JSON.stringify({ status: 'error', error: 'sessionId required' });
          const s = sessions.get(sessionId);
          if (!s) return JSON.stringify({ status: 'error', error: `Session not found: ${sessionId}` });

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
            return JSON.stringify({ status: 'success', message: 'Process already exited', exitCode: s.exitCode });
          }
          s.process.kill('SIGKILL');
          return JSON.stringify({ status: 'success', message: `SIGKILL sent to PID ${s.pid}` });
        }

        case 'clear': {
          const removed: string[] = [];
          for (const [id, s] of sessions) {
            if (s.exitCode !== null) {
              sessions.delete(id);
              removed.push(id);
            }
          }
          return JSON.stringify({ status: 'success', cleared: removed.length, sessionIds: removed });
        }

        default:
          return JSON.stringify({ status: 'error', error: `Unknown action: ${action}` });
      }
    },
  };
}
