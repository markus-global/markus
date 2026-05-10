/**
 * Internal-External Bridge - Connects external service activity back to the internal agent.
 *
 * Responsibilities:
 * 1. Daily summary: Injects external service stats into agent's heartbeat/daily report
 * 2. Escalation: Routes unresolvable queries to internal agent's mailbox
 * 3. Re-publish trigger: Notifies when knowledge drift requires snapshot update
 */
import { createLogger } from '@markus/shared';

const log = createLogger('internal-bridge');

export interface MailboxInjector {
  injectSystemEvent(agentId: string, event: { type: string; priority: number; content: string; metadata?: Record<string, unknown> }): void;
  injectDailyReport(agentId: string, section: string, content: string): void;
}

export interface ExternalStatsProvider {
  getDailySummary(serviceId: string): Promise<DailySummary>;
  getUnansweredQueries(serviceId: string, limit?: number): Promise<UnansweredQuery[]>;
}

export interface DailySummary {
  date: string;
  totalSessions: number;
  totalMessages: number;
  tokensUsed: number;
  averageRating: number | null;
  uniqueUsers: number;
  topQuestions: string[];
  errorCount: number;
}

export interface UnansweredQuery {
  sessionId: string;
  question: string;
  timestamp: string;
  participantId: string;
}

export class InternalExternalBridge {
  constructor(
    private mailbox: MailboxInjector,
    private stats: ExternalStatsProvider,
  ) {}

  /**
   * Generate and inject a daily summary into the agent's heartbeat report.
   * Should be called by the agent's daily report scheduler.
   */
  async injectDailySummary(agentId: string, serviceId: string): Promise<void> {
    try {
      const summary = await this.stats.getDailySummary(serviceId);

      const content = this.formatDailySummary(summary);
      this.mailbox.injectDailyReport(agentId, 'external_service', content);

      log.info('Daily summary injected', { agentId, serviceId, sessions: summary.totalSessions });
    } catch (err) {
      log.error('Failed to inject daily summary', { agentId, serviceId, error: String(err) });
    }
  }

  /**
   * Escalate a query from an external session to the internal agent's mailbox.
   * Used when the session worker cannot handle a request.
   */
  escalate(agentId: string, opts: {
    sessionId: string;
    question: string;
    participantId: string;
    context?: string;
    priority?: number;
  }): void {
    const content = `[External Escalation] A user in external session asked a question I couldn't resolve:\n\nQuestion: "${opts.question}"${opts.context ? `\n\nContext: ${opts.context}` : ''}\n\nSession: ${opts.sessionId}\nPlease consider updating the published service knowledge if this is a common question.`;

    this.mailbox.injectSystemEvent(agentId, {
      type: 'external_escalation',
      priority: opts.priority ?? 3,
      content,
      metadata: {
        sessionId: opts.sessionId,
        participantId: opts.participantId,
        question: opts.question,
      },
    });

    log.info('Escalation injected', { agentId, sessionId: opts.sessionId });
  }

  /**
   * Notify the internal agent that knowledge drift has been detected
   * (too many unanswered questions) and suggest a re-publish.
   */
  async checkKnowledgeDrift(agentId: string, serviceId: string, threshold = 5): Promise<void> {
    const queries = await this.stats.getUnansweredQueries(serviceId, threshold);
    if (queries.length < threshold) return;

    const questionList = queries.map(q => `- "${q.question}"`).join('\n');
    const content = `[External Service] Knowledge drift detected. ${queries.length} recent user questions could not be answered satisfactorily:\n\n${questionList}\n\nConsider updating your knowledge and re-publishing the external service to better serve users.`;

    this.mailbox.injectSystemEvent(agentId, {
      type: 'knowledge_drift_alert',
      priority: 4,
      content,
      metadata: { serviceId, unansweredCount: queries.length },
    });

    log.info('Knowledge drift alert sent', { agentId, serviceId, count: queries.length });
  }

  private formatDailySummary(s: DailySummary): string {
    const lines = [
      `📊 External Service Daily Report (${s.date})`,
      ``,
      `Sessions: ${s.totalSessions} | Messages: ${s.totalMessages} | Unique Users: ${s.uniqueUsers}`,
      `Tokens Used: ${s.tokensUsed.toLocaleString()} | Errors: ${s.errorCount}`,
    ];

    if (s.averageRating !== null) {
      lines.push(`Average Rating: ${s.averageRating.toFixed(1)}/5`);
    }

    if (s.topQuestions.length > 0) {
      lines.push('', 'Most Common Questions:');
      for (const q of s.topQuestions.slice(0, 5)) {
        lines.push(`  • ${q}`);
      }
    }

    return lines.join('\n');
  }
}
