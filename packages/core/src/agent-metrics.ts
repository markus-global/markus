import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@markus/shared';

const log = createLogger('agent-metrics');

export interface TokenUsage {
  input: number;
  output: number;
  cost: number;
}

export interface TaskMetrics {
  completed: number;
  failed: number;
  cancelled: number;
  averageCompletionTimeMs: number;
}

/**
 * C2: harness-discipline signals. The existing counters cover cost/throughput but not
 * whether context packing, completion-marker discipline, and prompt caching are actually
 * holding. These are measurement-only (they never change agent behavior).
 */
export interface HarnessHealthMetrics {
  /** How often per-call context packing had to compress (over budget). */
  compressionCount: number;
  /** Share of non-chat turns that finished without a completion marker (0-1). */
  markerFailureRate: number;
  /** Prompt cache-hit rate from provider usage where reported (0-1). */
  cacheHitRate: number;
  /** USD cost attributed per completed turn (0 when no USD cost is reported). */
  perTurnCostUsd: number;
}

export interface AgentMetricsSnapshot {
  agentId: string;
  period: '1h' | '24h' | '7d';
  collectedAt: string;

  tokenUsage: TokenUsage;
  taskMetrics: TaskMetrics;

  healthScore: number;
  heartbeatSuccessRate: number;
  errorRate: number;
  averageResponseTimeMs: number;

  totalInteractions: number;
  uptime: number;

  /** C2: harness-discipline signals (compression / marker / cache / per-turn cost). */
  harness: HarnessHealthMetrics;
}

interface AuditCounters {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;
  costToday: number;
  totalCuUsed: number;
  cuUsedToday: number;
  requestCount: number;
  toolCalls: number;
  errorCount: number;
  totalEvents: number;
  totalLlmDurationMs: number;
  lastSuccessTimestamp: number;
  tokensToday: number;
  requestsToday: number;
  toolCallsToday: number;
  todayCutoffDate: string;
  // C2: harness-health raw counters (measurement only).
  compressionCount: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turnsCompleted: number;
  nonChatTurns: number;
  markerMissTurns: number;
}

function freshCounters(): AuditCounters {
  return {
    totalTokens: 0, promptTokens: 0, completionTokens: 0,
    estimatedCost: 0, costToday: 0,
    totalCuUsed: 0, cuUsedToday: 0,
    requestCount: 0, toolCalls: 0, errorCount: 0,
    totalEvents: 0, totalLlmDurationMs: 0, lastSuccessTimestamp: 0,
    tokensToday: 0, requestsToday: 0, toolCallsToday: 0,
    todayCutoffDate: new Date().toISOString().slice(0, 10),
    compressionCount: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0,
    turnsCompleted: 0, nonChatTurns: 0, markerMissTurns: 0,
  };
}

interface TaskEvent {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  durationMs?: number;
  timestamp: number;
}

interface HeartbeatEvent {
  success: boolean;
  skipped: boolean;
  timestamp: number;
}

/**
 * Collects and computes real-time metrics for a single Agent.
 * Wired in via Agent's auditCallback and event bus.
 */
export class AgentMetricsCollector {
  private counters: AuditCounters = freshCounters();
  private taskEvents: TaskEvent[] = [];
  private heartbeatEvents: HeartbeatEvent[] = [];
  private startTime = Date.now();
  private lastErrorDetail: { message: string; timestamp: number } | null = null;
  private static readonly MAX_EVENTS = 10_000;
  private dataDir?: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly agentId: string,
    dataDir?: string
  ) {
    this.dataDir = dataDir;
    if (dataDir) this.loadFromDisk();
  }

  /**
   * Lightweight counter update — no longer stores full event history.
   * Full audit trail is persisted to SQLite via activity callbacks.
   */
  recordAudit(event: {
    type: string;
    action: string;
    tokensUsed?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cost?: number;
    cuCost?: number;
    durationMs?: number;
    success: boolean;
    detail?: string;
  }): void {
    const c = this.counters;
    const today = new Date().toISOString().slice(0, 10);
    if (today !== c.todayCutoffDate) {
      c.tokensToday = 0;
      c.requestsToday = 0;
      c.toolCallsToday = 0;
      c.costToday = 0;
      c.cuUsedToday = 0;
      c.todayCutoffDate = today;
    }

    c.totalEvents++;
    if (!event.success) c.errorCount++;
    if (event.success) c.lastSuccessTimestamp = Date.now();

    if (event.type === 'llm_request') {
      const tokens = event.tokensUsed ?? 0;
      c.totalTokens += tokens;
      c.promptTokens += event.inputTokens ?? 0;
      c.completionTokens += event.outputTokens ?? 0;
      if (event.cost) {
        c.estimatedCost += event.cost;
        c.costToday += event.cost;
      }
      c.requestCount++;
      c.tokensToday += tokens;
      c.requestsToday++;
      if (event.cuCost) {
        c.totalCuUsed += event.cuCost;
        c.cuUsedToday += event.cuCost;
      }
      // C2: prompt cache accounting (provider-reported; may be absent).
      if (event.cacheReadTokens) c.cacheReadTokens += event.cacheReadTokens;
      if (event.cacheWriteTokens) c.cacheWriteTokens += event.cacheWriteTokens;
      if (event.durationMs) c.totalLlmDurationMs += event.durationMs;
    } else if (event.type === 'tool_call') {
      c.toolCalls++;
      c.toolCallsToday++;
    }

    if (event.type === 'error' && event.detail) {
      this.lastErrorDetail = { message: event.detail, timestamp: Date.now() };
    }

    this.scheduleSave();
  }

  getLastError(): { message: string; timestamp: number } | null {
    return this.lastErrorDetail;
  }

  recordTaskCompletion(
    taskId: string,
    status: 'completed' | 'failed' | 'cancelled',
    durationMs?: number
  ): void {
    this.taskEvents.push({ taskId, status, durationMs, timestamp: Date.now() });
    this.trimEvents(this.taskEvents);
    this.scheduleSave();
  }

  recordHeartbeat(success: boolean, skipped = false): void {
    this.heartbeatEvents.push({ success, skipped, timestamp: Date.now() });
    this.trimEvents(this.heartbeatEvents);
    this.scheduleSave();
  }

  /** C2: a per-call context pack had to compress (was over budget). */
  recordCompression(): void {
    this.counters.compressionCount++;
    this.scheduleSave();
  }

  /**
   * C2: a mailbox turn completed. Non-chat turns are expected to end with a completion
   * marker; missing markers on those turns feed the marker-failure rate. Chat turns are
   * excluded (a human is reading the reply, no marker protocol applies).
   */
  recordTurn(opts: { isChat: boolean; hadCompletionMarker: boolean; costUsd?: number }): void {
    const c = this.counters;
    c.turnsCompleted++;
    if (opts.costUsd) c.estimatedCost += opts.costUsd;
    if (!opts.isChat) {
      c.nonChatTurns++;
      if (!opts.hadCompletionMarker) c.markerMissTurns++;
    }
    this.scheduleSave();
  }

  getMetrics(period: '1h' | '24h' | '7d' = '24h'): AgentMetricsSnapshot {
    const cutoff = this.periodCutoff(period);
    const c = this.counters;

    const tasks = this.taskEvents.filter(e => e.timestamp >= cutoff);
    const heartbeats = this.heartbeatEvents.filter(e => e.timestamp >= cutoff);

    const tokenUsage = this.computeTokenUsageFromCounters(c);
    const taskMetrics = this.computeTaskMetrics(tasks);
    const heartbeatSuccessRate = this.computeHeartbeatRate(heartbeats);
    const errorRate = c.totalEvents > 0 ? c.errorCount / c.totalEvents : 0;
    const averageResponseTimeMs = c.requestCount > 0 ? Math.round(c.totalLlmDurationMs / c.requestCount) : 0;
    const healthScore = this.computeHealthScore(heartbeatSuccessRate, taskMetrics, errorRate);
    const harness = this.computeHarnessMetrics(c);

    return {
      agentId: this.agentId,
      period,
      collectedAt: new Date().toISOString(),
      tokenUsage,
      taskMetrics,
      healthScore,
      heartbeatSuccessRate,
      errorRate,
      averageResponseTimeMs,
      totalInteractions: c.requestCount,
      uptime: Date.now() - this.startTime,
      harness,
    };
  }

  private computeHarnessMetrics(c: AuditCounters): HarnessHealthMetrics {
    const markerFailureRate = c.nonChatTurns > 0 ? c.markerMissTurns / c.nonChatTurns : 0;
    // Cache-hit rate: cached reads over total prompt-side tokens (cached reads + writes +
    // fresh prompt tokens). 0 when nothing cacheable has been reported.
    const cacheDenominator = c.cacheReadTokens + c.cacheWriteTokens + c.promptTokens;
    const cacheHitRate = cacheDenominator > 0 ? c.cacheReadTokens / cacheDenominator : 0;
    const perTurnCostUsd = c.turnsCompleted > 0 ? c.estimatedCost / c.turnsCompleted : 0;
    return {
      compressionCount: c.compressionCount,
      markerFailureRate,
      cacheHitRate,
      perTurnCostUsd,
    };
  }

  /**
   * Returns persistent usage stats for the Usage page.
   * Provides both all-time and today-only aggregates.
   */
  getUsageStats(): {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    requestCount: number;
    toolCalls: number;
    tokensToday: number;
    requestsToday: number;
    toolCallsToday: number;
    estimatedCost: number;
    costToday: number;
    cuUsed: number;
    cuUsedToday: number;
  } {
    const c = this.counters;

    return {
      totalTokens: c.totalTokens,
      promptTokens: c.promptTokens || Math.round(c.totalTokens * 0.7),
      completionTokens: c.completionTokens || (c.totalTokens - Math.round(c.totalTokens * 0.7)),
      requestCount: c.requestCount,
      toolCalls: c.toolCalls,
      tokensToday: c.tokensToday,
      requestsToday: c.requestsToday,
      toolCallsToday: c.toolCallsToday,
      estimatedCost: 0,
      costToday: 0,
      cuUsed: c.totalCuUsed,
      cuUsedToday: c.cuUsedToday,
    };
  }

  /**
   * Health score algorithm (0-100):
   * - 40% heartbeat success rate
   * - 30% task completion rate (completed / (completed + failed))
   * - 20% error rate (inverted — lower errors = higher score)
   * - 10% recency bonus (have there been recent successful interactions?)
   */
  computeHealthScore(
    heartbeatSuccessRate: number,
    taskMetrics: TaskMetrics,
    errorRate: number
  ): number {
    const heartbeatComponent = heartbeatSuccessRate * 40;

    const totalTasks = taskMetrics.completed + taskMetrics.failed;
    const taskCompletionRate = totalTasks > 0 ? taskMetrics.completed / totalTasks : 1;
    const taskComponent = taskCompletionRate * 30;

    const errorComponent = (1 - errorRate) * 20;

    const now = Date.now();
    const recencyMs = this.counters.lastSuccessTimestamp > 0 ? now - this.counters.lastSuccessTimestamp : Infinity;
    const recencyComponent = recencyMs < 3600_000 ? 10 : recencyMs < 86400_000 ? 5 : 0;

    return Math.round(
      Math.min(100, heartbeatComponent + taskComponent + errorComponent + recencyComponent)
    );
  }

  private computeTokenUsageFromCounters(c: AuditCounters): TokenUsage {
    const input = c.promptTokens || Math.round(c.totalTokens * 0.7);
    const output = c.completionTokens || (c.totalTokens - input);
    return { input, output, cost: 0 };
  }

  private computeTaskMetrics(tasks: TaskEvent[]): TaskMetrics {
    const completed = tasks.filter(t => t.status === 'completed').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    const cancelled = tasks.filter(t => t.status === 'cancelled').length;

    const completedWithDuration = tasks.filter(t => t.status === 'completed' && t.durationMs);
    const avgTime =
      completedWithDuration.length > 0
        ? completedWithDuration.reduce((sum, t) => sum + (t.durationMs ?? 0), 0) /
          completedWithDuration.length
        : 0;

    return {
      completed,
      failed,
      cancelled,
      averageCompletionTimeMs: Math.round(avgTime),
    };
  }

  private computeHeartbeatRate(heartbeats: HeartbeatEvent[]): number {
    const executed = heartbeats.filter(h => !h.skipped);
    if (executed.length === 0) return 1;
    const successes = executed.filter(h => h.success).length;
    return successes / executed.length;
  }

  private periodCutoff(period: '1h' | '24h' | '7d'): number {
    const now = Date.now();
    switch (period) {
      case '1h':
        return now - 3600_000;
      case '24h':
        return now - 86400_000;
      case '7d':
        return now - 7 * 86400_000;
    }
  }

  private trimEvents<T extends { timestamp: number }>(events: T[]): void {
    if (events.length > AgentMetricsCollector.MAX_EVENTS) {
      events.splice(0, events.length - AgentMetricsCollector.MAX_EVENTS);
    }
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveToDisk();
  }

  private scheduleSave(): void {
    if (!this.dataDir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, 5_000);
  }

  private saveToDisk(): void {
    if (!this.dataDir) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const file = join(this.dataDir, 'metrics.json');
      const data = {
        startTime: this.startTime,
        counters: this.counters,
        taskEvents: this.taskEvents.slice(-2000),
        heartbeatEvents: this.heartbeatEvents.slice(-2000),
        lastErrorDetail: this.lastErrorDetail,
      };
      writeFileSync(file, JSON.stringify(data));
    } catch (err) {
      log.warn('Failed to persist metrics to disk', { error: String(err), dir: this.dataDir });
    }
  }

  private loadFromDisk(): void {
    if (!this.dataDir) return;
    try {
      const file = join(this.dataDir, 'metrics.json');
      if (!existsSync(file)) return;
      const raw = JSON.parse(readFileSync(file, 'utf-8'));
      if (raw.startTime) this.startTime = raw.startTime;
      if (raw.counters) this.counters = { ...freshCounters(), ...raw.counters };
      if (raw.lastErrorDetail) this.lastErrorDetail = raw.lastErrorDetail;
      if (Array.isArray(raw.taskEvents)) this.taskEvents = raw.taskEvents;
      if (Array.isArray(raw.heartbeatEvents)) this.heartbeatEvents = raw.heartbeatEvents;
    } catch (err) {
      log.warn('Failed to load metrics from disk', { error: String(err), dir: this.dataDir });
    }
  }
}
