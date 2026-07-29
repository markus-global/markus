import { appendFileSync, existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Singleton file stream for all runtime logs. Resolve dir at use-time so tests
// that mock os.homedir() see the mocked path (module-load const would freeze
// the real home).
function getLogDir(): string {
  return join(homedir(), '.markus', 'logs');
}

let runtimeLogStream: ReturnType<typeof createWriteStream> | null = null;
let runtimeLogPath: string | null = null;

function ensureLogDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
}

function getRuntimeLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(getLogDir(), `runtime-${date}.log`);
}

function initRuntimeLogger(): void {
  const path = getRuntimeLogPath();
  if (runtimeLogStream && runtimeLogPath === path) return;
  if (runtimeLogStream) {
    runtimeLogStream.end();
    runtimeLogStream = null;
  }
  try {
    ensureLogDir(getLogDir());
    runtimeLogStream = createWriteStream(path, { flags: 'a', mode: 0o644 });
    runtimeLogPath = path;
    // Directory may be deleted by tests (or user cleanup) while the stream is
    // still open — without a listener that becomes an uncaught Exception and
    // fails the Vitest run even when all tests passed.
    runtimeLogStream.on('error', () => {
      runtimeLogStream = null;
      runtimeLogPath = null;
    });
  } catch {
    runtimeLogStream = null;
    runtimeLogPath = null;
  }
}

function writeToFile(line: string): void {
  try {
    initRuntimeLogger();
    if (!runtimeLogStream) return;
    runtimeLogStream.write(line + '\n');
  } catch {
    runtimeLogStream = null;
    runtimeLogPath = null;
  }
}
export class Logger {
  private minLevel: number;

  constructor(
    private name: string,
    level: LogLevel = 'info',
  ) {
    this.minLevel = LOG_LEVELS[level];
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('debug', msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log('info', msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('warn', msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log('error', msg, data);
  }

  child(name: string): Logger {
    return new Logger(`${this.name}:${name}`, this.levelName());
  }

  private levelName(): LogLevel {
    const entry = Object.entries(LOG_LEVELS).find(([, v]) => v === this.minLevel);
    return (entry?.[0] as LogLevel) ?? 'info';
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < this.minLevel) return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}] [${this.name}]`;
    const suffix = data ? ` ${JSON.stringify(data)}` : '';
    const line = `${prefix} ${msg}${suffix}`;

    // Write to log file only — stderr/stdout reserved for user-facing output
    writeToFile(line);
  }
}

export function createLogger(name: string, level?: LogLevel): Logger {
  return new Logger(name, level ?? (process.env['LOG_LEVEL'] as LogLevel) ?? 'info');
}

export function closeRuntimeLogger(): void {
  if (runtimeLogStream) {
    try {
      runtimeLogStream.end();
    } catch { /* already closed / dir gone */ }
    runtimeLogStream = null;
    runtimeLogPath = null;
  }
}
