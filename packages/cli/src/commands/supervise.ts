import type { Command } from 'commander';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  detectUncleanShutdown,
  getCrashLogPath,
} from '@markus/shared';

/**
 * `markus supervise` — a minimal watchdog/supervisor for the Markus server.
 *
 * It spawns the server as a child process and restarts it automatically when it
 * exits abnormally (crash / OOM / signal), carrying over a root-cause hint from
 * the crash-attribution store (~/.markus/logs/last-crash.json + run-state.json)
 * so a restart is never "silent".
 *
 * Why a child-process supervisor: the desktop shell hosts the backend
 * in-process (Electron main), and `markus start` runs it in-process in the
 * CLI. Neither can restart itself once the same process is gone. `supervise`
 * decouples the supervisor from the supervised process — if the server dies,
 * the supervisor (still alive) relaunches it.
 */

interface SuperviseOptions {
  port?: number;
  config?: string;
  /** Max consecutive abnormal restarts before giving up (0 = unlimited). */
  maxRestarts?: number;
  /** Initial backoff ms between restarts (doubles each consecutive crash). */
  backoffMs?: number;
}

const BACKOFF_CAP_MS = 60_000;

export function registerSuperviseCommand(program: Command): Command {
  const root = program
    .command('supervise')
    .description('Run the Markus server under a watchdog that auto-restarts it on crash/OOM');

  root
    .option('-p, --port <number>', 'API port to pass through to the server')
    .option('-c, --config <path>', 'Path to markus.json config file')
    .option('--max-restarts <n>', 'Max consecutive abnormal restarts before giving up (default 5, 0=unlimited)', '5')
    .option('--backoff <ms>', 'Initial backoff between restarts in ms (default 2000)', '2000')
    .action(async (opts) => {
      await supervise({
        port: opts.port ? Number(opts.port) : undefined,
        config: opts.config,
        maxRestarts: opts.maxRestarts ? Number(opts.maxRestarts) : 5,
        backoffMs: opts.backoff ? Number(opts.backoff) : 2000,
      });
    });

  return root;
}

export async function supervise(opts: SuperviseOptions = {}): Promise<void> {
  const maxRestarts = opts.maxRestarts ?? 5;
  const backoffMs = Math.max(250, opts.backoffMs ?? 2000);

  // Entry point used to re-launch the server. This module is resolved from the
  // CLI dist output (dist/markus.mjs). Reusing the same script keeps flags/env
  // consistent across restarts.
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('supervise: cannot determine CLI entrypoint (process.argv[1] is empty)');
  }

  const childArgs = ['start'];
  if (opts.port) childArgs.push('--port', String(opts.port));
  if (opts.config) childArgs.push('--config', opts.config);

  let child: ChildProcess | null = null;
  let stopping = false;
  let consecutiveCrashes = 0;

  const reportRootCause = (): void => {
    const d = detectUncleanShutdown();
    if (!d.unclean) {
      console.log(`[supervise] previous exit was clean — not treated as a crash.`);
      return;
    }
    const crash = d.lastCrash;
    if (crash) {
      console.log(`[supervise] previous exit was ABNORMAL (${crash.reason} at ${crash.timestamp})`);
      if (crash.message) console.log(`[supervise]   reason: ${crash.message}`);
      if (crash.signal) console.log(`[supervise]   signal : ${crash.signal}`);
      if (crash.exitCode !== undefined) console.log(`[supervise]   exit  : ${crash.exitCode}`);
      console.log(`[supervise]   peak RSS: ${crash.memory?.rssMb ?? 'n/a'} MB, heap: ${crash.memory?.heapUsedMb ?? 'n/a'} MB`);
      if (crash.memory && crash.memory.rssMb > 0 && crash.memory.systemTotalMb > 0
        && crash.memory.rssMb / crash.memory.systemTotalMb > 0.6) {
        console.log(`[supervise]   ⚠ RSS exceeded 60% of system memory — OOM is a strong suspect.`);
      }
      console.log(`[supervise]   crash log: ${getCrashLogPath()}`);
      if (crash.context) console.log(`[supervise]   context  : ${JSON.stringify(crash.context)}`);
      return;
    }
    const prev = d.previous;
    if (prev) {
      console.log(`[supervise] previous run was unclean (pid ${prev.pid}, booted ${prev.bootedAt}) but no crash report was written —`);
      if (d.lastAliveGapSec !== null && d.lastAliveGapSec !== undefined) {
        console.log(`[supervise]   last alive ${d.lastAliveGapSec}s before this boot (kill -9 / OOM / power loss suspected).`);
      }
    }
  };

  const launch = (): Promise<void> => {
    return new Promise((resolve) => {
      console.log(`\n[supervise] starting server (pid ${process.pid} → child)...`);
      child = spawn(process.execPath, [cliEntry, ...childArgs], {
        stdio: 'inherit',
        env: { ...process.env, NO_BROWSER: '1' },
      });
      console.log(`[supervise] child pid ${child.pid} launched. Ctrl+C to stop supervision.`);

      child.on('exit', (code, signal) => {
        child = null;
        if (stopping) {
          console.log(`[supervise] child stopped (code=${code ?? 'null'}, signal=${signal ?? 'none'}). Supervision ending.`);
          process.exit(0);
          return;
        }
        // The child has exited. Attribute + decide whether to restart.
        reportRootCause();
        consecutiveCrashes += 1;
        if (maxRestarts !== 0 && consecutiveCrashes > maxRestarts) {
          console.error(`[supervise] reached max-restarts (${maxRestarts}) — giving up. Manual intervention required.`);
          console.error(`[supervise] see ${getCrashLogPath()} for crash history.`);
          process.exit(1);
          return;
        }
        const delay = Math.min(backoffMs * Math.pow(2, consecutiveCrashes - 1), BACKOFF_CAP_MS);
        console.log(`[supervise] crash #${consecutiveCrashes} — restarting in ${delay}ms...`);
        setTimeout(() => {
          launch().then(resolve);
        }, delay);
      });

      child.on('error', (err) => {
        console.error(`[supervise] failed to spawn child:`, err);
        resolve();
      });
    });
  };

  // Forward terminate signals: gracefully ask the child to stop, then exit the
  // supervisor (do NOT respawn on an operator-initiated stop).
  const forwardSignal = (sig: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[supervise] received ${sig} — stopping server...`);
    if (child && child.pid) {
      child.kill(sig === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
      // Give the child a few seconds to exit, then force.
      setTimeout(() => {
        if (child && child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, 5000).unref();
    } else {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  await launch();
  // Keep the supervisor alive until signalled / child returns.
  await new Promise<void>(() => {});
}