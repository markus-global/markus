/**
 * Cognitive Preparation Pipeline (CPP)
 *
 * Runs 0–3 lightweight LLM calls before the main reasoning call to prepare
 * persona-aware context. See docs/COGNITIVE-ARCHITECTURE.md for theory.
 *
 * Phases:
 *   1. Appraisal — "What is this? What do I need?" (persona-aware LLM call)
 *   2. Directed Retrieval — execute the plan from Phase 1 (no LLM, pure queries)
 *   3. Reflection — "What does this mean for me?" (persona-aware LLM call)
 *   4. Assembly — stitch results into prompt sections (code, no LLM)
 */

import {
  createLogger,
  CognitiveDepth,
  type CognitiveStimulus,
  type CognitiveAgentContext,
  type AppraisalResult,
  type RetrievalPlan,
  type RetrievedContext,
  type ReflectionResult,
  type PreparedCognitiveContext,
  type CognitiveConfig,
  type LLMRequest,
  type LLMResponse,
} from '@markus/shared';

const log = createLogger('cognitive');

/** Minimal LLM interface — only needs the non-streaming chat method */
export interface CognitiveLLM {
  chat(request: LLMRequest, providerName?: string): Promise<LLMResponse>;
}

/** Backend for Phase 2 retrieval */
export interface RetrievalBackend {
  searchMemories(query: string, limit?: number): Array<{ content: string; relevance: number }>;
  searchActivities(agentId: string, query: string, limit?: number): Array<{ summary: string; type: string }>;
  searchTasks(query: string, limit?: number): Array<{ title: string; status: string; id: string }>;
}

// ─── Depth Selection (0G) ────────────────────────────────────────────────────

const SCENARIO_DEPTH_MAP: Record<string, CognitiveDepth> = {
  heartbeat: CognitiveDepth.D0_Reflexive,
  memory_consolidation: CognitiveDepth.D0_Reflexive,
  human_chat: CognitiveDepth.D1_Reactive,
  a2a: CognitiveDepth.D1_Reactive,
  a2a_message: CognitiveDepth.D1_Reactive,
  comment_response: CognitiveDepth.D1_Reactive,
  task_execution: CognitiveDepth.D2_Deliberative,
};

export function selectCognitiveDepth(
  scenario: string,
  agentState: { hasFailedTasks?: boolean; hasBlockers?: boolean },
  stimulusLength: number,
): CognitiveDepth {
  const base = SCENARIO_DEPTH_MAP[scenario] ?? CognitiveDepth.D1_Reactive;

  // Upgrade heuristics
  if (base === CognitiveDepth.D0_Reflexive && agentState.hasFailedTasks) {
    return CognitiveDepth.D1_Reactive;
  }
  if (base === CognitiveDepth.D1_Reactive && stimulusLength > 500) {
    return CognitiveDepth.D2_Deliberative;
  }
  if (base === CognitiveDepth.D2_Deliberative && agentState.hasBlockers) {
    return CognitiveDepth.D3_MetaCognitive;
  }

  return base;
}

// ─── Cognitive Preparation ───────────────────────────────────────────────────

export class CognitivePreparation {
  constructor(private config: CognitiveConfig) {}

  async prepare(
    stimulus: CognitiveStimulus,
    agent: CognitiveAgentContext,
    depth: CognitiveDepth,
    llm: CognitiveLLM,
    retrieval: RetrievalBackend,
  ): Promise<PreparedCognitiveContext> {
    if (!this.config.enabled || depth === CognitiveDepth.D0_Reflexive) {
      return { depth, isEmpty: true };
    }

    log.info('CPP starting', { depth, stimulus: stimulus.type, agent: agent.name });

    // Phase 1: Appraisal
    const appraisal = await this.appraise(stimulus, agent, llm);

    if (depth === CognitiveDepth.D1_Reactive) {
      return {
        depth,
        cognitiveContext: appraisal.cognitiveContext,
        isEmpty: false,
      };
    }

    // Phase 2: Directed Retrieval (D2+)
    const retrieved = await this.retrieve(appraisal.retrievalPlan, retrieval, agent.name);

    // Phase 3: Reflection (D2+ when needed)
    let reflection: ReflectionResult | undefined;
    if (appraisal.reflectionNeeded && depth >= CognitiveDepth.D2_Deliberative) {
      reflection = await this.reflect(stimulus, agent, retrieved, llm);
    }

    // Phase 4: Assembly
    return this.assemble(depth, appraisal, retrieved, reflection);
  }

  // ─── Phase 1: Appraisal ─────────────────────────────────────────────────────

  private async appraise(
    stimulus: CognitiveStimulus,
    agent: CognitiveAgentContext,
    llm: CognitiveLLM,
  ): Promise<AppraisalResult> {
    const prompt = [
      `You are ${agent.name}, a ${agent.roleDescription}.`,
      `Current status: ${agent.status}`,
      agent.currentTask ? `Current task: ${agent.currentTask}` : '',
      agent.recentActivity.length > 0
        ? `Recent activity:\n${agent.recentActivity.slice(-5).map((a: string) => `- ${a}`).join('\n')}`
        : '',
      '',
      'An incoming stimulus requires your attention:',
      `Type: ${stimulus.type}`,
      stimulus.sender ? `From: ${stimulus.sender}` : '',
      `Content: ${stimulus.content.slice(0, 800)}`,
      '',
      'Respond with a JSON object (no markdown fences):',
      '{',
      '  "intent": "brief description of what this stimulus is asking/requiring",',
      '  "relevance": "how this relates to your current work and role",',
      '  "confidence": "high|medium|low — how confident you are in understanding this",',
      '  "retrievalPlan": {',
      '    "memoryQueries": ["keywords to search your memory for relevant knowledge"],',
      '    "activityQueries": ["keywords to search your past activities"],',
      '    "taskQueries": ["keywords to search task board"]',
      '  },',
      '  "reflectionNeeded": true/false,',
      '  "cognitiveContext": "1-2 sentence summary of your assessment for the main reasoning call"',
      '}',
    ].filter(Boolean).join('\n');

    try {
      const response = await llm.chat({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 500,
        temperature: 0.3,
        metadata: { purpose: 'cognitive_appraisal' },
      });

      const parsed = JSON.parse(response.content.trim()) as AppraisalResult;
      log.debug('Appraisal completed', { intent: parsed.intent, confidence: parsed.confidence });
      return parsed;
    } catch (err) {
      log.warn('Appraisal LLM call failed, using fallback', { error: String(err) });
      return {
        intent: stimulus.summary || stimulus.type,
        relevance: 'unknown',
        confidence: 'low',
        retrievalPlan: { memoryQueries: [], activityQueries: [], taskQueries: [] },
        reflectionNeeded: false,
        cognitiveContext: `Incoming ${stimulus.type}: ${stimulus.summary || stimulus.content.slice(0, 100)}`,
      };
    }
  }

  // ─── Phase 2: Directed Retrieval ────────────────────────────────────────────

  private async retrieve(
    plan: RetrievalPlan,
    backend: RetrievalBackend,
    agentId: string,
  ): Promise<RetrievedContext> {
    const result: RetrievedContext = { memories: [], activities: [], tasks: [] };

    for (const q of plan.memoryQueries.slice(0, 3)) {
      try {
        const hits = backend.searchMemories(q, 5);
        result.memories.push(...hits);
      } catch (err) {
        log.warn('Memory retrieval failed', { query: q, error: String(err) });
      }
    }

    for (const q of plan.activityQueries.slice(0, 3)) {
      try {
        const hits = backend.searchActivities(agentId, q, 5);
        result.activities.push(...hits);
      } catch (err) {
        log.warn('Activity retrieval failed', { query: q, error: String(err) });
      }
    }

    for (const q of plan.taskQueries.slice(0, 3)) {
      try {
        const hits = backend.searchTasks(q, 5);
        result.tasks.push(...hits);
      } catch (err) {
        log.warn('Task retrieval failed', { query: q, error: String(err) });
      }
    }

    // Deduplicate memories by content
    const seen = new Set<string>();
    result.memories = result.memories.filter((m: { content: string; relevance: number }) => {
      const key = m.content.slice(0, 100);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    log.debug('Retrieval completed', {
      memories: result.memories.length,
      activities: result.activities.length,
      tasks: result.tasks.length,
    });

    return result;
  }

  // ─── Phase 3: Reflection ────────────────────────────────────────────────────

  private async reflect(
    stimulus: CognitiveStimulus,
    agent: CognitiveAgentContext,
    retrieved: RetrievedContext,
    llm: CognitiveLLM,
  ): Promise<ReflectionResult> {
    const contextSummary = [
      retrieved.memories.length > 0
        ? `Relevant knowledge:\n${retrieved.memories.slice(0, 5).map((m: { content: string; relevance: number }) => `- ${m.content}`).join('\n')}`
        : '',
      retrieved.activities.length > 0
        ? `Past activities:\n${retrieved.activities.slice(0, 5).map((a: { summary: string; type: string }) => `- [${a.type}] ${a.summary}`).join('\n')}`
        : '',
      retrieved.tasks.length > 0
        ? `Related tasks:\n${retrieved.tasks.slice(0, 5).map((t: { title: string; status: string; id: string }) => `- [${t.status}] ${t.title} (${t.id})`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n\n');

    const prompt = [
      `You are ${agent.name}, a ${agent.roleDescription}.`,
      `Current status: ${agent.status}`,
      '',
      `You are about to respond to: ${stimulus.summary || stimulus.content.slice(0, 200)}`,
      '',
      'Here is the context retrieved from your memory and experience:',
      contextSummary || '(No relevant context found)',
      '',
      'Reflect on this from your role\'s perspective. Respond with JSON (no markdown fences):',
      '{',
      '  "interpretation": "What this context means for how you should approach the stimulus",',
      '  "recommendations": ["specific action or consideration 1", "specific action 2"]',
      '}',
    ].join('\n');

    try {
      const response = await llm.chat({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 400,
        temperature: 0.3,
        metadata: { purpose: 'cognitive_reflection' },
      });

      const parsed = JSON.parse(response.content.trim()) as ReflectionResult;
      log.debug('Reflection completed', { recommendations: parsed.recommendations.length });
      return parsed;
    } catch (err) {
      log.warn('Reflection LLM call failed', { error: String(err) });
      return {
        interpretation: 'Unable to reflect — proceeding with available context.',
        recommendations: [],
      };
    }
  }

  // ─── Phase 4: Assembly ──────────────────────────────────────────────────────

  private assemble(
    depth: CognitiveDepth,
    appraisal: AppraisalResult,
    retrieved: RetrievedContext,
    reflection?: ReflectionResult,
  ): PreparedCognitiveContext {
    const sections: string[] = [];

    // Cognitive context (from appraisal)
    const cognitiveContext = appraisal.cognitiveContext;

    // Retrieved context
    const retrievedParts: string[] = [];
    if (retrieved.memories.length > 0) {
      retrievedParts.push('**From your knowledge:**');
      for (const m of retrieved.memories.slice(0, 5)) {
        retrievedParts.push(`- ${m.content}`);
      }
    }
    if (retrieved.activities.length > 0) {
      retrievedParts.push('**From past experience:**');
      for (const a of retrieved.activities.slice(0, 5)) {
        retrievedParts.push(`- [${a.type}] ${a.summary}`);
      }
    }
    if (retrieved.tasks.length > 0) {
      retrievedParts.push('**Related tasks:**');
      for (const t of retrieved.tasks.slice(0, 5)) {
        retrievedParts.push(`- [${t.status}] ${t.title} (${t.id})`);
      }
    }
    const retrievedContext = retrievedParts.length > 0 ? retrievedParts.join('\n') : undefined;

    // Reflection
    let reflectionText: string | undefined;
    if (reflection) {
      sections.length = 0; // reuse
      sections.push(reflection.interpretation);
      if (reflection.recommendations.length > 0) {
        for (const r of reflection.recommendations) {
          sections.push(`- ${r}`);
        }
      }
      reflectionText = sections.join('\n');
    }

    return {
      depth,
      cognitiveContext,
      retrievedContext,
      reflection: reflectionText,
      isEmpty: false,
    };
  }
}
