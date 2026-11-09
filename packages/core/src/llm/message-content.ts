/**
 * Message-content hygiene at the request boundary.
 *
 * One observed failure (2026-11-09, `markus:z-ai/glm-5v-turbo`) makes the reason
 * for this module concrete: a user message with ONE screenshot arrived with its
 * multimodal parts serialized into TEXT —
 *   `[{"type":"text","text":"…"},{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}]`
 * — a 338,836-character string. Two things then went wrong, and neither is a
 * provider bug:
 *   1. the image was billed as TEXT (~35k tokens per turn, re-sent every turn),
 *      while the vision model received no usable image at all;
 *   2. the structure was inferred from the payload (`Array.isArray(content)` was
 *      false), so nothing downstream could tell a screenshot from prose.
 *
 * The fix is to make the boundary explicit: every message that reaches a
 * provider goes through `normalizeHistoryContent`, which turns a serialized
 * parts array back into real parts. Structure is then structure again, in ONE
 * place, for every request.
 */
import type { LLMContentPart } from '@markus/shared';

/**
 * Parse `content` back into multimodal parts when it is a JSON array of parts
 * that carries at least one image.
 *
 * Deliberately narrow:
 *   - only strings that start with `[` and contain `"type"` are candidates
 *     (a normal message is never a JSON array — no false positives in practice),
 *   - every element must be an object with a string `type`,
 *   - at least one part must be `image_url` (a text-only JSON array is prose the
 *     user actually wrote — leave it alone).
 *
 * Returns `null` when the content is not a serialized parts array.
 */
export function rehydrateContentParts(content: unknown): LLMContentPart[] | null {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('[') || !trimmed.includes('"type"')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const parts: LLMContentPart[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return null;
    const type = (item as { type?: unknown }).type;
    if (typeof type !== 'string') return null;
    parts.push(item as LLMContentPart);
  }
  // Only rescue multimodal payloads: plain JSON text stays text.
  if (!parts.some(p => p.type === 'image_url')) return null;
  return parts;
}

/**
 * Apply {@link rehydrateContentParts} to a message list without touching
 * anything else. Pure; returns the same array identity when there is nothing
 * to repair so the packing hot path stays allocation-free for normal turns.
 */
export function normalizeHistoryContent<T extends { content: unknown }>(messages: T[]): T[] {
  let changed = false;
  const out = messages.map(m => {
    const parts = rehydrateContentParts(m.content);
    if (!parts) return m;
    changed = true;
    return { ...m, content: parts } as T;
  });
  return changed ? out : messages;
}
