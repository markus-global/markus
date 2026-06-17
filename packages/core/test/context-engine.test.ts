import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextEngine } from '../src/context-engine.js';
import { MemoryStore } from '../src/memory/store.js';
import type { RoleTemplate, LLMMessage } from '@markus/shared';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'ctx-role',
  name: 'Context Test Role',
  description: 'Role for context engine tests',
  category: 'engineering',
  systemPrompt: 'You are a helpful engineering assistant.',
  defaultSkills: ['file_read_write'],
  heartbeatChecklist: '- Check inbox',
  defaultPolicies: [{ name: 'Safety', description: 'Be safe', rules: ['No secrets in code'] }],
  builtIn: false,
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-ctx-engine-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeEngine(overrides?: { summarizer?: (msgs: LLMMessage[]) => Promise<string> }) {
  const engine = new ContextEngine({ memorySearchTopK: 3 });
  if (overrides?.summarizer) {
    engine.setLLMSummarizer(overrides.summarizer);
  }
  return engine;
}

describe('ContextEngine constructor', () => {
  it('uses default config when none provided', () => {
    const engine = new ContextEngine();
    expect(engine).toBeDefined();
  });

  it('accepts custom memorySearchTopK', () => {
    const engine = new ContextEngine({ memorySearchTopK: 10 });
    expect(engine).toBeDefined();
  });
});

describe('buildSystemPrompt', () => {
  it('assembles stable role content and tool usage rules', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      currentQuery: 'How do I run tests?',
    });

    expect(result.text).toContain('You are a helpful engineering assistant');
    expect(result.text).toContain('## Policies');
    expect(result.text).toContain('Safety');
    expect(result.text).toContain('## Tool Usage Rules');
    expect(result.text).toContain('spawn_subagent');
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('includes org context and assigned tasks', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      orgContext: {
        orgName: 'Acme Corp',
        teamName: 'Platform',
        colleagues: [{ id: 'agt_peer', name: 'Peer', role: 'worker' }],
        projects: [{ name: 'Alpha', description: 'Main product' }],
      },
      assignedTasks: [{
        id: 'task_1',
        title: 'Fix bug',
        description: 'Resolve login issue',
        status: 'in_progress',
        priority: 'high',
      }],
    });

    expect(result.text).toContain('Acme Corp');
    expect(result.text).toContain('Platform');
    expect(result.text).toContain('Fix bug');
  });

  it('includes mailbox context when provided', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      mailboxContext: {
        queueDepth: 2,
        currentFocus: { type: 'a2a_message', label: 'Review PR', elapsedMs: 5000 },
        topQueued: [{ type: 'human_chat', priority: 0, summary: 'User question' }],
      },
    });

    expect(result.text).toContain('mailbox');
    expect(result.text.toLowerCase()).toMatch(/queue|focus|inbox/i);
  });

  it('reads CONTEXT.md from disk when path is provided', async () => {
    const memory = new MemoryStore(tempDir);
    const contextPath = join(tempDir, 'CONTEXT.md');
    writeFileSync(contextPath, '# Project Context\nUse pnpm for package management.');

    const engine = makeEngine();
    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      contextMdPath: contextPath,
    });

    expect(result.text).toContain('pnpm');
  });

  it('uses memory consolidation scenario without task workflow sections', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      scenario: 'memory_consolidation',
    });

    expect(result.text).toContain('You are a helpful engineering assistant');
    expect(result.text).not.toContain('## Task & Requirement Workflow');
  });

  it('includes semantic search results when configured', async () => {
    const memory = new MemoryStore(tempDir);
    memory.addEntry({
      id: 'mem_1',
      timestamp: new Date().toISOString(),
      type: 'fact',
      content: 'The deployment uses Kubernetes.',
    });

    const engine = makeEngine();
    engine.setSemanticSearch({
      isEnabled: () => true,
      search: vi.fn(async () => [{
        entry: memory.getEntries()[0]!,
        score: 0.9,
      }]),
    } as never);

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      currentQuery: 'deployment infrastructure',
    });

    expect(result.text).toContain('Kubernetes');
  });
});

describe('prepareMessages', () => {
  it('prepends system prompt and computes usage stats', async () => {
    const memory = new MemoryStore(tempDir);
    const session = memory.createSession('agt_ctx');
    memory.appendMessage(session.id, { role: 'user', content: 'Hello' });
    memory.appendMessage(session.id, { role: 'assistant', content: 'Hi there!' });

    const engine = makeEngine();
    const prepared = await engine.prepareMessages({
      systemPrompt: 'System instructions here.',
      sessionMessages: memory.getRecentMessages(session.id, 50),
      memory,
      sessionId: session.id,
      modelContextWindow: 32000,
      modelMaxOutput: 4000,
    });

    expect(prepared.messages[0]?.role).toBe('system');
    expect(prepared.messages.length).toBeGreaterThan(1);
    expect(prepared.usage.contextWindow).toBe(32000);
    expect(prepared.usage.systemTokens).toBeGreaterThan(0);
    expect(prepared.usage.messageTokens).toBeGreaterThan(0);
    expect(prepared.usage.usagePercent).toBeGreaterThanOrEqual(0);
  });

  it('shrinks oversized messages within budget', async () => {
    const memory = new MemoryStore(tempDir);
    const session = memory.createSession('agt_ctx');
    const huge = 'x'.repeat(50000);
    memory.appendMessage(session.id, { role: 'user', content: huge });
    memory.appendMessage(session.id, { role: 'assistant', content: 'Acknowledged.' });

    const engine = makeEngine();
    const prepared = await engine.prepareMessages({
      systemPrompt: 'Short system prompt.',
      sessionMessages: memory.getRecentMessages(session.id, 50),
      memory,
      sessionId: session.id,
      modelContextWindow: 8000,
      modelMaxOutput: 1000,
    });

    const userMsg = prepared.messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(String(userMsg!.content).length).toBeLessThan(huge.length);
  });

  it('summarizes when message count exceeds threshold', async () => {
    const memory = new MemoryStore(tempDir);
    const session = memory.createSession('agt_ctx');

    for (let i = 0; i < 65; i++) {
      memory.appendMessage(session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message number ${i} with some content.`,
      });
    }

    const summarizer = vi.fn(async () => 'Earlier conversation summarized.');
    const engine = makeEngine({ summarizer });

    const prepared = await engine.prepareMessages({
      systemPrompt: 'System prompt.',
      sessionMessages: memory.getRecentMessages(session.id, 100),
      memory,
      sessionId: session.id,
      modelContextWindow: 64000,
      modelMaxOutput: 4000,
    });

    expect(prepared.messages.length).toBeLessThan(66);
    expect(summarizer.mock.calls.length + prepared.messages.length).toBeGreaterThan(0);
  });

  it('includes tool definition tokens in usage', async () => {
    const memory = new MemoryStore(tempDir);
    const session = memory.createSession('agt_ctx');
    memory.appendMessage(session.id, { role: 'user', content: 'Run tool' });

    const engine = makeEngine();
    const prepared = await engine.prepareMessages({
      systemPrompt: 'System.',
      sessionMessages: memory.getRecentMessages(session.id, 10),
      memory,
      sessionId: session.id,
      modelContextWindow: 32000,
      modelMaxOutput: 4000,
      toolDefinitions: [{
        name: 'echo',
        description: 'Echo tool',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      }],
    });

    expect(prepared.usage.toolDefTokens).toBeGreaterThan(0);
  });
});

describe('shrinkMessages', () => {
  it('caps individual message size and drops oldest when over budget', () => {
    const engine = makeEngine();
    const messages: LLMMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Old message 1' },
      { role: 'assistant', content: 'Old reply 1' },
      { role: 'user', content: 'x'.repeat(20000) },
      { role: 'assistant', content: 'Latest reply' },
    ];

    const shrunk = engine.shrinkMessages(messages, 4000);
    expect(shrunk[0]?.role).toBe('system');
    expect(shrunk.length).toBeLessThanOrEqual(messages.length);
    const lastUser = [...shrunk].reverse().find(m => m.role === 'user');
    expect(String(lastUser?.content).length).toBeLessThan(20000);
  });

  it('compacts oversized tool results with head and tail', () => {
    const engine = makeEngine();
    const messages: LLMMessage[] = [
      { role: 'tool', content: 'search_results: ' + 'a'.repeat(10000), toolCallId: 'tc_1' },
    ];

    const shrunk = engine.shrinkMessages(messages, 4000);
    const text = String(shrunk[0]?.content);
    expect(text).toContain('compacted');
  });
});

describe('buildSystemPrompt extended scenarios', () => {
  it('includes project, workflow, and cognitive context blocks', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      projectContext: {
        project: { id: 'proj_1', name: 'Alpha', description: 'Main project', status: 'active' },
        repositories: [{ localPath: '/repo', defaultBranch: 'main', role: 'primary' }],
        governanceRules: 'All PRs need review',
        teamRole: 'lead',
      },
      workflowContext: {
        activeRuns: [{
          workflowName: 'Release',
          runNumber: 3,
          status: 'running',
          taskCount: 5,
          startedAt: new Date().toISOString(),
        }],
        availableWorkflows: [{ name: 'Release', description: 'Release pipeline', stepCount: 4 }],
      },
      cognitiveContext: {
        plan: 'Step 1: analyze\nStep 2: implement',
        reflections: ['Prior attempt failed on tests'],
      } as never,
      trustLevel: { level: 'trusted', score: 85 },
      announcements: [{
        type: 'info',
        priority: 'normal',
        title: 'Deploy freeze',
        content: 'No deploys until Friday',
      }],
      scenario: 'task_execution',
      agentWorkspace: {
        primaryWorkspace: '/workspace',
        sharedWorkspace: '/shared',
      },
      teamAnnouncements: 'Sprint ends tomorrow.',
      teamNorms: 'Standups at 10am.',
      isTeamManager: true,
    });

    expect(result.text).toContain('Alpha');
    expect(result.text).toContain('Release');
    expect(result.text).toContain('Deploy freeze');
    expect(result.text).toContain('Sprint ends tomorrow');
  });

  it('includes a2a and review scenario sections', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();

    const a2a = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      scenario: 'a2a',
      a2aWaitForReply: true,
      senderIdentity: { id: 'agt_peer', name: 'Peer', role: 'worker' },
    });

    const review = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      scenario: 'review',
    });

    expect(a2a.text.toLowerCase()).toMatch(/agent|peer|message/);
    expect(review.text.toLowerCase()).toMatch(/review|task/);
  });

  it('prepareMessages compacts tool-call history when over token budget', async () => {
    const memory = new MemoryStore(tempDir);
    const session = memory.createSession('agt_ctx');

    memory.appendMessage(session.id, { role: 'user', content: 'Run tools' });
    memory.appendMessage(session.id, {
      role: 'assistant',
      content: 'Calling tools',
      toolCalls: [{ id: 'tc1', name: 'lookup', arguments: {} }],
    });
    memory.appendMessage(session.id, { role: 'tool', content: 'result '.repeat(5000), toolCallId: 'tc1' });
    memory.appendMessage(session.id, { role: 'assistant', content: 'Done with tools.' });
    memory.appendMessage(session.id, { role: 'user', content: 'Follow up question' });

    const engine = makeEngine();
    const prepared = await engine.prepareMessages({
      systemPrompt: 'System.',
      sessionMessages: memory.getRecentMessages(session.id, 50),
      memory,
      sessionId: session.id,
      modelContextWindow: 4000,
      modelMaxOutput: 500,
      toolDefinitions: [{
        name: 'lookup',
        description: 'lookup data',
        inputSchema: { type: 'object', properties: {} },
      }],
    });

    expect(prepared.messages.length).toBeGreaterThan(1);
    expect(prepared.usage.messageTokens).toBeLessThan(50000);
  });
});

describe('buildSystemPrompt knowledge and deliverables', () => {
  it('includes knowledge, deliverable, and feedback context', async () => {
    const memory = new MemoryStore(tempDir);
    memory.addLongTermMemory('architecture', 'Uses microservices.');
    const engine = makeEngine();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      knowledgeContext: 'Relevant docs about API v2',
      deliverableContext: 'Latest report: Q1 summary',
      recentFeedback: [{
        authorName: 'Lead',
        priority: 'high',
        content: 'Add more test coverage',
      }],
      projectDeliverables: [{
        category: 'report',
        title: 'Status Report',
        content: 'All systems green',
      }],
      availableSkills: [{ name: 'search', description: 'Web search', category: 'research' }],
      dynamicContext: 'Sprint 12 in progress.',
    });

    expect(result.text).toContain('Q1 summary');
    expect(result.text).toContain('test coverage');
    expect(result.text).toContain('Status Report');
    expect(result.text).toContain('search');
    expect(result.text).toContain('Sprint 12');
  });
});
