import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextEngine } from '../src/context-engine.js';
import { MemoryStore } from '../src/memory/store.js';
import type { RoleTemplate } from '@markus/shared';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'deep-role',
  name: 'Deep Role',
  description: 'Deep coverage role',
  category: 'engineering',
  systemPrompt: 'You are a deep test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-ctx-deep-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeEngine() {
  return new ContextEngine({ memorySearchTopK: 5 });
}

describe('ContextEngine identity and trust', () => {
  it('renders full identity section for manager with team context', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_mgr',
      agentName: 'Manager Bot',
      role: MOCK_ROLE,
      memory,
      identity: {
        self: { name: 'Manager Bot', agentRole: 'manager', skills: ['search', 'file_read_write'] },
        organization: { id: 'org_1', name: 'Acme Inc' },
        team: { id: 'team_1', name: 'Platform' },
        manager: undefined,
        colleagues: [
          { id: 'agt_w1', name: 'Worker One', role: 'worker', status: 'idle', skills: ['shell'] },
          { id: 'agt_w2', name: 'Worker Two', role: 'worker', status: 'busy' },
        ],
        humans: [
          { id: 'u1', name: 'Alice Owner', role: 'owner' },
          { id: 'u2', name: 'Bob Admin', role: 'admin' },
        ],
        otherTeams: [{
          id: 'team_2',
          name: 'Design',
          members: [{ id: 'agt_d1', name: 'Designer', role: 'worker' }],
        }],
        teamProjects: [{
          id: 'proj_1', name: 'Alpha', description: 'Main product', status: 'active',
        }],
      },
      availableSkills: [
        { name: 'search', description: 'Web search', category: 'research' },
        { name: 'shell', description: 'Run commands', category: 'dev' },
        { name: 'unused', description: 'Rare skill', category: 'misc' },
      ],
      currentQuery: 'search deployment logs',
    });

    expect(result.text).toContain('Team Manager of **Platform**');
    expect(result.text).toContain('Manager Responsibilities');
    expect(result.text).toContain('Worker One');
    expect(result.text).toContain('Alice Owner');
    expect(result.text).toContain('Design');
    expect(result.text).toContain('Alpha');
    expect(result.text).toContain('search');
  });

  it('includes USER.md from shared workspace', async () => {
    const shared = join(tempDir, 'shared');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'USER.md'), 'Owner prefers concise answers and uses vim.');

    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();
    const result = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'Agent',
      role: MOCK_ROLE,
      memory,
      agentWorkspace: { primaryWorkspace: join(tempDir, 'ws'), sharedWorkspace: shared },
    });

    expect(result.text).toContain('About the Owner');
    expect(result.text).toContain('vim');
  });

  it('renders all trust level guidance strings', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();
    const levels = ['probation', 'standard', 'trusted', 'senior'] as const;

    for (const level of levels) {
      const result = await engine.buildSystemPrompt({
        agentId: 'agt_1',
        agentName: 'Agent',
        role: MOCK_ROLE,
        memory,
        trustLevel: { level, score: 50 },
      });
      expect(result.text).toContain(`**${level}**`);
    }
  });
});

describe('ContextEngine task board and mailbox', () => {
  it('partitions my vs team tasks with closed counts and limits', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();
    const assignedTasks = [];

    for (let i = 0; i < 18; i++) {
      assignedTasks.push({
        id: `mine_${i}`,
        title: `My task ${i}`,
        description: `Desc ${i}`,
        status: i < 16 ? 'in_progress' : 'completed',
        priority: 'medium',
        assignedAgentId: 'agt_1',
      });
    }
    for (let i = 0; i < 10; i++) {
      assignedTasks.push({
        id: `other_${i}`,
        title: `Team task ${i}`,
        description: `Team desc ${i}`,
        status: 'in_progress',
        priority: 'high',
        assignedAgentId: 'agt_peer',
        assignedAgentName: 'Peer Agent',
      });
    }

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'Agent',
      role: MOCK_ROLE,
      memory,
      assignedTasks,
    });

    expect(result.text).toContain('My Tasks');
    expect(result.text).toContain('Team Tasks');
    expect(result.text).toContain('Peer Agent');
    expect(result.text).toContain('more active tasks not shown');
    expect(result.text).toContain('completed/closed tasks');
  });

  it('shows empty task board when no tasks assigned', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();
    const result = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'Agent',
      role: MOCK_ROLE,
      memory,
      assignedTasks: [],
    });
    expect(result.text).toContain('No tasks on the board');
  });

  it('renders rich mailbox section with focus, queue, decisions, and merged content', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();
    const result = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'Agent',
      role: MOCK_ROLE,
      memory,
      mailboxContext: {
        queueDepth: 3,
        currentFocus: { type: 'task_execution', label: 'Fix bug', elapsedMs: 12000, taskId: 'task_99' },
        topQueued: [
          { type: 'human_chat', priority: 0, summary: 'Need help now' },
          { type: 'a2a_message', priority: 2, summary: 'Status update' },
        ],
        recentDecisions: [{ type: 'preempt', reasoning: 'User message arrived during task' }],
        mergedContent: 'Prior thread about deployment failure',
      },
    });

    expect(result.text).toContain('Current focus');
    expect(result.text).toContain('task_99');
    expect(result.text).toContain('Message Processing Checklists');
    expect(result.text).toContain('Merged context');
    expect(result.text).toContain('deployment failure');
  });
});

describe('ContextEngine scenario sections', () => {
  const scenarios = [
    'chat',
    'task_execution',
    'heartbeat',
    'a2a',
    'group_chat',
    'comment_response',
    'review',
    'memory_consolidation',
    'deliberation',
    'requirement_action',
    'workflow_action',
  ] as const;

  for (const scenario of scenarios) {
    it(`includes guidance for ${scenario} scenario`, async () => {
      const memory = new MemoryStore(tempDir);
      const engine = makeEngine();
      const result = await engine.buildSystemPrompt({
        agentId: 'agt_1',
        agentName: 'Agent',
        role: MOCK_ROLE,
        memory,
        scenario,
        a2aWaitForReply: scenario === 'a2a',
        senderIdentity: scenario === 'a2a'
          ? { id: 'agt_peer', name: 'Peer', role: 'worker', isFirstConversation: true }
          : scenario === 'chat'
            ? { id: 'u1', name: 'Owner', role: 'owner' }
            : undefined,
      });
      expect(result.text.length).toBeGreaterThan(100);
      if (scenario === 'memory_consolidation') {
        expect(result.text).not.toContain('## Task & Requirement Workflow');
      }
      if (scenario === 'chat' && result.text.includes('Current Conversation')) {
        expect(result.text).toContain('organization owner');
      }
    });
  }
});

describe('ContextEngine prepareMessages compaction paths', () => {
  it('compacts old tool history when over budget with many tool rounds', async () => {
    const memory = new MemoryStore(tempDir);
    const session = memory.createSession('agt_1');

    for (let round = 0; round < 12; round++) {
      memory.appendMessage(session.id, { role: 'user', content: `Step ${round}` });
      memory.appendMessage(session.id, {
        role: 'assistant',
        content: 'Using tool',
        toolCalls: [{ id: `tc_${round}`, name: 'lookup', arguments: {} }],
      });
      memory.appendMessage(session.id, {
        role: 'tool',
        content: 'x'.repeat(12000),
        toolCallId: `tc_${round}`,
      });
    }

    const engine = makeEngine();
    const prepared = await engine.prepareMessages({
      systemPrompt: 'System.',
      sessionMessages: memory.getRecentMessages(session.id, 100),
      memory,
      sessionId: session.id,
      modelContextWindow: 3000,
      modelMaxOutput: 300,
    });

    const toolMsg = prepared.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg!.content).length).toBeLessThan(12000);
    expect(prepared.usage.messageTokens).toBeLessThan(80000);
  });

  it('summarizer failure falls back without throwing', async () => {
    const memory = new MemoryStore(tempDir);
    const session = memory.createSession('agt_1');
    for (let i = 0; i < 70; i++) {
      memory.appendMessage(session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i} with content.`,
      });
    }

    const engine = makeEngine();
    engine.setLLMSummarizer(vi.fn(async () => { throw new Error('summarizer down'); }));

    const prepared = await engine.prepareMessages({
      systemPrompt: 'System.',
      sessionMessages: memory.getRecentMessages(session.id, 100),
      memory,
      sessionId: session.id,
      modelContextWindow: 64000,
      modelMaxOutput: 4000,
    });

    expect(prepared.messages.length).toBeGreaterThan(1);
  });
});
