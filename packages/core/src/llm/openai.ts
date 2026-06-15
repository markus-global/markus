import { type LLMProviderConfig, type LLMRequest, type LLMResponse, type LLMStreamEvent, type LLMMessage, type LLMTool, type LLMContentPart, type ProviderCapabilities, getTextContent, sanitizeForLLM, sanitizeLLMMessages } from '@markus/shared';
import type { MultiModalProviderInterface, ImageGenOptions, ImageResult, TTSOptions, AudioResult, STTOptions } from './provider.js';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{type: string; text?: string; image_url?: {url: string}}>;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OpenAIResponse {
  choices: Array<{
    message: OpenAIMessage & { reasoning_content?: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export type TokenResolver = () => Promise<string>;

export class OpenAIProvider implements MultiModalProviderInterface {
  name: string;
  model: string;
  private apiKey: string;
  private baseUrl: string;
  private maxTokens: number;
  private chatTimeoutMs: number;
  private streamTimeoutMs: number;
  private tokenResolver?: TokenResolver;

  constructor(config?: LLMProviderConfig, tokenResolver?: TokenResolver) {
    this.name = config?.provider ?? 'openai';
    this.model = config?.model ?? 'gpt-4o';
    this.apiKey = config?.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this.baseUrl = config?.baseUrl ?? 'https://api.openai.com';
    this.maxTokens = config?.maxTokens ?? 4096;
    this.chatTimeoutMs = config?.timeoutMs ?? 90_000;
    this.streamTimeoutMs = config?.timeoutMs ?? 120_000;
    this.tokenResolver = tokenResolver;
  }

  configure(config: LLMProviderConfig): void {
    if (config.model) this.model = config.model;
    if (config.apiKey) this.apiKey = config.apiKey;
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.maxTokens) this.maxTokens = config.maxTokens;
    if (config.timeoutMs) {
      this.chatTimeoutMs = config.timeoutMs;
      this.streamTimeoutMs = config.timeoutMs;
    }
  }

  setTokenResolver(resolver: TokenResolver): void {
    this.tokenResolver = resolver;
  }

  private async resolveAuthHeader(): Promise<string> {
    if (this.tokenResolver) {
      const token = await this.tokenResolver();
      return `Bearer ${token}`;
    }
    return `Bearer ${this.apiKey}`;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages,
    };

    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.stopSequences?.length) body['stop'] = request.stopSequences;
    if (request.tools?.length) body['tools'] = this.convertTools(request.tools);

    const base = this.baseUrl.replace(/\/+$/, '');
    const endpoint = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
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

      const data = (await res.json()) as OpenAIResponse;
      return this.convertResponse(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cause = (err as NodeJS.ErrnoException).cause;
      const detail = cause instanceof Error ? ` (${cause.message})` : '';
      throw new Error(`${msg}${detail}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private convertMessages(rawMessages: LLMMessage[]): OpenAIMessage[] {
    const messages = sanitizeLLMMessages(rawMessages);

    // DeepSeek thinking models require reasoning_content on ALL assistant messages.
    // Old session messages may lack this field; backfill with empty string to avoid 400 errors.
    const backfillReasoning = this.name === 'deepseek';

    return messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: sanitizeForLLM(getTextContent(m.content)),
          tool_call_id: m.toolCallId ?? '',
        };
      }

      if (m.toolCalls?.length) {
        const msg: OpenAIMessage = {
          role: 'assistant' as const,
          content: getTextContent(m.content) || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
        if (m.reasoningContent || backfillReasoning) msg.reasoning_content = m.reasoningContent ?? '';
        return msg;
      }

      if (m.role === 'assistant' && (m.reasoningContent || backfillReasoning)) {
        const msg: OpenAIMessage = {
          role: 'assistant' as const,
          content: typeof m.content === 'string' ? m.content : getTextContent(m.content),
          reasoning_content: m.reasoningContent ?? '',
        };
        return msg;
      }

      if (Array.isArray(m.content)) {
        return {
          role: m.role,
          content: m.content.map((p: LLMContentPart) =>
            p.type === 'image_url'
              ? { type: 'image_url' as const, image_url: { url: p.image_url.url } }
              : { type: 'text' as const, text: p.text }
          ),
        };
      }

      return { role: m.role, content: m.content };
    });
  }

  private convertTools(tools: LLMTool[]): OpenAIToolDef[] {
    const seen = new Set<string>();
    const unique: OpenAIToolDef[] = [];
    for (const t of tools) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      unique.push({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      });
    }
    return unique;
  }

  async chatStream(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages,
      stream: true,
    };
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.stopSequences?.length) body['stop'] = request.stopSequences;
    if (request.tools?.length) body['tools'] = this.convertTools(request.tools);

    const base = this.baseUrl.replace(/\/+$/, '');
    const endpoint = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.streamTimeoutMs);
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
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      const cause = (err as NodeJS.ErrnoException).cause;
      const detail = cause instanceof Error ? ` (${cause.message})` : '';
      throw new Error(`${msg}${detail}`);
    }

    if (!res.ok) {
      clearTimeout(timeout);
      const errText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errText}`);
    }

    let content = '';
    let reasoningContent = '';
    const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
    let finishReason: LLMResponse['finishReason'] = 'end_turn';
    let promptTokens = 0;
    let completionTokens = 0;

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body reader');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const chunk = JSON.parse(trimmed.slice(6)) as {
            choices?: Array<{
              delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>; reasoning_content?: string; reasoning_details?: string; thinking?: string };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };

          const choice = chunk.choices?.[0];

          const deltaReasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning_details ?? choice?.delta?.thinking;
          if (deltaReasoning) {
            reasoningContent += deltaReasoning;
            onEvent({ type: 'thinking_delta', thinking: deltaReasoning });
          }

          if (choice?.delta?.content) {
            content += choice.delta.content;
            onEvent({ type: 'text_delta', text: choice.delta.content });
          }

          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (!toolCalls.has(tc.index)) {
                toolCalls.set(tc.index, { id: tc.id ?? '', name: '', args: '' });
              }
              const existing = toolCalls.get(tc.index)!;
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) {
                existing.name = tc.function.name;
                onEvent({ type: 'tool_call_start', toolCall: { id: existing.id, name: existing.name } });
              }
              if (tc.function?.arguments) {
                existing.args += tc.function.arguments;
                onEvent({ type: 'tool_call_delta', toolCall: { id: existing.id }, text: tc.function.arguments });
              }
            }
          }

          if (choice?.finish_reason) {
            const finishMap: Record<string, LLMResponse['finishReason']> = {
              stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens',
            };
            finishReason = finishMap[choice.finish_reason] ?? 'end_turn';
          }

          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? 0;
            completionTokens = chunk.usage.completion_tokens ?? 0;
          }
        } catch { /* skip unparseable lines */ }
      }
    }

    clearTimeout(timeout);

    const resultToolCalls = [...toolCalls.values()]
      .filter((tc) => tc.name)
      .map((tc) => {
        onEvent({ type: 'tool_call_end', toolCall: { id: tc.id, name: tc.name } });
        return {
          id: tc.id,
          name: tc.name,
          arguments: tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {},
        };
      });

    const usage = { inputTokens: promptTokens, outputTokens: completionTokens };
    onEvent({ type: 'message_end', usage, finishReason });

    const streamResult: LLMResponse = {
      content,
      toolCalls: resultToolCalls.length ? resultToolCalls : undefined,
      usage,
      finishReason,
    };
    if (reasoningContent) streamResult.reasoningContent = reasoningContent;
    return streamResult;
  }

  private convertResponse(data: OpenAIResponse): LLMResponse {
    const choice = data.choices[0];
    if (!choice) throw new Error('No response choice from OpenAI');

    const msg = choice.message;
    const toolCalls = msg.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    const finishMap: Record<string, LLMResponse['finishReason']> = {
      stop: 'end_turn',
      tool_calls: 'tool_use',
      length: 'max_tokens',
    };

    const result: LLMResponse = {
      content: typeof msg.content === 'string' ? msg.content : '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
      finishReason: finishMap[choice.finish_reason] ?? 'end_turn',
    };
    if (msg.reasoning_content) result.reasoningContent = msg.reasoning_content;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Multi-modal: capabilities
  // ---------------------------------------------------------------------------

  private get isNativeOpenAI(): boolean {
    return this.baseUrl.includes('api.openai.com');
  }

  getCapabilities(): ProviderCapabilities {
    const isOpenAI = this.isNativeOpenAI;
    // OpenAI-compatible providers (SiliconFlow, MiniMax, etc.) often expose
    // /v1/images/generations; TTS/STT is less common outside native OpenAI.
    return {
      chat: true,
      vision: true,
      imageGeneration: true,
      tts: isOpenAI,
      stt: isOpenAI,
      videoGeneration: false,
      embedding: isOpenAI,
      reasoning: true,
      promptCaching: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Multi-modal: image generation (DALL-E)
  // ---------------------------------------------------------------------------

  async generateImage(prompt: string, options?: ImageGenOptions): Promise<ImageResult[]> {
    const base = this.baseUrl.replace(/\/+$/, '');
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

    const authorization = await this.resolveAuthHeader();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Image generation API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as { data: Array<{ url?: string; b64_json?: string; revised_prompt?: string }> };
    return (data.data ?? []).map(d => ({
      url: d.url,
      base64: d.b64_json,
      revisedPrompt: d.revised_prompt,
    }));
  }

  // ---------------------------------------------------------------------------
  // Multi-modal: text-to-speech
  // ---------------------------------------------------------------------------

  async generateSpeech(text: string, options?: TTSOptions): Promise<AudioResult> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const endpoint = /\/v\d+$/.test(base) ? `${base}/audio/speech` : `${base}/v1/audio/speech`;

    const format = options?.responseFormat ?? 'mp3';
    const body: Record<string, unknown> = {
      model: options?.model ?? 'tts-1',
      input: text,
      voice: options?.voice ?? 'alloy',
      response_format: format,
    };
    if (options?.speed) body['speed'] = options.speed;

    const authorization = await this.resolveAuthHeader();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`TTS API error ${res.status}: ${errText}`);
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
      throw new Error(`STT API error ${res.status}: ${errText}`);
    }

    const responseFormat = options?.responseFormat ?? 'text';
    if (responseFormat === 'text') {
      return await res.text();
    }
    const data = await res.json() as { text: string };
    return data.text;
  }
}
