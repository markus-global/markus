/**
 * client.ts — Upstash Redis REST API client for Cloudflare Workers.
 *
 * Upstash provides a REST API that works via standard HTTP fetch —
 * no TCP/WebSocket connection needed. This makes it ideal for Workers.
 *
 * Docs: https://docs.upstash.com/redis/rest/overview
 *
 * Usage:
 *   const redis = new RedisClient(env.UPSTASH_REDIS_URL, env.UPSTASH_REDIS_TOKEN);
 *   const result = await redis.eval(script, keys, args);
 */

/** Result of the CU quota deduction Lua script */
export interface QuotaDeductionResult {
  remaining: number;  // -1 means quota exceeded (rollback applied)
  usage: number;
  limit: number;
  error?: string;     // If present, something went wrong
}

/** Low-level response from Upstash REST API */
interface UpstashResponse {
  result?: string;
  error?: string;
}

/**
 * Lightweight Upstash Redis client.
 * Uses the REST API at `{url}/{command}` with Basic Auth via token.
 */
export class RedisClient {
  private readonly url: string;
  private readonly authHeader: string;

  constructor(url: string, token: string) {
    // Remove trailing slash from URL
    this.url = url.replace(/\/+$/, '');
    // Upstash uses token as a Basic Auth password (user is empty)
    this.authHeader = 'Bearer ' + token;
  }

  /**
   * Execute a Redis EVAL command via Upstash REST API.
   *
   * @param script - Lua script source code
   * @param keys - Redis key names (KEYS in Lua)
   * @param args - Additional arguments (ARGV in Lua)
   * @returns Parsed result string (JSON blob from our Lua script)
   */
  async eval(script: string, keys: string[], args: string[]): Promise<string> {
    const command = [
      'EVAL',
      script,
      keys.length.toString(),
      ...keys,
      ...args,
    ];

    const response = await this.executeCommand(command);
    return response;
  }

  /**
   * Execute a Redis command via Upstash REST API.
   * Commands are sent as an array: ["COMMAND", "arg1", "arg2", ...]
   */
  private async executeCommand(command: string[]): Promise<string> {
    const response = await fetch(`${this.url}`, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });

    if (!response.ok) {
      throw new Error(
        `Redis request failed: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as UpstashResponse;

    if (data.error) {
      throw new Error(`Redis error: ${data.error}`);
    }

    return data.result ?? '';
  }

  /**
   * Parse the JSON result from the quota deduction Lua script.
   */
  static parseQuotaResult(raw: string): QuotaDeductionResult {
    try {
      const parsed = JSON.parse(raw) as QuotaDeductionResult;
      return {
        remaining: typeof parsed.remaining === 'number' ? parsed.remaining : 0,
        usage: typeof parsed.usage === 'number' ? parsed.usage : 0,
        limit: typeof parsed.limit === 'number' ? parsed.limit : 0,
        error: parsed.error,
      };
    } catch {
      return {
        remaining: 0,
        usage: 0,
        limit: 0,
        error: 'failed_to_parse_redis_response',
      };
    }
  }
}
