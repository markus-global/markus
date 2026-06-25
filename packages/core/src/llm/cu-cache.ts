/**
 * CU (Compute Unit) usage cache for proxy mode.
 *
 * Tracks per-provider, per-model token usage and cost from proxy
 * responses so the Desktop client can query usage without hitting
 * the upstream every time.
 *
 * Usage data is purely in-memory (volatile across restarts).  A
 * future wave will add SQLite persistence.
 */

import { createLogger } from '@markus/shared';

const log = createLogger('cu-cache');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CUUsageRecord {
  readonly provider: string;
  readonly model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in USD (from model catalog pricing × tokens) */
  estimatedCost: number;
  lastUpdated: string;
}

export interface CUSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCost: number;
  /** Per-provider breakdown, keyed by "provider:model" */
  breakdown: Record<string, CUUsageRecord>;
  /** Remaining balance if known (from proxy response headers) */
  balance?: number;
  lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export class CUCache {
  /** Key = "provider:model", value = aggregated usage */
  private records = new Map<string, CUUsageRecord>();
  /** Latest balance reported by the proxy. undefined = unknown. */
  private _balance?: number;
  private _lastBalanceUpdate?: string;

  // ---- Mutators -----------------------------------------------------------

  /**
   * Record usage from a proxy response.
   * `provider` should be the upstream provider name (e.g. "anthropic").
   * `model` should be the model ID used.
   */
  recordUsage(provider: string, model: string, inputTokens: number, outputTokens: number, estimatedCost?: number): void {
    const key = `${provider}:${model}`;
    let rec = this.records.get(key);
    if (!rec) {
      rec = { provider, model, inputTokens: 0, outputTokens: 0, estimatedCost: 0, lastUpdated: new Date().toISOString() };
      this.records.set(key, rec);
    }
    rec.inputTokens += inputTokens;
    rec.outputTokens += outputTokens;
    rec.estimatedCost += estimatedCost ?? 0;
    rec.lastUpdated = new Date().toISOString();
  }

  /**
   * Update the CU balance from a proxy response header.
   */
  setBalance(balance: number): void {
    this._balance = balance;
    this._lastBalanceUpdate = new Date().toISOString();
  }

  // ---- Accessors ----------------------------------------------------------

  /**
   * Return a snapshot of all usage data.
   */
  getSummary(): CUSummary {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    const breakdown: Record<string, CUUsageRecord> = {};

    for (const [key, rec] of this.records) {
      breakdown[key] = { ...rec };
      totalInput += rec.inputTokens;
      totalOutput += rec.outputTokens;
      totalCost += rec.estimatedCost;
    }

    return {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalEstimatedCost: totalCost,
      breakdown,
      balance: this._balance,
      lastUpdated: this._lastBalanceUpdate ?? new Date().toISOString(),
    };
  }

  /**
   * Get usage for a specific provider.
   */
  getProviderUsage(provider: string): CUSummary {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    const breakdown: Record<string, CUUsageRecord> = {};

    for (const [key, rec] of this.records) {
      if (rec.provider !== provider) continue;
      breakdown[key] = { ...rec };
      totalInput += rec.inputTokens;
      totalOutput += rec.outputTokens;
      totalCost += rec.estimatedCost;
    }

    return {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalEstimatedCost: totalCost,
      breakdown,
      balance: this._balance,
      lastUpdated: this._lastBalanceUpdate ?? new Date().toISOString(),
    };
  }

  get balance(): number | undefined {
    return this._balance;
  }

  /**
   * Reset all usage data (e.g. at the start of a billing cycle).
   */
  reset(): void {
    this.records.clear();
    this._balance = undefined;
    this._lastBalanceUpdate = undefined;
    log.info('CU cache reset');
  }
}
