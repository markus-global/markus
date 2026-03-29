import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
}

interface AuditCounters {
  totalTokens: number;
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
}

function freshCounters(): AuditCounters {
  return {
    totalTokens: 0, requestCount: 0, toolCalls: 0, errorCount: 0,
    totalEvents: 0, totalLlmDurationMs: 0, lastSuccessTimestamp: 0,
    tokensToday: 0, requestsToday: 0, toolCallsToday: 0,
    todayCutoffDate: new Date().toISOString().slice(0, 10),
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
      c.todayCutoffDate = today;
    }

    c.totalEvents++;
    if (!event.success) c.errorCount++;
    if (event.success) c.lastSuccessTimestamp = Date.now();

    if (event.type === 'llm_request') {
      const tokens = event.tokensUsed ?? 0;
      c.totalTokens += tokens;
      c.requestCount++;
      c.tokensToday += tokens;
      c.requestsToday++;
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

  recordHeartbeat(success: boolean): void {
    this.heartbeatEvents.push({ success, timestamp: Date.now() });
    this.trimEvents(this.heartbeatEvents);
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
  } {
    const c = this.counters;
    const input = Math.round(c.totalTokens * 0.7);
    const output = c.totalTokens - input;
    const estimatedCost = (input / 1_000_000) * 3 + (output / 1_000_000) * 15;

    return {
      totalTokens: c.totalTokens,
      promptTokens: input,
      completionTokens: output,
      requestCount: c.requestCount,
      toolCalls: c.toolCalls,
      tokensToday: c.tokensToday,
      requestsToday: c.requestsToday,
      toolCallsToday: c.toolCallsToday,
      estimatedCost: Math.round(estimatedCost * 10000) / 10000,
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
    const input = Math.round(c.totalTokens * 0.7);
    const output = c.totalTokens - input;
    const cost = (input / 1_000_000) * 3 + (output / 1_000_000) * 15;
    return { input, output, cost: Math.round(cost * 10000) / 10000 };
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
    if (heartbeats.length === 0) return 1;
    const successes = heartbeats.filter(h => h.success).length;
    return successes / heartbeats.length;
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
    } catch {
      /* best effort */
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
    } catch {
      /* best effort */
    }
  }
}
