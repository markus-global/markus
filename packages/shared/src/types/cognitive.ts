/**
 * Cognitive Preparation Pipeline types.
 *
 * The CPP runs before the main LLM call, using 0–3 lightweight LLM calls
 * to prepare persona-aware context. See docs/COGNITIVE-ARCHITECTURE.md.
 */

/** Cognitive depth levels (Kahneman Dual Process inspired) */
export enum CognitiveDepth {
  /** No CPP phases. Used for heartbeat acks, dream cycles. */
  D0_Reflexive = 0,
  /** Appraisal only. Most chats, A2A, comments. 0–1 extra LLM calls. */
  D1_Reactive = 1,
  /** Appraisal + Retrieval + Reflection. Task execution, complex questions. 2 calls. */
  D2_Deliberative = 2,
  /** Full pipeline + post-response evaluation. High-stakes, novel situations. 2–3 calls. */
  D3_MetaCognitive = 3,
}

/** The stimulus that triggers cognitive preparation */
export interface CognitiveStimulus {
  type: string;
  summary: string;
  content: string;
  sender?: string;
  scenario?: string;
}

/** Agent context available to cognitive phases */
export interface CognitiveAgentContext {
  name: string;
  roleDescription: string;
  status: string;
  currentTask?: string;
  recentActivity: string[];
}

/** Output of Phase 1: Appraisal */
export interface AppraisalResult {
  intent: string;
  relevance: string;
  confidence: 'high' | 'medium' | 'low';
  retrievalPlan: RetrievalPlan;
  reflectionNeeded: boolean;
  cognitiveContext: string;
}

/** Instructions for Phase 2: what to retrieve */
export interface RetrievalPlan {
  memoryQueries: string[];
  activityQueries: string[];
  taskQueries: string[];
}

/** Output of Phase 2: Retrieved items */
export interface RetrievedContext {
  memories: Array<{ content: string; relevance: number }>;
  activities: Array<{ summary: string; type: string }>;
  tasks: Array<{ title: string; status: string; id: string }>;
}

/** Output of Phase 3: Reflection */
export interface ReflectionResult {
  interpretation: string;
  recommendations: string[];
}

/** The final prepared context passed to buildSystemPrompt */
export interface PreparedCognitiveContext {
  depth: CognitiveDepth;
  cognitiveContext?: string;
  retrievedContext?: string;
  reflection?: string;
  isEmpty: boolean;
}

/** Configuration for the cognitive pipeline */
export interface CognitiveConfig {
  enabled: boolean;
  defaultDepth?: CognitiveDepth;
}
