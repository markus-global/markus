/**
 * Global per-agent wake budget.
 *
 * The existing storm guards are per-channel (`a2aCooldowns` keyed by
 * channel+peer). An agent active in 10 channels gets 10 independent allowances
 * and therefore no effective ceiling — measured: 52 inbound a2a messages in 48
 * minutes for one agent, and a single day with 12,731 LLM calls platform-wide.
 *
 * Industry posture (AWS Bedrock AgentCore, agentgateway): per-channel AND global
 * budgets; per-channel alone is not a control. This module is the global tier.
 *
 * Semantics: a token bucket per agent. When empty, further wake-ups are NOT
 * queued for a later burst (that just delays the storm) — the message is still
 * delivered to the inbox/log, but it does not start a turn. The agent will see
 * it on its next turn (mailbox view / task_get), which is how MCP one-way
 * notifications behave.
 */

export interface WakeBudgetConfig {
  /** Bucket capacity — burst allowance. */
  capacity: number;
  /** Tokens restored per second. */
  refillPerSecond: number;
}

/** Defaults: burst 6 wake-ups, sustained 1 per 60s (~60/hour ceiling per agent). */
export const DEFAULT_WAKE_BUDGET: WakeBudgetConfig = { capacity: 6, refillPerSecond: 1 / 60 };

export interface WakeBudgetDecision {
  allowed: boolean;
  /** Tokens left after the decision (rounded to 2dp for logging). */
  remaining: number;
}

export class AgentWakeBudget {
  private buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly config: WakeBudgetConfig = DEFAULT_WAKE_BUDGET,
    private readonly now: () => number = Date.now,
  ) {}

  /** Try to spend one wake-up for `agentId`. */
  tryConsume(agentId: string): WakeBudgetDecision {
    const ts = this.now();
    const bucket = this.buckets.get(agentId) ?? { tokens: this.config.capacity, updatedAt: ts };

    const elapsedSec = Math.max(0, (ts - bucket.updatedAt) / 1000);
    const tokens = Math.min(this.config.capacity, bucket.tokens + elapsedSec * this.config.refillPerSecond);

    if (tokens < 1) {
      this.buckets.set(agentId, { tokens, updatedAt: ts });
      return { allowed: false, remaining: round(tokens) };
    }
    const left = tokens - 1;
    this.buckets.set(agentId, { tokens: left, updatedAt: ts });
    return { allowed: true, remaining: round(left) };
  }

  /** Test/ops helper: current tokens without consuming. */
  peek(agentId: string): number {
    const ts = this.now();
    const bucket = this.buckets.get(agentId);
    if (!bucket) return this.config.capacity;
    const elapsedSec = Math.max(0, (ts - bucket.updatedAt) / 1000);
    return round(Math.min(this.config.capacity, bucket.tokens + elapsedSec * this.config.refillPerSecond));
  }

  /** Drop a bucket (agent stopped / config changed). */
  reset(agentId?: string): void {
    if (agentId) this.buckets.delete(agentId);
    else this.buckets.clear();
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
