import { describe, it, expect, vi } from 'vitest';
import {
  CognitiveDepth,
  type CognitiveConfig,
  type CognitiveStimulus,
  type CognitiveAgentContext,
  type PreparedCognitiveContext,
} from '@markus/shared';
import { CognitivePreparation, selectCognitiveDepth } from '../src/cognitive.js';
import type { CognitiveLLM } from '../src/cognitive.js';
import { ContextEngine } from '../src/context-engine.js';
import { MemoryStore } from '../src/memory/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RoleTemplate } from '@markus/shared';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const STIMULUS: CognitiveStimulus = {
  type: 'chat',
  summary: 'User asks about auth module',
  content: 'How does the auth module handle token refresh?',
  sender: 'user-1',
  scenario: 'chat',
};

const AGENT_CTX: CognitiveAgentContext = {
  id: 'agent-001',
  name: 'DevBot',
  roleDescription: 'A backend developer specializing in Node.js and TypeScript.',
  status: 'idle',
  currentTask: undefined,
  recentActivity: ['Fixed login bug', 'Reviewed PR #42'],
};

function makeMockLLM(responseContent: string): CognitiveLLM {
  return {
    chat: vi.fn().mockResolvedValue({ content: responseContent }),
  };
}

const VALID_APPRAISAL_JSON = JSON.stringify({
  intent: 'User wants to understand token refresh logic',
  relevance: 'Directly related to auth module I maintain',
  confidence: 'high',
  retrievalPlan: {
    memoryQueries: ['auth token refresh'],
    activityQueries: ['auth module work'],
    taskQueries: [],
  },
  reflectionNeeded: false,
  cognitiveContext: 'User is asking about auth token refresh. I have recent experience with the auth module.',
});

// ─── selectCognitiveDepth ────────────────────────────────────────────────────

describe('selectCognitiveDepth', () => {
  it('returns D0 for heartbeat', () => {
    expect(selectCognitiveDepth('heartbeat', {}, 10)).toBe(CognitiveDepth.D0_Reflexive);
  });

  it('returns D0 for memory_consolidation', () => {
    expect(selectCognitiveDepth('memory_consolidation', {}, 100)).toBe(CognitiveDepth.D0_Reflexive);
  });

  it('returns D1 for chat', () => {
    expect(selectCognitiveDepth('chat', {}, 100)).toBe(CognitiveDepth.D1_Reactive);
  });

  it('returns D1 for a2a', () => {
    expect(selectCognitiveDepth('a2a', {}, 100)).toBe(CognitiveDepth.D1_Reactive);
  });

  it('returns D1 for comment_response', () => {
    expect(selectCognitiveDepth('comment_response', {}, 100)).toBe(CognitiveDepth.D1_Reactive);
  });

  it('returns D1 for review', () => {
    expect(selectCognitiveDepth('review', {}, 100)).toBe(CognitiveDepth.D1_Reactive);
  });

  it('returns D2 for task_execution', () => {
    expect(selectCognitiveDepth('task_execution', {}, 100)).toBe(CognitiveDepth.D2_Deliberative);
  });

  it('defaults to D1 for unknown scenarios', () => {
    expect(selectCognitiveDepth('unknown_scenario', {}, 100)).toBe(CognitiveDepth.D1_Reactive);
  });

  // Upgrade heuristics
  it('upgrades D0 to D1 when agent has failed tasks', () => {
    expect(selectCognitiveDepth('heartbeat', { hasFailedTasks: true }, 10)).toBe(CognitiveDepth.D1_Reactive);
  });

  it('upgrades D1 to D2 when stimulus is long (>500 chars)', () => {
    expect(selectCognitiveDepth('chat', {}, 600)).toBe(CognitiveDepth.D2_Deliberative);
  });

  it('does NOT upgrade D1 to D2 when stimulus is short', () => {
    expect(selectCognitiveDepth('chat', {}, 400)).toBe(CognitiveDepth.D1_Reactive);
  });

  it('upgrades D2 to D3 when agent has blockers', () => {
    expect(selectCognitiveDepth('task_execution', { hasBlockers: true }, 100)).toBe(CognitiveDepth.D3_MetaCognitive);
  });
});

// ─── CognitivePreparation ────────────────────────────────────────────────────

describe('CognitivePreparation', () => {
  describe('prepare() at D0', () => {
    it('returns empty result immediately', async () => {
      const config: CognitiveConfig = { enabled: true };
      const cpp = new CognitivePreparation(config);
      const llm = makeMockLLM('{}');

      const result = await cpp.prepare(STIMULUS, AGENT_CTX, CognitiveDepth.D0_Reflexive, llm);

      expect(result.isEmpty).toBe(true);
      expect(result.depth).toBe(CognitiveDepth.D0_Reflexive);
      expect(llm.chat).not.toHaveBeenCalled();
    });
  });

  describe('prepare() when disabled', () => {
    it('returns empty result even at D2', async () => {
      const config: CognitiveConfig = { enabled: false };
      const cpp = new CognitivePreparation(config);
      const llm = makeMockLLM('{}');

      const result = await cpp.prepare(STIMULUS, AGENT_CTX, CognitiveDepth.D2_Deliberative, llm);

      expect(result.isEmpty).toBe(true);
      expect(llm.chat).not.toHaveBeenCalled();
    });
  });

  describe('prepare() at D1', () => {
    it('calls appraisal LLM and returns cognitiveContext', async () => {
      const config: CognitiveConfig = { enabled: true };
      const cpp = new CognitivePreparation(config);
      const llm = makeMockLLM(VALID_APPRAISAL_JSON);

      const result = await cpp.prepare(STIMULUS, AGENT_CTX, CognitiveDepth.D1_Reactive, llm);

      expect(result.isEmpty).toBe(false);
      expect(result.depth).toBe(CognitiveDepth.D1_Reactive);
      expect(result.cognitiveContext).toContain('auth token refresh');
      expect(llm.chat).toHaveBeenCalledTimes(1);
      // Verify appraisal prompt includes agent identity
      const callArgs = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('DevBot');
      expect(callArgs.metadata?.purpose).toBe('cognitive_appraisal');
    });

    it('does NOT call retrieval or reflection', async () => {
      const config: CognitiveConfig = { enabled: true };
      const cpp = new CognitivePreparation(config);
      const llm = makeMockLLM(VALID_APPRAISAL_JSON);

      const result = await cpp.prepare(STIMULUS, AGENT_CTX, CognitiveDepth.D1_Reactive, llm);

      expect(result.retrievedContext).toBeUndefined();
      expect(result.reflection).toBeUndefined();
      expect(llm.chat).toHaveBeenCalledTimes(1);
    });
  });

  describe('maxDepth clamping', () => {
    it('clamps D2 to D1 when maxDepth is D1', async () => {
      const config: CognitiveConfig = { enabled: true, maxDepth: CognitiveDepth.D1_Reactive };
      const cpp = new CognitivePreparation(config);
      const llm = makeMockLLM(VALID_APPRAISAL_JSON);

      const result = await cpp.prepare(STIMULUS, AGENT_CTX, CognitiveDepth.D2_Deliberative, llm);

      expect(result.depth).toBe(CognitiveDepth.D1_Reactive);
      expect(result.isEmpty).toBe(false);
      // Only 1 LLM call (appraisal), no retrieval or reflection
      expect(llm.chat).toHaveBeenCalledTimes(1);
    });

    it('clamps D3 to D0 when maxDepth is D0', async () => {
      const config: CognitiveConfig = { enabled: true, maxDepth: CognitiveDepth.D0_Reflexive };
      const cpp = new CognitivePreparation(config);
      const llm = makeMockLLM('{}');

      const result = await cpp.prepare(STIMULUS, AGENT_CTX, CognitiveDepth.D3_MetaCognitive, llm);

      expect(result.isEmpty).toBe(true);
      expect(result.depth).toBe(CognitiveDepth.D0_Reflexive);
      expect(llm.chat).not.toHaveBeenCalled();
    });
  });

  describe('appraisal fallback on LLM error', () => {
    it('returns a fallback cognitiveContext when LLM throws', async () => {
      const config: CognitiveConfig = { enabled: true };
      const cpp = new CognitivePreparation(config);
      const llm: CognitiveLLM = {
        chat: vi.fn().mockRejectedValue(new Error('LLM timeout')),
      };

      const result = await cpp.prepare(STIMULUS, AGENT_CTX, CognitiveDepth.D1_Reactive, llm);

      expect(result.isEmpty).toBe(false);
      expect(result.cognitiveContext).toContain('chat');
      expect(result.cognitiveContext).toContain('User asks about auth module');
    });

    it('returns fallback when LLM returns invalid JSON', async () => {
      const config: CognitiveConfig = { enabled: true };
      const cpp = new CognitivePreparation(config);
      const llm = makeMockLLM('not valid json at all');

      const result = await cpp.prepare(STIMULUS, AGENT_CTX, CognitiveDepth.D1_Reactive, llm);

      expect(result.isEmpty).toBe(false);
      expect(result.cognitiveContext).toBeDefined();
    });
  });

  describe('D2+ without RetrievalBackend', () => {
    it('falls back to appraisal-only when retrieval is not provided', async () => {
      const config: CognitiveConfig = { enabled: true };
      const cpp = new CognitivePreparation(config);
      const llm = makeMockLLM(VALID_APPRAISAL_JSON);

      const result = await cpp.prepare(STIMULUS, AGENT_CTX, CognitiveDepth.D2_Deliberative, llm);

      expect(result.isEmpty).toBe(false);
      expect(result.cognitiveContext).toContain('auth token refresh');
      // Only appraisal call, no reflection since no retrieval backend
      expect(llm.chat).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── ContextEngine CPP sections ──────────────────────────────────────────────

describe('ContextEngine CPP section rendering', () => {
  const MOCK_ROLE: RoleTemplate = {
    id: 'test-role',
    name: 'Test Role',
    description: 'Test role',
    category: 'engineering',
    systemPrompt: 'You are a test agent.',
    defaultSkills: [],
    heartbeatChecklist: '',
    defaultPolicies: [],
    builtIn: false,
  };

  let tempDir: string;

  it('renders ## Cognitive Context when cognitiveContext is provided', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'markus-cpp-test-'));
    try {
      const engine = new ContextEngine();
      const memory = new MemoryStore(tempDir);

      const cppResult: PreparedCognitiveContext = {
        depth: CognitiveDepth.D1_Reactive,
        cognitiveContext: 'User is asking about auth. I have relevant experience.',
        isEmpty: false,
      };

      const { text: prompt } = await engine.buildSystemPrompt({
        agentId: 'agent-1',
        agentName: 'TestBot',
        role: MOCK_ROLE,
        memory,
        currentQuery: 'How does auth work?',
        cognitiveContext: cppResult,
      });

      expect(prompt).toContain('## Cognitive Context');
      expect(prompt).toContain('User is asking about auth. I have relevant experience.');
      expect(prompt).not.toContain('## Relevant Memories');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to ## Relevant Memories when cognitiveContext is undefined', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'markus-cpp-test-'));
    try {
      const engine = new ContextEngine();
      const memory = new MemoryStore(tempDir);
      memory.addEntry({ id: 'mem-1', type: 'fact', content: 'Auth uses JWT tokens', timestamp: Date.now() });

      const { text: prompt } = await engine.buildSystemPrompt({
        agentId: 'agent-1',
        agentName: 'TestBot',
        role: MOCK_ROLE,
        memory,
        currentQuery: 'How does auth work?',
      });

      expect(prompt).not.toContain('## Cognitive Context');
      expect(prompt).toContain('## Relevant Memories');
      expect(prompt).toContain('Auth uses JWT tokens');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to ## Relevant Memories when cognitiveContext.isEmpty is true', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'markus-cpp-test-'));
    try {
      const engine = new ContextEngine();
      const memory = new MemoryStore(tempDir);
      memory.addEntry({ id: 'mem-1', type: 'fact', content: 'DB uses PostgreSQL', timestamp: Date.now() });

      const cppResult: PreparedCognitiveContext = {
        depth: CognitiveDepth.D0_Reflexive,
        isEmpty: true,
      };

      const { text: prompt } = await engine.buildSystemPrompt({
        agentId: 'agent-1',
        agentName: 'TestBot',
        role: MOCK_ROLE,
        memory,
        currentQuery: 'What database do we use?',
        cognitiveContext: cppResult,
      });

      expect(prompt).not.toContain('## Cognitive Context');
      expect(prompt).toContain('## Relevant Memories');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('renders all three CPP sections when provided', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'markus-cpp-test-'));
    try {
      const engine = new ContextEngine();
      const memory = new MemoryStore(tempDir);

      const cppResult: PreparedCognitiveContext = {
        depth: CognitiveDepth.D2_Deliberative,
        cognitiveContext: 'Appraisal: complex auth question.',
        retrievedContext: 'Retrieved: prior auth work from last week.',
        reflection: 'Reflection: be careful about token expiry edge cases.',
        isEmpty: false,
      };

      const { text: prompt } = await engine.buildSystemPrompt({
        agentId: 'agent-1',
        agentName: 'TestBot',
        role: MOCK_ROLE,
        memory,
        currentQuery: 'Refactor auth module',
        cognitiveContext: cppResult,
      });

      expect(prompt).toContain('## Cognitive Context');
      expect(prompt).toContain('Appraisal: complex auth question.');
      expect(prompt).toContain('## Retrieved Context');
      expect(prompt).toContain('Retrieved: prior auth work from last week.');
      expect(prompt).toContain('## Reflection');
      expect(prompt).toContain('Reflection: be careful about token expiry edge cases.');
      expect(prompt).not.toContain('## Relevant Memories');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
