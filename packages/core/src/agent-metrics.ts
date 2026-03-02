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

interface AuditEvent {
  type: string;
  action: string;
  tokensUsed?: number;
  durationMs?: number;
  success: boolean;
  timestamp: number;
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
  private auditEvents: AuditEvent[] = [];
  private taskEvents: TaskEvent[] = [];
  private heartbeatEvents: HeartbeatEvent[] = [];
  private startTime = Date.now();
  private static readonly MAX_EVENTS = 10_000;

  constructor(readonly agentId: string) {}

  recordAudit(event: { type: string; action: string; tokensUsed?: number; durationMs?: number; success: boolean }): void {
    this.auditEvents.push({ ...event, timestamp: Date.now() });
    this.trimEvents(this.auditEvents);
  }

  recordTaskCompletion(taskId: string, status: 'completed' | 'failed' | 'cancelled', durationMs?: number): void {
    this.taskEvents.push({ taskId, status, durationMs, timestamp: Date.now() });
    this.trimEvents(this.taskEvents);
  }

  recordHeartbeat(success: boolean): void {
    this.heartbeatEvents.push({ success, timestamp: Date.now() });
    this.trimEvents(this.heartbeatEvents);
  }

  getMetrics(period: '1h' | '24h' | '7d' = '24h'): AgentMetricsSnapshot {
    const cutoff = this.periodCutoff(period);

    const audits = this.auditEvents.filter(e => e.timestamp >= cutoff);
    const tasks = this.taskEvents.filter(e => e.timestamp >= cutoff);
    const heartbeats = this.heartbeatEvents.filter(e => e.timestamp >= cutoff);

    const tokenUsage = this.computeTokenUsage(audits);
    const taskMetrics = this.computeTaskMetrics(tasks);
    const heartbeatSuccessRate = this.computeHeartbeatRate(heartbeats);
    const errorRate = this.computeErrorRate(audits);
    const averageResponseTimeMs = this.computeAverageResponseTime(audits);
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
      totalInteractions: audits.filter(e => e.type === 'llm_request').length,
      uptime: Date.now() - this.startTime,
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
    errorRate: number,
  ): number {
    const heartbeatComponent = heartbeatSuccessRate * 40;

    const totalTasks = taskMetrics.completed + taskMetrics.failed;
    const taskCompletionRate = totalTasks > 0 ? taskMetrics.completed / totalTasks : 1;
    const taskComponent = taskCompletionRate * 30;

    const errorComponent = (1 - errorRate) * 20;

    const now = Date.now();
    const lastSuccessfulAudit = [...this.auditEvents]
      .reverse()
      .find(e => e.success);
    const recencyMs = lastSuccessfulAudit ? now - lastSuccessfulAudit.timestamp : Infinity;
    const recencyComponent = recencyMs < 3600_000 ? 10 : recencyMs < 86400_000 ? 5 : 0;

    return Math.round(Math.min(100, heartbeatComponent + taskComponent + errorComponent + recencyComponent));
  }

  private computeTokenUsage(audits: AuditEvent[]): TokenUsage {
    let totalTokens = 0;
    for (const e of audits) {
      if (e.tokensUsed) totalTokens += e.tokensUsed;
    }
    // Rough split: assume ~70% input, 30% output for typical conversation
    const input = Math.round(totalTokens * 0.7);
    const output = totalTokens - input;
    // Rough cost estimate at ~$3/1M input, ~$15/1M output (Anthropic Claude 3.5 Sonnet ballpark)
    const cost = (input / 1_000_000) * 3 + (output / 1_000_000) * 15;

    return { input, output, cost: Math.round(cost * 10000) / 10000 };
  }

  private computeTaskMetrics(tasks: TaskEvent[]): TaskMetrics {
    const completed = tasks.filter(t => t.status === 'completed').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    const cancelled = tasks.filter(t => t.status === 'cancelled').length;

    const completedWithDuration = tasks.filter(t => t.status === 'completed' && t.durationMs);
    const avgTime = completedWithDuration.length > 0
      ? completedWithDuration.reduce((sum, t) => sum + (t.durationMs ?? 0), 0) / completedWithDuration.length
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

  private computeErrorRate(audits: AuditEvent[]): number {
    if (audits.length === 0) return 0;
    const errors = audits.filter(e => !e.success).length;
    return errors / audits.length;
  }

  private computeAverageResponseTime(audits: AuditEvent[]): number {
    const llmRequests = audits.filter(e => e.type === 'llm_request' && e.durationMs);
    if (llmRequests.length === 0) return 0;
    const total = llmRequests.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
    return Math.round(total / llmRequests.length);
  }

  private periodCutoff(period: '1h' | '24h' | '7d'): number {
    const now = Date.now();
    switch (period) {
      case '1h': return now - 3600_000;
      case '24h': return now - 86400_000;
      case '7d': return now - 7 * 86400_000;
    }
  }

  private trimEvents<T extends { timestamp: number }>(events: T[]): void {
    if (events.length > AgentMetricsCollector.MAX_EVENTS) {
      events.splice(0, events.length - AgentMetricsCollector.MAX_EVENTS);
    }
  }
}
