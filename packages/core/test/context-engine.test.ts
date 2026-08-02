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

  it('appends viewer language and timezone guidance after the timestamp', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      senderIdentity: { id: 'usr_1', name: 'Li', role: 'owner', locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    });

    expect(result.text).toContain('Current date and time:');
    expect(result.text).toContain('Asia/Shanghai');
    expect(result.text).toContain('User locale:');
    expect(result.text).toContain('Chinese');
    expect(result.text).toContain('User Language (critical)');
    expect(result.text).toMatch(/task\/requirement\/deliverable/);
    // The locale block must come after the timestamp (Tier 3 tail, cache-safe).
    expect(result.text.indexOf('User locale:')).toBeGreaterThan(result.text.indexOf('Current date and time:'));
  });

  it('falls back to viewerContext for autonomous runs without a sender', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      viewerContext: { locale: 'ja-JP', timezone: 'Asia/Tokyo' },
    });

    expect(result.text).toContain('Asia/Tokyo');
    expect(result.text).toContain('User locale:');
    expect(result.text).toContain('Japanese');
    expect(result.text).toMatch(/user-visible field/);
  });

  it('still instructs language matching when no locale is configured', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
    });

    expect(result.text).toContain('User Language (critical)');
    expect(result.text).toContain('User language: Match the language of the user\'s recent messages');
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

  it('keeps full history when under the model token budget', async () => {
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

    // No count-based pre-summarization — 65 short turns fit a 64k window.
    expect(prepared.messages.filter(m => m.role !== 'system').length).toBe(65);
    expect(summarizer).not.toHaveBeenCalled();
  });

  it('compresses when history exceeds the model token budget', async () => {
    const memory = new MemoryStore(tempDir);
    const session = memory.createSession('agt_ctx');

    for (let i = 0; i < 40; i++) {
      memory.appendMessage(session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Turn ${i}: ${'detail '.repeat(200)}`,
      });
    }

    const summarizer = vi.fn(async () => 'Earlier conversation summarized.');
    const engine = makeEngine({ summarizer });

    const prepared = await engine.prepareMessages({
      systemPrompt: 'System prompt.',
      sessionMessages: memory.getRecentMessages(session.id, 100),
      memory,
      sessionId: session.id,
      modelContextWindow: 8000,
      modelMaxOutput: 1000,
    });

    const nonSystem = prepared.messages.filter(m => m.role !== 'system');
    expect(nonSystem.length).toBeLessThan(40);
    expect(prepared.usage.usagePercent).toBeLessThanOrEqual(100);
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

    expect(result.text).toContain('test coverage');
    expect(result.text).toContain('Sprint 12');
  });
});

describe('context budget overhaul', () => {
  it('keeps skill full bodies out of chat prompt until dynamicContext activates them', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();
    const skillBody = 'UNIQUE_SKILL_BODY_AGENT_BUILDING_XYZ — write manifests under builder-artifacts';

    const before = await engine.buildSystemPrompt({
      agentId: 'agt_sec',
      agentName: 'Secretary',
      role: MOCK_ROLE,
      memory,
      scenario: 'chat',
      availableSkills: [{
        name: 'agent-building',
        description: 'Design agent packages',
        category: 'development',
      }],
      identity: {
        self: {
          id: 'agt_sec',
          name: 'Secretary',
          role: 'Secretary',
          agentRole: 'manager',
          skills: ['agent-building'],
        },
        organization: { id: 'org_1', name: 'Acme' },
        colleagues: [],
        humans: [],
      },
    });

    expect(before.text).toContain('agent-building');
    expect(before.text).toContain('discover_tools');
    expect(before.text).not.toContain(skillBody);
    expect(before.text).not.toContain('## Task & Requirement Workflow');
    expect(before.text).toContain('## Task Workflow (summary)');
    expect(before.text).not.toContain('## Quality Gates');

    const after = await engine.buildSystemPrompt({
      agentId: 'agt_sec',
      agentName: 'Secretary',
      role: MOCK_ROLE,
      memory,
      scenario: 'chat',
      dynamicContext: `<skill name="agent-building">\n${skillBody}\n</skill>`,
    });
    expect(after.text).toContain(skillBody);
  });

  it('loads full task workflow only in task_execution scenario', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();
    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      scenario: 'task_execution',
    });
    expect(result.text).toContain('## Task & Requirement Workflow');
    expect(result.text).toContain('## Quality Gates');
    expect(result.text).toContain('## Error Recovery');
  });

  it('caps colleague roster in identity and points to team_list', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();
    const colleagues = Array.from({ length: 18 }, (_, i) => ({
      id: `agt_${i}`,
      name: `Agent${i}`,
      role: 'Worker',
      type: 'agent' as const,
      skills: ['coding'],
    }));

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_mgr',
      agentName: 'Manager',
      role: MOCK_ROLE,
      memory,
      identity: {
        self: {
          id: 'agt_mgr',
          name: 'Manager',
          role: 'Manager',
          agentRole: 'manager',
          skills: [],
        },
        organization: { id: 'org_1', name: 'Acme' },
        team: { id: 'team_1', name: 'Platform' },
        colleagues,
        humans: [{ id: 'usr_1', name: 'Owner', role: 'owner' }],
      },
    });

    expect(result.text).toContain('Agent0');
    expect(result.text).toContain('Agent9');
    expect(result.text).not.toContain('Agent17');
    expect(result.text).toContain('team_list');
    expect(result.text).toMatch(/8 more teammates/);
  });

  it('proactively compresses when history exceeds 55% of message budget', async () => {
    const memory = new MemoryStore(tempDir);
    const session = memory.createSession('agt_ctx');
    // ~60 turns × ~2.8k chars ≈ well above 55% of a 32k-window message budget
    for (let i = 0; i < 60; i++) {
      memory.appendMessage(session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Turn ${i}: ${'payload '.repeat(400)}`,
      });
    }

    const summarizer = vi.fn(async () => 'Earlier conversation summarized.');
    const engine = makeEngine({ summarizer });
    const prepared = await engine.prepareMessages({
      systemPrompt: 'System.',
      sessionMessages: memory.getRecentMessages(session.id, 200),
      memory,
      sessionId: session.id,
      modelContextWindow: 32_000,
      modelMaxOutput: 4_000,
    });

    expect(prepared.usage.compressed).toBe(true);
    expect(['proactive', 'over_budget', 'summarize', 'trim']).toContain(prepared.usage.compactStage);
    expect(prepared.usage.compactStage).not.toBe('none');
  });

  it('clamps packing budget when promptAffordTokens is set', async () => {
    const memory = new MemoryStore(tempDir);
    const session = memory.createSession('agt_ctx');
    for (let i = 0; i < 80; i++) {
      memory.appendMessage(session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Turn ${i}: ${'detail '.repeat(200)}`,
      });
    }

    const engine = makeEngine({ summarizer: async () => 'summary' });
    const prepared = await engine.prepareMessages({
      systemPrompt: 'System prompt for afford test.',
      sessionMessages: memory.getRecentMessages(session.id, 200),
      memory,
      sessionId: session.id,
      modelContextWindow: 128_000,
      modelMaxOutput: 16_000,
      promptAffordTokens: 20_000,
    });

    expect(prepared.usage.promptAffordTokens).toBe(20_000);
    expect(prepared.usage.totalUsed).toBeLessThan(20_000);
    expect(prepared.usage.compressed).toBe(true);
    expect(prepared.usage.packingBudget).toBeLessThan(40_000);
  });
});

describe('Learning Habits (LEARNING-LOOP §8)', () => {
  function extractLearningHabits(text: string): string {
    const start = text.indexOf('## Learning Habits');
    if (start < 0) return '';
    const rest = text.slice(start);
    const next = rest.search(/\n## (?!Learning Habits)/);
    return next < 0 ? rest : rest.slice(0, next);
  }

  it('B-prompt-learning-habits-present: chat and task_execution include Learning Habits cues', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();
    for (const scenario of ['chat', 'task_execution'] as const) {
      const result = await engine.buildSystemPrompt({
        agentId: 'agt_ctx',
        agentName: 'Ctx Agent',
        role: MOCK_ROLE,
        memory,
        scenario,
      });
      expect(result.text).toContain('## Learning Habits');
      expect(result.text).toContain('memory_search');
      expect(result.text).toContain('recall_activity');
      expect(result.text).toContain('memory_save');
      expect(result.text).toMatch(/Me vs others|other agents/i);
      expect(result.text).toMatch(/builder-artifacts\/skills|impact:\s*"low"|impact.*low/i);
      expect(result.text).not.toContain('.pending/');
    }
  });

  it('B-distill-habits-injected: distillation includes Learning Habits, no JSON outcome ritual', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();
    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      scenario: 'distillation',
    });
    expect(result.text).toContain('## Learning Habits');
    expect(result.text).toMatch(/post-task distillation|distillation mode/i);
    expect(result.text).toMatch(/package_install/);
    expect(result.text).toMatch(/request_user_input/);
    expect(result.text).not.toMatch(/"outcome"|staged_skill/);
  });

  it('B-prompt-learning-habits-absent-dream / B-dream-no-habits: memory_consolidation omits Learning Habits', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();
    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      scenario: 'memory_consolidation',
    });
    expect(result.text).not.toContain('## Learning Habits');
  });

  it('B-prompt-learning-habits-budget: Learning Habits section ≤ 1600 chars', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();
    const result = await engine.buildSystemPrompt({
      agentId: 'agt_ctx',
      agentName: 'Ctx Agent',
      role: MOCK_ROLE,
      memory,
      scenario: 'chat',
    });
    const section = extractLearningHabits(result.text);
    expect(section.length).toBeGreaterThan(0);
    expect(section.length).toBeLessThanOrEqual(1600);
  });
});
