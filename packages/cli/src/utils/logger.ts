/**
 * Startup logger for markus start command.
 * Writes all startup logs to ~/.markus/logs/ AND prints to console.
 * Run `markus gateway logs` to view the log file.
 */

import { createWriteStream, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = join(homedir(), '.markus', 'logs');

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 });
  }
}

export function getStartupLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOG_DIR, `startup-${date}.log`);
}

export function getLLMLogPath(): string {
  return join(LOG_DIR, 'llm.log');
}

let startupLogStream: ReturnType<typeof createWriteStream> | null = null;
let startupLogPath: string = '';
let _suppressConsole = false;

export function setSuppressConsole(suppress: boolean): void {
  _suppressConsole = suppress;
}

export function initStartupLogger(): string {
  ensureLogDir();
  startupLogPath = getStartupLogPath();
  startupLogStream = createWriteStream(startupLogPath, { flags: 'a', mode: 0o644 });
  return startupLogPath;
}

export function getStartupLogFile(): string {
  return startupLogPath;
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'OK' | 'FAIL' | 'SKIP';

const LEVEL_PREFIX: Record<LogLevel, string> = {
  OK:   '[OK]',
  INFO: '[INFO]',
  WARN: '[WARN]',
  ERROR: '[ERROR]',
  FAIL: '[FAIL]',
  SKIP: '[SKIP]',
};

/**
 * Write a startup log entry to file AND console.
 */
export function startupLog(level: LogLevel, message: string, detail?: string): void {
  const ts = new Date().toISOString();
  const fileLine = `${ts} ${LEVEL_PREFIX[level]} ${message}${detail ? ' ' + detail : ''}\n`;
  if (startupLogStream) {
    startupLogStream.write(fileLine);
  }
  if (!_suppressConsole) {
    const consoleLine = `  ${LEVEL_PREFIX[level]} ${message}${detail ? ' ' + detail : ''}`;
    console.log(consoleLine);
  }
}

/**
 * Write a blank line to log file AND console.
 */
export function startupBlank(): void {
  if (startupLogStream) {
    startupLogStream.write('\n');
  }
  if (!_suppressConsole) {
    console.log('');
  }
}

/**
 * Write a section header to log file AND console.
 */
export function startupSection(title: string): void {
  if (startupLogStream) {
    startupLogStream.write(`\n--- ${title} ---\n`);
  }
  if (!_suppressConsole) {
    console.log(`\n--- ${title} ---`);
  }
}

/**
 * Close the startup log stream (call on shutdown).
 */
export function closeStartupLogger(): void {
  if (startupLogStream) {
    startupLogStream.end();
    startupLogStream = null;
  }
}

/**
 * Append an LLM log entry (call for each LLM call).
 */
export function appendLLMLog(entry: {
  timestamp: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  success: boolean;
  error?: string;
}): void {
  ensureLogDir();
  const line = JSON.stringify(entry) + '\n';
  try {
    appendFileSync(getLLMLogPath(), line, { mode: 0o644 });
  } catch {
    // non-fatal
  }
}
