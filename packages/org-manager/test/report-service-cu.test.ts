import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReportService } from '../src/report-service.js';

describe('ReportService CU cost summary', () => {
  let billingService: {
    getUsageSummaryForPeriod: ReturnType<typeof vi.fn>;
    getCuUsageSummaryForPeriod: ReturnType<typeof vi.fn>;
  };
  let service: ReportService;

  beforeEach(() => {
    billingService = {
      getUsageSummaryForPeriod: vi.fn(() => ({ llmTokens: 1500, toolCalls: 2, messages: 0 })),
      getCuUsageSummaryForPeriod: vi.fn(() => ({ totalCu: 85 })),
    };
    service = new ReportService(
      {
        listTasks: vi.fn(() => []),
        createTask: vi.fn(),
      } as never,
      billingService as never,
      { record: vi.fn() } as never,
      {
        contribute: vi.fn(),
        verify: vi.fn(),
      } as never,
    );
  });

  it('buildCostSummary returns totalCu instead of USD estimate', async () => {
    const report = await service.generateReport({
      type: 'daily',
      scope: 'org',
      scopeId: 'org-1',
      periodStart: new Date('2026-06-01T00:00:00.000Z'),
      periodEnd: new Date('2026-06-30T23:59:59.999Z'),
    });

    expect(billingService.getCuUsageSummaryForPeriod).toHaveBeenCalled();
    expect(report.costSummary.totalCu).toBe(85);
    expect(report.costSummary.totalTokens).toBe(1500);
    expect(report.costSummary.totalEstimatedCost).toBe(0);
  });
});
