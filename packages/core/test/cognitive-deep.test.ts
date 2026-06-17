import { describe, it, expect, vi } from 'vitest';
import {
  CognitiveDepth,
  type CognitiveConfig,
  type CognitiveStimulus,
  type CognitiveAgentContext,
} from '@markus/shared';
import { CognitivePreparation, type CognitiveLLM, type RetrievalBackend } from '../src/cognitive.js';

const STIMULUS: CognitiveStimulus = {
  type: 'task_execution',
  summary: 'Implement feature X',
  content: 'Build the new authentication flow with OAuth2 support.',
  scenario: 'task_execution',
};

const AGENT_CTX: CognitiveAgentContext = {
  id: 'agent-001',
  name: 'DevBot',
  roleDescription: 'Backend developer',
  status: 'working',
  currentTask: 'auth refactor',
  recentActivity: ['Reviewed OAuth docs'],
};

const APPRAISAL_WITH_REFLECTION = JSON.stringify({
  intent: 'Build OAuth2 auth flow',
  relevance: 'Core platform work',
  confidence: 'high',
  retrievalPlan: {
    memoryQueries: ['oauth', 'auth'],
    activityQueries: ['login bug'],
    taskQueries: ['auth task'],
  },
  reflectionNeeded: true,
  cognitiveContext: 'OAuth implementation with existing auth context.',
});

const REFLECTION_JSON = JSON.stringify({
  interpretation: 'Need to integrate with existing session store',
  recommendations: ['Check current JWT middleware', 'Add refresh token rotation'],
});

function makeLLM(appraisal: string, reflection?: string): CognitiveLLM {
  let calls = 0;
  return {
    chat: vi.fn(async (req) => {
      calls++;
      const purpose = req.metadata?.purpose;
      if (purpose === 'cognitive_reflection') {
        return { content: reflection ?? REFLECTION_JSON };
      }
      return { content: appraisal };
    }),
  };
}

function makeBackend(overrides?: Partial<RetrievalBackend>): RetrievalBackend {
  return {
    searchMemories: vi.fn((q: string) => [
      { content: `Memory hit for ${q}`, score: 0.9 },
      { content: `Memory hit for ${q}`, score: 0.8 },
    ]),
    searchActivities: vi.fn((_, q: string) => [
      { type: 'task', summary: `Activity for ${q}` },
    ]),
    searchTasks: vi.fn((q: string) => [
      { id: 'task_1', title: `Task ${q}`, status: 'in_progress' },
    ]),
    ...overrides,
  };
}

describe('CognitivePreparation D2+ with retrieval', () => {
  it('runs full pipeline with retrieval and reflection at D2', async () => {
    const config: CognitiveConfig = { enabled: true };
    const cpp = new CognitivePreparation(config);
    const llm = makeLLM(APPRAISAL_WITH_REFLECTION);
    const backend = makeBackend();

    const result = await cpp.prepare(
      STIMULUS,
      AGENT_CTX,
      CognitiveDepth.D2_Deliberative,
      llm,
      backend,
    );

    expect(result.isEmpty).toBe(false);
    expect(result.retrievedContext).toContain('Memory hit');
    expect(result.reflection).toContain('session store');
    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(backend.searchMemories).toHaveBeenCalled();
  });

  it('deduplicates memory retrieval results', async () => {
    const config: CognitiveConfig = { enabled: true };
    const cpp = new CognitivePreparation(config);
    const llm = makeLLM(JSON.stringify({
      intent: 'test',
      relevance: 'test',
      confidence: 'low',
      retrievalPlan: { memoryQueries: ['dup'], activityQueries: [], taskQueries: [] },
      reflectionNeeded: false,
      cognitiveContext: 'ctx',
    }));
    const backend = makeBackend();

    await cpp.prepare(STIMULUS, AGENT_CTX, CognitiveDepth.D2_Deliberative, llm, backend);
    expect(backend.searchMemories).toHaveBeenCalledWith('dup', 5);
  });

  it('continues when retrieval backends throw', async () => {
    const config: CognitiveConfig = { enabled: true };
    const cpp = new CognitivePreparation(config);
    const llm = makeLLM(APPRAISAL_WITH_REFLECTION);
    const backend = makeBackend({
      searchMemories: vi.fn(() => { throw new Error('mem fail'); }),
      searchActivities: vi.fn(() => { throw new Error('act fail'); }),
      searchTasks: vi.fn(() => { throw new Error('task fail'); }),
    });

    const result = await cpp.prepare(
      STIMULUS,
      AGENT_CTX,
      CognitiveDepth.D2_Deliberative,
      llm,
      backend,
    );

    expect(result.isEmpty).toBe(false);
    expect(result.cognitiveContext).toBeDefined();
  });

  it('uses reflection fallback when reflection LLM fails', async () => {
    const config: CognitiveConfig = { enabled: true };
    const cpp = new CognitivePreparation(config);
    const llm: CognitiveLLM = {
      chat: vi.fn(async (req) => {
        if (req.metadata?.purpose === 'cognitive_reflection') {
          throw new Error('reflection failed');
        }
        return { content: APPRAISAL_WITH_REFLECTION };
      }),
    };
    const backend = makeBackend();

    const result = await cpp.prepare(
      STIMULUS,
      AGENT_CTX,
      CognitiveDepth.D3_MetaCognitive,
      llm,
      backend,
    );

    expect(result.reflection).toContain('Unable to reflect');
  });
});
