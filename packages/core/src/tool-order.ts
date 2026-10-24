import type { LLMTool } from '@markus/shared';

/**
 * Keep a growing tool array cache-stable.
 *
 * WHY THIS EXISTS
 * ---------------
 * In every provider's request the `tools` field is serialized BEFORE the
 * messages: it is not a message, it is a sibling top-level field. So the token
 * stream for a call is
 *
 *     [ tools … ][ system ][ history … ]
 *
 * and the tool block is a *prefix* of everything. Any change inside it —
 * including a pure reordering — invalidates the provider's prefix cache for the
 * entire request: system prompt, pinned slots, and the whole conversation.
 *
 * `discover_tools` grows that array mid-turn. The rebuild used to go straight
 * through the tool selector, which re-ranks and may re-select, so a new
 * activation could shuffle tools that were already cached and push the
 * invalidataion point earlier than necessary.
 *
 * The set of tools is the selector's decision and is kept exactly as chosen.
 * Only the ORDER is stabilized: tools that were already present keep their
 * previous relative order, and tools that are genuinely new are appended at the
 * end. That makes the already-cached portion of the tool block byte-identical
 * again, so the mispriced prefix shrinks to "everything after the last
 * surviving tool" instead of "everything".
 *
 * Correctness note: tool order carries no semantics — a model selects a tool by
 * name. Only eviction (which tools exist) changes behaviour, and eviction is
 * preserved: anything the selector dropped is dropped here too.
 */
export function stabilizeToolOrder(current: LLMTool[], rebuilt: LLMTool[]): LLMTool[] {
  // Everything the selector kept, in the order the model already saw it.
  const rebuiltNames = new Set(rebuilt.map((t) => t.name));
  const kept = current.filter((t) => rebuiltNames.has(t.name));

  // Tools that were NOT in the previous array — genuinely new this call.
  const currentNames = new Set(current.map((t) => t.name));
  const added = rebuilt.filter((t) => !currentNames.has(t.name));

  return [...kept, ...added];
}
