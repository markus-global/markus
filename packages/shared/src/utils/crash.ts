/**
 * Process crash attribution & self-heal helpers.
 *
 * Goal (P0 / S 域 问题 35): when the Markus server process exits abnormally
 * (crash / OOM / signal), we must be able to answer "why did it exit / was it
 * OOM" and, for supervised launches, restart it automatically.
 *
 * This module is backend-host agnostic: it is used by both the CLI server
 * (`markus start`) and the Electron desktop main process. It provides:
 *   - exit-signal / exit-code / timing / memory attribution into `~/.markus/logs/`
 *   - an unclean-shutdown detector (last run ended without clean shutdown → crash/OOM)
 *   - a periodic memory watermark sampler with over-limit alarms
 *   - process-level fault handlers (uncaughtException / unhandledRejection /
 *     SIGTERM / SIGINT / graceful shutdown annotation)
 *
 * Nothing here starts a supervisor loop itself — that lives in the CLI
 * `supervise` command (packages/cli) and in the Electron shell watchdog.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, totalmem, freemem } from 'node:os';
import { createLogger } from './logger.js';

const log = createLogger('crash-guard');

// ─── Paths & files ───────────────────────────────────────────────────────────

function getLogDir(): string {
  return join(homedir(), '.markus', 'logs');
}

function ensureLogDir(): void {
  if (!existsSync(getLogDir())) {
    mkdirSync(getLogDir(), { recursive: true, mode: 0o755 });
  }
}

/** Appended crash records (human/aug reader friendly). */
export function getCrashLogPath(): string {
  return join(getLogDir(), 'crash.log');
}

/** Latest crash report, machine readable (single record, overwritten each crash). */
export function getLastCrashPath(): string {
  return join(getLogDir(), 'last-crash.json');
}

/** Run-state marker used to detect an *unclean* shutdown (crash / OOM / kill). */
export function getRunStatePath(): string {
  return join(getLogDir(), 'run-state.json');
}

// ─── Memory helpers ──────────────────────────────────────────────────────────

export interface MemorySnapshot {
  /** Resident set size in MB. */
  rssMb: number;
  /** V8 heap used in MB. */
  heapUsedMb: number;
  /** V8 heap total in MB. */
  heapTotalMb: number;
  /** External (native) memory in MB. */
  externalMb: number;
  /** System-level total memory in MB. */
  systemTotalMb: number;
  /** System-level free memory in MB. */
  systemFreeMb: number;
  /** Process uptime in seconds. */
  uptimeSec: number;
  /** Monotonic uptime in ms (for watermark wall-clock deltas). */
  uptimeMs: number;
}

export function getMemorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round((usage.rss / 1024 / 1024) * 100) / 100,
    heapUsedMb: Math.round((usage.heapUsed / 1024 / 1024) * 100) / 100,
    heapTotalMb: Math.round((usage.heapTotal / 1024 / 1024) * 100) / 100,
    externalMb: Math.round(((usage.external ?? 0) / 1024 / 1024) * 100) / 100,
    systemTotalMb: Math.round((totalmem() / 1024 / 1024) * 100) / 100,
    systemFreeMb: Math.round((freemem() / 1024 / 1024) * 100) / 100,
    uptimeSec: process.uptime(),
    uptimeMs: Date.now(),
  };
}

// ─── Env summary (redacted) ──────────────────────────────────────────────────

const SECRET_KEYS = /(key|token|secret|password|passwd|credential|api[-_]?key|authorization)/i;

/** Filtered env snapshot — excludes anything credential-like. */
export function summarizeEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_KEYS.test(k)) continue; // never leak credentials
    if (typeof v !== 'string') continue;
    const val = v.length > 400 ? v.slice(0, 400) : v;
    out[k] = val;
  }
  return out;
}

// ─── Crash report shape ──────────────────────────────────────────────────────

export interface CrashReport {
  timestamp: string;
  pid: number;
  /** e.g. 'uncaughtException' | 'unhandledRejection' | 'beforeExit' | 'manualTest' */
  reason: string;
  exitCode?: number;
  signal?: string;
  message?: string;
  stack?: string;
  memory: MemorySnapshot;
  env: Record<string, string>;
  /** Arbitrary host context (e.g. agent ids, task ids). */
  context?: Record<string, unknown>;
  /** true when this crash was injected by a test harness. */
  testOnly?: boolean;
}

export function buildCrashReport(reason: string, extra?: Partial<CrashReport>): CrashReport {
  return {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    reason,
    ...extra,
    memory: extra?.memory ?? getMemorySnapshot(),
    env: extra?.env ?? summarizeEnv(),
  };
}

/** Append a crash record to crash.log and overwrite last-crash.json. */
export function writeCrashReport(report: CrashReport, { toLast = true }: { toLast?: boolean } = {}): string {
  ensureLogDir();
  const line = JSON.stringify(report) + '\n';
  try {
    appendFileSync(getCrashLogPath(), line, { mode: 0o644 });
  } catch (err) {
    log.warn('failed to append crash.log', { error: String(err) });
  }
  if (toLast) {
    try {
      writeFileSync(getLastCrashPath(), line, { mode: 0o644 });
    } catch { /* best effort */ }
  }
  return line;
}

// ─── Run-state / unclean-shutdown detection ──────────────────────────────────

export interface RunState {
  pid: number;
  /** ISO timestamp of last boot. */
  bootedAt: string;
  /** ISO timestamp the process last wrote a heartbeat (i.e. was alive). */
  lastAliveAt: string;
  /** 'running' | 'clean-shutdown' */
  status: 'running' | 'clean-shutdown';
  /** Version recorded at boot, to attribute restarts across upgrades. */
  version?: string;
}

export function readRunState(): RunState | null {
  try {
    const raw = readFileSync(getRunStatePath(), 'utf-8');
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

/**
 * Detect whether the previous process exited cleanly. On boot, a leftover
 * run-state with status 'running' means the last run never recorded a clean
 * shutdown → it crashed (or was killed / OOM'd / SIGKILL). Returns the prior
 * state plus a boolean verdict and, if an unclean exit was detected, the last
 * crash report (if any) so the caller can present a root-cause hint.
 */
export function detectUncleanShutdown(): {
  unclean: boolean;
  previous: RunState | null;
  lastCrash: CrashReport | null;
  lastAliveGapSec: number | null;
} {
  const previous = readRunState();
  let lastCrash: CrashReport | null = null;
  try {
    const raw = readFileSync(getLastCrashPath(), 'utf-8');
    lastCrash = JSON.parse(raw) as CrashReport;
  } catch { /* none yet */ }

  let lastAliveGapSec: number | null = null;
  let unclean = false;
  if (previous) {
    if (previous.lastAliveAt) {
      lastAliveGapSec = Math.round((Date.now() - new Date(previous.lastAliveAt).getTime()) / 1000);
    }
    unclean = previous.status !== 'clean-shutdown';
  }
  return { unclean, previous, lastCrash, lastAliveGapSec };
}

/** Mark the current run as started. Returns the prior state (for attribution). */
export function markRunStarted(): RunState | null {
  ensureLogDir();
  const prior = readRunState();
  const state: RunState = {
    pid: process.pid,
    bootedAt: new Date().toISOString(),
    lastAliveAt: new Date().toISOString(),
    status: 'running',
  };
  writeFileSync(getRunStatePath(), JSON.stringify(state, null, 2), { mode: 0o644 });
  return prior;
}

/** Update the heartbeat timestamp (call periodically from the watermark sampler). */
export function touchRunHeartbeat(): void {
  const prior = readRunState();
  if (!prior) return;
  prior.lastAliveAt = new Date().toISOString();
  try { writeFileSync(getRunStatePath(), JSON.stringify(prior, null, 2), { mode: 0o644 }); } catch { /* beat effort */ }
}

/** Record a clean shutdown so a subsequent boot is not flagged as a crash. */
export function markCleanShutdown(): void {
  try {
    const prior = readRunState();
    const state: RunState = prior ?? {
      pid: process.pid,
      bootedAt: new Date().toISOString(),
      lastAliveAt: new Date().toISOString(),
      status: 'running',
    };
    state.status = 'clean-shutdown';
    state.lastAliveAt = new Date().toISOString();
    writeFileSync(getRunStatePath(), JSON.stringify(state, null, 2), { mode: 0o644 });
  } catch { /* best effort */ }
}

// ─── Memory watermark sampler + over-limit watchdog ──────────────────────────

export interface MemoryWatermark {
  /** Peak RSS in MB observed since sampling started. */
  peakRssMb: number;
  /** Peak heap in MB observed since sampling started. */
  peakHeapUsedMb: number;
  /** Timestamp of the last sample. */
  lastSampleAt: string;
  /** Number of samples taken. */
  samples: number;
  /** Whether an over-limit alarm has been raised (fires once per epoch). */
  alarmed: boolean;
}

/**
 * Watcher that periodically samples process memory, records high-water marks,
 * touches the run heartbeat, and raises an alarm when RSS surpasses
 * `rssLimitMb` (typical OOM culprit). Returns a start/stop/watermark handle.
 */
export function memoryWatermarkWatchdog(
  opts: {
    intervalMs?: number;
    rssLimitMb?: number;
    /** Touch the run-state heartbeat every N ms (0 = disabled). */
    heartbeatMs?: number;
    onAlarm?: (w: MemoryWatermark) => void;
  } = {},
): { start(): void; stop(): void; watermark(): MemoryWatermark } {
  const intervalMs = opts.intervalMs ?? 5000;
  const rssLimitMb = opts.rssLimitMb ?? 0; // 0 = disabled
  const heartbeatMs = opts.heartbeatMs ?? 0; // 0 = disabled

  const w: MemoryWatermark = {
    peakRssMb: 0,
    peakHeapUsedMb: 0,
    lastSampleAt: new Date().toISOString(),
    samples: 0,
    alarmed: false,
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const sample = (): void => {
    const m = getMemorySnapshot();
    if (m.rssMb > w.peakRssMb) w.peakRssMb = m.rssMb;
    if (m.heapUsedMb > w.peakHeapUsedMb) w.peakHeapUsedMb = m.heapUsedMb;
    w.samples += 1;
    w.lastSampleAt = new Date().toISOString();
    if (rssLimitMb > 0 && m.rssMb > rssLimitMb && !w.alarmed) {
      w.alarmed = true;
      opts.onAlarm?.(w);
      log.warn('memory watermark alarm exceeded RSS limit', {
        rssMb: m.rssMb,
        limitMb: rssLimitMb,
        peakRssMb: w.peakRssMb,
      });
    }
  };

  return {
    start() {
      if (timer) return;
      sample();
      timer = setInterval(sample, intervalMs);
      timer.unref?.();
      if (heartbeatMs > 0) {
        heartbeatTimer = setInterval(touchRunHeartbeat, heartbeatMs);
        heartbeatTimer.unref?.();
      }
    },
    watermark() {
      return w;
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    },
  };
}

// ─── Process fault handlers ──────────────────────────────────────────────────

export interface CrashGuardOptions {
  /** Skip installing on tests unless explicitly requested. */
  enabled?: boolean;
  /** Provide extra attribution context (host-side specifics like version). */
  context?: () => Record<string, unknown>;
  /**
   * After writing an uncaughtException report, exit the process (default true).
   * An exception swallowed by a lingering handler leaves the process in an
   * unknown state — for a supervised server we want a hard, attributed exit so
   * the supervisor restarts it. Set false when you must keep running (rare).
   */
  exitOnUncaught?: boolean;
}

let installed = false;

/**
 * Install in-process fault handlers that make an abnormal exit attributable:
 *  - uncaughtException  → write crash report then re-raise (do NOT swallow)
 *  - unhandledRejection → write crash report (rejection is usually not fatal,
 *                         but must be visible — do NOT let it silently drop)
 *  - SIGTERM/SIGINT     → mark clean shutdown on graceful OS signals
 */
export function installCrashGuard(opts: CrashGuardOptions = {}): void {
  if (installed) return;
  if (opts.enabled === false) return;
  installed = true;

  // Bootstrap run-state on first import-backed call.
  const prior = readRunState();
  if (!prior || prior.status === 'clean-shutdown') {
    // Fresh or previously-clean boot — record a running marker so the next
    // unclean exit is attributed to THIS run.
    markRunStarted();
  }

  process.on('uncaughtException', (err: Error) => {
    const stack = (err as { stack?: string })?.stack ?? `${err}`;
    const report = buildCrashReport('uncaughtException', {
      message: err?.message ?? String(err),
      stack,
      context: opts.context?.(),
    });
    writeCrashReport(report);
    log.error('uncaughtException — crash report written', { reason: 'uncaughtException', at: getCrashLogPath() });
    // Do NOT swallow: an attached handler keeps Node alive with the process in
    // an undefined state. Print the stack, then force a hard, attributed exit so
    // an external supervisor (CLI supervise / shell watchdog) restarts us.
    // (If a user has explicitly requested recovery, they own the consequences.)
    process.stderr.write('\n' + stack + '\n');
    if (opts.exitOnUncaught !== false) {
      // Allow the report I/O to flush, then exit non-zero.
      setTimeout(() => process.exit(1), 10);
    }
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const stack = reason instanceof Error ? reason.stack : String(reason);
    const report = buildCrashReport('unhandledRejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack,
      context: opts.context?.(),
    });
    writeCrashReport(report);
    log.error('unhandledRejection — crash report written', { at: getCrashLogPath() });
  });

  // Graceful OS signals → record a clean shutdown marker so a later SIGKILL /
  // crash isn't confused with an orderly stop.
  const graceful = (): void => {
    markCleanShutdown();
  };
  process.on('SIGTERM', graceful);
  process.on('SIGINT', graceful);
}

/** True when the fault handlers have been (or were requested to be) installed. */
export function isCrashGuardInstalled(): boolean {
  return installed;
}

/** Force-reset for tests (allows re-install). */
export function _resetCrashGuard(): void {
  installed = false;
}