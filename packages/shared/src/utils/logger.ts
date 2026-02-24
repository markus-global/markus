export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

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

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

export function createLogger(name: string, level?: LogLevel): Logger {
  return new Logger(name, level ?? (process.env['LOG_LEVEL'] as LogLevel) ?? 'info');
}
