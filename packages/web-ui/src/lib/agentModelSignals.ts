/**
 * "This agent's model binding just changed" — a signal, not a store.
 *
 * Why this exists: the agent's bound model is shown in two independent places
 * that are mounted at the same time — Settings > 模型配置 (PerAgentModelSection)
 * and the Team chat composer's model menu. The composer hydrated its label once
 * per agent switch (`useEffect(..., [selectedAgent])`), so a write made in
 * Settings never reached it: the label kept the old model until the user
 * switched agents or reloaded. The reverse direction worked only because the
 * composer wrote its own local state optimistically.
 *
 * The value itself is NOT cached here. `GET /api/agents/:id` stays the single
 * authority (`effectiveModel`); this module only tells readers when to re-read
 * it. Caching the value would create a second writer for one fact.
 *
 * Every writer must announce: the composer (`applyChatModelSelection`), the
 * settings section, and anything else that binds a model later. Writes made
 * outside the renderer (an agent calling `agent_model_set_default`) cannot
 * announce, so readers also re-read on window focus.
 */

type Listener = (agentId: string) => void;

const listeners = new Set<Listener>();

/** Announce that `agentId`'s model binding changed. Call AFTER the write lands. */
export function notifyAgentModelChanged(agentId: string): void {
  for (const listener of [...listeners]) listener(agentId);
}

/** Subscribe; returns the unsubscribe function (safe to return from useEffect). */
export function onAgentModelChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test-only: drop every subscriber between cases. */
export function __resetAgentModelSignalsForTests(): void {
  listeners.clear();
}