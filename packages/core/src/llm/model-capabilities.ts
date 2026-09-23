/**
 * Provider-model capability vocabulary.
 *
 * `ModelDefinition.capabilities` is a free-form set of tags. Historically
 * "is this a chat model?" was inferred from *absence* — `capabilities` empty
 * meant chat, anything else meant "not chat". That forced an exclusive choice:
 * declaring e.g. `imageGeneration` silently removed a model from every chat
 * surface (chat composer picker, text routing, capability suggestions), even
 * when the endpoint really does serve `/chat/completions`.
 *
 * Real models are frequently both: a local diffusion server exposing a chat
 * endpoint, `gpt-image-1` (image generation through chat completions),
 * `gpt-audio` (a multimodal chat model). The rule is therefore explicit and
 * additive:
 *
 *   chat-capable  ⇔  capabilities includes 'chat'
 *                     OR (no media tag AND mode is not a non-chat mode)
 *
 * Backward compatible: an undeclared model is still assumed to be a chat model.
 */

/** Explicit "this endpoint serves /chat/completions" tag. */
export const CHAT_CAPABILITY = 'chat';

/**
 * Tags meaning "this is a dedicated media/side endpoint".
 * Deliberately excludes `vision` (a property of chat models) and `decision`
 * (a different response *shape*, not a non-chat modality).
 */
export const NON_CHAT_CAPABILITIES: ReadonlySet<string> = new Set([
  'imageGeneration',
  'tts',
  'stt',
  'videoGeneration',
  'audioOutput',
  'audioInput',
]);

/** Minimum shape needed to decide chat capability. */
export interface ChatCapabilityShape {
  capabilities?: string[];
  /** Catalog mode, e.g. 'chat' | 'image_generation' | 'audio_speech'. */
  mode?: string;
}

/**
 * Can this model serve `/chat/completions`?
 *
 * Order matters: an explicit `chat` tag wins even alongside media tags, so a
 * model can advertise `['imageGeneration', 'chat']` and stay selectable in the
 * chat UI while remaining routable as an image endpoint.
 */
export function isChatCapableModel(model: ChatCapabilityShape): boolean {
  const caps = model.capabilities ?? [];
  if (caps.includes(CHAT_CAPABILITY)) return true;
  if (caps.some(c => NON_CHAT_CAPABILITIES.has(c))) return false;
  if (model.mode && model.mode !== 'chat') return false;
  return true;
}
