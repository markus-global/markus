/**
 * Deterministic cognitive-context types.
 *
 * The former Cognitive Preparation Pipeline (CPP — the 0–3 pre-call LLM phases
 * appraise / retrieve / reflect) was **removed** in the memory-and-cognition
 * refactor: see docs/COGNITIVE-ARCHITECTURE.md §3. What remains is a small,
 * LLM-free situational block assembled per turn (recent activity + working-memory
 * keys) plus the on/off flag that gates it. Deeper cross-domain recall is
 * agent-driven via `memory_search` / `kb_search`, not a pre-call pipeline.
 */

/**
 * The deterministic situational block passed to `buildSystemPrompt`.
 * Rendered as `## Cognitive Context` when non-empty.
 */
export interface PreparedCognitiveContext {
  /** Recent activity + working-memory keys, if any. */
  cognitiveContext?: string;
  /** True when there is nothing to inject. */
  isEmpty: boolean;
}

/** Configuration for the deterministic cognitive-context block (default: disabled). */
export interface CognitiveConfig {
  /** Gate the situational block. No LLM phase runs either way — this is pure assembly. */
  enabled: boolean;
}
