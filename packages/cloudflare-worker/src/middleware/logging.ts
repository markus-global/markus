/**
 * Logging middleware — emits structured request/response logs via
 * `console.log` so they appear in the Workers dashboard.
 */

export interface LogEntry {
  timestamp: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
  env: string;
}

/**
 * Simple request logger.  Returns a `finish` callback that the caller
 * invokes after the response is ready so we can capture the final status
 * and timing.
 */
export function startLog(request: Request, env: Record<string, unknown>): (response: Response) => void {
  const start = Date.now();
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const url = new URL(request.url);
  const envName = (env.ENVIRONMENT as string) ?? 'production';

  return (response: Response) => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - start,
      requestId,
      env: envName,
    };
    console.log(JSON.stringify(entry));
  };
}
