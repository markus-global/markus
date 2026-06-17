import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReportService } from '../src/report-service.js';

describe('ReportService', () => {
  let taskService: {
    listTasks: ReturnType<typeof vi.fn>;
    createTask: ReturnType<typeof vi.fn>;
  };
  let billingService: { getUsageSummaryForPeriod: ReturnType<typeof vi.fn> };
  let auditService: { record: ReturnType<typeof vi.fn> };
  let knowledgeService: {
    contribute: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
  };
  let service: ReportService;

  beforeEach(() => {
    taskService = {
      listTasks: vi.fn(() => [
        {
          id: 't1', title: 'Done', status: 'completed', orgId: 'org-1',
          assignedAgentId: 'agent-1', updatedAt: '2026-06-10T00:00:00.000Z',
          startedAt: '2026-06-09T00:00:00.000Z', priority: 'high',
        },
        {
          id: 't2', title: 'Pending', status: 'pending', orgId: 'org-1',
          assignedAgentId: 'agent-2', updatedAt: '2026-06-11T00:00:00.000Z', priority: 'medium',
        },
        {
          id: 't3', title: 'Blocked', status: 'blocked', orgId: 'org-1',
          assignedAgentId: 'agent-1', updatedAt: '2026-06-12T00:00:00.000Z',
          blockedBy: ['dep-1'],
        },
        {
          id: 't4', title: 'Failed', status: 'failed', orgId: 'org-1',
          updatedAt: '2026-06-13T00:00:00.000Z',
        },
        {
          id: 't5', title: 'In progress', status: 'in_progress', orgId: 'org-1',
          assignedAgentId: 'agent-1', updatedAt: '2026-06-14T00:00:00.000Z',
          startedAt: '2026-06-14T00:00:00.000Z',
        },
      ]),
      createTask: vi.fn((opts) => ({ id: 'new-task', ...opts })),
    };
    billingService = {
      getUsageSummaryForPeriod: vi.fn(() => ({ llmTokens: 1000, toolCalls: 5, messages: 2 })),
    };
    auditService = { record: vi.fn() };
    knowledgeService = {
      contribute: vi.fn(() => ({ id: 'kb-1' })),
      verify: vi.fn(),
    };
    service = new ReportService(
      taskService as never,
      billingService as never,
      auditService as never,
      knowledgeService as never,
    );
  });

  it('generates report with plan', async () => {
    const report = await service.generateReport({
      type: 'daily',
      scope: 'org',
      scopeId: 'org-1',
      periodStart: new Date('2026-06-01T00:00:00.000Z'),
      periodEnd: new Date('2026-06-30T23:59:59.999Z'),
      includePlan: true,
      generatedBy: 'user-1',
    });
    expect(report.id).toMatch(/^rpt_/);
    expect(report.metrics.tasksCompleted).toBe(1);
    expect(report.metrics.tasksFailed).toBe(1);
    expect(report.metrics.tasksInProgress).toBe(1);
    expect(report.metrics.tasksBlocked).toBe(1);
    expect(report.upcomingPlan?.plannedTasks.length).toBeGreaterThan(0);
    expect(report.costSummary.totalTokens).toBe(1000);
  });

  it('lists and filters reports', async () => {
    await service.generateReport({
      type: 'daily', scope: 'org', scopeId: 'org-1',
      periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-06-30'),
    });
    await service.generateReport({
      type: 'weekly', scope: 'project', scopeId: 'proj-1',
      periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-06-30'),
    });
    expect(service.listReports({ scope: 'org' })).toHaveLength(1);
    expect(service.listReports({ type: 'weekly' })).toHaveLength(1);
    expect(service.getReport(service.listReports()[0]!.id)).toBeDefined();
  });

  it('approves plan and creates tasks', async () => {
    const report = await service.generateReport({
      type: 'daily', scope: 'org', scopeId: 'org-1',
      periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-06-30'),
      includePlan: true,
    });
    service.submitPlanForApproval(report.id);
    const approved = service.approvePlan(report.id, 'user-1');
    expect(approved.upcomingPlan?.status).toBe('approved');
    expect(taskService.createTask).toHaveBeenCalled();
  });

  it('rejects plan', async () => {
    const report = await service.generateReport({
      type: 'daily', scope: 'org', scopeId: 'org-1',
      periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-06-30'),
      includePlan: true,
    });
    const rejected = service.rejectPlan(report.id, 'user-1', 'Not ready');
    expect(rejected.upcomingPlan?.status).toBe('rejected');
  });

  it('throws when plan missing', () => {
    expect(() => service.submitPlanForApproval('missing')).toThrow();
    expect(() => service.approvePlan('missing', 'u1')).toThrow();
    expect(() => service.rejectPlan('missing', 'u1', 'no')).toThrow();
  });

  it('adds feedback with broadcast, knowledge, and directive', () => {
    const fb1 = service.addFeedback({
      reportId: 'rpt-1', authorId: 'u1', authorName: 'User',
      type: 'comment', content: 'Looks good', disclosure: { scope: 'broadcast' },
    });
    expect(fb1.actions.some(a => a.type === 'announcement')).toBe(true);

    const fb2 = service.addFeedback({
      reportId: 'rpt-1', authorId: 'u1', authorName: 'User',
      type: 'annotation', content: 'Save this', disclosure: { scope: 'private' },
      saveToKnowledge: true, projectId: 'proj-1',
    });
    expect(fb2.actions.some(a => a.type === 'knowledge')).toBe(true);

    const fb3 = service.addFeedback({
      reportId: 'rpt-1', authorId: 'u1', authorName: 'User',
      type: 'directive', content: 'Fix the bug', disclosure: { scope: 'targeted', targetAgentIds: ['agent-1'] },
      assignedAgentId: 'agent-1', reviewerId: 'agent-2', priority: 'critical',
    });
    expect(fb3.actions.some(a => a.type === 'task_created')).toBe(true);
    expect(service.getFeedback('rpt-1')).toHaveLength(3);
    expect(service.getRecentFeedbackForAgent('agent-1').length).toBeGreaterThan(0);
  });
});
