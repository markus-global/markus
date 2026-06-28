import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';

let tempDir: string;
const originalFetch = globalThis.fetch;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'CU integration test role',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function chatCompletionBody(content = 'Hello from Markus') {
  return {
    choices: [{
      message: { content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

function mockFetchResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  } as Response;
}

/** Minimal billing recorder mirroring BillingService CU metadata tracking. */
class BillingRecorder {
  records: Array<{
    orgId: string;
    agentId: string;
    type: string;
    amount: number;
    metadata?: Record<string, unknown>;
  }> = [];

  recordUsage(opts: {
    orgId: string;
    agentId: string;
    type: string;
    amount: number;
    metadata?: Record<string, unknown>;
  }): void {
    this.records.push(opts);
  }

  getCuTotal(): number {
    return this.records
      .filter(r => r.type === 'llm_tokens')
      .reduce((sum, r) => sum + (typeof r.metadata?.cuCost === 'number' ? r.metadata.cuCost : 0), 0);
  }
}

describe('Agent CU integration', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'markus-agent-cu-'));
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('flows CU from Markus provider through audit, metrics, and billing', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (href.includes('/v1/chat/completions')) {
        return mockFetchResponse(chatCompletionBody(), 200, {
          'x-cu-cost': '27',
          'x-cu-remaining': '973',
          'x-cu-limit': '1000',
        });
      }
      return mockFetchResponse({ error: { message: 'not found' } }, 404);
    });

    const router = new LLMRouter('markus');
    router.registerProviderFromConfig('markus', {
      provider: 'markus',
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8787',
      model: 'markus-lite',
    });
    router.setAutoFallback(false);

    const billing = new BillingRecorder();
    const auditEvents: Array<Record<string, unknown>> = [];

    const agent = new Agent({
      config: {
        id: 'cu-test-agent',
        name: 'CU Test Agent',
        roleId: 'worker',
        llmConfig: { modelMode: 'custom', primary: 'markus' },
        createdAt: new Date().toISOString(),
      } as never,
      role: MOCK_ROLE,
      llmRouter: router,
      dataDir: tempDir,
    });

    agent.setAuditCallback((event) => {
      auditEvents.push({ ...event });
      if (event.tokensUsed && event.type === 'llm_request') {
        billing.recordUsage({
          orgId: 'default',
          agentId: agent.id,
          type: 'llm_tokens',
          amount: event.tokensUsed,
          metadata: {
            cuCost: event.cuCost,
            provider: event.provider,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          },
        });
      }
    });

    await agent.handleMessage('hello');

    const llmAudit = auditEvents.find(e => e.type === 'llm_request' && e.success);
    expect(llmAudit).toBeDefined();
    expect(llmAudit?.cuCost).toBe(27);
    expect(llmAudit?.provider).toBe('markus');

    const usageStats = agent.getUsageStats();
    expect(usageStats.cuUsed).toBe(27);
    expect(usageStats.cuUsedToday).toBe(27);
    expect(usageStats.estimatedCost).toBe(0);

    expect(billing.getCuTotal()).toBe(27);
    const billingRecord = billing.records.find(r => r.type === 'llm_tokens');
    expect(billingRecord?.metadata?.cuCost).toBe(27);
    expect(billingRecord?.metadata?.provider).toBe('markus');
  });
});
