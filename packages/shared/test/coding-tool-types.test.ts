import { describe, it, expect } from 'vitest';
import {
  isCodingToolName,
  isCodingToolSessionStatus,
  isCodingToolEventType,
  isCliSuccessResponse,
  isCliErrorResponse,
  CLI_EXIT_CODES,
  type CodingToolConfig,
  type CodingToolSession,
  type ToolCostReport,
  type CodingToolResult,
  type TestResult,
  type CodingToolEvent,
  type ToolAdapter,
  type ToolExecutionContext,
  type TaskContextResponse,
  type CliResponse,
  type CliSuccessResponse,
  type CliErrorResponse,
} from '../src/types/coding-tool.js';

describe('Coding Tool Types', () => {
  describe('type guards', () => {
    describe('isCodingToolName', () => {
      it('accepts valid tool names', () => {
        expect(isCodingToolName('claude-code')).toBe(true);
        expect(isCodingToolName('codex')).toBe(true);
        expect(isCodingToolName('cursor-agent')).toBe(true);
      });

      it('rejects invalid values', () => {
        expect(isCodingToolName('copilot')).toBe(false);
        expect(isCodingToolName('')).toBe(false);
        expect(isCodingToolName(null)).toBe(false);
        expect(isCodingToolName(undefined)).toBe(false);
        expect(isCodingToolName(42)).toBe(false);
      });
    });

    describe('isCodingToolSessionStatus', () => {
      it('accepts all valid session statuses', () => {
        const validStatuses = ['created', 'context_injected', 'running', 'completed', 'failed', 'cancelled', 'timeout'];
        for (const status of validStatuses) {
          expect(isCodingToolSessionStatus(status)).toBe(true);
        }
      });

      it('rejects invalid values', () => {
        expect(isCodingToolSessionStatus('pending')).toBe(false);
        expect(isCodingToolSessionStatus('active')).toBe(false);
        expect(isCodingToolSessionStatus(123)).toBe(false);
      });
    });

    describe('isCodingToolEventType', () => {
      it('accepts all valid event types', () => {
        const validTypes = ['progress', 'tool_use', 'file_edit', 'test_run', 'error', 'cost_update', 'completed'];
        for (const t of validTypes) {
          expect(isCodingToolEventType(t)).toBe(true);
        }
      });

      it('rejects invalid values', () => {
        expect(isCodingToolEventType('start')).toBe(false);
        expect(isCodingToolEventType('')).toBe(false);
      });
    });

    describe('isCliSuccessResponse / isCliErrorResponse', () => {
      it('identifies success responses', () => {
        const success: CliSuccessResponse = { ok: true, data: { id: '123' } };
        expect(isCliSuccessResponse(success)).toBe(true);
        expect(isCliErrorResponse(success)).toBe(false);
      });

      it('identifies error responses', () => {
        const error: CliErrorResponse = { ok: false, error: 'Not found', code: 'NOT_FOUND' };
        expect(isCliErrorResponse(error)).toBe(true);
        expect(isCliSuccessResponse(error)).toBe(false);
      });
    });
  });

  describe('CLI_EXIT_CODES', () => {
    it('defines expected exit codes', () => {
      expect(CLI_EXIT_CODES.SUCCESS).toBe(0);
      expect(CLI_EXIT_CODES.USER_ERROR).toBe(1);
      expect(CLI_EXIT_CODES.SERVER_ERROR).toBe(2);
      expect(CLI_EXIT_CODES.NETWORK_ERROR).toBe(3);
    });
  });

  describe('serialization round-trips', () => {
    it('CodingToolConfig survives JSON round-trip', () => {
      const config: CodingToolConfig = {
        tool: 'claude-code',
        enabled: true,
        binaryPath: '/usr/local/bin/claude',
        defaultArgs: ['--output-format', 'stream-json'],
        timeoutMs: 300000,
        maxRetries: 2,
        env: { ANTHROPIC_API_KEY: 'sk-test' },
      };
      const parsed = JSON.parse(JSON.stringify(config)) as CodingToolConfig;
      expect(parsed).toEqual(config);
      expect(isCodingToolName(parsed.tool)).toBe(true);
    });

    it('CodingToolSession survives JSON round-trip', () => {
      const session: CodingToolSession = {
        id: 'session-001',
        taskId: 'task-001',
        tool: 'codex',
        status: 'running',
        worktreePath: '/tmp/worktree-001',
        branchName: 'coding-tool/task-001',
        prompt: 'Implement user authentication',
        progressPercent: 45,
        progressMessage: 'Writing auth middleware...',
        createdAt: '2026-01-01T00:00:00Z',
        startedAt: '2026-01-01T00:01:00Z',
      };
      const parsed = JSON.parse(JSON.stringify(session)) as CodingToolSession;
      expect(parsed).toEqual(session);
      expect(isCodingToolSessionStatus(parsed.status)).toBe(true);
    });

    it('CodingToolResult with test results survives JSON round-trip', () => {
      const result: CodingToolResult = {
        success: true,
        summary: 'Implemented auth module',
        diffStats: { filesChanged: 3, additions: 150, deletions: 10 },
        modifiedFiles: ['src/auth.ts', 'src/middleware.ts', 'test/auth.test.ts'],
        testResult: { passed: 12, failed: 0, skipped: 1, success: true },
        exitCode: 0,
      };
      const parsed = JSON.parse(JSON.stringify(result)) as CodingToolResult;
      expect(parsed).toEqual(result);
    });

    it('ToolCostReport survives JSON round-trip', () => {
      const cost: ToolCostReport = {
        inputTokens: 15000,
        outputTokens: 8000,
        cacheReadTokens: 5000,
        estimatedCostUsd: 0.35,
        durationMs: 45000,
        source: 'tool_output',
      };
      const parsed = JSON.parse(JSON.stringify(cost)) as ToolCostReport;
      expect(parsed).toEqual(cost);
    });

    it('CodingToolEvent survives JSON round-trip', () => {
      const event: CodingToolEvent = {
        type: 'file_edit',
        content: 'Modified src/auth.ts',
        metadata: { path: 'src/auth.ts', additions: 50, deletions: 3 },
        timestamp: '2026-01-01T00:05:00Z',
      };
      const parsed = JSON.parse(JSON.stringify(event)) as CodingToolEvent;
      expect(parsed).toEqual(event);
      expect(isCodingToolEventType(parsed.type)).toBe(true);
    });

    it('TaskContextResponse survives JSON round-trip', () => {
      const ctx: TaskContextResponse = {
        task: {
          id: 'task-001',
          title: 'Implement auth',
          description: 'Add JWT authentication',
          status: 'in_progress',
          priority: 'high',
          subtasks: [{ id: 'sub-1', title: 'Write middleware', status: 'pending' }],
          notes: ['Started working on JWT flow'],
          assignedAgentId: 'agent-dev',
          reviewerId: 'agent-reviewer',
          executionRound: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T01:00:00Z',
        },
        requirement: {
          id: 'req-001',
          title: 'User Authentication',
          description: 'Implement complete auth flow',
          status: 'in_progress',
        },
        project: {
          id: 'proj-001',
          name: 'MyApp',
          description: 'Main application',
          repositories: [{ localPath: '/code/myapp', role: 'primary' }],
        },
        upstream: [
          {
            id: 'task-000',
            title: 'Database schema',
            status: 'completed',
            completionSummary: 'Created users table',
            deliverables: [{ type: 'file', reference: 'migrations/001.sql', summary: 'Users table schema' }],
          },
        ],
        downstream: [
          { id: 'task-002', title: 'API endpoints', status: 'blocked' },
        ],
      };
      const parsed = JSON.parse(JSON.stringify(ctx)) as TaskContextResponse;
      expect(parsed).toEqual(ctx);
    });

    it('CliResponse success survives JSON round-trip', () => {
      const resp: CliResponse<{ id: string }> = { ok: true, data: { id: '123' } };
      const parsed = JSON.parse(JSON.stringify(resp)) as CliResponse<{ id: string }>;
      expect(parsed).toEqual(resp);
      expect(isCliSuccessResponse(parsed)).toBe(true);
    });

    it('CliResponse error survives JSON round-trip', () => {
      const resp: CliResponse = { ok: false, error: 'Task not found', code: 'NOT_FOUND' };
      const parsed = JSON.parse(JSON.stringify(resp)) as CliResponse;
      expect(parsed).toEqual(resp);
      expect(isCliErrorResponse(parsed)).toBe(true);
    });
  });

  describe('type structural validation', () => {
    it('ToolExecutionContext allows all optional fields', () => {
      const empty: ToolExecutionContext = {};
      expect(empty.taskId).toBeUndefined();
      expect(empty.sessionId).toBeUndefined();
      expect(empty.onProgress).toBeUndefined();
    });

    it('ToolExecutionContext onProgress callback receives events', () => {
      const events: CodingToolEvent[] = [];
      const ctx: ToolExecutionContext = {
        taskId: 'task-001',
        onProgress: (e) => events.push(e),
      };
      ctx.onProgress!({
        type: 'progress',
        content: 'Working...',
        timestamp: new Date().toISOString(),
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('progress');
    });

    it('CodingToolSession with completed result', () => {
      const session: CodingToolSession = {
        id: 's-1',
        taskId: 't-1',
        tool: 'cursor-agent',
        status: 'completed',
        prompt: 'Fix bug',
        result: {
          success: true,
          summary: 'Fixed the null check',
          diffStats: { filesChanged: 1, additions: 2, deletions: 1 },
          exitCode: 0,
        },
        cost: {
          inputTokens: 5000,
          outputTokens: 2000,
          durationMs: 12000,
          source: 'tool_output',
        },
        createdAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:00:12Z',
      };
      expect(session.result?.success).toBe(true);
      expect(session.cost?.source).toBe('tool_output');
    });
  });
});
