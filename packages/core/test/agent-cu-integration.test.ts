import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import { LLMRouter } from '../src/llm/router.js';
import { MarkusProvider } from '../src/llm/markus-provider.js';
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
    usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0027 },
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

class BillingRecorder {
  records: Array<{
    orgId: string;
    agentId: string;
    type: string;
    amount: number;
    metadata?: Record<string, unknown>;
  }> = [];

  recordUsage(r: {
    orgId: string;
    agentId: string;
    type: string;
    amount: number;
    metadata?: Record<string, unknown>;
  }): void {
    this.records.push(r);
  }

  getTokenTotal(): number {
    return this.records
      .filter(r => r.type === 'llm_tokens')
      .reduce((s, r) => s + r.amount, 0);
  }
}

describe('Agent CU integration', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'markus-cu-'));
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('flows OR chat through audit/metrics; CU is Hub-reconciled (not response headers)', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (href.includes('/v1/chat/completions')) {
        return mockFetchResponse(chatCompletionBody());
      }
      return mockFetchResponse({ error: { message: 'not found' } }, 404);
    });

    const router = new LLMRouter('markus');
    // Use registerProvider (not FromConfig) to avoid async Hub catalog refresh races.
    router.registerProvider('markus', new MarkusProvider({
      provider: 'markus',
      apiKey: 'sk-or-test-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4-flash',
    }));
    router.addCustomModel('markus', {
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      provider: 'markus',
      contextWindow: 128000,
      maxOutputTokens: 8192,
      cost: { input: 0, output: 0 },
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
    // OR path: no Worker x-cu-* headers; plan CU comes from Hub reconcile.
    expect(llmAudit?.cuCost ?? 0).toBe(0);
    expect(llmAudit?.provider).toBe('markus');
    expect(llmAudit?.tokensUsed).toBe(150);

    const usageStats = agent.getUsageStats();
    expect(usageStats.cuUsed).toBe(0);
    expect(billing.getTokenTotal()).toBe(150);
    const billingRecord = billing.records.find(r => r.type === 'llm_tokens');
    expect(billingRecord?.metadata?.provider).toBe('markus');
  });
});
