import {
  createLogger,
  generateId,
  type Report,
  type ReportPeriod,
  type ReportScope,
  type ReportMetrics,
  type ReportTaskSummary,
  type ReportCostSummary,
  type ReportPlan,
  type ReportFeedback,
  type FeedbackAction,
} from '@markus/shared';
import type { TaskService } from './task-service.js';
import type { BillingService } from './billing-service.js';
import type { AuditService } from './audit-service.js';
import type { KnowledgeService } from './knowledge-service.js';

const log = createLogger('report-service');

export class ReportService {
  private reports = new Map<string, Report>();
  private feedbackStore = new Map<string, ReportFeedback[]>();

  constructor(
    private taskService: TaskService,
    private billingService: BillingService,
    private auditService: AuditService,
    private knowledgeService: KnowledgeService
  ) {}

  async generateReport(opts: {
    type: ReportPeriod;
    scope: ReportScope;
    scopeId: string;
    periodStart: Date;
    periodEnd: Date;
    includePlan?: boolean;
    generatedBy?: string;
  }): Promise<Report> {
    const allTasks = this.taskService.listTasks({ orgId: opts.scopeId });
    const periodTasks = allTasks.filter(t => {
      const updated = new Date(t.updatedAt);
      return updated >= opts.periodStart && updated <= opts.periodEnd;
    });

    const metrics = this.computeMetrics(periodTasks);
    const taskSummary = this.buildTaskSummary(periodTasks);
    const costSummary = this.buildCostSummary(opts.scopeId, opts.periodStart, opts.periodEnd);

    let upcomingPlan: ReportPlan | undefined;
    if (opts.includePlan) {
      const pendingTasks = allTasks.filter(t => t.status === 'pending_approval');
      upcomingPlan = {
        status: 'draft',
        goals: [],
        plannedTasks: pendingTasks.slice(0, 10).map(t => ({
          title: t.title,
          description: t.description,
          assignedAgent: t.assignedAgentId,
          priority: t.priority,
        })),
      };
    }

    const report: Report = {
      id: generateId('rpt'),
      type: opts.type,
      scope: opts.scope,
      scopeId: opts.scopeId,
      periodStart: opts.periodStart.toISOString(),
      periodEnd: opts.periodEnd.toISOString(),
      status: 'ready',
      metrics,
      taskSummary,
      costSummary,
      upcomingPlan,
      generatedAt: new Date().toISOString(),
      generatedBy: opts.generatedBy ?? 'system',
    };

    this.reports.set(report.id, report);
    log.info('Report generated', { id: report.id, type: report.type, scope: report.scope });
    return report;
  }

  getReport(id: string): Report | undefined {
    return this.reports.get(id);
  }

  listReports(opts?: { scope?: string; scopeId?: string; type?: string }): Report[] {
    let results = [...this.reports.values()];
    if (opts?.scope) results = results.filter(r => r.scope === opts.scope);
    if (opts?.scopeId) results = results.filter(r => r.scopeId === opts.scopeId);
    if (opts?.type) results = results.filter(r => r.type === opts.type);
    return results.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  // ─── Plan Approval ─────────────────────────────────────────────────────────

  submitPlanForApproval(reportId: string): void {
    const report = this.reports.get(reportId);
    if (!report?.upcomingPlan) throw new Error('Report has no plan');
    report.upcomingPlan.status = 'pending_approval';
    log.info('Plan submitted for approval', { reportId });
  }

  approvePlan(reportId: string, userId: string): Report {
    const report = this.reports.get(reportId);
    if (!report?.upcomingPlan) throw new Error('Report has no plan');
    report.upcomingPlan.status = 'approved';
    report.upcomingPlan.approvedBy = userId;
    report.upcomingPlan.approvedAt = new Date().toISOString();
    report.status = 'reviewed';
    report.reviewedBy = userId;
    report.reviewedAt = new Date().toISOString();

    for (const planned of report.upcomingPlan.plannedTasks) {
      if (!planned.assignedAgent) continue;
      this.taskService.createTask({
        orgId: report.scopeId,
        title: planned.title,
        description: planned.description,
        priority: (planned.priority as any) ?? 'medium',
        assignedAgentId: planned.assignedAgent,
        reviewerAgentId: planned.assignedAgent,
        approvedVia: 'plan_approval',
        planReportId: reportId,
        projectId: report.scope === 'project' ? report.scopeId : undefined,
      });
    }

    log.info('Plan approved — tasks created', {
      reportId,
      taskCount: report.upcomingPlan.plannedTasks.length,
    });
    return report;
  }

  rejectPlan(reportId: string, userId: string, reason: string): Report {
    const report = this.reports.get(reportId);
    if (!report?.upcomingPlan) throw new Error('Report has no plan');
    report.upcomingPlan.status = 'rejected';
    report.upcomingPlan.rejectionReason = reason;
    log.info('Plan rejected', { reportId, reason });
    return report;
  }

  // ─── Feedback ──────────────────────────────────────────────────────────────

  addFeedback(opts: {
    reportId: string;
    authorId: string;
    authorName: string;
    type: 'annotation' | 'comment' | 'directive';
    content: string;
    priority?: 'normal' | 'important' | 'critical';
    anchor?: { section: string; itemId?: string };
    disclosure: {
      scope: 'private' | 'targeted' | 'broadcast';
      targetAgentIds?: string[];
      targetTeamIds?: string[];
    };
    saveToKnowledge?: boolean;
    projectId?: string;
    assignedAgentId?: string;
    reviewerAgentId?: string;
  }): ReportFeedback {
    const actions: FeedbackAction[] = [];

    if (opts.disclosure.scope === 'broadcast') {
      const announcementId = generateId('ann');
      actions.push({ type: 'announcement', announcementId });
    }

    if (opts.saveToKnowledge && opts.projectId) {
      const entry = this.knowledgeService.contribute({
        scope: 'project',
        scopeId: opts.projectId,
        category: opts.type === 'directive' ? 'process' : 'decision',
        title: `Human feedback: ${opts.content.slice(0, 80)}`,
        content: opts.content,
        source: opts.authorId,
        importance: opts.priority === 'critical' ? 90 : opts.priority === 'important' ? 75 : 50,
      });
      this.knowledgeService.verify(entry.id, opts.authorId);
      actions.push({ type: 'knowledge', knowledgeId: entry.id });
    }

    if (opts.type === 'directive' && opts.assignedAgentId && opts.reviewerAgentId) {
      const task = this.taskService.createTask({
        orgId: opts.reportId,
        title: `Directive: ${opts.content.slice(0, 100)}`,
        description: opts.content,
        priority: opts.priority === 'critical' ? 'urgent' : 'high',
        assignedAgentId: opts.assignedAgentId,
        reviewerAgentId: opts.reviewerAgentId,
        approvedVia: 'plan_approval',
        projectId: opts.projectId,
      });
      actions.push({ type: 'task_created', taskId: task.id });
    }

    const feedback: ReportFeedback = {
      id: generateId('fb'),
      reportId: opts.reportId,
      authorId: opts.authorId,
      authorName: opts.authorName,
      type: opts.type,
      anchor: opts.anchor,
      content: opts.content,
      priority: opts.priority ?? 'normal',
      disclosure: opts.disclosure,
      actions,
      createdAt: new Date().toISOString(),
    };

    const existing = this.feedbackStore.get(opts.reportId) ?? [];
    existing.push(feedback);
    this.feedbackStore.set(opts.reportId, existing);

    log.info('Feedback added to report', {
      reportId: opts.reportId,
      type: opts.type,
      disclosure: opts.disclosure.scope,
    });
    return feedback;
  }

  getFeedback(reportId: string): ReportFeedback[] {
    return this.feedbackStore.get(reportId) ?? [];
  }

  getRecentFeedbackForAgent(agentId: string): ReportFeedback[] {
    const result: ReportFeedback[] = [];
    for (const feedbackList of this.feedbackStore.values()) {
      for (const fb of feedbackList) {
        if (fb.disclosure.scope === 'broadcast') {
          result.push(fb);
        } else if (
          fb.disclosure.scope === 'targeted' &&
          fb.disclosure.targetAgentIds?.includes(agentId)
        ) {
          result.push(fb);
        }
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private computeMetrics(tasks: any[]): ReportMetrics {
    const completed = tasks.filter(t => t.status === 'completed');
    const durations = completed
      .filter(t => t.startedAt)
      .map(t => new Date(t.updatedAt).getTime() - new Date(t.startedAt).getTime());
    const avgDuration =
      durations.length > 0 ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;

    return {
      tasksCompleted: completed.length,
      tasksFailed: tasks.filter(t => t.status === 'failed').length,
      tasksCreated: tasks.length,
      tasksInProgress: tasks.filter(t => t.status === 'in_progress').length,
      tasksBlocked: tasks.filter(t => t.status === 'blocked').length,
      avgCompletionTimeMs: avgDuration,
      totalTokensUsed: 0,
      estimatedCost: 0,
      knowledgeContributions: 0,
    };
  }

  private buildTaskSummary(tasks: any[]): ReportTaskSummary {
    return {
      completed: tasks
        .filter(t => t.status === 'completed')
        .map(t => ({
          id: t.id,
          title: t.title,
          agent: t.assignedAgentId ?? 'unassigned',
          durationMs: t.startedAt
            ? new Date(t.updatedAt).getTime() - new Date(t.startedAt).getTime()
            : 0,
        })),
      inProgress: tasks
        .filter(t => t.status === 'in_progress')
        .map(t => ({
          id: t.id,
          title: t.title,
          agent: t.assignedAgentId ?? 'unassigned',
          startedAt: t.startedAt ?? t.updatedAt,
        })),
      blocked: tasks
        .filter(t => t.status === 'blocked')
        .map(t => ({
          id: t.id,
          title: t.title,
          agent: t.assignedAgentId ?? 'unassigned',
          reason: t.blockedBy?.join(', ') ?? 'unknown',
        })),
      carriedOver: [],
    };
  }

  private buildCostSummary(scopeId: string, start: Date, end: Date): ReportCostSummary {
    const usage = this.billingService.getUsageSummaryForPeriod(scopeId, start, end);
    return {
      totalTokens: usage.llmTokens,
      totalEstimatedCost: usage.llmTokens * 0.000003,
      byAgent: [],
      byCategory: [
        { category: 'llm_tokens', tokens: usage.llmTokens, cost: usage.llmTokens * 0.000003 },
        { category: 'tool_calls', tokens: 0, cost: 0 },
      ],
      trend: 'stable',
    };
  }
}
