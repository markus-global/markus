import { type LLMProviderConfig, type LLMRequest, type LLMResponse, type LLMStreamEvent, type LLMMessage, type LLMTool, type ProviderCapabilities } from '@markus/shared';
import {
  DEFAULT_REQUEST_MAX_TOKENS,
  defaultVoiceForModel,
  formatUpstreamMediaError,
  type MultiModalProviderInterface,
  type MultiModalToolSchemas,
  type ImageGenOptions,
  type ImageResult,
  type TTSOptions,
  type AudioResult,
  type STTOptions,
} from './provider.js';
import {
  buildOpenAICompatEndpoint,
  convertMessagesOpenAI,
  convertToolsOpenAI,
  parseOpenAICompatResponse,
  createSSEAccumulator,
  isOpenRouterReasoningModel,
  recoverTextToolCalls,
  createSafeTextEmitter,
  stripToolNoise,
  type OpenAIMessage,
  type OpenAIToolDef,
} from './provider-helpers.js';

interface OpenAIResponse {
  choices: Array<{
    message: OpenAIMessage & { reasoning_content?: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export type TokenResolver = () => Promise<string>;

export class OpenAIProvider implements MultiModalProviderInterface {
  name: string;
  model: string;
  protected apiKey: string;
  protected baseUrl: string;
  protected maxTokens: number;
  protected chatTimeoutMs: number;
  protected streamTimeoutMs: number;
  protected tokenResolver?: TokenResolver;

  constructor(config?: LLMProviderConfig, tokenResolver?: TokenResolver) {
    this.name = config?.provider ?? 'openai';
    this.model = config?.model ?? 'gpt-4o';
    this.apiKey = config?.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this.baseUrl = config?.baseUrl ?? 'https://api.openai.com';
    this.maxTokens = config?.maxTokens ?? DEFAULT_REQUEST_MAX_TOKENS;
    this.chatTimeoutMs = config?.timeoutMs ?? 90_000;
    // Idle gap between chunks (reset on data). Independent of chat timeoutMs.
    this.streamTimeoutMs = config?.streamTimeoutMs ?? 180_000;
    this.tokenResolver = tokenResolver;
  }

  configure(config: LLMProviderConfig): void {
    if (config.model) this.model = config.model;
    if (config.apiKey) this.apiKey = config.apiKey;
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.maxTokens) this.maxTokens = config.maxTokens;
    if (config.timeoutMs) this.chatTimeoutMs = config.timeoutMs;
    if (config.streamTimeoutMs) this.streamTimeoutMs = config.streamTimeoutMs;
  }

  setTokenResolver(resolver: TokenResolver): void {
    this.tokenResolver = resolver;
  }

  /** Build a full endpoint URL by appending `path` to the base URL. */
  protected buildEndpoint(path: string): string {
    return buildOpenAICompatEndpoint(this.baseUrl, path);
  }

  /** True when this instance is configured as an OpenRouter client. */
  protected get isOpenRouter(): boolean {
    return this.name === 'openrouter' || this.baseUrl.includes('openrouter.ai');
  }

  protected async resolveAuthHeader(): Promise<string> {
    if (this.tokenResolver) {
      const token = await this.tokenResolver();
      return `Bearer ${token}`;
    }
    return `Bearer ${this.apiKey}`;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages, request.systemCacheSegments);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages,
    };

    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.stopSequences?.length) body['stop'] = request.stopSequences;
    if (request.tools?.length) body['tools'] = this.convertTools(request.tools);

    const endpoint = this.buildEndpoint('/chat/completions');
    // OpenRouter asks for usage.cost and explicit reasoning on capable models.
    const isOpenRouter = this.isOpenRouter;
    if (isOpenRouter) {
      body['usage'] = { include: true };
      const modelId = request.model ?? this.model;
      if (isOpenRouterReasoningModel(modelId)) {
        body['reasoning'] = { enabled: true, effort: 'high' };
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.chatTimeoutMs);
    try {
      const authorization = await this.resolveAuthHeader();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as OpenAIResponse & { usage?: { cost?: number } };
      const response = this.convertResponse(data as OpenAIResponse);
      if (isOpenRouter && typeof data.usage?.cost === 'number') {
        (response.usage as LLMResponse['usage'] & { cost?: number }).cost = data.usage.cost;
      }
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cause = (err as NodeJS.ErrnoException).cause;
      const detail = cause instanceof Error ? ` (${cause.message})` : '';
      throw new Error(`${msg}${detail}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private convertMessages(rawMessages: LLMMessage[], systemCacheSegments?: Array<{ content: string; cacheBreakpoint?: boolean }>): OpenAIMessage[] {
    return convertMessagesOpenAI(rawMessages, {
      // DeepSeek thinking models require reasoning_content on ALL assistant messages.
      backfillReasoning: this.name === 'deepseek',
      systemCacheSegments,
    });
  }

  private convertTools(tools: LLMTool[]): OpenAIToolDef[] {
    return convertToolsOpenAI(tools);
  }

  async chatStream(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages, request.systemCacheSegments);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages,
      stream: true,
    };
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.stopSequences?.length) body['stop'] = request.stopSequences;
    if (request.tools?.length) body['tools'] = this.convertTools(request.tools);

    const isOpenRouter = this.isOpenRouter;
    // OpenRouter: ask for usage.cost + streamed usage, and explicit reasoning.
    const modelId = request.model ?? this.model;
    if (isOpenRouter) {
      body['usage'] = { include: true };
      body['stream_options'] = { include_usage: true };
      if (isOpenRouterReasoningModel(modelId)) {
        body['reasoning'] = { enabled: true, effort: 'high' };
      }
    }

    const endpoint = this.buildEndpoint('/chat/completions');
    const controller = new AbortController();
    const STREAM_HARD_TIMEOUT_MS = 15 * 60_000;
    let idleTimedOut = false;
    let hardTimedOut = false;
    let idleTimeout = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, this.streamTimeoutMs);
    const hardTimeout = setTimeout(() => {
      hardTimedOut = true;
      controller.abort();
    }, STREAM_HARD_TIMEOUT_MS);
    const bumpIdleTimeout = () => {
      clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, this.streamTimeoutMs);
    };
    const clearStreamTimeouts = () => {
      clearTimeout(idleTimeout);
      clearTimeout(hardTimeout);
    };
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    let res: Response;
    try {
      const authorization = await this.resolveAuthHeader();
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearStreamTimeouts();
      const msg = err instanceof Error ? err.message : String(err);
      const cause = (err as NodeJS.ErrnoException).cause;
      const detail = cause instanceof Error ? ` (${cause.message})` : '';
      throw new Error(`${msg}${detail}`);
    }

    if (!res.ok) {
      clearStreamTimeouts();
      const errText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errText}`);
    }

    bumpIdleTimeout();
    const sse = createSSEAccumulator();

    // Stream-side leak guard: never push raw `<invoke>` plaintext deltas to the
    // UI. Hold suspected tool-tag starts and only emit confirmed-safe text live;
    // flush the remainder (tool markup swallowed) before message_end.
    const safeText = createSafeTextEmitter((text) => onEvent({ type: 'text_delta', text }));
    const safeThinking = (thinking: string) =>
      onEvent({ type: 'thinking_delta', thinking: stripToolNoise(thinking) });
    let lastCostUsd: number | undefined;

    const reader = res.body?.getReader();
    if (!reader) {
      clearStreamTimeouts();
      throw new Error('No response body reader');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bumpIdleTimeout();
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const chunk = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
          sse.feed(chunk, {
            onThinking: (thinking) => safeThinking(thinking),
            onText: (text) => safeText.emit(text),
            onToolStart: (toolCall) => onEvent({ type: 'tool_call_start', toolCall }),
            onToolDelta: (toolCall, text) => onEvent({ type: 'tool_call_delta', toolCall, text }),
            onUsage: (_usage, raw) => {
              if (isOpenRouter && typeof raw.cost === 'number') lastCostUsd = raw.cost;
            },
          });
        } catch { /* skip unparseable lines */ }
      }
    }
    } catch (err) {
      clearStreamTimeouts();
      const state = sse.state;
      const hasPartial = state.content.length > 0 || state.reasoningContent.length > 0 || state.toolCalls.size > 0;
      if (idleTimedOut && hasPartial) {
        state.toolCalls.clear();
        state.finishReason = 'max_tokens';
      } else if (idleTimedOut || hardTimedOut) {
        const kind = hardTimedOut ? 'hard' : 'idle';
        throw new Error(
          `OpenAI stream ${kind} timeout after ${hardTimedOut ? STREAM_HARD_TIMEOUT_MS : this.streamTimeoutMs}ms`,
        );
      } else {
        throw err;
      }
    } finally {
      clearStreamTimeouts();
    }

    const state = sse.state;
    const resultToolCalls = sse.finalizeToolCalls().map((tc) => {
      onEvent({ type: 'tool_call_end', toolCall: { id: tc.id, name: tc.name } });
      return tc;
    });

    // Recover tool calls the model streamed as plain text instead of via the
    // structured tool_calls field. Even when structured tool calls exist, a
    // mixed output can still carry plaintext `<invoke>` markup in the body —
    // always strip the markup; only adopt recovered calls when none structured.
    let streamToolCalls = resultToolCalls;
    let streamContent = state.content;
    const recovered = recoverTextToolCalls(streamContent);
    if (recovered.toolCalls.length) {
      streamContent = recovered.cleanedContent;
      if (!resultToolCalls.length) {
        this.logLeakRecovered(recovered.toolCalls.length);
        streamToolCalls = recovered.toolCalls;
      }
    }

    // Upstream sometimes reports finish_reason=stop even when it emitted tool
    // calls; normalize so the agent treats it as a tool turn.
    if (streamToolCalls.length && state.finishReason !== 'tool_use') state.finishReason = 'tool_use';

    const usage: LLMResponse['usage'] = { inputTokens: state.promptTokens, outputTokens: state.completionTokens };
    if (state.cachedTokens > 0) usage.cacheReadTokens = state.cachedTokens;
    if (lastCostUsd !== undefined) (usage as LLMResponse['usage'] & { cost?: number }).cost = lastCostUsd;
    // Flush any held-safe text (tool markup swallowed) before the turn ends.
    safeText.flush();
    onEvent({ type: 'message_end', usage, finishReason: state.finishReason });

    const streamResult: LLMResponse = {
      content: streamContent,
      toolCalls: streamToolCalls.length ? streamToolCalls : undefined,
      usage,
      finishReason: state.finishReason,
    };
    if (state.reasoningContent) streamResult.reasoningContent = state.reasoningContent;
    return streamResult;
  }

  private convertResponse(data: OpenAIResponse): LLMResponse {
    return parseOpenAICompatResponse(data as unknown as Record<string, unknown>, {
      recoverTextToolCalls: (content) => {
        const recovered = recoverTextToolCalls(content);
        if (recovered.toolCalls.length) {
          this.logLeakRecovered(recovered.toolCalls.length);
        }
        return recovered;
      },
    });
  }

  private logLeakRecovered(count: number): void {
    // Keep provider file side-effect free; minimal warn to stderr via console.
    // (No createLogger import here to avoid coupling — providers log loud enough.)
    if (count > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[openai] Recovered ${count} text-emitted tool call(s) from content`);
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-modal: capabilities
  // ---------------------------------------------------------------------------

  protected get isNativeOpenAI(): boolean {
    return this.baseUrl.includes('api.openai.com');
  }

  getCapabilities(): ProviderCapabilities {
    const isOpenAI = this.isNativeOpenAI;
    const isOpenRouter = this.isOpenRouter;
    const mediaCapable = isOpenAI || isOpenRouter;
    return {
      chat: true,
      vision: true,
      imageGeneration: mediaCapable,
      tts: mediaCapable,
      stt: mediaCapable,
      videoGeneration: false,
      embedding: isOpenAI,
      reasoning: true,
      promptCaching: true,
    };
  }

  getToolSchemas(): MultiModalToolSchemas {
    return {
      generate_image: {
        description: 'Generate images using OpenAI. Provide a detailed text prompt.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Detailed text description of the image to generate' },
            model: { type: 'string', description: 'Model to use (default from routing config). e.g. "gpt-image-1", "dall-e-3"' },
            size: { type: 'string', enum: ['1024x1024', '1792x1024', '1024x1792'], description: 'Image dimensions (default: 1024x1024)' },
            quality: { type: 'string', enum: ['standard', 'hd'], description: 'Image quality (default: standard)' },
            style: { type: 'string', enum: ['natural', 'vivid'], description: 'Style preset (default: vivid)' },
            n: { type: 'number', description: 'Number of images to generate (default: 1)' },
            output_dir: { type: 'string', description: 'Directory to save images' },
            output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Output format (default: png)' },
          },
          required: ['prompt'],
        },
      },
      text_to_speech: {
        description:
          'Convert text to speech using OpenAI (synchronous — blocks until full audio returns). ' +
          'Long text is slow; split paragraphs into short sentences and call multiple times.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to synthesize. Keep short per call; split long narration.' },
            model: { type: 'string', description: 'Model to use (default from routing config). e.g. "tts-1", "tts-1-hd"' },
            voice: { type: 'string', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], description: 'Voice to use (default: alloy)' },
            speed: { type: 'number', description: 'Speech speed (0.25-4.0, default: 1.0)' },
          },
          required: ['text'],
        },
      },
      speech_to_text: {
        description: 'Transcribe speech audio to text using OpenAI Whisper.',
        inputSchema: {
          type: 'object',
          properties: {
            audio_url: { type: 'string', description: 'URL or local file path of the audio to transcribe' },
            model: { type: 'string', description: 'Model to use (default from routing config). e.g. "whisper-1"' },
            language: { type: 'string', description: 'Language code (e.g. "en", "zh") for better accuracy' },
          },
          required: ['audio_url'],
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Multi-modal: image generation (DALL-E)
  // ---------------------------------------------------------------------------

  async generateImage(prompt: string, options?: ImageGenOptions): Promise<ImageResult[]> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const authorization = await this.resolveAuthHeader();
    const endpoint = /\/v\d+$/.test(base) ? `${base}/images/generations` : `${base}/v1/images/generations`;

    const body: Record<string, unknown> = {
      model: options?.model ?? 'dall-e-3',
      prompt,
      n: options?.n ?? 1,
      size: options?.size ?? '1024x1024',
      response_format: 'url',
    };
    if (options?.quality) body['quality'] = options.quality;
    if (options?.style) body['style'] = options.style;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Image generation API error ${formatUpstreamMediaError(res.status, errText)}`);
    }

    const data = await res.json() as {
      data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
      images?: Array<{ url?: string }>;
    };
    const items = data.data ?? data.images ?? [];
    return items.map(d => ({
      url: d.url,
      base64: (d as Record<string, unknown>).b64_json as string | undefined,
      revisedPrompt: (d as Record<string, unknown>).revised_prompt as string | undefined,
    }));
  }

  // ---------------------------------------------------------------------------
  // Multi-modal: text-to-speech
  // ---------------------------------------------------------------------------

  async generateSpeech(text: string, options?: TTSOptions): Promise<AudioResult> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const endpoint = /\/v\d+$/.test(base) ? `${base}/audio/speech` : `${base}/v1/audio/speech`;

    const format = options?.responseFormat ?? 'mp3';
    const model = options?.model ?? 'tts-1';
    const body: Record<string, unknown> = {
      model,
      input: text,
      // OpenAI's /audio/speech requires a voice; default via the family-aware
      // helper (falls back to "alloy" for OpenAI-family models).
      voice: options?.voice ?? defaultVoiceForModel(model) ?? 'alloy',
      response_format: format,
    };
    if (options?.speed) body['speed'] = options.speed;

    const authorization = await this.resolveAuthHeader();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`TTS API error ${formatUpstreamMediaError(res.status, errText)}`);
    }

    const arrayBuf = await res.arrayBuffer();
    return { audio: Buffer.from(arrayBuf), format };
  }

  // ---------------------------------------------------------------------------
  // Multi-modal: speech-to-text (Whisper)
  // ---------------------------------------------------------------------------

  async transcribeSpeech(audio: Buffer, options?: STTOptions): Promise<string> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const endpoint = /\/v\d+$/.test(base) ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;

    const formData = new FormData();
    formData.append('file', new Blob([audio as unknown as ArrayBuffer], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', options?.model ?? 'whisper-1');
    if (options?.language) formData.append('language', options.language);
    if (options?.prompt) formData.append('prompt', options.prompt);
    formData.append('response_format', options?.responseFormat ?? 'text');

    const authorization = await this.resolveAuthHeader();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: authorization },
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`STT API error ${formatUpstreamMediaError(res.status, errText)}`);
    }

    const responseFormat = options?.responseFormat ?? 'text';
    if (responseFormat === 'text') {
      return await res.text();
    }
    const data = await res.json() as { text: string };
    return data.text;
  }
}
