/**
 * Health-check endpoint — returns 200 OK with service status.
 *
 * GET /health
 */

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  timestamp: string;
  uptime: number;
}

export function handleHealth(_request: Request): HealthResponse {
  return {
    status: 'ok',
    service: 'markus-proxy',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    uptime: Date.now() - ((globalThis as Record<string, unknown>).START_TIME as number) || 0,
  };
}
