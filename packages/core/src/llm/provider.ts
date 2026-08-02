import type { LLMRequest, LLMResponse, LLMStreamEvent, LLMProviderConfig, ProviderCapabilities } from '@markus/shared';

/**
 * Default `max_tokens` for providers that require the field on the wire
 * (Anthropic, OpenAI-compatible, Google, Ollama).
 *
 * 4096 is too tight for agent coding turns (large patches / tool args get cut
 * off). 32k is enough headroom for typical digital-employee work without
 * approaching catalog ceilings (100k–393k) that break prepaid OpenRouter keys
 * when injected as a reservation. Markus/OpenRouter still omits max_tokens by
 * default — this constant is only for native BYOK providers.
 */
export const DEFAULT_REQUEST_MAX_TOKENS = 32_768;

export interface LLMProviderInterface {
  readonly name: string;
  readonly model: string;
  chat(request: LLMRequest): Promise<LLMResponse>;
  chatStream?(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void, signal?: AbortSignal): Promise<LLMResponse>;
  configure(config: LLMProviderConfig): void;
}

// ---------------------------------------------------------------------------
// Multi-modal provider interfaces
// ---------------------------------------------------------------------------

export interface ImageGenOptions {
  model?: string;
  size?: string;
  quality?: string;
  style?: string;
  n?: number;
  negative_prompt?: string;
  seed?: number;
  output_dir?: string;
  output_format?: string;
}

export interface ImageResult {
  /** Remote URL when the upstream returns one (rare on OpenRouter — usually b64). */
  url?: string;
  /** Base64 image bytes when the upstream returns inline data. */
  base64?: string;
  /** Local filesystem path when the provider already persisted the file. */
  path?: string;
  /** MIME type when known (e.g. image/png, image/jpeg). */
  mediaType?: string;
  revisedPrompt?: string;
}

export interface TTSOptions {
  model?: string;
  voice?: string;
  speed?: number;
  /** OpenRouter TTS accepts `mp3` | `pcm`; other values are provider-specific. */
  responseFormat?: 'mp3' | 'pcm' | 'opus' | 'aac' | 'flac' | 'wav';
}

/**
 * Pick a sensible default voice for a TTS model when the caller did not supply one.
 *
 * TTS voices are provider-specific: OpenAI uses names like "alloy", Deepgram's
 * aura family uses names like "aura-2-thalia-en". We must NOT blindly send
 * "alloy" to every upstream — routing a Deepgram model with "alloy" yields a hard
 * 400 ("Unknown voice"). This maps a model id to a known-good default for its
 * family, and returns `undefined` for unknown families so the caller can omit the
 * voice entirely and let the upstream apply its own default (or return an
 * actionable error listing valid voices).
 */
export function defaultVoiceForModel(model?: string): string | undefined {
  const id = (model ?? '').toLowerCase();
  if (!id) return undefined;
  // Deepgram aura / aura-2 family
  if (id.includes('aura')) return 'aura-2-thalia-en';
  // MiniMax speech models (OpenRouter / native) require an explicit voice string.
  if (id.includes('speech') || id.includes('minimax')) return 'Chinese (Mandarin)_Gentle_Youth';
  // OpenAI tts-1 / tts-1-hd / gpt-4o-mini-tts and OpenAI-compatible clones
  if (id.includes('tts') || id.includes('openai') || id.includes('gpt')) return 'alloy';
  // Unknown family — omit and let the upstream decide / report valid voices.
  return undefined;
}

/**
 * Turn a raw upstream media-endpoint error body into a clean, actionable message
 * for the agent.
 *
 * OpenRouter / OpenAI-compatible media endpoints often return useful details:
 *   - Bad voice → `Unknown voice "alloy". Supported voices: aura-2-thalia-en, …`
 *   - Bad/unserved model → `Model X does not exist` / `No model found for "X"`
 *
 * Unwrap `{ error: { message } }`, keep voice enumerations intact, and cap length
 * so a huge voice list cannot blow the agent's context.
 */
/**
 * True when status/body look like OpenRouter *payment/credit* errors.
 *
 * Per OpenRouter docs (errors-and-debugging / limits):
 * - 402 Payment Required → account or API key has insufficient credits (`payment_required`)
 * - 429 → rate limit (NOT credits)
 * - 403 → moderation / permission (NOT credits unless body explicitly says key/credit limit)
 * - 409 Conflict → not used by OpenRouter for billing; never treat as credits
 *
 * Callers must still confirm with Hub remaining before surfacing CU_EXCEEDED to users —
 * a stale OR key can 402 while Hub still shows budget.
 */
export function isCreditExhaustedHttp(status: number, bodyText: string): boolean {
  if (status === 409 || status === 429) return false;
  const t = bodyText || '';
  if (/CU_EXCEEDED|CU_MONTHLY_EXCEEDED/i.test(t)) return true;
  // Official OR meaning of 402.
  if (status === 402) {
    if (!t.trim()) return true;
    if (/payment_required|insufficient (credits?|quota|balance)|credits? (exhausted|exceeded)|key limit exceeded|quota exceeded/i.test(t)) {
      return true;
    }
    // Generic 402 bodies still mean payment required per OR docs.
    return !/rate.?limit|moderation|forbidden|unauthorized/i.test(t);
  }
  // Legacy / odd gateways sometimes put key-cap text on 400/403 — require explicit credit wording.
  if (status === 403 || status === 400) {
    return /key limit exceeded|insufficient (credits?|quota|balance)|credits? (exhausted|exceeded)|payment_required/i.test(t);
  }
  return false;
}

export const CREDIT_EXCEEDED_MSG = 'CU_EXCEEDED: Credits exhausted. Please top up or upgrade your plan.';

/** Hub still has budget after an upstream 402 — do not claim the user is out of credits. */
export const UPSTREAM_BILLING_MISMATCH_MSG =
  'MARKUS_UPSTREAM_ERROR: Upstream returned a payment/credit error, but Hub still shows remaining credits. Please retry shortly or switch model.';

/**
 * OpenRouter 402 bodies often include:
 *   "You requested up to N tokens, but can only afford M."
 * When `max_tokens` is omitted, OR still reserves against a high default
 * (commonly 65536). Parse M so callers can retry with an affordable cap.
 */
export function parseOpenRouterAffordableTokens(errText: string): number | null {
  const m = (errText || '').match(/can only afford\s+(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  // Leave a tiny margin — OR affordability is approximate.
  return Math.max(1, Math.floor(n * 0.98));
}

/**
 * Clamp max_tokens for an OpenRouter reservation-afford retry (Afford.S4).
 * `max_tokens = min(N, max(512, N - safety))` → effectively max(512, N - safety).
 */
export function clampReservationMaxTokens(
  affordable: number,
  safety = 64,
  floor = 512,
): number {
  if (!(affordable > 0)) return floor;
  return Math.max(floor, Math.min(affordable, affordable - Math.max(0, safety)));
}

/**
 * Proactive max_tokens clamp from known prompt afford (Afford.S4).
 * `max_tokens ≤ promptAfford - estimatedPrompt - margin`, floored at 512.
 */
export function clampMaxTokensToRemainingAfford(opts: {
  requested: number | undefined;
  promptAfford: number;
  estimatedPrompt: number;
  margin?: number;
  floor?: number;
}): number {
  const margin = opts.margin ?? 500;
  const floor = opts.floor ?? 512;
  const remaining = Math.max(
    floor,
    Math.floor(opts.promptAfford - Math.max(0, opts.estimatedPrompt) - margin),
  );
  if (opts.requested === undefined || !(opts.requested > 0)) return remaining;
  return Math.min(opts.requested, remaining);
}

/**
 * OpenRouter 402 when the *prompt* itself exceeds key affordability:
 *   "Prompt tokens limit exceeded: 86869 > 37406"
 * Returns the afford ceiling (Y), not the requested size (X).
 */
export function parseOpenRouterPromptAffordableTokens(errText: string): number | null {
  const m = (errText || '').match(/Prompt tokens limit exceeded:\s*\d+\s*>\s*(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.max(1, Math.floor(n * 0.95));
}

/**
 * Format a media-API error for the agent/tool layer.
 * MarkusProvider must resolve credit-like HTTP statuses via Hub cu/sync
 * *before* calling this — otherwise a stale OpenRouter 402 is mislabeled
 * as CU_EXCEEDED while Hub still has budget.
 */
export function formatUpstreamMediaError(status: number, errText: string): string {
  if (isCreditExhaustedHttp(status, errText)) {
    return CREDIT_EXCEEDED_MSG;
  }
  let message = errText;
  try {
    const parsed = JSON.parse(errText) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') message = parsed.error;
    else if (typeof parsed.error === 'object' && parsed.error?.message) message = parsed.error.message;
    else if (parsed.message) message = parsed.message;
  } catch {
    /* not JSON — keep the raw text */
  }
  message = message.trim();
  // Never surface vendor workspace / billing admin URLs to the agent or chat UI.
  message = message.replace(/https?:\/\/[^\s]*openrouter\.ai[^\s]*/gi, '').trim();
  const MAX = 1200;
  if (message.length > MAX) message = `${message.slice(0, MAX)}… (truncated)`;

  let hint = '';
  if (/does not exist|no model found|not a valid model|model.*not.*found/i.test(message)) {
    hint = ' — this model is not served for this capability. Call llm_get_capability_routing to see usable models, then retry with one of those.';
  } else if (/unknown voice|invalid voice|unsupported voice/i.test(message)) {
    hint = ' — retry with one of the supported voices listed above.';
  }
  return `HTTP ${status}: ${message}${hint}`;
}

export interface AudioResult {
  audio: Buffer;
  format: string;
  durationMs?: number;
}

export interface STTOptions {
  model?: string;
  language?: string;
  prompt?: string;
  responseFormat?: 'json' | 'text' | 'srt' | 'vtt';
}

export interface VideoGenOptions {
  model?: string;
  duration?: number;
  size?: string;
  fps?: number;
}

export interface VideoResult {
  /** Remote content URL (may require provider auth / expire). */
  url?: string;
  /** Local filesystem path when the provider (or tool layer) persisted the file. */
  path?: string;
  taskId?: string;
  status: 'completed' | 'processing' | 'failed';
  durationSeconds?: number;
}

/**
 * Extended provider interface supporting multi-modal operations.
 * All methods are optional -- providers declare which modalities they support
 * via getCapabilities().
 */
export interface ToolParamSchema {
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MultiModalToolSchemas {
  generate_image?: ToolParamSchema;
  text_to_speech?: ToolParamSchema;
  speech_to_text?: ToolParamSchema;
  generate_video?: ToolParamSchema;
}

export interface MultiModalProviderInterface extends LLMProviderInterface {
  getCapabilities?(): ProviderCapabilities;
  getToolSchemas?(): MultiModalToolSchemas;
  generateImage?(prompt: string, options?: ImageGenOptions): Promise<ImageResult[]>;
  generateSpeech?(text: string, options?: TTSOptions): Promise<AudioResult>;
  transcribeSpeech?(audio: Buffer, options?: STTOptions): Promise<string>;
  generateVideo?(prompt: string, options?: VideoGenOptions): Promise<VideoResult>;
}
