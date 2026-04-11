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

// Singleton file stream for all runtime logs
const LOG_DIR = join(homedir(), '.markus', 'logs');
let runtimeLogStream: ReturnType<typeof createWriteStream> | null = null;

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 });
  }
}

function getRuntimeLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOG_DIR, `runtime-${date}.log`);
}

function initRuntimeLogger(): void {
  if (runtimeLogStream) return;
  ensureLogDir();
  runtimeLogStream = createWriteStream(getRuntimeLogPath(), { flags: 'a', mode: 0o644 });
}

function writeToFile(line: string): void {
  if (!runtimeLogStream) return;
  runtimeLogStream.write(line + '\n');
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
    initRuntimeLogger();
    writeToFile(line);
  }
}

export function createLogger(name: string, level?: LogLevel): Logger {
  return new Logger(name, level ?? (process.env['LOG_LEVEL'] as LogLevel) ?? 'info');
}

export function closeRuntimeLogger(): void {
  if (runtimeLogStream) {
    runtimeLogStream.end();
    runtimeLogStream = null;
  }
}
