/**
 * Browser-side mirror of `packages/core/src/llm/model-capabilities.ts`.
 *
 * The web bundle cannot import `@markus/core` / `@markus/shared` (see the same
 * note in `src/constants/providers.ts`), so the rule is duplicated here. Keep
 * both copies in sync — they decide which models appear in the chat composer
 * and in Settings → Model Routing.
 */

/** Explicit "this endpoint serves /chat/completions" tag. */
export const CHAT_CAPABILITY = 'chat';

/** Tags meaning "this is a dedicated media/side endpoint". */
export const NON_CHAT_CAPABILITIES: ReadonlySet<string> = new Set([
  'imageGeneration',
  'tts',
  'stt',
  'videoGeneration',
  'audioOutput',
  'audioInput',
]);

export interface ChatCapabilityShape {
  capabilities?: string[];
  mode?: string;
}

/**
 * Can this model serve `/chat/completions`?
 *
 * A media-only model must never be bindable to an agent or listed in the chat
 * composer: every turn would POST to an endpoint that has no chat route and
 * fail at the upstream API. An explicit `chat` tag overrides the media tags for
 * models that genuinely serve both.
 */
export function isChatCapableModel(model: ChatCapabilityShape): boolean {
  const caps = model.capabilities ?? [];
  if (caps.includes(CHAT_CAPABILITY)) return true;
  if (caps.some(c => NON_CHAT_CAPABILITIES.has(c))) return false;
  if (model.mode && model.mode !== 'chat') return false;
  return true;
}
